import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openNewChat,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
  v3Main,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #92 — model picker v2 in the REAL app (apps/web over relay + harness
 * on engine-fake). Each acceptance criterion is a named test. #438 folded the
 * prototype spec (ac-30, mock stack) into this file: its two unique legs
 * survive as the first-turn-pick and no-capability tests; the other four
 * restated AC-1…AC-7 and were dropped with the file. The fake catalog is
 * Fake Small (no dial) / Fake Large (3 stops + fast, the default) /
 * Fake Reasoning (7-stop ladder + fast) / Fake Opus 2 (a "/" id) /
 * Fake Fresh (only via `models.list {refresh:true}`).
 *
 * v3: the full picker (effort slider, Fast, "Model ›" list, Refresh, Edit
 * models) is on both composers: the thread panel's, and the new-chat draft
 * beside Threads (the old DM home's new-session composer). Only one is on
 * screen at a time, so `triggers` reads whichever is open.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const SHOTS = path.join(repo, "test-results", "ac-92");

let stackA: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stackA = await bootStack("picker", await pickPorts());
});
test.afterAll(async () => {
  await stackA?.stop();
});

test.describe.configure({ mode: "serial" });
// The pick → next-turn footer flow is the AC-4 evidence the PR needs on film.
test.use({ video: "on" });

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

/* #511: leave the app BEFORE the stack dies — while the page still points at
   a dead relay its reconnect loops log ERR_CONNECTION_REFUSED and watchConsole
   is still collecting for the assert below. The stack's own origin, not
   about:blank: the skip-first-run init script reads localStorage on every
   document and about:blank denies it (a pageerror). */
const leaveApp = (page: Page, stack: Stack) =>
  page.goto(`${stack.webUrl}/lilos-config.json`);

/** A new chat with Default: the draft beside Threads, type, Send, landing on
 *  the thread in the side peek. An id that names nobody opens the draft on
 *  the default agent. */
async function chatDefault(stack: Stack, page: Page, text: string) {
  await skipFirstRun(page);
  await startChat(page, stack.webUrl, { id: "default", name: "Default" }, text);
}

/** The picker on the open session (the thread panel's composer). The old DM
 *  home carried a second one on its new-session composer; in v3 that
 *  composer is the draft's model chip (`draftChip`). */
const triggers = (page: Page) =>
  v3Peek(page).locator('[data-slot="model-picker-trigger"]');

/** The new-chat draft's model picker: the same one the thread's composer has,
 *  with effort and Fast (only one is on screen at a time). */
const draftChip = triggers;

/** Open the session picker's popover and drill into the searchable model
 *  list (the v3 peek holds one thread, so there is one trigger). */
async function openModelList(page: Page) {
  await triggers(page).click();
  await page.getByRole("button", { name: /Model$/ }).click();
}

const option = (page: Page, name: string) =>
  page.locator("[cmdk-item]", { hasText: name });

/** A reply in the open thread (the panel's composer). */
const send = async (page: Page, text: string) => {
  const box = page.locator("[data-thread-panel] textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

/** The newest turn's footer facts ("Fake Reasoning · High · Fast"). The
 *  footer is a hover line — transparent until the pointer is on the turn — so
 *  hover it and wait until it is fully shown, as a person reading it would. */
async function expectFooter(page: Page, facts: string) {
  const turn = page.locator("[data-agentturn]").last();
  const footer = turn.locator("[data-turnsettled]");
  await expect(async () => {
    await turn.hover();
    await expect(footer.getByText(facts)).toBeVisible({ timeout: 2_000 });
    await expect(footer).toHaveCSS("opacity", "1", { timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
}

test("AC-1 + AC-5 the new-session composer starts on the employee default and lists every engine model; the session picker groups them by provider", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  // The draft's picker: the employee default (fake-large) with its effort —
  // never a sticky last-used pick — and every engine model under its provider.
  await openNewChat(page, stackA.webUrl);
  const chip = draftChip(page);
  await expect(chip).toContainText("Fake Large");
  await expect(chip).toContainText("Medium");
  await chip.click();
  await page.getByRole("button", { name: /Model$/ }).click();
  await expect(page.getByRole("group", { name: "Fake" })).toBeVisible();
  for (const name of [
    "Fake Small",
    "Fake Large",
    "Fake Reasoning",
    "Fake Opus 2",
  ])
    await expect(option(page, name)).toHaveCount(1);
  // The refresh-only model is NOT listed until the engine is asked.
  await expect(option(page, "Fake Fresh")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The session picker (the thread panel's composer) starts on the same
  // default with its effort, and groups every model under its provider.
  await v3Peek(page)
    .getByPlaceholder("Message Default…")
    .fill("Check the relay reconnect plan");
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
  const home = triggers(page);
  await expect(home).toContainText("Fake Large", { timeout: 30_000 });
  await expect(home).toContainText("Medium");
  await home.click();
  await page.getByRole("button", { name: /Model$/ }).click();
  // Every model the engine reports, under its provider group.
  const group = page.getByRole("group", { name: "Fake" });
  await expect(group).toBeVisible();
  for (const name of [
    "Fake Small",
    "Fake Large",
    "Fake Reasoning",
    "Fake Opus 2",
  ])
    await expect(option(page, name)).toHaveCount(1);
  // The refresh-only model is NOT listed until the engine is asked.
  await expect(option(page, "Fake Fresh")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-1-catalog.png` });
  expect(errors).toEqual([]);
});

test("AC-2 the slider has exactly the picked model's stops; no ticks; Faster/Smarter ends", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await chatDefault(stackA, page, "Check the relay reconnect plan");
  await triggers(page).click();
  const slider = page.getByRole("slider", { name: "Reasoning effort" });
  // fake-large: efforts [low, medium, high] → slider 0..2.
  await expect(slider).toHaveAttribute("max", "2");
  await expect(page.getByText("Faster", { exact: true })).toBeVisible();
  await expect(page.getByText("Smarter", { exact: true })).toBeVisible();
  // No per-level tick buttons — drag/arrow only.
  await expect(page.getByRole("button", { name: "High" })).toHaveCount(0);
  await page.getByRole("button", { name: /Model$/ }).click();
  // Fake Reasoning reports the full ladder (7 stops).
  await option(page, "Fake Reasoning").click();
  await expect(slider).toHaveAttribute("max", "6");
  // A model without reasoning control shows no slider.
  await page.getByRole("button", { name: /Model$/ }).click();
  await option(page, "Fake Small").click();
  await expect(
    page.getByText("This model has no reasoning control."),
  ).toBeVisible();
  await expect(slider).toHaveCount(0);
  // …nor a fast toggle (Fake Small reports no fast tier).
  await expect(page.getByRole("button", { name: "Fast mode" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-2-no-dial.png` });
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("AC-3 + AC-4 the next turn runs the picked model + effort + fast; the footer shows them; a mid-turn pick applies next turn", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  // Park the first turn on an approval — provably running while we repick.
  await chatDefault(stackA, page, "Add a release note to the readme");
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  // A pick while running never errors and applies to the NEXT turn.
  await openModelList(page);
  await option(page, "Fake Reasoning").click();
  await page.getByRole("button", { name: "Fast mode" }).click();
  const slider = page.getByRole("slider", { name: "Reasoning effort" });
  await slider.press("ArrowUp"); // medium → high
  await page.keyboard.press("Escape");
  // Approve the pending ask so the parked turn can finish.
  for (let i = 0; i < 6; i++) {
    const b = page.getByRole("button", { name: "Allow", exact: true });
    if (
      !(await b
        .first()
        .isVisible()
        .catch(() => false))
    )
      break;
    await b.first().click();
    await page.waitForTimeout(400);
  }
  const turn = page.locator("[data-agentturn]").last();
  await expect(turn).toContainText(/Done on|Review it/, { timeout: 90_000 });
  // The running turn still reports the model it STARTED on — the pick
  // applies from the next turn.
  await expect(turn).toContainText("Fake Large", { timeout: 60_000 });
  await page.screenshot({ path: `${SHOTS}/ac-4-midturn-pick.png` });

  // The NEXT turn runs the pick — footer = engine turn.started truth.
  await send(page, "what changed?");
  await expectFooter(page, "Fake Reasoning · High · Fast");
  await expect(triggers(page)).toContainText("Fake Reasoning");
  await page.screenshot({ path: `${SHOTS}/ac-4-footer.png` });

  // AC-8: a "/" id round-trips verbatim — the footer resolves Fake Opus 2
  // from the catalog (the raw id never gets re-split into provider/model).
  // The High effort is kept across the switch (opus-2 reports it too), and
  // Fast drops because opus-2 has no fast tier.
  await openModelList(page);
  await option(page, "Fake Opus 2").click();
  await page.keyboard.press("Escape");
  await expect(triggers(page)).toContainText("Fake Opus 2");
  await send(page, "one more thing");
  await expectFooter(page, "Fake Opus 2 · High");
  await page.screenshot({ path: `${SHOTS}/ac-8-slash-id.png` });
  expect(errors).toEqual([]);
});

/* Was ac-30's "v2 new session" leg (#438): the same pick → footer flow as
   AC-3+AC-4, but the pick is made on the new-session composer BEFORE the
   session exists — it rides `conversations.open` into `session.start`, so the
   FIRST turn already runs it. The back half is AC-5's other clause: a fresh
   new-session composer starts on the employee default, never a sticky pick.
   v3: the draft's picker is the full one, so effort and Fast ride the first
   turn as before. */
test("AC-4 + AC-5 a pick on the new-session composer lands on the FIRST turn; the next new session is back on the employee default", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  const box = await openNewChat(page, stackA.webUrl);
  const chip = draftChip(page);
  await expect(chip).toContainText("Fake Large");
  await chip.click();
  const slider = page.getByRole("slider", { name: "Reasoning effort" });
  // fake-large reports 3 stops; the pick swaps in its own ladder.
  await expect(slider).toHaveAttribute("max", "2");
  await page.getByRole("button", { name: /Model$/ }).click();
  await option(page, "Fake Reasoning").click();
  await expect(slider).toHaveAttribute("max", "6");
  await slider.press("ArrowUp"); // medium → high
  await page.getByRole("button", { name: "Fast mode" }).click();
  await page.keyboard.press("Escape");
  await expect(chip).toContainText("Fake Reasoning");

  await box.fill("Check the relay reconnect plan");
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
  // The FIRST turn runs the pick — footer = engine turn.started truth.
  await expectFooter(page, "Fake Reasoning · High · Fast");
  // The session keeps its pick on its own composer.
  await expect(triggers(page)).toContainText("Fake Reasoning");
  await page.screenshot({ path: `${SHOTS}/ac-4-first-turn-pick.png` });

  // A new chat with the same person (their page → Message) is back on the
  // employee default. The sidebar pick jumped to the person's page (D-#769);
  // the draft it opens peeks beside it.
  await v3Sidebar(page)
    .getByRole("button", { name: /Default/ })
    .click();
  await v3Main(page).getByRole("button", { name: "Message" }).click();
  await expect(draftChip(page)).toContainText("Fake Large");
  expect(errors).toEqual([]);
});

test("AC-6 + AC-7 Refresh surfaces a new model without restart; Edit models' ONE hide list survives a relay restart; new models default to visible", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  await chatDefault(stackA, page, "Check the relay reconnect plan");
  await openModelList(page);
  // Refresh renders only because the engine declares it; the click re-lists.
  await page.getByRole("option", { name: /Refresh models/ }).click();
  await expect(option(page, "Fake Fresh")).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/ac-6-refresh.png` });

  // Edit models: the provider row hides the whole group…
  await page.getByRole("option", { name: /Edit models/ }).click();
  const dialog = page.getByRole("dialog", { name: "Models" });
  await dialog.getByRole("checkbox", { name: /Show all Fake/ }).click();
  await page.keyboard.press("Escape");
  await openModelList(page);
  // Every non-selected model leaves the list; the current pick stays visible
  // so the picker never yanks the selection out from under a session on it.
  await expect(option(page, "Fake Small")).toHaveCount(0);
  await expect(option(page, "Fake Reasoning")).toHaveCount(0);
  await expect(option(page, "Fake Large")).toHaveCount(1);
  // …and re-showing it restores every model (tri-state back to all-on).
  await page.getByRole("option", { name: /Edit models/ }).click();
  await dialog.getByRole("checkbox", { name: /Show all Fake/ }).click();
  await expect(dialog.getByText("5/5")).toBeVisible();
  // Then hide ONE model — Fake Reasoning leaves the list, the others stay.
  await dialog.getByRole("switch", { name: /Show Fake Reasoning/ }).click();
  await page.keyboard.press("Escape");
  await openModelList(page);
  await expect(option(page, "Fake Reasoning")).toHaveCount(0);
  await expect(option(page, "Fake Large")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${SHOTS}/ac-7-hidden.png` });

  // The ONE LilOS list lives in the relay's sqlite — it survives a full
  // stack restart on the same LILOS_HOME.
  const stackB = await bootStack(
    "picker-restart",
    await pickPorts(),
    {},
    { home: stackA.home },
  );
  try {
    await chatDefault(stackB, page, "Check the relay reconnect plan");
    await openModelList(page);
    await expect(option(page, "Fake Reasoning")).toHaveCount(0);
    // A model the engine adds AFTER the last edit is visible by default.
    await page.getByRole("option", { name: /Refresh models/ }).click();
    await expect(option(page, "Fake Fresh")).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/ac-7-restart.png` });
    await leaveApp(page, stackB);
  } finally {
    await stackB.stop();
  }
  expect(errors).toEqual([]);
});

/* Was ac-30's AC-3 leg (#438; the criterion is #30's). `?models=off` was a
   prototype flag — the real-stack twin is a stack whose harness filters the
   `models` capability out of `describe` (LILOS_HIDE_CAPS). No capability →
   no catalog → no picker control anywhere (D-#19: never a dead shell). */
test("AC-3 (#30) no picker when the engine lacks the models capability", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  const stackB = await bootStack("picker-nomodels", await pickPorts(), {
    LILOS_HIDE_CAPS: "models",
  });
  try {
    // The new-chat draft is rendered but carries no model chip.
    const box = await openNewChat(page, stackB.webUrl);
    await expect(box).toBeVisible();
    await expect(draftChip(page)).toHaveCount(0);
    await box.fill("Check the relay reconnect plan");
    await v3Peek(page).getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
    // …and the open session's composer has none either, mid-turn included.
    await expect(page.locator("[data-agentturn]").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(triggers(page)).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-3-no-picker.png` });
    await leaveApp(page, stackB);
  } finally {
    await stackB.stop();
  }
  expect(errors).toEqual([]);
});
