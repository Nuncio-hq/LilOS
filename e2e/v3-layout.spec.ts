import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  pickPorts,
  type Stack,
  startChat,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * The v3 shell's layout is the person's to arrange (#793; real stack: relay +
 * harness on engine-fake). The sidebar and the side peek resize by dragging
 * the divider beside them (keyboard-operable, double-click resets, remembered
 * per device); the sidebar hides with ⌘\ or its toggle and pops out over the
 * page when the pointer goes to the left edge; and no control appears twice —
 * one Search, one Widen/Narrow, the company named once.
 */

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("v3layout", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const SIDE_KEY = "lilos-v3-sidebar-w";
const PEEK_KEY = "lilos-v3-peek-w";
const HIDDEN_KEY = "lilos-v3-sidebar-hidden";

const sideSep = (page: Page) =>
  page.getByRole("separator", { name: "Resize sidebar" });
const peekSep = (page: Page) =>
  page.getByRole("separator", { name: "Resize side panel" });
const widthNow = async (sep: Locator) =>
  Number(await sep.getAttribute("aria-valuenow"));
const stored = (page: Page, key: string) =>
  page.evaluate((k) => localStorage.getItem(k), key);
const widthOf = async (el: Locator) => (await el.boundingBox())?.width ?? 0;
const main = (page: Page) => page.locator("#v3-main");
const topBar = (page: Page) => page.locator("[data-v3-topbar]");

/** The company's name at the head of the sidebar (after its mark). */
const companyName = async (page: Page) =>
  (
    await v3Sidebar(page).locator("> div span.truncate").first().innerText()
  ).trim();

/** Where the company's name is on screen (the hidden sidebar's copy is not). */
const visibleCompany = (page: Page, company: string) =>
  page.getByText(company, { exact: true }).filter({ visible: true });

/** Drag a divider `dx` px with the pointer, the way a person does (a drag
    past the window's edge stops at the edge, as a pointer does). */
async function drag(page: Page, sep: Locator, dx: number) {
  const box = await sep.boundingBox();
  const view = page.viewportSize();
  if (!box || !view) throw new Error("divider has no box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(Math.min(Math.max(x + dx, 5), view.width - 5), y, {
    steps: 8,
  });
  await page.mouse.up();
}

/** A window where the sidebar, a wide peek and a 320px page all fit. */
async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const agent = await openDefaultAgent(page, stack.webUrl);
  await expect(v3Peek(page)).toBeVisible();
  return agent;
}

test("dragging a divider resizes the sidebar and the side panel, and the widths survive a reload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await open(page);

  // Both dividers are separators with a value and limits.
  await expect(sideSep(page)).toHaveAttribute("aria-valuemin", "200");
  await expect(sideSep(page)).toHaveAttribute("aria-valuemax", "360");
  expect(await widthNow(sideSep(page))).toBe(236);
  expect(Math.round(await widthOf(v3Sidebar(page)))).toBe(236);

  await drag(page, sideSep(page), 64);
  expect(await widthNow(sideSep(page))).toBe(300);
  expect(Math.round(await widthOf(v3Sidebar(page)))).toBe(300);

  // The peek widens by dragging its divider left.
  const before = await widthNow(peekSep(page));
  await drag(page, peekSep(page), -100);
  const after = await widthNow(peekSep(page));
  expect(after).toBe(before + 100);
  expect(Math.round(await widthOf(v3Peek(page)))).toBe(after);

  // Remembered per device: a reload keeps both.
  await page.reload();
  await expect(sideSep(page)).toBeVisible({ timeout: 30_000 });
  expect(await widthNow(sideSep(page))).toBe(300);
  expect(await widthNow(peekSep(page))).toBe(after);
  expect(Math.round(await widthOf(v3Sidebar(page)))).toBe(300);
  expect(Math.round(await widthOf(v3Peek(page)))).toBe(after);
  await page.screenshot({ path: "test-results/v3-layout/resized.png" });
});

test("the limits hold: sidebar 200–360, peek 360 to 70% of the window, the page never under 320", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await open(page);

  await drag(page, sideSep(page), 600);
  expect(await widthNow(sideSep(page))).toBe(360);
  await drag(page, sideSep(page), -600);
  expect(await widthNow(sideSep(page))).toBe(200);

  // The peek's room is what the sidebar leaves: 1440 − 200 = 1240.
  await drag(page, peekSep(page), -1200);
  const max = Number(await peekSep(page).getAttribute("aria-valuemax"));
  expect(await widthNow(peekSep(page))).toBe(max);
  expect(max).toBeLessThanOrEqual(Math.floor(1240 * 0.7));
  expect(await widthOf(main(page))).toBeGreaterThanOrEqual(319);
  await drag(page, peekSep(page), 1200);
  expect(await widthNow(peekSep(page))).toBe(360);

  // A narrower window squeezes the peek first: the page keeps its 320px.
  await drag(page, peekSep(page), -1200);
  await page.setViewportSize({ width: 900, height: 900 });
  await expect
    .poll(async () => widthOf(main(page)))
    .toBeGreaterThanOrEqual(319);
  expect(await widthOf(v3Sidebar(page))).toBeCloseTo(200, 0);
});

test("the dividers work from the keyboard: arrows nudge, Shift+arrows leap, Home/End jump to the limits", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await open(page);

  await sideSep(page).focus();
  await page.keyboard.press("ArrowRight");
  expect(await widthNow(sideSep(page))).toBe(236 + 16);
  await page.keyboard.press("Shift+ArrowRight");
  expect(await widthNow(sideSep(page))).toBe(236 + 16 + 64);
  await page.keyboard.press("Shift+ArrowLeft");
  expect(await widthNow(sideSep(page))).toBe(236 + 16);
  await page.keyboard.press("End");
  expect(await widthNow(sideSep(page))).toBe(360);
  await page.keyboard.press("Home");
  expect(await widthNow(sideSep(page))).toBe(200);

  // The arrow points where the divider moves: ← widens the peek.
  await peekSep(page).focus();
  await page.keyboard.press("Home");
  expect(await widthNow(peekSep(page))).toBe(360);
  await page.keyboard.press("ArrowLeft");
  expect(await widthNow(peekSep(page))).toBe(376);
  await page.keyboard.press("ArrowRight");
  expect(await widthNow(peekSep(page))).toBe(360);
});

test("double-click resets a divider and forgets its stored width", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await open(page);

  const peekDefault = await widthNow(peekSep(page));
  await drag(page, sideSep(page), 80);
  await drag(page, peekSep(page), -60);
  expect(await stored(page, SIDE_KEY)).not.toBeNull();
  expect(await stored(page, PEEK_KEY)).not.toBeNull();

  await sideSep(page).dblclick();
  expect(await widthNow(sideSep(page))).toBe(236);
  expect(await stored(page, SIDE_KEY)).toBeNull();
  // The peek's default follows the room it has, so it is back to the default
  // for a 236px sidebar.
  await peekSep(page).dblclick();
  expect(await stored(page, PEEK_KEY)).toBeNull();
  expect(await widthNow(peekSep(page))).toBe(peekDefault);

  await page.reload();
  await expect(sideSep(page)).toBeVisible({ timeout: 30_000 });
  expect(await widthNow(sideSep(page))).toBe(236);
  expect(await widthNow(peekSep(page))).toBe(peekDefault);
});

test("the widened peek ignores its width, and narrowing returns to it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const agent = await open(page);
  await startChat(page, stack.webUrl, agent, "layout width check");
  await expect(v3Peek(page).locator("[data-thread-panel]")).toBeVisible({
    timeout: 30_000,
  });

  await drag(page, peekSep(page), -50);
  const beside = await widthNow(peekSep(page));

  await v3Peek(page).getByTitle("Widen over the page", { exact: true }).click();
  await expect(peekSep(page)).toHaveCount(0);
  // Widened it covers the page: the whole room right of the sidebar.
  const room = 1440 - (await widthOf(v3Sidebar(page)));
  expect(Math.round(await widthOf(v3Peek(page)))).toBe(Math.round(room));

  await v3Peek(page)
    .getByTitle("Narrow, back beside the page", { exact: true })
    .click();
  await expect(peekSep(page)).toBeVisible();
  expect(await widthNow(peekSep(page))).toBe(beside);
  expect(Math.round(await widthOf(v3Peek(page)))).toBe(beside);
});

test("the sidebar hides, pops out over the page from the left edge, tucks away, and stays hidden after a reload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await open(page);
  const company = await companyName(page);
  const docked = await main(page).boundingBox();

  // Hide it from its own head: the page takes the room.
  await v3Sidebar(page).getByRole("button", { name: "Hide sidebar" }).click();
  await expect(v3Sidebar(page)).toBeHidden();
  await expect(sideSep(page)).toHaveCount(0);
  await expect.poll(async () => (await main(page).boundingBox())?.x).toBe(0);
  expect(await stored(page, HIDDEN_KEY)).toBe("1");
  // The top bar now carries what the sidebar did: its toggle, Search and the
  // company; the page and the peek are where they were.
  await expect(topBar(page)).toContainText(company);
  await expect(
    topBar(page).getByRole("button", { name: "Show sidebar" }),
  ).toBeVisible();
  await expect(
    topBar(page).getByRole("button", { name: "Search", exact: true }),
  ).toBeVisible();
  await expect(v3Peek(page)).toBeVisible();
  await page.screenshot({ path: "test-results/v3-layout/hidden.png" });

  // The state is remembered: a reload comes up hidden.
  await page.mouse.move(900, 500);
  await page.reload();
  await expect(v3Peek(page)).toBeVisible({ timeout: 30_000 });
  await expect(v3Sidebar(page)).toBeHidden();
  await expect(topBar(page)).toContainText(company);

  // Pointer at the left edge: it slides out over the page, which never moves.
  const hiddenMain = await main(page).boundingBox();
  await page.mouse.move(300, 400);
  await page.mouse.move(2, 400);
  await expect(v3Sidebar(page)).toBeVisible();
  await expect(v3Sidebar(page)).toHaveAttribute("data-sidebar", "popped");
  await expect
    .poll(async () => (await v3Sidebar(page).boundingBox())?.x)
    .toBe(0);
  const popMain = await main(page).boundingBox();
  expect(popMain?.x).toBe(hiddenMain?.x);
  expect(popMain?.width).toBe(hiddenMain?.width);
  expect(hiddenMain?.width).toBeGreaterThan(docked?.width ?? 0);
  await page.screenshot({ path: "test-results/v3-layout/popped.png" });

  // It is usable while out (a click goes where it says)…
  await v3Sidebar(page)
    .getByRole("button", { name: /^Threads/ })
    .click();
  await expect(page).toHaveURL(/page=threads/);
  // …and tucks away after the pointer leaves.
  await page.mouse.move(900, 500);
  await expect(v3Sidebar(page)).toBeHidden({ timeout: 5_000 });
  await expect(v3Sidebar(page)).toHaveAttribute("data-sidebar", "hidden");

  // Keep it docked from the top bar: it takes its room again and stays.
  await topBar(page).getByRole("button", { name: "Show sidebar" }).click();
  await expect(v3Sidebar(page)).toBeVisible();
  await expect(v3Sidebar(page)).toHaveAttribute("data-sidebar", "docked");
  expect(await stored(page, HIDDEN_KEY)).toBeNull();
  await page.reload();
  await expect(v3Sidebar(page)).toBeVisible({ timeout: 30_000 });
  await expect(sideSep(page)).toBeVisible();
});

test("a popped-out sidebar stays while the keyboard is in it; Esc tucks it before the peek", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await open(page);
  await v3Sidebar(page).getByRole("button", { name: "Hide sidebar" }).click();
  await expect(v3Sidebar(page)).toBeHidden();
  await page.mouse.move(900, 500);
  await page.reload();
  await expect(v3Peek(page)).toBeVisible({ timeout: 30_000 });
  await expect(v3Sidebar(page)).toBeHidden();

  await page.mouse.move(300, 400);
  await page.mouse.move(2, 400);
  await expect(v3Sidebar(page)).toHaveAttribute("data-sidebar", "popped");
  // Once it has slid in, Tab lands in it (it is first in the page); the
  // pointer leaves, the keyboard stays: so does the sidebar.
  await expect
    .poll(async () => (await v3Sidebar(page).boundingBox())?.x)
    .toBe(0);
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(
      () => !!document.activeElement?.closest("aside:not([aria-label])"),
    ),
  ).toBe(true);
  await page.mouse.move(900, 500);
  await page.waitForTimeout(900);
  await expect(v3Sidebar(page)).toBeVisible();

  // Esc tucks it, not the peek beside it, and the keyboard goes to the bar.
  await page.keyboard.press("Escape");
  await expect(v3Sidebar(page)).toBeHidden({ timeout: 5_000 });
  await expect(v3Peek(page)).toBeVisible();
  await expect(page).toHaveURL(/open=agent:/);
  await expect(
    topBar(page).getByRole("button", { name: "Show sidebar" }),
  ).toBeFocused();
  // A second Esc is the peek's, as ever.
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press("Escape");
  await expect(v3Peek(page)).toHaveCount(0);
});

test("⌘\\ hides and shows the sidebar", async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await expect(v3Sidebar(page)).toHaveAttribute("data-sidebar", "docked");

  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(v3Sidebar(page)).toBeHidden();
  await expect.poll(() => stored(page, HIDDEN_KEY)).toBe("1");

  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(v3Sidebar(page)).toBeVisible();
  await expect(v3Sidebar(page)).toHaveAttribute("data-sidebar", "docked");
  await expect.poll(() => stored(page, HIDDEN_KEY)).toBeNull();
});

test("each control appears once: one Search, one Widen/Narrow, the company named once", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const agent = await open(page);
  await startChat(page, stack.webUrl, agent, "layout duplicates check");
  await expect(v3Peek(page).locator("[data-thread-panel]")).toBeVisible({
    timeout: 30_000,
  });
  const company = await companyName(page);

  // Sidebar shown: Search is the sidebar's row, the bar has none and does not
  // repeat the company; the peek has one Widen and one Close.
  await expect(page.getByRole("button", { name: /^Search/ })).toHaveCount(1);
  await expect(
    v3Sidebar(page).getByRole("button", { name: /^Search/ }),
  ).toBeVisible();
  await expect(topBar(page)).not.toContainText(company);
  await expect(visibleCompany(page, company)).toHaveCount(1);
  await expect(page.getByRole("button", { name: /widen|narrow/i })).toHaveCount(
    1,
  );
  await expect(
    v3Peek(page).getByRole("button", { name: "Close", exact: true }),
  ).toHaveCount(1);
  await page.screenshot({ path: "test-results/v3-layout/once-docked.png" });

  // Sidebar hidden: the one Search is now the bar's icon, and the company is
  // named by the bar alone.
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(v3Sidebar(page)).toBeHidden();
  await expect(page.getByRole("button", { name: /^Search/ })).toHaveCount(1);
  await expect(
    topBar(page).getByRole("button", { name: "Search", exact: true }),
  ).toBeVisible();
  await expect(visibleCompany(page, company)).toHaveCount(1);
  await expect(topBar(page)).toContainText(company);
  await expect(page.getByRole("button", { name: /widen|narrow/i })).toHaveCount(
    1,
  );
  // The bar's Search is the same palette.
  await topBar(page)
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  // No "Ask the CEO" box: this app has no CEO draft to offer.
  await expect(page.getByText("Ask the CEO anything…")).toHaveCount(0);
});
