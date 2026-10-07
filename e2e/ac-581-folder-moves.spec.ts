import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #581 — folders: the new-session pick remembers the last choice
 * (including "No folder"), and a folder-less thread gets a real
 * "Add a folder" that MOVES the session there (same thread, same memory —
 * the engine's session.moveWorkspace runs for real).
 *
 *   AC-1 the new-session folder pick follows the last session's choice,
 *       "No folder" included (it used to silently reselect the repo).
 *   AC-2 a folder-less thread shows "Add a folder"; picking one moves the
 *       session there — system note + the affordance is gone after.
 *   AC-3 the Add-folder dialog opens with nothing selected; no dev text,
 *       no promises of unbuilt features.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-581");

/* Fixture dirs, made once for the file:
   - ROOT/repoDir: a git repo the "Found on this Mac" chips can discover.
     It sits under ~/repos — one of the picker's always-scanned roots —
     because the `?roots=` override is captured at boot and loses the race
     when the app redirects / → /dm before initHost reads location.search.
   - moveDir: under the real $HOME on purpose — moving a live session is
     a host write, gated to inside the Mac's home folder. */
mkdirSync(path.join(homedir(), "repos"), { recursive: true }); // ~/repos may not exist on a fresh CI runner
const ROOT = mkdtempSync(path.join(homedir(), "repos", "lilos-581-"));
const repoDir = path.join(ROOT, "lilos-repo-581");
const moveDir = mkdtempSync(path.join(homedir(), "lilos-581-move-"));
mkdirSync(repoDir);
execSync(
  "git init -b trunk && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
  { cwd: repoDir },
);
const moveName = path.basename(moveDir);
const moveShown = `~/${moveName}`;
/* Discovery answers with collapsePath — a repo under $HOME is the
   `~/x` form in the Found chips, not the absolute path. */
const repoShown = `~/repos/${path.basename(ROOT)}/lilos-repo-581`;

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac581", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(moveDir, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

async function dmDefault(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await page.goto(stack.webUrl);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  await aside
    .getByRole("button", { name: /default/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
}

const send = async (page: Page, text: string) => {
  const box = page.locator("main textarea").first();
  await box.fill(text);
  await box.press("Enter");
};

const PANEL_URL = /\/dm\/[^/]+\/conv_[^/]+$/;
const DM_URL = /\/dm\/[^/]+$/;
const panel = (page: Page) => page.locator("[data-thread-panel]");
const picker = (page: Page) => page.locator('[data-ws="folder"]');

const openPickerMenu = async (page: Page) => {
  await picker(page).click();
  return page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last();
};

test("AC-1 the folder pick follows the last session's choice — 'No folder' included", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);

  /* Leg 1 — pick "No folder", send: after reload the pick is still
     "No folder" (it used to silently reselect the repo). */
  const menu1 = await openPickerMenu(page);
  await menu1.getByText("No folder · just chat").click();
  await expect(picker(page)).toContainText("No folder");
  await send(page, "folder-less first");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await panel(page).getByLabel("Close thread panel").click();
  await expect(page).toHaveURL(DM_URL, { timeout: 15_000 });

  await page.reload();
  await expect(picker(page)).toContainText("No folder", { timeout: 30_000 });

  /* Leg 2 — add the repo folder and send in it: after reload the pick is
     the folder again. */
  const menu2 = await openPickerMenu(page);
  await menu2.getByText("Add a folder").click();
  const dialog = page.locator("[data-addfolder]");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(`[data-discovered="${repoShown}"]`)).toBeVisible({
    timeout: 30_000,
  });
  await dialog.locator(`[data-discovered="${repoShown}"]`).click();
  await expect(dialog.locator("[data-folderinfo]")).toContainText("Git repo", {
    timeout: 30_000,
  });
  await dialog.locator("[data-addbtn]").click();
  await expect(dialog).toHaveCount(0);
  await expect(picker(page)).toContainText("lilos-repo-581");
  await send(page, "in the repo now");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await panel(page).getByLabel("Close thread panel").click();
  await expect(page).toHaveURL(DM_URL, { timeout: 15_000 });
  await page.reload();
  await expect(picker(page)).toContainText("lilos-repo-581", {
    timeout: 30_000,
  });

  /* Leg 3 — "No folder" again: the folder session in between must not
     stick the pick on the repo. */
  const menu3 = await openPickerMenu(page);
  await menu3.getByText("No folder · just chat").click();
  await send(page, "folder-less again");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await panel(page).getByLabel("Close thread panel").click();
  await expect(page).toHaveURL(DM_URL, { timeout: 15_000 });
  await page.reload();
  await expect(picker(page)).toContainText("No folder", { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-1-no-folder-remembered.png` });
});

test("AC-2 + AC-3 a folder-less thread's 'Add a folder' moves the session there — honest dialog, real move", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);

  /* A folder-less send (the previous test's last pick is "No folder", and
     the pick follows it) opens the thread in the panel. */
  const menu = await openPickerMenu(page);
  await menu.getByText("No folder · just chat").click();
  await send(page, "move me somewhere");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await expect(panel(page)).toBeVisible();

  /* AC-2: the affordance is where the folder badge would sit. */
  const addBtn = panel(page).locator("[data-add-folder]");
  await expect(addBtn).toBeVisible({ timeout: 15_000 });
  await expect(addBtn).toContainText("Add a folder");
  await page.screenshot({ path: `${SHOTS}/ac-2-add-folder-affordance.png` });
  await addBtn.click();

  const dialog = page.locator("[data-addfolder]");
  await expect(dialog).toBeVisible();

  /* AC-3: nothing is selected on open — no ~/Desktop pre-pick, Add stays
     disabled — and none of the dev internals show: no folders.add wire
     call, no "Hermes call" title, no workstream/worktree promises. */
  await expect(dialog.locator("[data-pathinput]")).toHaveValue("");
  await expect(dialog.locator("[data-addbtn]")).toBeDisabled();
  await expect(dialog).not.toContainText(/workstream|worktree/i);
  await expect(dialog).not.toContainText(/folders\.add/i);
  await expect(dialog).not.toContainText(/Hermes call/i);
  await page.screenshot({ path: `${SHOTS}/ac-3-dialog-opens-empty.png` });

  /* Browse the real home listing — the target dir sits under $HOME so the
     host move accepts it (moving a live session is a home write). */
  const row = dialog.locator(`[data-fsrow="${moveName}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(dialog.locator("[data-folderinfo]")).toContainText(
    "Sessions edit files here directly.",
    { timeout: 30_000 },
  );
  await expect(dialog.locator("[data-addbtn]")).toBeEnabled();
  await dialog.locator("[data-addbtn]").click();
  await expect(dialog).toHaveCount(0);

  /* AC-2: the move is real — a system note lands in the same thread
     saying the running session moved (engine session.moveWorkspace ran),
     and the affordance is gone now that the session has a folder. */
  const note = panel(page).getByText(/Moved this thread to/);
  await expect(note).toBeVisible({ timeout: 30_000 });
  await expect(note).toContainText(moveShown);
  await expect(note).toContainText("the running session moved too");
  await expect(panel(page).locator("[data-add-folder]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-2-moved-note.png` });

  /* …and it's persisted: a reload keeps the session on the folder (the
     "Add a folder" affordance does not come back). */
  await page.reload();
  await expect(panel(page)).toBeVisible({ timeout: 30_000 });
  await expect(panel(page).getByText(/Moved this thread to/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(panel(page).locator("[data-add-folder]")).toHaveCount(0);
});
