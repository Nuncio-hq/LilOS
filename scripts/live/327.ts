/**
 * Issue #327 live leg — capture the REAL engine→harness frame sequence
 * around a reasoning turn and an untracked (dispatched) delegate_task,
 * then cold-start a fresh feed and fold it the way the apps do.
 *
 *   bun scripts/live/327.ts [--engine hermes] [--seconds N]
 *
 * Spawns the real relay + harness + `hermes serve` (same env as
 * scripts/live/288.ts). The stub provider (scripts/live/openai-stub.ts,
 * STUB_SCRIPT) scripts two legs:
 *
 *   1. message A — a `reasoning_content` delta before the answer, so the
 *      wire shows turn.delta stream=reasoning -> turn.completed ->
 *      session.state idle (the "Thinking…" arc #327 must collapse);
 *   2. message B — a delegate_task with background:true: hermes answers
 *      the call with {"status":"dispatched"} and the child keeps running
 *      off the record — the row can never see subagent.completed, so
 *      #327 settles it stopped when the session leaves "running".
 *
 * The cold-start leg then connects a SECOND EngineClient, syncs the
 * conversation's sessionFeed (session.events replay + snapshot — what a
 * phone opening the thread does), folds it with reduceSessionEvents, and
 * asserts: no live turn, turn A settled with its reasoning retained, and
 * no subagent row still spinning.
 *
 * Prints the full timeline, then PASS/FAIL observations. Exit 0 always —
 * this is a capture, not a gate.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative import: scripts/ is not a workspace dir, so @lilos/* does not
// resolve here — the package resolves its own deps internally.
import {
  EngineClient,
  RelayClient,
  reduceSessionEvents,
} from "../../packages/client-runtime/src/index";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const seconds = Number(arg("seconds", "60") ?? "60");
const engineKind = arg("engine", process.env.LILOS_ENGINE ?? "hermes");
const textA =
  arg("texta", "take a moment then answer plainly") ??
  "take a moment then answer plainly";
const textB = arg("textb", "hand it off now") ?? "hand it off now";

const t0 = Date.now();
const out = (line: string) =>
  console.log(`[live-327 +${String(Date.now() - t0).padStart(5)}ms] ${line}`);
const relayHome = mkdtempSync(join(tmpdir(), "lilos327-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos327-harness-"));
const workdir = join(harnessHome, "work");

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === "object" && addr
          ? resolve(addr.port)
          : reject(new Error("no port")),
      );
    });
  });

const procs: ChildProcess[] = [];
const launch = (name: string, cmd: string[], env: Record<string, string>) => {
  const child = spawn(cmd[0] ?? "bun", cmd.slice(1), {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(child);
  child.stdout?.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => void console.log(`  [${name}] ${l}`)),
  );
  child.stderr?.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => void console.error(`  [${name}!] ${l}`)),
  );
  return child;
};
const cleanup = () => {
  for (const p of procs) p.kill("SIGTERM");
  rmSync(relayHome, { recursive: true, force: true });
  rmSync(harnessHome, { recursive: true, force: true });
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

const waitForFile = async (path: string, ms = 10_000): Promise<string> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
};

/* -------------------------------- boot ---------------------------------- */

const relayPort = await freePort();
const feedPort = await freePort();
launch("relay", ["bun", "apps/relay/src/index.ts"], {
  LILOS_RELAY_HOME: relayHome,
  LILOS_RELAY_PORT: String(relayPort),
});
const relayToken = await waitForFile(join(relayHome, "relay-token"));
const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;
out(`relay ws ${relayUrl}`);

launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: workdir,
  LILOS_ENGINE: engineKind,
  LILOS_FEED_PORT: String(feedPort),
  LILOS_REPO_ROOT: repoRoot,
});
out(`harness launched (engine=${engineKind})`);

{
  const deadline = Date.now() + 30_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${feedPort}/host`, {
        method: "OPTIONS",
      });
      if (res.status === 204) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) throw new Error("harness feed did not come up");
}

/* ------------------------------ recording -------------------------------- */

interface Rec {
  ms: number;
  seq?: number;
  type: string;
  detail: string;
}
const tape: Rec[] = [];
const rec = (type: string, detail: string, seq?: number) =>
  tape.push({ ms: Date.now() - t0, type, detail, ...(seq ? { seq } : {}) });

const engine = new EngineClient({
  url: `ws://127.0.0.1:${feedPort}/ws`,
  connectTimeoutMs: 60_000,
});
engine.onEvent((e) => {
  const p = e.payload as Record<string, unknown>;
  const bits: string[] = [];
  for (const k of [
    "turnId",
    "ref",
    "toolCallId",
    "tool",
    "subagentId",
    "parentToolCallId",
    "status",
    "stopReason",
    "name",
    "stream",
    "state",
  ]) {
    if (p[k] !== undefined) bits.push(`${k}=${JSON.stringify(p[k])}`);
  }
  for (const k of ["output", "result", "text", "task", "delta"]) {
    if (typeof p[k] === "string" && p[k])
      bits.push(`${k}=${JSON.stringify(String(p[k]).slice(0, 120))}`);
  }
  rec(e.type, `sid=${e.sessionId} ${bits.join(" ")}`, e.seq);
});
await engine.connect();
out("feed connected — recording every engine event");

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-327", version: "0" },
});
await user.connect();

/* Tool-call approvals surface as relay asks — answer "once" so delegate /
   terminal calls run without a human. */
const answeredAsks = new Set<string>();
const approvals = setInterval(() => {
  void user
    .request<{ asks: { id: string; state: string }[] }>("asks.list", {})
    .then(({ asks }) => {
      for (const a of asks) {
        if (a.state !== "open" || answeredAsks.has(a.id)) continue;
        answeredAsks.add(a.id);
        rec("ask.auto-approve", `askId=${a.id} outcome=once`);
        void user
          .request("asks.respond", { askId: a.id, outcome: "once" })
          .catch((e) => rec("ask.respond-failed", `${a.id}: ${e}`));
      }
    })
    .catch(() => {});
}, 400);

/* --------------------------------- run ---------------------------------- */

const sessionIdle = () =>
  new Promise<void>((resolve) => {
    const off = engine.onEvent((e) => {
      if (
        e.type === "session.state" &&
        (e.payload as { state?: string }).state === "idle"
      ) {
        off();
        resolve();
      }
    });
  });

/* A phone opening the thread connects fresh to the RELAY and syncs the
   feed: the relay's `session.events` replay + snapshot is the whole
   durable truth it sees — fold it the way apps do and hand the model to
   the checks. (The harness feed speaks `events.since` only — calling
   `sessionFeed` on it answers METHOD_NOT_FOUND, which the client reads as
   "no session bound": an empty feed with a closed seed snapshot. That was
   this script's first cold leg, not a product bug.) */
const coldFold = async (label: string) => {
  const cold = new RelayClient({
    url: relayUrl,
    token: relayToken,
    client: { name: `lilos-live-327-${label}`, version: "0" },
  });
  await cold.connect();
  const coldFeed = cold.sessionFeed(conversation.id);
  const deadline = Date.now() + 15_000;
  while (!coldFeed.get().synced) {
    if (Date.now() > deadline) {
      cold.close();
      throw new Error(`cold feed never synced (${label})`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const f = coldFeed.get();
  out(
    `cold start (${label}) — replayed ${f.events.length} events, snapshot sid=${f.snapshot?.sessionId} state=${f.snapshot?.state}`,
  );
  cold.close();
  return f.sessionId
    ? reduceSessionEvents(f.sessionId, f.events, f.snapshot)
    : undefined;
};

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer" },
);
const { channel } = await user.request<{
  channel: { id: string; employeeId: string };
}>("channels.openDm", { employeeId: employee.id });
const messages = user.channelMessages(channel.id);

const { conversation } = await user.request<{
  conversation: { id: string };
}>("conversations.open", {
  channelId: channel.id,
  text: textA,
  title: `#327 ${Date.now().toString(36)}`,
});
rec("user.message", `A=${JSON.stringify(textA)} conv=${conversation.id}`);
out(`conversation ${conversation.id} — message A sent (reasoning leg)`);

await sessionIdle();
out("session idle after turn A");
{
  const { conversations } = await user.request<{
    conversations: { id: string; engineRef?: string; state?: string }[];
  }>("conversations.list", {});
  const c = conversations.find((x) => x.id === conversation.id);
  out(`relay sees conv engineRef=${c?.engineRef} state=${c?.state}`);
}

/* AC: cold-start while the session is still live — the phone replays the
   durable tape, the fold must settle the finished turn. */
const modelA = await coldFold("after reasoning turn");

await user.request("messages.post", {
  channelId: channel.id,
  conversationId: conversation.id,
  authorId: "user",
  authorKind: "user",
  text: textB,
});
rec("user.message", `B=${JSON.stringify(textB)} — delegate_task leg`);
await sessionIdle();
out("session idle after turn B");

/* Keep recording a beat — the result-delivery leg and any stragglers. */
const endAt = Date.now() + seconds * 1000;
await new Promise((r) => setTimeout(r, Math.max(0, endAt - Date.now())));
clearInterval(approvals);

const modelB = await coldFold("after dispatched delegate");

/* ------------------------------- dump ----------------------------------- */

console.log("\n================ FRAME TIMELINE ================");
for (const r of tape) {
  const seq = r.seq === undefined ? "  --" : String(r.seq).padStart(4);
  console.log(
    `+${String(r.ms).padStart(6)}ms seq=${seq} ${r.type} ${r.detail}`,
  );
}
console.log("================================================\n");

const msgs = messages.get().messages;
console.log("================ RELAY MESSAGES =================");
for (const m of msgs) {
  console.log(
    `  ${m.id} ${m.authorKind} seq=${m.seq} :: ${JSON.stringify(m.text.slice(0, 90))}`,
  );
}
console.log("=================================================\n");

/* Observations the PR write-up quotes. */
const seen = (pred: (r: Rec) => boolean) => tape.some(pred);
const reasoningDeltas = tape.filter(
  (r) => r.type === "turn.delta" && r.detail.includes('stream="reasoning"'),
);
const subSettles = tape.filter(
  (r) =>
    r.type === "subagent.completed" && r.detail.includes('status="stopped"'),
);
const idleIdx = tape.findIndex(
  (r) => r.type === "session.state" && r.detail.includes('state="idle"'),
);

out(`reasoning deltas captured: ${reasoningDeltas.length}`);
out(
  `first session.state idle at seq ${idleIdx >= 0 ? tape[idleIdx].seq : "—"}`,
);

let ok = true;
const check = (pass: boolean, label: string) => {
  out(`${pass ? "PASS" : "FAIL"} ${label}`);
  if (!pass) ok = false;
};

check(
  seen(
    (r) => r.type === "turn.delta" && r.detail.includes('stream="reasoning"'),
  ),
  "reasoning streamed on the wire (turn.delta stream=reasoning)",
);
check(
  seen((r) => r.type === "turn.completed"),
  "turn.completed landed",
);
check(idleIdx >= 0, "session.state idle emitted at turn end");
if (subSettles.length)
  out(
    `subagent.completed stopped frames: ${subSettles
      .map((r) => `seq=${r.seq} ${r.detail.slice(0, 80)}`)
      .join(" | ")}`,
  );
else
  out(
    "no subagent.completed stopped — the receipt may have been synchronous (note only)",
  );

if (!modelA) {
  check(false, "cold fold after turn A produced a session model");
} else {
  check(
    modelA.live === undefined,
    "cold fold A: no live turn (model.live unset)",
  );
  check(
    modelA.turns.every((t) => t.phase === "done" || t.phase === "stopped"),
    `cold fold A: every turn settled (${modelA.turns.map((t) => t.phase).join(",")})`,
  );
  const turnA = modelA.turns.find((t) => t.reasoning?.trim());
  check(
    turnA !== undefined,
    "cold fold A: the reasoning text survived replay (renders 'Thought…')",
  );
}
if (!modelB) {
  check(false, "cold fold after turn B produced a session model");
} else {
  check(
    modelB.live === undefined,
    "cold fold B: no live turn (model.live unset)",
  );
  const runningSubs = modelB.turns.flatMap((t) =>
    t.subagents.filter((s) => s.status === "running"),
  );
  check(
    runningSubs.length === 0,
    `cold fold B: no subagent row still running (${
      modelB.turns
        .flatMap((t) => t.subagents)
        .map((s) => s.status)
        .join(",") || "none"
    })`,
  );
}

user.close();
engine.close();
cleanup();
out(`RESULT: ${ok ? "PASS" : "FAIL (see lines above)"}`);
process.exit(ok ? 0 : 1);
