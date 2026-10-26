#!/usr/bin/env bun
/**
 * D-#764 — the deterministic fake ACP agent: a real `session/new` /
 * `session/prompt` / `session/request_permission` / `session/update`
 * speaker over stdio ndjson, driving the engine-conformance suite without
 * an LLM (CI-safe). Behavior is scripted off the prompt text, the same
 * contract `engine-fake` keeps:
 *
 * - "read or search tool" / generic text → one non-mutating tool call +
 *   LILOS_OK
 * - "edit README.md" / "chmod 777" → permission ask first (Hermes-shaped
 *   option ids: allow_once / allow_session / allow_always / reject_once /
 *   reject_always — the #133 optionId trap), then the mutating tool call
 * - "always" grants persist agent-side per command — a second session on
 *   the same command never re-asks (the conformance mcp_servers leg)
 * - LILOS_SLOW → a paced word stream cancel-able mid-turn
 * - "plan: tasks" → paced plan snapshots (interrupt leaves items pending)
 * - "remember the codeword X" / "recall:" → session transcript memory —
 *   it survives `session/load` (the fake advertises loadSession)
 * - "env NAME" → tool call reporting the spawned child's own env value
 *   (the D-#845 spawn-scrub probe)
 * - first turn sends `session_info_update` (the llm auto-title) and each
 *   turn reports `usage_update` + PromptResponse.usage
 *
 * Everything the agent advertises is honest surface: image+embeddedContext
 * prompt capabilities, http+sse MCP, list/resume/close session lifecycle,
 * and a model/thought_level/speed config catalog with ask/code modes.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk";

const MODELS = [
  { value: "fake-fast", name: "Fake Fast" },
  { value: "fake-smart", name: "Fake Smart" },
  { value: "fake-deep", name: "Fake Deep" },
];
const EFFORTS = ["low", "medium", "high"];
const SPEEDS = ["standard", "fast"];
const MODES = [
  { id: "ask", name: "Ask" },
  { id: "code", name: "Code" },
];

interface FakeSession {
  id: string;
  cwd: string;
  transcript: string[];
  codewords: string[];
  config: Map<string, string>;
  mode: string;
  closed: boolean;
  cancelled: boolean;
  titled: boolean;
  /** Last `_meta` seen on session/new|load — the `meta` prompt echoes it
     (D-#866: sessionMeta actually reaching the agent is the assertion). */
  meta?: unknown;
}

/* Test knobs (env, comma lists): LILOS_FAKE_CONFIG narrows which config
   options session/new advertises (e.g. "thought_level" → no model option);
   LILOS_FAKE_RESET_ON_LOAD=1 clears a session's config at session/load —
   an agent that returns to defaults must see the stored pick re-applied
   (#846). */
const ADVERTISED = new Set(
  (process.env.LILOS_FAKE_CONFIG ?? "model,thought_level,speed")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const RESET_ON_LOAD = process.env.LILOS_FAKE_RESET_ON_LOAD === "1";

/* D-#866 wedge simulation: `LILOS_FAKE_HANG_CWD=<substr>` makes session/new
   never resolve for sessions whose cwd contains it (the probe's cwd can be
   excluded by choosing a substring only real sessions carry).
   `LILOS_FAKE_HANG_ONCE=<file>` limits the wedge to the first matching
   call — the file is created when the hang starts, so a respawned adapter
   (the engine's teardown-and-reopen path) serves normally after.
   `LILOS_FAKE_GRANDCHILD_PIDFILE=<file>` additionally spawns a `sleep`
   grandchild in the same process group and records its pid — the wedged-
   teardown tests assert the whole tree dies, not just the adapter. */
const HANG_CWD = process.env.LILOS_FAKE_HANG_CWD;
const HANG_ONCE = process.env.LILOS_FAKE_HANG_ONCE;
const GRANDCHILD_PIDFILE = process.env.LILOS_FAKE_GRANDCHILD_PIDFILE;
/* LILOS_FAKE_SLOW_CONFIG_MS=<ms> — set_config_option sleeps first (the
   r7 start-budget test). */
const SLOW_CONFIG_MS = Number(process.env.LILOS_FAKE_SLOW_CONFIG_MS ?? 0);
/* `LILOS_FAKE_META_LOG=<file>` appends one JSON line per session/new|load
   `_meta` — the catalog probe's meta is observable even though the probe
   session is closed before it can be prompted. */
const META_LOG = process.env.LILOS_FAKE_META_LOG;
/* `LILOS_FAKE_EXIT_ON_LOAD_MS=<ms>` — the adapter answers session/load
   then exits that long after: the r8-nit shape, an adapter dying
   mid-resume while the engine still writes the session's pick. */
const EXIT_ON_LOAD_MS = Number(process.env.LILOS_FAKE_EXIT_ON_LOAD_MS ?? 0);

const sessions = new Map<string, FakeSession>();
/** allow_always grants — the profile allowlist lives agent-side and
    survives sessions, so the second leg never re-asks (#133 AC). */
const grants = new Set<string>();
let nextSession = 0;
let nextToolCall = 0;

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const words = (n: number) =>
  Array.from({ length: n }, (_, i) => `w${i % 97}`).join(" ");

function configOptions(s: FakeSession): acp.SessionConfigOption[] {
  const all: acp.SessionConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: s.config.get("model") ?? "fake-fast",
      options: MODELS.map((m) => ({
        value: m.value,
        name: m.name,
        description: `${m.name} (deterministic)`,
      })),
    } as acp.SessionConfigOption,
    {
      id: "thought_level",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: s.config.get("thought_level") ?? "medium",
      options: EFFORTS.map((e) => ({ value: e, name: e })),
    } as acp.SessionConfigOption,
    {
      id: "speed",
      name: "Speed",
      category: "model_config",
      type: "select",
      currentValue: s.config.get("speed") ?? "standard",
      options: SPEEDS.map((v) => ({ value: v, name: v })),
    } as acp.SessionConfigOption,
  ];
  return all.filter((o) => ADVERTISED.has(o.id));
}

const textBlock = (text: string): acp.ContentBlock => ({
  type: "text",
  text,
});

async function send(
  conn: acp.AgentSideConnection,
  sessionId: string,
  update: acp.SessionUpdate,
) {
  await conn.sessionUpdate({ sessionId, update });
}

async function sendText(
  conn: acp.AgentSideConnection,
  sessionId: string,
  text: string,
) {
  await send(conn, sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: textBlock(text),
  });
}

async function sendTool(
  conn: acp.AgentSideConnection,
  sessionId: string,
  tool: { title: string; kind: string; input: Record<string, unknown> },
) {
  const toolCallId = `call-${++nextToolCall}`;
  await send(conn, sessionId, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: tool.title,
    kind: tool.kind,
    status: "in_progress",
    rawInput: tool.input,
  } as acp.SessionUpdate);
  await send(conn, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    title: tool.title,
    status: "completed",
    rawOutput: "ok",
  } as acp.SessionUpdate);
}

/** Hermes-shaped options — allow_session carries kind allow_always on
    purpose: the #133 trap the shared permissions map must survive. */
const PERMISSION_OPTIONS: acp.PermissionOption[] = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  {
    optionId: "allow_session",
    name: "Allow this session",
    kind: "allow_always",
  },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  { optionId: "reject_always", name: "Always deny", kind: "reject_always" },
];

async function askPermission(
  conn: acp.AgentSideConnection,
  sessionId: string,
  toolCall: { title: string; kind: string; input: Record<string, unknown> },
): Promise<"allowed" | "denied" | "cancelled"> {
  const res = await conn.requestPermission({
    sessionId,
    toolCall: {
      toolCallId: `perm-${++nextToolCall}`,
      title: toolCall.title,
      kind: toolCall.kind,
      status: "pending",
      rawInput: toolCall.input,
      content: [],
    } as acp.ToolCall,
    options: PERMISSION_OPTIONS,
  });
  const o = res.outcome;
  if (o.outcome === "cancelled") return "cancelled";
  const id = o.optionId;
  if (id === "allow_always") grants.add(toolCall.title);
  if (id.startsWith("allow_")) return "allowed";
  return "denied";
}

const promptText = (prompt: acp.ContentBlock[]) =>
  prompt.map((b) => (b.type === "text" ? b.text : "")).join(" ");

async function runMutating(
  conn: acp.AgentSideConnection,
  s: FakeSession,
  tool: { title: string; kind: string; input: Record<string, unknown> },
): Promise<"done" | "cancelled"> {
  if (!grants.has(tool.title)) {
    const verdict = await askPermission(conn, s.id, tool);
    if (verdict === "cancelled") return "cancelled";
    if (verdict === "denied") {
      await sendText(conn, s.id, "denied");
      return "done";
    }
  }
  await sendTool(conn, s.id, tool);
  await sendText(conn, s.id, "LILOS_OK");
  return "done";
}

async function runSlow(
  conn: acp.AgentSideConnection,
  s: FakeSession,
  wordCount: number,
): Promise<"done" | "cancelled"> {
  /* ~15 paced chunks — interrupt/steer land mid-stream deterministically. */
  const chunks = 15;
  const per = Math.ceil(wordCount / chunks);
  for (let i = 0; i < chunks; i++) {
    if (s.cancelled) return "cancelled";
    await sendText(conn, s.id, `${words(per)} `);
    await tick(40);
  }
  await sendText(conn, s.id, "LILOS_OK");
  return "done";
}

async function runPlan(
  conn: acp.AgentSideConnection,
  s: FakeSession,
): Promise<"done" | "cancelled"> {
  const steps = ["read README.md", "edit README.md", "run a quick check"];
  const snapshot = async (doneTo: number, running: number) => {
    await send(conn, s.id, {
      sessionUpdate: "plan",
      entries: steps.map((content, i) => ({
        content,
        priority: "medium",
        status:
          i < doneTo ? "completed" : i === running ? "in_progress" : "pending",
      })),
    } as acp.SessionUpdate);
  };
  await snapshot(0, 0);
  for (let i = 0; i < steps.length; i++) {
    /* ~120ms per step — interrupt lands mid-list with items still pending. */
    await tick(120);
    if (s.cancelled) return "cancelled";
    await sendTool(conn, s.id, {
      title: steps[i],
      kind: "other",
      input: {},
    });
    await snapshot(i + 1, i + 1);
  }
  await sendText(conn, s.id, "LILOS_OK");
  return "done";
}

const agent = (conn: acp.AgentSideConnection): acp.Agent => ({
  initialize: async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "lilos-fake-acp-agent", version: "0.0.0" },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true, audio: false },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: {
        list: {},
        resume: {},
        close: {},
      },
    },
  }),

  newSession: async (params) => {
    if (
      HANG_CWD &&
      params.cwd.includes(HANG_CWD) &&
      !(HANG_ONCE && existsSync(HANG_ONCE))
    ) {
      if (HANG_ONCE) writeFileSync(HANG_ONCE, "wedged");
      if (GRANDCHILD_PIDFILE) {
        const g = spawn("sleep", ["300"], { stdio: "ignore" });
        writeFileSync(GRANDCHILD_PIDFILE, String(g.pid));
        g.unref();
      }
      /* The wedged agent: a session/new that never settles — what the
         installed app's stalled `claude` child looked like to the engine. */
      await new Promise(() => {});
    }
    const s: FakeSession = {
      id: `acp-fake-${++nextSession}`,
      cwd: params.cwd,
      transcript: [],
      codewords: [],
      config: new Map(),
      mode: MODES[0].id,
      closed: false,
      cancelled: false,
      titled: false,
      meta: params._meta,
    };
    sessions.set(s.id, s);
    if (META_LOG)
      appendFileSync(
        META_LOG,
        `${JSON.stringify({ op: "new", meta: s.meta ?? null })}\n`,
      );
    return {
      sessionId: s.id,
      modes: {
        currentModeId: s.mode,
        availableModes: MODES.map((m) => ({ id: m.id, name: m.name })),
      },
      configOptions: configOptions(s),
    };
  },

  loadSession: async (params) => {
    const s = sessions.get(params.sessionId);
    if (!s)
      throw { code: -32002, message: `no stored session ${params.sessionId}` };
    /* session/load reopens a closed session — transcript and codewords
       survive (what suspend-resume proves). RESET_ON_LOAD simulates an
       agent whose reloaded session drops back to config defaults. */
    s.closed = false;
    if (RESET_ON_LOAD) s.config.clear();
    s.cancelled = false;
    s.meta = params._meta;
    if (META_LOG)
      appendFileSync(
        META_LOG,
        `${JSON.stringify({ op: "load", meta: s.meta ?? null })}\n`,
      );
    if (EXIT_ON_LOAD_MS > 0)
      setTimeout(() => process.exit(0), EXIT_ON_LOAD_MS).unref();
    return {
      modes: {
        currentModeId: s.mode,
        availableModes: MODES.map((m) => ({ id: m.id, name: m.name })),
      },
      configOptions: configOptions(s),
    };
  },

  listSessions: async () => ({
    sessions: [...sessions.values()].map((s) => ({
      sessionId: s.id,
      cwd: s.cwd,
      title: s.codewords[0] ?? "fake session",
    })),
  }),

  resumeSession: async (params) => {
    const s = sessions.get(params.sessionId);
    if (!s)
      throw { code: -32002, message: `no stored session ${params.sessionId}` };
    s.closed = false;
    s.cancelled = false;
    return {};
  },

  closeSession: async (params) => {
    const s = sessions.get(params.sessionId);
    if (s) s.closed = true;
    return {};
  },

  setSessionMode: async (params) => {
    const s = sessions.get(params.sessionId);
    if (!s) throw { code: -32002, message: "no session" };
    if (!MODES.some((m) => m.id === params.modeId))
      throw { code: -32602, message: `unknown mode ${params.modeId}` };
    s.mode = params.modeId;
    return {};
  },

  setSessionConfigOption: async (params) => {
    const s = sessions.get(params.sessionId);
    if (!s) throw { code: -32002, message: "no session" };
    /* LILOS_FAKE_SLOW_CONFIG_MS=<ms> — a config write that sits inside
       the start budget window; the r7 test uses it to prove the chain
       can't outrun the harness's bind wait. */
    if (SLOW_CONFIG_MS > 0) await tick(SLOW_CONFIG_MS);
    s.config.set(params.configId, String(params.value));
    return { configOptions: configOptions(s) };
  },

  authenticate: async () => ({}),

  prompt: async (params) => {
    const s = sessions.get(params.sessionId);
    if (!s || s.closed) throw { code: -32002, message: "no live session" };
    s.cancelled = false;
    const text = promptText(params.prompt);
    s.transcript.push(text);
    const hasImage = params.prompt.some((b) => b.type === "image");

    /* The llm auto-title rides session_info_update — sent at turn END so a
       user title picked mid-turn (a parked ask) still outranks it (#137
       AC-5: engine-fake's llm stage lands after the reply too). */
    const sendTitle = async () => {
      if (s.titled) return;
      s.titled = true;
      await send(conn, s.id, {
        sessionUpdate: "session_info_update",
        title: `Fake — ${s.transcript[0]?.split("\n")[0]?.slice(0, 40) ?? "session"}`,
      } as acp.SessionUpdate);
    };

    const usage = async () => {
      await send(conn, s.id, {
        sessionUpdate: "usage_update",
        used: 1024 + s.transcript.length * 128,
        size: 200_000,
      } as acp.SessionUpdate);
      return {
        inputTokens: 100,
        outputTokens: 42,
        thoughtTokens: 0,
        cachedReadTokens: 0,
        totalTokens: 142,
      };
    };

    let outcome: "done" | "cancelled" = "done";
    const codeword = text.match(/codeword\s+(\S+)/i)?.[1];
    if (codeword) {
      s.codewords.push(codeword);
      await sendText(conn, s.id, "LILOS_OK");
    } else if (/^recall:/i.test(text.trim())) {
      await sendText(
        conn,
        s.id,
        s.codewords.length ? s.codewords.join(" ") : "(nothing)",
      );
      await sendText(conn, s.id, " LILOS_OK");
    } else if (/plan: tasks/i.test(text)) {
      /* The plan prompt's steps name tools ("edit README.md") — the plan
         surface owns the turn, so this branch precedes the mutating one. */
      outcome = await runPlan(conn, s);
    } else if (/chmod 777/.test(text)) {
      outcome = await runMutating(conn, s, {
        title: "chmod 777 README.md",
        kind: "execute",
        input: { command: "chmod 777 README.md" },
      });
    } else if (/edit README\.md|mutating tool call/i.test(text)) {
      outcome = await runMutating(conn, s, {
        title: "Edit README.md",
        kind: "edit",
        input: { path: "README.md" },
      });
    } else if (/\bLILOS_SLOW\b/.test(text)) {
      outcome = await runSlow(conn, s, /300 words/.test(text) ? 320 : 220);
    } else if (/^env \S+$/i.test(text.trim())) {
      /* D-#845 probe: the spawned child's own env view — the serve test
         asserts LILOS_* internals never cross the seam's spawn scrub
         while HOME/PATH still do. */
      const name = text.trim().split(/\s+/)[1];
      const toolCallId = `call-${++nextToolCall}`;
      await send(conn, s.id, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: `env ${name}`,
        kind: "read",
        status: "in_progress",
        rawInput: { name },
      } as acp.SessionUpdate);
      await send(conn, s.id, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: `env ${name}`,
        status: "completed",
        rawOutput: process.env[name] ?? "<unset>",
      } as acp.SessionUpdate);
      await sendText(conn, s.id, "LILOS_OK");
    } else if (/^meta$/i.test(text.trim())) {
      /* The `_meta` the client sent on session/new|load — proves a shim's
         sessionMeta really crosses the wire (D-#866). */
      const toolCallId = `call-${++nextToolCall}`;
      await send(conn, s.id, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "meta",
        kind: "read",
        status: "in_progress",
      } as acp.SessionUpdate);
      await send(conn, s.id, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: "meta",
        status: "completed",
        rawOutput: JSON.stringify(s.meta ?? null),
      } as acp.SessionUpdate);
      await sendText(conn, s.id, "LILOS_OK");
    } else if (/read or search tool|relay package/i.test(text)) {
      await sendTool(conn, s.id, {
        title: "Read relay package",
        kind: "read",
        input: { path: "packages/relay" },
      });
      await sendText(conn, s.id, "LILOS_OK");
    } else {
      await sendText(
        conn,
        s.id,
        hasImage ? "image received LILOS_OK" : "LILOS_OK",
      );
    }

    const u = await usage();
    await sendTitle();
    return {
      stopReason:
        outcome === "cancelled" || s.cancelled ? "cancelled" : "end_turn",
      usage: u,
    };
  },

  cancel: async (params) => {
    const s = sessions.get(params.sessionId);
    if (s) s.cancelled = true;
  },
});

const stream = acp.ndJsonStream(
  /* Writable side first: stdout carries agent->client frames; stderr is
     for any logging (stdout is the protocol wire, keep it clean). */
  new WritableStream({
    write(chunk) {
      process.stdout.write(chunk);
    },
  }),
  new ReadableStream({
    start(controller) {
      process.stdin.on("data", (d: Buffer) =>
        controller.enqueue(new Uint8Array(d)),
      );
      process.stdin.on("end", () => controller.close());
    },
  }),
);

const conn = new acp.AgentSideConnection(agent, stream);
void conn.closed.catch(() => {});

/* r6 close-orphan shape: `LILOS_FAKE_TERM_IGNORING_PIDFILE=<file>` spawns
   a `sleep` that ignores SIGTERM (an ignored disposition survives exec)
   in the adapter's process group, records its pid, and — with
   `LILOS_FAKE_EXIT_AFTER_MS=<ms>` — exits the adapter CLEANLY (code 0)
   that long after boot. The adapter then exits 0 while the grandchild
   lives: the repro for close() skipping the group kill whenever the
   proc already had an exit code. */
if (process.env.LILOS_FAKE_TERM_IGNORING_PIDFILE) {
  const g = spawn("sh", ["-c", `trap "" TERM; exec sleep 300`], {
    stdio: "ignore",
  });
  writeFileSync(process.env.LILOS_FAKE_TERM_IGNORING_PIDFILE, String(g.pid));
  g.unref();
}
const FAKE_EXIT_AFTER_MS = Number(process.env.LILOS_FAKE_EXIT_AFTER_MS ?? 0);
if (FAKE_EXIT_AFTER_MS > 0)
  setTimeout(() => process.exit(0), FAKE_EXIT_AFTER_MS).unref();
