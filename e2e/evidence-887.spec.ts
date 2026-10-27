import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  freePort,
  openDefaultAgent,
  relayRpc,
  type Stack,
  startChat,
  startChatInFolder,
  v3Main,
} from "./helpers/stack";

/**
 * Evidence capture for #887 — the UI says Done / Not done, and Threads is
 * one list by status (Pinned · Active · Working · Snoozed · Done) with no
 * tabs, no Group-by switch and no counters. The project page uses the
 * same statuses.
 *
 * Not part of the verify suite: every test here is skipped unless
 * `LILOS_EVIDENCE=1` is set. Run locally to regenerate the PR's shots:
 *
 *   LILOS_EVIDENCE=1 bunx playwright test e2e/evidence-887.spec.ts
 *
 * Output lands in test-results/evidence/887/ — the "after" shots on the
 * real app (relay + harness + engine-fake). The audit's "before" shots
 * are /tmp/lilos-ux/22-threads-page.png, 28-project-page.png and
 * 42-thread-row-menu.png.
 */

test.skip(
  process.env.LILOS_EVIDENCE !== "1",
  "evidence capture only — set LILOS_EVIDENCE=1",
);

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const OUT = path.join(here, "..", "test-results", "evidence", "887");

let stack: Stack;
const ids = {
  pinned: "",
  active: "",
  working: "",
  snoozed: "",
  done: "",
  project: "",
};

test.beforeAll(async () => {
  test.setTimeout(240_000);
  mkdirSync(OUT, { recursive: true });
  stack = await bootStack("v3done887", {
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
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
/** One shot per colour scheme — Oscar reads both. */
const shotBoth = async (page: Page, name: string) => {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({
      path: path.join(OUT, `${name}-${scheme}.png`),
      animations: "disabled",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
};
const row = (page: Page, id: string) =>
  main(page).locator(`[data-thread-row="${id}"]`);
const foldButton = (page: Page, fold: string) =>
  main(page).locator(`[data-fold="${fold}"] > button`);
const ensureOpen = async (page: Page, fold: string) => {
  const btn = foldButton(page, fold);
  if (
    (await btn.count()) &&
    (await btn.getAttribute("aria-expanded")) === "false"
  )
    await btn.click();
};
const menu = async (page: Page, id: string) => {
  await row(page, id).hover();
  await row(page, id)
    .getByRole("button", { name: "Thread actions", exact: true })
    .click();
};

test("after: Threads is one list by status and the menu says Done", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const agent = await openDefaultAgent(page, stack.webUrl);
  /* One thread per status: the held turn stays Working; the rest finish
     and land Active until they are pinned, snoozed or marked done. */
  ids.pinned = await startChat(page, stack.webUrl, agent, "pin evidence");
  ids.active = await startChat(page, stack.webUrl, agent, "active evidence");
  ids.working = await startChat(
    page,
    stack.webUrl,
    agent,
    "LILOS_TURN_HOLD working evidence",
  );
  ids.snoozed = await startChat(page, stack.webUrl, agent, "snooze evidence");
  ids.done = await startChat(page, stack.webUrl, agent, "done evidence");

  await page.goto(`${stack.webUrl}/#?page=threads`);
  await expect(row(page, ids.done)).toBeVisible({ timeout: 30_000 });

  /* Pin, snooze and done from the row menus — the same moves Oscar makes. */
  await menu(page, ids.pinned);
  await page.getByRole("menuitem", { name: "Pin thread" }).click();
  await expect(main(page).getByText("Pinned", { exact: true })).toBeVisible();

  await menu(page, ids.snoozed);
  await page.getByRole("menuitem", { name: "Snooze" }).click();
  await page.getByRole("menuitem", { name: "1 h" }).click();
  await expect(foldButton(page, "snoozed")).toContainText("Snoozed (1)");

  await menu(page, ids.done);
  await page.getByRole("menuitem", { name: "Done", exact: true }).click();
  await expect(foldButton(page, "settled")).toContainText("Done (1)");

  /* The list shot: every status on one page, no tabs / Group-by /
     counters. Folds open so the rows show. */
  await menu(page, ids.active);
  await shot(page, "thread-menu");
  await page.keyboard.press("Escape");
  await ensureOpen(page, "working");
  await ensureOpen(page, "snoozed");
  await ensureOpen(page, "settled");
  await shot(page, "threads-list");

  /* The Done shelf's menu leads with Not done. */
  await menu(page, ids.done);
  await shot(page, "not-done-menu");
  await page.keyboard.press("Escape");
});

test("after: the project page uses the same statuses", async ({ page }) => {
  test.setTimeout(240_000);
  const agent = await openDefaultAgent(page, stack.webUrl);
  mkdirSync(path.join(stack.home, "repos"), { recursive: true });
  const dir = mkdtempSync(path.join(stack.home, "repos", "lilos-evidence-"));
  execSync("git init -b main", { cwd: dir });
  /* projects.create is get-or-create by folder — the id it returns is
     the page's. */
  const { project } = await relayRpc<{ project: { id: string } }>(
    page,
    stack,
    "projects.create",
    { folder: dir },
  );
  ids.project = await startChatInFolder(
    page,
    stack,
    agent,
    dir,
    "project evidence",
  );
  await page.goto(`${stack.webUrl}/#?page=project&id=${project.id}`);
  const threads = main(page).locator("[data-project-threads]");
  await expect(row(page, ids.project)).toBeVisible({ timeout: 30_000 });
  /* The held turn is a plain chat, not this project's — the page shows
     its own thread under Active. */
  await expect(threads.getByText("Active", { exact: true })).toBeVisible();
  await shot(page, "project-statuses");
});

test("after: company layer off — Oscar's view, light and dark", async ({
  page,
}) => {
  test.setTimeout(240_000);
  /* Oscar's app runs the company layer paused (D-#836): the same list and
     menus under LILOS_COMPANY=0 — no Work / Goals / People chrome. */
  const off = await bootStack(
    "v3done887off",
    { relay: 0, feed: 0, web: await freePort() },
    { LILOS_COMPANY: "0" },
  );
  try {
    const agent = await openDefaultAgent(page, off.webUrl);
    const pinned = await startChat(page, off.webUrl, agent, "pin evidence");
    const active = await startChat(page, off.webUrl, agent, "active evidence");
    await startChat(
      page,
      off.webUrl,
      agent,
      "LILOS_TURN_HOLD working evidence",
    );
    const snoozed = await startChat(page, off.webUrl, agent, "snooze evidence");
    const done = await startChat(page, off.webUrl, agent, "done evidence");
    await page.goto(`${off.webUrl}/#?page=threads`);
    await expect(row(page, done)).toBeVisible({ timeout: 30_000 });

    await menu(page, pinned);
    await page.getByRole("menuitem", { name: "Pin thread" }).click();
    await menu(page, snoozed);
    await page.getByRole("menuitem", { name: "Snooze" }).click();
    await page.getByRole("menuitem", { name: "1 h" }).click();
    await expect(foldButton(page, "snoozed")).toContainText("Snoozed (1)");
    await menu(page, done);
    await page.getByRole("menuitem", { name: "Done", exact: true }).click();
    await expect(foldButton(page, "settled")).toContainText("Done (1)");

    await ensureOpen(page, "working");
    await ensureOpen(page, "snoozed");
    await ensureOpen(page, "settled");
    await shotBoth(page, "threads-list-company-off");

    await menu(page, active);
    await shotBoth(page, "thread-menu-company-off");
    await page.keyboard.press("Escape");
    await menu(page, done);
    await shotBoth(page, "not-done-menu-company-off");
    await page.keyboard.press("Escape");
  } finally {
    await off.stop();
  }
});
