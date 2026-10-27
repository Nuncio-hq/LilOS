import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  panelIntoFocus,
  pickPorts,
  type Stack,
  startChat,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * #773: Needs you lists every open ask, oldest first, with what yes and no
 * do. One test per acceptance criterion, on the engine-fake stack.
 */

let stack: Stack;
let agent: { id: string; name: string };
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac773", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.locator("#v3-main");
const goTo = (page: Page, item: "Needs you" | "Threads") =>
  v3Sidebar(page).getByRole("button", { name: item }).click();
const sideItem = (page: Page) =>
  v3Sidebar(page).getByRole("button", { name: /^Needs you/ });
const card = (page: Page, title: RegExp) =>
  main(page).getByRole("button").filter({ hasText: title }).first();

const SHOTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-results",
  "ac-773",
);
/** The PR's evidence, light and dark, with transitions finished. */
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

const ASK = `ask: Ship the paywall
why: The hooks scored best with readers
ifYes: The ads start today
ifNo: The ticket closes
option: Keep it
option: Ship it`;

test("an approval from one thread and a question from another both appear, oldest first", async ({
  page,
}) => {
  test.setTimeout(180_000);
  agent = await openDefaultAgent(page, stack.webUrl);

  await startChat(page, stack.webUrl, agent, "Add a one-line footer note");
  await expect(sideItem(page)).toHaveText(/^Needs you\s*1$/, {
    timeout: 60_000,
  });

  await startChat(
    page,
    stack.webUrl,
    agent,
    "question: where should this ship",
  );
  await expect(sideItem(page)).toHaveText(/^Needs you\s*2$/, {
    timeout: 60_000,
  });

  await goTo(page, "Needs you");
  /* #884: the ask is the one plain sentence everywhere — the raw tool+args
     JSON never shows. */
  await expect(main(page)).toContainText("Edit README.md?");
  await expect(main(page)).toContainText("Allow this next time");
  await expect(main(page)).toContainText(`${agent.name} asks`);
  // The question waiting underneath is titled by what it asks.
  const question = main(page).getByText(
    "Which environment should this change ship to?",
  );
  await expect(question).toBeVisible();
  await shot(page, "ac-1-approval-open");
  // The raw command is kept, but only behind Details: closed until opened.
  const details = main(page)
    .locator("[data-approval-details]")
    .filter({ hasText: 'patch {"path":"README.md"}' });
  await expect(details.locator("pre")).toBeHidden();
  await details.locator("summary").click();
  await expect(details.locator("pre")).toContainText(
    'patch {"path":"README.md"}',
  );

  // The newer question is the one underneath. Open it: no allow-next-time.
  await question.click();
  await expect(main(page)).toContainText(
    "Which environment should this change ship to?",
  );
  await expect(main(page).getByText("Allow this next time")).toHaveCount(0);
  // A question has no approve or deny (D-#19), so the hint is only J/K.
  await expect(main(page)).toContainText("J/K move");
  await expect(main(page).getByText(/A approve/)).toHaveCount(0);
  await shot(page, "ac-1-question-open");

  // Back to the older approval, then clear both so the next criterion starts empty.
  await page.keyboard.press("k");
  await expect(main(page).getByText("Allow this next time")).toBeVisible();
  await main(page).getByRole("button", { name: "Deny", exact: true }).click();
  await expect(
    main(page).getByRole("button", { name: "Staging first" }),
  ).toBeVisible({ timeout: 30_000 });
  await main(page).getByRole("button", { name: "Staging first" }).click();
  await expect(sideItem(page)).toHaveText(/^Needs you$/, { timeout: 60_000 });
});

test("approve from Needs you resumes the turn and the item disappears everywhere", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openDefaultAgent(page, stack.webUrl);
  await startChat(page, stack.webUrl, agent, "Add a footer to the page");
  await expect(sideItem(page)).toHaveText(/^Needs you\s*1$/, {
    timeout: 60_000,
  });

  await goTo(page, "Needs you");
  const approve = main(page).getByRole("button", {
    name: "Allow",
    exact: true,
  });
  // Earlier criteria already left finished threads here, so "Finished"
  // is not unique. This turn is done when its own result row appears.
  const result = main(page).getByRole("button", {
    name: /add a footer to the page/i,
  });
  await expect(async () => {
    if (await approve.isVisible()) await approve.click();
    await expect(result).toContainText("Finished", { timeout: 2_000 });
  }).toPass({ timeout: 120_000 });

  await expect(sideItem(page)).toHaveText(/^Needs you$/);
  await expect(main(page).getByText("0 waiting on you")).toBeVisible();
  await shot(page, "ac-2-needs-you-cleared");

  await goTo(page, "Threads");
  const row = card(page, /add a footer to the page/i);
  await expect(row.locator('[data-v3-status="done"]')).toBeVisible();
  await expect(row.getByRole("button", { name: "Allow" })).toHaveCount(0);
  await shot(page, "ac-2-thread-card-finished");
});

test("an agent ask with why, if yes and if no shows those lines", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDefaultAgent(page, stack.webUrl);
  await startChat(page, stack.webUrl, agent, ASK);
  await expect(sideItem(page)).toHaveText(/^Needs you\s*1$/, {
    timeout: 60_000,
  });

  await goTo(page, "Needs you");
  await expect(main(page)).toContainText("Ship the paywall");
  await expect(main(page)).toContainText("Why");
  await expect(main(page)).toContainText("The hooks scored best with readers");
  await expect(main(page)).toContainText("If yes");
  await expect(main(page)).toContainText("The ads start today");
  await expect(main(page)).toContainText("If no");
  await expect(main(page)).toContainText("The ticket closes");
  await expect(main(page)).toContainText(`${agent.name} asks`);
  await expect(main(page).getByText("Allow this next time")).toHaveCount(0);
  await shot(page, "ac-3-why-if-yes-if-no");

  await main(page)
    .getByRole("button", { name: "Ship it", exact: true })
    .click();
  await expect(main(page)).toContainText("Heard the answer and carried on.", {
    timeout: 60_000,
  });
  await expect(sideItem(page)).toHaveText(/^Needs you$/);
});

test("A, D, J and K work, and do nothing while typing in a field", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDefaultAgent(page, stack.webUrl);
  await startChat(
    page,
    stack.webUrl,
    agent,
    "ask: Ship the paywall\nwhy: Readers liked the hooks",
  );
  await expect(sideItem(page)).toHaveText(/^Needs you\s*1$/, {
    timeout: 60_000,
  });
  await startChat(
    page,
    stack.webUrl,
    agent,
    "ask: Retire the old banner\nwhy: It covers the title",
  );
  await expect(sideItem(page)).toHaveText(/^Needs you\s*2$/, {
    timeout: 60_000,
  });

  await goTo(page, "Needs you");
  // Opening the page clears the thread peek, so the keys are not typing.
  // The why line is only on the open card, so it says which ask is open.
  await expect(main(page)).toContainText("Readers liked the hooks");
  await expect(main(page)).toContainText("A approve · D deny · J/K move");
  await shot(page, "ac-4-keys-hint");

  // Widened, the thread covers Needs you. A bare `a` must not approve.
  // This stack's Workbench has no Terminal tab (no live PTY), so the
  // `[data-lilos-terminal]` case cannot be driven here.
  await main(page).getByRole("button", { name: "Open thread" }).click();
  await panelIntoFocus(page);
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.keyboard.press("a");
  await expect(sideItem(page)).toHaveText(/^Needs you\s*2$/);
  await expect(main(page)).toContainText("Readers liked the hooks");

  await v3Peek(page)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page).not.toHaveURL(/open=thread:/);

  // Typing in Search swallows J and A: the open card and the count stay.
  await v3Sidebar(page)
    .getByRole("button", { name: /^Search/ })
    .click();
  const search = page
    .getByRole("dialog", { name: "Search" })
    .getByRole("textbox");
  await expect(search).toBeFocused();
  await page.keyboard.press("j");
  await page.keyboard.press("a");
  await expect(search).toHaveValue(/ja/i);
  await expect(main(page)).toContainText("Readers liked the hooks");
  await expect(sideItem(page)).toHaveText(/^Needs you\s*2$/);
  await page.keyboard.press("Escape");

  await page.keyboard.press("j");
  await expect(main(page)).toContainText("It covers the title");
  await expect(main(page).getByText("Readers liked the hooks")).toHaveCount(0);
  await shot(page, "ac-4-j-moved");
  await page.keyboard.press("k");
  await expect(main(page)).toContainText("Readers liked the hooks");
  await expect(main(page).getByText("It covers the title")).toHaveCount(0);

  await page.keyboard.press("a");
  await expect(sideItem(page)).toHaveText(/^Needs you\s*1$/, {
    timeout: 60_000,
  });
  await expect(main(page)).toContainText("Retire the old banner");

  await v3Sidebar(page)
    .getByRole("button", { name: /^Search/ })
    .click();
  await expect(search).toBeFocused();
  await page.keyboard.press("d");
  await expect(search).toHaveValue(/d/i);
  await expect(sideItem(page)).toHaveText(/^Needs you\s*1$/);
  await page.keyboard.press("Escape");

  await page.keyboard.press("d");
  await expect(sideItem(page)).toHaveText(/^Needs you$/, { timeout: 60_000 });
});
