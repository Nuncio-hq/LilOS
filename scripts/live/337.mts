#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Issue #337 live check — the agent gateway seam, for real:
 *
 *   - `serveSurfaces` (apps/harness): real Chromium + real PTY, and the
 *     gateway HTTP surface on a real socket.
 *   - POST /mcp (streamable HTTP): initialize carrying the rendered host
 *     policy, tools/list filtered to the session's real areas, tools/call
 *     running terminal_run on the real PTY and thread_post/thread_read on
 *     the session's bound conversation.
 *   - AC-3 binding: two sessions, per-session bearers; a caller naming the
 *     OTHER session's id is refused (401); the engine's own session id
 *     resolves through the registered alias.
 *   - `lilos thread read` — the CLI renders the same catalog onto the wire.
 *   - engine-fake: a real engine session attaches `{type:"http"}` MCP and
 *     drives thread_post + thread_read through POST /mcp (the issue's e2e).
 *   - `hermes acp` (real binary): ACP initialize + session/new still accepts
 *     the session's stdio `mcpServers` spec — the HTTP attach is the
 *     engine-side adapter that lands in #339, so here we prove the engine
 *     seam the gateway sits behind stays intact. (ACP mcpServers are
 *     stdio-only; that is why the HTTP leg is checked directly.)
 *
 * Modes:
 *   stub (default): a scratch HERMES_HOME registers `lilos-stub`, a
 *     deterministic OpenAI-compatible provider in this script.
 *   real: HERMES_PROVIDER + HERMES_MODEL set -> the real ~/.hermes is used
 *     untouched; a real model is asked to call the lilos terminal_run tool
 *     (stdio attach) and the PTY marker proves it landed.
 *
 * Prints PASS/FAIL per check plus a summary line. Exit 0 = all pass.
 */
import { serveSurfaces } from "../../apps/harness/src/surfaces/server.ts";

const MARKER = `LIVE337-${Math.random().toString(36).slice(2, 8)}`;
const REAL_PROVIDER = (process.env.HERMES_PROVIDER || "").trim();
const REAL_MODEL = (process.env.HERMES_MODEL || "").trim();
const results: [boolean, string, string][] = [];
const check = (ok: boolean, name: string, detail = "") => {
  results.push([ok, name, detail]);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
};

// ── in-memory thread store the harness would hand appOps (relay seam #339) ──

const makeAppOps = (conversationId: string) => {
  const messages: { seq: number; text: string; id: string }[] = [];
  return {
    messages,
    async postMessage(text: string) {
      const m = {
        id: `m${messages.length + 1}`,
        channelId: "chan-1",
        conversationId,
        seq: messages.length + 1,
        authorId: "agent",
        authorKind: "employee" as const,
        text,
        rewound: false,
        createdAt: Date.now(),
      };
      messages.push(m);
      return m;
    },
    async readConversation(afterSeq?: number) {
      return afterSeq ? messages.filter((m) => m.seq > afterSeq) : messages;
    },
  };
};

// ── MCP streamable-HTTP client (what an engine's HTTP adapter does) ──────────

class HttpMcp {
  private nextId = 0;
  constructor(
    private url: string,
    private token: string,
    private session?: string,
  ) {}
  private async post(msg: Record<string, unknown>) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.token}`,
        ...(this.session ? { "x-lilos-session": this.session } : {}),
      },
      body: JSON.stringify(msg),
    });
    return res;
  }
  async request(method: string, params: Record<string, unknown> = {}) {
    const res = await this.post({
      jsonrpc: "2.0",
      id: ++this.nextId,
      method,
      params,
    });
    const text = await res.text();
    const ct = res.headers.get("content-type") ?? "";
    const payload = ct.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("")
      : text;
    return { status: res.status, body: payload ? JSON.parse(payload) : null };
  }
}

// ── tiny stdio JSON-RPC client (ACP) ─────────────────────────────────────────

class StdioRpc {
  private buf = "";
  private waiters = new Map<number, (v: unknown) => void>();
  private nextId = 0;
  constructor(private proc: ReturnType<typeof spawn>) {
    proc.stdout!.on("data", (d) => {
      this.buf += d.toString();
      for (;;) {
        const i = this.buf.indexOf("\n");
        if (i < 0) break;
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof msg.id === "number" && this.waiters.has(msg.id)) {
          this.waiters.get(msg.id)!(msg);
          this.waiters.delete(msg.id);
        }
      }
    });
  }
  request(
    method: string,
    params: unknown,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    this.proc.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`${method} timed out`)),
        timeoutMs,
      );
      this.waiters.set(id, (v) => {
        clearTimeout(t);
        resolve(v as Record<string, unknown>);
      });
    });
  }
}

// ── deterministic OpenAI-compatible stub provider (from scripts/live/36.mts) ──

function startStub() {
  const seen: { tools: string[]; text: string }[] = [];
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: ["stub-model-a"].map((id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "lilos-stub",
          })),
        });
      }
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body = (await req.json()) as {
          stream?: boolean;
          tools?: { function?: { name?: string } }[];
          messages?: { role: string; content?: unknown; name?: string }[];
        };
        const tools = (body.tools ?? [])
          .map((t) => t.function?.name ?? "")
          .filter(Boolean);
        const last = [...(body.messages ?? [])].reverse()[0];
        const lastText =
          typeof last?.content === "string"
            ? last.content
            : JSON.stringify(last?.content ?? "");
        seen.push({ tools, text: lastText.slice(0, 400) });
        const termTool = tools.find((n) => /terminal_run/i.test(n));
        const msgs = body.messages ?? [];
        const toolMsgs = msgs.filter((m) => m.role === "tool");
        const toolText = (m: { content?: unknown }) =>
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content ?? "");
        const searched = toolMsgs.some((m) =>
          /mcp__lilos__terminal_run/.test(toolText(m)),
        );
        const ranLilos = toolMsgs.some((m) => /FROM-MODEL/.test(toolText(m)));
        const searchTool = tools.find((n) => /^tool_search$/i.test(n));
        const callTool = tools.find((n) => /^tool_call$/i.test(n));
        const wantCall = ranLilos
          ? null
          : termTool
            ? {
                id: "call_lilos_1",
                name: termTool,
                arguments: { command: `echo ${MARKER}-FROM-MODEL` },
              }
            : searched && callTool
              ? {
                  id: "call_lilos_2",
                  name: callTool,
                  arguments: {
                    calls: [
                      {
                        name: "mcp__lilos__terminal_run",
                        arguments: { command: `echo ${MARKER}-FROM-MODEL` },
                      },
                    ],
                  },
                }
              : searchTool
                ? {
                    id: `call_search_${toolMsgs.length}`,
                    name: searchTool,
                    arguments: { queries: ["terminal_run"] },
                  }
                : null;
        const toolCallDelta = (call: {
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        }) => ({
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              },
            ],
          },
        });
        const toolCallMsg = (call: {
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        }) => ({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            },
          ],
        });
        const sse = (chunks: Record<string, unknown>[]) => {
          const payload =
            chunks
              .map(
                (c) =>
                  `data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", created: 0, model: "stub-model-a", choices: [{ index: 0, ...c }] })}\n\n`,
              )
              .join("") + "data: [DONE]\n\n";
          return new Response(payload, {
            headers: { "content-type": "text/event-stream" },
          });
        };
        if (body.stream) {
          if (wantCall) {
            return sse([
              toolCallDelta(wantCall),
              { delta: {}, finish_reason: "tool_calls" },
            ]);
          }
          return sse([
            { delta: { role: "assistant", content: `stub:${MARKER}` } },
            { delta: {}, finish_reason: "stop" },
          ]);
        }
        if (wantCall) {
          return Response.json({
            id: "chatcmpl-stub",
            object: "chat.completion",
            created: 0,
            model: "stub-model-a",
            choices: [
              {
                index: 0,
                message: toolCallMsg(wantCall),
                finish_reason: "tool_calls",
              },
            ],
          });
        }
        return Response.json({
          id: "chatcmpl-stub",
          object: "chat.completion",
          created: 0,
          model: "stub-model-a",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `stub:${MARKER}` },
              finish_reason: "stop",
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${srv.port}`,
    seen,
    stop: () => srv.stop(true),
  };
}

async function main() {
  const mode = REAL_PROVIDER
    ? `real provider ${REAL_PROVIDER}/${REAL_MODEL || "(default)"}`
    : "STUB provider lilos-stub (deterministic; no real LLM completing turns)";
  console.log(`# issue #337 live check — mode: ${mode}`);

  const stores = new Map<string, ReturnType<typeof makeAppOps>>();
  const surfaces = await serveSurfaces(0, {
    appOps: (session, binding) => {
      const conv = binding?.conversationId ?? "conv-none";
      const store = makeAppOps(conv);
      stores.set(session, store);
      return store;
    },
  });

  try {
    // 1. Two bound sessions — distinct employees/threads + an engine alias.
    const createSession = async (body: Record<string, unknown>) =>
      (await (
        await fetch(`${surfaces.url}/surfaces/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json()) as {
        session: string;
        token: string;
        mcpServer: { args: string[]; env: { name: string; value: string }[] };
        mcpServerHttp: { type: string; url: string };
      };
    const engineIdA = `20261001_${Date.now() % 1000000}_abcd1`.slice(0, 20);
    const a = await createSession({
      cwd: process.env.HOME,
      binding: {
        employeeId: "emp-ada",
        channelId: "chan-ada",
        conversationId: "conv-ada",
      },
      engineSessionId: engineIdA,
    });
    const b = await createSession({
      cwd: process.env.HOME,
      binding: {
        employeeId: "emp-bex",
        channelId: "chan-bex",
        conversationId: "conv-bex",
      },
    });
    check(
      a.mcpServerHttp?.type === "http" && a.mcpServerHttp.url.endsWith("/mcp"),
      "session create returns the HTTP MCP spec (AC-2)",
      JSON.stringify(a.mcpServerHttp),
    );

    const mcpA = new HttpMcp(`${surfaces.url}/mcp`, a.token);
    const mcpAaliased = new HttpMcp(`${surfaces.url}/mcp`, a.token, engineIdA);

    // 2. initialize carries the rendered host policy, scoped to real areas.
    const init = await mcpA.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "live-337", version: "0" },
    });
    const instructions = String(init.body?.result?.instructions ?? "");
    check(
      init.status === 200 && /\[LilOS host policy v\d+\]/.test(instructions),
      "mcp initialize carries the versioned host policy (AC-5)",
    );
    check(
      instructions.includes("thread_*") &&
        !/channel|sessions/.test("") &&
        instructions.length <= 2000,
      "policy mentions thread area, stays under 2000 chars (AC-5)",
      `len=${instructions.length}`,
    );

    // 3. tools/list renders from the catalog, filtered to real areas.
    const listed = await mcpA.request("tools/list");
    const names = (
      (listed.body?.result?.tools ?? []) as { name: string }[]
    ).map((t) => t.name);
    check(
      names.includes("thread_post") &&
        names.includes("thread_read") &&
        names.includes("terminal_run") &&
        names.includes("browser_open"),
      "tools/list: catalog names incl. thread_* for a bound session (AC-1)",
      names.join(","),
    );

    // 4. tools/call: thread_post lands on THIS session's binding.
    const posted = await mcpA.request("tools/call", {
      name: "thread_post",
      arguments: { text: `hello ${MARKER}` },
    });
    check(
      posted.status === 200 && !posted.body?.result?.isError,
      "tools/call thread_post",
    );
    const readBack = await mcpA.request("tools/call", {
      name: "thread_read",
      arguments: {},
    });
    const threadText = JSON.stringify(readBack.body ?? {});
    check(
      threadText.includes(`hello ${MARKER}`),
      "tools/call thread_read returns the posted message (AC-3)",
    );
    check(
      !stores.get(b.session)?.messages.length,
      "session B's thread untouched by A's calls (AC-3)",
    );

    // 5. terminal_run on the real PTY through the same endpoint.
    const ran = await mcpA.request("tools/call", {
      name: "terminal_run",
      arguments: { command: `echo ${MARKER}-PTY` },
    });
    check(
      JSON.stringify(ran.body ?? {}).includes(`${MARKER}-PTY`),
      "tools/call terminal_run on the real PTY",
    );

    // 6. AC-3 isolation: A's token naming B's session is refused.
    const mcpAasB = new HttpMcp(`${surfaces.url}/mcp`, a.token, b.session);
    const theft = await mcpAasB.request("tools/list");
    check(theft.status === 401, "A's bearer naming B's session → 401 (AC-3)");

    // 7. AC-3 alias: the engine's own session id resolves to the scope.
    const aliasList = await mcpAaliased.request("tools/list");
    check(
      aliasList.status === 200 &&
        ((aliasList.body?.result?.tools ?? []) as { name: string }[]).some(
          (t) => t.name === "thread_post",
        ),
      "engine session-id alias resolves the scope (AC-3)",
      `engineId=${engineIdA}`,
    );

    // 8. GET /tools renders the same catalog (what the CLI feeds on).
    const cat = await (
      await fetch(`${surfaces.url}/tools`, {
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).json();
    check(
      (cat.tools ?? []).length === names.length,
      "GET /tools renders the same session catalog",
    );

    // 9. The `lilos` CLI renders from the catalog: `lilos thread read`.
    const cliPath = a.mcpServer.args[0];
    const cliEnv = Object.fromEntries(
      a.mcpServer.env.map((e) => [e.name, e.value]),
    );
    const cli = spawn("bun", [cliPath, "thread", "read"], {
      env: { ...(process.env as Record<string, string>), ...cliEnv },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let cliOut = "";
    cli.stdout!.on("data", (d) => (cliOut += d.toString()));
    await new Promise((r) => cli.on("close", r));
    check(
      cliOut.includes(`hello ${MARKER}`),
      "`lilos thread read` renders the catalog onto the wire (AC-1)",
      cliOut.trim().slice(0, 100),
    );

    // 10. engine-fake over HTTP MCP — the issue's verify leg, for real.
    const { FakeEngine } = await import(
      new URL("../../packages/engine-fake/src/engine.ts", import.meta.url)
        .pathname
    );
    const engine = new FakeEngine({ tick: 1 });
    const toolEvents: { tool: string; status: string }[] = [];
    engine.onEvent((e) => {
      if (e.type === "tool.completed")
        toolEvents.push(e.payload as { tool: string; status: string });
    });
    const start = await engine.dispatch("session.start", {
      agent: "builder",
      cwd: process.env.HOME,
      mcpServers: [
        {
          type: "http",
          name: "lilos",
          url: `${surfaces.url}/mcp`,
          headers: [{ name: "Authorization", value: `Bearer ${b.token}` }],
        },
      ],
    });
    await engine.dispatch("prompt", {
      sessionId: (start as { sessionId: string }).sessionId,
      content: [{ type: "text", text: `surfaces: say ${MARKER}-ENGINE; conv` }],
    });
    const bad = toolEvents.filter((t) => t.status !== "completed");
    check(
      toolEvents.length >= 2 && bad.length === 0,
      "engine-fake drives thread_post + thread_read over POST /mcp",
      bad.map((t) => `${t.tool}:${t.status}`).join(","),
    );
    check(
      (stores.get(b.session)?.messages ?? []).some((m) =>
        m.text.includes(`${MARKER}-ENGINE`),
      ),
      "engine's post landed on B's bound thread only",
    );
    engine.closeAllMcp();

    // 11. Real `hermes acp`: the engine seam the gateway sits behind.
    //     ACP session/new mcpServers are stdio-only — the HTTP attach is the
    //     #339 adapter — so this leg proves the existing attach still works.
    let hermesHome = process.env.HERMES_HOME;
    let stub: ReturnType<typeof startStub> | null = null;
    if (!REAL_PROVIDER) {
      stub = startStub();
      hermesHome = mkdtempSync(join(tmpdir(), "lilos337-hermes-"));
      writeFileSync(
        join(hermesHome, "config.yaml"),
        "model:\n" +
          "  provider: lilos-stub\n" +
          "  default: stub-model-a\n" +
          "custom_providers:\n" +
          "  - name: lilos-stub\n" +
          `    base_url: ${stub.url}/v1\n` +
          "    api_key: sk-lilos-stub\n" +
          "    api_mode: chat_completions\n" +
          "    models:\n      - stub-model-a\n",
      );
    }
    const markerLog = join(
      mkdtempSync(join(tmpdir(), "lilos337-")),
      "spawn.log",
    );
    const mcpEnv = { ...cliEnv, LILOS_MCP_SPAWN_LOG: markerLog };
    const acp = spawn("hermes", ["acp"], {
      env: {
        ...(process.env as Record<string, string>),
        ...(hermesHome ? { HERMES_HOME: hermesHome } : {}),
      },
      cwd: process.env.HOME ?? "/tmp",
      stdio: ["pipe", "pipe", "inherit"],
    });
    const arpc = new StdioRpc(acp);
    try {
      const ainit = await arpc.request(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: { name: "lilos-live-337", version: "0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        180_000,
      );
      check(!!ainit.result, "hermes acp initialize");
      const snew = await arpc.request(
        "session/new",
        {
          cwd: process.env.HOME,
          mcpServers: [
            {
              name: "lilos",
              command: "bun",
              args: [cliPath, "mcp"],
              env: Object.entries(mcpEnv).map(([name, value]) => ({
                name,
                value,
              })),
            },
          ],
        },
        90_000,
      );
      const sessionId = (snew.result as { sessionId?: string })?.sessionId;
      check(!!sessionId, "hermes acp session/new accepts the stdio spec");
      const t1 = Date.now();
      while (Date.now() - t1 < 20_000 && !existsSync(markerLog)) {
        await new Promise((r) => setTimeout(r, 300));
      }
      const spawned = existsSync(markerLog)
        ? readFileSync(markerLog, "utf8")
        : "";
      check(
        spawned.includes(`session=${a.session}`),
        "hermes spawned `lilos mcp` bound to the session (LILOS_MCP_SPAWN_LOG)",
        spawned.trim().split("\n")[0] ?? "",
      );

      if (sessionId && REAL_PROVIDER) {
        // Real model: ask it to drive the lilos terminal_run tool.
        const pr = await arpc
          .request(
            "session/prompt",
            {
              sessionId,
              prompt: [
                {
                  type: "text",
                  text: `Call the lilos terminal_run tool with command "echo ${MARKER}-FROM-MODEL" then say done.`,
                },
              ],
            },
            120_000,
          )
          .catch((e) => ({ error: String(e) }));
        check(
          !("error" in pr),
          "session/prompt completes (real provider)",
          JSON.stringify(pr).slice(0, 200),
        );
      } else if (sessionId && stub) {
        const pr = (await arpc
          .request(
            "session/prompt",
            {
              sessionId,
              prompt: [
                {
                  type: "text",
                  text: "Use the lilos terminal_run tool to echo a marker.",
                },
              ],
            },
            120_000,
          )
          .catch((e) => ({ error: String(e) }))) as Record<string, unknown>;
        check(!("error" in pr), "session/prompt completes (stub provider)");
        const toolsOffered = [...new Set(stub.seen.flatMap((s) => s.tools))];
        const reached =
          toolsOffered.some((n) => /mcp__lilos__|terminal_run/i.test(n)) ||
          toolsOffered.some((n) => /^tool_search$/i.test(n));
        check(
          reached,
          "hermes gave the model a path to the lilos MCP tools",
          toolsOffered.join(","),
        );
        const tail = await mcpA.request("tools/call", {
          name: "terminal_read",
          arguments: { tailBytes: 8192 },
        });
        check(
          JSON.stringify(tail.body ?? {}).includes(`${MARKER}-FROM-MODEL`),
          "model-driven tool call landed on the session PTY",
        );
      }
    } catch (e) {
      check(
        false,
        "hermes acp leg",
        e instanceof Error ? e.message : String(e),
      );
    }
    try {
      acp.kill();
    } catch {}
    stub?.stop();
  } finally {
    await surfaces.close().catch(() => {});
  }

  const fails = results.filter(([ok]) => !ok);
  console.log(
    `\nlive-337: ${results.length - fails.length}/${results.length} passed` +
      (fails.length
        ? ` — FAILURES: ${fails.map((f) => f[1]).join(" | ")}`
        : "") +
      (!REAL_PROVIDER
        ? "\nLIVE_ENGINE_UNAVAILABLE: stub provider; set HERMES_PROVIDER+HERMES_MODEL for a real model run"
        : ""),
  );
  process.exit(fails.length ? 1 : 0);
}

await main();
