import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  bootStack,
  freePort,
  openDefaultAgent,
  type Stack,
  startChat,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #884 round 2 — an engine whose global approval policy was left on
 * `off` must not be silently rewritten (the same policy serves Oscar's
 * terminal Hermes): LilOS surfaces one plain warning — on the composer's
 * access pill and in Settings — with a one-click Fix that sets it back to
 * `smart`, the ask-for-the-risky-ones mode behind "Ask before risky
 * commands". Until the click, `off` auto-answers every gated step and no
 * card can appear; after it, a risky step surfaces one.
 *
 * `LILOS_FAKE_POLICY=off` boots engine-fake in exactly that stale state.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-884");

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

test("an engine reporting Off warns — Fix makes a risky step ask", async ({
  page,
}) => {
  test.setTimeout(240_000);
  /* Settled frames for the evidence shots — routes fade in otherwise. */
  await page.emulateMedia({ reducedMotion: "reduce" });
  const agent = await openDefaultAgent(page, stack.webUrl);

  /* The composer's access pill reads the warning, not "Ask". */
  await page.goto(
    `${stack.webUrl}/#?page=threads&open=newchat:${encodeURIComponent(agent.id)}`,
  );
  const pill = v3Peek(page).locator('[data-slot="access-pill"]');
  await expect(pill).toHaveText("Never asks", { timeout: 30_000 });

  /* The warning also sits in the pill's own menu, above Ask / Full access —
     one access control, with Fix in it (#886 folds #884 into it). */
  await pill.click();
  const menuWarning = page.getByRole("menu", { name: "Access" });
  await expect(menuWarning).toContainText("never ask, so Ask won't stop");
  await expect(menuWarning.getByRole("menuitemradio")).toHaveCount(2);
  await page.keyboard.press("Escape");

  /* Settings says the same, in one line, with the repair beside it. */
  await page.goto(`${stack.webUrl}/#?page=settings&view=general`);
  const warning = page
    .locator("[data-engine-never-asks]")
    .filter({ hasText: "never ask," });
  await expect(warning).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-4-policy-warning.png` });
  await warning.getByRole("button", { name: "Fix" }).click();
  await expect(warning).toHaveCount(0);

  /* With `smart` restored the risky step surfaces a card — `off` would
     have auto-answered it. */
  await startChat(page, stack.webUrl, agent, "Add a footer to the page");
  const card = page.locator('[data-ask-id][data-ask-state="open"]').first();
  await expect(card).toContainText("Edit README.md?", { timeout: 90_000 });
  await expect(
    card.getByRole("button", { name: "Allow", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS, "ac-4-policy-reset.png"),
  });
});
