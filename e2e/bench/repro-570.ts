/**
 * Issue #570 — CI flake repro, run manually (NOT a Playwright test, no
 * fixed ports): boots its own stack on pickPorts(), grows a --turns
 * thread through relay RPC, serves the production build via `vite
 * preview`, then opens the conv URL with the named hydration knob
 * `?stubHydrateMs=` and samples the scroll port per frame for --window
 * seconds.
 *
 * Prints the sampled (scrollTop, scrollHeight) timeline and a verdict:
 * PASS when the port settles within a row of the true bottom, FAIL when
 * it strands (the e2e/ac-570 AC-1 assert's shape).
 *
 *   bun e2e/bench/repro-570.ts --hydrate 60 --cpu 4
 *   bun e2e/bench/repro-570.ts --hydrate 0 --turns 60 --window 8
 *
 * --cpu N applies CDP Emulation.setCPUThrottlingRate — it slows the
 * page's own renderer (never adds host load), modelling the CI box's
 * deferred-timeout ordering.
 */

import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { growDmThread } from "../helpers/relay-thread";
import { bootStack, freePort, pickPorts } from "../helpers/stack";

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/bench
const repo = path.resolve(here, "../..");
const webDir = path.join(repo, "apps", "web");
const viteBin = path.join(webDir, "node_modules", ".bin", "vite");

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const TURNS = Math.max(1, Number(arg("turns", "60")) || 60);
const HYDRATE_MS = arg("hydrate", "60");
const WINDOW_S = Number(arg("window", "10")) || 10;
const CPU = Number(arg("cpu", "0")) || 0;
const VIEWPORT = { width: 1288, height: 900 };

/* Default: the ac-570 spec's exact mix — all-light rows where the stub
   estimate undershoots the real height hardest (the CI strand shape).
   --heavy keeps the bench's every-5th `md: blocks` mix instead. */
const HEAVY = process.argv.includes("--heavy");
const promptFor = (i: number) =>
  !HEAVY || i % 5 === 0
    ? i === 3
      ? "turn 3 early-quaggmire-probe status check"
      : `turn ${i} status check`
    : "md: blocks";

/** Per-frame scroll geometry + pin-state sampler, injected before
    navigation. Also logs every port scroll event with the live pin
    flags so an escape shows up in the stream it killed. */
const SAMPLER = `
window.__tl = [];
window.__ev = [];
(function rec(t0) {
  const first = document.querySelector("[data-thread-panel] [data-msg]");
  let p = first && first.parentElement;
  while (p && !/(auto|scroll)/.test(getComputedStyle(p).overflowY))
    p = p.parentElement;
  if (p && !p.__wired) {
    p.__wired = true;
    p.addEventListener("scroll", () => {
      const pin = p.__pin;
      window.__ev.push({
        t: Math.round(performance.now() - t0),
        top: Math.round(p.scrollTop),
        h: p.scrollHeight,
        at: pin ? pin.state.isAtBottom : "?",
        esc: pin ? pin.state.escapedFromLock : "?",
        gesc: pin ? pin.escaped.v : "?",
        hyd: pin ? Math.round(performance.now() - pin.hydratedAt.v) : "?",
        anim: pin ? !!pin.state.animation : "?",
        rd: pin ? Math.round(pin.state.resizeDifference) : "?",
      });
    });
  }
  const pin = p && p.__pin;
  window.__tl.push({
    t: Math.round(performance.now() - t0),
    top: p ? Math.round(p.scrollTop) : -1,
    h: p ? p.scrollHeight : -1,
    ch: p ? p.clientHeight : -1,
    held: document.querySelectorAll("[data-held-stub]").length,
    at: pin ? pin.state.isAtBottom : "?",
    esc: pin ? pin.state.escapedFromLock : "?",
    gesc: pin ? pin.escaped.v : "?",
    hyd: pin ? Math.round(performance.now() - pin.hydratedAt.v) : "?",
    anim: pin ? !!pin.state.animation : "?",
    rd: pin ? Math.round(pin.state.resizeDifference) : "?",
  });
  if (window.__tl.length < ${WINDOW_S} * 90)
    requestAnimationFrame((ts) => rec(t0 ?? ts));
})();
`;

async function main() {
  const picked = await pickPorts();
  const previewPort = await freePort();
  console.log(
    `repro-570: ${TURNS} turns, stubHydrateMs=${HYDRATE_MS}, cpu x${CPU || 1}`,
  );
  console.log("building apps/web (production)…");
  execFileSync("bun", ["run", "build"], {
    cwd: webDir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const stack = await bootStack(
    "repro570",
    { relay: picked.relay, feed: picked.feed, web: picked.web },
    { ENGINE_FAKE_TICK: "2" },
  );
  try {
    const grown = await growDmThread(
      stack,
      Array.from({ length: TURNS }, (_, i) => promptFor(i + 1)),
    );
    const url = `http://127.0.0.1:${previewPort}`;
    const preview = spawn(
      viteBin,
      [
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        String(previewPort),
        "--strictPort",
      ],
      {
        cwd: webDir,
        env: {
          ...process.env,
          LILOS_RELAY_WS: stack.relayWs,
          LILOS_RELAY_TOKEN: stack.relayToken,
          LILOS_ENGINE_WS: stack.feedWs,
        },
        stdio: "inherit",
      },
    );
    try {
      for (let i = 0; ; i++) {
        const ok = await fetch(url, { signal: AbortSignal.timeout(2_000) })
          .then((r) => r.ok)
          .catch(() => false);
        if (ok) break;
        if (i > 150) throw new Error("vite preview never came up");
        await new Promise((r) => setTimeout(r, 200));
      }
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext({ viewport: VIEWPORT });
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        if (CPU > 0)
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
        await page.addInitScript(SAMPLER);
        await page.goto(
          `${url}/dm/${grown.employeeId}/${grown.conversationId}` +
            `?stubHydrateMs=${HYDRATE_MS}&pinDebug=1`,
        );
        const panel = page.locator("[data-thread-panel]");
        await expect(panel).toBeVisible({ timeout: 60_000 });
        const turns = panel.locator("[data-agentturn]");
        await expect
          .poll(() => turns.count(), { timeout: 120_000 })
          .toBeGreaterThanOrEqual(TURNS);
        await expect(
          turns.nth(TURNS - 1).locator("[data-turnsettled]"),
        ).toBeAttached({ timeout: 120_000 });
        await page.waitForTimeout(WINDOW_S * 1000);
        const { tl, ev } = await page.evaluate(() => {
          const w = window as unknown as {
            __tl: {
              t: number;
              top: number;
              h: number;
              ch: number;
              held: number;
              at: boolean | string;
              esc: boolean | string;
              anim: boolean | string;
              rd: number | string;
            }[];
            __ev: {
              t: number;
              top: number;
              h: number;
              at: boolean | string;
              esc: boolean | string;
              anim: boolean | string;
              rd: number | string;
            }[];
          };
          return { tl: w.__tl ?? [], ev: w.__ev ?? [] };
        });
        /* Scroll events — the escape suspects — with the pin flags the
           event observed. */
        console.log("scroll events:");
        let pe = "";
        for (const e of ev) {
          const key = `${e.top}|${e.at}|${e.esc}|${e.gesc}|${e.anim}`;
          if (key === pe) continue;
          pe = key;
          console.log(
            `  t=${String(e.t).padStart(5)}ms top=${String(e.top).padStart(6)} ` +
              `h=${e.h} at=${e.at} esc=${e.esc} gesc=${e.gesc} hyd=${e.hyd} anim=${e.anim} rd=${e.rd}`,
          );
        }
        /* Collapse the frame series to state transitions. */
        console.log("frames:");
        let prev = "";
        for (const s of tl) {
          const key = `${s.top}|${s.h}|${s.held}|${s.at}|${s.esc}|${s.gesc}|${s.anim}`;
          if (key === prev) continue;
          prev = key;
          console.log(
            `  t=${String(s.t).padStart(5)}ms top=${String(s.top).padStart(6)} ` +
              `h=${String(s.h).padStart(6)} ch=${s.ch} held=${s.held} ` +
              `gap=${s.h - s.top - s.ch} at=${s.at} esc=${s.esc} gesc=${s.gesc} hyd=${s.hyd} anim=${s.anim} rd=${s.rd}`,
          );
        }
        const last = tl[tl.length - 1];
        if (!last) throw new Error("sampler collected nothing");
        const stranded = last.h - last.top - last.ch;
        console.log(
          `\nfinal: top=${last.top} bottom=${last.h - last.ch} gap=${stranded} held=${last.held}`,
        );
        console.log(stranded <= 400 ? "VERDICT: PASS" : "VERDICT: FAIL");
      } finally {
        await browser.close();
      }
    } finally {
      preview.kill("SIGTERM");
      setTimeout(() => preview.kill("SIGKILL"), 3_000).unref();
    }
  } finally {
    await stack.stop();
  }
}

await main();
