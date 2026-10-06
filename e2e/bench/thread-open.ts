/**
 * Issue #570 AC-1 — long-thread open/reload benchmark.
 *
 * The streaming bench (long-thread.ts, #427) brackets composer-send →
 * turn-settled windows; this one brackets what the issue profiled — the
 * thread panel's FIRST mount. It grows a settled --turns thread through
 * relay RPC (growDmThread, #574 — seconds, no browser sends) against its
 * own pickPorts()'d stack, serves a production `vite build` through
 * `vite preview` (its /lilos-config.json middleware points the built app
 * at OUR relay + feed — no reuseExistingServer, never 5199), then per
 * trial measures two windows:
 *
 *   open   — DM feed → click the "N replies" chip → panel's last turn
 *            settles + a quiet frame (the in-app open the issue timed at
 *            ~370 ms of main-thread work at 200 turns);
 *   reload — page.reload() on the conv URL → same settle (321–449 ms).
 *
 * CDP Performance.getMetrics deltas give the Task/Script/Layout/Recalc
 * split; a PerformanceObserver longtask collector (max duration, count)
 * is the AC's "longest task < 100 ms" number. Median over --runs.
 *
 * Local use (allowed on Oscar's Mac — other worktrees run the suite):
 *   bun e2e/bench/thread-open.ts                  # 3 runs × 200 turns
 *   bun e2e/bench/thread-open.ts --runs 1 --turns 60
 *
 * Before/after protocol: run on main (or the pre-PR commit), run on the
 * PR head, diff the medians. ENGINE_FAKE_TICK=1 keeps the grow phase
 * minutes-scale instead of an hour — pacing is not what's measured.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CDPSession,
  chromium,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { growDmThread } from "../helpers/relay-thread";
import { bootStack, freePort, pickPorts } from "../helpers/stack";

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/bench
const repo = path.resolve(here, "../..");
const webDir = path.join(repo, "apps", "web");
const viteBin = path.join(webDir, "node_modules", ".bin", "vite");

/* Resolved in main() before the first trial — pickPorts() is async and
   bound-and-probed (#484 deleted the fixed safePort registry). */
const PORTS = { relay: 0, feed: 0, web: 0, preview: 0 };
const VIEWPORT = { width: 1288, height: 900 };

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const RUNS = Math.max(1, Number(arg("runs", "3")) || 3);
const TURNS = Math.max(1, Number(arg("turns", "200")) || 200);
const SHOTS = arg("shots", ""); // dir → screenshot the opened thread

/* A realistic column: every 5th turn the heavy markdown fixture (fences +
   highlight + table — the DOM weight the lazy threshold exists for), the
   rest short text prompts minting the generic reply — cheap to grow at
   tick=1, still a real row to mount. ~40 heavy + ~160 light rows lands in
   the 10–15k-element range the issue profiled. */
const promptFor = (i: number) =>
  i % 5 === 0 ? "md: blocks" : `turn ${i} status check`;

interface Window {
  taskMs: number;
  scriptMs: number;
  layoutMs: number;
  recalcMs: number;
  longestTaskMs: number;
  longTasks: number;
  wallMs: number;
  domNodes: number;
  heldStubs: number;
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
    if (Date.now() - start > 30_000) {
      proc.kill("SIGKILL");
      throw new Error(`timed out waiting for preview ${url}`);
    }
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

/* Long tasks (≥50 ms) from document start: count + worst duration. Resets
   per navigation — each measured window starts at one. */
const LONGTASKS = `window.__lt = { n: 0, max: 0 };
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    window.__lt.n += 1;
    window.__lt.max = Math.max(window.__lt.max, e.duration);
  }
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

const ltStats = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __lt: { n: number; max: number } }).__lt ?? {
        n: 0,
        max: 0,
      },
  );

/** Turn `i`'s card inside `scope` ended (text lands earlier — footer waits). */
async function waitSettled(scope: Locator, i: number) {
  const turns = scope.locator("[data-agentturn]");
  await expect
    .poll(() => turns.count(), { timeout: 120_000 })
    .toBeGreaterThanOrEqual(i);
  await expect(turns.nth(i - 1).locator("[data-turnsettled]")).toBeAttached({
    timeout: 120_000,
  });
}

const quiet = (page: Page) =>
  page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60))),
  );

const domStats = (page: Page) =>
  page.evaluate(() => ({
    nodes: document.querySelectorAll("*").length,
    msgs: document.querySelectorAll("[data-msg]").length,
    held: document.querySelectorAll("[data-held-stub]").length,
  }));

async function snap(cdp: CDPSession, page: Page) {
  return {
    ...(await cdpMetrics(cdp)),
    lt: await ltStats(page),
    t: Date.now(),
  };
}
type Snap = Awaited<ReturnType<typeof snap>>;

async function windowBetween(page: Page, a: Snap, b: Snap): Promise<Window> {
  const dom = await domStats(page);
  return {
    /* CDP Performance counters reset on navigation (verified: reload
       zeroes the per-renderer accumulators). A leg that crosses a nav
       reads the post-nav snapshot as absolute — pass a zeroed `a`. */
    taskMs: b.taskMs - a.taskMs,
    scriptMs: b.scriptMs - a.scriptMs,
    layoutMs: b.layoutMs - a.layoutMs,
    recalcMs: b.recalcMs - a.recalcMs,
    /* __lt is an init script — it re-arms per document. The open leg
       zeroes it before the click; the reload leg's post-nav b.lt covers
       just that document's window. */
    longestTaskMs: b.lt.max,
    longTasks: b.lt.n,
    wallMs: b.t - a.t,
    domNodes: dom.nodes,
    heldStubs: dom.held,
  };
}

async function trial(shotsDir = ""): Promise<{ open: Window; reload: Window }> {
  const stack = await bootStack(
    "bench570",
    { relay: PORTS.relay, feed: PORTS.feed, web: PORTS.web },
    { ENGINE_FAKE_TICK: "1" },
  );
  try {
    /* Grow before the browser launches — send time isn't measured. */
    const grown = await growDmThread(
      stack,
      Array.from({ length: TURNS }, (_, i) => promptFor(i + 1)),
    );
    const preview = await servePreview({
      LILOS_RELAY_WS: stack.relayWs,
      LILOS_RELAY_TOKEN: stack.relayToken,
      LILOS_ENGINE_WS: stack.feedWs,
    });
    try {
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext({ viewport: VIEWPORT });
        const page = await context.newPage();
        await page.addInitScript(LONGTASKS);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Performance.enable");
        const panel = page.locator("[data-thread-panel]");

        /* Leg 1 — open: the feed's "N replies" chip mounts the panel. */
        await page.goto(`${preview.url}/dm/${grown.employeeId}`);
        const chip = page.getByRole("button", { name: /replies/ });
        await expect(chip).toBeVisible({ timeout: 60_000 });
        await page.evaluate(() => {
          (window as unknown as { __lt: { n: number; max: number } }).__lt = {
            n: 0,
            max: 0,
          };
        });
        const m0 = await snap(cdp, page);
        await chip.click();
        await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/);
        await waitSettled(panel, TURNS);
        await quiet(page);
        const open = await windowBetween(page, m0, await snap(cdp, page));

        /* Leg 2 — reload: full document restart on the conv URL. The CDP
           counters reset at the navigation, so the post-reload snapshot
           reads as this leg's absolute cost. */
        const t0 = Date.now();
        await page.reload();
        await expect(panel).toBeVisible({ timeout: 60_000 });
        await waitSettled(panel, TURNS);
        await quiet(page);
        const reload = await windowBetween(
          page,
          {
            taskMs: 0,
            scriptMs: 0,
            layoutMs: 0,
            recalcMs: 0,
            lt: { n: 0, max: 0 },
            t: t0,
          },
          await snap(cdp, page),
        );

        if (shotsDir) {
          mkdirSync(shotsDir, { recursive: true });
          /* Open state: bottom-pinned tail, everything above held. Wait
             for the instant pin to land so the shot isn't the blank
             stub field at scrollTop 0. */
          const portMetrics = () =>
            page.evaluate(() => {
              const first = document.querySelector(
                "[data-thread-panel] [data-msg]",
              );
              let p = first?.parentElement ?? null;
              while (p && !/(auto|scroll)/.test(getComputedStyle(p).overflowY))
                p = p.parentElement;
              return p
                ? {
                    top: Math.round(p.scrollTop),
                    h: p.scrollHeight,
                    ch: p.clientHeight,
                  }
                : null;
            });
          try {
            await page.waitForFunction(
              () => {
                const first = document.querySelector(
                  "[data-thread-panel] [data-msg]",
                );
                let p = first?.parentElement ?? null;
                while (
                  p &&
                  !/(auto|scroll)/.test(getComputedStyle(p).overflowY)
                )
                  p = p.parentElement;
                return (
                  !!p && p.scrollTop + p.clientHeight >= p.scrollHeight - 8
                );
              },
              undefined,
              { timeout: 10_000 },
            );
          } catch {
            console.log("  shots: bottom pin never landed");
          }
          console.log("  shots: port at open:", await portMetrics());
          await page.screenshot({
            path: path.join(shotsDir, "open-bottom.png"),
          });
          /* Scrolled mid-thread: born-stubbed rows mounted in view. */
          await page.evaluate(() => {
            const first = document.querySelector(
              "[data-thread-panel] [data-msg]",
            );
            let port = first?.parentElement ?? null;
            while (
              port &&
              !/(auto|scroll)/.test(getComputedStyle(port).overflowY)
            )
              port = port.parentElement;
            if (port) port.scrollTop = Math.floor(port.scrollHeight * 0.45);
          });
          /* IO mounts land on the next frames — settle a couple. */
          await page.evaluate(
            () =>
              new Promise<void>((r) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => setTimeout(r, 80)),
                ),
              ),
          );
          await page.screenshot({
            path: path.join(shotsDir, "scrolled-mid.png"),
          });
        }

        await context.close();
        return { open, reload };
      } finally {
        await browser.close();
      }
    } finally {
      await preview.stop();
    }
  } finally {
    await stack.stop();
  }
}

const fmt = (w: Window) =>
  `task ${w.taskMs.toFixed(0)} ms (script ${w.scriptMs.toFixed(0)}, ` +
  `layout ${w.layoutMs.toFixed(0)}, recalc ${w.recalcMs.toFixed(0)}) · ` +
  `longest ${w.longestTaskMs.toFixed(0)} ms · longtasks ${w.longTasks} · ` +
  `wall ${(w.wallMs / 1000).toFixed(1)} s · ${w.domNodes} dom nodes · ` +
  `${w.heldStubs} held stubs`;

async function main() {
  console.log(
    `bench: long-thread open/reload (#570) — ${RUNS} run(s) × ${TURNS} turns`,
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
  const opens: Window[] = [];
  const reloads: Window[] = [];
  for (let r = 1; r <= RUNS; r++) {
    console.log(`  run ${r}/${RUNS}`);
    const w = await trial(SHOTS && r === 1 ? SHOTS : "");
    opens.push(w.open);
    reloads.push(w.reload);
    console.log(`    open:   ${fmt(w.open)}`);
    console.log(`    reload: ${fmt(w.reload)}`);
  }
  const col = (ws: Window[], k: keyof Window) => median(ws.map((w) => w[k]));
  console.log(`\nmedians over ${RUNS} run(s) — AC-1: longest task < 100 ms`);
  console.log(
    "leg    | task ms | script | layout | recalc | longest ms | tasks | wall s | dom | held",
  );
  for (const [leg, ws] of [
    ["open", opens],
    ["reload", reloads],
  ] as const) {
    console.log(
      `${leg.padEnd(6)} | ${col(ws, "taskMs").toFixed(0).padStart(7)} | ` +
        `${col(ws, "scriptMs").toFixed(0).padStart(6)} | ` +
        `${col(ws, "layoutMs").toFixed(0).padStart(6)} | ` +
        `${col(ws, "recalcMs").toFixed(0).padStart(6)} | ` +
        `${col(ws, "longestTaskMs").toFixed(0).padStart(10)} | ` +
        `${col(ws, "longTasks").toFixed(0).padStart(5)} | ` +
        `${(col(ws, "wallMs") / 1000).toFixed(1).padStart(6)} | ` +
        `${col(ws, "domNodes").toFixed(0).padStart(5)} | ` +
        `${col(ws, "heldStubs").toFixed(0)}`,
    );
  }
}

await main();
