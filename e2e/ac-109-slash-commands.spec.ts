import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

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

async function dmDefault(page: Page) {
  await page.goto(stack.webUrl);
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

const box = (page: Page) => page.locator("textarea").first();
const menu = (page: Page) => page.getByRole("listbox", { name: "Commands" });
const rows = (page: Page) => page.locator("[data-slash-command]");

async function sendDraft(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press("Enter");
}

test("AC menu lists commands + skills, typing filters, Esc dismisses", async ({
  page,
}) => {
  await dmDefault(page);
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
  await dmDefault(page);
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
  await dmDefault(page);
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
  await dmDefault(page);
  await sendDraft(page, "/model");
  await expect(
    page
      .getByRole("dialog")
      .or(page.locator('[aria-label="Model and reasoning"]')),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-model-picker.png` });
});
