import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { LILOS_TOOLS } from "@lilos/contracts/harness";
import { describe, expect, it } from "vitest";
import { SessionSurfaces } from "../src/index.js";
import {
  FakeBrowser,
  FakePtySpawner,
  fakeAppOps,
  serveGateway,
} from "./fakes.js";

const CLI = resolve(__dirname, "../../../apps/lilos/src/cli.ts");

/** Minimal MCP stdio client — JSON-RPC over newline-delimited stdio. */
function mcpClient(child: ReturnType<typeof spawn>) {
  let buf = "";
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  let nextId = 1;
  child.stdout?.on("data", (d) => {
    buf += d.toString();
    for (;;) {
      const i = buf.indexOf("\n");
      if (i < 0) break;
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as {
        id?: number;
        error?: { message: string };
        result?: unknown;
      };
      const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!p || msg.id === undefined) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });
  const request = (method: string, params?: unknown) =>
    new Promise<unknown>((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`,
      );
    });
  const notify = (method: string) =>
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  return { request, notify };
}

async function startMcp(env: NodeJS.ProcessEnv) {
  const child = spawn("bun", [CLI, "mcp"], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const c = mcpClient(child);
  await c.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  c.notify("notifications/initialized");
  return { child, ...c };
}

describe("AC-2 MCP server: tools/list + tools/call over real stdio", () => {
  it("serves the session's tools and routes calls to the scoped backend", async () => {
    const spawner = new FakePtySpawner();
    const browser = new FakeBrowser();
    const appOps = fakeAppOps();
    const scope = new SessionSurfaces({
      session: "sess-mcp",
      cwd: "/tmp",
      spawnPty: spawner.spawn,
      createBrowser: async () => browser,
      appOps,
    });
    const api = await serveGateway({
      sessions: [{ scope, token: "tok" }],
    });
    const { child, request } = await startMcp({
      LILOS_SURFACES_URL: api.baseUrl,
      LILOS_TOKEN: "tok",
      LILOS_SESSION: "sess-mcp",
    });
    try {
      const list = (await request("tools/list")) as {
        tools: { name: string; description: string }[];
      };
      expect(list.tools.map((t) => t.name).sort()).toEqual(
        Object.keys(LILOS_TOOLS).sort(),
      );
      expect(list.tools[0].description).toBeTruthy();

      const call = (await request("tools/call", {
        name: "browser_open",
        arguments: { url: "http://localhost:7777" },
      })) as { content: { text: string }[] };
      expect(browser.url).toBe("http://localhost:7777");
      expect(JSON.parse(call.content[0].text)).toMatchObject({
        url: "http://localhost:7777",
      });

      const msg = (await request("tools/call", {
        name: "thread_post",
        arguments: { text: "via mcp" },
      })) as { content: { text: string }[] };
      expect(JSON.parse(msg.content[0].text).message.text).toBe("via mcp");
    } finally {
      child.kill();
      api.server.close();
    }
  }, 30_000);

  it("lists only the areas the session really has (no browser -> no browser_*)", async () => {
    // AC-2: a session with no browser attached never sees browser_* — the
    // stdio server asks the gateway for this session's catalog (GET /tools)
    // and registers only those.
    const spawner = new FakePtySpawner();
    const scope = new SessionSurfaces({
      session: "sess-tiny",
      cwd: "/tmp",
      spawnPty: spawner.spawn,
      // no createBrowser, no appOps: terminal + workbench areas only
    });
    const api = await serveGateway({
      sessions: [{ scope, token: "tok" }],
    });
    const { child, request } = await startMcp({
      LILOS_SURFACES_URL: api.baseUrl,
      LILOS_TOKEN: "tok",
      LILOS_SESSION: "sess-tiny",
    });
    try {
      const list = (await request("tools/list")) as {
        tools: { name: string }[];
      };
      expect(list.tools.map((t) => t.name).sort()).toEqual(
        [
          "terminal_read",
          "terminal_run",
          "terminal_write",
          "workbench_previews",
        ].sort(),
      );
    } finally {
      child.kill();
      api.server.close();
    }
  }, 30_000);

  it("AC-6 measure per-turn tool-schema token cost (tools/list bytes / 4)", async () => {
    // Same method as spike #23: MCP tools/list JSON size, bytes/4 tokens.
    // Measured in-process (the SDK serializes identically over stdio).
    const { toJSONSchema } = await import("zod");
    const toolDefs = Object.entries(LILOS_TOOLS).map(([name, t]) => ({
      name,
      description: t.doc,
      inputSchema: toJSONSchema(t.params as never) as Record<string, unknown>,
    }));
    const payload = JSON.stringify({ tools: toolDefs });
    const tokens = Math.ceil(payload.length / 4);
    // The AC-6 number — printed in the test output for the PR body.
    process.stdout.write(
      `[AC-6] tools/list payload = ${payload.length} bytes ≈ ${tokens} tokens\n`,
    );
    expect(toolDefs.length).toBe(Object.keys(LILOS_TOOLS).length);
  });
});

describe("lilos CLI (AC-2)", () => {
  it("runs a tool subcommand and prints JSON", async () => {
    const spawner = new FakePtySpawner();
    const scope = new SessionSurfaces({
      session: "sess-cli",
      cwd: "/tmp",
      spawnPty: spawner.spawn,
      createBrowser: async () => new FakeBrowser(),
    });
    const api = await serveGateway({
      sessions: [{ scope, token: "tok" }],
    });
    const env = {
      ...process.env,
      LILOS_SURFACES_URL: api.baseUrl,
      LILOS_TOKEN: "tok",
      LILOS_SESSION: "sess-cli",
    };
    const run = (args: string[]) =>
      new Promise<string>((res, rej) => {
        const child = spawn("bun", [CLI, ...args], { env });
        let stdout = "";
        child.stdout?.on("data", (d) => {
          stdout += d;
        });
        child.on("exit", (code) =>
          code === 0 ? res(stdout) : rej(new Error(`exit ${code}`)),
        );
      });
    try {
      const out = await run([
        "browser_open",
        JSON.stringify({ url: "http://a.b" }),
      ]);
      expect(JSON.parse(out)).toMatchObject({ url: "http://a.b" });

      const tools = await run(["tools"]);
      expect(JSON.parse(tools)).toEqual(Object.keys(LILOS_TOOLS));
    } finally {
      api.server.close();
    }
  }, 30_000);
});
