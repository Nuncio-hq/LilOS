import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
} from "./helpers/stack";

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
  /* The first send opens the session; the follow-up answer is the #659 text
     ("Noted. Plan for this session now: …"). Both turns drain through the
     paced feed — every reply must render exactly once the whole time. The
     new chat is Default's draft beside Threads (60 s for the boot, not the
     usual 30: under --repeat-each the previous iteration's paced drain can
     still be clearing when the next page boots — repeat 18 of the x20 leg
     flaked on the old sidebar wait, and the dup assertion never ran). */
  await skipFirstRun(page);
  const thread = page.locator("[data-thread]");
  await startChat(
    page,
    stack.webUrl,
    { id: "default", name: "Hermes" },
    "first marker",
  );
  /* #577: a send opens the thread in the peek — hop into the session view
     so [data-thread] and the rest of this spec see the same surface the
     soak was written against. */
  await panelIntoFocus(page);
  await expect(thread.getByText("If you want me to change code")).toBeVisible({
    timeout: 60_000,
  });

  const answer = thread.getByText("Noted. Plan for this session");
  await send(page, "second marker");
  /* The paced queue holds both turns' ~120 frames ≈ 18 s of drain; the
     relay row lands ~2 s in while the live card's streamed text only
     reaches the asserted prefix near the drain's tail — the duplicate
     window opens there. Soak it: `count()` answers instantly, so a bare
     row + streaming card (2 matches, the #659 dup) fails on that poll.
     A `toBeVisible`/`toHaveCount` poll would wait the transient out, and
     `data-turnsettled` can't bound the window — a still-unclaimed bare
     row renders it too (its phase is already "done"). */
  const deadline = Date.now() + 30_000;
  do {
    expect(await answer.count()).toBeLessThanOrEqual(1);
    await page.waitForTimeout(150);
  } while (Date.now() < deadline);
  /* Settled end state: the turn completed and exactly one answer surface
     remains in the thread. */
  await expect(answer).toBeVisible({ timeout: 30_000 });
  expect(await answer.count()).toBe(1);
});
