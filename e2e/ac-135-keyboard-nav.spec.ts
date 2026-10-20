import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  pickPorts,
  type Stack,
  startChat,
  v3Peek,
} from "./helpers/stack";

/**
 * Keyboard navigation: ⌘K opens the search palette over people and threads
 * (a thread matches on its title, which is the first message until the
 * engine writes one) — Enter opens the pick beside the page you are on.
 * ⌘/ shows the shortcut list. The web surface binds only the chords a
 * browser doesn't reserve (⌘N/⌘1–9 are Electron menu accelerators, covered
 * by apps/desktop's menu test). ⌘[ / ⌘] walk the hash history.
 *
 * The old switcher's Employees/Sessions/Folders sections are gone: the v3
 * palette lists matches under one "Go to" group, each row naming what it is
 * (a person's role, "<agent> · thread").
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

const palette = (page: Page) => page.getByRole("dialog", { name: "Search" });

test("⌘K opens the palette, typing filters, Enter opens the thread", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await openDefaultAgent(page, stack.webUrl);

  /* Seed a thread so the palette has a row to match on its first message —
     and wait for its title to show so the palette's thread list provably
     holds it before ⌘K opens. */
  await startChat(page, stack.webUrl, agent, "Keyboard nav sentinel session");
  await expect(v3Peek(page).locator("[data-session-title]")).toContainText(
    /sentinel/i,
    { timeout: 30_000 },
  );
  // Close the peek: the pick must open it again, not find it already open.
  await page.goto(`${stack.webUrl}/#?page=threads`);
  await expect(v3Peek(page)).toHaveCount(0);

  await page.keyboard.press("Meta+k");
  await expect(palette(page)).toBeVisible();
  await expect(palette(page).locator("input")).toBeFocused();
  // With nothing typed the palette offers the pages to jump to.
  await expect(palette(page).getByText("Go to")).toBeVisible();

  /* Typing filters: a term living only in the thread's title/first message. */
  await palette(page).locator("input").fill("sentinel");
  const row = palette(page).getByRole("button", { name: /· thread$/ });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(`${agent.name} · thread`);

  /* Enter opens the highlighted pick — the thread opens beside Threads. */
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 15_000 });
  await expect(v3Peek(page).locator("[data-thread-panel]")).toBeVisible();
  await expect(palette(page)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-k-session.png` });
});

test("⌘K person pick lands on their page; Esc closes the palette", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await openDefaultAgent(page, stack.webUrl);
  await page.goto(`${stack.webUrl}/#?page=home`);
  await expect(v3Peek(page)).toHaveCount(0);

  await page.keyboard.press("Meta+k");
  await expect(palette(page)).toBeVisible();

  /* Esc closes the palette itself, nothing underneath. */
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);

  await page.keyboard.press("Meta+k");
  await palette(page).locator("input").fill(agent.name);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`open=agent:${encodeURIComponent(agent.id)}$`),
    { timeout: 15_000 },
  );
  await expect(v3Peek(page)).toBeVisible();
  await expect(palette(page)).toHaveCount(0);
});

test("⌘/ shows the shortcut list and Esc closes it", async ({ page }) => {
  test.setTimeout(120_000);
  await openDefaultAgent(page, stack.webUrl);
  await page.keyboard.press("Meta+/");
  const dialog = page.locator("[data-shortcuts-dialog]");
  await expect(dialog).toBeVisible();
  // The search chord is listed (the old row read "Quick switcher").
  await expect(dialog.getByText("⌘K")).toBeVisible();
  await expect(dialog.getByText(/Search — jump to/)).toBeVisible();
  /* Desktop-only chords don't list on web. */
  await expect(dialog.getByText("⌘N")).toHaveCount(0);
  await expect(dialog.getByText(/⌘1/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-slash.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("⌘[ / ⌘] walk the navigation history", async ({ page }) => {
  test.setTimeout(120_000);
  const agent = await openDefaultAgent(page, stack.webUrl);
  // The new-chat draft and the thread it becomes are two history entries.
  await page.goto(
    `${stack.webUrl}/#?page=threads&open=newchat:${encodeURIComponent(agent.id)}`,
  );
  const draftUrl = page.url();
  const box = v3Peek(page).getByPlaceholder(`Message ${agent.name}…`);
  await box.fill("history sentinel");
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 15_000 });
  const openedUrl = page.url();
  await page.keyboard.press("Meta+[");
  await expect(page).toHaveURL(draftUrl, { timeout: 15_000 });
  await page.keyboard.press("Meta+]");
  await expect(page).toHaveURL(openedUrl, { timeout: 15_000 });
});
