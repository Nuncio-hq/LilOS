/**
 * Issue #569 AC-1 — many-sessions streaming benchmark.
 *
 * Boots its own stack via e2e/helpers/stack.ts on pickPorts()'d free
 * ports plus a fourth free port for the vite preview, serves a
 * production `vite build` through `vite preview` (its /lilos-config.json
 * middleware points the built app at OUR relay + feed), then seeds one
 * employee with N DM sessions over the relay socket — the same
 * conversations.open + messages.post calls the composer makes.
 *
 * Per checkpoint (1/10/31/51 sessions) the page reloads the DM list
 * (thread panel closed — the layout the issue profiled), then one
 * `slow:2 md: blocks` reply streams into the LAST session via
 * messages.post. The reply window — post resolves → the turn's
 * relay `turn.completed` + a quiet frame — is bracketed with CDP
 * Performance.getMetrics deltas (TaskDuration is the main-thread-busy ms
 * the issue reports; Script/Layout/Recalc split it) and a
 * PerformanceObserver longtask counter. Median over --runs trials is
 * printed.
 *
 * Local use (allowed on Oscar's Mac — other worktrees run the suite):
 *   bun e2e/bench/many-sessions.ts                    # 3 runs x 51 sessions
 *   bun e2e/bench/many-sessions.ts --runs 1 --sessions 31
 *   bun e2e/bench/many-sessions.ts --runs 1 --shots pr-assets/569/before
 *
 * Before/after protocol: run on main (or the pre-PR commit), run on the
 * PR head, diff the medians. --shots captures the 51-session DM list
 * light + dark at 1288×900 for AC-2's pixel-identical evidence.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type CDPSession, chromium, expect, type Page } from "@playwright/test";
/* e2e/ is no workspace — reach the packages by relative path (their own
   node_modules resolve their inner @lilos/* imports). */
import { RelayClient } from "../../packages/client-runtime/src/index";
import type { EngineEvent } from "../../packages/contracts/src/engine/index";
import { bootStack, freePort, pickPorts } from "../helpers/stack";

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/bench
const repo = path.resolve(here, "../..");
const webDir = path.join(repo, "apps", "web");
const viteBin = path.join(webDir, "node_modules", ".bin", "vite");

/* Resolved in main() before the first trial — pickPorts() is async and
   bound-and-probed (#484 deleted the fixed safePort registry). */
const PORTS = { relay: 0, feed: 0, web: 0, preview: 0 };
const CHECKPOINTS = [1, 10, 31, 51];
const VIEWPORT = { width: 1288, height: 900 };
const USER_ID = "user";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const RUNS = Math.max(1, Number(arg("runs", "3")) || 3);
const MAX_SESSIONS = Math.max(1, Number(arg("sessions", "51")) || 51);
const SHOTS = arg("shots", ""); // dir → screenshot the max-N DM list
const TICK = arg("tick", "2"); // engine-fake pacing for seeds + slow:2
/* The seed prompt builds a markdown answer (preview() does real work per
   row); the measured reply streams it again at slow:2. */
const SEED_PROMPT = "md: blocks";
const STREAM_PROMPT = "slow:2 md: blocks";

interface Window {
  taskMs: number;
  scriptMs: number;
  layoutMs: number;
  recalcMs: number;
  longTasks: number;
  wallMs: number;
}

const median = (xs: number[]) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;

/** Serve the built app; the lilos-config plugin points it at OUR stack. */
async function servePreview(env: Record<string, string>): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const url = `http://127.0.0.1:${PORTS.preview}`;
  const proc = spawn(
    viteBin,
    [
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(PORTS.preview),
      "--strictPort",
    ],
    { cwd: webDir, env: { ...process.env, ...env }, stdio: "inherit" },
  );
  let died = false;
  proc.once("exit", () => {
    died = true;
  });
  const start = Date.now();
  for (;;) {
    if (died)
      throw new Error(
        `vite preview died — port ${PORTS.preview} already bound?`,
      );
    const ok = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    if (Date.now() - start > 30_000)
      throw new Error(`timed out waiting for preview ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url,
    stop: () =>
      new Promise((resolve) => {
        const t = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 4_000);
        proc.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
        proc.kill("SIGTERM");
      }),
  };
}

/* Pixel determinism for --shots: every rendered time reads "10:42". */
const FREEZE_TIMES = `(() => {
  const T = "10:42";
  Date.prototype.toLocaleTimeString = () => T;
  Date.prototype.toLocaleDateString = () => "Jan 1";
  Date.prototype.toLocaleString = () => "Jan 1, 10:42";
  Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
    value: () => T,
  });
})();`;

/* Long tasks (≥50 ms) observed from document start; resets per navigation —
   windows are bounded inside one document so the reset is harmless. */
const LONGTASKS = `window.__lt = 0;
new PerformanceObserver((list) => {
  window.__lt += list.getEntries().length;
}).observe({ type: "longtask" });`;

async function cdpMetrics(cdp: CDPSession) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const get = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0;
  return {
    taskMs: get("TaskDuration") * 1000,
    scriptMs: get("ScriptDuration") * 1000,
    layoutMs: get("LayoutDuration") * 1000,
    recalcMs: get("RecalcStyleDuration") * 1000,
  };
}

const ltCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { __lt: number }).__lt);

const quiet = (page: Page) =>
  page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60))),
  );

const snap = async (cdp: CDPSession, page: Page) => ({
  ...(await cdpMetrics(cdp)),
  lt: await ltCount(page),
  t: Date.now(),
});
type Snap = Awaited<ReturnType<typeof snap>>;

const between = (a: Snap, b: Snap): Window => ({
  taskMs: b.taskMs - a.taskMs,
  scriptMs: b.scriptMs - a.scriptMs,
  layoutMs: b.layoutMs - a.layoutMs,
  recalcMs: b.recalcMs - a.recalcMs,
  longTasks: b.lt - a.lt,
  wallMs: b.t - a.t,
});

interface Bench {
  seedTo: (n: number) => Promise<void>;
  stream: (text: string) => Promise<void>;
  close: () => void;
  employeeId: string;
  convs: string[];
}

/** One employee + its DM channel; seedTo() grows the session count one
    completed turn at a time, stream() sends one message into the last
    session and resolves when its turn completes on the wire. */
async function openBench(stack: {
  relayWs: string;
  relayToken: string;
}): Promise<Bench> {
  const relay = new RelayClient({
    url: stack.relayWs,
    token: stack.relayToken,
  });
  const completed = new Map<string, () => void>();
  relay.onEvent((method, params) => {
    if (method !== "engine.event") return;
    const p = params as { conversationId?: string; event?: EngineEvent };
    if (p.event?.type !== "turn.completed") return;
    completed.get(p.conversationId ?? "")?.();
  });
  await relay.connect();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 300 && !relay.directoryReady.get(); i++) await sleep(100);
  if (!relay.directoryReady.get())
    throw new Error("relay directory never loaded");

  const waitTurn = async (conversationId: string) => {
    const done = new Promise<void>((resolve) =>
      completed.set(conversationId, resolve),
    );
    await Promise.race([
      done,
      sleep(120_000).then(() => {
        throw new Error(`turn never completed for ${conversationId}`);
      }),
    ]);
    completed.delete(conversationId);
  };

  const emp = await relay.request<{ employee: { id: string } }>(
    "employees.create",
    { name: "Bench 569", profile: "builder" },
  );
  const dm = await relay.request<{ channel: { id: string } }>(
    "channels.openDm",
    { employeeId: emp.employee.id },
  );
  const channelId = dm.channel.id;
  await relay.request("channel.subscribe", { channelId });

  const convs: string[] = [];
  return {
    employeeId: emp.employee.id,
    convs,
    async seedTo(n: number) {
      while (convs.length < n) {
        const res = await relay.request<{ conversation: { id: string } }>(
          "conversations.open",
          { channelId, authorId: USER_ID, text: SEED_PROMPT },
        );
        const id = res.conversation.id;
        convs.push(id);
        await waitTurn(id);
      }
    },
    async stream(text: string) {
      const convId = convs[convs.length - 1];
      if (!convId) throw new Error("no seeded session");
      const done = new Promise<void>((resolve) =>
        completed.set(convId, resolve),
      );
      await relay.request("messages.post", {
        channelId,
        conversationId: convId,
        authorId: USER_ID,
        authorKind: "user",
        text,
      });
      await done;
      completed.delete(convId);
    },
    close: () => relay.close(),
  };
}

async function trial(shotsDir: string): Promise<Map<number, Window>> {
  const out = new Map<number, Window>();
  const stack = await bootStack(
    "bench569",
    {
      relay: PORTS.relay,
      feed: PORTS.feed,
      web: PORTS.web,
    },
    {
      LILOS_USER_NAME: "Oscar",
      ENGINE_FAKE_TICK: TICK,
    },
  );
  try {
    const preview = await servePreview({
      LILOS_RELAY_WS: stack.relayWs,
      LILOS_RELAY_TOKEN: stack.relayToken,
      LILOS_ENGINE_WS: stack.feedWs,
    });
    try {
      const bench = await openBench(stack);
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext({ viewport: VIEWPORT });
        const page = await context.newPage();
        await page.emulateMedia({ colorScheme: "light" });
        await page.addInitScript(LONGTASKS);
        if (shotsDir) await page.addInitScript(FREEZE_TIMES);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Performance.enable");

        for (const n of CHECKPOINTS.filter((c) => c <= MAX_SESSIONS)) {
          /* Grow the employee's DM to N sessions, then reload so each
             measurement opens a clean list (the fold caches re-seed off
             the relay rows, like a real page load). */
          await bench.seedTo(n);
          await page.goto(`${preview.url}/dm/${bench.employeeId}`);
          const rows = page.locator("[data-session]");
          await expect.poll(() => rows.count(), { timeout: 60_000 }).toBe(n);
          const m0 = await snap(cdp, page);
          await bench.stream(STREAM_PROMPT);
          await quiet(page);
          const w = between(m0, await snap(cdp, page));
          out.set(n, w);
          const nodes = await page.evaluate(
            () => document.querySelectorAll("*").length,
          );
          console.log(
            `    sessions ${String(n).padStart(3)}: task ${w.taskMs.toFixed(0)} ms ` +
              `(script ${w.scriptMs.toFixed(0)}, layout ${w.layoutMs.toFixed(0)}, ` +
              `recalc ${w.recalcMs.toFixed(0)}) · longtasks ${w.longTasks} · ` +
              `wall ${(w.wallMs / 1000).toFixed(1)} s · ${nodes} dom nodes`,
          );
        }
        if (shotsDir) await takeShots(page, shotsDir);
        await context.close();
      } finally {
        bench.close();
        await browser.close();
      }
    } finally {
      await preview.stop();
    }
  } finally {
    await stack.stop();
  }
  return out;
}

/** 1288×900 DM-list shots, light + dark — the AC-2 "unchanged" evidence.
   The list's stick-to-bottom can lag the last delta by a frame, so pin
   the scroller to the end before capturing (same anchor on both legs →
   identical slice for the pixel diff). */
async function takeShots(page: Page, dir: string) {
  mkdirSync(dir, { recursive: true });
  await page.mouse.move(0, 0);
  const scrollBottom = () =>
    page.evaluate(() => {
      for (const el of document.querySelectorAll("main *"))
        if (el.scrollHeight > el.clientHeight + 4)
          el.scrollTop = el.scrollHeight;
    });
  const twoFrames = () =>
    page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
  await scrollBottom();
  await twoFrames();
  await scrollBottom();
  await twoFrames();
  await page.screenshot({ path: path.join(dir, "dm-list-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await quiet(page);
  await page.screenshot({ path: path.join(dir, "dm-list-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  console.log(`    shots → ${dir}/dm-list-{light,dark}.png`);
}

async function main() {
  console.log(
    `bench: many-sessions streaming (#569) — ${RUNS} run(s) × ${MAX_SESSIONS} sessions, prompt "${STREAM_PROMPT}"`,
  );
  const picked = await pickPorts();
  PORTS.relay = picked.relay;
  PORTS.feed = picked.feed;
  PORTS.web = picked.web;
  PORTS.preview = await freePort();
  console.log(`building apps/web (production)…`);
  execFileSync("bun", ["run", "build"], {
    cwd: webDir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const runs: Map<number, Window>[] = [];
  for (let r = 1; r <= RUNS; r++) {
    console.log(`  run ${r}/${RUNS}`);
    runs.push(await trial(SHOTS && r === 1 ? SHOTS : ""));
  }
  const checkpoints = CHECKPOINTS.filter((c) => c <= MAX_SESSIONS);
  console.log(`\nmedians over ${runs.length} run(s):`);
  console.log(
    "sessions | task ms | script ms | layout ms | recalc ms | longtasks | wall s",
  );
  for (const c of checkpoints) {
    const col = (k: keyof Window) =>
      median(runs.map((r) => r.get(c)?.[k] ?? 0));
    console.log(
      `${String(c).padStart(8)} | ${col("taskMs").toFixed(0).padStart(7)} | ` +
        `${col("scriptMs").toFixed(0).padStart(9)} | ${col("layoutMs").toFixed(0).padStart(9)} | ` +
        `${col("recalcMs").toFixed(0).padStart(9)} | ${col("longTasks").toFixed(0).padStart(9)} | ` +
        `${(col("wallMs") / 1000).toFixed(1)}`,
    );
  }
}

await main();
