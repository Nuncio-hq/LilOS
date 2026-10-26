import path from "node:path";
import { fileURLToPath } from "node:url";
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
 * #774: Home answers who is working, what needs you, and what just finished.
 * One test per acceptance criterion, on the engine-fake stack. Counts and
 * the finished rows are the same ones Threads and Needs you show. Stuck is
 * not on this build, so Home leaves that count out.
 */

let stack: Stack;
let agent: { id: string; name: string };
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac774", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.locator("#v3-main");
const goTo = (page: Page, item: "Home" | "Needs you" | "Threads") =>
  v3Sidebar(page)
    .getByRole("button", { name: new RegExp(`^${item}`) })
    .click();
const sideItem = (page: Page) =>
  v3Sidebar(page).getByRole("button", { name: /^Needs you/ });
/** The agent's row in the team table: it wears a status pill, an ask and a
    finished result do not. */
const teamRow = (page: Page) =>
  main(page)
    .getByRole("button", { name: new RegExp(agent.name) })
    .filter({ hasText: /Idle|Working|Needs you|Failed|Stuck/ });

const SHOTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-results",
  "ac-774",
);

/** The criterion's evidence, light and dark, with transitions finished. */
async function shot(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({
      path: path.join(SHOTS, `${name}-${scheme}.png`),
      animations: "disabled",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** A count in the strip under the title. Absent means zero (Home hides it). */
async function countWord(page: Page, word: string): Promise<number> {
  const row = main(page)
    .locator("span.inline-flex")
    .filter({ hasText: new RegExp(`\\d+\\s+${word}`) });
  if ((await row.count()) === 0) return 0;
  const text = (await row.first().innerText()).replace(/\s+/g, " ");
  return Number(/(\d+)/.exec(text)?.[1] ?? Number.NaN);
}

const idleCards = (page: Page) =>
  main(page).getByRole("button").filter({ hasText: "Asleep" });

async function enter(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  agent = await openDefaultAgent(page, stack.webUrl);
}

test("each agent's row shows its live thread and since when; an idle agent shows the next scheduled run", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await enter(page);

  await goTo(page, "Threads");
  await main(page).getByRole("button", { name: "Scheduled" }).click();
  await main(page).getByRole("button", { name: "New schedule" }).click();
  await main(page).getByPlaceholder("Morning triage").fill("Morning triage");
  await main(page)
    .getByPlaceholder(/is told each time/)
    .fill("Check what came in overnight");
  await main(page).getByRole("button", { name: "Create schedule" }).click();
  const saved = main(page).getByText(/^Next /);
  await expect(saved).toBeVisible();
  const next = /^Next\s+(.+)$/.exec(
    (await saved.innerText()).replace(/\s+/g, " "),
  )?.[1];
  expect(next).toBeTruthy();

  await goTo(page, "Home");
  await expect(teamRow(page)).toContainText("Idle", { timeout: 30_000 });
  await expect(teamRow(page)).toContainText("Morning triage");
  await expect(teamRow(page)).toContainText(next as string);
  await shot(page, "ac-2-idle");

  await startChat(
    page,
    stack.webUrl,
    agent,
    "LILOS_TURN_HOLD Add a release note to the readme",
  );
  await expect(
    v3Peek(page).getByRole("button", { name: /^stop \(⌘\.\)$/i }),
  ).toBeVisible({ timeout: 30_000 });

  await goTo(page, "Home");
  await expect(teamRow(page)).toContainText("Working");
  await expect(teamRow(page)).toContainText(/release note/i);
  await expect(teamRow(page)).not.toContainText("Morning triage");
  await expect(main(page).getByText("Since", { exact: true })).toBeVisible();
  await expect(teamRow(page)).toContainText(/now|1m/);
  await shot(page, "ac-2-live");
});

test("counts match Threads", async ({ page }) => {
  test.setTimeout(180_000);
  await enter(page);

  await goTo(page, "Threads");
  await expect(main(page).getByText(/1 working/)).toBeVisible({
    timeout: 30_000,
  });
  // Stuck is printed on Threads and left off Home: nothing marks a thread
  // stuck on this build.
  await expect(main(page).getByText(/0 stuck/)).toBeVisible();
  expect(await idleCards(page).count()).toBe(0);

  await goTo(page, "Home");
  expect(await countWord(page, "working")).toBe(1);
  expect(await countWord(page, "needs you")).toBe(0);
  expect(await countWord(page, "idle")).toBe(0);
  await expect(main(page).getByText(/stuck/i)).toHaveCount(0);

  // A second thread that needs you, while the first is still working: the
  // strip counts threads, so both numbers show, matching Threads.
  await startChat(page, stack.webUrl, agent, "Add a footer to the page");
  await expect(sideItem(page)).toHaveText(/^Needs you\s*1$/, {
    timeout: 60_000,
  });

  await goTo(page, "Threads");
  const working = await countWord(page, "working");
  const needs = await countWord(page, "needs you");
  const idle = await idleCards(page).count();
  expect(working).toBe(1);
  expect(needs).toBe(1);
  expect(idle).toBe(0);
  await expect(main(page).getByText(/0 stuck/)).toBeVisible();

  await goTo(page, "Home");
  expect(await countWord(page, "working")).toBe(working);
  expect(await countWord(page, "needs you")).toBe(needs);
  expect(await countWord(page, "idle")).toBe(idle);
  await expect(main(page).getByText(/stuck/i)).toHaveCount(0);
  await shot(page, "ac-1-counts");
});

test("approve on Home resolves the ask everywhere, and the result is the same row Needs you shows", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await enter(page);
  await goTo(page, "Home");
  const approve = main(page).getByRole("button", {
    name: "Approve",
    exact: true,
  });
  await expect(approve.first()).toBeVisible({ timeout: 30_000 });
  const recent = main(page).getByRole("heading", { name: /Recent results/ });
  await expect(async () => {
    if (await approve.first().isVisible()) await approve.first().click();
    await expect(recent).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 120_000 });

  await expect(sideItem(page)).toHaveText(/^Needs you$/);
  await expect(approve).toHaveCount(0);
  await expect(
    main(page).getByRole("button", { name: /add a footer/i }),
  ).toBeVisible();
  await shot(page, "ac-3-resolved");

  await goTo(page, "Needs you");
  await expect(main(page).getByText("0 waiting on you")).toBeVisible();
  await expect(main(page).getByText("1 results to look at")).toBeVisible();
  await expect(
    main(page).getByRole("button", { name: /add a footer/i }),
  ).toBeVisible();
  await expect(
    main(page).getByRole("button", { name: "Approve", exact: true }),
  ).toHaveCount(0);

  await goTo(page, "Threads");
  const card = main(page)
    .getByRole("button")
    .filter({ hasText: /add a footer/i })
    .first();
  await expect(card.locator('[data-v3-status="done"]')).toBeVisible();
  await expect(card.getByRole("button", { name: "Approve" })).toHaveCount(0);

  // Opening the result from Home is what sees it, on Needs you too.
  await goTo(page, "Home");
  await main(page)
    .getByRole("button", { name: /add a footer/i })
    .click();
  await expect(v3Peek(page)).toBeVisible({ timeout: 30_000 });
  await v3Peek(page).getByTitle("Close (Esc)").click();
  await expect(recent).toHaveCount(0);
  await goTo(page, "Needs you");
  await expect(main(page).getByText("0 results to look at")).toBeVisible();
});
