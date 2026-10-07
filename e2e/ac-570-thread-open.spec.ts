import { expect, type Locator, test } from "@playwright/test";
import { growDmThread } from "./helpers/relay-thread";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #570 — opening or reloading a long thread must not mount every
 * row: a lazy thread's first mount renders an estimated-height tail and
 * starts older turns as stubs (the #430 held-stub path), so first paint
 * stays under the AC-1 task budget.
 *
 * AC-1's named leg proves the mechanism a budget rests on: an early
 * turn's text NEVER enters the DOM (a MutationObserver armed before
 * navigation sees every insert — the old mount-then-stub path inserts
 * it), the held stubs keep the scroll extent, and the pin still lands on
 * the newest turn.
 *
 * AC-2's named leg keeps the interaction contract on a stubbed thread:
 * scrolling up mounts older turns, a find chord un-stubs held text
 * (#512), and a search-hit click jumps to a held anchor (#138).
 *
 * A 60-turn engine-fake thread grown through relay RPC (#574 — the
 * browser never types them; 119 reply rows » TURN_LAZY_AFTER).
 */

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  stack = await bootStack("open570", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
    ENGINE_FAKE_TICK: "2",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

/* Turn 3's user prompt carries the probe — early enough that it always
   sits above the open tail. Turn 1 becomes the permanently-mounted
   thread ROOT (same caveat as ac-512), so the probe can't ride it. */
const EARLY_PROBE = "early-quaggmire-probe";
const MID_PROBE = "turn 30 status check";
const PROMPTS = [
  "where does the relay keep session state and how does recovery work?",
  "status check pass 2",
  `status check ${EARLY_PROBE} pass 3`,
  ...Array.from({ length: 57 }, (_, i) => `turn ${i + 4} status check`),
];

let grown: { employeeId: string; conversationId: string };
test.beforeAll(async () => {
  grown = await growDmThread(stack, PROMPTS);
});

/** Turn `i`'s card inside `scope` ended (held stubs keep the markers). */
async function waitSettled(scope: Locator, i: number) {
  const turns = scope.locator("[data-agentturn]");
  await expect
    .poll(() => turns.count(), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(i);
  await expect(turns.nth(i - 1).locator("[data-turnsettled]")).toBeAttached({
    timeout: 60_000,
  });
}

test("AC-1: opening a lazy thread mounts only the tail — older turns start as stubs", async ({
  page,
}) => {
  test.setTimeout(240_000);
  /* Armed before the FIRST paint: if the early probe's text node is ever
     inserted (the old mount-everything path), the flag flips — polling
     after settle can't catch a transient mount otherwise. */
  await page.addInitScript((probe: string) => {
    const w = window as unknown as { __earlyMounted: boolean };
    w.__earlyMounted = false;
    new MutationObserver((ms) => {
      if (w.__earlyMounted) return;
      for (const m of ms)
        for (const n of m.addedNodes)
          if (n.nodeType === 1 && n.textContent?.includes(probe)) {
            w.__earlyMounted = true;
            return;
          }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }, EARLY_PROBE);

  /* `?stubHydrateMs=` delays each born-stub's un-hold — the CI-slow
     hydration under which the open pin and the scroll-to-top leg must
     still resolve (the named slow-box knob, not a timeout bump). */
  await page.goto(
    `${stack.webUrl}/dm/${grown.employeeId}/${grown.conversationId}` +
      `?stubHydrateMs=60`,
  );
  const panel = page.locator("[data-thread-panel]");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await waitSettled(panel, 60);

  /* The early probe is a stub — its text never entered the DOM. */
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __earlyMounted: boolean }).__earlyMounted,
        ),
      { timeout: 15_000 },
    )
    .toBe(false);
  await expect(panel.getByText(EARLY_PROBE)).toHaveCount(0);

  /* Most of the 119 reply rows hold as stubs immediately — the stub set
     is the first-mount state, not a post-settle sweep. */
  await expect
    .poll(() => panel.locator("[data-held-stub]").count(), {
      timeout: 30_000,
    })
    .toBeGreaterThan(40);

  /* …and they hold the scroll extent: the pin still lands at the bottom
     on the newest turn. The read waits for the port to go STILL —
     knob-delayed hydration resolves estimate→real heights for frames
     after the last turn settles, and every commit re-pins; a one-shot
     read races that tail (CI #570's `extent.top` miss). */
  const extent = await page.evaluate(
    () =>
      new Promise<{ top: number; h: number; ch: number } | null>((resolve) => {
        const first = document.querySelector("[data-thread-panel] [data-msg]");
        let port = first?.parentElement ?? null;
        while (port && !/(auto|scroll)/.test(getComputedStyle(port).overflowY))
          port = port.parentElement;
        if (!port) return resolve(null);
        const el = port;
        let lastTop = -1;
        let lastH = -1;
        let still = 0;
        let n = 0;
        const tick = () => {
          const { scrollTop: top, scrollHeight: h, clientHeight: ch } = el;
          if (++n > 1500) return resolve({ top, h, ch });
          if (top === lastTop && h === lastH && ++still >= 10)
            return resolve({ top, h, ch });
          lastTop = top;
          lastH = h;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  if (!extent) throw new Error("no scroll port in the thread panel");
  expect(extent.h).toBeGreaterThan(extent.ch * 3);
  /* scrollTop within a row of the bottom — the pin settled on the tail. */
  expect(extent.top).toBeGreaterThan(extent.h - extent.ch - 400);
});

test("AC-2: scroll, find, and jump-to-message reach held turns on a lazy thread", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const convUrl =
    `${stack.webUrl}/dm/${grown.employeeId}/${grown.conversationId}` +
    `?stubHydrateMs=60`;
  await page.goto(convUrl);
  const panel = page.locator("[data-thread-panel]");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await waitSettled(panel, 60);
  await expect(panel.getByText(EARLY_PROBE)).toHaveCount(0);

  /* Scroll to the top — the observer mounts the born-stubbed rows and
     the early turn's text lands. */
  await page.evaluate(() => {
    const first = document.querySelector("[data-thread-panel] [data-msg]");
    let port = first?.parentElement ?? null;
    while (port && !/(auto|scroll)/.test(getComputedStyle(port).overflowY))
      port = port.parentElement;
    if (port) port.scrollTop = 0;
  });
  await expect(panel.getByText(EARLY_PROBE).first()).toBeVisible({
    timeout: 15_000,
  });

  /* Back at the bottom, a find chord mounts held rows — the mid-thread
     probe is DOM text find-in-page could match (#512). */
  await page.evaluate(() => {
    const first = document.querySelector("[data-thread-panel] [data-msg]");
    let port = first?.parentElement ?? null;
    while (port && !/(auto|scroll)/.test(getComputedStyle(port).overflowY))
      port = port.parentElement;
    if (port) port.scrollTop = port.scrollHeight;
  });
  await expect(panel.getByText(MID_PROBE)).toHaveCount(0);
  await page.keyboard.press("Control+f");
  await expect(panel.getByText(MID_PROBE).first()).toBeAttached({
    timeout: 15_000,
  });

  /* Jump-to-message: the session filter's message hits open the conv
     scrolled to the match (#138) — the hit's row is a stub until the
     scroll target keeps it mounted. */
  await page.goto(`${stack.webUrl}/dm/${grown.employeeId}`);
  const filter = page.getByPlaceholder("Filter sessions");
  await filter.fill("quaggmire");
  const hitsPanel = page.locator("[data-message-hits]");
  await expect(hitsPanel).toBeVisible({ timeout: 15_000 });
  const hit = hitsPanel.locator("[data-message-hit]").first();
  const hitId = await hit.getAttribute("data-message-hit");
  expect(hitId).toBeTruthy();
  await hit.click();
  await expect(page).toHaveURL(/\/dm\/[^/]+\/conv_[^/]+$/, {
    timeout: 10_000,
  });
  const anchor = panel.locator(`[data-msg="${hitId}"]`);
  await expect(anchor).toBeVisible({ timeout: 15_000 });
  /* The target mounted real (not a stub) and flashed. */
  await expect(anchor.locator("[data-held-stub]")).toHaveCount(0);
  await expect(anchor).toHaveClass(/amber/, { timeout: 5_000 });
  await expect(anchor).toBeInViewport();
});
