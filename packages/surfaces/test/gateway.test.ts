import type { Conversation } from "@lilos/contracts/app";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_HEADER,
  SessionRegistry,
  SessionSurfaces,
} from "../src/index.js";
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
    browser?: boolean | FakeBrowser;
    appOps?: ReturnType<typeof fakeAppOps>;
    spawner?: FakePtySpawner;
  } = {},
) {
  const spawner = opts.spawner ?? new FakePtySpawner(true);
  const browser: FakeBrowser | undefined =
    opts.browser === true ? new FakeBrowser() : opts.browser || undefined;
  const scope = new SessionSurfaces({
    session,
    cwd: "/tmp",
    spawnPty: spawner.spawn,
    ...(browser ? { createBrowser: async () => browser } : {}),
    ...(opts.appOps ? { appOps: opts.appOps } : {}),
    binding: {
      employeeId: `emp-${session}`,
      channelId: `chan-${session}`,
      conversationId: `conv-${session}`,
    },
  });
  return { scope, spawner, browser };
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
      expect(msg.result.instructions).toContain("[LilOS host policy v2]");
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
    const opsA = fakeAppOps([], { conversationId: "conv-sess-A" });
    const opsB = fakeAppOps([], { conversationId: "conv-sess-B" });
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

describe("AC-3 aliases + catalog hardening (review)", () => {
  it("rebinding an alias moves it; removing the old owner keeps it live", async () => {
    const { scope: scopeA } = makeScope("sess-rA");
    const { scope: scopeB } = makeScope("sess-rB");
    const api = await serveGateway({
      sessions: [
        { scope: scopeA, token: "tok-rA", engineSessionId: "eng-shared" },
        { scope: scopeB, token: "tok-rB" },
      ],
    });
    try {
      // An alias can never shadow a real session id.
      expect(api.registry.bindEngineSession("sess-rA", "sess-rB")).toBe(false);
      // The engine restarts and rebinds its own id to the new session.
      expect(api.registry.bindEngineSession("sess-rB", "eng-shared")).toBe(
        true,
      );
      api.registry.remove("sess-rA");
      // The old owner's teardown must not take the live alias down.
      expect(api.registry.resolve("eng-shared")?.session).toBe("sess-rB");
      expect(api.registry.resolve("sess-rA")).toBeNull();
    } finally {
      api.server.close();
    }
  });

  it("Object.prototype keys are not tools — 404/-32602, never a 500", async () => {
    const { scope } = makeScope("s-proto");
    const api = await serveGateway({
      sessions: [{ scope, token: "tok-p" }],
    });
    try {
      const rest = await fetch(`${api.baseUrl}/tools/toString`, {
        method: "POST",
        headers: {
          authorization: "Bearer tok-p",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(rest.status).toBe(404);
      const rpc = (await (
        await mcpCall(`${api.baseUrl}/mcp`, "tok-p", {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "constructor", arguments: {} },
        })
      ).json()) as { error: { code: number } };
      expect(rpc.error.code).toBe(-32602);
    } finally {
      api.server.close();
    }
  });

  it("tools/call rejects names outside the session's areas", async () => {
    const { scope } = makeScope("s-lean2"); // terminal + workbench only
    const api = await serveGateway({
      sessions: [{ scope, token: "tok-l" }],
    });
    try {
      const rpc = (await (
        await mcpCall(`${api.baseUrl}/mcp`, "tok-l", {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "browser_open", arguments: { url: "http://x" } },
        })
      ).json()) as { error: { code: number; message: string } };
      expect(rpc.error.code).toBe(-32602);
      expect(rpc.error.message).toContain("browser_open");
      // Same over the plain tool API — thread_* isn't in this catalog.
      const rest = await fetch(`${api.baseUrl}/tools/thread_post`, {
        method: "POST",
        headers: {
          authorization: "Bearer tok-l",
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(rest.status).toBe(404);
      // An in-area call still goes through.
      const ok = await fetch(`${api.baseUrl}/tools/workbench_previews`, {
        method: "POST",
        headers: {
          authorization: "Bearer tok-l",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(ok.status).toBe(200);
    } finally {
      api.server.close();
    }
  });

  it("unparseable JSON-RPC bodies answer -32700 (parse error)", async () => {
    const { scope } = makeScope("s-parse");
    const api = await serveGateway({
      sessions: [{ scope, token: "tok-j" }],
    });
    try {
      const res = await fetch(`${api.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer tok-j",
          "content-type": "application/json",
        },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      const msg = (await res.json()) as { error: { code: number } };
      expect(msg.error.code).toBe(-32700);
    } finally {
      api.server.close();
    }
  });

  it("SessionRegistry.add also rejects an engine id shadowing a session", () => {
    const registry = new SessionRegistry();
    const { scope } = makeScope("s-real2");
    registry.add(scope, { token: "t" });
    const { scope: scope2 } = makeScope("s-other");
    // engineSessionId equal to an existing session id would shadow it.
    registry.add(scope2, { engineSessionId: "s-real2" });
    expect(registry.resolve("s-real2")?.session).toBe("s-real2");
  });
});

/* ------------------------------------------------------------------ */
/* Issue #340 AC-1 — the DM tools over the real gateway (engine-fake     */
/* session): every tool's happy path plus the scope limit.               */
/* ------------------------------------------------------------------ */

type ToolMsg = {
  result?: {
    content: { text: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  error?: { code: number; message: string };
};

async function dmCall(
  url: string,
  token: string,
  name: string,
  args: unknown,
  id = 1,
): Promise<ToolMsg> {
  return (await (
    await mcpCall(`${url}/mcp`, token, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    })
  ).json()) as ToolMsg;
}
const dmPayload = (m: ToolMsg) =>
  JSON.parse(m.result!.content[0].text) as Record<string, unknown>;

/** A second thread in the same DM for read/list/search coverage. */
const otherConv = (channelId: string): Conversation => ({
  id: "conv-other",
  channelId,
  rootMessageId: "r-other",
  engineRef: null,
  state: "idle",
  title: "Planning notes",
  titleSource: "auto",
  access: "ask",
  archived: false,
  deliveredSeq: 0,
  createdAt: 2,
});

const msg = (
  id: string,
  channelId: string,
  conversationId: string,
  seq: number,
  text: string,
  at: number,
) =>
  ({
    id,
    channelId,
    conversationId,
    seq,
    authorId: seq % 2 ? "user" : "agent",
    authorKind: seq % 2 ? "user" : "employee",
    text,
    rewound: false,
    dropped: false,
    removed: false,
    claimed: false,
    createdAt: at,
  }) as const;

describe("AC-1 DM tools over the gateway (issue #340)", () => {
  it("lilos_context answers who and where the session is", async () => {
    const ops = fakeAppOps([], {
      conversationId: "conv-s-ctx",
      employees: [
        {
          id: "emp-s-ctx",
          name: "Ada",
          role: "Engineer",
          status: "online",
          profile: "default",
          model: "fake-1",
          now: "DM tools",
          instructions: "",
          respondTo: "me",
          createdAt: 1,
        },
      ],
    });
    const { scope } = makeScope("s-ctx", { appOps: ops });
    const api = await serveGateway({
      sessions: [{ scope, token: "t-ctx" }],
    });
    try {
      const r = dmPayload(await dmCall(api.baseUrl, "t-ctx", "context", {}));
      expect(r.employee).toMatchObject({
        name: "Ada",
        role: "Engineer",
        model: "fake-1",
      });
      expect(r.channel).toMatchObject({ id: "chan-s-ctx", kind: "dm" });
      expect(r.thread).toMatchObject({
        id: "conv-s-ctx",
        title: "Thread conv-s-ctx",
        access: "ask", // #106
      });
      expect(r.user).toMatchObject({ name: "Oscar" });
      expect(r.mac).toMatchObject({ state: "ok" });
      expect(
        (r.mac as { components: unknown[] }).components.length,
      ).toBeGreaterThan(0);
      expect(r.hostPolicyVersion).toBe(2);
      expect(r.areas).toEqual(
        expect.arrayContaining(["root", "thread", "team", "workbench"]),
      );
    } finally {
      api.server.close();
    }
  });

  it("lilos_guide serves the index and each shipped page", async () => {
    const { scope } = makeScope("s-guide");
    const api = await serveGateway({
      sessions: [{ scope, token: "t-guide" }],
    });
    try {
      // No topic = the index — guide works even unbound (root is always-on).
      const idx = dmPayload(await dmCall(api.baseUrl, "t-guide", "guide", {}));
      expect(idx.topic).toBe("index");
      for (const topic of [
        "overview",
        "dm-and-threads",
        "employees",
        "approvals",
        "workbench",
        "mobile",
        "gateway",
      ]) {
        expect(idx.body).toContain(topic);
        const page = dmPayload(
          await dmCall(api.baseUrl, "t-guide", "guide", { topic }),
        );
        expect(page.topic).toBe(topic);
        expect((page.body as string).length).toBeGreaterThan(40);
      }
      // An unknown topic is a params error, not a result.
      const bad = await dmCall(api.baseUrl, "t-guide", "guide", {
        topic: "nope",
      });
      expect(bad.result?.isError).toBe(true);
      expect(bad.result?.content[0].text).toContain("invalid params");
    } finally {
      api.server.close();
    }
  });

  it("team_list returns the roster", async () => {
    const ops = fakeAppOps([], { conversationId: "conv-s-team" });
    const { scope } = makeScope("s-team", { appOps: ops });
    const api = await serveGateway({
      sessions: [{ scope, token: "t-team" }],
    });
    try {
      const r = dmPayload(await dmCall(api.baseUrl, "t-team", "team_list", {}));
      expect(r.employees).toEqual([
        expect.objectContaining({
          name: "Ada",
          role: "Engineer",
          status: "online",
          model: "fake-1",
        }),
      ]);
    } finally {
      api.server.close();
    }
  });

  it("thread_list marks the bound thread and carries its PRs", async () => {
    const pr = {
      number: 42,
      url: "https://github.com/o/r/pull/42",
      repo: "o/r",
      title: "Ship it",
      state: "open" as const,
      draft: false,
      head: "devin/x",
      base: "main",
      openedAt: "2026-10-01T00:00:00Z",
      checks: "passing" as const,
    };
    const ops = fakeAppOps([], {
      conversationId: "conv-s-list",
      conversations: [otherConv("chan-s-list")],
      prs: { "conv-s-list": [pr] },
    });
    const { scope } = makeScope("s-list", { appOps: ops });
    const api = await serveGateway({
      sessions: [{ scope, token: "t-list" }],
    });
    try {
      const r = dmPayload(
        await dmCall(api.baseUrl, "t-list", "thread_list", {}),
      );
      const threads = r.threads as {
        id: string;
        title: string;
        current: boolean;
        prs: unknown[];
      }[];
      expect(threads).toHaveLength(2);
      const mine = threads.find((t) => t.id === "conv-s-list")!;
      expect(mine.current).toBe(true);
      expect(mine.prs).toHaveLength(1);
      expect(threads.find((t) => t.id === "conv-other")!.current).toBe(false);
    } finally {
      api.server.close();
    }
  });

  it("thread_read windows the bound DM and never another", async () => {
    const ops = fakeAppOps(
      [
        msg("m1", "chan-s-rd", "conv-s-rd", 1, "plan the launch", 10),
        msg("m2", "chan-s-rd", "conv-s-rd", 2, "on it — drafting", 20),
        msg("m3", "chan-s-rd", "conv-other", 3, "note to self", 30),
        msg("m4", "chan-s-rd", "conv-s-rd", 4, "done — see the diff", 40),
      ],
      {
        conversationId: "conv-s-rd",
        conversations: [otherConv("chan-s-rd")],
      },
    );
    const { scope } = makeScope("s-rd", { appOps: ops });
    const api = await serveGateway({
      sessions: [{ scope, token: "t-rd" }],
    });
    try {
      // Default = the session's own thread.
      const own = dmPayload(
        await dmCall(api.baseUrl, "t-rd", "thread_read", {}),
      );
      expect((own.thread as { id: string }).id).toBe("conv-s-rd");
      // #106: thread_read reports the level (read-only — the agent never
      // sets it itself).
      expect((own.thread as { access?: string }).access).toBe("ask");
      expect((own.messages as { seq: number }[]).map((m) => m.seq)).toEqual([
        1, 2, 4,
      ]);

      // Another thread of the same DM — by id or by exact title.
      const byId = dmPayload(
        await dmCall(api.baseUrl, "t-rd", "thread_read", {
          thread: "conv-other",
        }),
      );
      expect((byId.thread as { title: string }).title).toBe("Planning notes");
      expect((byId.messages as { seq: number }[]).map((m) => m.seq)).toEqual([
        3,
      ]);
      const byTitle = dmPayload(
        await dmCall(api.baseUrl, "t-rd", "thread_read", {
          thread: "Planning notes",
        }),
      );
      expect((byTitle.thread as { id: string }).id).toBe("conv-other");

      // limit / before / afterSeq window the same thread.
      const limited = dmPayload(
        await dmCall(api.baseUrl, "t-rd", "thread_read", { limit: 1 }),
      );
      expect((limited.messages as { seq: number }[]).map((m) => m.seq)).toEqual(
        [4],
      );
      const before = dmPayload(
        await dmCall(api.baseUrl, "t-rd", "thread_read", { before: 4 }),
      );
      expect((before.messages as { seq: number }[]).map((m) => m.seq)).toEqual([
        1, 2,
      ]);
      const after = dmPayload(
        await dmCall(api.baseUrl, "t-rd", "thread_read", { afterSeq: 1 }),
      );
      expect((after.messages as { seq: number }[]).map((m) => m.seq)).toEqual([
        2, 4,
      ]);

      // A thread outside this DM is not_found — never silently readable.
      const theft = await dmCall(api.baseUrl, "t-rd", "thread_read", {
        thread: "conv-elsewhere",
      });
      expect(theft.result?.isError).toBe(true);
      expect(theft.result?.content[0].text).toContain("in this DM");
    } finally {
      api.server.close();
    }
  });

  it("thread_search stays inside the DM", async () => {
    const ops = fakeAppOps(
      [
        msg("m1", "chan-s-se", "conv-s-se", 1, "ship the launch page", 10),
        msg("m2", "chan-s-se", "conv-s-se", 2, "launch checklist done", 20),
        msg("m3", "chan-s-se", "conv-other", 3, "unrelated", 30),
      ],
      {
        conversationId: "conv-s-se",
        conversations: [otherConv("chan-s-se")],
      },
    );
    const { scope } = makeScope("s-se", { appOps: ops });
    const api = await serveGateway({
      sessions: [{ scope, token: "t-se" }],
    });
    try {
      const r = dmPayload(
        await dmCall(api.baseUrl, "t-se", "thread_search", {
          query: "launch",
        }),
      );
      const hits = r.hits as { messageId: string; snippet: string }[];
      expect(hits.map((h) => h.messageId).sort()).toEqual(["m1", "m2"]);
      const none = dmPayload(
        await dmCall(api.baseUrl, "t-se", "thread_search", { query: "zebra" }),
      );
      expect(none.hits).toEqual([]);
    } finally {
      api.server.close();
    }
  });

  it("thread_set_title renames only while the title is auto", async () => {
    const opsAuto = fakeAppOps([], { conversationId: "conv-s-ta" });
    const opsUser = fakeAppOps([], {
      conversationId: "conv-s-tu",
      titleSource: "user",
    });
    const { scope: sA } = makeScope("s-ta", { appOps: opsAuto });
    const { scope: sU } = makeScope("s-tu", { appOps: opsUser });
    const api = await serveGateway({
      sessions: [
        { scope: sA, token: "t-ta" },
        { scope: sU, token: "t-tu" },
      ],
    });
    try {
      const set = dmPayload(
        await dmCall(api.baseUrl, "t-ta", "thread_set_title", {
          title: "Launch work",
        }),
      );
      expect(set).toMatchObject({ outcome: "set", title: "Launch work" });
      expect(opsAuto.titled).toEqual(["Launch work"]);

      // #137: a user-typed title wins — the tool reports it, no overwrite.
      const kept = dmPayload(
        await dmCall(api.baseUrl, "t-tu", "thread_set_title", {
          title: "Sneaky rename",
        }),
      );
      expect(kept).toMatchObject({
        outcome: "user_title",
        title: "Thread conv-s-tu",
      });
    } finally {
      api.server.close();
    }
  });

  it("thread_prs lists the bound thread's PRs", async () => {
    const pr = {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      repo: "o/r",
      title: "Fix it",
      state: "merged" as const,
      draft: false,
      head: "devin/fix",
      base: "main",
      openedAt: "2026-09-01T00:00:00Z",
      checks: "passing" as const,
    };
    const ops = fakeAppOps([], {
      conversationId: "conv-s-pr",
      prs: { "conv-s-pr": [pr] },
    });
    const { scope } = makeScope("s-pr", { appOps: ops });
    const api = await serveGateway({
      sessions: [{ scope, token: "t-pr" }],
    });
    try {
      const r = dmPayload(await dmCall(api.baseUrl, "t-pr", "thread_prs", {}));
      expect(r.prs).toEqual([
        expect.objectContaining({ number: 7, title: "Fix it" }),
      ]);
    } finally {
      api.server.close();
    }
  });

  it("workbench_open forwards each target to the app", async () => {
    const ops = fakeAppOps([], { conversationId: "conv-s-wb" });
    const { scope, browser } = makeScope("s-wb", {
      appOps: ops,
      browser: true,
    });
    const api = await serveGateway({
      sessions: [{ scope, token: "t-wb" }],
    });
    try {
      for (const target of [
        { file: "src/app.ts", line: 7 },
        { diff: true, path: "src/app.ts" },
        { pr: true },
        { url: "http://localhost:5173" },
        /* #543: an engine tab — the only target shape a folderless
           session accepts. */
        { tab: "subagents" },
        { tab: "background" },
      ]) {
        const r = dmPayload(
          await dmCall(api.baseUrl, "t-wb", "workbench_open", target),
        );
        expect(r).toEqual({ opened: true });
      }
      expect(ops.opened).toEqual([
        { file: "src/app.ts", line: 7 },
        { diff: true, path: "src/app.ts" },
        { pr: true },
        { url: "http://localhost:5173" },
        { tab: "subagents" },
        { tab: "background" },
      ]);

      // The {url} target also navigates the session's browser — the app's
      // Workbench Preview shows the page, not a blank pane. The navigate is
      // fire-and-forget inside the handler — wait for it to land (#380).
      await vi.waitFor(() => {
        expect(browser?.url).toBe("http://localhost:5173");
      });

      /* #340 live-leg: the model guessed `{"diff": "<a diff string>"}` and
         got a bare HTTP 400 — invalid_params must surface the zod issues so
         it can correct itself. */
      const bad = await dmCall(api.baseUrl, "t-wb", "workbench_open", {
        diff: "<a unified diff string>",
        path: "thread-title",
      });
      expect(bad.result?.isError).toBe(true);
      const badText = bad.result?.content[0]?.text ?? "";
      expect(badText).toContain("diff");
      expect(badText).toContain("expected true");
      const rest = await fetch(`${api.baseUrl}/tools/workbench_open`, {
        method: "POST",
        headers: {
          authorization: "Bearer t-wb",
          "content-type": "application/json",
        },
        body: JSON.stringify({ diff: true, file: "x.ts" }),
      });
      expect(rest.status).toBe(400);
      const body = (await rest.json()) as {
        error?: { code?: string; message?: string };
      };
      expect(body.error?.code).toBe("invalid_params");
      expect(body.error?.message).toContain(
        "exactly one of `file`, `diff`, `pr`, `url`, `tab`",
      );
    } finally {
      api.server.close();
    }
  });

  it("thread/team tools are refused outside the session's areas", async () => {
    // Lean scope: terminal + workbench + root — no DM binding, no thread/team.
    const { scope } = makeScope("s-dmlean");
    const api = await serveGateway({
      sessions: [{ scope, token: "t-lean" }],
    });
    try {
      for (const name of [
        "team_list",
        "thread_list",
        "thread_read",
        "thread_search",
        "thread_post",
        "thread_set_title",
        "thread_prs",
      ]) {
        const r = await dmCall(api.baseUrl, "t-lean", name, {});
        expect(r.error?.code).toBe(-32602);
        expect(r.error?.message).toContain(name);
        const rest = await fetch(`${api.baseUrl}/tools/${name}`, {
          method: "POST",
          headers: {
            authorization: "Bearer t-lean",
            "content-type": "application/json",
          },
          body: "{}",
        });
        expect(rest.status).toBe(404);
      }
      // workbench_open stays advertised but reports cleanly when no DM bound.
      const wb = await dmCall(api.baseUrl, "t-lean", "workbench_open", {
        diff: true,
      });
      expect(wb.result?.isError).toBe(true);
      // Same for context — an unbound session gets `unavailable`, not a crash.
      const ctx = await dmCall(api.baseUrl, "t-lean", "context", {});
      expect(ctx.result?.isError).toBe(true);
      expect(ctx.result?.content[0].text).toContain("no conversation");
    } finally {
      api.server.close();
    }
  });
});
