import { resolve } from "node:path";
import type { EngineEvent } from "@lilos/contracts/engine";
import { FakeEngine } from "@lilos/engine-fake";
import { describe, expect, it } from "vitest";
import {
  FakeBrowser,
  FakePtySpawner,
  fakeAppOps,
  SessionSurfaces,
  serveGateway,
} from "./helpers.js";

const CLI = resolve(__dirname, "../src/cli.ts");

/**
 * AC-3: each engine session gets the LilOS MCP server via
 * `session.start { mcpServers }`, scoped to that session. Engine side is
 * engine-fake's real stdio client; the server is the real `lilos mcp`
 * pointing at the real tool API — the same path Hermes takes via ACP.
 */
describe("AC-3 session.start { mcpServers } scopes tools to the session", () => {
  it("engine session spawns lilos-mcp per session and drives it", async () => {
    const spawner = new FakePtySpawner(true);
    const browser = new FakeBrowser();
    const appOps = fakeAppOps();
    const scope = new SessionSurfaces({
      session: "sess-1",
      cwd: "/tmp",
      spawnPty: spawner.spawn,
      createBrowser: async () => browser,
      appOps,
    });
    const api = await serveGateway({
      sessions: [{ scope, token: "tok" }],
    });
    const engine = new FakeEngine({ tick: 1 });
    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));
    try {
      const start = (await engine.dispatch("session.start", {
        agent: "builder",
        cwd: "/tmp",
        mcpServers: [
          {
            name: "lilos",
            command: "bun",
            args: [CLI, "mcp"],
            env: [
              { name: "LILOS_SURFACES_URL", value: api.baseUrl },
              { name: "LILOS_TOKEN", value: "tok" },
              { name: "LILOS_SESSION", value: "sess-1" },
            ],
          },
        ],
      })) as { sessionId: string };
      const result = (await engine.dispatch("prompt", {
        sessionId: start.sessionId,
        content: [
          {
            type: "text",
            text: "surfaces: open http://localhost:4321; run echo from-pty; say hi ada; previews",
          },
        ],
      })) as { stopReason: string };
      expect(result.stopReason).toBe("end_turn");

      const done = events.filter(
        (e) => e.type === "tool.completed" && e.sessionId === start.sessionId,
      );
      expect(
        done.every(
          (e) => (e.payload as { status: string }).status === "completed",
        ),
      ).toBe(true);

      // The calls really happened — against sess-1's surfaces, not globally.
      expect(browser.url).toBe("http://localhost:4321");
      expect(spawner.last.written.join("")).toContain("echo from-pty");
      expect(appOps.posted).toEqual(["hi ada"]);
    } finally {
      engine.closeAllMcp();
      api.server.close();
    }
  }, 60_000);

  it("a second session gets its own scope (no cross-session bleed)", async () => {
    const spawnerA = new FakePtySpawner(true);
    const scopeA = new SessionSurfaces({
      session: "sess-A",
      cwd: "/tmp",
      spawnPty: spawnerA.spawn,
    });
    const spawnerB = new FakePtySpawner(true);
    const scopeB = new SessionSurfaces({
      session: "sess-B",
      cwd: "/tmp",
      spawnPty: spawnerB.spawn,
    });
    const api = await serveGateway({
      sessions: [
        { scope: scopeA, token: "tok-A" },
        { scope: scopeB, token: "tok-B" },
      ],
    });
    const engine = new FakeEngine({ tick: 1 });
    try {
      const start = async (sess: string, token: string) =>
        (await engine.dispatch("session.start", {
          agent: "builder",
          cwd: "/tmp",
          mcpServers: [
            {
              name: "lilos",
              command: "bun",
              args: [CLI, "mcp"],
              env: [
                { name: "LILOS_SURFACES_URL", value: api.baseUrl },
                { name: "LILOS_TOKEN", value: token },
                { name: "LILOS_SESSION", value: sess },
              ],
            },
          ],
        })) as { sessionId: string };
      const a = await start("sess-A", "tok-A");
      await engine.dispatch("prompt", {
        sessionId: a.sessionId,
        content: [{ type: "text", text: "surfaces: run echo only-A" }],
      });
      expect(spawnerA.last.written.join("")).toContain("echo only-A");
      expect(spawnerB.last.written.join("")).not.toContain("only-A");
    } finally {
      engine.closeAllMcp();
      api.server.close();
    }
  }, 60_000);
});
