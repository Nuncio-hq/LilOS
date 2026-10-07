import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #137 — sessions name themselves: a placeholder from the first
 * message, then the engine's derived title, then its small-model (llm)
 * title — and a user rename always wins over a late engine title.
 * Runs the real stack (relay + harness + vite, engine-fake).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-137");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac137", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});
test.describe.configure({ mode: "serial" });
test.use({ trace: "retain-on-failure" });

async function dmDefault(page: Page) {
  await page.goto(`${stack.webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 60_000,
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

/** The open thread's header title. */
const headerTitle = (page: Page) => page.locator("[data-session-title]");

/** Stage ordering: placeholder < derived < llm — titles must never regress.
    The prompt avoids edit-verbs so engine-fake runs a clean read turn. */
const STAGE = [
  "Explain the whole repository layout in…", // placeholder: first 6 words + …
  "Explain the whole repository layout in detail p…", // derived: ≤48 chars
  "Explain The Whole Repository Layout In Detail Please", // llm upgrade
] as const;
const PROMPT = "Explain the whole repository layout in detail please";

test("AC-3/AC-4 placeholder then engine titles land live in header, list, search", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await send(page, PROMPT);
  await expect(page).toHaveURL(/\/dm\/[^/]+\/conv_/, { timeout: 10_000 });
  // A new session opens in Focus (#114); its header carries the title too.

  /* AC-4 "≤1 visible flicker placeholder → derived → llm": poll the header
     title and assert the observed stages only ever move forward. */
  const seen: string[] = [];
  const deadline = Date.now() + 60_000;
  for (;;) {
    const t =
      (await headerTitle(page)
        .textContent()
        .catch(() => "")) ?? "";
    if (t && seen.at(-1) !== t) seen.push(t);
    if (t === STAGE[2]) break;
    if (Date.now() > deadline)
      throw new Error(`title never reached the llm stage; trace: ${seen}`);
    await page.waitForTimeout(80);
  }
  const stages = seen.map((t) => STAGE.indexOf(t as (typeof STAGE)[number]));
  for (const t of seen) {
    expect(
      STAGE.includes(t as (typeof STAGE)[number]),
      `unexpected title "${t}" in trace ${seen}`,
    ).toBe(true);
  }
  for (let i = 1; i < stages.length; i++) {
    expect(stages[i], `title regressed: ${seen}`).toBeGreaterThan(
      stages[i - 1],
    );
  }
  expect(seen.at(-1)).toBe(STAGE[2]);
  await page.screenshot({ path: `${SHOTS}/ac34-header-llm-title.png` });

  // AC-4: the session list row + title search show the engine title.
  // #577: the send landed on /dm/e/c — feed + panel are already mounted.
  await expect(page).toHaveURL(/\/dm\/[^/]+\/conv_[^/]+$/, {
    timeout: 10_000,
  });
  const row = page.locator("[data-session]", { hasText: STAGE[2] });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder("Filter threads").fill("Detail Please");
  await expect(row).toBeVisible();
  await page.getByPlaceholder("Filter threads").fill("zzz-no-match");
  await expect(row).toBeHidden();
  await page.getByPlaceholder("Filter threads").fill("");
  await page.screenshot({ path: `${SHOTS}/ac34-list-auto-title.png` });
});

test("AC-2 a mid-turn rename survives the late llm title", async ({ page }) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  /* "Add a footer" parks on an approval ask mid-turn: the derived title has
     landed but the llm title is still owed — a deterministic race window. */
  await send(page, "Add a footer to the page");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/conv_/, { timeout: 10_000 });
  await expect(
    page.getByRole("button", { name: "Once", exact: true }).first(),
  ).toBeVisible({ timeout: 60_000 });

  // Back to the session list; rename the running session.
  await page.goBack();
  const row = page.locator("div[data-session]", {
    hasText: "Add a footer to the page",
  });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Thread actions" }).click();
  await page.getByRole("menuitem", { name: "Rename thread" }).click();
  const input = page.getByLabel("Thread title");
  await input.fill("My footer session");
  await input.press("Enter");
  await expect(
    page.locator("div[data-session]", { hasText: "My footer session" }),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac2-renamed-mid-turn.png` });

  // Finish the turn: the canned flow asks more than once — keep answering
  // "Once" until it completes; the llm title must not overwrite the
  // rename.
  // The row opens the session's peek panel (#195) — the turn text lives
  // there now, not in `main` (which stays the feed).
  await row.getByRole("button", { name: /\d+ repl(y|ies)/ }).click();
  const doneOn = page
    .locator("[data-thread-panel]")
    .getByText("Done on")
    .first();
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (await doneOn.isVisible().catch(() => false)) break;
    const allow = page
      .getByRole("button", { name: "Once", exact: true })
      .first();
    if (await allow.isVisible().catch(() => false)) await allow.click();
    if (Date.now() > deadline)
      throw new Error("turn never completed after answering approvals");
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1_500); // settle window for the late title write
  await expect(headerTitle(page)).toHaveText("My footer session");

  // Reload → reconnect replays the engine title; the rename still stands.
  await page.reload();
  await expect(headerTitle(page)).toHaveText("My footer session", {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac2-rename-kept.png` });
});
