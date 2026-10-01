#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Issue #340 live check — the DM tools for real:
 *
 *   - A REAL relay subprocess (scratch LILOS_RELAY_HOME) seeded with two
 *     employees, a DM, and two threads with real messages — the same store
 *     the app reads.
 *   - `serveSurfaces` with the harness's relay-backed `appOps` factory — the
 *     same wiring `apps/harness/src/index.ts` ships (kept in sync by hand;
 *     this script is the live check, not the shared source).
 *   - The bundled `lilos` plugin installed+enabled on a Hermes profile, then
 *     `hermes acp` with the gateway env: the model answers Oscar's four AC-2
 *     DM questions by calling `lilos_context` / `lilos_team_list` /
 *     `lilos_thread_list` / `lilos_thread_read`, retitles + posts into the
 *     thread, and opens the Workbench on a diff (`workbench_opened` lands on
 *     the app's relay socket).
 *
 * Modes:
 *   stub (default): a scratch HERMES_HOME registers `lilos-stub`, a
 *     deterministic OpenAI-compatible provider in this script — it calls
 *     each lilos_* tool on the matching question and echoes the tool result
 *     back, so every leg is deterministic without a real LLM.
 *   real: HERMES_PROVIDER + HERMES_MODEL set -> the real ~/.hermes is used;
 *     the dedicated profile `l340live` is created (Oscar's own profiles
 *     untouched), the plugin installed+enabled, and a real model asked the
 *     same questions. (HERMES_PROFILE overrides the profile name.)
 *
 * Prints PASS/FAIL per check plus a summary line. Exit 0 = all pass.
 */
import { serveSurfaces } from "../../apps/harness/src/surfaces/server.ts";
import { RelayClient } from "../../packages/client-runtime/src/client.ts";

const MARKER = `LIVE340-${Math.random().toString(36).slice(2, 8)}`;
const REAL_PROVIDER = (process.env.HERMES_PROVIDER || "").trim();
const REAL_MODEL = (process.env.HERMES_MODEL || "").trim();
const PROFILE = (process.env.HERMES_PROFILE || "l340live").trim();
const PLUGIN_SRC = join(process.cwd(), "packages/engine-hermes/plugin/lilos");
const HERMES_BIN = process.env.HERMES_BIN ?? "hermes";
const HOME = process.env.HOME ?? "/tmp";
const RELAY_DIR = join(process.cwd(), "apps/relay");

const results: [boolean, string, string][] = [];
const check = (ok: boolean, name: string, detail = "") => {
  results.push([ok, name, detail]);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
};

// ── preflight: the ACP extra must be installed on this Hermes ───────────────
{
  const acp = spawnSync(HERMES_BIN, ["acp", "--check"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (acp.status !== 0) {
    console.log(
      `FAIL  hermes acp --check — the ACP extra is not installed on this host.\n` +
        `      Install it once: ${HERMES_BIN} pm install --extra acp\n` +
        `      (${`${acp.stdout}${acp.stderr}`.trim().split("\n").pop()})`,
    );
    process.exit(1);
  }
  check(true, "preflight: hermes acp --check");
}

// ── tiny stdio JSON-RPC client (ACP) — same shape as live-339 ───────────────

class StdioRpc {
  private buf = "";
  private waiters = new Map<number, (v: unknown) => void>();
  private nextId = 0;
  updates: Record<string, unknown>[] = [];
  constructor(private proc: ReturnType<typeof spawn>) {
    this.proc.stdout?.on("data", (d) => {
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
          this.waiters.get(msg.id)?.(msg);
          this.waiters.delete(msg.id);
        } else if (msg.method === "session/update") {
          const p = msg.params as { update?: Record<string, unknown> };
          this.updates.push((p.update ?? p) as Record<string, unknown>);
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
    this.proc.stdin?.write(
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

/* The assistant text a `session/prompt` streamed since `from` (agent_message_
   chunk updates). */
function replyText(rpc: StdioRpc, from: number): string {
  return rpc.updates
    .slice(from)
    .filter(
      (u) =>
        (u.sessionUpdate === "agent_message_chunk" ||
          u.sessionUpdate === "agent_thought_chunk") &&
        (u.content as { type?: string })?.type === "text",
    )
    .map((u) => String((u.content as { text?: string })?.text ?? ""))
    .join("");
}
/* Which lilos_* tools the model really invoked (tool_call update titles). */
function toolsCalled(rpc: StdioRpc, from: number): string[] {
  return rpc.updates
    .slice(from)
    .filter((u) => u.sessionUpdate === "tool_call")
    .map((u) => String(u.title ?? ""));
}

// ── deterministic OpenAI-compatible stub provider ───────────────────────────
// One tool call per prompt: the last user text decides the lilos_* tool; once
// a tool result arrives the stub answers `ANSWER:<result snippet>` so the
// script can check the model saw the real relay data (like a typed answer).

/* Property names the model is told `lilos_workbench_open` takes — read from
   a tool_describe result (`{"tools": {"lilos_workbench_open": {parameters}}}`).
   Returns [] when the tool was described but its schema has no properties
   (the union-schema bug), null when it wasn't described at all. */
function wbPropsFromDescribe(txt: string): string[] | null {
  try {
    const parsed = JSON.parse(txt) as {
      tools?: Record<
        string,
        { parameters?: { properties?: Record<string, unknown> } }
      >;
    };
    const entry = parsed.tools?.lilos_workbench_open;
    if (!entry) return null;
    return Object.keys(entry.parameters?.properties ?? {});
  } catch {
    return null;
  }
}

/* Text bodies an ACP update can carry a tool result in: `rawOutput` arrives
   as a JSON string or an already-decoded object, and tool_call updates may
   also wrap output in `content` blocks. */
function updateTexts(u: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) texts.push(v);
    else if (v !== null && typeof v === "object") texts.push(JSON.stringify(v));
  };
  push(u.rawOutput);
  for (const c of Array.isArray(u.content) ? u.content : []) {
    const block = c as { text?: unknown; content?: { text?: unknown } };
    push(block.text);
    push(block.content?.text);
  }
  return texts;
}

/* The ACP stream renders a tool_describe result as markdown, not raw JSON
   (`tool_describe result\n- **tools:**\n  - **lilos_workbench_open:**\n
   - **parameters:**\n      - **properties:** {json}`): pull the properties
   map back out of that text. [] = the tool's section was there but its
   properties object was empty (the regression); null = not observed. */
function wbPropsFromDescribeMd(txt: string): string[] | null {
  const toolIdx = txt.indexOf("**lilos_workbench_open:**");
  if (toolIdx < 0) return null;
  const nextTool = txt.indexOf("\n  - **", toolIdx + 1);
  const section = txt.slice(toolIdx, nextTool < 0 ? undefined : nextTool);
  const propIdx = section.indexOf("**properties:**");
  if (propIdx < 0) return null;
  const start = section.indexOf("{", propIdx);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < section.length; i += 1) {
    if (section[i] === "{") depth += 1;
    else if (section[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return Object.keys(JSON.parse(section.slice(start, i + 1)));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/* Real-mode read of what the model actually received (#375): the
   tool_describe result streams back on `tool_call`/`tool_call_update`
   updates of the real `hermes acp` session — raw JSON in some builds,
   the markdown render above in others. null = never observed in-band. */
function wbPropsFromAcp(updates: Record<string, unknown>[]): string[] | null {
  for (const u of updates) {
    if (
      u.sessionUpdate !== "tool_call" &&
      u.sessionUpdate !== "tool_call_update"
    )
      continue;
    for (const t of updateTexts(u)) {
      const props = wbPropsFromDescribe(t) ?? wbPropsFromDescribeMd(t);
      if (props !== null) return props;
    }
  }
  return null;
}

/* The advertised schema at the gateway boundary: `GET /tools` returns the
   session catalog the lilos plugin registers verbatim
   (`parameters: tool.get("inputSchema")`), i.e. the same inputSchema the
   model's tool defs carry. null = not observable. */
async function wbPropsFromCatalog(
  baseUrl: string,
  engineToken: string,
  session: string,
): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/tools`, {
      headers: {
        authorization: `Bearer ${engineToken}`,
        "x-lilos-session": session,
      },
    });
    if (!res.ok) return null;
    const catalog = (await res.json()) as {
      tools?: {
        name?: string;
        inputSchema?: { properties?: Record<string, unknown> };
      }[];
    };
    const wb = (catalog.tools ?? []).find((t) => t.name === "workbench_open");
    if (!wb) return null;
    return Object.keys(wb.inputSchema?.properties ?? {});
  } catch {
    return null;
  }
}

const QUESTIONS: [RegExp, string, Record<string, unknown>][] = [
  [/who are you|where are you/i, "context", {}],
  [/who.?s on the team|the team/i, "team_list", {}],
  [/which threads/i, "thread_list", {}],
  [/settle/i, "thread_read", { thread: "Triage notes" }],
  [/guide|what can employees do/i, "guide", { topic: "dm-and-threads" }],
  [/search|find (the |any )?messages/i, "thread_search", { query: "gateway" }],
  [/prs|pull requests/i, "thread_prs", {}],
  [/retitle/i, "thread_set_title", { title: `Answered ${MARKER}` }],
  [/post (a |the )?note/i, "thread_post", { text: `note ${MARKER}` }],
  [/diff/i, "workbench_open", { diff: true }],
];

function startStub() {
  const seen: { tools: string[]; lastText: string }[] = [];
  /* The schema hermes actually advertised to the model for
     lilos_workbench_open (read from the request's `tools`, never
     hard-coded). A union params schema serializes to a bare anyOf — no
     `properties` — and the live leg showed a model CANNOT guess args from
     that: the stub derives its call args from this schema so a schema
     regression can no longer hide behind a hard-coded `{diff:true}`. */
  const advertised: { wbProps: string[] | null } = { wbProps: null };
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: [
            {
              id: "stub-model-a",
              object: "model",
              created: 0,
              owned_by: "lilos-stub",
            },
          ],
        });
      }
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body = (await req.json()) as {
          stream?: boolean;
          tools?: { function?: { name?: string } }[];
          messages?: { role: string; content?: unknown }[];
        };
        const tools = (body.tools ?? [])
          .map((t) => t.function?.name ?? "")
          .filter(Boolean);
        const msgs = body.messages ?? [];
        /* Hermes sends the whole conversation each call — only the tool
           messages AFTER the last user prompt belong to this question. */
        const lastUserIdx = (() => {
          for (let i = msgs.length - 1; i >= 0; i -= 1) {
            if (msgs[i]?.role === "user") return i;
          }
          return -1;
        })();
        const lastUser = lastUserIdx >= 0 ? msgs[lastUserIdx] : undefined;
        const lastText =
          typeof lastUser?.content === "string"
            ? lastUser.content
            : JSON.stringify(lastUser?.content ?? "");
        seen.push({ tools, lastText: lastText.slice(0, 300) });
        const toolMsgs = msgs
          .slice(lastUserIdx + 1)
          .filter((m) => m.role === "tool");
        const toolText = (m: { content?: unknown }) =>
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content ?? "");

        // The matching lilos tool for this prompt (native name or via
        // hermes' tool_search/tool_call indirection — same as live-339).
        // `call_dm_*` ids mark OUR lilos calls so the loop can tell "the real
        // tool already ran" apart from "only searched so far".
        const intent = QUESTIONS.find(([re]) => re.test(lastText));
        const wanted = intent
          ? tools.find((n) => new RegExp(`lilos_${intent[1]}$`).test(n))
          : undefined;
        const callIdOf = (m: { tool_call_id?: unknown }) =>
          typeof m.tool_call_id === "string" ? m.tool_call_id : "";
        const ranLilos = toolMsgs.some((m) =>
          /^call_dm_[12]/.test(callIdOf(m as { tool_call_id?: string })),
        );
        const searched = toolMsgs.some((m) =>
          intent
            ? /^call_dm_3/.test(callIdOf(m as { tool_call_id?: string }))
            : false,
        );
        const described = toolMsgs.some((m) =>
          /^call_dm_4/.test(callIdOf(m as { tool_call_id?: string })),
        );
        const searchTool = tools.find((n) => /^tool_search$/i.test(n));
        const describeTool = tools.find((n) => /^tool_describe$/i.test(n));
        const callTool = tools.find((n) => /^tool_call$/i.test(n));

        /* workbench_open: read the schema the MODEL actually sees — a real
           model calls tool_describe before tool_call, so the stub does the
           same, then builds `{diff:true}` only if the schema lists `diff`.
           A bare anyOf/{} (the union-schema bug) → no args → the call fails
           AND the advertised-props check at the end fails the run. */
        let intentArgs = intent?.[2];
        if (intent?.[1] === "workbench_open") {
          if (described && advertised.wbProps === null) {
            const txt = toolMsgs
              .filter((m) => /^call_dm_4/.test(callIdOf(m)))
              .map(toolText)
              .join("\n");
            advertised.wbProps = wbPropsFromDescribe(txt);
            if (!(advertised.wbProps ?? []).includes("diff"))
              console.log(
                `[stub] lilos_workbench_open schema via tool_describe: ${txt.slice(0, 600)}`,
              );
          }
          /* A directly-advertised def (some hermes configs skip the
             search/describe indirection) is the same contract surface. */
          if (advertised.wbProps === null) {
            const def = (body.tools ?? []).find((t) =>
              /lilos_workbench_open$/.test(t.function?.name ?? ""),
            );
            if (def?.function)
              advertised.wbProps = Object.keys(
                (
                  def.function as {
                    parameters?: { properties?: Record<string, unknown> };
                  }
                ).parameters?.properties ?? {},
              );
          }
          intentArgs = (advertised.wbProps ?? []).includes("diff")
            ? { diff: true }
            : undefined;
        }

        const wantCall =
          ranLilos || !intent
            ? null
            : wanted
              ? {
                  id: "call_dm_1",
                  name: wanted,
                  arguments: intentArgs ?? {},
                }
              : intent[1] === "workbench_open" &&
                  searched &&
                  !described &&
                  describeTool
                ? {
                    id: "call_dm_4",
                    name: describeTool,
                    arguments: { names: ["lilos_workbench_open"] },
                  }
                : searched && callTool
                  ? {
                      id: "call_dm_2",
                      name: callTool,
                      arguments: {
                        calls: [
                          {
                            name: `lilos_${intent[1]}`,
                            arguments: intentArgs ?? {},
                          },
                        ],
                      },
                    }
                  : searchTool && toolMsgs.length < 8
                    ? {
                        id: "call_dm_3",
                        name: searchTool,
                        arguments: { queries: [intent[1]] },
                      }
                    : null;

        /* Answer only from REAL lilos results (call_dm_1/2), not the
           tool_search listing that came first — the reply is what the
           script greps for seeded data. */
        const resultMsgs = toolMsgs.filter((m) =>
          /^call_dm_[12]/.test(callIdOf(m as { tool_call_id?: string })),
        );
        const reply = resultMsgs.length
          ? `ANSWER:${resultMsgs.map(toolText).join(" | ").slice(0, 900)}`
          : `stub:${MARKER}`;
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
          const payload = `${chunks
            .map(
              (c) =>
                `data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", created: 0, model: "stub-model-a", choices: [{ index: 0, ...c }] })}\n\n`,
            )
            .join("")}data: [DONE]\n\n`;
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
            { delta: { role: "assistant", content: reply } },
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
              message: { role: "assistant", content: reply },
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
    advertised,
    stop: () => srv.stop(true),
  };
}

// ── real relay subprocess (the app's store — scratch home) ──────────────────

async function startRelay() {
  const home = mkdtempSync(join(tmpdir(), "lilos340-relay-"));
  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: RELAY_DIR,
    env: {
      ...(process.env as Record<string, string>),
      LILOS_RELAY_HOME: home,
      LILOS_RELAY_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const address = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("relay did not start")),
      20_000,
    );
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(
        /listening on http:\/\/([0-9a-fA-F.:]+):(\d+)/,
      );
      if (match) {
        clearTimeout(timer);
        resolve(`${match[1]}:${match[2]}`);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited ${code}: ${buffer.slice(-400)}`));
    });
  });
  const [host, port] = address.split(":");
  const token = readFileSync(join(home, "relay-token"), "utf8").trim();
  return {
    child,
    url: `ws://${host}:${port}/ws`,
    httpUrl: `http://${host}:${port}`,
    token,
  };
}

// ── hermes CLI helper ────────────────────────────────────────────────────────

const hermes = (args: string[], env: Record<string, string>) =>
  spawnSync(HERMES_BIN, args, {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...(process.env as Record<string, string>), ...env },
  });

async function main() {
  const mode = REAL_PROVIDER
    ? `real provider ${REAL_PROVIDER}/${REAL_MODEL || "(default)"}`
    : "STUB provider lilos-stub (deterministic; no real LLM completing turns)";
  console.log(`# issue #340 live check — mode: ${mode}`);

  const relay = await startRelay();
  check(true, "real relay up", relay.url);

  /* The app's client — sees `workbench.opened` exactly like Oscar's
     desktop/phone does. */
  const appEvents: { method: string; params: Record<string, unknown> }[] = [];
  const app = new RelayClient({
    url: relay.url,
    token: relay.token,
    client: { name: "live-340-app" },
    onEvent: (method, params) => appEvents.push({ method, params }),
  });
  await app.connect();

  /* The harness-side client whose requests mint the DM the session binds to
     (employees.open / channels.openDm / conversations.open). */
  const host = new RelayClient({
    url: relay.url,
    token: relay.token,
    client: { name: "live-340-host" },
  });
  await host.connect();
  /* Only the registered engine host may post employee messages, set auto
     titles or open workbenches — this client stands in for the harness. */
  await host.request("harness.register", {
    protocolVersion: 1,
    version: "live-340",
  });

  // Seed the company: two employees, Ada's DM, two threads with messages.
  const ada = (
    await host.request<{ employee: { id: string; name: string } }>(
      "employees.create",
      {
        name: "Ada",
        role: "engineer",
        status: "online",
        profile: "default",
        model: "qwen-live",
      },
    )
  ).employee;
  await host.request("employees.create", {
    name: "Grace",
    role: "reviewer",
    status: "offline",
  });
  const dm = (
    await host.request<{ channel: { id: string } }>("channels.openDm", {
      employeeId: ada.id,
    })
  ).channel;
  const conv = (
    await host.request<{ conversation: { id: string } }>("conversations.open", {
      channelId: dm.id,
      text: "plan the launch",
      title: "launch plan",
    })
  ).conversation;
  const other = (
    await host.request<{ conversation: { id: string } }>("conversations.open", {
      channelId: dm.id,
      text: "pick next tickets",
      title: "Triage notes",
    })
  ).conversation;
  await host.request("messages.post", {
    channelId: dm.id,
    conversationId: conv.id,
    authorKind: "employee",
    authorId: ada.id,
    text: "drafting the plan",
  });
  await host.request("messages.post", {
    channelId: dm.id,
    conversationId: other.id,
    text: "we settled: gateway first, approvals next",
  });
  /* The app-side client only sees channel events after subscribing — like
     the real app does when it opens the DM. */
  await app.request("channel.subscribe", { channelId: dm.id });
  check(true, "company seeded (2 employees, DM, 2 threads)");

  /* The surfaces server with the same relay-backed appOps the harness
     installs (mirrors apps/harness/src/index.ts). */
  const surfaces = await serveSurfaces(0, {
    appOps: (_session, binding) => {
      if (!binding) return undefined;
      return {
        postMessage: async (text) => {
          const { message } = await host.request<{ message: unknown }>(
            "messages.post",
            {
              channelId: binding.channelId,
              conversationId: binding.conversationId,
              authorKind: "employee",
              authorId: binding.employeeId,
              text,
            },
          );
          return message;
        },
        readConversation: async (opts) => {
          const page = await host.request<{ messages: unknown[] }>(
            "messages.list",
            {
              channelId: binding.channelId,
              conversationId: opts?.conversationId ?? binding.conversationId,
              ...(opts?.afterSeq !== undefined
                ? { afterSeq: opts.afterSeq }
                : {}),
            },
          );
          return page.messages;
        },
        listThreads: async () => {
          const r = await host.request<{ conversations: unknown[] }>(
            "conversations.list",
            { channelId: binding.channelId, includeArchived: true },
          );
          return r.conversations;
        },
        threadSummaries: async () => {
          const r = await host.request<{ summaries: unknown[] }>(
            "conversations.summaries",
            { channelId: binding.channelId, includeArchived: true },
          );
          return r.summaries;
        },
        employees: async () => {
          const r = await host.request<{ employees: unknown[] }>(
            "employees.list",
            {},
          );
          return r.employees;
        },
        threadPrs: async (conversationId) => {
          const r = await host.request<{ prs: unknown[] }>(
            "conversations.prs",
            { conversationId },
          );
          return r.prs;
        },
        searchMessages: async (query, limit) => {
          const r = await host.request<{ hits: unknown[] }>("messages.search", {
            query,
            channelId: binding.channelId,
            includeArchived: true,
            ...(limit !== undefined ? { limit } : {}),
          });
          return r.hits;
        },
        setThreadTitle: async (title) => {
          const r = await host.request<{
            conversation: { title: string; titleSource: string };
          }>("conversations.update", {
            conversationId: binding.conversationId,
            title,
          });
          return r.conversation.titleSource === "user"
            ? { outcome: "user_title" as const, title: r.conversation.title }
            : { outcome: "set" as const, title: r.conversation.title };
        },
        status: () => host.request("system.status", { logLines: 0 }),
        profile: async () => {
          const r = await host.request<{ profile: unknown }>("profile.get", {});
          return r.profile;
        },
        openWorkbench: async (target) => {
          await host.request("workbench.open", {
            conversationId: binding.conversationId,
            target,
          });
        },
      };
    },
  });
  const a = surfaces.create({
    cwd: HOME,
    binding: {
      employeeId: ada.id,
      channelId: dm.id,
      conversationId: conv.id,
    },
  });
  check(
    a.mcpServerHttp?.type === "http" && a.mcpServerHttp.url.endsWith("/mcp"),
    "gateway session create returns the HTTP MCP spec",
    a.binding?.conversationId ?? "",
  );

  let stub: ReturnType<typeof startStub> | null = null;
  const acps: ReturnType<typeof spawn>[] = [];
  try {
    // HERMES_HOME: scratch+stub provider, or the real one — real mode keeps
    // the real home (profiles are HOME-anchored; a scratch home breaks
    // profile setup — see live-339's note).
    let hermesHome = process.env.HERMES_HOME;
    if (!REAL_PROVIDER) {
      stub = startStub();
      hermesHome = mkdtempSync(join(tmpdir(), "lilos340-hermes-"));
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
    const hEnv: Record<string, string> = hermesHome
      ? { HERMES_HOME: hermesHome }
      : {};

    // Profile + bundled lilos plugin — the Connect mechanism (AC-1).
    const listed = hermes(["profile", "list"], hEnv);
    if (!`${listed.stdout}${listed.stderr}`.includes(PROFILE)) {
      const created = hermes(["profile", "create", PROFILE], hEnv);
      check(
        created.status === 0,
        `hermes profile create ${PROFILE}`,
        `${created.stdout}${created.stderr}`.slice(-120).trim(),
      );
    }
    const pluginsDir = join(hermesHome ?? "", "profiles", PROFILE, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    cpSync(PLUGIN_SRC, join(pluginsDir, "lilos"), { recursive: true });
    const enabled = hermes(["-p", PROFILE, "plugins", "enable", "lilos"], hEnv);
    check(
      enabled.status === 0,
      `plugins enable lilos on ${PROFILE}`,
      `${enabled.stdout}${enabled.stderr}`.slice(-160).trim(),
    );

    const lilosEnv = {
      LILOS_SURFACES_URL: surfaces.url,
      LILOS_ENGINE_TOKEN: surfaces.engineToken,
      HERMES_SESSION_SOURCE: "lilos",
      ...hEnv,
    };
    const spawnAcp = (env: Record<string, string>) => {
      const p = spawn(HERMES_BIN, ["-p", PROFILE, "acp"], {
        env: { ...(process.env as Record<string, string>), ...env },
        cwd: HOME,
        stdio: ["pipe", "pipe", "inherit"],
      });
      acps.push(p);
      return new StdioRpc(p);
    };

    const rpc = spawnAcp(lilosEnv);
    await rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "lilos-live-340", version: "0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
      180_000,
    );
    const snew = await rpc.request(
      "session/new",
      { cwd: HOME, mcpServers: [] },
      90_000,
    );
    const sessionId = (snew.result as { sessionId?: string })?.sessionId;
    check(!!sessionId, "hermes acp session/new (lilos session)");
    if (!sessionId) throw new Error("no session");
    surfaces.bindEngineSession(a.session, sessionId);

    /** One question → the model calls the tool → ANSWER carries real data. */
    const ask = async (
      label: string,
      text: string,
      expectTool: string,
      expects: RegExp[],
    ) => {
      const from = rpc.updates.length;
      const pr = (await rpc
        .request(
          "session/prompt",
          { sessionId, prompt: [{ type: "text", text }] },
          180_000,
        )
        .catch((e) => ({ error: String(e) }))) as Record<string, unknown>;
      if ("error" in pr) {
        check(false, `${label}: session/prompt`, String(pr.error));
        return "";
      }
      const reply = replyText(rpc, from);
      const called = toolsCalled(rpc, from).join(",");
      if (REAL_PROVIDER) {
        // A real model picks its own wording — proof is the tool call
        // itself landing, not an exact answer string.
        check(
          called.includes(`lilos_${expectTool}`) ||
            (stub?.seen ?? []).length > 0,
          `${label}: model called lilos_${expectTool}`,
          called || "(no tool_call update)",
        );
      } else {
        check(
          called.includes(`lilos_${expectTool}`) ||
            stub?.seen.some((s) =>
              s.tools.some((t) => t.includes(`lilos_${expectTool}`)),
            ),
          `${label}: model drove lilos_${expectTool}`,
          called || "(offered only)",
        );
        for (const re of expects) {
          check(
            re.test(reply),
            `${label}: answer carries ${re}`,
            reply.slice(0, 160),
          );
        }
      }
      return reply;
    };

    // ── The four AC-2 questions over real relay data ─────────────────────
    await ask(
      "Q1 who/where",
      `In this DM Oscar asks: "who are you and where are you?" — call your LilOS tools and answer.`,
      "context",
      [/Ada/i, /launch plan/i],
    );
    await ask(
      "Q2 team",
      `Oscar asks: "who's on the team?" — answer from LilOS.`,
      "team_list",
      [/Ada/i, /Grace/i],
    );
    await ask(
      "Q3 threads",
      `Oscar asks: "which threads do we have?" — list them from LilOS.`,
      "thread_list",
      [/launch plan/i, /Triage notes/i],
    );
    await ask(
      "Q4 settled",
      `Oscar asks: "what did we settle in the Triage notes thread?" — read it and tell him.`,
      "thread_read",
      [/gateway first/i],
    );

    // ── The remaining read tools — one real agent call each (step 4) ─────
    await ask(
      "guide",
      `Oscar asks: "what can employees do in a DM?" — read the guide page that answers it.`,
      "guide",
      [/thread|dm/i],
    );
    await ask(
      "search",
      `Oscar asks: "search our messages for 'gateway'" — find them.`,
      "thread_search",
      [/gateway/i],
    );
    await ask(
      "prs",
      `Oscar asks: "which PRs are attached to this thread?" — list them.`,
      "thread_prs",
      [/prs|pull|request|\[/i],
    );

    // ── Writes: retitle (auto) + post into the bound thread ──────────────
    await ask(
      "retitle",
      `Retitle this thread to "Answered ${MARKER}".`,
      "thread_set_title",
      [/"set"|set/i],
    );
    const convs = await host.request<{
      conversations: { id: string; title: string }[];
    }>("conversations.list", { channelId: dm.id });
    check(
      convs.conversations.some(
        (c) => c.id === conv.id && c.title === `Answered ${MARKER}`,
      ),
      "thread retitle landed in the relay store",
      convs.conversations.map((c) => c.title).join(", "),
    );
    await ask(
      "post",
      `Post a note saying "note ${MARKER}" into this thread.`,
      "thread_post",
      [new RegExp(MARKER)],
    );
    const page = await host.request<{ messages: { text: string }[] }>(
      "messages.list",
      { channelId: dm.id, conversationId: conv.id },
    );
    check(
      page.messages.some((m) => m.text === `note ${MARKER}`),
      "thread_post landed in the relay store",
    );

    // ── workbench_open → the app's relay socket (AC-2b mechanism) ────────
    const wbBefore = appEvents.length;
    await ask(
      "workbench_open",
      `Show me the diff of what you changed — open my Workbench on it.`,
      "workbench_open",
      [/opened/i],
    );
    await new Promise((r) => setTimeout(r, 1500));
    const opened = appEvents
      .slice(wbBefore)
      .find((e) => e.method === "workbench.opened");
    check(
      !!opened &&
        JSON.stringify(opened?.params?.target ?? {}).includes("diff") &&
        opened?.params?.conversationId === conv.id,
      "workbench.opened reached the app's relay socket",
      JSON.stringify(opened?.params ?? "none").slice(0, 160),
    );
    /* Schema regression guard (#340 live leg, fixed #375): the model can
       only call workbench_open with sane args if its advertised inputSchema
       lists the target fields — a bare anyOf/{} advertises nothing.
       Stub mode: the stub captured the schema it was sent.
       Real mode: read what the model actually received — the tool_describe
       result on the ACP session's tool_call updates, else the gateway
       catalog the lilos plugin registered verbatim (GET /tools). Only when
       neither surface exposes the schema is the leg skipped with a printed
       reason; packages/contracts/test/harness.test.ts's object-schema test
       stays the always-on guard. */
    const schemaGuard =
      "workbench_open's advertised schema lists its target fields";
    if (REAL_PROVIDER) {
      const acpProps = wbPropsFromAcp(rpc.updates);
      const props =
        acpProps ??
        (await wbPropsFromCatalog(
          surfaces.url,
          surfaces.engineToken,
          a.session,
        ));
      if (props === null) {
        console.log(
          `SKIP  ${schemaGuard} — skipped: no tool_describe result in the ` +
            "ACP session and GET /tools unreachable; the contracts " +
            "object-schema test stays the guard",
        );
      } else {
        check(
          props.includes("diff"),
          schemaGuard,
          `${JSON.stringify(props).slice(0, 120)} (via ${
            acpProps !== null ? "tool_describe update" : "GET /tools"
          })`,
        );
      }
    } else {
      check(
        stub?.advertised.wbProps?.includes("diff") === true,
        schemaGuard,
        JSON.stringify(stub?.advertised.wbProps ?? "not advertised").slice(
          0,
          160,
        ),
      );
    }
  } catch (e) {
    check(false, "acp leg", String(e));
  } finally {
    for (const p of acps) {
      try {
        p.kill();
      } catch {}
    }
    stub?.stop();
    await surfaces.close().catch(() => {});
    relay.child.kill("SIGKILL");
    host.close();
    app.close();
  }

  const fails = results.filter(([ok]) => !ok);
  console.log(
    `\nlive-340: ${results.length - fails.length}/${results.length} passed` +
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
