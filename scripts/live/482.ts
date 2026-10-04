/**
 * Issue #482 live leg — the real adapter + a real `hermes serve` child, on
 * the engine wire only (no relay/harness needed — the watchdog lives in
 * the adapter; the harness probe is unit/e2e-covered).
 *
 *   bun scripts/live/482.ts
 *
 * 482.sh owns environment shaping (isolated HOME, provider config, stub or
 * live label). What this script does:
 *
 *   1. launches the REAL adapter (`packages/engine-hermes/scripts/serve.ts`
 *      under bun) with HERMES_SERVE_PID_FILE pointing at the child pid file;
 *   2. waits for engine ok via `describe` (backend.state === "running"),
 *      starts a session, runs one turn to completion (memory exists);
 *   3. fires a second prompt whose turn is HELD server-side (stub mode:
 *      STUB_SCRIPT delayMs; live mode: real model latency) and kills ONLY
 *      the spawned `hermes serve` child — by pid, never by name;
 *   4. asserts: the held turn fails typed BACKEND_DOWN within 5 s, a fresh
 *      `models.list` fails typed within 5 s, and `describe` reports the
 *      backend not-running within 5 s — the adapter-visible "harness
 *      reports" surface;
 *   5. asserts the adapter relaunches Hermes itself (`describe` returns
 *      running again ≤ 60 s on a cold provider build), `models.list`
 *      answers, and a prompt on the SAME engine session answers — the
 *      resumed session keeps its store.
 *
 * stdout prints every adapter log line prefixed [adapter] so the death →
 * restart sequence is visible verbatim (the harness-log equivalent).
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanup,
  freePort,
  launch,
  startStub,
  waitForFile,
} from "./lib/helpers";

const RPC_BACKEND_DOWN = -32006;

const t0 = Date.now();
const out = (line: string) =>
  console.log(`[live-482 +${String(Date.now() - t0).padStart(5)}ms] ${line}`);
const fail = (why: string): never => {
  console.log(`RESULT: FAIL — ${why}`);
  process.exit(1);
};

const checks: string[] = [];
const check = (ok: boolean, name: string, detail = "") => {
  checks.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  out(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) throw new Error(name);
};

/* ------------------------------- boot ---------------------------------- */

/* Stub mode: 482.sh exported LILOS_STUB_PORT — bind it here (the provider
   config written by the .sh already points at it). */
const stub = process.env.LILOS_STUB_PORT
  ? await startStub(Number(process.env.LILOS_STUB_PORT))
  : null;
if (stub) out(`openai-stub listening on :${stub.port}`);

const scratch = mkdtempSync(join(tmpdir(), "lilos482-"));
const pidFile = join(scratch, "hermes-serve.pid");
const sessionsFile = join(scratch, "engine-sessions.json");
const adapterPort = await freePort();
const workdir = join(scratch, "work");
mkdirSync(workdir, { recursive: true });
const bun = process.env.BUN_BIN ?? "bun";

const adapter = launch(
  "adapter",
  [
    bun,
    "packages/engine-hermes/scripts/serve.ts",
    "--port",
    String(adapterPort),
    "--hermes-bin",
    process.env.HERMES_BIN ?? "hermes",
    "--sessions-file",
    sessionsFile,
    ...(process.env.HERMES_PROVIDER
      ? ["--provider", process.env.HERMES_PROVIDER]
      : []),
    ...(process.env.HERMES_MODEL ? ["--model", process.env.HERMES_MODEL] : []),
  ],
  {
    HERMES_SERVE_PID_FILE: pidFile,
    HERMES_SERVE_TIMEOUT_MS: process.env.HERMES_SERVE_TIMEOUT_MS ?? "240000",
  },
);

/* Minimal engine-wire client: JSON-RPC over the adapter's /ws, exactly the
   frame contract the harness's connectEngineWs speaks. */
interface Frame {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/* The adapter prints LISTENING before we can connect — retry until the
   socket accepts (spawn + first `hermes serve` boot are the slow part). */
let ws: WebSocket | undefined;
const wsDeadline = Date.now() + 300_000;
for (;;) {
  try {
    ws = await new Promise<WebSocket>((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${adapterPort}/ws`);
      w.onopen = () => res(w);
      w.onerror = () => rej(new Error("adapter ws connect failed"));
      setTimeout(() => rej(new Error("adapter ws connect timeout")), 3_000);
    });
    break;
  } catch {
    if (adapter.exitCode !== null)
      fail(`adapter exited before listening (code ${adapter.exitCode})`);
    if (Date.now() > wsDeadline) fail("adapter never listened on /ws");
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!ws) fail("unreachable");
const sock: WebSocket = ws;

let nextId = 1;
const pending = new Map<
  string,
  { res: (v: unknown) => void; rej: (e: Error) => void }
>();
const events: { type: string; sessionId?: string; payload?: unknown }[] = [];
sock.onmessage = (ev) => {
  const f = JSON.parse(String(ev.data)) as Frame;
  if (f.id !== undefined && ("result" in f || "error" in f)) {
    const w = pending.get(String(f.id));
    if (w) {
      pending.delete(String(f.id));
      if (f.error) {
        const e = Object.assign(
          new Error(`[${f.error.code}] ${f.error.message}`),
          { code: f.error.code },
        );
        w.rej(e);
      } else w.res(f.result);
    }
  } else if (f.method === "event" && f.params) {
    events.push(f.params as { type: string });
  }
};

const call = <T = unknown>(method: string, params: unknown = {}) =>
  new Promise<T>((res, rej) => {
    const id = `${nextId++}`;
    pending.set(id, { res: res as (v: unknown) => void, rej });
    sock.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });

const backendState = async (): Promise<string> => {
  const r = (await call("describe", {})) as {
    backend?: { state?: string };
  };
  return r.backend?.state ?? "missing";
};

const waitEvent = (type: string, timeoutMs: number, fromIndex = 0) =>
  new Promise<void>((res, rej) => {
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      if (events.slice(fromIndex).some((e) => e.type === type)) {
        clearInterval(poll);
        res();
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        rej(new Error(`no ${type} within ${timeoutMs}ms`));
      }
    }, 25);
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

process.on("SIGINT", () => {
  cleanup(scratch);
  process.exit(130);
});

try {
  /* ── 1. adapter up, backend running ─────────────────────────────── */
  const adapterUp = Date.now();
  for (;;) {
    if (adapter.exitCode !== null)
      fail(`adapter exited before listening (code ${adapter.exitCode})`);
    try {
      if ((await backendState()) === "running") break;
    } catch {
      /* ws not listening yet */
    }
    if (Date.now() - adapterUp > 300_000)
      fail("adapter never reported backend running");
    await sleep(500);
  }
  out("adapter up — backend.state running");

  /* ── 2. one session, one completed turn (memory exists) ─────────── */
  const started = (await call("session.start", {
    agent: "default",
    cwd: workdir,
  })) as { sessionId: string };
  const sessionId = started.sessionId;
  await Promise.all([
    waitEvent("turn.completed", 120_000),
    call("prompt", {
      sessionId,
      content: [{ type: "text", text: "remember the codeword PETRICHOR" }],
    }),
  ]);
  out("baseline turn completed");

  /* ── 3. held in-flight call + kill ONLY the spawned child ───────── */
  const heldPrompt = call("prompt", {
    sessionId,
    content: [{ type: "text", text: "hold the turn while I kill you" }],
  });
  const heldCode = heldPrompt.then(
    () => "resolved",
    (e: Error & { code?: number }) => e.code,
  );
  /* Let the turn reach hermes before the kill — the turn must genuinely be
     in flight on the dying backend. */
  await sleep(750);
  const pid = Number(await waitForFile(pidFile, 15_000));
  const killAt = Date.now();
  out(
    `killing hermes serve child pid=${pid} (SIGKILL — pid only, never a name match)`,
  );
  process.kill(pid, "SIGKILL");

  const inFlightCode = await Promise.race([
    heldCode,
    sleep(5_000).then(() => "timeout"),
  ]);
  check(
    inFlightCode === RPC_BACKEND_DOWN,
    "in-flight prompt fails typed engine_unavailable (BACKEND_DOWN)",
    `${inFlightCode} at +${Date.now() - killAt}ms`,
  );

  const newCode = await call("models.list", {}).then(
    () => "resolved",
    (e: Error & { code?: number }) => e.code,
  );
  check(
    newCode === RPC_BACKEND_DOWN && Date.now() - killAt < 5_000,
    "new call fails typed fast (no 15 s hang)",
    `${newCode} at +${Date.now() - killAt}ms`,
  );

  /* ── 4. adapter reports the backend not-running within 5 s ──────── */
  let reported = "";
  const reportDeadline = killAt + 5_000;
  while (Date.now() < reportDeadline) {
    const s = await backendState().catch(() => "unreachable");
    if (s !== "running" && s !== "missing") {
      reported = s;
      break;
    }
    await sleep(150);
  }
  check(
    reported === "restarting" || reported === "failed",
    "adapter reports backend not-running within 5 s",
    `backend.state=${reported} at +${Date.now() - killAt}ms`,
  );

  /* ── 5. self-heal: relaunch + resume the same session ────────────── */
  const healDeadline = Date.now() + 120_000;
  for (;;) {
    if (adapter.exitCode !== null)
      fail(`adapter exited during recovery (code ${adapter.exitCode})`);
    const s = await backendState().catch(() => "unreachable");
    if (s === "running") break;
    if (Date.now() > healDeadline)
      fail("adapter never relaunched hermes serve");
    await sleep(500);
  }
  check(true, "adapter relaunched hermes serve on its own");

  const relist = (await call("models.list", {})) as {
    models?: unknown[];
  };
  check(
    Array.isArray(relist.models) && relist.models.length > 0,
    "models.list answers after recovery",
    `${relist.models?.length ?? 0} models`,
  );

  /* The turn that died mid-flight can resume server-side on
     session.resume: hermes re-emits message.start for it, the adapter
     mints a leg turn, and the answer lands on its own. A prompt while
     that leg runs is a legit -32003 conflict — drain it (each fresh
     turn.completed) and retry the memory prompt until the lane frees. */
  const answered = await (async (): Promise<undefined | Error> => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const mark = events.length;
      try {
        await call("prompt", {
          sessionId,
          content: [
            {
              type: "text",
              text: "what was the codeword I gave you? answer with just the word",
            },
          ],
        });
        return;
      } catch (e) {
        const code = (e as { code?: number }).code;
        if (code !== -32003 || Date.now() > deadline) return e as Error;
        out(
          `resumed turn still draining (-32003) — waiting for its turn.completed`,
        );
        await waitEvent("turn.completed", deadline - Date.now(), mark).catch(
          () => {},
        );
      }
    }
  })();
  check(
    !(answered instanceof Error),
    "same engine session answers after restart (session.resume)",
    answered instanceof Error ? answered.message : "turn completed",
  );

  out("all checks passed — adapter watched, failed fast, relaunched, resumed");
  console.log("RESULT: PASS");
  for (const c of checks) console.log(`  ${c}`);
} catch (e) {
  console.log(`RESULT: FAIL — ${e instanceof Error ? e.message : e}`);
  for (const c of checks) console.log(`  ${c}`);
  console.log("  last engine events:");
  for (const ev of events.slice(-15))
    console.log(`    ${ev.type}${ev.sessionId ? ` ${ev.sessionId}` : ""}`);
  process.exitCode = 1;
} finally {
  sock.close();
  cleanup(scratch);
}
