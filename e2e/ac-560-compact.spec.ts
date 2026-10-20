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

  /* The meter's trigger is an AI Elements Context button — accessible
     name carries the current share ("Context used: …"). */
  const meter = page.getByRole("button", { name: /Context used:/ }).first();
  await expect(meter).toBeVisible({ timeout: 30_000 });
  /* A hover card, not a click popover: open it by hovering and keep the
     pointer on it so it stays open for the click. */
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

    /* The thread in the side peek: a full context window shows on the
       header's meter, which offers both outs (the old per-row alert in the
       DM list is gone with that list). */
    await skipFirstRun(page);
    await page.goto(threadUrl(stack.webUrl, grown.conversationId));
    const meter = v3Peek(page).getByRole("button", {
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
    await page.goto(`${stack.webUrl}/#?page=threads&view=all`);
    const recap = page
      .getByRole("button")
      .filter({ hasText: "Picking up mid-thread" });
    await expect(recap).toHaveCount(1, { timeout: 30_000 });
    await recap.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/continued-session.png` });
  } finally {
    relay.close();
  }
});
