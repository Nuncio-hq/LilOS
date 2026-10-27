import { expect, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  skipFirstRun,
  startChat,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #645 — the ac-103-drafts AC-4 flake: after a send, the thread
 * composer never became addressable on CI (`locator.fill` on
 * `getByPlaceholder(/Reply to /)` timed out).
 *
 * Root cause: the thread panel resolved the open conversation from
 * `conversations.summaries` alone, and the "submitted" marker cleared only
 * when a live engine model was observed. Hold the summary read past the
 * turn's end — the window CI's load created — and `openConv` landed (or
 * never did, once every refresh outlasted the request timeout) while the
 * marker latched: the composer mounted with the "…is working. Enter
 * steers this turn…" placeholder and never returned to "Reply to…".
 *
 * `LILOS_SUMMARY_DELAY_MS` (#660's knob) delays every summaries answer on
 * the relay, so this spec rides that window deterministically. With the
 * fix the open thread resolves off `relay.conversations` (push-fed by
 * `conversation.updated`/`conversations.list`), the marker hands off when
 * the session feed's replay lands, and a dead summaries fetch can no
 * longer hold the directory at "Loading…".
 */

const SHOTS = "test-results/ac-645";
/* Inside the thread panel: the new-chat draft beside it is "Message X…" too. */
const REPLY = /^Message [^…]+…$/;

test("AC-645 the thread composer mounts and re-arms while summaries lag", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  /* 8s: past an engine-fake turn's length (the latch window) but under the
     15s request timeout — the exact lateness CI's load produced. */
  const stack = await bootStack("tc645", await pickPorts(), {
    LILOS_SUMMARY_DELAY_MS: "8000",
  });
  try {
    await skipFirstRun(page);
    /* The new chat is Default's draft beside Threads; the send swaps it for
       its thread in the peek. */
    await startChat(
      page,
      stack.webUrl,
      { id: "default", name: "Hermes" },
      "composer under lag",
    );

    /* The summary row lands ~8s late; the composer must still mount (the
       `conversations` union) and return to "Message X…" once the session
       feed's model answers — the placeholder is the deterministic anchor
       for "running" having handed off. */
    const thread = v3Peek(page)
      .locator("[data-thread-panel]")
      .getByPlaceholder(REPLY);
    await expect(thread).toBeVisible({ timeout: 45_000 });
    await thread.fill("still here under lag");
    await page.screenshot({ path: `${SHOTS}/ac-645-composer-reamed.png` });

    await page.reload();
    await expect(
      v3Peek(page).locator("[data-thread-panel]").getByPlaceholder(REPLY),
    ).toHaveValue("still here under lag", { timeout: 45_000 });
    await page.screenshot({ path: `${SHOTS}/ac-645-after-reload.png` });
  } finally {
    await stack.stop();
  }
});
