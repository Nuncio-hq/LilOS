/**
 * Issue #334 live leg — capture the REAL `hermes serve` wire frames for a
 * turn whose `reasoning.available` event carries the assistant's final
 * answer, and the engine frames that same event maps to.
 *
 *   bun scripts/live/334.ts [--seconds N]
 *
 * Spawns `hermes serve` for real (same lifecycle as the harness,
 * packages/engine-hermes/src/serve.ts) and drives one engine session at
 * the gateway layer — no relay/harness needed: the question is what the
 * GATEWAY emits vs. what the ENGINE maps it to. Two legs (STUB_SCRIPT):
 *
 *   1. plain answer "391" — the reported case: no chain-of-thought, so
 *      `_relay_thinking` relays the message text itself as
 *      `reasoning.available` (agent/turn_response_intake.py upstream);
 *   2. a `reasoning_content` delta ("thought") then an answer — the
 *      general case: a real reasoning stream followed by the summary
 *      frame, which must not append the answer onto the thought.
 *
 * Prints a dual timeline (wire frame -> engine frame) and folds the
 * engine log with reduceSessionEvents — what the Reasoning card renders.
 * Exits 1 when the folded reasoning contains the answer text (the bug).
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
const seconds = Number(arg("seconds", "45") ?? "45");
const workdir = mkdtempSync(join(tmpdir(), "lilos334-"));

const t0 = Date.now();
const out = (line: string) =>
  console.log(`[live-334 +${String(Date.now() - t0).padStart(5)}ms] ${line}`);

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
  side: "wire" | "engine";
  type: string;
  detail: string;
  seq?: number;
}
const tape: Rec[] = [];
const rec = (
  side: Rec["side"],
  type: string,
  detail: string,
  seq?: number,
) => tape.push({ ms: Date.now() - t0, side, type, detail, ...(seq ? { seq } : {}) });

const pick = (p: Record<string, unknown>, keys: string[]) => {
  const bits: string[] = [];
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v) bits.push(`${k}=${JSON.stringify(v.slice(0, 160))}`);
    else if (v !== undefined && typeof v !== "object")
      bits.push(`${k}=${JSON.stringify(v)}`);
  }
  return bits.join(" ");
};

const gateway = await HermesGateway.connect(
  `ws://127.0.0.1:${hermes.port}/api/ws?token=${hermes.token}`,
);
gateway.onEvent((e: GatewayEvent) => {
  if (e.type === "gateway.ready") return;
  rec("wire", e.type, `sid=${e.sessionId} ${pick(e.payload, ["text", "delta", "name", "status", "state", "model", "reasoning_effort"])}`);
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
    `sid=${e.sessionId} seq=${e.seq} ${pick(e.payload as Record<string, unknown>, ["stream", "delta", "text", "stopReason", "state"])}`,
    e.seq,
  );
});

/* -------------------------------- run ---------------------------------- */

const { agents } = (await conn.request("agents.list")) as {
  agents: { id: string }[];
};
const agent = agents[0]?.id;
if (!agent) throw new Error("no hermes profile available");
out(`agent=${agent}`);

const { sessionId } = (await conn.request("session.start", {
  agent,
  cwd: workdir,
  model,
  provider,
  effort: "high",
})) as { sessionId: string };
out(`session ${sessionId} (provider=${provider} model=${model} effort=high)`);

const prompts = [
  "answer plainly: what is 17 x 23",
  "think step by step then answer 17 x 23 again",
];
for (const text of prompts) {
  rec("client", "prompt", `text=${JSON.stringify(text)}`);
  const res = (await conn.request("prompt", {
    sessionId,
    content: [{ type: "text", text }],
  })) as { turnId: string; stopReason: string };
  rec("client", "prompt.resolved", JSON.stringify(res));
}

/* Give the auto-title / stragglers a beat, then dump. */
await new Promise((r) => setTimeout(r, Math.min(seconds, 5) * 1000));

console.log("\n=========== DUAL TIMELINE (wire -> engine) ===========");
for (const r of tape) {
  const seq = r.seq === undefined ? "  --" : String(r.seq).padStart(4);
  console.log(
    `+${String(r.ms).padStart(6)}ms ${r.side.padEnd(6)} seq=${seq} ${r.type} ${r.detail}`,
  );
}
console.log("======================================================\n");

/* Fold the engine log the way the Reasoning card does. */
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

const avail = tape.filter(
  (r) => r.side === "wire" && r.type === "reasoning.available",
);
/* Expected reasoning per turn = the wire's reasoning.delta stream and
   nothing else — the thought itself may mention the answer text, so a
   substring check can't tell a faithful render from the #334 tail. */
const expectedReasoning: string[] = [];
tape.forEach((r) => {
  if (r.side !== "wire") return;
  if (r.type === "turn.started" || r.type === "message.start")
    expectedReasoning.push("");
  if (r.type === "reasoning.delta") {
    const m = /text="(.*)"$/.exec(r.detail);
    if (expectedReasoning.length)
      expectedReasoning[expectedReasoning.length - 1] += JSON.parse(
        `"${m?.[1] ?? ""}"`,
      ) as string;
  }
});
const answers = session.turns
  .map((t) => t.text.trim())
  .filter((t) => t.length > 0);

let ok = true;
const check = (pass: boolean, label: string) => {
  out(`${pass ? "PASS" : "FAIL"} ${label}`);
  if (!pass) ok = false;
};

check(
  avail.length > 0,
  `wire emitted reasoning.available x${avail.length} (the summary frame exists)`,
);
check(
  session.turns.every(
    (t, i) => t.reasoning === (expectedReasoning[i] ?? ""),
  ),
  `folded reasoning === the wire's reasoning.delta stream only (${JSON.stringify(expectedReasoning)})`,
);
check(
  answers.length === prompts.length,
  `every turn still produced its answer text (${answers.length}/${prompts.length})`,
);

await conn.request("session.close", { sessionId }).catch(() => {});
gateway.close();
await cleanup();
out(`RESULT: ${ok ? "PASS" : "FAIL (answer text reached the reasoning stream)"}`);
process.exit(ok ? 0 : 1);
