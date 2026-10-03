/**
 * Issue #414 live leg — drive a real say-then-tool turn on `hermes serve`
 * and prove the pre-tool commentary reaches the folded turn text exactly
 * once (the bug rendered it twice: once via message.delta, again via
 * message.interim's authoritative segment text).
 *
 *   bun scripts/live/414.ts [--seconds N]
 *
 * Same shape as scripts/live/334.ts: spawns `hermes serve` for real
 * (packages/engine-hermes/src/serve.ts), connects a gateway + engine at
 * the wire layer — no relay/harness needed, the bug lived in the
 * wire->engine mapping — records BOTH sides, then folds the engine log
 * with reduceSessionEvents the way the thread does.
 *
 * The prompt is the issue's reproduction ("add a subtract function and a
 * test file, don't commit"). In stub mode STUB_SCRIPT scripts one
 * assistant message carrying commentary text + a real `tool_call`
 * (todo_list), which makes upstream emit `message.interim`; a real model
 * produces the same frame naturally on any say-then-tool turn.
 * Approval asks are auto-answered "once" so the run never blocks.
 *
 * PASS criteria:
 *   - the wire emitted `message.interim` (the seal frame exists on this
 *     build — the check can't prove anything without it);
 *   - each interim's text occurs EXACTLY ONCE in the folded turn text;
 *   - the turn completed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative imports: scripts/ is not a workspace dir, so @lilos/* does not
// resolve here — each package resolves its own deps internally.
import { reduceSessionEvents } from "../../packages/client-runtime/src/index";
import type { EngineEvent } from "../../packages/contracts/src/engine";
import { HermesEngine } from "../../packages/engine-hermes/src/engine";
import {
  type GatewayEvent,
  HermesGateway,
} from "../../packages/engine-hermes/src/gateway";
import { startHermesServe } from "../../packages/engine-hermes/src/serve";
import { connectInMemory } from "../../packages/engine-hermes/src/transport";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const provider = process.env.HERMES_PROVIDER ?? "lilos-stub";
const model = process.env.HERMES_MODEL ?? "stub-model";
const seconds = Number(arg("seconds", "60") ?? "60");
const workdir = mkdtempSync(join(tmpdir(), "lilos414-"));

const t0 = Date.now();
const out = (line: string) =>
  console.log(`[live-414 +${String(Date.now() - t0).padStart(5)}ms] ${line}`);

/* ------------------------------- boot --------------------------------- */

const hermes = await startHermesServe({
  bin: process.env.HERMES_BIN ?? "hermes",
  timeoutMs: 240_000,
});
out(`hermes serve ready at ${hermes.url}`);

const cleanup = async () => {
  await hermes.close();
  rmSync(workdir, { recursive: true, force: true });
};
process.on("SIGINT", () => {
  void cleanup().then(() => process.exit(130));
});

interface Rec {
  ms: number;
  side: "wire" | "engine" | "client";
  type: string;
  detail: string;
  seq?: number;
}
const tape: Rec[] = [];
const rec = (side: Rec["side"], type: string, detail: string, seq?: number) =>
  tape.push({
    ms: Date.now() - t0,
    side,
    type,
    detail,
    ...(seq ? { seq } : {}),
  });

const pick = (p: Record<string, unknown>, keys: string[]) => {
  const bits: string[] = [];
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v)
      bits.push(`${k}=${JSON.stringify(v.slice(0, 160))}`);
    else if (v !== undefined && typeof v !== "object")
      bits.push(`${k}=${JSON.stringify(v)}`);
  }
  return bits.join(" ");
};

const gateway = await HermesGateway.connect(
  `ws://127.0.0.1:${hermes.port}/api/ws?token=${hermes.token}`,
);
/* Interim payloads matter most here — record their text + the flag the
   fix keys on. */
const interims: { text: string; alreadyStreamed: unknown }[] = [];
gateway.onEvent((e: GatewayEvent) => {
  if (e.type === "gateway.ready") return;
  if (e.type === "message.interim") {
    interims.push({
      text:
        typeof e.payload.text === "string" ? (e.payload.text as string) : "",
      alreadyStreamed: e.payload.already_streamed,
    });
  }
  rec(
    "wire",
    e.type,
    `sid=${e.sessionId} ${pick(e.payload, ["text", "name", "status", "state", "already_streamed", "model", "reasoning_effort"])}`,
  );
});
out("gateway connected — recording raw wire frames");

const engine = new HermesEngine({ gateway });
const conn = connectInMemory(engine);
const engineEvents: EngineEvent[] = [];
conn.onEvent((e) => {
  engineEvents.push(e);
  rec(
    "engine",
    e.type,
    `sid=${e.sessionId} seq=${e.seq} ${pick(e.payload as Record<string, unknown>, ["stream", "delta", "stopReason", "state", "tool"])}`,
    e.seq,
  );
  /* Headless run: never let an approval ask stall the turn — answer the
     first offered "run it" outcome the wire carries. */
  if (e.type === "request.opened") {
    const p = e.payload as { requestId: string; request: { kind: string } };
    void conn
      .request("request.respond", {
        sessionId: e.sessionId,
        requestId: p.requestId,
        outcome: p.request.kind === "question" ? "answer" : "once",
        ...(p.request.kind === "question" ? { answer: "proceed" } : {}),
      })
      .then(() => rec("client", "request.respond", `requestId=${p.requestId}`));
  }
});

/* -------------------------------- run ---------------------------------- */

let { agents } = (await conn.request("agents.list")) as {
  agents: { id: string }[];
};
if (!agents[0]?.id) {
  /* An isolated HOME gives hermes a blank profile store — create one so
     the run is self-contained (profiles.create, the agents.* surface). */
  out("no hermes profile under the isolated home — creating 'lilos414'");
  await conn.request("agents.create", {
    name: "lilos414",
    description: "live-414 check profile",
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

const { sessionId } = (await conn.request("session.start", {
  agent,
  cwd: workdir,
  model,
  provider,
})) as { sessionId: string };
out(`session ${sessionId} (provider=${provider} model=${model})`);

/* The issue's reproduction task — a small coding job in a scratch folder
   so the agent naturally says something, then calls a tool. */
const prompt =
  "In the current folder, add a subtract function and a test file for it, don't commit anything.";
rec("client", "prompt", `text=${JSON.stringify(prompt)}`);
const res = (await conn.request("prompt", {
  sessionId,
  content: [{ type: "text", text: prompt }],
})) as { turnId: string; stopReason: string };
rec("client", "prompt.resolved", JSON.stringify(res));

/* Give stragglers (auto-title, post-turn frames) a beat, then dump. */
await new Promise((r) => setTimeout(r, Math.min(seconds, 5) * 1000));

console.log("\n=========== DUAL TIMELINE (wire -> engine) ===========");
for (const r of tape) {
  const seq = r.seq === undefined ? "  --" : String(r.seq).padStart(4);
  console.log(
    `+${String(r.ms).padStart(6)}ms ${r.side.padEnd(6)} seq=${seq} ${r.type} ${r.detail}`,
  );
}
console.log("======================================================\n");

/* Fold the engine log the way the thread's turn model does. */
const session = reduceSessionEvents(
  sessionId,
  engineEvents.filter((e) => e.sessionId === sessionId),
);
console.log("=========== FOLDED TURNS (client view) ===========");
for (const t of session.turns) {
  console.log(`turn ${t.turnId} phase=${t.phase}`);
  console.log(`  reasoning: ${JSON.stringify(t.reasoning)}`);
  console.log(`  text:      ${JSON.stringify(t.text)}`);
}
console.log("==================================================\n");

/* --------------------------- observations ----------------------------- */

const norm = (x: string) => x.replace(/\s+/g, " ").trim();
const count = (hay: string, needle: string) => {
  let n = 0;
  let at = 0;
  for (;;) {
    const i = hay.indexOf(needle, at);
    if (i < 0) return n;
    n++;
    at = i + needle.length;
  }
};

let ok = true;
const check = (pass: boolean, label: string) => {
  out(`${pass ? "PASS" : "FAIL"} ${label}`);
  if (!pass) ok = false;
};

const turn = session.turns.find((t) => t.turnId === res.turnId);
const folded = norm(turn?.text ?? "");
const nonempty = interims.filter((i) => norm(i.text));

check(res.stopReason === "end_turn", `turn completed (${res.stopReason})`);
check(
  nonempty.length > 0,
  `wire emitted message.interim x${nonempty.length} (the seal frame exists on this build)`,
);
for (const [i, it] of nonempty.entries()) {
  const n = count(folded, norm(it.text));
  /* The seal carries the segment's full text — it must be in the folded
     reply exactly once: streamed text for an already_streamed seal, the
     frame itself when nothing streamed. 0 = text lost; 2+ = #414. */
  check(
    n === 1,
    `interim[${i}] (already_streamed=${String(it.alreadyStreamed)}) text occurs ${n}x in folded text — want 1`,
  );
}

await conn.request("session.stop", { sessionId }).catch(() => {});
gateway.close();
await cleanup();
out(`RESULT: ${ok ? "PASS" : "FAIL (interim text duplicated in folded text)"}`);
process.exit(ok ? 0 : 1);
