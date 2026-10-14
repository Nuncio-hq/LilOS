/**
 * Issue #341 live leg — one REAL agent call per approval-gated tool on a
 * real `hermes serve` session, over the full stack: plugin `lilos` →
 * surfaces gateway → the real harness appOps → a real in-process relay →
 * ask card opened on the bound conversation → the user approves or
 * declines → the write lands (or doesn't).
 *
 *   bun scripts/live/341.ts [--seconds N]
 *
 * Same boot shape as the #411 leg (hermes serve + gateway + plugin enable),
 * except `appOps` is NOT a seeded store: it is `createAppOps` bound to a
 * real RelayClient against an in-process relay, with a real Harness
 * registered as the engine host so `agents.*` passthrough reaches Hermes.
 * A second RelayClient plays the user: it watches `asks.list` on the bound
 * conversation and answers each card — approve for the first four tools,
 * decline for the last folder_add.
 *
 * HOME/HERMES_HOME isolation is the caller's job (341.sh); nothing here
 * kills or touches anything it did not spawn.
 */

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Harness } from "../../apps/harness/src/harness";
import { createAppOps } from "../../apps/harness/src/harness/app-ops";
import { createMemoryLogger } from "../../apps/harness/src/log";
import { createFakeSleepGuard } from "../../apps/harness/src/sleep";
import { serveSurfaces } from "../../apps/harness/src/surfaces/server";
import { createRelay } from "../../apps/relay/src/session";
import { createMemoryStore } from "../../apps/relay/test/memory-store";
import type {
  RelaySocket,
  SocketFactory,
} from "../../packages/client-runtime/src/index";
import { RelayClient } from "../../packages/client-runtime/src/index";
import type { Ask } from "../../packages/contracts/src/app/domain";
import type { SessionBinding } from "../../packages/contracts/src/harness/binding";
import { HermesEngine } from "../../packages/engine-hermes/src/engine";
import {
  type GatewayEvent,
  HermesGateway,
} from "../../packages/engine-hermes/src/gateway";
import { startHermesServe } from "../../packages/engine-hermes/src/serve";
import { connectInMemory } from "../../packages/engine-hermes/src/transport";
import { cleanup, startStub } from "./lib/helpers";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const provider = process.env.HERMES_PROVIDER ?? "lilos-stub";
const model = process.env.HERMES_MODEL ?? "stub-model";
const seconds = Number(arg("seconds", "90") ?? "90");
const workdir = mkdtempSync(join(tmpdir(), "lilos341-"));
const HERMES_HOME = process.env.HERMES_HOME ?? join(workdir, "hermes-home");
const repoRoot =
  process.env.LILOS_REPO_ROOT ??
  dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const pluginSrc = join(repoRoot, "packages/engine-hermes/plugin/lilos");

const t0 = Date.now();
const out = (line: string) =>
  console.log(`[live-341 +${String(Date.now() - t0).padStart(5)}ms] ${line}`);

/* The same in-process socket pair apps/harness/test/helpers.ts uses —
   inlined here because that module registers a top-level afterEach
   (vitest-only). */
const socketFor =
  (r: ReturnType<typeof createRelay>): SocketFactory =>
  () => {
    const listeners = new Map<string, Array<(e?: unknown) => void>>();
    const emit = (type: string, e?: unknown) =>
      queueMicrotask(() =>
        (listeners.get(type) ?? []).forEach((fn) => void fn(e)),
      );
    let peer: { receive(f: string): Promise<void>; closed(): void };
    let readyState = 0;
    const socket = {
      get readyState() {
        return readyState;
      },
      send: (frame: string) => {
        void peer.receive(frame);
      },
      close: () => {
        readyState = 3;
        peer.closed();
        emit("close", { code: 1000, reason: "closed" });
      },
      addEventListener(type: string, fn: (e?: unknown) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
    } as unknown as RelaySocket;
    peer = r.connect({
      send: (frame) => emit("message", { data: frame }),
      close: (code, reason) => emit("close", { code, reason }),
    });
    queueMicrotask(() => {
      readyState = 1;
      emit("open");
    });
    return socket;
  };

/* ------------------------------- boot --------------------------------- */

const stub = process.env.LILOS_STUB_PORT
  ? await startStub(Number(process.env.LILOS_STUB_PORT))
  : null;
if (stub) out(`openai-stub listening on :${stub.port}`);

/* A real relay, in-process (the same one the vitest world boots), with a
   user client to seed the DM and answer asks, and a host client the real
   Harness rides on — so `agents.*` passthrough lands on Hermes. */
const TOKEN = "live-341-token";
const store = createMemoryStore();
const relay = createRelay({ store, token: TOKEN });
const hostClient = new RelayClient({
  url: "mem://host",
  token: TOKEN,
  socketFactory: socketFor(relay),
});
const log = createMemoryLogger();
const harness = new Harness({
  relay: hostClient,
  sleep: createFakeSleepGuard(),
  workdir,
  log,
});
const user = new RelayClient({
  url: "mem://user",
  token: TOKEN,
  socketFactory: socketFor(relay),
});
await user.connect();
const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer", profile: "builder" },
);
const { channel } = await user.request<{ channel: { id: string } }>(
  "channels.openDm",
  { employeeId: employee.id },
);
const { conversation } = await user.request<{
  conversation: { id: string };
}>("conversations.open", {
  channelId: channel.id,
  text: "live 341 dm",
});
const BINDING: SessionBinding = {
  employeeId: employee.id,
  channelId: channel.id,
  conversationId: conversation.id,
};
out(`dm seeded: employee=${employee.id} conversation=${conversation.id}`);

const surfaces = await serveSurfaces(0, {
  appOps: createAppOps({
    relay: hostClient,
    runningTurnId: () => undefined,
    log,
  }),
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

const hermesEnv: Record<string, string> = {
  HOME: process.env.HOME ?? "",
  HERMES_HOME,
  LILOS_SURFACES_URL: surfaces.url,
  LILOS_ENGINE_TOKEN: surfaces.engineToken,
};
const hermes = await startHermesServe({
  bin: process.env.HERMES_BIN ?? "hermes",
  timeoutMs: 240_000,
  env: hermesEnv,
});
out(`hermes serve ready at ${hermes.url}`);

const shutdown = async () => {
  await hermes.close();
  await surfaces.close();
  user.close();
  await harness.stop();
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

const engine = new HermesEngine({ gateway });
const conn = connectInMemory(engine);
conn.onEvent((e) => {
  /* Headless run: never let an engine-side ask stall a turn. The lilos
     approval cards are not engine asks — they are answered by the user
     client below. */
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

/* The engine host must be registered before agents.* calls forward — the
   real Harness does it, and it can also bind sessions onto the DM. */
harness.attachEngine(
  conn as unknown as Parameters<typeof harness.attachEngine>[0],
);
await harness.start();
out("harness started (engine host registered)");

/* -------------------------------- run ---------------------------------- */

let { agents } = (await conn.request("agents.list")) as {
  agents: { id: string }[];
};
if (!agents[0]?.id) {
  out("no hermes profile under the isolated home — creating 'lilos341'");
  await conn.request("agents.create", {
    name: "lilos341",
    description: "live-341 check profile",
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

const profileHome =
  agent === "default" ? HERMES_HOME : join(HERMES_HOME, "profiles", agent);
mkdirSync(join(profileHome, "plugins"), { recursive: true });
cpSync(pluginSrc, join(profileHome, "plugins", "lilos"), { recursive: true });
out(`plugin copied to ${join(profileHome, "plugins", "lilos")}`);

const hermesCli = (argv: string[]) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(process.env.HERMES_BIN ?? "hermes", argv, {
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
  `plugins enable exited ${enable.code} — ${enable.out.trim().split("\n").pop() ?? ""}`,
);
const ts = await hermesCli([
  "-p",
  agent,
  "config",
  "set",
  "tools.tool_search.enabled",
  "off",
]);
out(`config set tool_search=off exited ${ts.code}`);

const handle = surfaces.create({ cwd: workdir, binding: BINDING });
const { sessionId, engineSessionId } = (await conn.request("session.start", {
  agent,
  cwd: workdir,
  model,
  provider,
})) as { sessionId: string; engineSessionId?: string };
if (engineSessionId)
  surfaces.bindEngineSession(handle.session, engineSessionId);
out(`session ${sessionId} bound to surfaces ${handle.session}`);

/* The user at the other end of the DM: answer each gateway ask as it
   opens — approve every tool except the last folder_add (declined). */
const asks = async (state: "open" | "resolved") => {
  const { asks } = await user.request<{ asks: Ask[] }>("asks.list", {
    conversationId: conversation.id,
    state,
  });
  return asks;
};
const answered = new Set<string>();
const answerAsks = async (decline: boolean) => {
  const open = await asks("open");
  for (const a of open) {
    if (answered.has(a.id)) continue;
    answered.add(a.id);
    out(
      `user ${decline ? "DECLINES" : "approves"} ask ${a.id.slice(0, 8)} ` +
        `(${a.request.kind === "approval" ? a.request.command : a.request.kind})`,
    );
    await user.request("asks.respond", {
      askId: a.id,
      outcome: decline ? "deny" : "once",
    });
  }
};
/* Background answerer: approve unless the current leg wants a decline. */
let declineNext = false;
const answerer = setInterval(() => {
  void answerAsks(declineNext);
}, 250);
answerer.unref?.();

const promptOnce = async (text: string) => {
  const res = (await conn.request("prompt", {
    sessionId,
    content: [{ type: "text", text }],
  })) as { turnId: string; stopReason: string };
  out(`prompt resolved ${JSON.stringify(res)}`);
};

/* One leg per tool. The stub fires the scripted lilos_* call on the first
   model request of each prompt, then answers with canned text. */
const legs = [
  { key: "thread", label: "lilos_thread_start" },
  { key: "hire", label: "lilos_team_hire" },
  { key: "update", label: "lilos_team_update" },
  { key: "folder", label: "lilos_folder_add" },
];
for (const leg of legs) {
  await promptOnce(`live341 ${leg.key}`);
}
declineNext = true;
await promptOnce("live341 decline-folder");
declineNext = false;
await answerAsks(false);
await new Promise((r) => setTimeout(r, Math.min(seconds, 3) * 1000));
clearInterval(answerer);

/* --------------------------- observations ------------------------------ */

let ok = true;
const check = (pass: boolean, label: string) => {
  out(`${pass ? "PASS" : "FAIL"} ${label}`);
  if (!pass) ok = false;
};

for (const leg of [...legs, { key: "decline", label: "lilos_folder_add" }]) {
  const call = toolCalls.find((c) => c.tool === leg.label);
  check(Boolean(call), `real agent call ran: ${leg.label}`);
}

/* Every card was answered — none left open. */
const stillOpen = await asks("open");
check(stillOpen.length === 0, `no asks left open (${stillOpen.length})`);

/* Approve legs applied their writes. */
const { conversations } = await user.request<{
  conversations: { id: string; title: string | null }[];
}>("conversations.list", { channelId: channel.id });
out(
  `conversations: ${conversations.map((c) => `${c.id}:${c.title ?? "?"}`).join(", ")}`,
);
check(
  conversations.length >= 2,
  "thread_start applied: a new conversation exists",
);
const { employees } = await user.request<{
  employees: { id: string; name: string; role: string }[];
}>("employees.list", {});
const bea = employees.find((e) => e.name === "Bea");
check(Boolean(bea), "team_hire applied: Bea is an employee");
const ada = employees.find((e) => e.id === employee.id);
check(
  ada?.role === "lead engineer",
  "team_update applied: Ada is 'lead engineer'",
);
const { folders } = await user.request<{ folders: { path: string }[] }>(
  "folders.list",
  {},
);
check(
  folders.some((f) => f.path === "~/work/app"),
  "folder_add applied: ~/work/app in recents",
);
check(
  !folders.some((f) => f.path === "~/work/nope"),
  "declined folder_add wrote nothing",
);
const declinedCall = [...toolCalls]
  .reverse()
  .find((c) => c.tool === "lilos_folder_add" && c.result !== undefined);
check(
  !declinedCall?.ok || /declin|denied|403/i.test(declinedCall?.result ?? ""),
  `decline returned a declined error to the agent (${declinedCall?.result?.slice(0, 80) ?? declinedCall?.ok})`,
);

await conn.request("session.stop", { sessionId }).catch(() => {});
gateway.close();
await shutdown();
out(`RESULT: ${ok ? "PASS" : "FAIL"} (provider=${provider} model=${model})`);
process.exit(ok ? 0 : 1);
