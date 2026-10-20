import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  relayRpc,
  type Stack,
  skipFirstRun,
  startChatInFolder,
  startFolderlessChat,
  threadUrl,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #113 — pick a folder per session, end to end on the real stack
 * (relay + harness + vite dev, engine-fake). The folders are real dirs under
 * a tmp root; repoDir is a git repo on branch `trunk` so the header badge
 * and the engine-fake `I'm in <cwd>` echo are both real assertions.
 *
 * v3 has two folder surfaces instead of the old composer picker: the
 * new-chat draft's Folder chip (a menu of the app's recents, newest first;
 * unreachable folders are left out) and a folder-less thread's "Add a
 * folder" button, which opens the in-app dialog and MOVES that session into
 * the pick. "No folder · just chat" is the draft's last menu entry (AC-6 picks
 * it); the folder-less threads the other legs start from skip the draft and
 * open over the relay (startFolderlessChat).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");

const SHOTS = path.join(repo, "test-results", "ac-113");

/* Real fixture dirs, made once for the whole file. They sit under ~/repos —
   moving a live session into a folder is a host write gated to the Mac's
   home folder, and ~/repos is one of the discovery scan's default roots. */
mkdirSync(path.join(homedir(), "repos"), { recursive: true }); // may not exist on a fresh CI runner
const ROOT = mkdtempSync(path.join(homedir(), "repos", "lilos-113-"));
const repoDir = path.join(ROOT, "lilos-repo-a");
const plainDir = path.join(ROOT, "lilos-plain-b");
const goneDir = path.join(ROOT, "lilos-gone-c");
/* Never added to recents before the #208 AC-3 test — the dialog must say
   "Not a git repo" for a dir it hasn't seen. */
const freshDir = path.join(ROOT, "lilos-fresh-d");
mkdirSync(repoDir);
mkdirSync(plainDir);
mkdirSync(goneDir);
mkdirSync(freshDir);
execSync(
  "git init -b trunk && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
  { cwd: repoDir },
);

/* The recents and the discovery chips carry a folder under $HOME in its
   `~/x` form (a move stores it that way), so spec lookups use it too: the
   same folder in two spellings would list as two menu rows. */
const shown = (abs: string) => `~${abs.slice(homedir().length)}`;

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac113", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

/* An id that names nobody opens the new-chat draft on the default agent, so
   the spec needs no employee lookup. */
const DEFAULT_AGENT = { id: "default", name: "Default" };

const panel = (page: Page) => page.locator("[data-thread-panel]");
const dialogOf = (page: Page) => page.locator("[data-addfolder]");

/** A folder-less thread open beside Threads, its header's "Add a folder"
    showing. `query` rides the page load (`?roots=` is read at boot). */
async function openFolderless(page: Page, text: string, query = "") {
  const conv = await startFolderlessChat(page, stack, text);
  await page.goto(
    `${stack.webUrl}/${query}#?page=threads&open=thread:${encodeURIComponent(conv)}`,
  );
  await expect(panel(page).locator("[data-add-folder]")).toBeVisible({
    timeout: 30_000,
  });
}

/** The new-chat draft's Folder chip. The app reads the recents when it
    mounts, so a reload is what proves what the relay holds. */
async function draftFolderChip(page: Page) {
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:default`);
  await page.reload();
  const chip = v3Peek(page).getByTitle(/^Folder · /);
  await expect(chip).toBeVisible({ timeout: 30_000 });
  return chip;
}

/** Type `dir` into the open dialog, wait for its folder card, Add. */
async function addViaDialog(page: Page, dir: string, info: string) {
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-pathinput]").fill(dir);
  await expect(dialog.locator("[data-folderinfo]")).toContainText(info, {
    timeout: 15_000,
  });
  await dialog.locator("[data-addbtn]").click();
  await expect(dialog).toHaveCount(0);
  await expect(panel(page).getByText(/Moved this thread to/)).toBeVisible({
    timeout: 30_000,
  });
}

const send = async (page: Page, text: string) => {
  const box = panel(page).locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

test("AC-2 + #208 AC-1 a folder-less thread offers Add a folder; it opens the in-app dialog even on the desktop bridge", async ({
  page,
}) => {
  /* #208 AC-1/AC-5: a live `window.lilos.pickFolder` must never fire — Add a
     folder is LilOS's own dialog on every surface. The spy returns a real
     dir so the removed code path would add it straight in, never opening
     the dialog. */
  await page.addInitScript((bait) => {
    const w = window as Window & {
      lilos?: { pickFolder?: () => Promise<string | null> };
      __pickFolderCalls?: number;
    };
    w.lilos = {
      pickFolder: () => {
        w.__pickFolderCalls = (w.__pickFolderCalls ?? 0) + 1;
        return Promise.resolve(bait);
      },
    };
  }, plainDir);
  /* `?roots=` makes git.discoverRepos scan just this fixture root — the
     override is captured at boot (apps/web/src/lib/host.ts) and rides the
     page load, so the "Found" chips are deterministic. */
  await openFolderless(page, "which folder?", `?roots=${ROOT}`);
  await page.screenshot({ path: `${SHOTS}/ac-2-folderless-thread.png` });
  await panel(page).locator("[data-add-folder]").click();

  // The in-app dialog (fs.list / git.discoverRepos): repoDir is a
  // discovered chip; pick it, see the repo card, add it.
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.locator(`[data-discovered="${shown(repoDir)}"]`),
  ).toBeVisible({ timeout: 15_000 });
  await dialog.locator(`[data-discovered="${shown(repoDir)}"]`).click();
  await expect(dialog.locator("[data-folderinfo]")).toContainText("Git repo", {
    timeout: 15_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-2-addfolder.png` });
  await dialog.locator("[data-addbtn]").click();
  await expect(dialog).toHaveCount(0);
  // The session moved there: the note names the folder, the badge shows it,
  // and the affordance is gone.
  await expect(panel(page).getByText(/Moved this thread to/)).toContainText(
    shown(repoDir),
    { timeout: 30_000 },
  );
  await expect(panel(page).locator("[data-wsbadge]")).toContainText(
    "lilos-repo-a",
    { timeout: 15_000 },
  );
  await expect(panel(page).locator("[data-add-folder]")).toHaveCount(0);
  // The OS-panel bridge was never consulted (#208 AC-5).
  const pickFolderCalls = await page.evaluate(() => {
    const calls: unknown = Reflect.get(window, "__pickFolderCalls");
    return typeof calls === "number" ? calls : 0;
  });
  expect(pickFolderCalls).toBe(0);
});

test("opening a thread never scans the disk — git.discoverRepos runs only on Add a folder", async ({
  page,
}) => {
  const hostCalls: string[] = [];
  page.on("request", (r) => {
    if (!r.url().endsWith("/host")) return;
    try {
      const m = (JSON.parse(r.postData() ?? "{}") as { method?: string })
        .method;
      if (m) hostCalls.push(m);
    } catch {
      /* OPTIONS preflight carries no JSON body */
    }
  });
  await openFolderless(page, "scan check");
  // Boot and the recents probes (fs.list/git.branches on the stored folders)
  // DO hit /host — wait for one so "no discoverRepos" isn't vacuous.
  await expect
    .poll(() => hostCalls.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(hostCalls).not.toContain("git.discoverRepos");
  // …and it does fire when the Add-folder dialog opens.
  await panel(page).locator("[data-add-folder]").click();
  await expect(dialogOf(page)).toBeVisible();
  await expect
    .poll(() => hostCalls.includes("git.discoverRepos"), { timeout: 15_000 })
    .toBe(true);
});

test("AC-3 the folder menu and the session header offer direct mode only (no worktree items)", async ({
  page,
}) => {
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  await relayRpc(page, stack, "folders.add", { path: shown(repoDir) });
  const chip = await draftFolderChip(page);
  await chip.click();
  const peek = v3Peek(page);
  const menu = peek.getByRole("menu");
  // The recents menu lists folders and nothing else — no branch list, no
  // workstream or worktree choices.
  await expect(
    menu.getByRole("menuitemradio", { name: /lilos-repo-a/ }),
  ).toBeVisible();
  await expect(menu).not.toContainText(/workstream|worktree/i);
  await expect(menu).not.toContainText(/Edit .* directly/);
  await page.screenshot({ path: `${SHOTS}/ac-3-direct-only.png` });
  await menu.getByRole("menuitemradio", { name: /lilos-repo-a/ }).click();
  await expect(chip).toContainText("lilos-repo-a");
  await peek.getByPlaceholder("Message Default…").fill("direct mode check");
  await peek.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });

  // Direct mode: the checked-out branch is a static label of the header
  // badge — nothing on the page checks a branch out or promises a worktree.
  const badge = panel(page).locator("[data-wsbadge]");
  await expect(badge).toContainText("lilos-repo-a", { timeout: 15_000 });
  await expect(badge).toContainText("trunk");
  await expect(badge).toContainText("direct");
  await expect(page.getByText(/Edit .* directly/)).toHaveCount(0);
  await expect(page.getByText("New workstream from")).toHaveCount(0);
  await expect(page.getByText("Continue a workstream")).toHaveCount(0);
  await expect(page.getByText(/worktree/i)).toHaveCount(0);
});

test("AC-4 + AC-7 a session picked on the repo runs there; the header shows folder + branch", async ({
  page,
}) => {
  await startChatInFolder(
    page,
    stack,
    DEFAULT_AGENT,
    shown(repoDir),
    "hello — first turn",
  );
  await expect(page).toHaveURL(/open=thread:[^&]+/);
  /* Wait for turn 1 to finish, or the next message becomes a steer inside
     the running turn instead of the follow-up turn that echoes the cwd.
     Scope to the open thread's panel: the Threads list stays rendered
     beside it, and a previous attempt's thread carries the same canned
     reply text — a page-wide match can settle before this turn streams. */
  await expect(
    panel(page)
      .getByText("If you want me to change code", { exact: false })
      .last(),
  ).toBeVisible({ timeout: 30_000 });
  // The reply text renders before the turn settles — wait for streaming to
  // end so the follow-up starts a new turn rather than steering this one.
  await expect(
    panel(page).locator("[data-agentturn] [data-streaming]"),
  ).toHaveCount(0, { timeout: 30_000 });
  // engine-fake echoes its cwd on the follow-up turn (AC-4); markdown puts
  // the path in a <code> element, so match that rather than the backticks.
  await send(page, "where are you working?");
  /* Scope to the last agent turn (#191): the answer's relay post and the
     still-streaming live turn overlap in the DOM for a moment, so a bare
     `code` search can resolve to both copies of the reply at once. */
  await expect(
    panel(page)
      .locator("[data-agentturn]")
      .last()
      .locator("code")
      .filter({ hasText: repoDir }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    panel(page).getByText("on ⎇", { exact: false }).last(),
  ).toBeVisible();
  // AC-7: header badge = folder name + real branch.
  const badge = panel(page).locator("[data-wsbadge]");
  await expect(badge).toContainText("lilos-repo-a", { timeout: 15_000 });
  await expect(badge).toContainText("trunk");
  await page.screenshot({ path: `${SHOTS}/ac-4-7-header.png` });
});

test("AC-6 a new chat pre-selects the last session's folder; a no-folder session is a plain chat (#196)", async ({
  page,
}) => {
  // Last session ran in repoDir → the draft's Folder chip comes up on it.
  const chip = await draftFolderChip(page);
  await expect(chip).toContainText("lilos-repo-a", { timeout: 15_000 });
  // …but a folder is never required: pick "No folder · just chat" and send.
  await chip.click();
  await v3Peek(page)
    .getByRole("menuitemradio", { name: /No folder/ })
    .click();
  await expect(chip).toContainText("No folder", { timeout: 15_000 });
  await v3Peek(page)
    .getByPlaceholder("Message Default…")
    .fill("no folder please");
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
  const conv = decodeURIComponent(
    /open=thread:([^&,]+)/.exec(page.url())?.[1] ?? "",
  );
  /* The thread opens beside Threads: the turn settles (an employee turn
     renders) and nothing announces the missing folder: no system note, no
     header chip, a neutral hint (#196 — supersedes the #113 AC-6 notice). */
  await expect(page.locator("[data-agentturn]").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByText("No folder: working in", { exact: false }),
  ).toHaveCount(0);
  await expect(page.locator("[data-wsbadge]")).toHaveCount(0);
  await expect(page.getByText(/read-only/i)).toHaveCount(0);
  // Composer hints reveal once there's a draft — calm at rest (#246), so
  // type a character first. The composer is named "Reply to …" in the
  // thread beside Threads and in the session view alike.
  const panelBox = page.getByRole("textbox", { name: /Reply to/ });
  await panelBox.pressSequentially("x");
  await expect(page.getByText(/Reply to .*…/).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-6-no-folder-panel.png` });
  // The session view shows the same no-folder session (Widen the thread).
  await panelIntoFocus(page);
  const focusBox = page.getByRole("textbox", { name: /Reply to/ });
  await expect(focusBox).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-wsbadge]")).toHaveCount(0);
  await expect(page.getByText(/read-only/i)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-6-no-folder-focus.png` });
  // The thread is the same on a fresh load: no chip, no "discussion" label,
  // neutral hint.
  await page.goto(threadUrl(stack.webUrl, conv));
  await page.reload();
  const replyBox = page.getByRole("textbox", { name: /Reply to/ });
  await expect(replyBox).toBeVisible({ timeout: 30_000 });
  await replyBox.pressSequentially("x");
  await expect(page.getByText(/Reply to .*…/).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("[data-wsbadge]")).toHaveCount(0);
  await expect(page.getByText("discussion", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/read-only/i)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-6-no-folder.png` });
  // Drafts persist per conversation — clear so later tests start clean.
  await replyBox.fill("");
});

test("AC-5 recents persist across reload, newest first; a deleted folder is not offered and can't be picked", async ({
  page,
}) => {
  // Add two more folders through the dialog (each moves a folder-less thread
  // there and joins the recents): one kept, one deleted after.
  for (const dir of [plainDir, goneDir]) {
    await openFolderless(page, `park in ${path.basename(dir)}`);
    await panel(page).locator("[data-add-folder]").click();
    await addViaDialog(page, dir, "Not a git repo");
  }
  rmSync(goneDir, { recursive: true, force: true });

  const chip = await draftFolderChip(page);
  /* The menu lists the reachable recents newest first: plain (added after
     repo's session), then repo. The deleted folder was added last, and is
     the only thing a missing-folder check can be about: v3 leaves an
     unreachable folder out of the menu entirely (and skips it as the
     default pick) instead of listing it disabled. */
  /* The chip follows the last chat (#581): that was a thread moved into the
     folder deleted since, which is not offered, so the pick is "No folder". */
  await expect(chip).toContainText("No folder", { timeout: 15_000 });
  await chip.click();
  const items = v3Peek(page).getByRole("menuitemradio");
  await expect(items.filter({ hasText: "lilos-plain-b" })).toHaveCount(1);
  await expect(items.filter({ hasText: "lilos-repo-a" })).toHaveCount(1);
  await expect(items.filter({ hasText: "lilos-gone-c" })).toHaveCount(0);
  const order = await items.allInnerTexts();
  const at = (name: string) => order.findIndex((t) => t.includes(name));
  expect(at("lilos-plain-b")).toBeGreaterThanOrEqual(0);
  expect(at("lilos-plain-b")).toBeLessThan(at("lilos-repo-a"));
  await page.screenshot({ path: `${SHOTS}/ac-5-recents-missing.png` });
});

test("AC-3 (#208) a typed non-git folder says 'Not a git repo', adds, and the session runs there", async ({
  page,
}) => {
  await openFolderless(page, "hello — plain folder turn");
  const dialog = dialogOf(page);
  /* Let turn 1 settle before the move, so the follow-up is a fresh turn that
     echoes the cwd. Scope the waits to the open thread's panel: the Threads
     list stays rendered beside it, and every sibling thread carries the same
     canned reply text — a page-wide match settles instantly and the next
     send lands as a steer inside the still-running turn. */
  await expect(
    panel(page)
      .getByText("If you want me to change code", { exact: false })
      .last(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    panel(page).locator("[data-agentturn] [data-streaming]"),
  ).toHaveCount(0, { timeout: 30_000 });
  await panel(page).locator("[data-add-folder]").click();
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-pathinput]").fill(freshDir);
  await expect(dialog.locator("[data-folderinfo]")).toContainText(
    "Not a git repo",
    { timeout: 15_000 },
  );
  await page.screenshot({ path: `${SHOTS}/ac-208-3-notgit.png` });
  await dialog.locator("[data-addbtn]").click();
  await expect(dialog).toHaveCount(0);
  await expect(panel(page).getByText(/Moved this thread to/)).toContainText(
    shown(freshDir),
    { timeout: 30_000 },
  );
  await send(page, "where are you working?");
  await expect(
    panel(page)
      .locator("[data-agentturn]")
      .last()
      .locator("code")
      .filter({ hasText: freshDir }),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-208-3-pwd.png` });
});

test("AC-1 + AC-2 (#418) a folder created while the app is open lists on the next dialog open", async ({
  page,
}) => {
  await openFolderless(page, "list check");
  // First open lists ROOT; pre-#418 that listing was cached for the page's
  // lifetime, so populate it before the new folder exists. Typing a partial
  // child path lists the parent filtered to the fragment — all lilos-* dirs
  // show, and the not-yet-created one provably doesn't.
  await panel(page).locator("[data-add-folder]").click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-pathinput]").fill(path.join(ROOT, "lilos"));
  await expect(dialog.locator('[data-fsrow="lilos-repo-a"]')).toBeVisible({
    timeout: 15_000,
  });
  await expect(dialog.locator('[data-fsrow="lilos-late-e"]')).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  // A folder is created while the app stays open.
  mkdirSync(path.join(ROOT, "lilos-late-e"));

  // The next dialog open re-reads the dir — no app reload needed. Typing
  // ROOT itself (its fs row now exists) shows the unfiltered children.
  await panel(page).locator("[data-add-folder]").click();
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-pathinput]").fill(ROOT);
  await expect(dialog.locator('[data-fsrow="lilos-late-e"]')).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-418-late-folder.png` });
});
