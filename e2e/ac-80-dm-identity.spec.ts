import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { electronScreenshot, launchDesktop } from "./helpers/electron";
import { bootStack, pickPorts, skipFirstRun, startChat } from "./helpers/stack";

/**
 * Issue #80 — thread identity + streaming markdown. AC-1 asserts the user's
 * message is the signed-in person's own (named with their name, never "You")
 * and that the same person reads the same on the other v3 surface that draws
 * them. AC-2 asserts markdown renders
 * mid-stream (the prompt's `slow:` directive stretches its own text
 * phase so the stream is observable — #432; no stack-wide tick). AC-3
 * captures both in the Electron desktop app.
 *
 * v3: the message is the thread panel's right-aligned bubble beside Threads
 * (`data-userturn`: no avatar — your own messages carry only the time line,
 * whose name is read by assistive tech, so "named, never You" is asserted on
 * its text); a send lands there, so no DM feed or "N replies" chip is needed
 * to reach it. The old assertion that the row's avatar IS the sidebar
 * footer's avatar has no v3 counterpart: the v3 sidebar has no me-row footer,
 * and the only other place v3 draws the signed-in person is the People org
 * chart's "Chairman" chip (initial on the neutral foreground chip). So "one
 * identity" is asserted as the same name on both surfaces and the chip's
 * initial being that name's first letter.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
// --repeat-each spreads a file's repeats across worker processes; each boots
// the stack again, so ports are offset per worker or relays race one port (#84).

const SHOTS = path.join(repo, "test-results", "ac-80");
/* AC-1 never gates on a running turn — its prompt runs at the engine tick. */
const PROMPT = "What does the replay contract carry?"; // hits the default script
/* `slow:75` paces only this turn (~4 s) — the mid-stream window AC-2's
   markdown asserts need; the streaming block is live whenever they look. */
const STREAM_PROMPT = `slow:75 ${PROMPT}`;
/* AC-3 asserts mid-stream markdown after the send lands — its send needs the
   longer ~8 s window to still be streaming by the time the shots are taken
   (#432). */
const STREAM_PROMPT_DESKTOP = `slow:150 ${PROMPT}`;
const AGENT = { id: "default", name: "Hermes" };

/* The bubble the user's message renders in. Scoped to the thread panel: the
   Threads list beside the peek has avatars of its own. */
const userRow = (page: Page, text: string) =>
  page
    .locator("[data-thread-panel] [data-userturn]")
    .filter({ hasText: text })
    .last();

/* The user's message is the signed-in person's: named with their name, not
   the anonymous "You". Returns the initial the other surface must show. */
async function expectOwnIdentity(row: Locator): Promise<string> {
  await expect(row).toContainText("Oscar");
  await expect(row).not.toContainText("You");
  return "O";
}

/* The People org chart's "Chairman" chip is the signed-in person's other
   avatar in v3: same name, same initial as the message row's. */
async function expectChairmanIsSamePerson(
  page: Page,
  webUrl: string,
  initial: string,
) {
  /* D-#836: the org chart is the paused company layer — `?company=1` shows
     it back (a URL hatch, so the desktop window's preload config honors it
     too — LILOS_COMPANY only reaches the web server's config endpoint). */
  await page.goto(`${webUrl}/?company=1#?page=people&view=org`);
  const chip = page
    .locator("#v3-main")
    .getByText("Chairman", { exact: true })
    .locator("xpath=ancestor::div[1]");
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toContainText("Oscar");
  await expect(chip.locator("span[aria-hidden='true']").first()).toHaveText(
    initial,
  );
}

test.describe.configure({ mode: "serial" });

test("AC-1 the user's message is their own identity (named, never 'You')", async ({
  page,
}) => {
  // bootStack + send need headroom under parallel load.
  test.setTimeout(180_000);
  const stack = await bootStack(
    "ac80a",
    await pickPorts(),
    // #118: the signed-in name is the OS user's — pin it so the identity
    // assertions below stay deterministic on any machine.
    { LILOS_USER_NAME: "Oscar" },
  );
  try {
    await skipFirstRun(page);
    await startChat(page, stack.webUrl, AGENT, PROMPT);
    /* #577: the send lands in the thread panel — the row this test measures
       is already rendered. */
    const row = userRow(page, PROMPT);
    await expect(row).toBeVisible({ timeout: 30_000 });
    const initial = await expectOwnIdentity(row);
    // …and the other surface that draws the same person agrees.
    await expectChairmanIsSamePerson(page, stack.webUrl, initial);
  } finally {
    await stack.stop();
  }
});

test("AC-2 markdown renders while the reply streams, then settles unchanged", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const stack = await bootStack(
    "ac80b",
    await pickPorts(),
    // The `slow:` prompt stretches its own text phase (~4 s → observable
    // mid-stream); pin the human's name (#118).
    { LILOS_USER_NAME: "Oscar" },
  );
  try {
    await skipFirstRun(page);
    /* #577: a send lands in the thread panel (`open=thread:<id>`) — exactly
       the thread-panel markdown path this test covers. */
    await startChat(page, stack.webUrl, AGENT, STREAM_PROMPT);
    const turn = page.locator("[data-agentturn]").first();
    const streaming = turn.locator("[data-streaming]");
    await expect(streaming).toBeVisible({ timeout: 60_000 });
    // Mid-stream the bullet and the `seq` code span are already real markdown.
    await expect(streaming.locator("li").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      streaming.locator("code").filter({ hasText: "seq" }),
    ).toBeVisible();
    await expect(streaming).not.toContainText("`");
    await expect(streaming).not.toContainText(/^-\s/m);
    await page.screenshot({ path: `${SHOTS}/ac-2-mid-stream.png` });
    // Done: the streaming block detaches; the same markdown stays rendered.
    await expect(streaming).toHaveCount(0, { timeout: 60_000 });
    await expect(
      turn.locator("code").filter({ hasText: "seq" }).first(),
    ).toBeVisible();
    await expect(turn.locator("li").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-2-done.png` });
  } finally {
    await stack.stop();
  }
});

test("AC-3 desktop app: same identity + streaming markdown in Electron", async () => {
  test.setTimeout(240_000);
  const stack = await bootStack("ac80c", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
  });
  try {
    const { app, win } = await launchDesktop(stack, {
      env: { LILOS_USER_NAME: "Oscar" },
    });
    try {
      await startChat(win, stack.webUrl, AGENT, STREAM_PROMPT_DESKTOP);
      // AC-1 in the desktop window: the user's message is their own.
      const row = userRow(win, PROMPT);
      await expect(row).toBeVisible({ timeout: 30_000 });
      const initial = await expectOwnIdentity(row);
      await electronScreenshot(app, win, `${SHOTS}/ac-3-desktop-avatar.png`);
      // AC-2 in the desktop window: markdown mid-stream. The send already
      // opened the thread in the panel — no session to reopen.
      await expect(win.locator("[data-agentturn]")).toHaveCount(1, {
        timeout: 15_000,
      });
      const streaming = win.locator("[data-agentturn] [data-streaming]");
      await expect(streaming.locator("li").first()).toBeVisible({
        timeout: 60_000,
      });
      await expect(streaming.locator("code").first()).toBeVisible();
      await electronScreenshot(app, win, `${SHOTS}/ac-3-desktop-streaming.png`);
      await expect(streaming).toHaveCount(0, { timeout: 60_000 });
      await electronScreenshot(app, win, `${SHOTS}/ac-3-desktop-done.png`);
      // The same person on the other surface that draws them.
      await expectChairmanIsSamePerson(win, stack.webUrl, initial);
    } finally {
      await app.close();
    }
  } finally {
    await stack.stop();
  }
});
