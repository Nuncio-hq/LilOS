import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  pickPorts,
  type Stack,
  startChat,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * One thread, the same truth on every surface (real stack: relay + harness on
 * engine-fake). A running turn reads Working on Home and Threads; an approval
 * is one count on the sidebar's Needs you, a card on Threads and a row on
 * Home, and answering it from Needs you lets the turn go on; a thread that
 * finished while nobody looked counts as finished-not-seen until it is opened.
 */

let stack: Stack;
let agent: { id: string; name: string };
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("v3status", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.locator("#v3-main");
const goTo = (page: Page, item: "Home" | "Needs you" | "Threads") =>
  v3Sidebar(page).getByRole("button", { name: item }).click();
/** A sidebar entry with its count: "Needs you 1", "Threads 0". */
const sideItem = (page: Page, item: "Needs you" | "Threads") =>
  v3Sidebar(page).getByRole("button", { name: new RegExp(`^${item}`) });
const card = (page: Page, title: RegExp) =>
  main(page).getByRole("button").filter({ hasText: title }).first();
/* Running threads fold under Working (#862): open the shelf before a row
   assertion reaches it. */
const openWorking = async (page: Page) => {
  const fold = main(page).locator(
    '[data-fold="working"] > button[aria-expanded="false"]',
  );
  if (await fold.count()) await fold.click();
};
/** The agent's row in Home's Team table (an ask row names the agent too). */
const teamRow = (page: Page) =>
  main(page)
    .getByRole("button", { name: new RegExp(agent.name) })
    .filter({ hasNotText: /wants to run/ });

test("a running turn reads Working on Home, Threads and the sidebar, until it is stopped", async ({
  page,
}) => {
  test.setTimeout(180_000);
  agent = await openDefaultAgent(page, stack.webUrl);

  // LILOS_TURN_HOLD parks the turn mid-run, so Working is there to look at.
  await startChat(
    page,
    stack.webUrl,
    agent,
    "LILOS_TURN_HOLD Add a release note to the readme",
  );
  await expect(
    v3Peek(page).getByRole("button", { name: /^stop \(⌘\.\)$/i }),
  ).toBeVisible({ timeout: 30_000 });

  // Threads: a Working row, counted live in the summary and the sidebar.
  // Running threads sit folded under Working (#862) — open the shelf, then
  // read the status dot (words are only for Needs-you/Failed pills).
  await goTo(page, "Threads");
  await expect(main(page).getByText(/1 working/)).toBeVisible({
    timeout: 30_000,
  });
  await openWorking(page);
  await expect(
    card(page, /release note/).locator('[data-v3-status="working"]'),
  ).toBeVisible();
  await expect(sideItem(page, "Threads")).toHaveText(/^Threads\s*1$/);

  // Home: the same agent, the same word, the same thread as what it works on.
  await goTo(page, "Home");
  await expect(teamRow(page)).toContainText("Working");
  await expect(teamRow(page)).toContainText("release note");
  await expect(main(page).getByText(/1 working/)).toBeVisible();

  // Stop from the thread: every surface drops Working together, and a turn
  // you stopped yourself is not "finished, not seen".
  await goTo(page, "Threads");
  await card(page, /release note/).click();
  await v3Peek(page)
    .getByRole("button", { name: /^stop \(⌘\.\)$/i })
    .click();
  await expect(v3Peek(page).getByText(/^Stopped$/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(main(page).getByText(/0 working/)).toBeVisible();
  await expect(main(page).getByText(/0 finished, not seen/)).toBeVisible();
  await expect(sideItem(page, "Threads")).toHaveText(/^Threads\s*0$/);
  await goTo(page, "Home");
  await expect(teamRow(page)).toContainText("Idle");
});

test("an approval is a Needs you count, a Threads card and a Home row; approving from Needs you resumes the turn; finished-not-seen clears on open", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openDefaultAgent(page, stack.webUrl);
  // A turn whose first edit asks before it patches the readme.
  await startChat(page, stack.webUrl, agent, "Add a footer to the page");

  // Sidebar: the one count that says something waits on you.
  await expect(sideItem(page, "Needs you")).toHaveText(/^Needs you\s*1$/, {
    timeout: 60_000,
  });

  // Threads: the thread's row wears the "Needs you" pill; the ask card with
  // the command and the two answers is inside the thread itself (#862's one
  // row per thread carries no card detail). The list counts it.
  await goTo(page, "Threads");
  const asking = card(page, /add a footer to the page/i);
  await expect(asking).toContainText("Needs you");
  await expect(main(page).getByText(/1 needs you/)).toBeVisible();
  await asking.click();
  const askCard = v3Peek(page).locator("[data-ask-id]").first();
  await expect(askCard).toContainText("patch wants to run", {
    timeout: 30_000,
  });
  await expect(askCard.getByRole("button", { name: "Deny" })).toBeVisible();
  await v3Peek(page).getByRole("button", { name: "Close" }).click();

  // Home: the agent reads Needs you, and the ask is a row with its answers.
  await goTo(page, "Home");
  await expect(teamRow(page)).toContainText("Needs you");
  const homeAsk = main(page)
    .getByRole("button")
    .filter({ hasText: /patch wants to run/ });
  await expect(homeAsk.getByRole("button", { name: "Approve" })).toBeVisible();

  // Needs you: the ask itself, the command it would run, and who asks.
  await goTo(page, "Needs you");
  await expect(main(page).getByText("1 waiting on you")).toBeVisible();
  await expect(main(page)).toContainText("patch wants to run");
  await expect(main(page)).toContainText(`${agent.name} asks`);

  // Approve each ask from here until the turn is over: it only gets past a
  // gated step because the answer reached it, so reaching "Finished" is the
  // turn resuming.
  const approve = main(page).getByRole("button", {
    name: "Approve",
    exact: true,
  });
  const finished = main(page).getByText("Finished", { exact: true });
  await expect(async () => {
    if (await approve.isVisible()) await approve.click();
    await expect(finished).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 120_000 });
  await expect(main(page).getByText("0 waiting on you")).toBeVisible();
  await expect(sideItem(page, "Needs you")).toHaveText(/^Needs you$/);

  // The turn's answer is in the thread; nobody has opened it yet, so it is
  // counted as finished-not-seen on Needs you (a result to look at) and on
  // Threads (a done row in Active, not a line in Earlier today).
  await expect(main(page).getByText("1 results to look at")).toBeVisible();
  await goTo(page, "Threads");
  await expect(main(page).getByText(/1 finished, not seen/)).toBeVisible();
  const unseen = card(page, /add a footer to the page/i);
  await expect(unseen.locator('[data-v3-status="done"]')).toBeVisible();

  // Opening the thread is what sees it: the count and the row go, on every
  // surface, and the thread moves down to Earlier today.
  await unseen.click();
  await expect(v3Peek(page)).toContainText("Allowed once", {
    timeout: 30_000,
  });
  await v3Peek(page).getByTitle("Close (Esc)").click();
  await expect(main(page).getByText(/0 finished, not seen/)).toBeVisible();
  await expect(
    main(page)
      .getByRole("button")
      .filter({ hasText: /add a footer to the page/i })
      .getByText("Finished", { exact: true }),
  ).toHaveCount(0);
  await goTo(page, "Needs you");
  await expect(main(page).getByText("0 results to look at")).toBeVisible();
  await expect(main(page)).toContainText("You're all caught up");
});
