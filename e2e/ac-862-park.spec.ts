import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  freePort,
  openDefaultAgent,
  relayRpc,
  type Stack,
  skipFirstRun,
  startChat,
  v3Main,
} from "./helpers/stack";

/**
 * D-#862 second slice — park state is relay state, not a mock: Settle,
 * Snooze and Pin on a real thread (relay + harness on engine-fake), each
 * leg read back after a page reload (persisted, not client cache), and a
 * settle issued by a second client landing live. Rows carry the relay's
 * stamps — pin under Pinned, a snooze under its own fold until Wake now,
 * a settled thread on the Settled shelf where Un-settle brings it back.
 */

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  /* Vite's port has to be chosen before spawn and this worker's slice can
     be held by another worktree's stack on the shared Mac — a probed port
     in the free band answers that; relay/feed still self-report on 0. */
  stack = await bootStack("v3park", {
    relay: 0,
    feed: 0,
    web: await freePort(),
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const main = (page: Page) => v3Main(page);
/** The thread's row inside a fold's section (Working/Snoozed/Settled). */
const inFold = (page: Page, fold: string, convId: string) =>
  main(page).locator(`[data-fold="${fold}"] [data-thread-row="${convId}"]`);
const rowAnywhere = (page: Page, convId: string) =>
  main(page).locator(`[data-thread-row="${convId}"]`);
const foldButton = (page: Page, fold: string) =>
  main(page).locator(`[data-fold="${fold}"] > button`);
/** Open a shelf if it renders collapsed (fold prefs persist in
    localStorage — a blind click can close an open one). */
const ensureOpen = async (page: Page, fold: string) => {
  const btn = foldButton(page, fold);
  if (
    (await btn.count()) &&
    (await btn.getAttribute("aria-expanded")) === "false"
  )
    await btn.click();
};
/** Open every shelf so the row is clickable wherever it sits. */
const openFolds = async (page: Page) => {
  for (const fold of ["working", "snoozed", "settled"]) {
    await ensureOpen(page, fold);
  }
};
const menu = async (page: Page, convId: string) => {
  const row = rowAnywhere(page, convId);
  await row.hover();
  await row
    .getByRole("button", { name: "Thread actions", exact: true })
    .click();
};
const wire = async (page: Page, convId: string) => {
  const { conversations } = await relayRpc<{
    conversations: {
      id: string;
      pinnedAt?: number;
      snoozedUntil?: number;
      settledAt?: number;
      archived: boolean;
    }[];
  }>(page, stack, "conversations.list", { includeArchived: true });
  const c = conversations.find((x) => x.id === convId);
  if (!c) throw new Error(`conversation ${convId} missing on the wire`);
  return c;
};

let convId = "";

/* Every test gets a fresh page — land on Threads each time. The sections
   load async (relay connect → summaries), so wait for ANY row/fold to
   attach before opening folds — clicking earlier races the data. */
const goThreads = async (page: Page) => {
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/#?page=threads`);
  await expect(
    main(page).locator("[data-thread-row], [data-fold]").first(),
  ).toBeAttached({ timeout: 30_000 });
  await openFolds(page);
  await expect(rowAnywhere(page, convId)).toBeVisible({ timeout: 30_000 });
};

test("setup: a thread on the seeded agent", async ({ page }) => {
  const agent = await openDefaultAgent(page, stack.webUrl);
  convId = await startChat(page, stack.webUrl, agent, "park me");
  await goThreads(page);
});

test("pin lands under Pinned and stays there across a reload", async ({
  page,
}) => {
  await goThreads(page);
  await menu(page, convId);
  await page.getByRole("menuitem", { name: "Pin thread" }).click();
  await expect(main(page).getByText("Pinned", { exact: true })).toBeVisible();
  expect(typeof (await wire(page, convId)).pinnedAt).toBe("number");

  await page.reload();
  await expect(main(page).getByText("Pinned", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(rowAnywhere(page, convId)).toBeVisible();
  expect(typeof (await wire(page, convId)).pinnedAt).toBe("number");
});

test("snooze folds the thread until Wake now — across a reload", async ({
  page,
}) => {
  await goThreads(page);
  await menu(page, convId);
  await page.getByRole("menuitem", { name: "Snooze" }).click();
  await page.getByRole("menuitem", { name: "1 h" }).click();
  /* Off the live list into the Snoozed fold; the wire stamp is set. */
  await expect(foldButton(page, "snoozed")).toContainText("Snoozed");
  await expect(inFold(page, "snoozed", convId)).toHaveCount(0); // folded
  expect(typeof (await wire(page, convId)).snoozedUntil).toBe("number");

  await page.reload();
  await expect(foldButton(page, "snoozed")).toContainText("Snoozed", {
    timeout: 30_000,
  });
  await ensureOpen(page, "snoozed");
  await expect(inFold(page, "snoozed", convId)).toBeVisible();

  /* Wake now clears it — the thread is back on the live list and the
     empty fold unmounts (Fold renders nothing at count 0). */
  await menu(page, convId);
  await page.getByRole("menuitem", { name: "Wake now" }).click();
  await expect(foldButton(page, "snoozed")).toHaveCount(0);
  expect((await wire(page, convId)).snoozedUntil).toBeUndefined();
});

test("settle shelves the thread — pin goes with it — across a reload", async ({
  page,
}) => {
  await goThreads(page);
  /* Still pinned from the pin leg (snooze/wake never touch it) — settle
     must take the pin with it. */
  expect(typeof (await wire(page, convId)).pinnedAt).toBe("number");
  await menu(page, convId);
  await page.getByRole("menuitem", { name: "Settle thread" }).click();
  /* Off every live section; on the shelf; the pin went with the settle. */
  await expect(rowAnywhere(page, convId)).toHaveCount(0);
  await expect(foldButton(page, "settled")).toContainText("Settled (1)");
  const onWire = await wire(page, convId);
  expect(typeof onWire.settledAt).toBe("number");
  expect(onWire.archived).toBe(true);
  expect(onWire.pinnedAt).toBeUndefined();

  await page.reload();
  await expect(foldButton(page, "settled")).toContainText("Settled (1)", {
    timeout: 30_000,
  });
  await ensureOpen(page, "settled");
  await expect(inFold(page, "settled", convId)).toBeVisible();

  /* Un-settle brings it back to the live list. */
  await menu(page, convId);
  await page.getByRole("menuitem", { name: "Un-settle thread" }).click();
  await expect(inFold(page, "settled", convId)).toHaveCount(0);
  await expect(rowAnywhere(page, convId)).toBeVisible();
  const back = await wire(page, convId);
  expect(back.settledAt).toBeUndefined();
  expect(back.archived).toBe(false);
});

test("a settle from a second client lands live — no reload", async ({
  page,
}) => {
  await goThreads(page);
  /* A fresh socket = another client; the page must move the row on the
     conversation.updated broadcast alone. */
  await relayRpc(page, stack, "conversations.settle", {
    conversationId: convId,
    settled: true,
  });
  await expect(rowAnywhere(page, convId)).toHaveCount(0);
  await expect(foldButton(page, "settled")).toContainText("Settled (1)");
  /* …and back, still without a reload. */
  await relayRpc(page, stack, "conversations.settle", {
    conversationId: convId,
    settled: false,
  });
  await expect(rowAnywhere(page, convId)).toBeVisible();
});
