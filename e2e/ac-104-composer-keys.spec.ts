import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
} from "./helpers/stack";

/**
 * Issue #104 — DM composer keys, updated for #576: Esc now only ever CLOSES
 * something (the @ menu, a popover, a dialog) — it never stops a turn. ⌘.
 * is the real stop shortcut, through the same `onStop` the ■ button calls
 * (AC-1…AC-4, AC-6 against the real app + engine-fake, stack booted like
 * ac-27-dm.spec.ts); ↑ in an empty composer recalls the last sent message
 * (AC-5); the prototype shows the same behaviour (AC-7, shared dev
 * server). LILOS_TURN_HOLD parks the turn mid-run for a deterministic
 * running state.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
// --repeat-each spreads a file's repeats across worker processes; each boots
// the stack again, so ports are offset per worker or relays race one port (#84).

const SHOTS = path.join(repo, "test-results", "ac-104");

let stackA: Stack; // engine-fake advertising every capability (incl. steer)
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stackA = await bootStack("keys", await pickPorts());
});
test.afterAll(async () => {
  await stackA?.stop();
});

test.describe.configure({ mode: "serial" });

/** Open the app, land on Default's DM (dismissing the first-run card). */
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

const employeeIdFromUrl = (page: Page) =>
  decodeURIComponent(page.url().split("/dm/")[1].split("/")[0]);

const STOPPED = "Stopped";
/* "Stopped" text also appears on a DM-home row whose last turn was stopped
   (#583 state word) — negative checks scope to turn elements only. */
const stoppedChip = (p: import("@playwright/test").Page) =>
  p.locator("[data-agentturn]").getByText(STOPPED);
const RUNNING_HINT = /Enter (steers|queues) · ⌘\. stop/;

test("AC-1 Esc never stops the running turn — ⌘. stops it (same as ■)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(stackA, page);
  /* LILOS_TURN_HOLD keeps the fake's turn running until the interrupt lands —
     Esc must NOT be what ends it; ⌘. is (#576). */
  await send(page, "LILOS_TURN_HOLD Add a release note to the readme");
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({ timeout: 30_000 });
  /* #577: the send lands on the thread panel — hop into Focus so Esc's only
     close target is the Focus surface itself (Esc on the panel would close
     the panel — correct too, but this AC is about the turn, not the layer). */
  await panelIntoFocus(page);
  const box = page.locator("textarea").last();
  await box.click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await expect(page.getByText(RUNNING_HINT)).toBeVisible();
  await expect(stoppedChip(page)).toHaveCount(0);
  await page.keyboard.press("Meta+Period");
  await expect(stoppedChip(page)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-1-cmddot-stopped.png` });
});

test("AC-2 Esc with no turn running does nothing (no Stop → nothing)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(stackA, page);
  // No session yet: the home composer never gets onStop — Esc is inert.
  const home = page.locator("textarea").first();
  await home.click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await expect(stoppedChip(page)).toHaveCount(0);

  // A finished turn: running is false → ⌘. inert; Esc does its only job —
  // closes the Focus surface back to the panel — it never touches the turn.
  await send(page, "Say hello then list files");
  await expect(page.getByPlaceholder(/Reply to /)).toBeVisible({
    timeout: 90_000,
  });
  // #577: hop to Focus so Esc closes it and lands back on the panel.
  await panelIntoFocus(page);
  await page.locator("textarea").last().click();
  await page.keyboard.press("Escape");
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+$/);
  await page.keyboard.press("Meta+Period");
  await page.waitForTimeout(400);
  await expect(stoppedChip(page)).toHaveCount(0);
});

test("AC-3 Esc closes an open popover/dialog first — the turn keeps running", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(stackA, page);
  await send(page, "LILOS_TURN_HOLD Add a release note to the readme");
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({ timeout: 30_000 });
  // #577: the "Back to DM" step below is Focus's back control — hop there.
  await panelIntoFocus(page);

  // Model-picker popover: Esc closes it without touching the turn.
  await page.locator('[data-slot="model-picker-trigger"]').last().click();
  await expect(
    page.locator('[data-slot="popover-content"][data-open]'),
  ).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="popover-content"][data-open]'),
  ).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(RUNNING_HINT)).toBeVisible();
  await expect(stoppedChip(page)).toHaveCount(0);

  // Status dialog: Esc inside it closes only the dialog. Focus has no
  // sidebar (#246) — the status button lives there, so leave focus first.
  await page.getByTitle("Back to DM").click();
  await page.getByRole("button", { name: "System status" }).click();
  const dialog = page.getByRole("dialog", { name: "System status" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(RUNNING_HINT)).toBeVisible();
  await expect(stoppedChip(page)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-3-overlays.png` });
});

test("AC-4 ⌘. with a steer draft typed still stops the turn and keeps the text", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(stackA, page);
  await send(page, "LILOS_TURN_HOLD Add a release note to the readme");
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({ timeout: 30_000 });
  // #577: hop to Focus — Esc mid-draft closes it, landing back on the panel
  // (the draft persists through the surface swap, same store).
  await panelIntoFocus(page);
  const box = page.locator("textarea").last();
  await box.fill("also mention bananas");
  // Esc is inert mid-draft — the turn keeps running, the draft stays.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await expect(stoppedChip(page)).toHaveCount(0);
  await expect(box).toHaveValue("also mention bananas");
  await page.keyboard.press("Meta+Period");
  await expect(stoppedChip(page)).toBeVisible({ timeout: 30_000 });
  await expect(box).toHaveValue("also mention bananas");
  await page.screenshot({ path: `${SHOTS}/ac-4-stopped-keeps-draft.png` });
});

test("AC-5 ↑ recalls the last sent message — thread, then home composer", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(stackA, page);
  await send(page, "first root: pick a color");
  await expect(page.getByText("first root: pick a color").first()).toBeVisible({
    timeout: 30_000,
  });
  /* The root preview lands in the home feed before the send's async navigate
     commits — wait for the thread URL so the next send hits the thread
     composer, not a second top-level message (same race as ac-28, #103). */
  await expect(page).toHaveURL(/\/dm\/[^/]+\/conv_/, { timeout: 10_000 });
  // ↑ recall reads the last message Oscar SENT — it must not depend on
  // whether the running turn has finished (a steer counts too).
  await send(page, "second reply: make it blue");
  await expect(
    page.getByText("second reply: make it blue").first(),
  ).toBeVisible({ timeout: 30_000 });

  // Thread composer: ↑ fills with the last reply Oscar sent, caret at end.
  const box = page.locator("textarea").last();
  await box.click();
  await page.keyboard.press("ArrowUp");
  await expect(box).toHaveValue("second reply: make it blue");
  const caret = await box.evaluate(
    (el: HTMLTextAreaElement) => el.selectionStart,
  );
  expect(caret).toBe("second reply: make it blue".length);
  await page.screenshot({ path: `${SHOTS}/ac-5-recalled.png` });

  // ↑ with a draft is the usual caret move — text is never replaced.
  await box.fill("draft in progress");
  await box.press("ArrowUp");
  await expect(box).toHaveValue("draft in progress");

  // Home composer recalls the last TOP-LEVEL message = this session's root.
  await page.goto(`${stackA.webUrl}/dm/${employeeIdFromUrl(page)}`);
  const home = page.locator("textarea").first();
  await home.click();
  await page.keyboard.press("ArrowUp");
  await expect(home).toHaveValue("first root: pick a color");
  await page.screenshot({ path: `${SHOTS}/ac-5-home-recalled.png` });
});

/* #700: AC-5's flake was a positional-send race, not a recall mix-up. The
   first send resolves `conversations.open` → navigates to the thread URL —
   but `openConv` (and so the panel's reply composer) only exists once the
   scoped `conversations.summaries` answer lands. In that gap the only
   textarea on the page is the HOME composer, so `send()`'s
   `textarea.last()` filled it and minted a second top-level conversation:
   "second reply" became its own root, and the home ↑ rightly recalled the
   newest top-level message — conv2's root (CI job 112651194005 received
   exactly that). LILOS_SUMMARY_DELAY_MS holds every summaries answer so the
   mount gap stays open long enough to make the mis-aim deterministic —
   the same knob AC-660 used for its openConv window. */
test("AC-700 ↑ recall stays per-composer while the thread's summary is held back", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("keysd", await pickPorts(), {
    LILOS_SUMMARY_DELAY_MS: "2000",
  });
  try {
    await dmDefault(stack, page);
    await send(page, "first root: pick a color");
    // No panel wait — this send's `textarea.last()` must land inside the
    // held-open mount gap, on the home composer (the buggy aim).
    await send(page, "second reply: make it blue");
    await expect(page.locator("[data-thread-panel]")).toBeVisible({
      timeout: 30_000,
    });
    const box = page.locator("textarea").last();
    await box.click();
    await page.keyboard.press("ArrowUp");
    await expect(box).toHaveValue("second reply: make it blue");

    // Home composer: the feed row gates the summaries snapshot landing
    // before the one-shot ↑ reads it.
    await page.goto(`${stack.webUrl}/dm/${employeeIdFromUrl(page)}`);
    await expect(
      page.getByText("first root: pick a color").first(),
    ).toBeVisible({ timeout: 30_000 });
    const home = page.locator("textarea").first();
    await home.click();
    await page.keyboard.press("ArrowUp");
    await expect(home).toHaveValue("first root: pick a color");
  } finally {
    await stack.stop();
  }
});

test("AC-6 the Stop button's label names the real shortcut — ⌘.", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(stackA, page);
  await send(page, "LILOS_TURN_HOLD Add a release note to the readme");
  /* #583: rows whose word is "stopped" also match /stop/i — name the
     button by its exact aria-label instead. */
  const stop = page.getByRole("button", { name: /^stop \(⌘\.\)$/i });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await expect(stop).toHaveAttribute("aria-label", /⌘\./);
  await expect(stop).toHaveAttribute("title", /⌘\./);
});

/* ---- AC-7: the prototype (UI source of truth) shows the same behaviour ---- */

async function sendProtoDM(page: Page, text: string) {
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();
  const box = page.getByPlaceholder(/New thread with Builder/);
  await box.fill(text);
  await box.press("Enter");
}

test("AC-7 prototype: ⌘. stops the turn (Esc never does); ↑ recalls; Esc closes the @ menu", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await sendProtoDM(page, "Check the relay reconnect plan");
  const steer = page.getByPlaceholder(/is working\. Enter steers this turn/);
  await expect(steer).toBeVisible({ timeout: 15_000 });

  // A mid-turn send lands in the steer buffer, not the replies — ↑ must still
  // recall it (parity with the real app, where the steer IS a user message).
  await steer.fill("also the flaky e2e retry counts");
  await steer.press("Enter");
  await expect(page.locator("[data-queued]").first()).toBeVisible({
    timeout: 10_000,
  });
  await steer.click();
  await page.keyboard.press("ArrowUp");
  await expect(steer).toHaveValue("also the flaky e2e retry counts");

  /* #577: Esc on the panel closes it — hop into the prototype's Focus first,
     mirroring the real-app legs (Esc then only exits Focus, never the turn). */
  await page.getByTitle("Focus", { exact: true }).click();
  // Esc does NOT stop the turn — ⌘. does (same as ■), draft kept.
  await page.keyboard.press("Escape");
  // Settle on the close, not a sleep: Focus's back control unmounts when the
  // surface closes — and the steer placeholder still greets a running turn.
  await expect(page.getByRole("button", { name: /back to dm/i })).toHaveCount(
    0,
  );
  await expect(steer).toBeVisible();
  await expect(stoppedChip(page)).toHaveCount(0);
  await page.keyboard.press("Meta+Period");
  await expect(stoppedChip(page).first()).toBeVisible({
    timeout: 15_000,
  });
  const box = page.getByPlaceholder(/Reply to Builder/);
  await expect(box).toHaveValue("also the flaky e2e retry counts");
  await page.screenshot({ path: `${SHOTS}/ac-7-prototype.png` });

  // A fresh send after the stop is the newest message — ↑ recalls it now.
  await box.fill("a second, plain message");
  await box.press("Enter");
  await expect(page.getByText("a second, plain message").first()).toBeVisible({
    timeout: 15_000,
  });
  const composer = page.locator("textarea").last();
  await composer.click();
  await page.keyboard.press("ArrowUp");
  await expect(composer).toHaveValue("a second, plain message");

  // The `@` employee menu in the channel composer: Esc closes it first.
  await page.goto("/");
  const chan = page.getByPlaceholder(/Message #engineering/);
  await chan.fill("@");
  // #105 renamed the @ menu's label (it lists files too now).
  const menu = page.getByRole("listbox", { name: "Mention" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});
