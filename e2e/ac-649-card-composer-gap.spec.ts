import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { growDmThread } from "./helpers/relay-thread";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
  skipFirstRun,
  threadUrl,
  v3Peek,
} from "./helpers/stack";

/* Issue #649 — when a decision card (approval ask, question ask, plan) is
   the last conversation row, its bottom edge must rest ≥12px above the
   composer: border, padding and rounded corners fully inside the scroller.
   Two failure shapes fed the bug: the bottom lock parks 1px short of the
   scroller's end (a ~12px content pad rests at ~11px), and a layout nudge
   while the lock chases stream growth kills the pin entirely, parking the
   card under the composer.
   Every leg rides the engine-fake dev stack on a real session grown
   scrollable first — the approval, plan and question cards (engine-fake's
   `question:` prompt, #553, replaced the prototype's seeded "v3" thread the
   question leg used to ride). Each surface is the v3 thread panel: the peek
   beside Threads, and the same panel widened into the session view. Every
   leg measures card-bottom → composer-top on the three desktop sizes ×
   light+dark and keeps a screenshot. */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-649");

const GAP_MIN = 12;

/* 1440x700 joins the matrix: the ac-602 AC-3 panel leg failed there on the
   first cut (a uniform pb-5 decision-card pad pushed the panel's at-rest
   band past #602's 24px — the panel's composer margin already supplies the
   clearance) — keep that frame covered. */
const VIEWPORTS = [
  { w: 1288, h: 700 },
  { w: 1288, h: 900 },
  { w: 1440, h: 700 },
  { w: 1440, h: 900 },
] as const;
/* The question card gets one tight-height leg on top: at 1024x600 the card
   nearly fills the port, the lock is dead and the card's own arrival-align
   owns the park — pad can't reach that case, only the align's tail
   clearance does (the second-cut fix). */
const QUESTION_VIEWPORTS = [...VIEWPORTS, { w: 1024, h: 600 }] as const;
const THEMES = ["light", "dark"] as const;

/** Sample the geometry the AC pins: card bottom vs composer top, card fully
    inside the scroller, ↓/gutter state for diagnosis. Runs in the page —
    passed to page.evaluate by reference. `settleFrames` waits that many
    animation frames before measuring: the app's re-pin rides a
    ResizeObserver + rAF, so a sample taken right after a viewport change
    can freeze a pre-realign layout that looks wall-clock-stable — a full
    frame boundary between samples is what makes "identical" mean settled. */
async function measureCard(args: {
  portSel: string;
  cardSel: string;
  settleFrames?: number;
}) {
  for (let i = args.settleFrames ?? 0; i > 0; i--) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
  /* A selector can match several mounts (sidebar + thread panel) — the
     port under test is always the last one in DOM order. */
  const port = [...document.querySelectorAll(args.portSel)].at(-1);
  if (!port) return { error: `no port ${args.portSel}` } as const;
  const sc = port.firstElementChild as HTMLElement | null;
  if (!sc) return { error: "no scroller" } as const;
  const cards = [...port.querySelectorAll<HTMLElement>(args.cardSel)];
  const card = cards[cards.length - 1];
  if (!card) return { error: `no card ${args.cardSel}` } as const;
  const comp = port.parentElement?.querySelector("[data-composer]");
  if (!comp) return { error: "no composer" } as const;
  const cardR = card.getBoundingClientRect();
  const scR = sc.getBoundingClientRect();
  const compR = comp.getBoundingClientRect();
  const list = card.querySelector<HTMLElement>("[data-question-options]");
  /* What the card's own port-walk resolves right now — a null/wrong port
     pins the options cap to the window height (Focus's all-at-once mount
     raced the library's overflow write; the class should make it stick). */
  let portOf: string | null = null;
  for (let p = list?.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (/(auto|scroll)/.test(oy)) {
      portOf = `${p.tagName.toLowerCase()}#ch${p.clientHeight}#${(p.getAttribute("class") ?? "").slice(0, 40)}`;
      break;
    }
  }
  return {
    top: sc.scrollTop,
    h: sc.scrollHeight,
    ch: sc.clientHeight,
    cardTop: cardR.top,
    cardBottom: cardR.bottom,
    cardH: cardR.height,
    listH: list?.getBoundingClientRect().height,
    listMaxH: list ? getComputedStyle(list).maxHeight : undefined,
    /* Whether use-stick-to-bottom had to write inline overflow — non-empty
       means the overflow-auto class never applied at mount. */
    scInlineOv: sc.style.overflow || sc.style.overflowY || "",
    portOf,
    scCls: (sc.getAttribute("class") ?? "").slice(0, 60),
    scBottom: scR.bottom,
    compTop: compR.top,
    gap: compR.top - cardR.bottom,
    clip: cardR.bottom - scR.bottom,
    portPad: parseFloat(getComputedStyle(port).paddingBottom),
    btnMounted: !!port.querySelector(".lilos-scroll-btn"),
  };
}

/* Convergent measurement (ac-602's rule): two identical samples in a row,
   the ↓ gutter gone, and — for pinned legs — the port at its end. lilos-rise's
   fill:both from-frame can otherwise freeze a stable-but-warped rect, and a
   dead lock with a still-visible card must not pass. `pinned` is off for the
   question card: its scroll-mt parks short of the end by design. On failure
   the last sample rides in the assertion message. */
async function expectCardClearance(
  page: Page,
  portSel: string,
  cardSel: string,
  shot: string,
  pinned: boolean,
) {
  type M = Exclude<Awaited<ReturnType<typeof measureCard>>, { error: string }>;
  let prev: Awaited<ReturnType<typeof measureCard>> | null = null;
  let last: Awaited<ReturnType<typeof measureCard>> | null = null;
  try {
    await expect
      .poll(async () => {
        const m = await page.evaluate(measureCard, {
          portSel,
          cardSel,
          settleFrames: 2,
        });
        last = m;
        const ok =
          !("error" in m) &&
          !m.btnMounted &&
          m.portPad === 0 &&
          (!pinned || m.top >= m.h - m.ch - 2) &&
          prev !== null &&
          !("error" in prev) &&
          m.top === prev.top &&
          m.h === prev.h &&
          m.cardBottom === prev.cardBottom &&
          m.compTop === prev.compTop;
        prev = m;
        return ok;
      })
      .toBe(true);
  } catch (e) {
    throw new Error(
      `card never settled — ${portSel} ${cardSel} ${JSON.stringify(last)}\n${e}`,
    );
  }
  if (last === null || "error" in last) {
    throw new Error(`no usable sample — ${JSON.stringify(last)}`);
  }
  const m: M = last;
  /* Screenshot before the assertions — a miss keeps its evidence. */
  await page.screenshot({ path: path.join(SHOTS, `${shot}.png`) });
  const dump = `${portSel} ${cardSel} ${JSON.stringify(m)}`;
  if (pinned) {
    expect(
      m.top,
      `port must stay pinned to the bottom — ${dump}`,
    ).toBeGreaterThanOrEqual(m.h - m.ch - 2);
  }
  expect(
    m.clip,
    `card bottom must stay inside the scroller — ${dump}`,
  ).toBeLessThanOrEqual(1);
  expect(
    m.gap,
    `card→composer clearance ≥ ${GAP_MIN}px — ${dump}`,
  ).toBeGreaterThanOrEqual(GAP_MIN);
}

const send = async (page: Page, text: string) => {
  const box = page.locator("[data-thread-panel] textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

/* Idle = the composer is not running, nothing is queued or streaming,
   and the last row is a settled agent turn — and stays that way.
   The previous agent turn's footer is the wrong anchor: the last
   `[data-msg]` can still be the user's just-posted row, with no agent
   turn mounted yet. Treating that as idle lets the next send land as a
   `turn.steered` note (#807). Stop (⌘.) covers the same gap before
   `[data-streaming]` exists. Require a stable 600ms window. The poll
   keeps expect's default 5s. */
const idle = async (page: Page) => {
  let idleSince: number | null = null;
  await expect
    .poll(async () => {
      const idleNow = await page.evaluate(() => {
        const root = document.querySelector("[data-thread-panel]");
        if (!root) return false;
        if (root.querySelector('button[aria-label="Stop (⌘.)"]')) return false;
        if (
          root.querySelector("[data-queued], [data-notsent], [data-streaming]")
        )
          return false;
        const msgs = root.querySelectorAll("[data-msg]");
        const last = msgs[msgs.length - 1];
        if (!last) return false;
        const turn = last.querySelector("[data-agentturn]");
        return !!turn && !!turn.querySelector("[data-turnsettled]");
      });
      const now = Date.now();
      if (!idleNow) {
        idleSince = null;
        return false;
      }
      if (idleSince === null) idleSince = now;
      return now - idleSince > 600;
    })
    .toBe(true);
};

/** The thread was grown through the relay before the page opened
    (`openChat`). This only checks the scroller overflowed. Sending
    another "summarize" here would put a word-by-word turn under
    `idle`'s 5s poll (#827). */
async function makeScrollable(page: Page) {
  const focusSel = "[data-thread-panel] [role='log']";
  const range = await page.evaluate((s) => {
    const sc = document.querySelector(s)
      ?.firstElementChild as HTMLElement | null;
    return sc ? sc.scrollHeight - sc.clientHeight : 0;
  }, focusSel);
  expect(range, "session never became scrollable").toBeGreaterThan(320);
}

/* Four settled default-script turns. Measured under four CPU hogs:
   hello + two of these notes already overflowed a 700px-tall scroller,
   and each composer send left only ~0.5s of the 5s idle poll after the
   turn. One extra note is margin for a shorter wrap. None of these
   match engine-fake's edit-ask, so each turn completes on its own. */
const SETTLED_SCROLL = [
  "hello there",
  "Working note 1: summarize the repo layout",
  "Working note 2: summarize the repo layout",
  "Working note 3: summarize the repo layout",
];

test.describe("AC-1/2/3 approval, plan and question cards (real app, engine-fake)", () => {
  test.describe.configure({ mode: "serial" });
  let stack: Stack;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    stack = await bootStack("gap649", await pickPorts());
  });
  test.afterAll(async () => {
    await stack?.stop();
  });

  /* A settled DM with the seeded employee, opened in the side peek and
     widened — the peek's widen button is the only way in (#577).
     #827: the turns are posted through the relay (`growDmThread` waits
     `turn.completed` on its own 60s budget) before the page opens.
     `idle` then only has to see a quiet composer for 600ms inside
     expect's default 5s. Sending them from the composer made the poll
     wait out engine-fake's word-by-word reply; under load that reply
     plus 600ms did not fit. */
  async function openChat(page: Page) {
    const grown = await growDmThread(stack, SETTLED_SCROLL);
    await skipFirstRun(page);
    await page.goto(threadUrl(stack.webUrl, grown.conversationId));
    await panelIntoFocus(page);
    await expect(
      page
        .locator("[data-thread-panel] [data-agentturn] [data-turnsettled]")
        .last(),
    ).toBeVisible({ timeout: 30_000 });
  }

  /** The surface under test: the session view as is, or narrowed back to the
      peek (the ask stays open across the swap). */
  async function surfaceOf(page: Page, surface: "focus" | "panel") {
    if (surface === "panel") {
      await v3Peek(page).getByTitle("Narrow, back beside the page").click();
      await expect(page).not.toHaveURL(/[#&]full=1(&|$)/);
      await expect(
        page.locator("[data-thread-panel] [role='log'] [data-msg]").first(),
      ).toBeVisible({ timeout: 15_000 });
    }
    return "[data-thread-panel] [role='log']";
  }

  /* One session per card kind, both surfaces walked off it — the ask stays
     open across the Focus ↔ thread-panel navigation. */
  for (const surface of ["focus", "panel"] as const) {
    test(`AC-1 approval card clears the composer — ${surface}`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: 1288, height: 700 });
      await openChat(page);
      await idle(page);
      await makeScrollable(page);
      /* An edit-shaped prompt gates the first tool behind an approval ask —
         the card lands while the lock is chasing the stream. */
      await send(page, "slow:150 update the readme with a release note");
      const card = page.locator(
        '[data-thread-panel] [role="log"] [data-ask-id][data-ask-state="open"]',
      );
      await expect(card).toBeVisible({ timeout: 60_000 });
      const portSel = await surfaceOf(page, surface);
      for (const { w, h } of VIEWPORTS) {
        for (const theme of THEMES) {
          await page.setViewportSize({ width: w, height: h });
          await page.emulateMedia({ colorScheme: theme });
          await expectCardClearance(
            page,
            portSel,
            '[data-ask-id][data-ask-state="open"]',
            `approval-${surface}-${w}x${h}-${theme}`,
            true,
          );
        }
      }
    });

    test(`AC-2 plan card clears the composer — ${surface}`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: 1288, height: 700 });
      await openChat(page);
      await idle(page);
      await makeScrollable(page);
      await send(page, "plan: propose — backoff reconnect");
      const card = page
        .locator('[data-thread-panel] [role="log"] [data-plan]')
        .last();
      await expect(card).toBeVisible({ timeout: 60_000 });
      const portSel = await surfaceOf(page, surface);
      for (const { w, h } of VIEWPORTS) {
        for (const theme of THEMES) {
          await page.setViewportSize({ width: w, height: h });
          await page.emulateMedia({ colorScheme: theme });
          await expectCardClearance(
            page,
            portSel,
            "[data-plan]",
            `plan-${surface}-${w}x${h}-${theme}`,
            true,
          );
        }
      }
    });

    test(`AC-3 question card clears the composer — ${surface}`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: 1288, height: 700 });
      await openChat(page);
      await idle(page);
      await makeScrollable(page);
      /* The `question:` prompt parks the turn on a free-text + options ask —
         the shared QuestionCard, the tallest card the app ships. */
      await send(page, "question: pick the ship target");
      const card = page.locator(
        '[data-thread-panel] [role="log"] [data-question-card][data-ask-state="open"]',
      );
      await expect(card).toBeVisible({ timeout: 60_000 });
      const portSel = await surfaceOf(page, surface);
      for (const { w, h } of QUESTION_VIEWPORTS) {
        for (const theme of THEMES) {
          await page.setViewportSize({ width: w, height: h });
          await page.emulateMedia({ colorScheme: theme });
          await expectCardClearance(
            page,
            portSel,
            '[data-question-card][data-ask-state="open"]',
            `question-${surface}-${w}x${h}-${theme}`,
            false,
          );
        }
      }
    });
  }
});
