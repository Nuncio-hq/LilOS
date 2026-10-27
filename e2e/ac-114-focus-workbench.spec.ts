import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { allowAllWhile, expectSettled } from "./helpers/approvals";
import {
  bootStack,
  openSession,
  panelIntoFocus,
  panelOutOfFocus,
  pickPorts,
  type Stack,
  startChatInFolder,
  startFolderlessChat,
  threadUrl,
} from "./helpers/stack";
import { openWorkbench, workbenchOffered } from "./helpers/workbench";

/**
 * Issue #114 — the session view + Workbench in the real app (apps/web), on
 * the real stack (relay + harness + vite dev, engine-fake): a session opens
 * in the side peek beside Threads (#195), and widening it (the peek's Widen,
 * `full=1` in the hash) is the session view — chat
 * beside the Workbench, whose Changes (git.diff), Files (fs.tree/fs.read)
 * and PR (forge.pr/comment/merge) tabs read the session's real folder —
 * here a tmp git repo served by the stateful fake `gh`
 * (packages/host/test/fake-gh) on the stack's PATH.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const fakeGh = path.join(repo, "packages", "host", "test", "fake-gh");

const SHOTS = path.join(repo, "test-results", "ac-114");

/* Fixture dirs + the fake gh's state, all under one tmp root. */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-114-"));
const repoDir = path.join(ROOT, "lilos-repo-a");
const plainDir = path.join(ROOT, "lilos-plain-b");
/* AC-396's own folder — repoDir/plainDir are already attached by earlier
   tests, and an already-added folder leaves the Add dialog's button
   disabled. */
const regDir = path.join(ROOT, "lilos-reg-c");
const ghFakeDir = path.join(ROOT, "gh-fake");
const viewPath = path.join(ghFakeDir, "view.json");
/* fake-gh's forced-failure switch (packages/host/test/fake-gh): "auth" =
   gh's signed-out answer, anything else = a generic failure. */
const failPath = path.join(ghFakeDir, "fail");
const ghLogFile = path.join(ghFakeDir, "gh.log");
mkdirSync(repoDir, { recursive: true });
mkdirSync(plainDir, { recursive: true });
mkdirSync(regDir, { recursive: true });
mkdirSync(ghFakeDir, { recursive: true });
const git = (args: string[], cwd = repoDir) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });
git(["init", "-b", "trunk"]);
writeFileSync(path.join(repoDir, "a.txt"), "one\n");
/* Committed but never touched by the session — clicking it in Files opens
   fs.read (changed files route to the diff instead). */
writeFileSync(path.join(repoDir, "b.txt"), "bees\n");
writeFileSync(path.join(plainDir, "note.txt"), "plain\n");
git(["add", "."]);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
execFileSync("git", ["init", "-b", "trunk"], { cwd: regDir });
writeFileSync(path.join(regDir, "note.txt"), "reg\n");

/* `gh pr view --json` fixture — OPEN, all checks green, one comment. */
const PR_VIEW = {
  number: 7,
  title: "Add the forge tab",
  body: "Wire the Workbench PR tab to the host forge.",
  url: "https://github.com/acme/widgets/pull/7",
  state: "OPEN",
  author: { login: "builder" },
  baseRefName: "trunk",
  headRefName: "feat/forge",
  createdAt: "2026-09-20T10:00:00Z",
  mergedAt: null,
  mergedBy: null,
  mergeCommit: null,
  mergeable: "MERGEABLE",
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      name: "typecheck",
      status: "COMPLETED",
      conclusion: "SUCCESS",
    },
    { __typename: "StatusContext", context: "netlify", state: "SUCCESS" },
  ],
  comments: [
    {
      author: { login: "reviewer" },
      body: "Nice split. One nit on the merge copy.",
      createdAt: "2026-09-21T08:00:00Z",
    },
  ],
};
const writeView = (v: unknown) =>
  writeFileSync(viewPath, `${JSON.stringify(v, null, 2)}\n`);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  writeView(PR_VIEW);
  stack = await bootStack("ac114", await pickPorts(), {
    PATH: `${fakeGh}:${process.env.PATH}`,
    GH_FAKE_DIR: ghFakeDir,
    GH_FAKE_LOG: ghLogFile,
  });
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

/* A new session in `dir`, the way a person starts one: the new-chat draft's
   folder chip, then Send (the folder joins the recents over the relay
   first). An id that names nobody opens the draft on the default agent, so
   the spec needs no employee lookup. Returns the conversation id. */
const startSession = (page: Page, dir: string, text: string) =>
  startChatInFolder(page, stack, { id: "default", name: "Hermes" }, dir, text);

const send = async (page: Page, text: string) => {
  const box = page.locator("[data-thread-panel] textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const turns = (page: Page) => page.locator("[data-agentturn]");

/* Send as a NEW turn: wait until every earlier turn has settled (a send into
   a running turn steers it instead — no new turn, no approval card), then
   send and return the agent turn right after THIS message. Anchored on the
   sent message, not a turn count: after a page load the engine feed replays
   older turns late, so a count taken early can point at one of those. */
const sendTurn = async (page: Page, text: string) => {
  await expect(turns(page).locator("[data-streaming]")).toHaveCount(0, {
    timeout: 60_000,
  });
  if ((await turns(page).count()) > 0) {
    await expectSettled(turns(page).last(), 60_000);
  }
  await send(page, text);
  const mine = page
    .locator("[data-msg]")
    .filter({ hasText: text })
    .filter({ hasNot: page.locator("[data-agentturn]") })
    .last();
  await expect(mine).toBeVisible({ timeout: 60_000 });
  const turn = mine.locator(
    "xpath=following-sibling::*[.//*[@data-agentturn]][1]//*[@data-agentturn]",
  );
  await expect(turn).toBeVisible({ timeout: 60_000 });
  return turn;
};

/* The session view: a thread widened over the page (what Focus was). The
   thread beside Threads is the same hash without it. */
const FOCUS_URL = /[#&]full=1(&|$)/;
const THREAD_URL = /open=([^&]*,)?thread:[^&,]+$/;

/* AC-1's repo session: later tests reopen it as the session view. */
let checkInConv: string;
const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });

test("AC-1 a session opens beside Threads; Widen reaches the session view; Esc/Back return through the thread", async ({
  page,
}) => {
  test.setTimeout(120_000);
  checkInConv = await startSession(page, repoDir, "check in");
  /* A send STAYS on Threads with the thread open in the side peek; the
     session view (chat beside the Workbench) opens only by widening the
     peek, so every way back out still lands on the same open thread. */
  await expect(page).toHaveURL(THREAD_URL, { timeout: 30_000 });
  await expect(page).not.toHaveURL(FOCUS_URL);
  const sentPanel = page.locator("[data-thread-panel]");
  await expect(sentPanel.getByText("check in").first()).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-1-send-panel.png` });
  await panelIntoFocus(page, FOCUS_URL);
  await expect(workbenchOffered(page)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-1-focus.png` });

  // Reload stays in the session view (the URL carries it).
  await page.reload();
  await expect(page).toHaveURL(FOCUS_URL);
  await expect(workbenchOffered(page)).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator("[data-thread-panel]").getByText("check in").first(),
  ).toBeVisible({ timeout: 30_000 });

  /* #195 AC-2: Esc steps back to the thread with Threads still visible
     beside it. */
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(THREAD_URL);
  await expect(page).not.toHaveURL(FOCUS_URL);
  const panel = page.locator("[data-thread-panel]");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText("check in").first()).toBeVisible();
  await expect(
    page.locator("main").getByRole("heading", { name: "Threads" }),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-1-panel.png` });

  // The thread URL reloads too (the URL carries it).
  await page.reload();
  await expect(page).toHaveURL(THREAD_URL);
  await expect(page.locator("[data-thread-panel]")).toBeVisible({
    timeout: 30_000,
  });

  // #195 AC-1: Esc again closes the thread back to the plain Threads page.
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/open=/);
  await expect(page.locator("[data-thread-panel]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-1-esc-dm.png` });

  /* Clicking the session's row re-opens the thread (not the session view);
     widening the peek is the way into the session view; the peek's Narrow
     returns to the thread. */
  await page
    .locator("main")
    .getByRole("button", { name: /check in/i })
    .first()
    .click();
  await expect(page).toHaveURL(THREAD_URL);
  await panelIntoFocus(page, FOCUS_URL);
  await panelOutOfFocus(page);
  await expect(page).toHaveURL(THREAD_URL);
  await expect(page).not.toHaveURL(FOCUS_URL);
  await page.screenshot({ path: `${SHOTS}/ac-1-back-panel.png` });
});

test("AC-2 Focus is the same live conversation: streaming, steps, approvals, model picker, steer + stop", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openSession(page, stack.webUrl, checkInConv);

  // A reply turn streams in — reasoning + tool steps render live. `.last()`:
  // AC-1's "check in" turn sits above it and carries no tool steps.
  const turn = await sendTurn(page, "Say hello then list files");
  await expect(turn.locator("[data-tasksteps]")).toBeVisible({
    timeout: 60_000,
  });
  await expect(turn).toContainText(/envelope|file|Done|answer/i, {
    timeout: 60_000,
  });
  // The model picker rides along (engine-fake declares `models`).
  await expect(
    page.locator('[data-slot="model-picker-trigger"]'),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-2-streamed.png` });

  // An edit-ask prompt parks on an approval card; answering it continues the
  // turn. sendTurn waits for the turn above to settle first — its text lands
  // before it ends, and a send into a running turn steers it instead.
  const edit = await sendTurn(page, "Add a release note to the readme");
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-2-approval.png` });
  // Keep answering while the turn finishes — a parked approval can't stall
  // the footer assert (#298).
  await allowAllWhile(page, expectSettled(edit));
  await expect(
    page.getByText(/Allowed once|Always allowed/).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(edit).toContainText(/Done on|Review it|done/i, {
    timeout: 60_000,
  });
  await expect(page.locator("[data-agentturn] [data-streaming]")).toHaveCount(
    0,
    { timeout: 60_000 },
  );

  // ⌘. inside the composer is still the turn's Stop — Focus stays open.
  const stopped = await sendTurn(page, "Add another note to the readme");
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  const box = page.locator("[data-thread-panel] textarea");
  await box.click();
  /* ⌘. is the stop shortcut — Esc only closes surfaces now (#576). */
  await page.keyboard.press("Meta+Period");
  // Wait the turn-ended wire condition before asserting the footer chip
  // (turn.completed -> data-turnsettled), not a wall-clock guess (#257).
  await expectSettled(stopped);
  await expect(stopped.getByText("Stopped")).toBeVisible();
  await expect(page).toHaveURL(FOCUS_URL);
  await page.screenshot({ path: `${SHOTS}/ac-2-stopped.png` });
});

test("AC-3 Changes lists uncommitted files with +/− and refreshes while the agent works", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openSession(page, stack.webUrl, checkInConv);

  const changes = tab(page, /Changes/);
  await expect(changes).toBeVisible({ timeout: 30_000 });
  await changes.click();
  // Clean repo → plain empty state.
  await expect(
    page.getByText(/Clean working tree/, { exact: false }),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-clean.png` });

  // An edit-ask turn parks on its approval; while it waits, the agent's
  // writes land in the folder — the tab polls and shows them mid-turn.
  const edit = await sendTurn(page, "Add a changelog note to the readme");
  await expect(edit.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  writeFileSync(path.join(repoDir, "notes.txt"), "fresh\nlines\nhere\n");
  writeFileSync(path.join(repoDir, "a.txt"), "one\ntwo\n");
  await expect(page.locator('[data-diff="notes.txt"]')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[data-diff="a.txt"]')).toBeVisible();
  // +/− stats ride along; the patch content renders.
  await expect(
    page.locator("[data-thread-panel]").getByText("+4").first(),
  ).toBeVisible();
  await expect(
    page.locator('[data-diff="notes.txt"]').getByText("fresh"),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-3-changes.png` });

  // Turn ends (allow through); the edits stay listed.
  await allowAllWhile(page, expectSettled(edit));
  await expect(edit).toContainText(/Done on|Review it|done/i, {
    timeout: 60_000,
  });
  await expect(page.locator('[data-diff="notes.txt"]')).toBeVisible();
});

test("AC-4 Files shows the folder tree (fs.tree) and file contents (fs.read)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openSession(page, stack.webUrl, checkInConv);

  const files = tab(page, "Files");
  await expect(files).toBeVisible({ timeout: 30_000 });
  await files.click();
  await expect(page.getByText("a.txt").last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("notes.txt").last()).toBeVisible();
  // An unchanged file opens fs.read's content (a.txt/notes.txt changed in
  // AC-3 — clicking one of those jumps to its diff instead).
  await page.getByText("b.txt").last().click();
  await expect(page.locator("[data-fileview]")).toContainText("bees", {
    timeout: 15_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-4-files.png` });
});

test("AC-5 the PR tab reads checks + comments through forge.pr; comment and merge go through gh; no-PR and gh failures read plainly", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openSession(page, stack.webUrl, checkInConv);

  const prTab = tab(page, /PR/);
  await expect(prTab).toBeVisible({ timeout: 30_000 });
  await prTab.click();
  const panel = page.locator("[data-pr='7']");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText("Add the forge tab");
  await expect(panel).toContainText("feat/forge");
  await panel.locator("[data-prtab='checks']").click();
  await expect(panel).toContainText("typecheck");
  await expect(panel).toContainText("netlify");
  await panel.locator("[data-prtab='discussion']").click();
  await expect(panel).toContainText("Nice split. One nit on the merge copy.");
  await page.screenshot({ path: `${SHOTS}/ac-5-pr.png` });

  // Comment posts through `gh pr comment` and re-reads into the list.
  await panel.getByPlaceholder(/Add a comment/).fill("LGTM from e2e");
  await panel.locator("form button[type='submit']").click();
  await expect(
    panel.locator("p").filter({ hasText: "LGTM from e2e" }),
  ).toBeVisible({ timeout: 15_000 });
  const log = () => readFileSync(ghLogFile, "utf8");
  expect(log()).toContain("pr comment 7");

  // Merge confirms the base + method, then `gh pr merge --squash` flips state.
  await page.getByRole("button", { name: /Squash and merge/ }).click();
  const confirm = page.locator("[data-mergeconfirm]");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Confirm merge" }).click();
  await expect(panel).toContainText("Merged", { timeout: 15_000 });
  expect(log()).toContain("pr merge 7 --squash");
  await page.screenshot({ path: `${SHOTS}/ac-5-merged.png` });

  // No PR for the branch → a plain note, not a crash.
  rmSync(viewPath);
  await page.reload();
  /* The reload lands back in the session view (`full=1` rides the URL);
     the Workbench tab is the thread's own state now, so PR is picked again
     below. */
  await expect(page).toHaveURL(FOCUS_URL);
  await expect(tab(page, /^PR$/)).toBeVisible({ timeout: 30_000 });
  await tab(page, /^PR$/).click();
  await expect(
    page.getByText(/No pull request on/, { exact: false }),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-5-no-pr.png` });

  // `gh` signed out (its real "gh auth login" stderr + exit 4) → the sign-in
  // copy names the next step the user can take (#579 AC-2: ask the employee,
  // then Retry) — never a command to type, never raw stderr, never "gh failed:".
  writeFileSync(failPath, "auth\n");
  /* #720: arm `?wbPrSigMark` for the failure leg — while the landed
     `forge.pr` answer is a failure it bumps `data-pr-sig-mark` on the PR
     tabpanel per signal-driven read decision, so the Retry press below is
     timed strictly after the scheduled land that used to yank the button
     mid-click (the land-vs-press race made deterministic). */
  /* The `?wbPrSigMark` knob is a real query parameter (read from
     location.search), so it goes before the hash, not into it. */
  const marked = new URL(page.url());
  marked.searchParams.set("wbPrSigMark", "1");
  await page.goto(marked.toString());
  await expect(tab(page, /^PR$/)).toBeVisible({ timeout: 30_000 });
  await tab(page, /^PR$/).click();
  await expect(
    page.getByText("GitHub isn't signed in on this machine", { exact: false }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/Ask Default to sign in, then Retry/, { exact: false }),
  ).toBeVisible();
  // No copyable command chip anywhere (#579): a grep over the panel finds
  // nothing that looks like a typed command.
  await expect(page.getByText("gh auth login")).toHaveCount(0);
  /* #419 wired the last turn's own hover Retry — scope this one to the PR
     panel or the name resolves to both. */
  const prPanel = page.getByRole("tabpanel", { name: "PR" });
  const retry = prPanel.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  await expect(page.getByText(/gh failed:/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-5-gh-auth.png` });

  // Retry re-probes for real: gh healthy again → the PR renders in place.
  rmSync(failPath);
  writeView(PR_VIEW);
  /* #720: a window-focus event is a real `forge.pr` signal — the same one
     the CI flake rode. The mark must move before the press: pre-fix that
     land commits `PrFailure` → `PrPanel` and detaches the button the click
     resolved; post-fix the landed failure holds scheduled reads and only
     the press's own `forge.pr` may lift it. */
  const prSigMark = Number(await prPanel.getAttribute("data-pr-sig-mark"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect
    .poll(async () => Number(await prPanel.getAttribute("data-pr-sig-mark")))
    .toBeGreaterThan(prSigMark);
  await retry.click();
  await expect(page.locator("[data-pr='7']")).toBeVisible({
    timeout: 15_000,
  });

  // Any other `gh` failure → "Couldn't load the PR." with the raw detail
  // only behind Details.
  writeFileSync(failPath, "boom\n");
  await page.reload();
  await expect(tab(page, /^PR$/)).toBeVisible({ timeout: 30_000 });
  await tab(page, /^PR$/).click();
  await expect(page.getByText("Couldn't load the PR.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/gh failed:/)).toHaveCount(0);
  await expect(page.getByText(/fake gh: boom/)).toHaveCount(0);
  /* The Workbench's own Details tab (and the header's strip) share the word —
     the disclosure is the one button named Details inside the tab panel. */
  await page
    .getByRole("tabpanel")
    .getByRole("button", { name: "Details" })
    .click();
  await expect(page.getByText(/fake gh: boom/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-5-gh-error.png` });
  rmSync(failPath);
});

test("AC-6 tabs render only when their host method answers; a session without a folder shows only the engine tabs", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // A session on a plain (non-repo) folder: fs answers, git/forge don't →
  // only the Files tab renders. Browser/Terminal never render in this slice.
  await startSession(page, plainDir, "check the folder");
  await panelIntoFocus(page);
  await expect(workbenchOffered(page)).toBeVisible({ timeout: 30_000 });
  await expect(tab(page, "Files")).toBeVisible({ timeout: 30_000 });
  await expect(tab(page, /Changes/)).toHaveCount(0);
  await expect(tab(page, /PR/)).toHaveCount(0);
  await expect(tab(page, /Terminal/)).toHaveCount(0);
  await expect(tab(page, /Preview/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-6-plain-folder.png` });

  /* #543 rewrote this leg: a session without a folder still gets the
     Workbench — only its engine tabs render (Background, since the engine
     declares the capability even with no jobs yet; Subagents once a turn
     has helpers), never the folder-bound tabs. The new-chat draft always
     pre-picks a recent folder, so the folder-less session starts over the
     relay — exactly what a send with no folder does. */
  const chatConv = await startFolderlessChat(
    page,
    stack,
    "just chat — no folder",
  );
  await page.goto(threadUrl(stack.webUrl, chatConv));
  await panelIntoFocus(page);
  await expect(workbenchOffered(page)).toBeVisible({ timeout: 30_000 });
  /* The panel opens on demand here — auto-open at ≥lg is for a panel that
     already has content to show (a folder, or live engine work). */
  if (
    !(await tab(page, "Background")
      .isVisible()
      .catch(() => false))
  ) {
    await openWorkbench(page);
  }
  await expect(tab(page, "Background")).toBeVisible({ timeout: 30_000 });
  await expect(tab(page, /^(Changes|Files|Terminal|Preview|PR)$/)).toHaveCount(
    0,
  );
  /* #587 AC-1 rewrote the empty-tab policy: engine-declared tabs render
     greyed-empty (data-wb-empty) instead of appearing on first content —
     Subagents + Plan are here from the start on a capable engine. */
  await expect(tab(page, "Subagents")).toBeVisible();
  await expect(tab(page, "Subagents")).toHaveAttribute("data-wb-empty", "true");
  await expect(tab(page, "Plan")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-6-no-folder.png` });
});

test("AC-7 Focus + Workbench compose like the prototype (evidence screenshots)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // AC-1's repo session — later sessions sit above it in Threads.
  await openSession(page, stack.webUrl, checkInConv);
  await expect(tab(page, /Changes/)).toBeVisible({ timeout: 30_000 });
  await tab(page, /Changes/).click();
  await expect(page.locator('[data-diff="notes.txt"]')).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({
    path: `${SHOTS}/ac-7-focus-workbench.png`,
    fullPage: true,
  });
});

test("AC-396 a turn that starts while you watch re-arms follow after a manual tab pick (#396)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await startSession(page, regDir, "say hi");
  await panelIntoFocus(page);
  /* Remount with NO live turn: the first live sighting after this mount
     must be a turn that BEGAN while mounted — that is exactly when
     follow may re-arm (the mount-time turn must never re-arm it, AC-319). */
  await expectSettled(turns(page).last(), 60_000);
  await page.reload();
  await expect(turns(page)).not.toHaveCount(0, { timeout: 30_000 });
  // Your own pick holds while the view idles.
  await tab(page, "Files").click();
  await expect(tab(page, "Files")).toHaveAttribute("aria-selected", "true");
  /* An edit turn that starts while you watch re-arms follow — its patch
     step steals the strip to Changes, so the picked tab yields. The turn
     parks on its edit approval along the way; keep answering while the
     strip flips. */
  await send(page, "Add a release note to the readme");
  await allowAllWhile(
    page,
    expect(tab(page, "Files")).toHaveAttribute("aria-selected", "false", {
      timeout: 30_000,
    }),
  );
});
