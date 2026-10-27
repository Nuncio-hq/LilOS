import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { growDmThread } from "./helpers/relay-thread";
import {
  bootStack,
  pickPorts,
  type Stack,
  skipFirstRun,
  threadUrl,
  v3Peek,
} from "./helpers/stack";
import {
  hideWorkbench,
  wbPanel,
  workMenu,
  workStrip,
} from "./helpers/workbench";

/**
 * Issue #560 — context-full UX: the engine's `session.compact` rides the
 * `compact` capability; the meter always offers Compact now, a compaction
 * posts exactly one "Context compacted: older turns summarized" note, and
 * at Full the thread also offers Continue in a new session.
 *
 * engine-fake's #560 probes drive both legs: a prompt starting
 * "contextfull" fails the turn on CONTEXT_LIMIT and pins the session at
 * its window (the Full read); `session.compact` drops the billed context
 * to ~12% and emits the typed `session.compacted` event the harness
 * persists as the thread note.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-560");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac560", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
    ENGINE_FAKE_TICK: "2",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});
test.describe.configure({ mode: "serial" });

test("AC: Compact now posts one compaction note and the meter drops", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const grown = await growDmThread(stack, ["Say hi.", "What is two plus two?"]);
  await skipFirstRun(page);
  await page.goto(threadUrl(stack.webUrl, grown.conversationId, true));

  /* The meter is the ⋯ menu's labeled Context row (#886); the card behind
     it is the same AI Elements hover card — a hover opens it and the
     `data-keepopen` card keeps the menu alive under the pointer. */
  await workMenu(page).click();
  const meter = page.getByRole("menuitem", { name: /Context used:/ });
  await expect(meter).toBeVisible({ timeout: 30_000 });
  await meter.hover();
  await expect(page.locator("[data-context-panel]")).toBeVisible();
  await expect(page.locator("[data-compact-now]")).toBeVisible();
  await page.locator("[data-context-panel]").screenshot({
    path: `${SHOTS}/panel-compact-now.png`,
  });

  await page.locator("[data-compact-now]").dispatchEvent("click");
  const note = page.locator("[data-sysnote]", {
    hasText: "Context compacted: older turns summarized",
  });
  await expect(note).toHaveCount(1, { timeout: 30_000 });
  await note.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/compacted-note.png` });
});

test("AC: context-limit failure offers Compact now + Continue in a new session", async ({
  page,
}) => {
  test.setTimeout(120_000);
  /* fake-large reports a real contextWindow so the failure probe can pin
     usage at it — the session starts on the default model, so pin the
     pick over the same relay call the picker makes. */
  const { RelayClient } = await import("../packages/client-runtime/src/client");
  const relay = new RelayClient({
    url: stack.relayWs,
    token: stack.relayToken,
    socketFactory: (url) => new WebSocket(url),
  });
  await relay.connect();
  try {
    const grown = await growDmThread(stack, ["Say hi."]);
    await relay.request("conversations.setModel", {
      conversationId: grown.conversationId,
      model: "fake-large",
    });
    /* The context-limit failure: the turn dies on CONTEXT_LIMIT and the
       session's usage pins at the window — the Full read. */
    await relay.request("messages.post", {
      channelId: grown.channelId,
      conversationId: grown.conversationId,
      authorId: "user",
      authorKind: "user",
      text: "contextfull please do the thing",
    });

    /* The thread in the side peek: a full context window is the ⋯ menu's
       Context row, which offers both outs (the old per-row alert in the
       DM list is gone with that list). */
    await skipFirstRun(page);
    await page.goto(threadUrl(stack.webUrl, grown.conversationId));
    await v3Peek(page)
      .locator(
        '[data-thread-header] [aria-label="Thread actions"], [data-thread-bar] [aria-label="Thread actions"]',
      )
      .click();
    const meter = page.getByRole("menuitem", {
      name: "Context window full",
    });
    await expect(meter).toBeVisible({ timeout: 60_000 });
    await meter.hover();
    const panel = page.locator("[data-context-panel]");
    await expect(panel).toBeVisible();
    await expect(page.locator("[data-compact-now]")).toBeVisible();
    await expect(page.locator("[data-continue-new-session]")).toBeVisible();
    await panel.screenshot({ path: `${SHOTS}/context-full-alert.png` });

    /* AC: Continue in a new session — a fresh root whose first message
       carries the transcript recap lands as a new thread (Threads → All). */
    /* dispatchEvent like the Compact leg above: the meter is a hover card
       and a thread row can sit under the pointer when the click lands. */
    await page.locator("[data-continue-new-session]").dispatchEvent("click");
    await page.goto(`${stack.webUrl}/#?page=threads`);
    /* The fresh root lands under Working while it runs (#862): the fold is
       collapsed by default and the sidebar mirrors the sections, so open
       Working inside #v3-main and count the row there. */
    const workingFold = page.locator(
      '#v3-main [data-fold="working"] > button[aria-expanded="false"]',
    );
    if (await workingFold.count()) await workingFold.click();
    const recap = page
      .locator("#v3-main")
      .getByRole("button")
      .filter({ hasText: "Picking up mid-thread" });
    await expect(recap).toHaveCount(1, { timeout: 30_000 });
    /* The row remounts while the fresh session moves between folds — let a
       detached node retry instead of racing it once. */
    await expect(async () => {
      await recap.first().scrollIntoViewIfNeeded({ timeout: 5_000 });
    }).toPass();
    await page.screenshot({ path: `${SHOTS}/continued-session.png` });
  } finally {
    relay.close();
  }
});

/* #770 + #886 design: the thread header (title and all) scrolls away with
   the conversation, but the ⋯ menu — home of the work surfaces and the
   context meter — must not go with it: a slim bar at the top of the column
   carries it, so Compact now is a menu and a hover away, never a scroll.
   The menu exists exactly once: in the header while it shows, in the bar
   after. */
test("AC: in a long thread Compact now stays on screen through the bar's ⋯", async ({
  page,
}) => {
  test.setTimeout(180_000);
  /* Tall `md: table` turns (ac-431): four overflow the scroller at any
     viewport the specs use, so the thread opens pinned to its end. */
  const grown = await growDmThread(
    stack,
    Array.from({ length: 4 }, (_, i) => `md: table — turn ${i + 1}`),
  );
  await skipFirstRun(page);
  await page.goto(threadUrl(stack.webUrl, grown.conversationId));
  const peek = v3Peek(page);
  const header = peek.locator("[data-thread-header]");
  const bar = peek.locator("[data-thread-bar]");
  const strip = page.locator("[data-work-strip]");
  const meter = page.getByRole("menuitem", { name: /Context used:/ });
  await expect(peek.locator("[data-agentturn]")).toHaveCount(4, {
    timeout: 60_000,
  });

  /* The title is above the fold; the bar names it small and carries the ⋯
     menu — the surfaces and the meter are rows inside it, not loose. */
  await expect(header).not.toBeInViewport({ timeout: 15_000 });
  await expect(bar).toBeVisible();
  await expect(bar.getByTitle(/./).first()).toBeVisible();
  await expect(
    bar.getByRole("button", { name: "Thread actions" }),
  ).toBeVisible();
  await expect(strip).toHaveCount(0);
  await bar.getByRole("button", { name: "Thread actions" }).click();
  await expect(strip).toBeVisible();
  await expect(meter).toBeVisible();

  /* Compact now is reachable straight from here: hover the Context row and
     the thread never had to scroll UP to the control (Playwright scrolls a
     target into view first when it is off screen; the pin only ever moves
     down as the content settles). */
  const log = peek.getByRole("log");
  const top = () => log.evaluate((el) => el.firstElementChild?.scrollTop ?? 0);
  const before = await top();
  await meter.hover();
  await expect(page.locator("[data-compact-now]")).toBeVisible();
  await expect(page.locator("[data-compact-now]")).toBeInViewport();
  expect(await top()).toBeGreaterThanOrEqual(before);
  await page.mouse.move(0, 0);
  await page.keyboard.press("Escape");

  /* Back at the top the header holds the ⋯ again — still exactly one. */
  await log.hover();
  await page.mouse.wheel(0, -20_000);
  await expect(header).toBeInViewport({ timeout: 15_000 });
  await expect(bar).toHaveCount(0);
  await expect(
    header.getByRole("button", { name: "Thread actions" }),
  ).toBeVisible();
  await header.getByRole("button", { name: "Thread actions" }).click();
  await expect(strip).toBeVisible();
  await expect(meter).toBeVisible();
  await page.keyboard.press("Escape");

  /* The widened session view is the same column: its ⋯ (the surfaces while
     the Workbench is hidden) rides the bar too. */
  await page.goto(threadUrl(stack.webUrl, grown.conversationId, true));
  await expect(page.locator("[data-agentturn]")).toHaveCount(4, {
    timeout: 60_000,
  });
  const sessionBar = page.locator("[data-thread-bar]");
  await expect(page.locator("[data-thread-header]")).not.toBeInViewport({
    timeout: 15_000,
  });
  if (await wbPanel(page).isVisible()) await hideWorkbench(page).click();
  await sessionBar.getByRole("button", { name: "Thread actions" }).click();
  await expect(strip).toBeInViewport({ ratio: 1 });
  await strip.locator('[data-work-tab="details"]').click();
  await expect(wbPanel(page)).toBeVisible();
  await expect(strip).toHaveCount(0);
});
