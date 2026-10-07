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
  panelIntoFocus,
  pickPorts,
  type Stack,
} from "./helpers/stack";

/**
 * Issue #107 — Workbench → Changes commits, pushes and opens a PR without
 * leaving LilOS, on the real stack (relay + harness + vite dev, engine-fake)
 * with `gh` stubbed by packages/host/test/fake-gh: file checkboxes drive the
 * staged set, Suggest asks the agent for a one-line message, Commit/Push hit
 * `git`, Create PR runs `gh pr create` and the PR tab shows the result.
 * Error states (non-fast-forward, no remote, auth) read plainly; a folder
 * that isn't a repo shows no bar at all (AC-6).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const fakeGh = path.join(repo, "packages", "host", "test", "fake-gh");

const SHOTS = path.join(repo, "test-results", "ac-107");

/* Fixture dirs + the fake gh's state, all under one tmp root:
   - repoDir      clone of the bare remote on `trunk` (the default branch)
   - nonremoteDir a repo with no `origin`
   - authDir      a repo whose `origin` is an unroutable ssh remote — git's
                  "Could not read from remote repository" reads as auth
   - rival clones land a commit on trunk to force a non-fast-forward
                  rejection (cloned fresh, so they hold the latest tip)
   - plainDir     not a repo (AC-6) */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-107-"));
const remoteDir = path.join(ROOT, "ship-remote.git");
const repoDir = path.join(ROOT, "ship-repo");
const nonremoteDir = path.join(ROOT, "no-remote-repo");
const authDir = path.join(ROOT, "auth-repo");
const plainDir = path.join(ROOT, "plain-dir");
const ghFakeDir = path.join(ROOT, "gh-fake");
const ghLogFile = path.join(ghFakeDir, "gh.log");
for (const d of [nonremoteDir, authDir, plainDir, ghFakeDir])
  mkdirSync(d, { recursive: true });

const git = (args: string[], cwd = repoDir) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });
const cfg = ["-c", "user.email=t@t", "-c", "user.name=t"];

git(["init", "--bare", "-b", "trunk", remoteDir], ROOT);
execFileSync("git", ["clone", remoteDir, repoDir], {
  cwd: ROOT,
  encoding: "utf8",
});
writeFileSync(path.join(repoDir, "a.txt"), "one\n");
git([...cfg, "add", "."]);
git([...cfg, "commit", "-m", "init"]);
git(["push", "-u", "origin", "trunk"]);
git(["remote", "set-head", "origin", "-a"]);

/* Repo-local identity for the app's own `git commit` — CI runners have no
   ambient user.name/user.email (locally ~/.gitconfig covers it). */
const fixtureIdentity = (dir: string) => {
  git(["config", "user.email", "e2e@lilos.dev"], dir);
  git(["config", "user.name", "LilOS e2e"], dir);
};
fixtureIdentity(repoDir);

// No-remote + auth fixtures: an initial commit each, no usable origin.
git(["init", "-b", "trunk"], nonremoteDir);
writeFileSync(path.join(nonremoteDir, "n.txt"), "n\n");
git([...cfg, "add", "."], nonremoteDir);
git([...cfg, "commit", "-m", "init"], nonremoteDir);
fixtureIdentity(nonremoteDir);
git(["init", "-b", "trunk"], authDir);
writeFileSync(path.join(authDir, "s.txt"), "s\n");
git([...cfg, "add", "."], authDir);
git([...cfg, "commit", "-m", "init"], authDir);
fixtureIdentity(authDir);
git(["remote", "add", "origin", "ssh://git@127.0.0.1:1/x/y.git"], authDir);

/* A rival clone lands a commit on trunk when the rejection case needs it —
   cloned fresh each time so it always holds the remote's latest tip. */
const rivalPush = () => {
  const rdir = path.join(ROOT, `rival-${Date.now()}`);
  execFileSync("git", ["clone", remoteDir, rdir], {
    cwd: ROOT,
    encoding: "utf8",
  });
  writeFileSync(path.join(rdir, "rival.txt"), `r${Date.now()}\n`);
  git([...cfg, "add", "."], rdir);
  git([...cfg, "commit", "-m", "rival commit"], rdir);
  git(["push", "origin", "trunk"], rdir);
};

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac107", await pickPorts(), {
    PATH: `${fakeGh}:${process.env.PATH}`,
    GH_FAKE_DIR: ghFakeDir,
    GH_FAKE_LOG: ghLogFile,
    /* #621: every approval opens 4s late, so the spec always exercises the
       late-card path this issue regressed — two or more asks in a row now
       outlast a helper that stops answering after ~6s of quiet. */
    LILOS_ASK_OPEN_DELAY_MS: "4000",
  });
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

async function dmDefault(page: Page) {
  await page.goto(`${stack.webUrl}/?roots=${ROOT}`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
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

const pickerButton = (page: Page) => page.locator('[data-ws="folder"]');

/** Pick `dir` for the next session: recents menu when listed, else Add folder. */
async function pickSessionFolder(page: Page, dir: string) {
  const menu = await (async () => {
    await pickerButton(page).click();
    return page
      .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
      .last();
  })();
  const recent = menu.locator(`[data-wsfolder="${dir}"]`);
  if (
    await recent
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await recent.first().click();
  } else {
    await menu.getByText("Add a folder").click();
    const dialog = page.locator("[data-addfolder]");
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-pathinput]").fill(dir);
    await expect(dialog.locator("[data-folderinfo]")).toBeVisible({
      timeout: 15_000,
    });
    await dialog.locator("[data-addbtn]").click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(pickerButton(page)).toContainText(path.basename(dir), {
    timeout: 15_000,
  });
}

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const turns = (page: Page) => page.locator("[data-agentturn]");

const sendTurn = async (page: Page, text: string) => {
  await expect(turns(page).locator("[data-streaming]")).toHaveCount(0, {
    timeout: 60_000,
  });
  if ((await turns(page).count()) > 0) {
    /* #621: on this shared stack the last turn of the opened session can be
       parked on an approval nobody is answering — e.g. a queued follow-up
       whose card opened after the previous test's allowAllWhile left. A
       bare settle wait only watches the parked card; allowAllWhile keeps
       answering it so the turn can actually finish. */
    await allowAllWhile(page, expectSettled(turns(page).last(), 60_000));
  }
  await send(page, text);
  /* #577: the send lands on the thread panel, which lives outside <main> —
     match data-msg on either surface. */
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

const FOCUS_URL = /\/dm\/[^/]+\/[^/]+\/focus$/;
const PANEL_URL = /\/dm\/[^/]+\/conv_[^/]+$/;
const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });

/* Opens the newest session — or the one whose first message matches — into
   Focus through the peek panel. */
const openFocus = async (page: Page, hasText?: string) => {
  const row = hasText
    ? page.locator("[data-session]", { hasText })
    : page.locator("[data-session]").last();
  await row.getByRole("button", { name: /repl(y|ies)/ }).click();
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await page
    .locator("[data-thread-panel]")
    .getByTitle("Focus", { exact: true })
    .click();
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
};

const stageCheck = (page: Page, diffPath: string) =>
  page
    .locator(`[data-diff="${diffPath}"]`)
    .locator("xpath=../..")
    .locator("[data-stagecheck]");

/* The ship-repo session's row text — its first message tags it. */
const SHIP_SESSION = "ship repo session";

test("AC-1 checkboxes pick the staged set; Commit commits only the checked files and refreshes Changes + Commits", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);
  await pickSessionFolder(page, repoDir);
  await send(page, SHIP_SESSION);
  /* #577: a send lands on the panel; Focus opens via its ↗. */
  await panelIntoFocus(page);

  await tab(page, /Changes/).click();
  await expect(page.getByText(/Clean working tree/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("[data-shipbar]")).toBeVisible();
  // No changes yet — the commit button is disabled until files + a message.
  await expect(page.locator("[data-shipcommit]")).toBeDisabled();

  // Two dirty files land (the agent is between turns — the section re-reads
  // on the next poll/turn flip; write then nudge with a turn).
  writeFileSync(path.join(repoDir, "new.txt"), "fresh\nlines\n");
  writeFileSync(path.join(repoDir, "a.txt"), "one\ntwo\n");
  const turn = await sendTurn(page, "Add a changelog note to the readme");
  await allowAllWhile(page, expectSettled(turn));

  // Every changed file's checkbox starts checked.
  await expect(page.locator('[data-diff="new.txt"]')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[data-diff="a.txt"]')).toBeVisible();
  const checks = page.locator("[data-stagecheck]");
  expect(await checks.count()).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < (await checks.count()); i++) {
    await expect(checks.nth(i)).toBeChecked();
  }

  // Uncheck a.txt — Commit stages only the checked set.
  await stageCheck(page, "a.txt").click();
  await page.locator("[data-shipmessage]").fill("wip from e2e");
  await expect(page.locator("[data-shipcommit]")).toContainText(/Commit \d+/);
  await page.locator("[data-shipcommit]").click();

  // new.txt left the list; a.txt (unchecked) is still dirty; the Commits
  // section shows the commit.
  await expect(page.locator('[data-diff="new.txt"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.locator('[data-diff="a.txt"]')).toBeVisible();
  await expect(page.getByText("wip from e2e").last()).toBeVisible({
    timeout: 30_000,
  });
  // The real repo agrees: new.txt committed, a.txt still modified.
  expect(git(["log", "-1", "--format=%s"])).toContain("wip from e2e");
  expect(git(["status", "--porcelain"])).toContain("M a.txt");
  await page.screenshot({ path: `${SHOTS}/ac-1-committed.png` });
});

test("AC-2 (#584) Suggest is a side request: no user message, no turn; fills the box while a turn runs", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await dmDefault(page);
  await openFocus(page, SHIP_SESSION);
  await tab(page, /Changes/).click();
  await expect(page.locator("[data-shipbar]")).toBeVisible({ timeout: 30_000 });

  /* First with the thread idle: the ask answers off-transcript — nothing
     posts to the thread, no agent turn opens. */
  const msgsBefore = await page.locator("[data-msg]").count();
  await page.locator("[data-shipsuggest]").click();
  await expect(page.locator("[data-shipmessage]")).toHaveValue(
    "feat: update a.txt",
    { timeout: 60_000 },
  );
  expect(await page.locator("[data-msg]").count()).toBe(msgsBefore);
  await expect(
    page.locator("main").getByText(/one-line git commit message/),
  ).toHaveCount(0);

  /* AC-2 (#584): still works mid-turn — LILOS_TURN_HOLD keeps the fake's
     turn running until the interrupt lands, so the ask provably overlaps it
     (no pacing race). */
  const turn = await sendTurn(
    page,
    "LILOS_TURN_HOLD add a note while the bar is busy",
  );
  await page.locator("[data-shipmessage]").fill("");
  await expect(page.locator("[data-shipsuggest]")).toBeEnabled();
  await page.locator("[data-shipsuggest]").click();
  await expect(page.locator("[data-shipmessage]")).toHaveValue(
    "feat: update a.txt",
    { timeout: 60_000 },
  );
  /* The ask landed while the turn was provably still running (data-turnsettled
     not yet rendered). Release it via the composer Stop → interrupt. */
  await expect(turn.locator("[data-turnsettled]")).toHaveCount(0);
  /* #576 renamed the tooltip to "Stop (⌘.)" — the exact aria-label,
     since a DM row whose word is "stopped" also matches /stop/i. */
  await page.getByRole("button", { name: /^stop \(⌘\.\)$/i }).click();
  await expectSettled(turn);
  /* And it survives a reload (the draft is persisted): reload mid-session,
     the box still shows the suggestion. */
  await page.reload();
  const changesThere = await expect(tab(page, /Changes/))
    .toBeVisible({ timeout: 45_000 })
    .then(() => true)
    .catch(() => false);
  if (!changesThere) {
    await page.getByTitle("Workbench", { exact: true }).click();
    await expect(tab(page, /Changes/)).toBeVisible({ timeout: 30_000 });
  }
  await tab(page, /Changes/).click();
  await expect(page.locator("[data-shipmessage]")).toHaveValue(
    "feat: update a.txt",
    { timeout: 30_000 },
  );
  await page.screenshot({ path: `${SHOTS}/ac-2-suggested.png` });

  // The suggested message commits for real — a.txt (still dirty) lands.
  await expect(page.locator("[data-shipcommit]")).toBeEnabled({
    timeout: 30_000,
  });
  await page.locator("[data-shipcommit]").click();
  await expect(page.locator('[data-diff="a.txt"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  expect(git(["status", "--porcelain"]).trim()).not.toContain("M a.txt");
  await page.screenshot({ path: `${SHOTS}/ac-2-committed-suggested.png` });
});

test("AC-3 Push sets upstream and lands the branch; rejected, no-remote and auth read plainly; never force-push", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await dmDefault(page);
  await openFocus(page, SHIP_SESSION);
  await tab(page, /Changes/).click();

  // Happy path: push to origin — the bare remote gains the tip. Poll:
  // the click returns while the push is still in flight.
  const remoteLog = () =>
    execFileSync("git", ["log", "trunk", "--format=%s"], {
      cwd: remoteDir,
      encoding: "utf8",
    });
  await page.locator("[data-shippush]").click();
  // The pushed tip is AC-2's commit ("feat: update a.txt" — the session.ask
  // suggestion that landed on a.txt).
  await expect
    .poll(remoteLog, { timeout: 30_000 })
    .toContain("feat: update a.txt");
  await expect(page.locator("[data-shiperror]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-3-pushed.png` });

  // Rejected: the rival clone lands a commit on trunk; a fresh local commit
  // then fails non-fast-forward — plain copy, raw stderr behind Details.
  // The dirty file lands before the turn: it's a new untracked file, so the
  // scripted diff the turn applies mid-turn can't rewrite it — and the
  // running-turn poll is what refreshes Changes.
  rivalPush();
  writeFileSync(path.join(repoDir, "c.txt"), "three\n");
  const turn = await sendTurn(page, "Bump the version note");
  await allowAllWhile(page, expectSettled(turn));
  await expect(page.locator('[data-diff="c.txt"]')).toBeVisible({
    timeout: 30_000,
  });
  await page.locator("[data-shipmessage]").fill("ship the bump");
  await page.locator("[data-shipcommit]").click();
  await expect
    .poll(() => git(["log", "-1", "--format=%s"]), { timeout: 30_000 })
    .toContain("ship the bump");
  await expect(page.getByText("ship the bump").last()).toBeVisible({
    timeout: 30_000,
  });
  await page.locator("[data-shippush]").click();
  const err = page.locator("[data-shiperror]");
  await expect(err).toBeVisible({ timeout: 30_000 });
  await expect(err).toContainText(/remote has newer commits/i);
  // Raw stderr stays inside the collapsed <details> — not in the lead copy.
  await expect(err.locator("pre")).not.toBeVisible();
  await err.locator("summary").click();
  await expect(err.locator("pre")).toContainText(
    /rejected|non-fast-forward|fetch first/i,
  );
  // Never force-pushed: the remote tip is still the rival's commit.
  expect(
    execFileSync("git", ["log", "trunk", "--format=%s", "-1"], {
      cwd: remoteDir,
      encoding: "utf8",
    }),
  ).toContain("rival commit");
  await page.screenshot({ path: `${SHOTS}/ac-3-rejected.png` });

  /* #393 AC-5: the rejected state offers the fix it names — a Pull button
     (real `git pull --ff-only` through git.pull) plus one-click "Ask agent
     to update". Push is no longer the only obvious action. */
  const pullBtn = page.locator("[data-shippull]");
  const askBtn = page.locator("[data-shipask]");
  await expect(pullBtn).toBeVisible();
  await expect(askBtn).toBeVisible();

  // Ask agent to update posts a user message the agent can act on — then
  // let the turn it started settle so later tests inherit a quiet thread.
  await askBtn.click();
  await expect(
    page
      .locator("[data-msg]")
      .filter({ hasText: /pull|rejected/i })
      .last(),
  ).toBeVisible({ timeout: 30_000 });
  await allowAllWhile(page, expectSettled(turns(page).last()));

  // Pull on a diverged checkout shows a plain error — and never merges or
  // rebases: HEAD stays put.
  const headBefore = git(["rev-parse", "HEAD"]).trim();
  await pullBtn.click();
  await expect(err).toContainText(/can't fast-forward|diverged/i, {
    timeout: 30_000,
  });
  expect(git(["rev-parse", "HEAD"]).trim()).toBe(headBefore);
  await page.screenshot({ path: `${SHOTS}/ac-5-pull-diverged.png` });

  /* Resolve the divergence in a terminal (the copy's own advice), let the
     remote move again, and Pull fast-forwards — the error clears and Push
     is green again. */
  git(["reset", "--hard", "origin/trunk"]);
  rivalPush();
  await pullBtn.click();
  await expect(page.locator("[data-shiperror]")).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect
    .poll(() => git(["log", "-1", "--format=%s"]).trim(), { timeout: 30_000 })
    .toContain("rival commit");
  await page.locator("[data-shippush]").click();
  await expect(page.locator("[data-shiperror]")).toHaveCount(0, {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-5-pulled.png` });

  // No remote: a repo without origin.
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await page
    .locator("aside")
    .getByRole("button", { name: /default/i })
    .click();
  await pickSessionFolder(page, nonremoteDir);
  await send(page, "no remote session");
  /* #577: a send lands on the panel; Focus opens via its ↗. */
  await panelIntoFocus(page);
  await tab(page, /Changes/).click();
  writeFileSync(path.join(nonremoteDir, "n2.txt"), "more\n");
  const nrTurn = await sendTurn(page, "Add a note");
  await allowAllWhile(page, expectSettled(nrTurn));
  await expect(page.locator("[data-shipbar]")).toBeVisible({
    timeout: 30_000,
  });
  await page.locator("[data-shipmessage]").fill("local only");
  await page.locator("[data-shipcommit]").click();
  await page.locator("[data-shippush]").click();
  /* #579 AC-2: the error names a next step Oscar can take — ask the
     employee, never type a git command. */
  await expect(page.locator("[data-shiperror]")).toContainText(
    /isn't on GitHub yet\. Ask .* to publish it/i,
    { timeout: 30_000 },
  );
  await page.screenshot({ path: `${SHOTS}/ac-3-no-remote.png` });

  // Auth: the remote is an unroutable ssh URL — git's own auth-ish failure
  // reads plainly (never raw stderr on the surface).
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await page
    .locator("aside")
    .getByRole("button", { name: /default/i })
    .click();
  await pickSessionFolder(page, authDir);
  await send(page, "auth remote session");
  /* #577: a send lands on the panel; Focus opens via its ↗. */
  await panelIntoFocus(page);
  await tab(page, /Changes/).click();
  writeFileSync(path.join(authDir, "s2.txt"), "more\n");
  const aTurn = await sendTurn(page, "Add a note");
  await allowAllWhile(page, expectSettled(aTurn));
  await page.locator("[data-shipmessage]").fill("auth try");
  await page.locator("[data-shipcommit]").click();
  await page.locator("[data-shippush]").click();
  const authErr = page.locator("[data-shiperror]");
  await expect(authErr).toContainText(
    /couldn't sign in.*Ask .* to fix the sign-in/i,
    { timeout: 30_000 },
  );
  await page.screenshot({ path: `${SHOTS}/ac-3-auth.png` });
});

test("AC-4 Create PR asks for a branch name on the default branch, then gh pr create lands it and the PR tab shows it", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await dmDefault(page);
  await openFocus(page, SHIP_SESSION);
  await tab(page, /Changes/).click();
  await expect(page.locator("[data-shipbar]")).toBeVisible({ timeout: 30_000 });

  // The session's branch is `trunk` — the remote's default — so the form
  // asks for a new branch name first.
  await page.locator("[data-shippr]").click();
  await expect(page.locator("[data-shipbranch]")).toBeVisible();
  // Title/body prefilled from the branch's commits; both stay editable.
  const title = page.locator("[data-shiptitle]");
  await expect(title).not.toHaveValue("");
  await expect(page.locator("[data-shipbody]")).toContainText(/## Summary/);
  await page.locator("[data-shipbranch]").fill("feat/e2e-ship");
  await title.fill("E2E ship bar PR");
  await page.screenshot({ path: `${SHOTS}/ac-4-ask-branch.png` });
  await page.locator("[data-shipcreate]").click();

  // git.createBranch → git.push → gh pr create; the PR tab shows #8.
  await expect(page.locator("[data-shiperror]")).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(page.locator("[data-pr='8']")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-pr='8']")).toContainText("E2E ship bar PR");
  const log = readFileSync(ghLogFile, "utf8");
  expect(log).toContain("pr create");
  expect(log).toContain("--title E2E ship bar PR");
  // The checkout moved onto the new branch and pushed it.
  expect(git(["symbolic-ref", "--short", "HEAD"]).trim()).toBe("feat/e2e-ship");
  await page.screenshot({ path: `${SHOTS}/ac-4-pr-tab.png` });

  // Off the default branch the ask is gone — the form goes straight to the
  // prefilled title/body.
  await tab(page, /Changes/).click();
  await page.locator("[data-shippr]").click();
  await expect(page.locator("[data-shipbranch]")).toHaveCount(0);
  await page.locator("[data-shipcreate]").click();
  await expect(page.locator("[data-shiperror]")).toHaveCount(0, {
    timeout: 60_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-4-no-branch-ask.png` });
});

test("AC-5 agent-shell commits and pushes refresh Changes/Commits/PR on their own", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);
  await openFocus(page, SHIP_SESSION);
  await tab(page, /Changes/).click();
  await expect(page.locator("[data-shipbar]")).toBeVisible({ timeout: 30_000 });

  // While a turn runs (parked on its approval), the agent's own shell work
  // lands: a committed file + a still-dirty one — the tab polls and shows
  // both without a click.
  const turn = await sendTurn(page, "Add a changelog note to the readme");
  await expect(turn.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  writeFileSync(path.join(repoDir, "shell.txt"), "agent shell\n");
  writeFileSync(path.join(repoDir, "a.txt"), "one\ntwo\nthree\nfour\n");
  git([...cfg, "add", "shell.txt"]);
  git([...cfg, "commit", "-m", "agent shell commit"]);
  await expect(page.getByText("agent shell commit").last()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[data-diff="a.txt"]')).toBeVisible({
    timeout: 30_000,
  });
  // The commit row offers the real sha.
  expect(git(["log", "-1", "--format=%s"])).toContain("agent shell commit");
  await page.screenshot({ path: `${SHOTS}/ac-5-shell-commit.png` });
  await allowAllWhile(page, expectSettled(turn));
});

test("AC-6 a folder that is not a git repo shows no ship bar and no Changes/PR tabs", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);
  await pickSessionFolder(page, plainDir);
  await send(page, "plain folder session");
  /* #577: a send lands on the panel; Focus opens via its ↗. */
  await panelIntoFocus(page);
  await expect(page.getByTitle("Workbench", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(tab(page, "Files")).toBeVisible({ timeout: 30_000 });
  await expect(tab(page, /Changes/)).toHaveCount(0);
  await expect(tab(page, /PR/)).toHaveCount(0);
  await expect(page.locator("[data-shipbar]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-6-not-a-repo.png` });
});
