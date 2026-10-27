import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #104 — DM composer keys, updated for #576: Esc now only ever CLOSES
 * something (the @ menu, a popover, a dialog) — it never stops a turn. ⌘.
 * is the real stop shortcut, through the same `onStop` the ■ button calls
 * (AC-1…AC-4, AC-6 against the real app + engine-fake, stack booted like
 * ac-27-dm.spec.ts); ↑ in an empty composer recalls the last sent message
 * (AC-5). LILOS_TURN_HOLD parks the turn mid-run for a deterministic
 * running state.
 *
 * v3: a chat starts on the new-chat draft beside Threads and its first send
 * swaps the draft for the thread in the peek; "Focus" is the widened peek
 * (`full=1`). The old DM home's ↑ recall is the new-chat draft's (AC-5's
 * second half). AC-7 is dropped, not faked: the prototype's old default
 * screen is gone.
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

const DEFAULT_AGENT = { id: "default", name: "Hermes" };

/** A new chat with Default, past first run; resolves once its thread is open
    in the peek. */
async function chatDefault(stack: Stack, page: Page, text: string) {
  await skipFirstRun(page);
  await startChat(page, stack.webUrl, DEFAULT_AGENT, text);
}

/** The thread composer in the peek — the draft's box is another textarea. */
const threadBox = (page: Page) =>
  v3Peek(page).locator("[data-thread-panel] textarea");

const STOPPED = "Stopped";
/* "Stopped" text also appears on a thread row whose last turn was stopped
   (#583 state word) — negative checks scope to turn elements only. */
const stoppedChip = (p: import("@playwright/test").Page) =>
  p.locator("[data-agentturn]").getByText(STOPPED);
const RUNNING_HINT = /Enter (steers|queues) · ⌘\. stop/;

test("AC-1 Esc never stops the running turn — ⌘. stops it (same as ■)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  /* LILOS_TURN_HOLD keeps the fake's turn running until the interrupt lands —
     Esc must NOT be what ends it; ⌘. is (#576). */
  await chatDefault(
    stackA,
    page,
    "LILOS_TURN_HOLD Add a release note to the readme",
  );
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({ timeout: 30_000 });
  /* #577: the send lands on the thread in the peek — hop into the session
     view so Esc's only close target is that surface itself (Esc on the peek
     would close the peek — correct too, but this AC is about the turn, not
     the layer). */
  await panelIntoFocus(page);
  const box = threadBox(page);
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
  await skipFirstRun(page);
  // No session yet: the new-chat draft never gets onStop — Esc is inert.
  await page.goto(`${stackA.webUrl}/#?page=threads&open=newchat:default`);
  const draft = v3Peek(page).getByPlaceholder("Message Hermes…");
  await expect(draft).toBeVisible({ timeout: 30_000 });
  await draft.click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await expect(stoppedChip(page)).toHaveCount(0);

  // A finished turn: running is false → ⌘. inert; Esc does its only job —
  // closes the session view back to the thread — it never touches the turn.
  await draft.fill("Say hello then list files");
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await expect(
    v3Peek(page)
      .locator("[data-thread-panel]")
      .getByPlaceholder(/^Message [^…]+…$/),
  ).toBeVisible({
    timeout: 90_000,
  });
  // #577: hop into the session view so Esc closes it and lands back on the
  // thread.
  await panelIntoFocus(page);
  await threadBox(page).click();
  await page.keyboard.press("Escape");
  await page.waitForURL(
    (u) => /open=thread:[^&]+/.test(u.hash) && !/full=1/.test(u.hash),
  );
  await page.keyboard.press("Meta+Period");
  await page.waitForTimeout(400);
  await expect(stoppedChip(page)).toHaveCount(0);
});

test("AC-3 Esc closes an open popover/dialog first — the turn keeps running", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await chatDefault(
    stackA,
    page,
    "LILOS_TURN_HOLD Add a release note to the readme",
  );
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({ timeout: 30_000 });
  // #577: the session view is the surface the layers stack on — hop there.
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
  /* `data-open` drops at once but the popover stays mounted and visible
     through its exit animation, and while it does the layer stack counts it
     as a foreign overlay that owns Esc — so wait it out before the dialog
     (the old flow's clicks in between gave it that time). */
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0, {
    timeout: 15_000,
  });

  /* A modal dialog: Esc inside it closes only the dialog. v3 has no standing
     System-status entry (its dialog opens from the status banner, which only
     draws while something is down), so the layer is the Keyboard-shortcuts
     dialog (⌘/): the same `useUiLayerEl` Esc mechanism the status dialog
     rode, reachable while the turn runs. */
  await page.keyboard.press("Meta+Slash");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
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
  await chatDefault(
    stackA,
    page,
    "LILOS_TURN_HOLD Add a release note to the readme",
  );
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({ timeout: 30_000 });
  // #577: hop to the session view — Esc mid-draft closes it, landing back on
  // the thread (the draft persists through the surface swap, same store).
  await panelIntoFocus(page);
  const box = threadBox(page);
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

/* AC-5's flow, parameterised by stack so AC-700 can rerun it on a
   summaries-delayed stack (#700). Every composer interaction is pinned to
   its surface — the peek's thread box — never positional `textarea.last()`:
   that is what flaked, landing a send in the wrong composer while the panel
   had not mounted yet. The second composer is the new-chat draft, where ↑
   recalls the last top-level message (the thread's root). */
async function ac5Recall(stack: Stack, page: Page, shots: string) {
  await chatDefault(stack, page, "first root: pick a color");
  /* The send swaps the draft for the thread as soon as conversations.open
     answers — but the panel's composer mounts only once the conversation
     resolves. Gate on the panel itself so the reply can't fall into the
     mount gap. */
  const panel = v3Peek(page).locator("[data-thread-panel]");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText("first root: pick a color").first()).toBeVisible(
    { timeout: 30_000 },
  );
  // ↑ recall reads the last message Oscar SENT — it must not depend on
  // whether the running turn has finished (a steer counts too). The
  // composer placeholder names the state — idle, running or waiting —
  // and never the new-chat draft's "Message Hermes…".
  const box = panel.getByPlaceholder(/^Message |is waiting/);
  await box.fill("second reply: make it blue");
  await box.press("Enter");
  await expect(
    panel.getByText("second reply: make it blue").first(),
  ).toBeVisible({ timeout: 30_000 });

  // Thread composer: ↑ fills with the last reply Oscar sent, caret at end.
  await box.click();
  await page.keyboard.press("ArrowUp");
  await expect(box).toHaveValue("second reply: make it blue");
  const caret = await box.evaluate(
    (el: HTMLTextAreaElement) => el.selectionStart,
  );
  expect(caret).toBe("second reply: make it blue".length);
  await page.screenshot({ path: `${SHOTS}/${shots}-recalled.png` });

  // ↑ with a draft is the usual caret move — text is never replaced.
  await box.fill("draft in progress");
  await box.press("ArrowUp");
  await expect(box).toHaveValue("draft in progress");

  // The new-chat draft recalls the last TOP-LEVEL message = this thread's root.
  await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:default`);
  const draft = v3Peek(page).getByPlaceholder("Message Hermes…");
  await expect(draft).toBeVisible({ timeout: 30_000 });
  /* ↑ recall reads the opener out of the summaries snapshot, which
     LILOS_SUMMARY_DELAY_MS holds back: ↑ in an empty box is a no-op until it
     lands, so press it until the text arrives rather than once. */
  await draft.click();
  await expect(async () => {
    await draft.press("ArrowUp");
    await expect(draft).toHaveValue("first root: pick a color", {
      timeout: 500,
    });
  }).toPass({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/${shots}-home-recalled.png` });
}

test("AC-5 ↑ recalls the last sent message — thread, then the new-chat draft", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ac5Recall(stackA, page, "ac-5");
});

/* #700: AC-5's flake was a positional-send race, not a recall mix-up. The
   first send resolves `conversations.open` → navigates to the thread — but
   the panel's reply composer only exists once the conversation resolves. In
   that gap the only textarea on the page was the HOME composer, so a
   positional `textarea.last()` filled it and minted a second top-level
   conversation (CI job 112651194005 received exactly that).
   LILOS_SUMMARY_DELAY_MS holds every summaries answer so the mount gap stays
   open for the whole second send. Re-running AC-5's flow through it is the
   sentinel: the pinned locators ride out the window, while any return to
   positional sends falls into it deterministically. */
test("AC-700 ↑ recall stays per-composer while the thread's summary is held back", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("keysd", await pickPorts(), {
    LILOS_SUMMARY_DELAY_MS: "2000",
  });
  try {
    await ac5Recall(stack, page, "ac-700");
  } finally {
    await stack.stop();
  }
});

test("AC-6 the Stop button's label names the real shortcut — ⌘.", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await chatDefault(
    stackA,
    page,
    "LILOS_TURN_HOLD Add a release note to the readme",
  );
  /* #583: rows whose word is "stopped" also match /stop/i — name the
     button by its exact aria-label instead. */
  const stop = page.getByRole("button", { name: /^stop \(⌘\.\)$/i });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await expect(stop).toHaveAttribute("aria-label", /⌘\./);
  await expect(stop).toHaveAttribute("title", /⌘\./);
});
