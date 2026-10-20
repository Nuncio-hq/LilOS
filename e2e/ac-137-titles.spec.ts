import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  pickPorts,
  type Stack,
  startChat,
} from "./helpers/stack";

/**
 * Issue #137 — sessions name themselves: a placeholder from the first
 * message, then the engine's derived title, then its small-model (llm)
 * title — and a user rename always wins over a late engine title.
 * Runs the real stack (relay + harness + vite, engine-fake).
 *
 * v3: the title shows in the thread's header and on its row/card on the
 * Threads page; "title search" is the ⌘K palette. "Rename thread" is the ⋯
 * menu in the thread's header (and on its row), and AC-2 renames through it —
 * what it proves (the stored rename outranks a late engine title, on every
 * surface) is relay behaviour.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-137");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac137", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});
test.describe.configure({ mode: "serial" });
/* Wide enough for the Threads page to keep its title column beside an open
   panel: at the default 1280px the finished-thread row's fixed columns
   (agent, summary, time) leave the title zero pixels. */
test.use({
  trace: "retain-on-failure",
  viewport: { width: 1600, height: 900 },
});

/** The open thread's header title. */
const headerTitle = (page: Page) => page.locator("[data-session-title]");

/** The thread's title on the Threads page beside the panel. */
const listTitle = (page: Page, title: string) =>
  page.locator("#v3-main").getByText(title).first();

/** Stage ordering: placeholder < derived < llm — titles must never regress.
    The prompt avoids edit-verbs so engine-fake runs a clean read turn. */
const STAGE = [
  "Explain the whole repository layout in…", // placeholder: first 6 words + …
  "Explain the whole repository layout in detail p…", // derived: ≤48 chars
  "Explain The Whole Repository Layout In Detail Please", // llm upgrade
] as const;
const PROMPT = "Explain the whole repository layout in detail please";

test("AC-3/AC-4 placeholder then engine titles land live in header, list, search", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await openDefaultAgent(page, stack.webUrl);
  await startChat(page, stack.webUrl, agent, PROMPT);
  // A new thread opens beside Threads; its header carries the title.

  /* AC-4 "≤1 visible flicker placeholder → derived → llm": poll the header
     title and assert the observed stages only ever move forward. */
  const seen: string[] = [];
  const deadline = Date.now() + 60_000;
  for (;;) {
    const t =
      (await headerTitle(page)
        .textContent()
        .catch(() => "")) ?? "";
    if (t && seen.at(-1) !== t) seen.push(t);
    if (t === STAGE[2]) break;
    if (Date.now() > deadline)
      throw new Error(`title never reached the llm stage; trace: ${seen}`);
    await page.waitForTimeout(80);
  }
  const stages = seen.map((t) => STAGE.indexOf(t as (typeof STAGE)[number]));
  for (const t of seen) {
    expect(
      STAGE.includes(t as (typeof STAGE)[number]),
      `unexpected title "${t}" in trace ${seen}`,
    ).toBe(true);
  }
  for (let i = 1; i < stages.length; i++) {
    expect(stages[i], `title regressed: ${seen}`).toBeGreaterThan(
      stages[i - 1],
    );
  }
  expect(seen.at(-1)).toBe(STAGE[2]);
  await page.screenshot({ path: `${SHOTS}/ac34-header-llm-title.png` });

  // AC-4: the thread's row on the Threads page + title search show the
  // engine title. The send landed on `open=thread:` — the page and the
  // panel are already mounted.
  await expect(page).toHaveURL(/page=threads&open=thread:conv_[^&]+$/, {
    timeout: 10_000,
  });
  await expect(listTitle(page, STAGE[2])).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Search" });
  const hit = palette.getByRole("button", { name: /· thread$/ });
  await palette.locator("input").fill("Detail Please");
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText(STAGE[2]);
  await palette.locator("input").fill("zzz-no-match");
  await expect(hit).toHaveCount(0);
  await palette.locator("input").fill("");
  await page.screenshot({ path: `${SHOTS}/ac34-list-auto-title.png` });
});

test("AC-2 a mid-turn rename survives the late llm title", async ({ page }) => {
  test.setTimeout(120_000);
  const agent = await openDefaultAgent(page, stack.webUrl);
  /* "Add a footer" parks on an approval ask mid-turn: the derived title has
     landed but the llm title is still owed — a deterministic race window. */
  await startChat(page, stack.webUrl, agent, "Add a footer to the page");
  await expect(
    page.getByRole("button", { name: "Once", exact: true }).first(),
  ).toBeVisible({ timeout: 60_000 });

  // Rename the running thread: its row and header follow live.
  await expect(listTitle(page, "Add a footer to the page")).toBeVisible({
    timeout: 30_000,
  });
  const panel = page.locator("[data-thread-panel]");
  await panel
    .getByRole("button", { name: "Thread actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Rename thread" }).click();
  const input = panel.getByRole("textbox", { name: "Thread title" });
  await input.fill("My footer session");
  await input.press("Enter");
  await expect(listTitle(page, "My footer session")).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac2-renamed-mid-turn.png` });

  // Finish the turn: the canned flow asks more than once — keep answering
  // "Once" until it completes; the llm title must not overwrite the
  // rename. The turn text lives in the thread panel.
  const doneOn = page
    .locator("[data-thread-panel]")
    .getByText("Done on")
    .first();
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (await doneOn.isVisible().catch(() => false)) break;
    const allow = page
      .getByRole("button", { name: "Once", exact: true })
      .first();
    if (await allow.isVisible().catch(() => false)) await allow.click();
    if (Date.now() > deadline)
      throw new Error("turn never completed after answering approvals");
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1_500); // settle window for the late title write
  await expect(headerTitle(page)).toHaveText("My footer session");

  // Reload → reconnect replays the engine title; the rename still stands.
  await page.reload();
  await expect(headerTitle(page)).toHaveText("My footer session", {
    timeout: 30_000,
  });
  await expect(listTitle(page, "My footer session")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac2-rename-kept.png` });
});
