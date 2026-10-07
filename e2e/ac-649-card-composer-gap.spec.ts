import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/* Issue #649 — when a decision card (approval ask, question ask, plan) is
   the last conversation row, its bottom edge must rest ≥12px above the
   composer: border, padding and rounded corners fully inside the scroller.
   Two failure shapes fed the bug: the bottom lock parks 1px short of the
   scroller's end (a ~12px content pad rests at ~11px), and a layout nudge
   while the lock chases stream growth kills the pin entirely, parking the
   card under the composer.
   Approval and plan legs ride the engine-fake dev stack on a real session
   grown scrollable first; the question-card leg rides the prototype's
   seeded "v3" thread (question asks are prototype-only — engine-fake never
   emits one). Every leg measures card-bottom → composer-top on the
   three desktop sizes × light+dark and keeps a screenshot. */

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
    passed to page.evaluate by reference. */
function measureCard(args: { portSel: string; cardSel: string }) {
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
  return {
    top: sc.scrollTop,
    h: sc.scrollHeight,
    ch: sc.clientHeight,
    cardTop: cardR.top,
    cardBottom: cardR.bottom,
    cardH: cardR.height,
    listH: list?.getBoundingClientRect().height,
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
  type M = Exclude<ReturnType<typeof measureCard>, { error: string }>;
  let prev: ReturnType<typeof measureCard> | null = null;
  let last: ReturnType<typeof measureCard> | null = null;
  try {
    await expect
      .poll(async () => {
        const m = await page.evaluate(measureCard, { portSel, cardSel });
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
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

/* Idle = no queued/not-sent rows and the composer is back to its
   post-turn placeholder (Focus "Continue session…", panel "Reply to…") —
   and stays there. engine-fake's pumpSteers mints a queued steer into a
   fresh turn in the same tick as turn.completed, so the placeholder can
   flash idle while a turn is already running; a send landing inside that
   window is consumed as a `turn.steered` note, never a prompt. Require a
   stable 600ms idle window before sending the next prompt. */
const idle = async (page: Page) => {
  let idleSince: number | null = null;
  await expect
    .poll(async () => {
      const idleNow = await page.evaluate(
        () =>
          !document.querySelector("[data-queued], [data-notsent]") &&
          [...document.querySelectorAll("textarea")].some(
            (t) =>
              t.placeholder.includes("Continue session") ||
              t.placeholder.includes("Reply to"),
          ),
      );
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

/** Grow the session until the Focus scroller overflows with headroom for
    the card that follows (≥ a card's height of scroll range). */
async function makeScrollable(page: Page) {
  const focusSel = "main [role='log']";
  const range = () =>
    page.evaluate((s) => {
      const sc = document.querySelector(s)
        ?.firstElementChild as HTMLElement | null;
      return sc ? sc.scrollHeight - sc.clientHeight : 0;
    }, focusSel);
  for (let i = 0; i < 8 && (await range()) < 320; i++) {
    await send(page, `Working note ${i + 1}: summarize the repo layout`);
    await idle(page);
  }
  expect(await range(), "session never became scrollable").toBeGreaterThan(320);
}

test.describe("AC-1/2 approval + plan cards (real app, engine-fake)", () => {
  test.describe.configure({ mode: "serial" });
  let stack: Stack;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    stack = await bootStack("gap649", await pickPorts());
  });
  test.afterAll(async () => {
    await stack?.stop();
  });

  async function openDm(page: Page) {
    await page.addInitScript(() =>
      localStorage.setItem("lilos-onboarded", "1"),
    );
    await page.goto(`${stack.webUrl}/`);
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
      await page
        .locator("aside")
        .first()
        .getByRole("button", { name: /default/i })
        .click();
    }
    await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
  }

  /* One session per card kind, both surfaces walked off it — the ask stays
     open across the Focus ↔ thread-panel navigation. */
  for (const surface of ["focus", "panel"] as const) {
    test(`AC-1 approval card clears the composer — ${surface}`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: 1288, height: 700 });
      await openDm(page);
      await send(page, "hello there");
      await expect(page).toHaveURL(/\/focus/, { timeout: 30_000 });
      await idle(page);
      await makeScrollable(page);
      /* An edit-shaped prompt gates the first tool behind an approval ask —
         the card lands while the lock is chasing the stream. */
      await send(page, "slow:150 update the readme with a release note");
      const card = page.locator(
        'main [role="log"] [data-ask-id][data-ask-state="open"]',
      );
      await expect(card).toBeVisible({ timeout: 60_000 });
      const portSel =
        surface === "focus"
          ? "main [role='log']"
          : "[data-thread-panel] [role='log']";
      if (surface === "panel") {
        await page.goto(page.url().replace(/\/focus$/, ""));
        await expect(
          page.locator("[data-thread-panel] [role='log'] [data-msg]").first(),
        ).toBeVisible({ timeout: 15_000 });
      }
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
      await openDm(page);
      await send(page, "hello there");
      await expect(page).toHaveURL(/\/focus/, { timeout: 30_000 });
      await idle(page);
      await makeScrollable(page);
      await send(page, "plan: propose — backoff reconnect");
      const card = page.locator('main [role="log"] [data-plan]').last();
      await expect(card).toBeVisible({ timeout: 60_000 });
      const portSel =
        surface === "focus"
          ? "main [role='log']"
          : "[data-thread-panel] [role='log']";
      if (surface === "panel") {
        await page.goto(page.url().replace(/\/focus$/, ""));
        await expect(
          page.locator("[data-thread-panel] [role='log'] [data-msg]").first(),
        ).toBeVisible({ timeout: 15_000 });
      }
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
  }
});

test.describe("AC-3 question card clears the composer (prototype)", () => {
  /* The reviewer DM's "v3" session parks on a 5-option open question —
     the tallest card the app ships. */
  async function openV3(page: Page) {
    await page.goto("/");
    await page
      .locator("aside")
      .first()
      .getByRole("button", { name: /Reviewer/ })
      .click();
    await page
      .locator('[data-session="v3"]')
      .getByRole("button", { name: /repl/ })
      .click();
  }

  for (const surface of ["panel", "focus"] as const) {
    test(`AC-3 question card — ${surface}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1288, height: 700 });
      await openV3(page);
      const portSel =
        surface === "panel" ? "aside [role='log']" : "main [role='log']";
      if (surface === "focus") {
        await page
          .locator("aside")
          .last()
          .getByRole("button", { name: "Focus", exact: true })
          .click();
        await expect(
          page.locator('main [role="log"] [data-msg]').first(),
        ).toBeVisible({ timeout: 15_000 });
      }
      const port = page.locator(portSel).last();
      await expect(
        port.locator('[data-question-card][data-ask-state="open"]'),
      ).toBeVisible({ timeout: 15_000 });
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
