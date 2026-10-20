import { expect, type Page, test } from "@playwright/test";
import { type GrownThread, growDmThread } from "./helpers/relay-thread";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
  threadUrl,
} from "./helpers/stack";

/* Issue #602 — at rest (scrolled to the bottom) the gap between the last
   message and the composer must be ≤ 24px on every chat surface.
   Regression: #536's permanent ↓-button gutter (56px port padding) stacked
   with #515's composer-height pad (112px) left a ~176px dead band under the
   thread panel and ~76px under the DM feed.
   Bounding-box assertions need a real browser — happy-dom has no layout.
   Every leg boots the dev stack on engine-fake and measures the thread's
   chat column (`[data-thread-panel]`): beside the Threads page in the side
   peek, and widened over the page as the session view.

   v3: the prototype legs (thread panel / Focus / channel feed / DM feed and
   the AC-3 card legs on the seeded reviewer DM, all `page.goto("/")` on the
   prototype dev server) are re-hosted on the real app; the channel feed and
   the DM home feed have no v3 counterpart (there is no feed page — a
   thread opens in the peek), so the band is measured on the thread
   panel's composer instead. */

const GAP_LIMIT = 24;

/* Same settle loop as ac-535: rows keep mounting after first paint and
   use-stick-to-bottom's resize="smooth" keeps re-writing scrollTop while the
   content grows — wait for the scroll extent AND scrollTop to hold at the
   bottom. */
async function settleAtBottom(
  page: Page,
  portSelector: string,
  atBottom = true,
) {
  let prev: { h: number; top: number; ch: number } | null = null;
  await expect
    .poll(async () => {
      const cur = await page.evaluate((sel) => {
        const sc = document.querySelector(sel)
          ?.firstElementChild as HTMLElement | null;
        if (!sc) throw new Error(`no scroller under ${sel}`);
        return {
          h: sc.scrollHeight,
          top: sc.scrollTop,
          ch: sc.clientHeight,
        };
      }, portSelector);
      const settled =
        cur.h > 0 &&
        prev !== null &&
        cur.h === prev.h &&
        cur.top === prev.top &&
        /* The library's lock target is scrollHeight - 1 - clientHeight and
           scrollTop is fractional — "at the bottom" is within 2px. The
           open question card parks itself differently on purpose (its
           scroll-mt-2 scroll-into-view stops ~19px short so the card end
           aligns with the scrollport) — the AC-3 legs only ask for a
           stable rest position. */
        (!atBottom || cur.top >= cur.h - cur.ch - 2);
      prev = cur;
      return settled;
    })
    .toBe(true);
}

/** One reading of the chat column's bottom band — everything the convergence
    check compares and everything a miss needs in its assertion message. */
interface GapSample {
  between: string[];
  kids: string[];
  portMB: string;
  portTf: string;
  portTfDone: boolean;
  portAnim: string;
  compTf: string;
  compTfDone: boolean;
  compAnim: string;
  parGap: string;
  parAfter: string;
  compPar: string;
  gap: number;
  portPad: number;
  scrollable: boolean;
  atBottom: boolean;
  btnMounted: boolean;
  h: number;
  ch: number;
  top: number;
  scBottom: number;
  portBottom: number;
  compTop: number;
  compMT: string;
  lastBottom: number;
  lastTop: number;
  sibBottom: number | undefined;
  sibPos: string;
  contentPadB: number;
  lastRow: string;
  lastText: string;
  trailing: number;
}
type GapMeasure = GapSample | { error: string };

/* The gap the user sees: the composer's top edge minus the bottom edge of
   the last rendered row, clipped to the scroller. The composer is the
   [data-composer] inside the port's own column (its margin-top counts as
   empty band — that's exactly what Oscar flagged). Returns enough state to
   decide convergence AND to diagnose a miss from the assertion message:
   the ↓ button's mount state (it drives the port gutter), the scroll
   target, and what the measured "last row" actually is. */
function measureGap(page: Page, portSelector: string): Promise<GapMeasure> {
  return page.evaluate((sel) => {
    const port = document.querySelector(sel);
    if (!port) return { error: `no port ${sel}` } as const;
    const sc = port.firstElementChild as HTMLElement | null;
    if (!sc) return { error: `no scroller under ${sel}` } as const;
    const scR = sc.getBoundingClientRect();
    const content = sc.firstElementChild;
    if (!content) return { error: "no content" } as const;
    const rows = [...content.children].filter(
      (el) =>
        el instanceof HTMLElement && el.getBoundingClientRect().height > 0,
    );
    const last = rows[rows.length - 1] as HTMLElement | undefined;
    if (!last) return { error: "no rows" } as const;
    const lastR = last.getBoundingClientRect();
    const lastBottom = Math.min(lastR.bottom, scR.bottom);
    const comp = port.parentElement?.querySelector("[data-composer]");
    if (!comp) return { error: "no composer under the port's column" } as const;
    const sib = content.children[content.children.length - 1];
    const sibR = sib?.getBoundingClientRect();
    /* Everything physically between the port's bottom edge and the
       composer's top: siblings rendered in the same column, each with its
       rect — the ARIA tree hides inert boxes, so a stray spacer/overlay
       only shows up here. */
    const between: string[] = [];
    const par = port.parentElement;
    if (par) {
      for (const kid of par.children) {
        if (!(kid instanceof HTMLElement)) continue;
        const r = kid.getBoundingClientRect();
        if (
          r.top >= port.getBoundingClientRect().bottom - 0.5 &&
          r.top < comp.getBoundingClientRect().top
        ) {
          between.push(
            `${kid.tagName.toLowerCase()}.${[...kid.classList].slice(0, 2).join(".")} ${r.top.toFixed(1)}-${r.bottom.toFixed(1)} h${r.height.toFixed(1)} ${getComputedStyle(kid).display}`,
          );
        }
      }
    }
    const mainAfter = par ? getComputedStyle(par, "::after") : null;
    const kids = par
      ? [...par.children].map((k) => {
          const r = k.getBoundingClientRect();
          return `${k.tagName.toLowerCase()}.${[...k.classList].slice(0, 2).join(".")} ${r.top.toFixed(1)}-${r.bottom.toFixed(1)}`;
        })
      : [];
    const compCS = getComputedStyle(comp);
    const portCS = getComputedStyle(port);
    const parCS = par ? getComputedStyle(par) : null;
    /* lilos-desktop plays lilos-rise (translateY+scale) on every non-header
       child of main at mount; until Chromium starts the animation the
       fill:both from-frame sits on the element and skews every rect. The
       poll below must see it finished, not just stable-but-warped rects. */
    const animState = (el: Element) =>
      (el as HTMLElement)
        .getAnimations?.()
        .map((a) => `${a.playState}@${Math.round(a.currentTime ?? -1)}`)
        .join(",") ?? "none";
    /* Done = no visual distortion: the computed transform is `none`, the
       identity matrix (finished fill-forwards animation serializes as
       `matrix(1, 0, 0, 1, 0, 0)`), or a zero translate alone. */
    const tfDone = (tf: string, tr: string) =>
      (tf === "none" || tf === "matrix(1, 0, 0, 1, 0, 0)") &&
      (tr === "none" || tr === "0px 0px" || tr === "0px 0px 0px");
    return {
      between,
      kids,
      portMB: portCS.marginBottom,
      portTf: `${portCS.transform}|${portCS.translate}`,
      portTfDone: tfDone(portCS.transform, portCS.translate),
      portAnim: animState(port),
      compTf: `${compCS.transform}|${compCS.translate}|top:${compCS.top}`,
      compTfDone: tfDone(compCS.transform, compCS.translate),
      compAnim: animState(comp),
      parGap: parCS
        ? `${parCS.rowGap}/${parCS.columnGap}/${parCS.justifyContent}`
        : "?",
      parAfter:
        mainAfter && mainAfter.content !== "none"
          ? `${mainAfter.content} h${mainAfter.height} disp${mainAfter.display}`
          : "none",
      compPar: comp.parentElement?.tagName.toLowerCase() ?? "?",
      gap: comp.getBoundingClientRect().top - lastBottom,
      portPad: parseFloat(getComputedStyle(port).paddingBottom),
      scrollable: sc.scrollHeight - sc.clientHeight > 8,
      atBottom: sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 2,
      btnMounted: !!port.querySelector(".lilos-scroll-btn"),
      h: sc.scrollHeight,
      ch: sc.clientHeight,
      top: sc.scrollTop,
      scBottom: scR.bottom,
      portBottom: port.getBoundingClientRect().bottom,
      compTop: comp.getBoundingClientRect().top,
      compMT: getComputedStyle(comp).marginTop,
      lastBottom: lastR.bottom,
      lastTop: lastR.top,
      sibBottom: sibR?.bottom,
      sibPos: sib ? getComputedStyle(sib).position : "",
      contentPadB: parseFloat(getComputedStyle(content).paddingBottom),
      lastRow: `${last.tagName.toLowerCase()}.${[...last.classList]
        .slice(0, 3)
        .join(".")} [${rows.length - 1}/${content.children.length}]`,
      lastText: (last.textContent ?? "").slice(0, 60),
      trailing: content.children.length - rows.length,
    };
  }, portSelector);
}

/** The AC-3 reading: the open question card against the scroller and the
    composer, plus the ↓ gutter state the convergence check waits on. */
interface CardSample {
  scBottom: number;
  cardBottom: number;
  skipBottom: number;
  compTop: number;
  portPad: number;
  btnMounted: boolean;
  top: number;
}
type CardMeasure = CardSample | { error: string };

/* One convergent measurement, not settle-then-sample: the port must hold
   the same state twice in a row with the ↓ unmounted, the gutter released
   and (unless the card parked it) the scroll at the bottom — a racing ↓
   unmount or a still-growing row can satisfy a settle loop between polls,
   but it cannot fake two identical converged samples back to back. On
   failure the last sample's full dump is in the assertion message. */
async function expectGap(page: Page, portSelector: string, atBottom = true) {
  type M = GapMeasure;
  let prev: M | null = null;
  let last: M | null = null;
  try {
    await expect
      .poll(async () => {
        const m = await measureGap(page, portSelector);
        last = m;
        const ok =
          !("error" in m) &&
          !m.btnMounted &&
          m.portPad === 0 &&
          /* the lilos-rise mount animation must have finished on both the
             port and the composer: fill:both leaves translateY+scale on
             them until it ticks, and the scale warps rects the same way
             every sample — stable ≠ done. */
          m.portTfDone &&
          m.compTfDone &&
          (!atBottom || m.atBottom) &&
          prev !== null &&
          !("error" in prev) &&
          m.gap === prev.gap &&
          m.h === prev.h &&
          m.top === prev.top;
        prev = m;
        return ok;
      })
      .toBe(true);
  } catch (e) {
    throw new Error(
      `port never reached the settled bottom state — last sample ${portSelector} ${JSON.stringify(last)}\n${e}`,
    );
  }
  const m = last as Extract<M, { gap: number }>;
  const dump = `${portSelector} ${JSON.stringify(m)}`;
  expect(
    m.gap,
    `gap between last row and composer at the bottom — ${dump}`,
  ).toBeLessThanOrEqual(GAP_LIMIT);
  expect(
    m.portPad,
    `↓ gutter must not be reserved while the button is hidden — ${dump}`,
  ).toBe(0);
}

/* The surface under test: a thread's chat column, in the side peek or
   widened into the session view — both mount the conversation inside
   `[data-thread-panel]`, so one selector measures either. */
const PORT = "[data-thread-panel] [role='log']";

/* Tall `md: table` turns (ac-431) grown over relay RPC: the at-rest band is
   only defined for a thread that scrolls, and four of them overflow the
   scroller at every viewport below. */
const FILLER = Array.from({ length: 4 }, (_, i) => `md: table — turn ${i + 1}`);

const isScrollable = (page: Page) =>
  page.evaluate((sel) => {
    const sc = document.querySelector(sel)
      ?.firstElementChild as HTMLElement | null;
    return sc ? sc.scrollHeight - sc.clientHeight > 8 : false;
  }, PORT);

test.describe("AC-1/3 real app (engine-fake stack)", () => {
  test.describe.configure({ mode: "serial" });
  let stack: Stack;
  /* One settled, scrolling thread shared by the AC-1 legs — each leg only
     re-loads it at its own viewport. */
  let grown: GrownThread;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    stack = await bootStack("gap602", await pickPorts());
    grown = await growDmThread(stack, FILLER);
  });
  test.afterAll(async () => {
    await stack?.stop();
  });

  /* A conversation at `w`x`h`: in the side peek, or — `full` — widened over
     the page as the session view. Resolves once its rows are up and the
     thread scrolls (the premise of every measurement below). */
  async function openThread(
    page: Page,
    conversationId: string,
    { w, h }: { w: number; h: number },
    full: boolean,
  ) {
    await page.setViewportSize({ width: w, height: h });
    await skipFirstRun(page);
    await page.goto(threadUrl(stack.webUrl, conversationId, full));
    await expect(page.locator(PORT).locator("[data-msg]").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(() => isScrollable(page), {
        message: "the grown thread must overflow the scroller",
      })
      .toBe(true);
  }

  /* AC-1 names 1440 and 1024 wide; 700px is the short desktop height the
     ac-535 spec also covers. The old DM-home feed (a bottom-anchored list of
     session rows) no longer exists in v3 — a thread is opened beside the
     Threads page, so the panel's own composer is what the band is measured
     against. */
  for (const { w, h } of [
    { w: 1440, h: 900 },
    { w: 1024, h: 700 },
  ]) {
    test(`AC-1 thread panel ${w}x${h}`, async ({ page }) => {
      test.setTimeout(90_000);
      await openThread(page, grown.conversationId, { w, h }, false);
      await expectGap(page, PORT);
    });

    test(`AC-1 session view ${w}x${h}`, async ({ page }) => {
      test.setTimeout(90_000);
      await openThread(page, grown.conversationId, { w, h }, true);
      await expectGap(page, PORT);
    });
  }

  test("AC-1 thread panel + session view once the session fills", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    /* A narrow+short viewport makes the new session scrollable after a
       couple of turns — enough to measure the at-bottom band. */
    await page.setViewportSize({ width: 1024, height: 600 });
    await skipFirstRun(page);
    const conversationId = await startChat(
      page,
      stack.webUrl,
      { id: "default", name: "Default" },
      "Say hello then list files",
    );
    // #577: a send lands on the peek; the session view opens only from its
    // widen button.
    await panelIntoFocus(page);
    /* Send follow-ups until the session scroller overflows (cap 6) — the
       engine-fake turn settles quickly; poll scrollHeight > clientHeight. */
    for (let i = 0; i < 6 && !(await isScrollable(page)); i++) {
      await page.waitForTimeout(1_500);
      const fbox = page.locator("[data-thread-panel] textarea").last();
      await fbox.fill(`Follow-up ${i + 1}: list three more details`);
      await fbox.press("Enter");
    }
    await expectGap(page, PORT);
    // The plain thread URL shows the same session in the side peek, mounted
    // fresh by the reload.
    await page.goto(threadUrl(stack.webUrl, conversationId));
    await page.reload();
    await expect(page).not.toHaveURL(/[#&]full=1(&|$)/);
    await expect(page.locator(PORT).locator("[data-msg]").first()).toBeVisible({
      timeout: 15_000,
    });
    await expectGap(page, PORT);
  });

  /* The question card (a 2-option ask plus free text — the shared
     QuestionCard, the tallest card the app ships) parks a turn; at a short
     viewport it reaches the scroller's bottom edge, which is exactly where
     #515 needed the padding that stacked into #602's band. The card (incl.
     its Skip row) must end above the composer AND inside the scroller — no
     clip, no overlay. The old prototype leg rode the seeded reviewer DM's
     "v3" thread; engine-fake's `question:` prompt opens the same card on
     the real app. */
  for (const { w, h } of [
    { w: 1440, h: 700 },
    { w: 1024, h: 600 },
  ]) {
    test(`AC-3 an open question card stays fully visible — thread panel ${w}x${h}`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      /* Its own thread: the ask stays open for the life of the stack, so a
         shared one would hand the next leg a card it did not open. */
      const thread = await growDmThread(stack, FILLER);
      await openThread(page, thread.conversationId, { w, h }, false);
      const box = page.locator("[data-thread-panel] textarea").last();
      await box.fill("question: pick the ship target");
      await box.press("Enter");
      const port = page.locator(PORT);
      const card = port.locator('[data-question-card][data-ask-state="open"]');
      await expect(card).toBeVisible({ timeout: 60_000 });
      await settleAtBottom(page, PORT, false);
      /* Same convergence rule as expectGap: two identical samples with the
         ↓ unmounted and the gutter released — the open card's
         scroll-into-view parks short of true bottom on purpose, so only
         stability is required, not atBottom. */
      const measure = (): Promise<CardMeasure> =>
        page.evaluate((sel) => {
          const port = document.querySelector(sel);
          if (!port) return { error: "no port" } as const;
          const sc = port.firstElementChild as HTMLElement;
          const card = port.querySelector<HTMLElement>(
            '[data-question-card][data-ask-state="open"]',
          );
          if (!card) return { error: "no open card" } as const;
          const skip = card.querySelector<HTMLElement>('button[title^="Skip"]');
          if (!skip) return { error: "no skip button" } as const;
          const comp = port.parentElement?.querySelector("[data-composer]");
          if (!comp) return { error: "no composer" } as const;
          return {
            scBottom: sc.getBoundingClientRect().bottom,
            cardBottom: card.getBoundingClientRect().bottom,
            skipBottom: skip.getBoundingClientRect().bottom,
            compTop: comp.getBoundingClientRect().top,
            portPad: parseFloat(getComputedStyle(port).paddingBottom),
            btnMounted: !!port.querySelector(".lilos-scroll-btn"),
            top: sc.scrollTop,
          };
        }, PORT);
      let prev: CardMeasure | null = null;
      let m: CardMeasure | null = null;
      await expect
        .poll(async () => {
          const cur = await measure();
          m = cur;
          const ok =
            !("error" in cur) &&
            !cur.btnMounted &&
            cur.portPad === 0 &&
            prev !== null &&
            !("error" in prev) &&
            cur.cardBottom === prev.cardBottom &&
            cur.scBottom === prev.scBottom &&
            cur.compTop === prev.compTop &&
            cur.top === prev.top;
          prev = cur;
          return ok;
        })
        .toBe(true);
      if (m === null || "error" in m) throw new Error("no sample");
      expect(
        m.cardBottom,
        "question card must end inside the scroller (not clipped)",
      ).toBeLessThanOrEqual(m.scBottom + 1);
      expect(
        m.skipBottom,
        "the card's Skip row must sit fully above the composer",
      ).toBeLessThanOrEqual(m.compTop);
      /* A live "waiting" line sits under the open card — the band check
         applies to the last rendered row, same as AC-1 (rest position
         only: the card's scroll-into-view parks short of true bottom). */
      await expectGap(page, PORT, false);
    });
  }
});
