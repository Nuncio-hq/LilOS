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
 * Issue #583 — the app says what it's waiting for, real app (apps/web over
 * relay + harness on engine-fake). AC-1 while a turn waits on Oscar the
 * composer says so ("waiting for your approval…"), never "working"; AC-2
 * every thread row carries its state in words (Working / Needs you / Failed
 * on the Threads page); AC-3 a thread with a live background job says so in
 * the thread header. Issue #586 AC-1 rides along: the placeholder names the
 * employee, never an engine id.
 *
 * v3 notes: the old DM-home row had a "stopped" word, a "N replies" count
 * and a background-jobs badge. The v3 Threads rows carry none of those (a
 * stopped thread reads Finished; the stopped word lives on the turn card
 * inside the thread), so those row legs assert the surface that still says
 * it.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-583");

/* The seeded employee. An id that names nobody opens the new-chat draft on
   the default agent, which on this one-agent stack is Default. */
const DEFAULT_AGENT = { id: "default", name: "Default" };

/** A new chat's thread in the side peek (past first run). */
const chat = async (stack: Stack, page: Page, text: string) => {
  await skipFirstRun(page);
  await startChat(page, stack.webUrl, DEFAULT_AGENT, text);
};

/** The thread panel's composer box. */
const threadBox = (page: Page) =>
  page.locator("[data-thread-panel] textarea").last();

const send = async (page: Page, text: string) => {
  const box = threadBox(page);
  await box.fill(text);
  await box.press("Enter");
};

/** The Threads page's All list, where every thread is one row with its
    state pill — the v3 home of what the DM feed's rows said. */
async function threadsAll(stack: Stack, page: Page) {
  await page.goto(`${stack.webUrl}/#?page=threads&view=all`);
  await expect(page.getByText("Every agent thread, live.")).toBeVisible({
    timeout: 30_000,
  });
}

/** The row for the thread titled like `title` (the fake engine Title-Cases
    it, so match case-blind). */
const rowFor = (page: Page, title: RegExp) =>
  page.getByRole("button").filter({ hasText: title }).first();

const openCard = (page: Page) =>
  page.locator('[data-ask-id][data-ask-state="open"]');
/* The edit script raises one approval per mutating step (patch, write_file,
   git commit) — answer each open card until none remain so the turn can
   settle. */
async function answerOpenAsks(page: Page, name: string) {
  for (let i = 0; i < 8; i++) {
    const open = openCard(page);
    if ((await open.count()) === 0) return;
    await open.first().getByRole("button", { name, exact: true }).click();
    await page.waitForTimeout(400);
  }
}

test.describe.configure({ mode: "serial" });
test.use({ video: "on" });

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac583", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test("AC-1+#586 the composer names the employee, then says it's waiting for Oscar's approval", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:default`);

  /* #586 AC-1: the idle placeholder names the employee ("Message Default…"
     on the new-chat draft, "Reply to Default…" inside a thread) — never
     an engine ref like `20261006_…` or `emp_…`. */
  const draft = v3Peek(page).getByPlaceholder(/^Message /);
  await expect(draft).toHaveAttribute("placeholder", /Message Default…/);
  await expect(draft).not.toHaveAttribute("placeholder", /emp_|2026\d{4}/);
  await chat(stack, page, "Say hello once");
  const box = threadBox(page);
  await expect(box).toHaveAttribute("placeholder", /Reply to Default/, {
    timeout: 60_000,
  });
  await expect(box).not.toHaveAttribute("placeholder", /emp_|2026\d{4}/);

  /* AC-1: a turn parked on an approval — the composer says it waits on
     Oscar, not that it's "working". */
  await send(page, "Add a footer to the page");
  await expect(openCard(page).first()).toBeVisible({ timeout: 60_000 });
  await expect(box).toHaveAttribute(
    "placeholder",
    /Default is waiting for your approval/,
  );
  await expect(box).not.toHaveAttribute("placeholder", /working/i);
  await page.screenshot({ path: `${SHOTS}/ac-1-waiting-composer.png` });

  /* Answer Once on every card the turn raises so it finishes. */
  await answerOpenAsks(page, "Once");
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });
});

test("AC-1 a waiting plan says the same", async ({ page }) => {
  test.setTimeout(120_000);
  await chat(stack, page, "plan: propose a release checklist");
  /* The plan ask opens a card of its own; the composer tells Oscar he's
     holding the turn up. */
  const box = threadBox(page);
  await expect(box).toHaveAttribute(
    "placeholder",
    /waiting for your approval/,
    { timeout: 60_000 },
  );
  await page.screenshot({ path: `${SHOTS}/ac-1-waiting-plan.png` });
  /* Approve the plan so the turn closes before the next test. */
  /* Scoped to the thread: the Threads page's live card for this thread
     carries its own Approve button beside it. */
  const approve = page
    .locator("[data-thread-panel]")
    .getByRole("button", { name: /^Approve$/ });
  if (await approve.isVisible().catch(() => false)) await approve.click();
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });
});

test('AC-2 a thread row waiting on an approval says "Needs you"', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await chat(stack, page, "Change the header color");
  await expect(openCard(page).first()).toBeVisible({ timeout: 60_000 });
  await threadsAll(stack, page);
  /* The row itself says Needs you while Oscar hasn't answered. */
  const row = rowFor(page, /header color/i);
  await expect(row).toContainText("Needs you", { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-row-needs-you.png` });
  /* Deny → turn ends; the state word clears with the open card. The card
     lives in the thread view — open the row first. */
  await row.click();
  await openCard(page)
    .first()
    .getByRole("button", { name: "Deny", exact: true })
    .click();
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });
  await threadsAll(stack, page);
  await expect(rowFor(page, /header color/i)).not.toContainText("Needs you");
});

test("AC-2 a running turn and a failed turn each say so", async ({ page }) => {
  test.setTimeout(240_000);
  await chat(stack, page, "slow:200 keep the pace for a while");
  await expect(page.locator("[data-agentturn]").last()).toBeVisible({
    timeout: 30_000,
  });
  await threadsAll(stack, page);
  const running = rowFor(page, /keep the pace/i);
  await expect(running).toContainText("Working", { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-row-running.png` });
  /* The row's word clears once the turn ends. */
  await expect(running).not.toContainText("Working", { timeout: 120_000 });

  /* A turn that dies on an error reads "Failed" on its row. */
  await running.click();
  await send(page, "fail on purpose");
  await expect(page.locator("[data-turn-failed]").last()).toBeVisible({
    timeout: 90_000,
  });
  await threadsAll(stack, page);
  await expect(rowFor(page, /keep the pace/i)).toContainText("Failed", {
    timeout: 90_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-2-row-failed.png` });
});

test('AC-2 a stopped turn says "stopped"', async ({ page }) => {
  test.setTimeout(120_000);
  await chat(stack, page, "slow:150 hold this turn while I stop it");
  const stop = page.getByRole("button", { name: /^stop \(⌘\.\)$/i });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await stop.click();
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 60_000,
  });
  /* v3 rows have no "stopped" word (the thread reads Finished once nothing
     runs); the turn card inside the thread says it. */
  await expect(
    page.locator("[data-thread-panel] [data-agentturn]").last(),
  ).toContainText("Stopped");
  await threadsAll(stack, page);
  const row = rowFor(page, /hold this turn/i);
  await expect(row).not.toContainText("Working", { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-row-stopped.png` });
});

test("AC-2 the state words read in dark mode too", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem("lilos-theme", "dark"));
  await chat(stack, page, "fail again for the dark check");
  await threadsAll(stack, page);
  await expect(rowFor(page, /dark check/i)).toContainText("Failed", {
    timeout: 90_000,
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({ path: `${SHOTS}/ac-2-row-failed-dark.png` });
});

test("AC-3 a live background job says so in the thread", async ({ page }) => {
  test.setTimeout(180_000);
  await chat(stack, page, "start a dev server");
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });
  /* The dev-server job stays running past the turn — the open thread's
     header says so (v3's rows have no jobs badge of their own). */
  await expect(
    page.locator("[data-bg-jobs]").filter({ hasText: /running in background/ }),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-background-job.png` });
});

test("AC-2 the reply count on the thread divider skips system notes", async ({
  page,
}) => {
  test.setTimeout(180_000);
  /* Full access → the turn carries a LilOS note ("Auto-approved …") beside
     the agent's reply — the thread divider must count only the replies,
     skipping the note. (The old row-vs-divider parity is gone with the row's
     count: v3 rows carry none, so the divider is compared with the turns
     actually rendered.) */
  await chat(stack, page, "Say hello once");
  /* The pill lives on the thread, so the chat opens first; let that turn
     end or the next send would steer into it instead of starting its own. */
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });
  const pill = page.locator('[data-thread-panel] [data-slot="access-pill"]');
  await expect(pill).toBeVisible({ timeout: 30_000 });
  await pill.click();
  await expect(pill).toHaveAttribute("data-access", "full");
  await send(page, "Add a footer to the page");
  /* The settle anchor lives inside the agent turn's footer — scope it so
     no stubbed/older anchor can satisfy the wait early. */
  await expect(
    page.locator("[data-agentturn]").last().locator("[data-turnsettled]"),
  ).toBeVisible({ timeout: 90_000 });

  /* The open thread holds system notes — the count must skip them. */
  await expect(
    page.locator("[data-thread-panel] [data-sysnote]").first(),
  ).toBeVisible({ timeout: 30_000 });
  const divider = page
    .locator("[data-thread-panel]")
    .getByText(/^\d+ repl(?:y|ies)$/);
  /* The count renders "0 replies" while the opened thread's history is
     still replaying — wait for the settled non-zero value, not just
     visibility. */
  await expect(divider.first()).toHaveText(/^[1-9]\d* repl/, {
    timeout: 30_000,
  });
  const dividerCount = Number(
    (await divider.first().innerText()).match(/(\d+)/)?.[1],
  );
  /* The rows under the divider, minus the opener and minus the system
     notes: what "N replies" must equal. */
  const replies = await page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll(
        "[data-thread-panel] [role='log'] [data-msg]",
      ),
    ];
    const notes = rows.filter((r) => r.querySelector("[data-sysnote]")).length;
    return rows.length - 1 - notes;
  });
  expect(dividerCount).toBe(replies);
});
