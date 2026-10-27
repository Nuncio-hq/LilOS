import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { setAccess } from "./helpers/approvals";
import {
  bootStack,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
} from "./helpers/stack";

/**
 * Issue #585 — system notes look like system notes, real app (apps/web over
 * relay + harness on engine-fake). AC-1 notes render as centred
 * `data-sysnote` rows — never Oscar's right-aligned bubble — and drop when
 * the turn beside them already shows the same status; AC-2 a denied
 * approval keeps the turn and its card ("You said no", #884); AC-3 message
 * search (⌘K's Messages group) labels a system note "LilOS", not Oscar.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-585");

/* The seeded employee. An id that names nobody opens the new-chat draft on
   the default agent, which on this one-agent stack is Default. */
const DEFAULT_AGENT = { id: "default", name: "Hermes" };

/** A new chat's thread in the side peek (past first run). */
const chat = async (stack: Stack, page: Page, text: string) => {
  await skipFirstRun(page);
  await startChat(page, stack.webUrl, DEFAULT_AGENT, text);
};

const send = async (page: Page, text: string) => {
  const box = page.locator("[data-thread-panel] textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const openCard = (page: Page) =>
  page.locator('[data-ask-id][data-ask-state="open"]');

test.describe.configure({ mode: "serial" });
test.use({ video: "on" });

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac585", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test("AC-1 a LilOS note renders centred, never as Oscar's bubble", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await chat(stack, page, "Say hello once");
  /* The pill lives on the thread, so the chat opens first; let that turn
     end or the next send would steer into it instead of starting its own. */
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });

  /* Full access → the gated step auto-approves and the harness posts a
     LilOS note ("Auto-approved … — Full access") into the thread. */
  await expect(
    page.locator('[data-thread-panel] [data-slot="access-pill"]'),
  ).toBeVisible({ timeout: 30_000 });
  await setAccess(page, "full");

  await send(page, "Add a footer to the page");
  const note = page.locator("[data-sysnote]", {
    hasText: /Auto-approved/,
  });
  await expect(note.first()).toBeVisible({ timeout: 60_000 });
  /* The centred note is its own row — it never carries a user or agent
     avatar, and it is not a right-aligned bubble. */
  await expect(note.first().locator("..")).not.toHaveClass(/justify-end/);
  await page.screenshot({ path: `${SHOTS}/ac-1-sysnote.png` });
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });
});

test("AC-1 a 'Stopped.' note drops beside the stopped turn it repeats", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await chat(stack, page, "slow: hold this turn while I stop it");
  /* Thread rows whose word is "stopped" also match /stop/i — name the
     button by its exact aria-label. */
  const stop = page.getByRole("button", { name: /^stop \(⌘\.\)$/i });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await stop.click();
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 60_000,
  });
  /* The turn shows "Stopped" itself — the bare note is a duplicate and
     never renders. */
  await expect(
    page.locator("[data-sysnote]", { hasText: /^Stopped\.?$/ }),
  ).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-1-stopped-dedupe.png` });
});

test("AC-2 a denied approval keeps the turn and its card", async ({ page }) => {
  test.setTimeout(180_000);
  await chat(stack, page, "Change the header color");
  const card = openCard(page).first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByRole("button", { name: "Deny", exact: true }).click();

  /* The card stays with "You said no" — a denied ask is a decision, not a
     failure, and the engine's silent end never blanks the turn out. */
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });
  const resolved = page.locator('[data-ask-id][data-ask-state="resolved"]', {
    hasText: /You said no/,
  });
  await expect(resolved.first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-denied-kept.png` });
});

test('AC-3 message search labels a system note "LilOS"', async ({ page }) => {
  test.setTimeout(180_000);
  await chat(stack, page, "Say hello once");
  /* engine-fake steers a send made mid-turn into the running turn, so the
     gated prompt below only runs as its own turn once this one has ended. */
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });
  /* Make a LilOS note searchable: Full access → "Auto-approved …" posts. */
  await expect(
    page.locator('[data-thread-panel] [data-slot="access-pill"]'),
  ).toBeVisible({ timeout: 30_000 });
  await setAccess(page, "full");
  await send(page, "Add a footer to the page");
  /* The turn ending is the signal, not this thread's own note: the harness
     dedupes its auto-approve note per channel on the engine's request id,
     and engine-fake numbers requests per session, so on this shared stack a
     later session's note is the same row AC-1 already made. Search covers
     the whole company, so it finds that row all the same. */
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });

  /* Search for the note's own word in ⌘K: the Messages group lists it, and
     says LilOS wrote it. */
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search" });
  await palette.locator("input").fill("Auto-approved");
  const hit = palette.locator("[data-message-hit]", {
    hasText: /Auto-approved/,
  });
  await expect(hit.first()).toBeVisible({ timeout: 30_000 });
  await expect(hit.first()).toContainText("LilOS");
  await expect(hit.first()).not.toContainText("Oscar");
  await page.screenshot({ path: `${SHOTS}/ac-3-search-lilos.png` });
});
