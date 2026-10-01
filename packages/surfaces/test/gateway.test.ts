import { describe, expect, it } from "vitest";
import { SESSION_HEADER, SessionSurfaces } from "../src/index.js";
import {
  FakeBrowser,
  FakePtySpawner,
  fakeAppOps,
  serveGateway,
} from "./fakes.js";

/**
 * Issue #337 — the agent gateway over HTTP: one endpoint carrying MCP
 * (initialize / tools/list / tools/call) per session, the catalog leg, and
 * the session binding that keeps every call on its own surfaces.
 */
function makeScope(
  session: string,
  opts: {
    browser?: boolean;
    appOps?: ReturnType<typeof fakeAppOps>;
    spawner?: FakePtySpawner;
  } = {},
) {
  const spawner = opts.spawner ?? new FakePtySpawner(true);
  const scope = new SessionSurfaces({
    session,
    cwd: "/tmp",
    spawnPty: spawner.spawn,
    ...(opts.browser ? { createBrowser: async () => new FakeBrowser() } : {}),
    ...(opts.appOps ? { appOps: opts.appOps } : {}),
    binding: {
      employeeId: `emp-${session}`,
      channelId: `chan-${session}`,
      conversationId: `conv-${session}`,
    },
  });
  return { scope, spawner };
}

const mcpCall = (url: string, token: string, msg: unknown, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(msg),
  });

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };

describe("AC-2 MCP over streamable HTTP", () => {
  it("initialize returns capabilities + the rendered host policy", async () => {
    const appOps = fakeAppOps();
    const { scope } = makeScope("s-gw", { browser: true, appOps });
    const api = await serveGateway({
      sessions: [{ scope, token: "tok-gw" }],
    });
    try {
      const res = await mcpCall(`${api.baseUrl}/mcp`, "tok-gw", init);
      expect(res.status).toBe(200);
      const msg = (await res.json()) as {
        result: {
          protocolVersion: string;
          capabilities: { tools: unknown };
          instructions: string;
        };
      };
      expect(msg.result.protocolVersion).toBe("2025-06-18");
      expect(msg.result.capabilities.tools).toBeDefined();
      // The host policy rides in `instructions` — and knows this session's areas.
      expect(msg.result.instructions).toContain("[LilOS host policy v1]");
      expect(msg.result.instructions).toContain("browser_*");
      expect(msg.result.instructions).toContain("thread_*");
    } finally {
      api.server.close();
    }
  });

  it("tools/list advertises only the session's real areas", async () => {
    const { scope } = makeScope("s-lean"); // terminal + workbench only
    const api = await serveGateway({
      sessions: [{ scope, token: "tok-lean" }],
    });
    try {
      const res = await mcpCall(`${api.baseUrl}/mcp`, "tok-lean", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      const msg = (await res.json()) as {
        result: { tools: { name: string }[] };
      };
      const names = msg.result.tools.map((t) => t.name);
      expect(names).toContain("terminal_run");
      expect(names).toContain("workbench_previews");
      expect(names.some((n) => n.startsWith("browser_"))).toBe(false);
      expect(names.some((n) => n.startsWith("thread_"))).toBe(false);
      // Catalog entries carry the schema the client needs.
      const run = msg.result.tools.find((t) => t.name === "terminal_run")!;
      expect(run).toMatchObject({
        annotations: { readOnlyHint: false },
        _meta: { "lilos/area": "terminal", "lilos/access": "write" },
      });
    } finally {
      api.server.close();
    }
  });

  it("tools/call runs the scoped tool; notifications get 202; bad auth gets 401", async () => {
    const appOps = fakeAppOps();
    const { scope } = makeScope("s-call", { appOps });
    const api = await serveGateway({
      sessions: [{ scope, token: "tok-call" }],
    });
    try {
      const call = (await (
        await mcpCall(`${api.baseUrl}/mcp`, "tok-call", {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "thread_post", arguments: { text: "ping" } },
        })
      ).json()) as {
        result: { content: { text: string }[]; structuredContent: unknown };
      };
      const posted = JSON.parse(call.result.content[0].text) as {
        message: { text: string };
      };
      expect(posted.message.text).toBe("ping");
      expect(appOps.posted).toEqual(["ping"]);
      expect(call.result.structuredContent).toMatchObject({
        message: { text: "ping" },
      });

      // Notifications / stray responses acknowledge with 202 and no body.
      const notif = await mcpCall(`${api.baseUrl}/mcp`, "tok-call", {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      expect(notif.status).toBe(202);

      // Unknown tool is a JSON-RPC error, not a transport failure.
      const unknown = (await (
        await mcpCall(`${api.baseUrl}/mcp`, "tok-call", {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "nope", arguments: {} },
        })
      ).json()) as { error: { code: number; message: string } };
      expect(unknown.error.code).toBe(-32602);

      // No bearer → 401, nothing dispatched.
      const denied = await fetch(`${api.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(init),
      });
      expect(denied.status).toBe(401);
    } finally {
      api.server.close();
    }
  });

  it("a JSON-RPC batch answers per request in one response", async () => {
    const { scope } = makeScope("s-batch");
    const api = await serveGateway({
      sessions: [{ scope, token: "tok-b" }],
    });
    try {
      const res = await mcpCall(`${api.baseUrl}/mcp`, "tok-b", [
        init,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ]);
      const msgs = (await res.json()) as { id: number }[];
      expect(msgs.map((m) => m.id).sort()).toEqual([1, 2]);
    } finally {
      api.server.close();
    }
  });

  it("GET /tools renders the same session catalog as tools/list", async () => {
    const { scope } = makeScope("s-cat", { appOps: fakeAppOps() });
    const api = await serveGateway({
      sessions: [{ scope, token: "tok-c" }],
    });
    try {
      const res = await fetch(`${api.baseUrl}/tools`, {
        headers: { authorization: "Bearer tok-c" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        tools: { name: string; inputSchema: unknown }[];
      };
      const names = body.tools.map((t) => t.name);
      expect(names).toContain("thread_post");
      expect(names).toContain("terminal_run");
      expect(names.some((n) => n.startsWith("browser_"))).toBe(false);
    } finally {
      api.server.close();
    }
  });
});

describe("AC-3 session binding — scope from the session, never agent-passed", () => {
  it("two parallel sessions each see only their own thread", async () => {
    const opsA = fakeAppOps();
    const opsB = fakeAppOps();
    const { scope: scopeA } = makeScope("sess-A", { appOps: opsA });
    const { scope: scopeB } = makeScope("sess-B", { appOps: opsB });
    const api = await serveGateway({
      sessions: [
        { scope: scopeA, token: "tok-A" },
        { scope: scopeB, token: "tok-B" },
      ],
    });
    try {
      const read = (token: string, session?: string) =>
        mcpCall(
          `${api.baseUrl}/mcp`,
          token,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "thread_read", arguments: {} },
          },
          session ? { [SESSION_HEADER]: session } : {},
        );
      const post = (token: string, text: string, session?: string) =>
        mcpCall(
          `${api.baseUrl}/mcp`,
          token,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "thread_post", arguments: { text } },
          },
          session ? { [SESSION_HEADER]: session } : {},
        );

      // Each call lands on its own session's appOps — the binding decides.
      await post("tok-A", "from A");
      await post("tok-B", "from B", "sess-B");
      expect(opsA.posted).toEqual(["from A"]);
      expect(opsB.posted).toEqual(["from B"]);

      const textOf = async (r: Response) =>
        JSON.parse(
          (
            (await r.json()) as {
              result: { content: { text: string }[] };
            }
          ).result.content[0].text,
        ) as { messages: { text: string }[] };
      expect((await textOf(await read("tok-A"))).messages[0].text).toBe(
        "from A",
      );
      expect(
        (await textOf(await read("tok-B", "sess-B"))).messages[0].text,
      ).toBe("from B");

      // A's token cannot reach B's scope — even naming B's session id.
      const theft = await read("tok-A", "sess-B");
      expect(theft.status).toBe(401);
      expect(opsB.posted).toEqual(["from B"]);
    } finally {
      api.server.close();
    }
  });

  it("resolves the engine's own session id via the registered alias", async () => {
    const ops = fakeAppOps();
    const { scope } = makeScope("s-real", { appOps: ops });
    const api = await serveGateway({
      sessions: [
        { scope, token: "tok-real", engineSessionId: "20261001_124426_cb5b3e" },
      ],
    });
    try {
      // An engine-side caller names its own Hermes-style id; the gateway
      // maps it to the bound session.
      const res = await mcpCall(
        `${api.baseUrl}/mcp`,
        "tok-real",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "thread_post", arguments: { text: "via engine id" } },
        },
        { [SESSION_HEADER]: "20261001_124426_cb5b3e" },
      );
      expect(res.status).toBe(200);
      expect(ops.posted).toEqual(["via engine id"]);

      // Also over the plain tool API.
      const tools = await fetch(`${api.baseUrl}/tools`, {
        headers: {
          authorization: "Bearer tok-real",
          [SESSION_HEADER]: "20261001_124426_cb5b3e",
        },
      });
      expect(tools.status).toBe(200);

      // The alias doesn't launder a foreign token.
      const wrong = await mcpCall(`${api.baseUrl}/mcp`, "tok-other", init, {
        [SESSION_HEADER]: "20261001_124426_cb5b3e",
      });
      expect(wrong.status).toBe(401);
    } finally {
      api.server.close();
    }
  });
});
