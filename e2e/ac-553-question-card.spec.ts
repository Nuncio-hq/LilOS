import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  type Stack,
  startChatInFolder,
} from "./helpers/stack";

/**
 * Issue #553 — a real `question` ask shows the shared card (options + free
 * text) on desktop, and an answer resolves the ask while the turn continues
 * (AC-1/AC-2). The `question:` engine-fake prompt opens the ask
 * (packages/engine-fake runQuestionTurn); the card is packages/ui's
 * QuestionCard — the same component the phone renders (AC-1 "matching
 * #420's prototype"). Answering rides asks.respond → the engine resolves →
 * the card flips to its "Answered …" receipt and the turn finishes.
 */

const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-553-"));
const repoDir = path.join(ROOT, "lilos-repo");
mkdirSync(repoDir, { recursive: true });
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
git(["init", "-b", "trunk"]);
writeFileSync(path.join(repoDir, "a.txt"), "alpha\n");
git(["add", "."]);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac553", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});
test.describe.configure({ mode: "serial" });

/* The seeded employee. An id that names nobody opens the new-chat draft on
   the default agent, which on this one-agent stack is Default. */
const DEFAULT_AGENT = { id: "default", name: "Default" };

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

/* The open shared card: data-question-card is packages/ui's QuestionCard —
   the same node the phone renders (AC-1 "matching #420's prototype"). */
const openCard = (page: Page) =>
  page.locator('[data-question-card][data-ask-state="open"]');

/* Under a resolved question card the settled marker collapses to h-0
   (#515 r4 — the receipt already says the turn ended), so "the turn
   finished" is an attachment assertion here, not a visibility one. */
const expectSettledHidden = async (turn: Locator) => {
  await expect(turn.locator("[data-turnsettled]")).toBeAttached({
    timeout: 90_000,
  });
};

test("AC-1/AC-2 #553: the shared card opens; an option tap resolves the ask and the turn continues", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  /* The new-chat draft's folder chip picks the repo; the send lands on the
     thread in the side peek, where the card renders. */
  await startChatInFolder(
    page,
    stack,
    DEFAULT_AGENT,
    repoDir,
    "question: pick the ship target",
  );

  /* AC-1 — the shared card: the engine's question, its two options, and a
     free-text field (freeText ask), all inside data-question-card. */
  const card = openCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(
    card.getByText("Which environment should this change ship to?"),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Staging first" }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Straight to prod" }),
  ).toBeVisible();
  await expect(card.getByLabel("Your answer")).toBeVisible();

  /* AC-2 — an option tap sends asks.respond answer="staging": the card
     flips to its answered receipt and the turn carries on. */
  const turn = page.locator("[data-agentturn]").last();
  await card.getByRole("button", { name: "Staging first" }).click();
  await expect(
    page.locator('[data-question-card][data-ask-state="resolved"]'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/Answered “Staging first” by/).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(turn.getByText(/going with "Staging first"/)).toBeVisible({
    timeout: 30_000,
  });
  await expectSettledHidden(turn);
});

test("AC-2 #553: a typed answer echoes and the turn continues; Skip cancels the turn", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  await startChatInFolder(
    page,
    stack,
    DEFAULT_AGENT,
    repoDir,
    "question: pick the ship target",
  );
  const card = openCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });

  const turn = page.locator("[data-agentturn]").last();
  await card.getByLabel("Your answer").fill("the demo box");
  await card.getByRole("button", { name: /^Answer$/ }).click();
  await expect(
    page.getByText(/Answered “the demo box” by/).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(turn.getByText(/going with "the demo box"/)).toBeVisible({
    timeout: 30_000,
  });
  await expectSettledHidden(turn);

  /* Skip → asks.respond "cancel" — the receipt names it and the turn dies. */
  await send(page, "question: and the target again");
  const card2 = openCard(page);
  await expect(card2).toBeVisible({ timeout: 30_000 });
  const turn2 = page.locator("[data-agentturn]").last();
  await card2.getByRole("button", { name: /Skip/ }).click();
  await expect(page.getByText(/Cancelled by/).first()).toBeVisible({
    timeout: 15_000,
  });
  await expectSettledHidden(turn2);
});
