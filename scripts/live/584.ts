/**
 * Issue #584 live leg — `session.ask` (the Suggest-commit-message seam)
 * answered by a real engine-hermes through a real `hermes serve` backend:
 * the ask resolves, emits NOTHING on the real session's event stream, and
 * runs while that session's turn is in flight (AC-1 + AC-2).
 *
 *   bun scripts/live/584.ts [--seconds N]
 *
 * HOME/HERMES_HOME isolation is the caller's job (584.sh); nothing here
 * kills or touches anything it did not spawn.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Relative imports: scripts/ is not a workspace dir, so @lilos/* does not
// resolve here — each package resolves its own deps internally.
import { HermesEngine } from "../../packages/engine-hermes/src/engine";
import { HermesGateway } from "../../packages/engine-hermes/src/gateway";
import { startHermesServe } from "../../packages/engine-hermes/src/serve";
import { connectInMemory } from "../../packages/engine-hermes/src/transport";
import { cleanup, startStub } from "./lib/helpers";

const provider = process.env.HERMES_PROVIDER ?? "lilos-stub";
const model = process.env.HERMES_MODEL ?? "stub-model";
const workdir = mkdtempSync(join(tmpdir(), "lilos584-"));
const HERMES_HOME = process.env.HERMES_HOME ?? join(workdir, "hermes-home");
const repoRoot =
  process.env.LILOS_REPO_ROOT ??
  dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const HERMES_BIN = process.env.HERMES_BIN ?? "hermes";
void repoRoot;

const t0 = Date.now();
const out = (line: string) =>
  console.log(`[live-584 +${String(Date.now() - t0).padStart(5)}ms] ${line}`);

/* ------------------------------- boot --------------------------------- */

const stub = process.env.LILOS_STUB_PORT
  ? await startStub(Number(process.env.LILOS_STUB_PORT))
  : null;
if (stub) out(`openai-stub listening on :${stub.port}`);

/* LilOS's engine backend — the same startHermesServe the adapter's
   backend supervisor calls (--isolated). */
const hermes = await startHermesServe({
  bin: HERMES_BIN,
  timeoutMs: 240_000,
  env: {
    HOME: process.env.HOME ?? "",
    HERMES_HOME,
  },
});
out(`lilos engine backend ready at ${hermes.url}`);

const shutdown = async () => {
  await hermes.close();
  cleanup(workdir);
};
process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(130));
});

const gateway = await HermesGateway.connect(
  `ws://127.0.0.1:${hermes.port}/api/ws?token=${hermes.token}`,
);
out("gateway connected");

const engine = new HermesEngine({
  gateway,
  hermesHome: HERMES_HOME,
  onLog: (line) => out(`engine ${line}`),
});
engine.setGateway(gateway, { url: hermes.url, token: hermes.token });

const conn = connectInMemory(engine);
/* AC-1 evidence: every event emitted on the real session, collected. */
const sessionEvents: { type: string; seq?: number; text?: string }[] = [];
conn.onEvent((e) => {
  sessionEvents.push({
    type: e.type,
    text: JSON.stringify(e.payload ?? {}).slice(0, 300),
  });
  /* Headless run: never let an approval ask stall a turn. */
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

let ok = true;
const check = (pass: boolean, label: string) => {
  out(`${pass ? "PASS" : "FAIL"} ${label}`);
  if (!pass) ok = false;
};

const described = (await conn.request("describe")) as {
  capabilities?: { id?: string }[];
};
check(
  (described.capabilities ?? []).some((c) => c.id === "side_prompt"),
  `describe advertises side_prompt (${(described.capabilities ?? []).map((c) => c.id).join(",")})`,
);

let { agents } = (await conn.request("agents.list")) as {
  agents: { id: string }[];
};
if (!agents[0]?.id) {
  out("no hermes profile under the isolated home — creating 'lilos584'");
  await conn.request("agents.create", {
    name: "lilos584",
    description: "live-584 check profile",
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
out(`session ${sessionId}`);

/* Watermark the event stream BEFORE the ask: AC-1 is "the ask adds nothing
   to the transcript/context" — replayable events must carry none of it. */
const before = (await conn.request("events.since", {
  sessionId,
  after: 0,
})) as { latestSeq: number };
out(`events.since watermark=${before.latestSeq}`);

/* AC-2: a slow main turn in flight while the ask runs. The stub's first
   scripted entry delays its answer ~3.5s so the windows overlap for real. */
const slowPrompt = conn.request("prompt", {
  sessionId,
  content: [{ type: "text", text: "Say hello back, take your time." }],
}) as Promise<{ turnId: string; stopReason: string }>;
await new Promise((r) => setTimeout(r, 800));
const askStarted = Date.now();

const ASK_TEXT =
  "Write one conventional-commit subject line for these staged changes: modified apps/web/src/App.tsx, added packages/ui/src/workbench/commit-bar.tsx. Answer with the subject only.";
const ask = (await conn.request("session.ask", {
  sessionId,
  text: ASK_TEXT,
})) as { answer: string };
const askMs = Date.now() - askStarted;
out(`session.ask resolved in ${askMs}ms → ${JSON.stringify(ask.answer)}`);

check(ask.answer.trim().length > 0, `session.ask returned an answer`);
check(
  /^(feat|fix|chore|refactor|docs|test|build|ci|perf|style|revert)[(:]/.test(
    ask.answer.trim(),
  ),
  `answer looks like a conventional-commit subject (${JSON.stringify(ask.answer.slice(0, 80))})`,
);

const turnDone = await slowPrompt;
out(`slow prompt resolved ${JSON.stringify(turnDone)}`);

/* AC-1 (turn still overlapped when the ask landed): zero events emitted on
   the real session between the ask and now that carry the ask text or its
   answer — the throwaway's frames feed a private collector, never emitAll. */
const leaked = sessionEvents.filter(
  (e) => e.text && (e.text.includes(ASK_TEXT) || e.text.includes(ask.answer)),
);
check(
  leaked.length === 0,
  `no ask text/answer leaked into the session's emitted events (${leaked.length} leaks)`,
);

/* …and the replayable log agrees: events.since since the watermark must not
   contain the ask text or answer either (transcript/context untouched). */
const replayed = (await conn.request("events.since", {
  sessionId,
  after: 0,
})) as { events: { type: string; payload?: unknown }[]; latestSeq: number };
const replayLeaks = replayed.events.filter((e) => {
  const s = JSON.stringify(e.payload ?? "");
  return s.includes(ASK_TEXT) || s.includes(ask.answer);
});
check(
  replayLeaks.length === 0,
  `events.since replay carries nothing from the ask (${replayed.events.length} events, ${replayLeaks.length} leaks)`,
);
check(
  turnDone.stopReason === "end_turn",
  `the in-flight turn still completed (${turnDone.stopReason})`,
);

await conn.request("session.stop", { sessionId }).catch(() => {});
gateway.close();
await shutdown();
out(`RESULT: ${ok ? "PASS" : "FAIL"} (provider=${provider} model=${model})`);
process.exit(ok ? 0 : 1);
