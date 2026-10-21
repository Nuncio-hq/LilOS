import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  TOOLBAR_HEIGHT,
  TRAFFIC_LIGHTS_END,
} from "../apps/desktop/src/window-chrome";
import { launchDesktop } from "./helpers/electron";
import { growDmThread } from "./helpers/relay-thread";
import {
  bootStack,
  panelFocusReady,
  pickPorts,
  type Stack,
  skipFirstRun,
  threadUrl,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #797 — one native unified toolbar. The window has ONE toolbar row
 * across it (52px in the Mac app, 44px in a browser tab), made of each
 * column's first row: the sidebar's segment (the traffic lights, then the
 * sidebar toggle), the page's (empty drag space), and the side peek's (back,
 * trail, Widen/Narrow, ✕ — one <aside>, no header row of its own below it).
 * No company name in it: the company heads the sidebar's Company section.
 *
 *   AC-1 one row: the three segments share the window's top edge and height,
 *       edge to edge, and every item is centred on it.
 *   AC-2 the toggle comes right after the lights docked or hidden; hidden,
 *       Search joins it, in the page's segment — or the peek's, widened.
 *   AC-3 a notice (the stack's own "no model reported") stays under the
 *       toolbar, above the page AND the peek, widened or not.
 *   AC-4 (Mac window) the first message of a thread starts ≤ 140px from the
 *       window's top (was ~250).
 * The native window around the row — the lights centred in it, drag, full
 * screen — is ac-232; the real window's captures are the PR evidence.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, "..", "test-results", "ac-797");
const isMac = process.platform === "darwin";

/** The toolbar row's segments, one per column. */
const SIDEBAR_BAR = "aside[data-sidebar] > [data-toolbar]";
const PAGE_BAR = "[data-v3-topbar]";
const PEEK_BAR = 'aside[aria-label="Opened record"] > [data-toolbar]';

let stack: Stack;
let conversationId = "";
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac797", await pickPorts());
  conversationId = (
    await growDmThread(stack, ["toolbar check", "and a second turn"])
  ).conversationId;
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const boxOf = async (page: Page, selector: string) => {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  return box;
};
const centreY = (b: { y: number; height: number }) => b.y + b.height / 2;

/** A thread in the side peek on a 1440px window (sidebar, page and peek all
    fit), past first run. */
async function openThread(page: Page, full = false) {
  await skipFirstRun(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(threadUrl(stack.webUrl, conversationId, full));
  await expect(
    v3Sidebar(page).getByRole("button", { name: /default/i }),
  ).toBeVisible({ timeout: 60_000 });
  await panelFocusReady(page);
}

test("AC-1 one toolbar row: the sidebar's, the page's and the peek's segments share the window's top edge, edge to edge", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openThread(page);
  const rowH = await page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--v3-toolbar-h",
      ),
    ),
  );
  // A browser tab gets the compact row; the Mac app's 52 is ac-232's.
  expect(rowH).toBe(44);

  const [side, pageBar, peek] = [
    await boxOf(page, SIDEBAR_BAR),
    await boxOf(page, PAGE_BAR),
    await boxOf(page, PEEK_BAR),
  ];
  for (const b of [side, pageBar, peek])
    expect([b.y, b.height]).toEqual([0, 44]);
  // Edge to edge: the sidebar's own box (its segment sits inside its border),
  // the page's segment, the peek's own box.
  const [sideBox, peekBox] = [
    await boxOf(page, "aside[data-sidebar]"),
    await boxOf(page, 'aside[aria-label="Opened record"]'),
  ];
  expect(side.x).toBe(0);
  expect(sideBox.x + sideBox.width).toBe(pageBar.x);
  expect(Math.round(pageBar.x + pageBar.width)).toBe(Math.round(peekBox.x));
  expect(Math.round(peekBox.x + peekBox.width)).toBe(1440);
  // The peek's first row IS the row: its <aside> starts at the window's top
  // and nothing sits between the row and its content but the notice (below).
  expect(peekBox.y).toBe(0);

  // Every item sits on the row's centre line: the toggle (28px, 16px glyph),
  // and the peek's back, Widen and close.
  const toggle = page.locator(`${SIDEBAR_BAR} button`);
  await expect(toggle).toHaveAttribute("aria-label", "Hide sidebar");
  const t = await boxOf(page, `${SIDEBAR_BAR} button`);
  expect([t.width, t.height]).toEqual([28, 28]);
  expect(await toggle.locator("svg").evaluate((s) => s.clientWidth)).toBe(16);
  expect(centreY(t)).toBe(22);
  for (const title of ["Back one step", "Widen over the page", "Close (Esc)"]) {
    const b = await v3Peek(page)
      .getByTitle(title, { exact: true })
      .boundingBox();
    expect(centreY(b ?? { y: -1, height: 0 })).toBe(22);
  }

  // The company names the sidebar's Company section, not the toolbar: no
  // text in any segment but the peek's trail.
  for (const bar of [SIDEBAR_BAR, PAGE_BAR])
    await expect(page.locator(bar)).toHaveText("");
  await expect(page.locator("[data-toolbar]")).toHaveCount(3);
  const company = await v3Sidebar(page)
    .locator("[data-company-label]")
    .innerText();
  expect(company.trim().length).toBeGreaterThan(0);
  await expect(page.locator(PEEK_BAR)).not.toContainText(company);
  // The page's segment is bare drag space while the sidebar is docked: Search
  // is the sidebar's row, so the one Search on screen is not up here.
  await expect(page.locator(PAGE_BAR).locator("button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Search/ })).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/ac-1-one-row.png` });
});

test("AC-2 the toggle stays right after the lights, docked or hidden; hidden, Search joins it — in the page's segment, or the peek's once widened", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openThread(page);
  const docked = await boxOf(page, `${SIDEBAR_BAR} button`);
  await page
    .locator(SIDEBAR_BAR)
    .getByRole("button", { name: "Hide sidebar" })
    .click();
  await expect(v3Sidebar(page)).toBeHidden();

  // Beside the page: the page's segment leads — toggle first, then Search —
  // in the very place the docked toggle was.
  const lead = page.locator(PAGE_BAR).locator("button");
  await expect(lead).toHaveCount(2);
  await expect(lead.nth(0)).toHaveAttribute("aria-label", "Show sidebar");
  await expect(lead.nth(1)).toHaveAttribute("aria-label", "Search");
  const [show, search] = [
    await boxOf(page, `${PAGE_BAR} button`),
    (await lead.nth(1).boundingBox()) ?? { x: -1, width: 0 },
  ];
  expect([show.x, show.y]).toEqual([docked.x, docked.y]);
  expect(search.x).toBeGreaterThan(show.x + show.width);
  await expect(page.getByRole("button", { name: /^Search/ })).toHaveCount(1);
  await expect(page.locator(PAGE_BAR)).toHaveText("");
  // The peek's segment is unchanged: Back first.
  await expect(
    page.locator(`${PEEK_BAR} [data-sidebar-shortcuts]`),
  ).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-2-hidden.png` });

  // Widened over the page: the peek's segment spans the window and takes the
  // lead — one set of shortcuts, never two — then its own items.
  await v3Peek(page).getByTitle("Widen over the page", { exact: true }).click();
  await expect(page).toHaveURL(/[#&]full=1(&|$)/);
  const bar = await boxOf(page, PEEK_BAR);
  expect([bar.x, bar.width, bar.y, bar.height]).toEqual([0, 1440, 0, 44]);
  await expect(page.locator("[data-sidebar-shortcuts]")).toHaveCount(1);
  await expect(
    page.locator(PEEK_BAR).locator("[data-sidebar-shortcuts]"),
  ).toHaveCount(1);
  await expect(page.locator(PAGE_BAR).locator("button")).toHaveCount(0);
  const widenedShow = await boxOf(page, `${PEEK_BAR} button`);
  expect([widenedShow.x, widenedShow.y]).toEqual([docked.x, docked.y]);
  const back = await v3Peek(page).getByTitle("Back one step").boundingBox();
  expect(back?.x).toBeGreaterThan(widenedShow.x + 28 * 2);
  await expect(page.getByRole("button", { name: /^Search/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /widen|narrow/i })).toHaveCount(
    1,
  );
  await page.screenshot({ path: `${SHOTS}/ac-2-hidden-widened.png` });

  // The toggle docks the sidebar again; the shortcuts go back where they
  // were not: nowhere, the sidebar's row is Search.
  await page
    .locator(PEEK_BAR)
    .getByRole("button", { name: "Show sidebar" })
    .click();
  await expect(v3Sidebar(page)).toBeVisible();
  await expect(page.locator("[data-sidebar-shortcuts]")).toHaveCount(0);
  const redocked = await boxOf(page, `${SIDEBAR_BAR} button`);
  expect([redocked.x, redocked.y]).toEqual([docked.x, docked.y]);
});

test("AC-3 a notice stays under the toolbar and above the page and the peek, widened or not", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openThread(page);
  /* The stack's engine-fake reports no model, so the app draws its notice
     (V3Banner, role=status, with "Details"): the one outage this stack has
     without killing a service. */
  const notice = page.getByRole("status").filter({ hasText: "Details" });
  await expect(notice).toBeVisible({ timeout: 30_000 });
  const n = (await notice.boundingBox()) ?? {
    x: -1,
    y: -1,
    width: 0,
    height: 0,
  };
  // Under the row, and across the page and the peek together.
  expect(n.y).toBe(44);
  const side = await boxOf(page, "aside[data-sidebar]");
  expect(Math.round(n.x)).toBe(Math.round(side.x + side.width));
  expect(Math.round(n.x + n.width)).toBe(1440);
  expect((await boxOf(page, "#v3-main")).y).toBeGreaterThanOrEqual(
    n.y + n.height,
  );
  expect((await boxOf(page, "[data-thread-panel]")).y).toBeGreaterThanOrEqual(
    n.y + n.height,
  );

  // Widened, the peek covers the page but not the notice: still the first
  // thing under the row, the peek's content below it.
  await v3Peek(page).getByTitle("Widen over the page", { exact: true }).click();
  await expect(page).toHaveURL(/[#&]full=1(&|$)/);
  await panelFocusReady(page);
  const w = (await notice.boundingBox()) ?? { y: -1, height: 0 };
  expect(w.y).toBe(44);
  expect((await boxOf(page, "[data-thread-panel]")).y).toBeGreaterThanOrEqual(
    w.y + w.height,
  );
  // …and it is the notice that is on top there, not the peek's own surface.
  expect(
    await notice.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(
        document.elementFromPoint(r.x + 40, r.y + r.height / 2),
      );
    }),
  ).toBe(true);
  await page.screenshot({ path: `${SHOTS}/ac-3-notice-widened.png` });
});

test("AC-4 on the Mac the first message of a thread starts ≤ 140px from the window's top", async () => {
  test.skip(!isMac, "the 52px row is the Mac app's");
  test.setTimeout(180_000);
  const { app, win } = await launchDesktop(stack, {
    hash: threadUrl(stack.webUrl, conversationId),
  });
  try {
    await expect(
      v3Sidebar(win).getByRole("button", { name: /default/i }),
    ).toBeVisible({ timeout: 60_000 });
    await panelFocusReady(win);
    await expect
      .poll(() => boxOf(win, PEEK_BAR).then((b) => b.height))
      .toBe(TOOLBAR_HEIGHT);

    /* Where the first message sits with the thread read from its top (a
       thread opens pinned to its newest message), beside the page and then
       widened. A notice (AC-3: this stack's engine reports no model, so the
       app draws one) is above the page by design and drawn only while
       something is wrong, so it is taken off the measure: what counts is what
       the toolbar and the thread add below the window's top edge. */
    const firstMessageTop = () =>
      win.evaluate(() => {
        for (const el of document.querySelectorAll(
          "aside[aria-label='Opened record'] *",
        )) {
          const cs = getComputedStyle(el);
          if (
            /(auto|scroll)/.test(cs.overflowY) &&
            el.scrollHeight > el.clientHeight
          )
            el.scrollTop = 0;
        }
        const notice = [...document.querySelectorAll("[role=status]")].find(
          (el) => el.textContent?.includes("Details"),
        );
        const top = document
          .querySelector("[data-userturn]")
          ?.getBoundingClientRect().top;
        return top === undefined
          ? undefined
          : top - (notice?.getBoundingClientRect().height ?? 0);
      });
    await expect.poll(firstMessageTop).toBeLessThanOrEqual(140);
    expect(await firstMessageTop()).toBeGreaterThan(TOOLBAR_HEIGHT);
    await win.screenshot({ path: `${SHOTS}/ac-4-first-message.png` });

    await v3Peek(win)
      .getByTitle("Widen over the page", { exact: true })
      .click();
    await expect(win).toHaveURL(/[#&]full=1(&|$)/);
    await expect.poll(firstMessageTop).toBeLessThanOrEqual(140);
    // The lights' reserve keeps the toggle clear of them in this window too.
    const toggle = await boxOf(win, `${SIDEBAR_BAR} button`);
    expect(toggle.x - TRAFFIC_LIGHTS_END).toBeGreaterThanOrEqual(10);
  } finally {
    await app.close();
  }
});
