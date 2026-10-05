import { expect, type Locator, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #512 — held (stubbed) turn rows carry no text nodes (#430), so
 * browser find-in-page can't match inside them. A find chord opens a ~10 s
 * window that mounts every held row; the window lapses and rows re-stub.
 *
 * Issue #537 — the re-stub contract is geometric, not a count: which rows
 * hold depends on where the scrollport's clip boundary sits when the
 * window lapses, and that boundary moves if anything shifts scrollTop.
 * `?findUnstubNudge=` injects a deterministic mid-window drift so the
 * spec proves the cycle preserves the reader's place instead of trusting
 * a fixed stub count.
 *
 * One 60-turn engine-fake thread (ENGINE_FAKE_TICK=2 keeps 60 sends cheap).
 * The window is driven by the `?findUnstubMs=` test hook — the spec never
 * sleeps: stubs returning is polled, not timed.
 */

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  stack = await bootStack("find512", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
    ENGINE_FAKE_TICK: "2",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

/* The named drift knob (#537): mid-window the scrollport shifts up by
   this many px, one solid row. */
const NUDGE_PX = 150;

/* First-run → land on Default's DM. `?findUnstubMs=2500` must ride the
   FIRST load — the store reads it once at module eval, so client-side
   route changes keep it. 2.5 s is long enough that slow CI polls can't
   race the lapse, short enough the re-stub leg still lands fast.
   `?findUnstubNudge=` rides too — it arms the #537 drift hook. */
async function dmDefault(page: Page) {
  await page.goto(
    `${stack.webUrl}/?findUnstubMs=2500&findUnstubNudge=${NUDGE_PX}`,
  );
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

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

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

test("AC-1: Cmd+F mounts held rows — a held row's text enters the DOM; the lapse re-bounds it", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await dmDefault(page);

  /* Turn 1 (lands in Focus) opens the conversation — its message becomes
     the thread ROOT, which the panel renders in a permanently-mounted row
     (never a lazy turn row), so the probe phrase must NOT ride it. It
     rides user turn 2 instead: a held reply row off-screen. */
  await send(
    page,
    "where does the relay keep session state and how does recovery work?",
  );
  const focus = page.locator("[data-thread]");
  await waitSettled(focus, 1);

  /* The same thread peeked open in the panel — the frame the issue
     profiled. Turns 2..60 run there. `page.goto` is a real reload — the
     store re-reads `?findUnstubMs=` on module eval, so the hook must
     ride this URL too (any prior query is stripped first). */
  await page.goto(
    `${page
      .url()
      .replace(/\/focus.*$/, "")
      .replace(/\?.*$/, "")}?findUnstubMs=2500&findUnstubNudge=${NUDGE_PX}`,
  );
  const panel = page.locator("[data-thread-panel]");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  for (let i = 2; i <= 60; i++) {
    await send(
      page,
      i === 2
        ? "status check pass 2 findprobe-alpha-turn2"
        : `status check pass ${i}`,
    );
    await waitSettled(panel, i);
  }

  /* 121 reply rows » TURN_LAZY_AFTER — far-off-screen rows hold as stubs.
     The phrase poll is the proof the probe's own row held: it exists
     nowhere in the DOM until that row mounts. */
  const stubs = panel.locator("[data-held-stub]");
  await expect
    .poll(() => stubs.count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(() => panel.getByText("findprobe-alpha-turn2").count(), {
      timeout: 30_000,
    })
    .toBe(0);

  /* #537: which rows hold is a function of where the scrollport's clip
     boundary sits — the row observer's implicit root means its 1600px
     rootMargin widens only the window bounds while the port's clip
     decides intersection, so a lazy row holds iff its box clears the
     port. The `?findUnstubNudge=` knob displaces the port mid-window, so
     the lapse's verdict is evaluated against a MOVED boundary — the
     regression a fixed `stubs >= heldBefore` count could not express. */
  const portScrollTop = () =>
    page.evaluate(() => {
      const first = document.querySelector("[data-thread-panel] [data-msg]");
      let port = first?.parentElement ?? null;
      while (port && !/(auto|scroll)/.test(getComputedStyle(port).overflowY)) {
        port = port.parentElement;
      }
      return port?.scrollTop ?? -1;
    });
  /* Lazy rows whose held flag contradicts their box vs the port rect
     (±1 px edge rows are IO-tie territory and don't count). */
  const badBoxRows = () =>
    page.evaluate(() => {
      const panelEl = document.querySelector("[data-thread-panel]");
      const first = panelEl?.querySelector("[data-msg]");
      let port = first?.parentElement ?? null;
      while (port && !/(auto|scroll)/.test(getComputedStyle(port).overflowY)) {
        port = port.parentElement;
      }
      if (!panelEl || !port) return -1;
      const pt = port.getBoundingClientRect();
      let bad = 0;
      for (const el of panelEl.querySelectorAll("[data-msg][data-lazy]")) {
        const r = el.getBoundingClientRect();
        const held = !!el.querySelector("[data-held-stub]");
        const inside = r.bottom > pt.top + 1 && r.top < pt.bottom - 1;
        const outside = r.bottom < pt.top - 1 || r.top > pt.bottom + 1;
        if ((inside && held) || (outside && !held)) bad += 1;
      }
      return bad;
    });
  /* The bottom pin's spring can still be crawling toward the port's end
     when we get here — it writes scrollTop every frame it runs, so a
     baseline read mid-flight makes the position assert nondeterministic
     (#537: the pinned scroller observed writing ~0.3 px/frame seconds
     after the last turn settled). Wait until scrollTop holds for 10
     frames — i.e. the spring terminated — before recording `before`. */
  const settledTop = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const first = document.querySelector(
            "[data-thread-panel] [data-msg]",
          );
          let port = first?.parentElement ?? null;
          while (
            port &&
            !/(auto|scroll)/.test(getComputedStyle(port).overflowY)
          )
            port = port.parentElement;
          if (!port) return resolve(-1);
          const a = port.scrollTop;
          let n = 0;
          const tick = () => {
            if (++n < 10) {
              requestAnimationFrame(tick);
              return;
            }
            resolve(port.scrollTop === a ? a : -1);
          };
          requestAnimationFrame(tick);
        }),
    );
  await expect.poll(settledTop, { timeout: 30_000 }).not.toBe(-1);
  const beforeTop = await portScrollTop();
  expect(beforeTop).toBeGreaterThan(NUDGE_PX);
  const nodesBefore = await page.evaluate(
    () => document.querySelectorAll("*").length,
  );
  /* Going in, the held set is already geometrically consistent. */
  await expect.poll(badBoxRows, { timeout: 15_000 }).toBe(0);

  /* Ctrl+F — the find chord: every held row mounts; the probe phrase is
     DOM text a find-in-page could match. */
  await page.keyboard.press("Control+f");
  await expect.poll(() => stubs.count(), { timeout: 15_000 }).toBe(0);
  await expect(panel.getByText("findprobe-alpha-turn2").first()).toBeAttached({
    timeout: 15_000,
  });
  const nodesOpen = await page.evaluate(
    () => document.querySelectorAll("*").length,
  );

  /* The window lapses (test-hooked to ~2.5 s) → off-screen rows re-stub
     and the DOM re-bounds to the geometric invariant. */
  await expect.poll(badBoxRows, { timeout: 15_000 }).toBe(0);
  const nodesClosed = await page.evaluate(
    () => document.querySelectorAll("*").length,
  );
  expect(nodesClosed).toBeLessThan(nodesOpen / 2);
  /* …and bounded by the pre-chord DOM plus a small constant for the few
     rows the moved boundary keeps mounted. */
  expect(nodesClosed).toBeLessThanOrEqual(nodesBefore + 1500);

  /* The reader's place survives the cycle whole: scrollTop is unchanged
     to ±2 px. The injected nudge is a mid-window displacement the find
     anchor must UNDO at the lapse — without it the port lands wherever
     the churn left it (#537's product bug). */
  await expect
    .poll(async () => Math.abs((await portScrollTop()) - beforeTop), {
      timeout: 15_000,
    })
    .toBeLessThanOrEqual(2);
});
