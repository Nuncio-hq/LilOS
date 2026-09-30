import { expect, type Locator, type Page } from "@playwright/test";

/** How long a turn may take to end once its approvals are answered (#257). */
export const TURN_END_TIMEOUT = 90_000;
/** Click → relay resolves → the card's wire state flips (#298). */
const ASK_RESOLVE_TIMEOUT = 15_000;
/** Between answers, the next gated step can take a beat to ask. */
const NEXT_CARD_WINDOW = 2_000;

/** data-turnsettled renders only once the turn is over (text lands earlier). */
export async function expectSettled(turn: Locator, timeout = TURN_END_TIMEOUT) {
  await expect(turn.locator("[data-turnsettled]")).toBeVisible({ timeout });
}

const openCard = (page: Page) =>
  page.locator('[data-ask-id][data-ask-state="open"]').first();

/* Ask-state reads go through evaluateAll: locator getAttribute auto-waits for
   the element to attach, and a resolved card is *replaced* by the next ask's
   card (the data-ask-id on the same slot changes) — reading it through a
   locator hangs the poll forever. evaluateAll returns [] on no match, so a
   missing card counts as resolved, not pending. */
const askStillOpen = (page: Page, askId: string) =>
  page
    .locator(`[data-ask-id="${askId}"]`)
    .evaluateAll((els) =>
      els.some((el) => el.getAttribute("data-ask-state") === "open"),
    );

async function answerOpenCard(page: Page, card: Locator) {
  const askId = await card.getAttribute("data-ask-id");
  if (!askId) throw new Error("approval card is missing data-ask-id");
  await card.getByRole("button", { name: /Allow once/i }).click();
  await expect
    .poll(() => askStillOpen(page, askId), {
      message: `ask ${askId} stayed open after "Allow once"`,
      timeout: ASK_RESOLVE_TIMEOUT,
    })
    .toBe(false);
}

/**
 * Answer every approval card on screen ("Allow once"), confirming each click
 * actually resolved the ask. After the last answer it keeps watching a short
 * window — the next gated step can take a beat to ask.
 */
export async function allowAll(page: Page) {
  for (let guard = 0; guard < 24; guard++) {
    const card = openCard(page);
    try {
      await card.waitFor({ state: "visible", timeout: NEXT_CARD_WINDOW });
    } catch {
      return; // nothing open and nothing arrived — all answered
    }
    await answerOpenCard(page, card);
  }
  throw new Error("allowAll: still answering after 24 approvals");
}

/**
 * Keep answering every approval that opens until `until` resolves — for
 * waits that outlive one card (a queued next turn can ask again, #298).
 * `until` is the caller's own expectation (e.g. `expectSettled(turn)`); it
 * is re-awaited at the end so its own failure surfaces.
 */
export async function allowAllWhile(page: Page, until: Promise<unknown>) {
  let done = false;
  void until
    .catch(() => {})
    .finally(() => {
      done = true;
    });
  for (let guard = 0; guard < 24 && !done; guard++) {
    const card = openCard(page);
    try {
      await card.waitFor({ state: "visible", timeout: 250 });
    } catch {
      continue; // no card open right now — poll until `until` lands
    }
    await answerOpenCard(page, card);
  }
  await until;
}
