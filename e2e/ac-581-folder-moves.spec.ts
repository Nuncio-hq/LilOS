import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  type Stack,
  startChatInFolder,
  startFolderlessChat,
  threadUrl,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #581 — folders: the new-chat folder follows the last session's
 * choice, and a folder-less thread gets a real "Add a folder" that MOVES the
 * session there (same thread, same memory — the engine's
 * session.moveWorkspace runs for real).
 *
 *   AC-1 the new-chat Folder chip follows the last folder a session ran in
 *       (a move counts), "No folder" included, across a reload, and a later
 *       session in another folder takes over — the pick never sticks on an
 *       older folder (nor does "No folder" stick once a folder session ran).
 *   AC-2 a folder-less thread shows "Add a folder"; picking one moves the
 *       session there — system note + the affordance is gone after.
 *   AC-3 the Add-folder dialog opens with nothing selected; no dev text,
 *       no promises of unbuilt features.
 *
 * v3: the new-chat draft's Folder chip carries the choice ("No folder · just
 * chat" is its last menu entry); folder-less threads that need no draft
 * start over the relay (startFolderlessChat).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-581");

/* Fixture dirs, made once for the file INSIDE the stack's scratch HOME
   (r10 — the host gates reads/writes to the harness's home and collapses
   paths against it, so a fixture in the real ~/repos is unreachable):
   - ROOT/repoDir: a git repo the "Found on this Mac" chips can discover.
     It sits under ~/repos — one of the scan's default roots — so no
     `?roots=` override is needed.
   - moveDir: under the stack's $HOME on purpose — moving a live session
     is a host write, gated to inside the machine's home folder. */
let ROOT: string;
let repoDir: string;
let moveDir: string;
let moveName: string;
let moveShown: string;
let otherDir: string;
let otherName: string;
/* Discovery answers with collapsePath — a repo under $HOME is the
   `~/x` form in the Found chips, not the absolute path. */
let repoShown: string;

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac581", await pickPorts());
  mkdirSync(path.join(stack.home, "repos"), { recursive: true });
  ROOT = mkdtempSync(path.join(stack.home, "repos", "lilos-581-"));
  repoDir = path.join(ROOT, "lilos-repo-581");
  moveDir = mkdtempSync(path.join(stack.home, "lilos-581-move-"));
  mkdirSync(repoDir);
  execSync(
    "git init -b trunk && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
    { cwd: repoDir },
  );
  moveName = path.basename(moveDir);
  moveShown = `~/${moveName}`;
  otherDir = path.join(ROOT, "lilos-other-581");
  otherName = path.basename(otherDir);
  mkdirSync(otherDir);
  repoShown = `~/repos/${path.basename(ROOT)}/lilos-repo-581`;
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(moveDir, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

const panel = (page: Page) => page.locator("[data-thread-panel]");

/** A folder-less thread open beside Threads, its header's "Add a folder"
    showing. */
async function openFolderless(page: Page, text: string) {
  const conv = await startFolderlessChat(page, stack, text);
  await page.goto(threadUrl(stack.webUrl, conv));
  await expect(panel(page).locator("[data-add-folder]")).toBeVisible({
    timeout: 30_000,
  });
  return conv;
}

/** The new-chat draft's Project chip after a reload — the app reads the
    company when it mounts, so a reload is what proves the pick persisted. */
async function draftFolderChip(page: Page) {
  await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:default`);
  await page.reload();
  const chip = v3Peek(page).getByTitle(/^Project · /);
  await expect(chip).toBeVisible({ timeout: 30_000 });
  return chip;
}

/** Start a chat from the draft with the Project chip set to `choice` (a
    project's name, or "No project"); then the page is left on the thread. */
async function chatFromDraft(page: Page, choice: RegExp, text: string) {
  const chip = await draftFolderChip(page);
  await chip.click();
  await v3Peek(page).getByRole("menuitemradio", { name: choice }).click();
  await expect(chip).toContainText(choice, { timeout: 15_000 });
  await v3Peek(page).getByPlaceholder("Message Hermes…").fill(text);
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
  /* The draft opens on the folder of the agent's newest thread by activity:
     let this one's first turn finish so its answer cannot land after the
     next chat starts and make an older thread the newest. */
  await expect(panel(page).locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 60_000,
  });
}

test("AC-1 the new-chat folder follows the last session's folder — a move counts, a later session takes over", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openFolderless(page, "folder-less first");

  /* Leg 1 — add the repo through the thread's own dialog (the discovered
     chip → repo card → Add): the session moves there, and the next new
     chat's pick is that folder, even after a reload. */
  await panel(page).locator("[data-add-folder]").click();
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
  await expect(panel(page).getByText(/Moved this thread to/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(await draftFolderChip(page)).toContainText("lilos-repo-581", {
    timeout: 30_000,
  });

  /* Leg 2 — a session started in another folder takes the pick over: the
     repo session in between must not stick it on the repo. (Its own dir:
     moveDir is AC-2's move target, and an already-attached folder leaves
     the dialog's Add button disabled.) */
  await startChatInFolder(
    page,
    stack,
    { id: "default", name: "Hermes" },
    otherDir,
    "in the other folder",
  );
  await expect(await draftFolderChip(page)).toContainText(otherName, {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-1-last-folder-remembered.png` });

  /* Leg 3 — pick "No project", send: after a reload the pick is still
     "No project" (it used to silently reselect the newest folder). */
  await chatFromDraft(page, /No project/, "folder-less by choice");
  await expect(await draftFolderChip(page)).toContainText("No project", {
    timeout: 30_000,
  });

  /* Leg 4 — a project pick takes the pick back, and "No project" again after
     it: the project session in between must not stick the pick on it. */
  await chatFromDraft(page, new RegExp(otherName), "back in a folder");
  await expect(await draftFolderChip(page)).toContainText(otherName, {
    timeout: 30_000,
  });
  await chatFromDraft(page, /No project/, "folder-less again");
  await expect(await draftFolderChip(page)).toContainText("No project", {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-1-no-folder-remembered.png` });
});

test("AC-2 + AC-3 a folder-less thread's 'Add a folder' moves the session there — honest dialog, real move", async ({
  page,
}) => {
  test.setTimeout(180_000);

  /* A folder-less send opens the thread beside Threads. */
  await openFolderless(page, "move me somewhere");
  await expect(panel(page)).toBeVisible();

  /* AC-2: the affordance is where the folder badge would sit. */
  const addBtn = panel(page).locator("[data-add-folder]");
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
