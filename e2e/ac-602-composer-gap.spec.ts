import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/* Issue #602 — at rest (scrolled to the bottom) the gap between the last
   message and the composer must be ≤ 24px on every chat surface.
   Regression: #536's permanent ↓-button gutter (56px port padding) stacked
   with #515's composer-height pad (112px) left a ~176px dead band under the
   thread panel and ~76px under the DM feed.
   Bounding-box assertions need a real browser — happy-dom has no layout.
   Prototype legs ride the seeded threads (ses_b71d scrolls at these sizes;
   the reviewer DM's "v3" thread parks on a tall open question card — #515's
   guarantee). The DM-feed and real-thread legs boot the dev stack on
   engine-fake. */

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

/* The gap the user sees: the composer's top edge minus the bottom edge of
   the last rendered row, clipped to the scroller. The composer is the
   [data-composer] inside the port's own column (its margin-top counts as
   empty band — that's exactly what Oscar flagged). Also returns the port's
   own padding-bottom: with the button unmounted at rest it must be 0. */
function measureGap(page: Page, portSelector: string) {
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
    const last = rows[rows.length - 1];
    if (!last) return { error: "no rows" } as const;
    const lastBottom = Math.min(
      last.getBoundingClientRect().bottom,
      scR.bottom,
    );
    const comp = port.parentElement?.querySelector("[data-composer]");
    if (!comp) return { error: "no composer under the port's column" } as const;
    return {
      gap: comp.getBoundingClientRect().top - lastBottom,
      portPad: parseFloat(getComputedStyle(port).paddingBottom),
      scrollable: sc.scrollHeight - sc.clientHeight > 8,
      scrollTop: sc.scrollTop,
    };
  }, portSelector);
}

/* Below xl the right panel mounts as a fixed overlay and starts closed;
   both main-area headers (channel + DM) end with the PanelRight icon
   button (`{!panelOpen && <Button …>` — no aria-label, it's the last
   button in the header). DM session rows instead open it via their
   "N replies" pill (`onOpen` → setPanelOpen(true) at any width). */
async function ensurePanelOpen(page: Page) {
  if (await page.locator("aside [role='log']").count()) return;
  await page.locator("main header button").last().click();
}

async function expectGap(page: Page, portSelector: string, atBottom = true) {
  await settleAtBottom(page, portSelector, atBottom);
  const m = await measureGap(page, portSelector);
  if ("error" in m) throw new Error(m.error);
  expect(
    m.gap,
    `${portSelector}: gap between last row and composer at the bottom`,
  ).toBeLessThanOrEqual(GAP_LIMIT);
  expect(
    m.portPad,
    `${portSelector}: ↓ gutter must not be reserved while the button is hidden`,
  ).toBe(0);
}

test.describe("AC-1 bottom gap at rest ≤ 24px (prototype surfaces)", () => {
  /* AC-1 names 1440 and 1024 wide; 700px is the short desktop height the
     ac-535 spec also covers. */
  for (const { w, h } of [
    { w: 1440, h: 900 },
    { w: 1024, h: 700 },
  ]) {
    test(`thread panel ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/");
      /* The seeded ses_b71d thread is pre-selected (threadId=m2); ≥1280
         opens the panel on its own, below that the header toggle does. */
      await ensurePanelOpen(page);
      const port = page.locator("aside").last().locator('[role="log"]');
      await expect(port.locator("[data-msg]").first()).toBeVisible({
        timeout: 15_000,
      });
      await expectGap(page, "aside [role='log']");
    });

    test(`Focus ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/");
      await ensurePanelOpen(page);
      const panel = page.locator("aside").last();
      await panel.getByRole("button", { name: "Focus", exact: true }).click();
      const port = page.locator('main [role="log"]');
      await expect(port.locator("[data-msg]").first()).toBeVisible({
        timeout: 15_000,
      });
      await expectGap(page, "main [role='log']");
    });

    test(`channel feed ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/");
      const port = page.locator('main [role="log"]');
      await expect(port).toBeVisible({ timeout: 15_000 });
      await expectGap(page, "main [role='log']");
    });

    test(`DM feed ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/");
      // Reviewer DM = EmployeeHome — the real app's DM list component.
      // (Accessible name also carries the sr-only "needs you" badge text.)
      await page
        .locator("aside")
        .first()
        .getByRole("button", { name: /Reviewer/ })
        .click();
      const port = page.locator('main [role="log"]');
      await expect(port).toBeVisible({ timeout: 15_000 });
      await expectGap(page, "main [role='log']");
    });
  }
});

test.describe("AC-3 an open question card stays fully visible", () => {
  /* The reviewer DM's "v3" thread parks on a 5-option question + free text —
     the tallest card; at a short viewport it reaches the scroller's bottom
     edge, which is exactly where #515 needed the padding that stacked into
     #602's band. The card (incl. its Skip row) must end above the composer
     AND inside the scroller — no clip, no overlay. */
  for (const { w, h } of [
    { w: 1440, h: 700 },
    { w: 1024, h: 600 },
  ]) {
    test(`thread panel ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/");
      await page
        .locator("aside")
        .first()
        .getByRole("button", { name: /Reviewer/ })
        .click();
      // The v3 session row's replies pill opens its thread at any width.
      await page
        .locator('[data-session="v3"]')
        .getByRole("button", { name: /repl/ })
        .click();
      const port = page.locator("aside").last().locator('[role="log"]');
      const card = port.locator('[data-question-card][data-ask-state="open"]');
      await expect(card).toBeVisible({ timeout: 15_000 });
      await settleAtBottom(page, "aside [role='log']", false);
      const m = await page.evaluate(() => {
        const port = document.querySelector("aside [role='log']");
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
        };
      });
      if ("error" in m) throw new Error(m.error);
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
      await expectGap(page, "aside [role='log']", false);
    });
  }
});

test.describe("AC-1 real app (engine-fake stack)", () => {
  test.describe.configure({ mode: "serial" });
  let stack: Stack;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    stack = await bootStack("gap602", await pickPorts());
  });
  test.afterAll(async () => {
    await stack?.stop();
  });

  async function openDm(page: Page) {
    await page.goto(`${stack.webUrl}/`);
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

  for (const { w, h } of [
    { w: 1440, h: 900 },
    { w: 1024, h: 700 },
  ]) {
    test(`DM feed ${w}x${h}`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: w, height: h });
      await openDm(page);
      const port = page.locator('main [role="log"]');
      await expect(port).toBeVisible({ timeout: 15_000 });
      /* Seed one session on the first leg so the feed's last row is a real
         message row (later legs see it through the shared stack). */
      const hasRow = await port
        .locator("[data-msg], [class*='grid-cols']")
        .first()
        .isVisible()
        .catch(() => false);
      if (!hasRow) {
        const box = page.locator("textarea").last();
        await box.fill("Say hello");
        await box.press("Enter");
        await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+\/focus/, {
          timeout: 30_000,
        });
        const emp = page.url().split("/dm/")[1].split("/")[0];
        await page.goto(`${stack.webUrl}/dm/${emp}`);
        await expect(port).toBeVisible({ timeout: 15_000 });
      }
      /* EmployeeHome bottom-anchors its content (min-h-full justify-end),
         so the last row always sits at the scroller's bottom edge. */
      await expectGap(page, "main [role='log']");
    });
  }

  test("thread panel + Focus once the session fills", async ({ page }) => {
    test.setTimeout(180_000);
    /* A narrow+short viewport makes the new session scrollable after a
       couple of turns — enough to measure the at-bottom band. */
    await page.setViewportSize({ width: 1024, height: 600 });
    await openDm(page);
    const box = page.locator("textarea").last();
    await box.fill("Say hello then list files");
    await box.press("Enter");
    await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+\/focus/, {
      timeout: 30_000,
    });
    /* Send follow-ups until the Focus scroller overflows (cap 6) — the
       engine-fake turn settles quickly; poll scrollHeight > clientHeight. */
    const isScrollable = (sel: string) =>
      page.evaluate((s) => {
        const sc = document.querySelector(s)
          ?.firstElementChild as HTMLElement | null;
        return sc ? sc.scrollHeight - sc.clientHeight > 8 : false;
      }, sel);
    const focusSel = "main [role='log']";
    for (let i = 0; i < 6 && !(await isScrollable(focusSel)); i++) {
      await page.waitForTimeout(1_500);
      const fbox = page.locator("textarea").last();
      await fbox.fill(`Follow-up ${i + 1}: list three more details`);
      await fbox.press("Enter");
    }
    await expectGap(page, focusSel);
    // The plain thread URL shows the same session in the right panel.
    await page.goto(page.url().replace(/\/focus$/, ""));
    const port = page.locator("[data-thread-panel] [role='log']");
    await expect(port.locator("[data-msg]").first()).toBeVisible({
      timeout: 15_000,
    });
    await expectGap(page, "[data-thread-panel] [role='log']");
  });
});
