/**
 * Issue #427 AC-1 — long-thread streaming benchmark.
 *
 * Boots its own stack via e2e/helpers/stack.ts on pickPorts()'d free
 * ports (#484: bound-and-probed, no fixed registry) plus a fourth free
 * port for the vite preview, serves a production `vite build` through
 * `vite preview` (its /lilos-config.json middleware points the built app at
 * OUR relay + feed — no reuseExistingServer, never 5199), then streams
 * `slow:2 md: blocks` replies into one DM thread.
 *
 * Per checkpoint (1/25/50/100 turns) it brackets the reply window —
 * composer Enter → the turn's data-turnsettled + a quiet frame — with CDP
 * Performance.getMetrics deltas (TaskDuration is the main-thread-busy ms the
 * issue reports; Script/Layout/Recalc split it) and a PerformanceObserver
 * longtask counter. Median over --runs trials is printed.
 *
 * Local use (allowed on Oscar's Mac — other worktrees run the suite):
 *   bun e2e/bench/long-thread.ts                 # 3 runs × 100 turns
 *   bun e2e/bench/long-thread.ts --runs 1 --turns 50
 *   bun e2e/bench/long-thread.ts --runs 1 --shots pr-assets/427/before
 *
 * Before/after protocol: run on main (or the pre-PR commit), run on the PR
 * head, diff the medians. --shots captures the 50-turn thread light + dark
 * at 1288×900 for AC-2's pixel-identical evidence. Turn 1 streams in Focus
 * (a fresh send always lands there); turns ≥2 run in the thread panel —
 * the view the issue profiled.
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
import { bootStack, freePort, pickPorts } from "../helpers/stack";

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/bench
const repo = path.resolve(here, "../..");
const webDir = path.join(repo, "apps", "web");
const viteBin = path.join(webDir, "node_modules", ".bin", "vite");

/* Resolved in main() before the first trial — pickPorts() is async and
   bound-and-probed (#484 deleted the fixed safePort registry). */
const PORTS = { relay: 0, feed: 0, web: 0, preview: 0 };
const PROMPT = "slow:2 md: blocks";
const CHECKPOINTS = [1, 25, 50, 100];
const VIEWPORT = { width: 1288, height: 900 };

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const RUNS = Math.max(1, Number(arg("runs", "3")) || 3);
const TURNS = Math.max(1, Number(arg("turns", "100")) || 100);
const SHOTS = arg("shots", ""); // dir → screenshot the 50-turn thread

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

/* Pixel determinism for --shots: every rendered time reads "10:42" —
   toLocaleTimeString on pre-PR main and the PR's cached
   Intl.DateTimeFormat.format alike. */
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

/** First-run → land on Default's DM (mirrors the specs' dmDefault). */
async function dmDefault(webUrl: string, page: Page) {
  await page.goto(`${webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  const dmBtn = page.getByRole("button", {
    name: /open dm|set up later|message/i,
  });
  if (
    await dmBtn
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await dmBtn.first().click();
  } else {
    await aside.getByRole("button", { name: /default/i }).click();
  }
  await expect(page).toHaveURL(/\/dm\//);
}

const send = async (page: Page) => {
  const box = page.locator("textarea").last();
  await box.fill(PROMPT);
  await box.press("Enter");
};

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

async function trial(shotsDir: string): Promise<Map<number, Window>> {
  const out = new Map<number, Window>();
  const stack = await bootStack("bench427", {
    relay: PORTS.relay,
    feed: PORTS.feed,
    web: PORTS.web,
  });
  try {
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
        await page.emulateMedia({ colorScheme: "light" });
        await page.addInitScript(LONGTASKS);
        if (shotsDir) await page.addInitScript(FREEZE_TIMES);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Performance.enable");
        await dmDefault(preview.url, page);

        const focus = page.locator("[data-thread]");
        let m0 = await snap(cdp, page);
        await send(page);
        await waitSettled(focus, 1);
        await quiet(page);
        out.set(1, between(m0, await snap(cdp, page)));

        /* The same thread, peeked open in the panel beside the feed — the
           layout the issue profiled. */
        const panelUrl = page.url().replace(/\/focus.*$/, "");
        await page.goto(panelUrl);
        const panel = page.locator("[data-thread-panel]");
        await expect(panel).toBeVisible({ timeout: 60_000 });

        let shot50 = false;
        for (let i = 2; i <= TURNS; i++) {
          const checkpoint = CHECKPOINTS.includes(i);
          if (checkpoint) m0 = await snap(cdp, page);
          await send(page);
          await waitSettled(panel, i);
          await quiet(page);
          if (checkpoint) {
            const w = between(m0, await snap(cdp, page));
            out.set(i, w);
            const nodes = await page.evaluate(
              () => document.querySelectorAll("*").length,
            );
            console.log(
              `    turn ${String(i).padStart(3)}: task ${w.taskMs.toFixed(0)} ms ` +
                `(script ${w.scriptMs.toFixed(0)}, layout ${w.layoutMs.toFixed(0)}, ` +
                `recalc ${w.recalcMs.toFixed(0)}) · longtasks ${w.longTasks} · ` +
                `wall ${(w.wallMs / 1000).toFixed(1)} s · ${nodes} dom nodes`,
            );
          }
          if (shotsDir && i === 50 && !shot50) {
            shot50 = true;
            await takeShots(page, shotsDir);
          }
        }
        if (shotsDir && !shot50) await takeShots(page, shotsDir);
        await context.close();
      } finally {
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

/** 1288×900 50-turn shots, light + dark — cursor parked: hover styles off. */
async function takeShots(page: Page, dir: string) {
  mkdirSync(dir, { recursive: true });
  await page.mouse.move(0, 0);
  const scrollBottom = () =>
    page.evaluate(() => {
      for (const el of document.querySelectorAll(
        "[data-thread-panel] *, [data-thread] *",
      ))
        if (el.scrollHeight > el.clientHeight + 4)
          el.scrollTop = el.scrollHeight;
    });
  /* Held rows (issue #430) remount through IntersectionObserver, which
     delivers on the rendering step after the scroll — settle a couple of
     frames so the capture sees mounted content. */
  const twoFrames = () =>
    page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
  await scrollBottom();
  await twoFrames();
  /* #430 diagnostics: held stubs + scroller extent vs the sum of row
     heights — a mismatch means held rows hold stale measurements. */
  const pane = () =>
    page.evaluate(() => {
      const scroller = [
        ...document.querySelectorAll("[data-thread-panel] *"),
      ].find((el) => el.scrollHeight > el.clientHeight + 4);
      const rows = [...document.querySelectorAll("[data-msg]")];
      const held = document.querySelectorAll("[data-held-stub]").length;
      return {
        scrollHeight: scroller?.scrollHeight,
        clientHeight: scroller?.clientHeight,
        rowSum: rows.reduce(
          (a, el) => a + el.getBoundingClientRect().height,
          0,
        ),
        msgs: rows.length,
        held,
      };
    });
  console.log("    pane:", await pane());
  /* Anchored capture: bottom-align the LAST mounted reply row (held stubs
     remount through IntersectionObserver — wait until none are held inside
     the pane's viewport). Same anchor on main and the branch → identical
     slice for the pixel diff. */
  const settleVisible = () =>
    page.waitForFunction(
      () => {
        const scroller = [
          ...document.querySelectorAll("[data-thread-panel] *"),
        ].find((el) => el.scrollHeight > el.clientHeight + 4);
        if (!scroller) return false;
        const vTop = scroller.getBoundingClientRect().top;
        const vBot = scroller.getBoundingClientRect().bottom;
        return ![...document.querySelectorAll("[data-held-stub]")].some(
          (el) => {
            const r = el.getBoundingClientRect();
            return r.bottom > vTop + 40 && r.top < vBot - 40;
          },
        );
      },
      { timeout: 15_000 },
    );
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-msg]")];
    rows[rows.length - 1]?.scrollIntoView({ block: "end" });
  });
  await settleVisible().catch(() => {});
  await twoFrames();
  console.log("    pane:", await pane());
  await page.screenshot({ path: path.join(dir, "thread-50-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await quiet(page);
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-msg]")];
    rows[rows.length - 1]?.scrollIntoView({ block: "end" });
  });
  await settleVisible().catch(() => {});
  await twoFrames();
  await page.screenshot({ path: path.join(dir, "thread-50-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  console.log(`    shots → ${dir}/thread-50-{light,dark}.png`);
}

async function main() {
  console.log(
    `bench: long-thread streaming (#427) — ${RUNS} run(s) × ${TURNS} turns, prompt "${PROMPT}"`,
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
  const checkpoints = CHECKPOINTS.filter((c) => c <= TURNS);
  console.log(`\nmedians over ${runs.length} run(s):`);
  console.log(
    "turn | task ms | script ms | layout ms | recalc ms | longtasks | wall s",
  );
  for (const c of checkpoints) {
    const col = (k: keyof Window) =>
      median(runs.map((r) => r.get(c)?.[k] ?? 0));
    console.log(
      `${String(c).padStart(4)} | ${col("taskMs").toFixed(0).padStart(7)} | ` +
        `${col("scriptMs").toFixed(0).padStart(9)} | ${col("layoutMs").toFixed(0).padStart(9)} | ` +
        `${col("recalcMs").toFixed(0).padStart(9)} | ${col("longTasks").toFixed(0).padStart(9)} | ` +
        `${(col("wallMs") / 1000).toFixed(1)}`,
    );
  }
}

await main();
