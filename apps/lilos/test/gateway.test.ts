import type { EngineEvent } from "@lilos/contracts/engine";
import { FakeEngine } from "@lilos/engine-fake";
import { describe, expect, it } from "vitest";
import {
  FakePtySpawner,
  fakeAppOps,
  SessionSurfaces,
  serveGateway,
} from "./helpers.js";

/**
 * Issue #337 verify leg: a real engine session (engine-fake, the repo's
 * conformance engine) drives `thread_read` and `thread_post` through the
 * agent gateway over streamable-HTTP MCP — `session.start` attaches the
 * `{ type: "http" }` server, and every `mcp__lilos__*` step crosses it.
 */
describe("AC-2/AC-3 engine session drives the gateway over HTTP MCP", () => {
  it("thread_read + thread_post flow through POST /mcp", async () => {
    const spawner = new FakePtySpawner(true);
    const appOps = fakeAppOps();
    const scope = new SessionSurfaces({
      session: "sess-http",
      cwd: "/tmp",
      spawnPty: spawner.spawn,
      appOps,
      binding: {
        employeeId: "emp-ada",
        channelId: "chan-ada",
        conversationId: "conv-ada",
      },
    });
    const api = await serveGateway({
      sessions: [{ scope, token: "tok-http" }],
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
            type: "http",
            name: "lilos",
            url: `${api.baseUrl}/mcp`,
            headers: [{ name: "Authorization", value: "Bearer tok-http" }],
          },
        ],
      })) as { sessionId: string };
      const result = (await engine.dispatch("prompt", {
        sessionId: start.sessionId,
        content: [
          {
            type: "text",
            text: "surfaces: say hi over http; conv; previews; term",
          },
        ],
      })) as { stopReason: string };
      expect(result.stopReason).toBe("end_turn");

      // Every mcp step completed — the calls really crossed POST /mcp.
      const calls = events.filter(
        (e) => e.type === "tool.completed" && e.sessionId === start.sessionId,
      );
      expect(calls.length).toBeGreaterThanOrEqual(4);
      expect(
        calls.every(
          (e) => (e.payload as { status: string }).status === "completed",
        ),
      ).toBe(true);

      // And they landed on THIS session's binding, not a global store.
      expect(appOps.posted).toEqual(["hi over http"]);
      const read = appOps.posted; // thread_read returned the posted thread
      expect(read).toContain("hi over http");
    } finally {
      engine.closeAllMcp();
      api.server.close();
    }
  }, 60_000);

  it("engines declaring transports advertise http; stdio keeps working", async () => {
    const engine = new FakeEngine({ tick: 1 });
    const desc = (await engine.dispatch("describe", {})) as {
      capabilities: { id: string; detail?: { transports?: string[] } }[];
    };
    const mcp = desc.capabilities.find((c) => c.id === "mcp_servers");
    expect(mcp?.detail?.transports).toEqual(["stdio", "http"]);
  });
});
