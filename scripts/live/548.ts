/**
 * Issue #548 live leg — the host-backend collision: another `hermes serve`
 * (Hermes Desktop, a dashboard, a second LilOS) already owns this OS user's
 * machine-level backend when LilOS's engine starts. LilOS must still reach
 * `running` on its own `--isolated` backend, a DM turn must answer, and the
 * lilos plugin must load (AC-1, AC-2).
 *
 *   bun scripts/live/548.ts [--seconds N]
 *
 * The "other app" is a PLAIN `hermes serve` (no --isolated) spawned first —
 * exactly the owner an installed LilOS.app / Hermes Desktop is. Then the
 * engine goes up through `startHermesServe` like the adapter does: pre-fix
 * it attaches to the owner and exits 0 ("exited early"), post-fix it binds
 * its own port and logs the observe-only line.
 *
 * HOME/HERMES_HOME isolation is the caller's job (548.sh); nothing here
 * kills or touches anything it did not spawn.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Relative imports: scripts/ is not a workspace dir, so @lilos/* does not
// resolve here — each package resolves its own deps internally.
import { serveSurfaces } from "../../apps/harness/src/surfaces/server";
import type {
  AppMessage,
  Conversation,
} from "../../packages/contracts/src/app/domain";
import type { SessionBinding } from "../../packages/contracts/src/harness/binding";
import { HermesEngine } from "../../packages/engine-hermes/src/engine";
import {
  type GatewayEvent,
  HermesGateway,
} from "../../packages/engine-hermes/src/gateway";
import { startHermesServe } from "../../packages/engine-hermes/src/serve";
import { connectInMemory } from "../../packages/engine-hermes/src/transport";
import type { AppOps } from "../../packages/surfaces/src/drivers";
import { cleanup, startStub } from "./lib/helpers";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const provider = process.env.HERMES_PROVIDER ?? "lilos-stub";
const model = process.env.HERMES_MODEL ?? "stub-model";
const seconds = Number(arg("seconds", "90") ?? "90");
const workdir = mkdtempSync(join(tmpdir(), "lilos548-"));
const HERMES_HOME = process.env.HERMES_HOME ?? join(workdir, "hermes-home");
const repoRoot =
  process.env.LILOS_REPO_ROOT ??
  dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const pluginSrc = join(repoRoot, "packages/engine-hermes/plugin/lilos");
const HERMES_BIN = process.env.HERMES_BIN ?? "hermes";

const t0 = Date.now();
const out = (line: string) =>
  console.log(`[live-548 +${String(Date.now() - t0).padStart(5)}ms] ${line}`);

/* ------------------------------- boot --------------------------------- */

const stub = process.env.LILOS_STUB_PORT
  ? await startStub(Number(process.env.LILOS_STUB_PORT))
  : null;
if (stub) out(`openai-stub listening on :${stub.port}`);

/* The real surfaces gateway — the plugin's catalog snapshot is generated
   from the same renderer this endpoint serves (see 411.ts). */
const BINDING: SessionBinding = {
  employeeId: "emp-1",
  channelId: "ch-dm-1",
  conversationId: "conv-1",
};
const now = Date.now();
const thread: Conversation = {
  id: "conv-1",
  channelId: "ch-dm-1",
  rootMessageId: "m-1",
  engineRef: null,
  state: "active",
  title: "DM with Ada",
  titleSource: "auto",
  access: "ask",
  archived: false,
  deliveredSeq: 0,
  createdAt: now,
};
const appOps: AppOps = {
  postMessage: async (text) =>
    ({
      id: `m-${Date.now()}`,
      channelId: BINDING.channelId,
      conversationId: BINDING.conversationId,
      seq: 1,
      authorKind: "employee",
      authorId: BINDING.employeeId,
      text,
      createdAt: Date.now(),
      rewound: false,
      dropped: false,
      removed: false,
      claimed: false,
    }) as AppMessage,
  readConversation: async () => [],
  listThreads: async () => [thread],
  threadSummaries: async () => [],
  employees: async () => [
    {
      id: BINDING.employeeId,
      name: "Ada",
      role: "engineer",
      status: "online",
      profile: "default",
      model,
      now: "",
      instructions: "",
      respondTo: "anyone",
      createdAt: now,
    },
  ],
  threadPrs: async () => [],
  searchMessages: async () => [],
  setThreadTitle: async (title) => ({ outcome: "set", title }),
  status: async () => ({
    protocolVersion: 1,
    generatedAt: Date.now(),
    components: [
      { id: "relay", label: "relay", state: "ok", reason: "" },
      { id: "harness", label: "harness", state: "ok", reason: "" },
      { id: "engine", label: "engine", state: "ok", reason: "" },
      { id: "model", label: "model", state: "ok", reason: "" },
    ],
    versions: { relay: "live-548", relayProtocol: 1 },
  }),
  profile: async () => ({ userName: "Oscar", companyName: "LilOS" }),
  openWorkbench: async () => {},
};
const surfaces = await serveSurfaces(0, {
  appOps: (_session, binding) => (binding ? appOps : undefined),
  log: {
    debug: () => {},
    info: (m: string, d?: Record<string, unknown>) =>
      out(`surfaces ${m} ${d ? JSON.stringify(d) : ""}`),
    warn: (m: string, d?: Record<string, unknown>) =>
      out(`surfaces! ${m} ${d ? JSON.stringify(d) : ""}`),
    error: (m: string, d?: Record<string, unknown>) =>
      out(`surfaces! ${m} ${d ? JSON.stringify(d) : ""}`),
    close: () => {},
  },
});
out(`surfaces gateway at ${surfaces.url}`);

/* The "other app": a plain `hermes serve` — NO --isolated — the way Hermes
   Desktop or an old LilOS owns the host. It claims the host lock and
   publishes the rendezvous record our engine's serve would attach to. */
async function spawnHostBackend() {
  const token = `lilos-host-${randomBytes(16).toString("hex")}`;
  const child = spawn(
    HERMES_BIN,
    ["serve", "--host", "127.0.0.1", "--port", "0", "--skip-build"],
    {
      env: {
        ...process.env,
        HOME: process.env.HOME ?? "",
        HERMES_HOME,
        HERMES_DASHBOARD_SESSION_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`host serve never ready:\n${logs}`)),
      240_000,
    );
    const onData = (d: Buffer | string) => {
      logs += String(d);
      const m = /HERMES_BACKEND_READY port=(\d+)/.exec(logs);
      if (m) {
        clearTimeout(timeout);
        resolve(Number(m[1]));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`host serve exited ${code}:\n${logs}`));
    });
  });
  return {
    port,
    async close() {
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          r();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    },
  };
}

const host = await spawnHostBackend();
out(
  `host backend ready at http://127.0.0.1:${host.port} (the "other app" — no --isolated)`,
);

/* LilOS's engine backend — the same startHermesServe the adapter's backend
   supervisor calls. On the bug it attaches to `host` and exits 0. */
const hermesEnv: Record<string, string> = {
  HOME: process.env.HOME ?? "",
  HERMES_HOME,
  LILOS_SURFACES_URL: surfaces.url,
  LILOS_ENGINE_TOKEN: surfaces.engineToken,
};
const hermes = await startHermesServe({
  bin: HERMES_BIN,
  timeoutMs: 240_000,
  env: hermesEnv,
});
out(`lilos engine backend ready at ${hermes.url}`);

const shutdown = async () => {
  await hermes.close();
  await host.close();
  await surfaces.close();
  cleanup(workdir);
};
process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(130));
});

/* ---------------------------- wire + engine ---------------------------- */

const toolCalls: { tool: string; ok: boolean; result?: string }[] = [];
const gateway = await HermesGateway.connect(
  `ws://127.0.0.1:${hermes.port}/api/ws?token=${hermes.token}`,
);
gateway.onEvent((e: GatewayEvent) => {
  if (e.type === "gateway.ready") return;
  if (e.type.startsWith("tool.")) {
    const p = e.payload as Record<string, unknown>;
    toolCalls.push({
      tool: String(p.tool ?? p.tool_name ?? p.name ?? "?"),
      ok: e.type !== "tool.error",
      result:
        p.result === undefined
          ? undefined
          : typeof p.result === "string"
            ? p.result
            : JSON.stringify(p.result),
    });
    out(`wire ${e.type} ${JSON.stringify(p).slice(0, 200)}`);
  }
});
out("gateway connected");

const engine = new HermesEngine({
  gateway,
  hermesHome: HERMES_HOME,
  onLog: (line) => out(`engine ${line}`),
});
/* The backend's own HTTP endpoint — what the production supervisor hands
   over; the #549 self-heal POSTs agent-plugins/activate there. */
engine.setGateway(gateway, { url: hermes.url, token: hermes.token });
const conn = connectInMemory(engine);
const engineTools: string[] = [];
conn.onEvent((e) => {
  if (e.type === "tool.started" || e.type === "tool.completed") {
    const p = e.payload as Record<string, unknown>;
    const name = String(p.tool ?? p.tool_name ?? "");
    if (name) engineTools.push(name);
  }
  /* Headless run: never let an approval ask stall the turn. */
  if (e.type === "request.opened") {
    const p = e.payload as {
      requestId: string;
      request: { kind: string };
    };
    void conn.request("request.respond", {
      sessionId: e.sessionId,
      requestId: p.requestId,
      outcome: p.request.kind === "question" ? "answer" : "once",
      ...(p.request.kind === "question" ? { answer: "proceed" } : {}),
    });
  }
});

/* -------------------------------- run ---------------------------------- */

let { agents } = (await conn.request("agents.list")) as {
  agents: { id: string }[];
};
if (!agents[0]?.id) {
  out("no hermes profile under the isolated home — creating 'lilos548'");
  await conn.request("agents.create", {
    name: "lilos548",
    description: "live-548 check profile",
    model,
    provider,
  });
  ({ agents } = (await conn.request("agents.list")) as {
    agents: { id: string }[];
  });
}
const agent = agents[0]?.id;
if (!agent) throw new Error("no hermes profile available");
out(`agent=${agent}`);

/* The plugin install, exactly the way connect.ts does it. */
const profileHome =
  agent === "default" ? HERMES_HOME : join(HERMES_HOME, "profiles", agent);
mkdirSync(join(profileHome, "plugins"), { recursive: true });
cpSync(pluginSrc, join(profileHome, "plugins", "lilos"), { recursive: true });
out(`plugin copied to ${join(profileHome, "plugins", "lilos")}`);

const tEnable = Date.now();
const hermesCli = (argv: string[]) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(HERMES_BIN, argv, {
      env: { ...process.env, ...hermesEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outBuf = "";
    p.stdout?.on("data", (d) => (outBuf += d));
    p.stderr?.on("data", (d) => (outBuf += d));
    p.on("exit", (code) => resolve({ code, out: outBuf }));
  });
const enable = await hermesCli(["-p", agent, "plugins", "enable", "lilos"]);
out(
  `plugins enable exited ${enable.code} in ${Date.now() - tEnable}ms — ${enable.out.trim().split("\n").pop() ?? ""}`,
);

const ts = await hermesCli([
  "-p",
  agent,
  "config",
  "set",
  "tools.tool_search.enabled",
  "off",
]);
out(
  `config set tool_search=off exited ${ts.code} — ${ts.out.trim().split("\n").pop() ?? ""}`,
);

const handle = surfaces.create({ cwd: workdir, binding: BINDING });
const { sessionId, engineSessionId } = (await conn.request("session.start", {
  agent,
  cwd: workdir,
  model,
  provider,
})) as { sessionId: string; engineSessionId?: string };
if (engineSessionId)
  surfaces.bindEngineSession(handle.session, engineSessionId);
out(
  `session ${sessionId} engineSessionId=${engineSessionId ?? "none"} bound to surfaces ${handle.session}`,
);

const prompt =
  "Use your LilOS tools: call lilos_context and lilos_team_list, then tell me who you are and who is on the team.";
out(`prompt: ${JSON.stringify(prompt)}`);
const res = (await conn.request("prompt", {
  sessionId,
  content: [{ type: "text", text: prompt }],
})) as { turnId: string; stopReason: string };
out(`prompt resolved ${JSON.stringify(res)}`);

await new Promise((r) => setTimeout(r, Math.min(seconds, 5) * 1000));

/* --------------------------- observations ------------------------------ */

let ok = true;
const check = (pass: boolean, label: string) => {
  out(`${pass ? "PASS" : "FAIL"} ${label}`);
  if (!pass) ok = false;
};

/* AC-1: the engine bound its OWN backend alongside the owner's — it did
   not attach and exit 0 (the start above would have thrown the typed
   conflict), and the port proves it is a distinct server. */
check(
  hermes.port !== host.port,
  `engine bound its own backend (lilos :${hermes.port} vs owner :${host.port})`,
);

/* Same fact from the hermes side: the isolated backend logs the
   "bound anyway (observe-only)" line — only the host rendezvous record is
   unpublished; plugins/sessions/resume all work. `_log.warning` lands in
   the serve child's output on some builds and in log files under
   HERMES_HOME on others — read BOTH, fail only if neither has it. */
const observeLines: string[] = [...hermes.logTail().split("\n")].filter(
  (l) => l.includes("observe-only") || l.includes("already owns this host"),
);
const logFiles: string[] = [];
const walkLogs = (dir: string) => {
  if (!existsSync(dir)) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkLogs(p);
    else if (ent.name.endsWith(".log")) logFiles.push(p);
  }
};
for (const dir of [HERMES_HOME, profileHome]) walkLogs(dir);
for (const p of logFiles) {
  try {
    observeLines.push(
      ...readFileSync(p, "utf8")
        .split("\n")
        .filter(
          (l) =>
            l.includes("observe-only") || l.includes("already owns this host"),
        ),
    );
  } catch {
    /* unreadable file */
  }
}
check(
  observeLines.length > 0,
  `engine backend went observe-only in hermes output (${observeLines.length} lines)`,
);
for (const l of observeLines.slice(0, 3)) out(`  observe-line: ${l}`);

/* AC-2: the session's tool list — wire `tools.list` scoped to this session. */
let offered: string[] = [];
try {
  const r = (await gateway.request("tools.list", {
    session_id: sessionId,
  })) as { toolsets?: { name: string; tools?: string[]; enabled?: boolean }[] };
  const lilos = (r.toolsets ?? []).find((t) => t.name === "lilos");
  offered = lilos?.tools ?? [];
  out(
    `tools.list lilos toolset: ${offered.length} tools, enabled=${lilos?.enabled}`,
  );
} catch (e) {
  out(`tools.list failed: ${String(e)}`);
}
check(
  offered.includes("lilos_context"),
  "turn tool list contains lilos_context",
);

/* A lilos_* tool call actually ran — wire tool.* frames or the engine's
   tool.started. */
const ranLilos =
  toolCalls.some((c) => c.tool.startsWith("lilos_")) ||
  engineTools.some((t) => t.startsWith("lilos_"));
check(
  ranLilos,
  `a lilos_* tool call ran (wire: ${toolCalls.map((c) => c.tool).join(",") || "none"}; engine: ${engineTools.join(",") || "none"})`,
);
const lilosResults = toolCalls.filter(
  (c) => c.tool.startsWith("lilos_") && c.result !== undefined,
);
const lilosOk = lilosResults.some(
  (c) =>
    !/failed|unauthorized|unavailable|only runs inside/i.test(c.result ?? ""),
);
check(
  lilosOk,
  `a lilos_* call returned real data (${lilosResults.map((c) => (c.result ?? "").slice(0, 80)).join(" | ") || "no results"})`,
);

/* The model-facing tool list — under the stub this is exactly the tools[]
   array on the provider request. */
if (process.env.STUB_REQUEST_LOG && existsSync(process.env.STUB_REQUEST_LOG)) {
  const offeredToModel = new Set<string>();
  for (const line of readFileSync(process.env.STUB_REQUEST_LOG, "utf8").split(
    "\n",
  )) {
    if (!line.trim()) continue;
    try {
      for (const n of (JSON.parse(line) as { tool_names?: string[] })
        .tool_names ?? [])
        offeredToModel.add(n);
    } catch {
      /* partial line */
    }
  }
  check(
    offeredToModel.has("lilos_context"),
    `model-facing tool list contains lilos_context (${[...offeredToModel].filter((t) => t.startsWith("lilos_")).length} lilos_* offered)`,
  );
}

check(res.stopReason === "end_turn", `turn completed (${res.stopReason})`);

await conn.request("session.stop", { sessionId }).catch(() => {});
gateway.close();
await shutdown();
out(`RESULT: ${ok ? "PASS" : "FAIL"} (provider=${provider} model=${model})`);
process.exit(ok ? 0 : 1);
