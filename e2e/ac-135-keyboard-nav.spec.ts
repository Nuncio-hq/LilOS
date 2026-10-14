import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Keyboard navigation: ⌘K opens the quick switcher over employees,
 * sessions (title + first message) and folders — Enter opens the pick.
 * ⌘/ shows the shortcut list. The web surface binds only the chords a
 * browser doesn't reserve (⌘N/⌘1–9 are Electron menu accelerators, covered
 * by apps/desktop's menu test); the prototype shows the same switcher.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-135");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("kbd", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

/** Land on Default's DM (dismissing the first-run card if present). */
async function dmDefault(page: Page) {
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

const switcher = (page: Page) => page.locator("[data-quick-switcher]");

test("⌘K opens the switcher, typing filters, Enter opens the session", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);

  /* Seed a session so the Sessions section has a row with first-message
     match text — and wait for the thread route so the switcher's session
     list provably holds it before ⌘K opens. */
  const box = page.locator("textarea").last();
  await box.fill("Keyboard nav sentinel session");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 15_000 });

  await page.keyboard.press("Meta+k");
  await expect(switcher(page)).toBeVisible();
  await expect(switcher(page).locator("input")).toBeFocused();
  /* Sections group employees, sessions and folders. */
  await expect(switcher(page).getByText("Employees")).toBeVisible();
  await expect(switcher(page).getByText("Sessions")).toBeVisible();

  /* Typing filters: a term living only in the session's title/message. */
  await switcher(page).locator("input").fill("sentinel");
  await expect(
    switcher(page).locator("[data-switcher-kind='session']").first(),
  ).toBeVisible();

  /* Enter opens the highlighted pick — a thread route loads. */
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 15_000 });
  await expect(switcher(page)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-k-session.png` });
});

test("⌘K employee pick lands on the DM; Esc closes the switcher", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await page.keyboard.press("Meta+k");
  await expect(switcher(page)).toBeVisible();

  /* Esc closes the switcher itself, nothing underneath. */
  await page.keyboard.press("Escape");
  await expect(switcher(page)).toHaveCount(0);

  await page.keyboard.press("Meta+k");
  await switcher(page).locator("input").fill("Default");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dm\//, { timeout: 15_000 });
});

test("⌘/ shows the shortcut list and Esc closes it", async ({ page }) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await page.keyboard.press("Meta+/");
  const dialog = page.locator("[data-shortcuts-dialog]");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Quick switcher", { exact: false }),
  ).toBeVisible();
  /* Desktop-only chords don't list on web. */
  await expect(dialog.getByText("⌘N")).toHaveCount(0);
  await expect(dialog.getByText(/⌘1/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-slash.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("⌘[ / ⌘] walk the navigation history", async ({ page }) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  const dmUrl = page.url();
  /* A send opens the thread route — two distinct history entries to walk. */
  const box = page.locator("textarea").last();
  await box.fill("history sentinel");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 15_000 });
  const threadUrl = page.url();
  await page.keyboard.press("Meta+[");
  await expect(page).toHaveURL(dmUrl, { timeout: 15_000 });
  await page.keyboard.press("Meta+]");
  await expect(page).toHaveURL(threadUrl, { timeout: 15_000 });
});

/* ---- the prototype (UI source of truth) shows the same switcher ---- */

test("prototype: ⌘K filters the seeded employees/sessions, Enter picks", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/");
  /* Hydration gates the keybinding — wait for the app chrome before ⌘K. */
  await expect(page.getByRole("button", { name: "Inbox" })).toBeVisible({
    timeout: 30_000,
  });
  await page.keyboard.press("Meta+k");
  const sw = switcher(page);
  await expect(sw).toBeVisible();
  await expect(sw.getByText("Employees")).toBeVisible();
  await sw.locator("input").fill("Builder");
  await page.keyboard.press("Enter");
  /* The pick landed on Builder's DM. */
  await expect(page.getByPlaceholder(/New thread with Builder/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(sw).toHaveCount(0);

  await page.keyboard.press("Meta+/");
  await expect(page.locator("[data-shortcuts-dialog]")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/prototype.png` });
});
