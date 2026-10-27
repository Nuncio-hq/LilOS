import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  bootStack,
  freePort,
  openDefaultAgent,
  type Stack,
  startChat,
} from "./helpers/stack";

/**
 * Issue #884 round 1 — an engine whose global approval policy was left on
 * `off` (the Settings row is gone, so a user cannot undo it) must still let
 * LilOS's Ask actually ask: the harness pins the engine to `manual` on
 * attach, and an ask then surfaces a card instead of being auto-answered.
 *
 * `LILOS_FAKE_POLICY=off` boots engine-fake in exactly that stale state —
 * without the pin it would answer every gated step itself and no card
 * would ever appear.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  /* Free port under the slice floor (six workers share the Mac), paused
     company layer = the real app, and the engine starts reporting `off`. */
  stack = await bootStack(
    "ac884pol",
    { relay: 0, feed: 0, web: await freePort() },
    { LILOS_COMPANY: "0", LILOS_FAKE_POLICY: "off" },
  );
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

test("an engine reporting Off is reset on connect — an ask shows a card", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const agent = await openDefaultAgent(page, stack.webUrl);
  await startChat(page, stack.webUrl, agent, "Add a footer to the page");

  /* With `off` auto-answering, no card could appear — its presence proves
     the harness set the policy back to `manual` on attach. */
  const card = page.locator('[data-ask-id][data-ask-state="open"]').first();
  await expect(card).toContainText("Edit README.md?", { timeout: 90_000 });
  await expect(
    card.getByRole("button", { name: "Allow", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(repo, "test-results", "ac-884", "ac-4-policy-reset.png"),
  });
});
