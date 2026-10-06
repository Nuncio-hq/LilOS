import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #558 — answer approval/plan cards from the keyboard. ↵ allows once
 * (or approves a plan), ⌫ denies (or rejects) — Esc is never an answer
 * (#576 keeps it close-only). The keys act only on the newest waiting card
 * in the visible thread, and never while typing in the composer. The card
 * that owns the keys shows the shortcut hint.
 *
 * engine-fake: an EDIT_ASK prompt ("update the readme") parks a gated step
 * on an approval card; `plan: propose — <title>` lands a waiting plan card.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-558");

let stackA: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stackA = await bootStack("askk", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
  });
});
test.afterAll(async () => {
  await stackA?.stop();
});

test.describe.configure({ mode: "serial" });

/** Bare JSON-RPC client (e2e runs under Node without workspace deps). */
async function askOutcome(
  stack: Stack,
  askId: string,
): Promise<string | undefined> {
  const ws = new WebSocket(stack.relayWs);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  const pending = new Map<string, (r: Record<string, unknown>) => void>();
  ws.onmessage = (e) => {
    const f = JSON.parse(e.data as string) as Record<string, unknown>;
    if (typeof f.id === "string") pending.get(f.id)?.(f);
  };
  const send = (id: string, method: string, params: object) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      pending.set(id, (f) =>
        f.error
          ? rej(new Error(`${method} -> ${JSON.stringify(f.error)}`))
          : res(f),
      );
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  await send("h", "session.hello", { protocolVersion: 1, token: stack.relayToken });
  const res = await send("0", "asks.list", {});
  ws.close();
  const asks = (res.result as { asks: { id: string; outcome?: string }[] })
    .asks;
  return asks.find((a) => a.id === askId)?.outcome;
}

async function dmDefault(stack: Stack, page: Page) {
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

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const openCard = (page: Page) =>
  page.locator('[data-ask-id][data-ask-state="open"]').first();

/* Keyboard answers must arrive on page chrome — blur the field so the press
   targets <body> (the keys never fire while typing in the composer). */
const blurPage = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

test("AC-558-1 a waiting approval card shows the hint and ↵ allows once", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(stackA, page);
  /* `slow:` keeps the turn live after the answer lands — the resolved
     card's "Allowed once" label lives only while its turn does. */
  await send(page, "slow:150 update the readme with a release note");
  const card = openCard(page);
  await expect(card).toBeVisible({ timeout: 60_000 });
  const askId = await card.getAttribute("data-ask-id");

  // The focused (only pending) card shows the shortcut hint.
  const hint = card.locator("[data-ask-keyhint]");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("↵ Allow once");
  await expect(hint).toContainText("⌫ Deny");
  await page.screenshot({ path: `${SHOTS}/ac-1-hint.png` });

  // Esc is NOT an answer — the card waits.
  await blurPage(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await expect(
    page.locator(`[data-ask-id="${askId}"][data-ask-state="open"]`),
  ).toBeVisible();

  // ↵ on page chrome answers it — same label the Once button writes.
  await page.keyboard.press("Enter");
  await expect
    .poll(
      () =>
        page
          .locator(`[data-ask-id="${askId}"]`)
          .evaluateAll((els) =>
            els.some((el) => el.getAttribute("data-ask-state") === "open"),
          ),
      { timeout: 15_000 },
    )
    .toBe(false);
  await expect(page.getByText(/Allowed once by Oscar/).first()).toBeVisible({
    timeout: 15_000,
  });
  // The relay-side outcome is the durable proof: ↵ allowed once.
  await expect(await askOutcome(stackA, askId)).toBe("once");
  await page.screenshot({ path: `${SHOTS}/ac-1-allowed.png` });
});

test("AC-558-2 ⌫ denies; typing in the composer never answers the card", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(stackA, page);
  await send(page, "slow:150 update the readme with a release note");
  const card = openCard(page);
  await expect(card).toBeVisible({ timeout: 60_000 });
  const askId = await card.getAttribute("data-ask-id");
  const openAsk = page.locator(
    `[data-ask-id="${askId}"][data-ask-state="open"]`,
  );

  // While typing in the composer, the keys belong to the text, not the card.
  const box = page.locator("textarea").last();
  await box.click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  await box.fill("a note typed while the card waits");
  await page.keyboard.press("Backspace"); // deletes a char, answers nothing
  await page.waitForTimeout(300);
  await expect(openAsk).toBeVisible();

  // ⌫ on page chrome denies.
  await blurPage(page);
  await page.keyboard.press("Backspace");
  await expect
    .poll(
      () =>
        page
          .locator(`[data-ask-id="${askId}"]`)
          .evaluateAll((els) =>
            els.some((el) => el.getAttribute("data-ask-state") === "open"),
          ),
      { timeout: 15_000 },
    )
    .toBe(false);
  /* A deny ends the turn at once — no card (and no label) survives the
     settle, so the assertion is the relay-side outcome, not the DOM. */
  await expect(await askOutcome(stackA, askId)).toBe("deny");
  await page.screenshot({ path: `${SHOTS}/ac-2-denied.png` });
});

test("AC-558-3 a waiting plan card answers with ↵ approve / ⌫ reject", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await dmDefault(stackA, page);

  // ↵ approves — the card carries the hint while it waits.
  await send(page, "plan: propose — approve from keys");
  const proposed = page
    .locator('[data-plan][data-planstatus="proposed"]')
    .last();
  await expect(proposed).toHaveAttribute("data-planphase", "waiting", {
    timeout: 60_000,
  });
  /* Track the card by its plan id — approving flips data-planstatus, so
     the proposed-locator would lose it mid-assertion. */
  const planIdA = await proposed.getAttribute("data-plan");
  const planA = page.locator(`[data-plan="${planIdA}"]`);
  const hint = planA.locator("[data-ask-keyhint]");
  await expect(hint).toContainText("↵ Approve");
  await expect(hint).toContainText("⌫ Reject");
  await page.screenshot({ path: `${SHOTS}/ac-3-plan-hint.png` });
  await blurPage(page);
  await page.keyboard.press("Enter");
  await expect(planA).toHaveAttribute("data-planstatus", "approved", {
    timeout: 15_000,
  });

  // ⌫ rejects the next one.
  await send(page, "plan: propose — reject from keys");
  const proposedB = page
    .locator('[data-plan][data-planstatus="proposed"]')
    .last();
  await expect(proposedB).toHaveAttribute("data-planphase", "waiting", {
    timeout: 60_000,
  });
  const planIdB = await proposedB.getAttribute("data-plan");
  const planB = page.locator(`[data-plan="${planIdB}"]`);
  await blurPage(page);
  await page.keyboard.press("Backspace");
  await expect(planB).toHaveAttribute("data-planstatus", "rejected", {
    timeout: 15_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-3-plan-rejected.png` });
});
