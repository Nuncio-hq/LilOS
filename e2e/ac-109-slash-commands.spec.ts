import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #109 — engine slash commands + skills in the composer, end to end
 * on the real stack (relay + harness + vite dev, engine-fake). engine-fake
 * declares the `commands` capability with a fixed catalog: /help, /compact,
 * /usage (commands) + /review, /brainstorm (skills). Commands exec with a
 * canned output; a skill expands to the prompt the next turn runs, which
 * the fake echoes back — that echo is the AC proof the engine ran it.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-109");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac109", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

/* The slash menu lives on the thread composer and on the new-chat draft
   beside Threads (the old home composer's: its commands are the agent's and
   the chosen folder's, asked before any session exists). Most tests open a
   chat with Default, let its first turn settle, and drive the thread composer
   in the peek; the draft has its own legs at the end. */
async function chatDefault(page: Page) {
  await skipFirstRun(page);
  await startChat(
    page,
    stack.webUrl,
    { id: "default", name: "Hermes" },
    "Say hello",
  );
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 60_000,
  });
}

const box = (page: Page) =>
  v3Peek(page).locator("[data-thread-panel] textarea");
const menu = (page: Page) => page.getByRole("listbox", { name: "Commands" });
const rows = (page: Page) => page.locator("[data-slash-command]");

async function sendDraft(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press("Enter");
}

test("AC menu lists commands + skills, typing filters, Esc dismisses", async ({
  page,
}) => {
  await chatDefault(page);
  await box(page).click();
  await page.keyboard.type("/");
  await expect(rows(page)).toHaveCount(5, { timeout: 15_000 });
  await expect(page.locator('[data-slash-command="help"]')).toBeVisible();
  await expect(page.locator('[data-slash-command="review"]')).toHaveAttribute(
    "data-kind",
    "skill",
  );
  await expect(page.locator('[data-slash-command="usage"]')).toHaveAttribute(
    "data-kind",
    "command",
  );
  await page.screenshot({ path: `${SHOTS}/ac-menu.png` });

  /* Typing filters against the same engine list. */
  await page.keyboard.type("rev");
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('[data-slash-command="review"]')).toBeVisible();

  /* Esc dismisses; the draft stays `/rev`. */
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
});

test("AC Enter inserts and sending execs the command in the engine", async ({
  page,
}) => {
  await chatDefault(page);
  await box(page).click();
  await page.keyboard.type("/usa");
  await expect(rows(page)).toHaveCount(1, { timeout: 15_000 });
  await page.keyboard.press("Enter");
  await expect(box(page)).toHaveValue(/\/usage\s*$/);
  await page.screenshot({ path: `${SHOTS}/ac-inserted.png` });

  /* Sending runs commands.exec: the fake's canned output lands as the
     employee's reply in the thread. */
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Usage: in \d+ \/ out \d+/).last()).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-exec-output.png` });
});

test("AC a skill expands into the next turn like the Hermes TUI", async ({
  page,
}) => {
  await chatDefault(page);
  await sendDraft(page, "/review src/auth");
  /* outcome:"prompt" → the harness sends the expanded prompt as the next
     turn; engine-fake echoes it as the agent's reply. */
  await expect(
    page.getByText("Run the review skill with: src/auth").last(),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-skill-expanded.png` });
});

test("AC /model opens the picker the surface already owns", async ({
  page,
}) => {
  await chatDefault(page);
  await sendDraft(page, "/model");
  await expect(
    page
      .getByRole("dialog")
      .or(page.locator('[aria-label="Model and reasoning"]')),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-model-picker.png` });
});

/** The new-chat draft's box. */
const draftBox = (page: Page) =>
  v3Peek(page).getByPlaceholder("Message Hermes…");

test("AC the new-chat draft lists the commands too, and /model opens its own picker", async ({
  page,
}) => {
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:default`);
  await expect(draftBox(page)).toBeVisible({ timeout: 30_000 });
  await draftBox(page).click();
  await page.keyboard.type("/");
  await expect(rows(page)).toHaveCount(5, { timeout: 15_000 });
  await expect(page.locator('[data-slash-command="help"]')).toBeVisible();
  await page.keyboard.type("rev");
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(draftBox(page)).toHaveValue(/\/review\s*$/);
  await page.screenshot({ path: `${SHOTS}/ac-draft-menu.png` });

  // `/model` is the app's: it opens the draft's picker and sends nothing.
  await draftBox(page).fill("/model");
  await draftBox(page).press("Enter");
  await expect(
    page
      .getByRole("dialog")
      .or(page.locator('[aria-label="Model and reasoning"]')),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page).not.toHaveURL(/open=thread:/);
  await page.screenshot({ path: `${SHOTS}/ac-draft-model-picker.png` });
});
