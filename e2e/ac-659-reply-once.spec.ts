import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #659 — an agent reply rendered twice in one thread (ac-134 strict
 * locators caught two identical <p>s in run 37543572110, shard 3).
 *
 * The race is cross-socket: the harness posts the completed answer as a
 * relay `message.created` row the instant `turn.completed` lands, while the
 * web model accumulates `turn.delta` frames on the separate feed socket —
 * the row can beat the stream's tail. `LILOS_FEED_DELAY_MS` paces feed
 * frames to one per 150 ms so the window is seconds wide and the duplicate
 * is deterministic, not lucky.
 *
 * AC-3: the assertion is a strict single-match locator polled across the
 * whole drain — a second surface fails immediately, same as ac-134.
 */

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("659", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
    LILOS_FEED_DELAY_MS: "150",
  });
});
test.afterAll(() => stack?.stop());

test.describe.configure({ mode: "serial" });

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

test("AC-1/2 a reply renders exactly once while the answer row beats the stream", async ({
  page,
}) => {
  test.setTimeout(120_000);
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

  /* First send opens the session; the follow-up answer is the #659 text
     ("Noted. Plan for this session now: …"). Both turns drain through the
     paced feed — every reply must render exactly once the whole time. */
  const thread = page.locator("[data-thread]");
  await send(page, "first marker");
  await expect(thread.getByText("If you want me to change code")).toBeVisible({
    timeout: 60_000,
  });

  const answer = thread.getByText("Noted. Plan for this session");
  await send(page, "second marker");
  /* ~60 frames × 150 ms ≈ 9 s of drain BEHIND turn 1's tail — the relay row
     lands at its head (~2 s) while the live card's streamed text only
     reaches the asserted prefix near the drain's tail. Poll `count()` until
     the turn settles (a second data-turnsettled appears): it answers
     instantly, so a bare row + streaming card (2 matches, the #659 dup)
     fails on that poll — a polling `toHaveCount`/`toBeVisible` would wait
     the transient out (or time out while the claimed row is legitimately
     invisible under the fix). */
  const settled = thread.locator("[data-turnsettled]");
  for (let i = 0; i < 400 && (await settled.count()) < 2; i++) {
    expect(await answer.count()).toBeLessThanOrEqual(1);
    await page.waitForTimeout(150);
  }
  /* Settled end state: the turn completed and exactly one answer surface
     remains in the thread. */
  expect(await settled.count()).toBeGreaterThanOrEqual(2);
  expect(await answer.count()).toBe(1);
});
