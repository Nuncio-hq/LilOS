import { expect, type Locator, type Page, test } from "@playwright/test";
import { v3Main, v3Peek, v3Sidebar } from "./helpers/stack";

/**
 * Issue #886 — one calm composer, one composer on screen, a real access
 * menu, and a window that works when it is narrow. Prototype app, mock
 * company. ACs covered here:
 *   - agent · folder · model/effort · access stay on ONE row at 1288 px and
 *     at 390 px (icons only when narrow), "direct · no git" and the cut-off
 *     key hint are gone;
 *   - Ask/Full is a menu, and Full needs a menu choice plus a one-time
 *     confirm — one click on the pill never switches it;
 *   - a thread open beside Home leaves exactly one composer on screen;
 *   - the sidebar's Threads entry carries no count (Needs you keeps its
 *     badge), and under ~700 px the sidebar collapses behind its toggle
 *     while the greeting reads full width.
 * The thread-header side of the same issue lives in v3-thread-header.spec.
 */
const DRAFT = "/?page=threads&open=newchat:builder";
const THREAD_BESIDE_HOME = "/?page=home&open=thread:t-hb12-build";

const main = (page: Page) => v3Main(page);
const peek = (page: Page) => v3Peek(page);

async function box(el: Locator) {
  const b = await el.boundingBox();
  expect(b, "the element has a box").not.toBeNull();
  return b as NonNullable<typeof b>;
}
const mid = (b: { y: number; height: number }) => b.y + b.height / 2;

/** The draft composer's four controls — the row #886 holds to one line. */
function controls(peekEl: Locator) {
  return {
    agent: peekEl.getByTitle("Agent", { exact: true }),
    project: peekEl.getByTitle(/^Project · /),
    model: peekEl.locator('[data-slot="model-picker-trigger"]'),
    access: peekEl.locator('[data-slot="access-pill"]'),
    send: peekEl.getByRole("button", { name: "Send" }),
  };
}

/** All of `controls` visible and mid-aligned — one row, never a stack. */
async function expectOneRow(peekEl: Locator, c = controls(peekEl)) {
  const boxes = await Promise.all(
    [c.agent, c.project, c.model, c.access, c.send].map(async (el) => {
      await expect(el).toBeVisible();
      return box(el);
    }),
  );
  const mids = boxes.map(mid);
  for (const m of mids)
    expect(Math.abs(m - mids[0]), "chips share one row").toBeLessThan(8);
  // …and the row reads left to right: chips, then Send.
  for (let i = 1; i < boxes.length; i++)
    expect(boxes[i].x).toBeGreaterThan(boxes[i - 1].x);
}

test("composer keeps its controls on one row at 1288 px, quiet labels dropped", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1288, height: 800 });
  await page.goto(DRAFT);
  const box = peek(page).getByPlaceholder("Message Builder…");
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expectOneRow(peek(page));

  /* The audit's clutter is gone: no "direct · no git" project label, no
     cut-off key hint line under the row. */
  await expect(peek(page).getByText(/direct ·|no git/)).toHaveCount(0);
  await expect(peek(page).locator(".lilos-hint")).toHaveCount(0);
  /* …and the access pill now owns a menu, not a one-click toggle. */
  await expect(controls(peek(page)).access).toHaveAttribute(
    "aria-haspopup",
    "menu",
  );
});

test("at 390 px the same row holds as icons, and the composer still sends", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(DRAFT);
  const input = peek(page).getByPlaceholder("Message Builder…");
  await expect(input).toBeVisible({ timeout: 30_000 });
  await expectOneRow(peek(page));

  /* Narrow = icons: the words step aside but the buttons stay reachable —
     the agent chip drops its name and shrinks to the avatar. */
  const agent = controls(peek(page)).agent;
  await expect(agent.getByText("Builder", { exact: true })).not.toBeVisible();
  const a = await box(agent);
  expect(a.width, "agent chip collapses to its icon").toBeLessThan(48);
  const pill = controls(peek(page)).access;
  await expect(pill.getByText("Ask", { exact: true })).not.toBeVisible();

  /* Usable: type and the Send button arms (the keys do what the dropped
     hint described). */
  await input.fill("hi there");
  await expect(controls(peek(page)).send).toBeEnabled();
});

test("access is a menu: a choice plus a one-time confirm for Full", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1288, height: 800 });
  await page.goto(DRAFT);
  const pill = controls(peek(page)).access;
  await expect(pill).toBeVisible({ timeout: 30_000 });
  await expect(pill).toHaveAttribute("data-access", "ask");

  /* One click opens the menu; it does not switch anything. */
  await pill.click();
  await expect(pill).toHaveAttribute("data-access", "ask");
  const menu = page.getByRole("menu", { name: "Access", exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-access-option="ask"]')).toContainText(
    "The agent asks before risky commands.",
  );
  await expect(menu.locator('[data-access-option="full"]')).toContainText(
    "The agent never stops to ask.",
  );

  /* Picking Full is still not the switch — it asks once, worded exactly. */
  await page.locator('[data-access-option="full"]').click();
  await expect(pill).toHaveAttribute("data-access", "ask");
  await expect(
    page.getByText("Agents run tools without asking in this thread"),
  ).toBeVisible();

  /* Confirming switches; switching back to Ask never asks. */
  await page.locator("[data-access-confirm]").click();
  await expect(pill).toHaveAttribute("data-access", "full");
  await pill.click();
  await page.locator('[data-access-option="ask"]').click();
  await expect(pill).toHaveAttribute("data-access", "ask");
});

test("a thread open beside Home leaves one composer on screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1288, height: 800 });
  await page.goto("/?page=home");
  await expect(main(page).getByPlaceholder(/Message /)).toBeVisible({
    timeout: 30_000,
  });

  /* Open the thread beside it: Home's box steps aside, the thread's is the
     one composer left on screen. */
  await page.goto(THREAD_BESIDE_HOME);
  await expect(peek(page).locator("[data-composer] textarea")).toBeVisible({
    timeout: 30_000,
  });
  await expect(main(page).locator("[data-composer]")).toHaveCount(0);
  await expect(page.locator("[data-composer]")).toHaveCount(1);

  /* Closing the peek brings Home's box straight back. */
  await peek(page).getByRole("button", { name: "Close" }).click();
  await expect(main(page).getByPlaceholder(/Message /)).toBeVisible({
    timeout: 30_000,
  });
});

test("the sidebar's Threads row carries no count; Needs you keeps its badge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1288, height: 800 });
  await page.goto("/?page=home");
  const side = v3Sidebar(page);
  await expect(side).toBeVisible({ timeout: 30_000 });
  await expect(
    side.getByRole("button", { name: "Threads", exact: true }),
  ).toBeVisible();
  await expect(
    side.getByRole("button", { name: /^Needs you \d+$/ }),
  ).toBeVisible();
});

test("below ~700 px the sidebar collapses behind its toggle and the greeting reads", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/?page=home");

  /* Docked → hidden on the way down: the shell keeps only the ☰-style
     toggle (and Search) in the toolbar. */
  await expect(page.locator('[data-sidebar="hidden"]')).toHaveCount(1);
  await expect(v3Sidebar(page)).not.toBeVisible();
  const toggle = page.getByRole("button", { name: "Show sidebar" });
  await expect(toggle).toBeVisible({ timeout: 30_000 });

  /* The greeting is smaller, not clipped: it fits the window's width. */
  const greeting = main(page).getByRole("heading", {
    name: /Good (morning|afternoon|evening)/,
  });
  await expect(greeting).toBeVisible();
  const g = await box(greeting);
  expect(g.x).toBeGreaterThanOrEqual(0);
  expect(g.x + g.width).toBeLessThanOrEqual(390);
  const size = await greeting.evaluate((el) => getComputedStyle(el).fontSize);
  expect(parseFloat(size)).toBeLessThanOrEqual(30.5);

  /* ☰ pops the sidebar over the page (not docked); Esc tucks it back. */
  await toggle.click();
  const popped = page.locator('[data-sidebar="popped"]');
  await expect(popped).toBeVisible();
  await expect(
    popped.getByRole("button", { name: "Threads", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popped).not.toBeVisible();
});

test("widening back re-docks only the sidebar the window itself hid", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/?page=home");
  await expect(page.locator('[data-sidebar="hidden"]')).toHaveCount(1, {
    timeout: 30_000,
  });
  await page.setViewportSize({ width: 1288, height: 800 });
  await expect(page.locator('[data-sidebar="docked"]')).toHaveCount(1);
});
