import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  pickPorts,
  relayRpc,
  type Stack,
  startChat,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #138 — full-text search inside sessions: ⌘K's Messages group finds
 * message text (AC-2), marks the matched term, shows archived sessions'
 * hits with an "archived" marker (AC-4), and picking a hit opens its thread
 * scrolled to and flashing that message (AC-3).
 *
 * The relay's index (`messages.search`, which the agents' own `thread_search`
 * tool uses too) is also checked over the wire: the palette always asks for
 * archived sessions too, so "archived only when asked" is the relay's own
 * contract and only the wire can show it.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-138");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  stack = await bootStack("ac138", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});
test.describe.configure({ mode: "serial" });

/* Terms live only inside messages (never in a title/first message), so a
   hit proves the message index — not a title match — found it.
   HIT_TEXT is a long message with the term near its end: the fake's reply
   echoes it back (a second long hit), and under the old 40-token excerpt the
   <mark> fell outside the one-line excerpt — the regression this spec guards. */
const HIT_TEXT =
  "deploy log for the ingest run: build green cache warm smoke tests " +
  "passed dashboards quiet queue drained workers healthy region failover " +
  "idle retries zero latency flat alarms silent and then the quaggmire " +
  "throttle kicked in mid-ingest";
const HIT_ARCHIVED = "quaggmire shows inside the archived session too";
const ROOT_A = "Summarize the repo layout in one line";
const ROOT_B = "Second session for the archive marker check";

interface Hit {
  messageId: string;
  conversationId: string | null;
  snippet: string;
}

const search = (page: Page, query: string, includeArchived: boolean) =>
  relayRpc<{ hits: Hit[] }>(page, stack, "messages.search", {
    query,
    includeArchived,
  }).then((r) => r.hits);

/** Send a follow-up from the open thread's own composer. */
async function followUp(page: Page, text: string) {
  const box = v3Peek(page)
    .locator("[data-thread-panel]")
    .getByPlaceholder(/^Message Hermes…$/);
  await box.fill(text);
  await box.press("Enter");
}

test("AC-2/3/4 message hits: found by message text, snippet marked, archived only on request, anchor in the thread", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const agent = await openDefaultAgent(page, stack.webUrl);

  /* engine-fake steers mid-turn sends into the running turn — a follow-up
     only gets its own reply once the composer is back to its idle
     placeholder ("Message Hermes…"). */
  const idleComposer = v3Peek(page)
    .locator("[data-thread-panel]")
    .getByPlaceholder(/^Message Hermes…$/);
  const panel = page.locator("[data-thread-panel]");

  // Session A: open, wait for the fake reply, then send a follow-up holding
  // the term — a message that is NOT the title or first message.
  const convA = await startChat(page, stack.webUrl, agent, ROOT_A);
  await expect(panel.getByText(/Short answer|Done on/i).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(idleComposer).toBeVisible({ timeout: 60_000 });
  await followUp(page, HIT_TEXT);
  await expect(panel.getByText(HIT_TEXT).first()).toBeVisible();
  /* The fake's follow-up reply echoes the message with its first letter
     capitalized, deep in its own text — waiting for "Deploy" makes the
     reply hit deterministic: its excerpt used to be clipped before the
     <mark> was reached. */
  await expect(
    panel.getByText(/Deploy log for the ingest run/).first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(idleComposer).toBeVisible({ timeout: 60_000 });

  // Session B: same shape, then archived — its hits only show on request.
  const convB = await startChat(page, stack.webUrl, agent, ROOT_B);
  await expect(panel.getByText(/Short answer|Done on/i).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(idleComposer).toBeVisible({ timeout: 60_000 });
  await followUp(page, HIT_ARCHIVED);
  await expect(panel.getByText(HIT_ARCHIVED).first()).toBeVisible();
  await expect(
    panel.getByText(/Quaggmire shows inside the archived session too/).first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(idleComposer).toBeVisible({ timeout: 60_000 });
  // Archive session B the way a person does: its row's menu on Threads → All.
  await page.goto(`${stack.webUrl}/#?page=threads`);
  const rowB = page.locator(`[data-thread-row="${convB}"]`);
  await expect(rowB).toBeVisible({ timeout: 30_000 });
  await rowB.hover();
  await rowB
    .getByRole("button", { name: "Thread actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Settle thread" }).click();
  await expect(rowB).toHaveCount(0, { timeout: 15_000 });

  // The index, over the wire: archived hits are left out until asked for.
  await expect
    .poll(async () => (await search(page, "quaggmire", false)).length, {
      timeout: 15_000,
    })
    .toBe(2);
  const live = await search(page, "quaggmire", false);
  expect(new Set(live.map((h) => h.conversationId))).toEqual(new Set([convA]));
  const all = await search(page, "quaggmire", true);
  // 4 hits: both user follow-ups + both fake replies echoing the term.
  expect(all).toHaveLength(4);
  expect(all.filter((h) => h.conversationId === convB)).toHaveLength(2);
  expect(all.filter((h) => h.conversationId === convA)).toHaveLength(2);
  for (const h of all) {
    expect(h.snippet, `hit ${h.messageId} lost its mark`).toMatch(
      /<mark>quaggmire<\/mark>/i,
    );
  }

  // AC-2: ⌘K's Messages group finds the term inside messages. Every hit row
  // keeps its matched term visibly marked inside its own box (the fake's
  // follow-up reply echoes the term deep in its text, which is exactly the
  // row that used to lose its mark).
  const palette = page.getByRole("dialog", { name: "Search" });
  await page.keyboard.press("ControlOrMeta+k");
  await palette.locator("input").fill("quaggmire");
  const hitRows = palette.locator("[data-message-hit]");
  await expect(hitRows).toHaveCount(4, { timeout: 15_000 });
  await expect(palette.getByText("Messages", { exact: true })).toBeVisible();
  for (let i = 0; i < 4; i++) {
    const row = hitRows.nth(i);
    await expect(row.locator("mark").first(), `hit row ${i}`).toHaveText(
      /quaggmire/i,
    );
    const rowBox = await row.boundingBox();
    const markBox = await row.locator("mark").first().boundingBox();
    expect(rowBox, `hit row ${i} has no box`).not.toBeNull();
    expect(markBox, `hit row ${i} mark is not rendered`).not.toBeNull();
    if (!rowBox || !markBox) continue;
    expect(markBox.x).toBeGreaterThanOrEqual(rowBox.x - 1);
    expect(markBox.y).toBeGreaterThanOrEqual(rowBox.y - 1);
    expect(markBox.x + markBox.width).toBeLessThanOrEqual(
      rowBox.x + rowBox.width + 1,
    );
    expect(markBox.y + markBox.height).toBeLessThanOrEqual(
      rowBox.y + rowBox.height + 1,
    );
  }
  // AC-4: the archived session's two hits carry the marker; session A's don't.
  await expect(palette.locator("[data-archived-hit]")).toHaveCount(2);
  await page.screenshot({ path: `${SHOTS}/ac2-message-hits.png` });

  // AC-3: picking the user's long follow-up is a palette jump — the thread
  // becomes the page (D-#769), scrolled to and flashing THAT message.
  const clicked = hitRows.filter({ hasText: "mid-ingest" }).first();
  const hitId = await clicked.getAttribute("data-message-hit");
  expect(hitId).toBeTruthy();
  await clicked.click();
  await expect(page).toHaveURL(
    new RegExp(`page=thread&id=${encodeURIComponent(convA)}`),
    { timeout: 10_000 },
  );
  await expect(panel).toBeVisible();
  const anchor = panel.locator(`[data-msg="${hitId}"]`);
  await expect(anchor).toBeVisible({ timeout: 15_000 });
  await expect(anchor).toContainText("mid-ingest");
  await expect(anchor).toHaveClass(/amber/, { timeout: 5_000 });
  await page.screenshot({ path: `${SHOTS}/ac3-hit-scrolled.png` });

  // A hit in an archived thread opens that thread too, and Unarchive is on
  // its menu: picking it brings the thread back to the list.
  await page.keyboard.press("ControlOrMeta+k");
  await palette.locator("input").fill("archived session too");
  const archivedHit = palette.locator("[data-message-hit]", {
    has: page.locator("[data-archived-hit]"),
  });
  await expect(archivedHit.first()).toBeVisible({ timeout: 15_000 });
  await archivedHit.first().click();
  await expect(page).toHaveURL(
    new RegExp(`page=thread&id=${encodeURIComponent(convB)}`),
    { timeout: 10_000 },
  );
  await panel
    .getByRole("button", { name: "Thread actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Un-settle thread" }).click();
  await page.goto(`${stack.webUrl}/#?page=threads`);
  await expect(page.locator(`[data-thread-row="${convB}"]`)).toBeVisible({
    timeout: 15_000,
  });

  // A term nowhere in any message finds nothing, archived included; ⌘K says so
  // with no Messages group.
  expect(await search(page, "definitely-not-anywhere", true)).toEqual([]);
  await page.keyboard.press("ControlOrMeta+k");
  await palette.locator("input").fill("definitely-not-anywhere");
  await page.waitForTimeout(600);
  await expect(palette.locator("[data-message-hit]")).toHaveCount(0);
  await expect(palette.getByText("Messages", { exact: true })).toHaveCount(0);
});
