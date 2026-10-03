import { type ChildProcess, execFileSync, spawn } from "node:child_process";
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
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import { allowAllWhile, expectSettled } from "./helpers/approvals";
import { wport } from "./ports";

/**
 * Issue #114 — Focus mode + Workbench in the real app (apps/web), on the real
 * stack (relay + harness + vite dev, engine-fake): a session opens in the
 * 420px thread panel beside the feed (#195), and the panel's ↗ continues into
 * full-window Focus at /dm/$employeeId/$conversationId/focus; the Workbench's
 * Changes (git.diff), Files (fs.tree/fs.read) and PR (forge.pr/comment/merge)
 * tabs read the session's real folder — here a tmp git repo served by the
 * stateful fake `gh` (packages/host/test/fake-gh) on the stack's PATH.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");
const fakeGh = path.join(repo, "packages", "host", "test", "fake-gh");

interface Stack {
  home: string;
  webUrl: string;
  stop: () => Promise<void>;
}

async function waitForHttp(url: string, ms = 90_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const ok = await fetch(url)
      .then((r) => r.ok || r.status === 404)
      .catch(() => false);
    if (ok) return;
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function killProc(proc: ChildProcess): Promise<void> {
  const killGroup = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      if (proc.pid) process.kill(-proc.pid, sig);
    } catch {
      try {
        proc.kill(sig);
      } catch {}
    }
  };
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      killGroup("SIGKILL");
      resolve();
    }, 8_000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    killGroup("SIGTERM");
  });
}

/* `bun run dev` + the fake gh on PATH (forge.* shells out to it). */
async function bootStack(
  tag: string,
  ports: { relay: number; feed: number; web: number },
): Promise<Stack> {
  const home = mkdtempSync(path.join(tmpdir(), `lilos-e2e-${tag}-`));
  const leakTag = engineTag(tag);
  const proc = spawn("bun", ["run", "dev"], {
    cwd: webDir,
    detached: true,
    env: {
      ...process.env,
      LILOS_HOME: home,
      LILOS_ENGINE_TAG: leakTag,
      LILOS_RELAY_PORT: String(ports.relay),
      LILOS_FEED_PORT: String(ports.feed),
      LILOS_WEB_PORT: String(ports.web),
      PATH: `${fakeGh}:${process.env.PATH}`,
      GH_FAKE_DIR: ghFakeDir,
      GH_FAKE_LOG: ghLogFile,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${ports.web}`;
  try {
    await waitForHttp(webUrl);
    await waitForHttp(`http://127.0.0.1:${ports.relay}/`);
    await waitForHttp(`http://127.0.0.1:${ports.feed}/`);
    const tokenPath = path.join(home, "relay-token");
    let relayToken = "";
    for (let i = 0; i < 300 && !relayToken; i++) {
      try {
        relayToken = readFileSync(tokenPath, "utf8").trim();
      } catch {}
      if (!relayToken) await new Promise((r) => setTimeout(r, 100));
    }
    if (!relayToken)
      throw new Error(`relay token never appeared at ${tokenPath}`);
    return {
      home,
      webUrl,
      stop: async () => {
        await killProc(proc);
        await expectNoEngineLeak(leakTag);
      },
    };
  } catch (e) {
    // Group kill: `bun run dev` spawns detached — killing only the shim
    // orphans stack.ts + relay + harness + vite and poisons the next boot.
    await killProc(proc);
    throw e;
  }
}

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
  stack = await bootStack("ac114", {
    relay: wport(4740),
    feed: wport(4826),
    web: wport(5327),
  });
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

/* `?roots=` lets git.discoverRepos find repoDir, but folders are added through
   the dialog's path input — deterministic either way. */
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
  // The pick lands async (addFolder → setPick) — wait for the button label
  // before sending, or the session starts without the folder.
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
    .locator("main [data-msg]")
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

/** The open session's chip row on the DM home. */
const sessionRow = (page: Page) => page.locator("[data-session] button").last();

/* #195: a feed row opens the peek panel (not Focus); the panel's ↗ carries
   on into Focus — every session-open in these tests goes through both. */
const openFocus = async (page: Page) => {
  await sessionRow(page).click();
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await page
    .locator("[data-thread-panel]")
    .getByTitle("Focus", { exact: true })
    .click();
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
};

const FOCUS_URL = /\/dm\/[^/]+\/[^/]+\/focus$/;
/* The peek panel sits at the conversation URL — end-anchored so it never
   matches /focus. */
const PANEL_URL = /\/dm\/[^/]+\/conv_[^/]+$/;
const DM_URL = /\/dm\/[^/]+$/;
// exact: title substring-match would also hit "Hide workbench" when open.
const workbenchToggle = (page: Page) =>
  page.getByTitle("Workbench", { exact: true });
const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });

test("AC-1 a session opens in the panel; ↗ reaches Focus; Esc/Back return through the panel", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await pickSessionFolder(page, repoDir);
  await send(page, "check in");
  // A send still lands in Focus, at its own URL (#195 routes it through the
  // panel URL so every way back out lands on the same open peek).
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  await expect(page.locator("main").getByText("check in").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(workbenchToggle(page)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-1-focus.png` });

  // Reload stays in Focus (the URL carries it).
  await page.reload();
  await expect(page).toHaveURL(FOCUS_URL);
  await expect(workbenchToggle(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("main").getByText("check in").first()).toBeVisible({
    timeout: 30_000,
  });

  /* #195 AC-2: Esc returns to the DM feed with the panel open on the same
     session — the feed stays visible beside it. */
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(PANEL_URL);
  const panel = page.locator("[data-thread-panel]");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText("check in").first()).toBeVisible();
  await expect(page.locator("main [data-session]").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-1-panel.png` });

  // The panel URL reloads too (the URL carries it).
  await page.reload();
  await expect(page).toHaveURL(PANEL_URL);
  await expect(page.locator("[data-thread-panel]")).toBeVisible({
    timeout: 30_000,
  });

  // #195 AC-1: Esc again closes the panel back to the plain feed.
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(DM_URL);
  await expect(page.locator("[data-thread-panel]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-1-esc-dm.png` });

  /* Clicking the session's row re-opens the panel (not Focus); the panel's
     ↗ is the way into Focus; the Focus back arrow returns to the panel. */
  await sessionRow(page).click();
  await expect(page).toHaveURL(PANEL_URL);
  await panel.getByTitle("Focus", { exact: true }).click();
  await expect(page).toHaveURL(FOCUS_URL);
  await page.getByTitle("Back to DM").click();
  await expect(page).toHaveURL(PANEL_URL);
  await page.screenshot({ path: `${SHOTS}/ac-1-back-panel.png` });
});

test("AC-2 Focus is the same live conversation: streaming, steps, approvals, model picker, steer + stop", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);
  await openFocus(page);

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

  // Esc inside the composer is still the turn's Stop — Focus stays open.
  const stopped = await sendTurn(page, "Add another note to the readme");
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  const box = page.locator("main textarea");
  await box.click();
  await page.keyboard.press("Escape");
  // Wait the turn-ended wire condition before asserting the footer chip
  // (turn.completed -> data-turnsettled), not a wall-clock guess (#257).
  await expectSettled(stopped);
  await expect(stopped.getByText("Stopped · session.interrupt")).toBeVisible();
  await expect(page).toHaveURL(FOCUS_URL);
  await page.screenshot({ path: `${SHOTS}/ac-2-stopped.png` });
});

test("AC-3 Changes lists uncommitted files with +/− and refreshes while the agent works", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);
  await openFocus(page);

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
  await expect(page.locator("main").getByText("+4").first()).toBeVisible();
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
  await dmDefault(page);
  await openFocus(page);

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
  await dmDefault(page);
  await openFocus(page);

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
  /* #319: the picked tab rides the URL — the reload lands back on
     `?tab=pr`, not the default tab. */
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+\/focus\?tab=pr$/);
  await expect(tab(page, /^PR$/)).toBeVisible({ timeout: 30_000 });
  await tab(page, /^PR$/).click();
  await expect(
    page.getByText(/No pull request on/, { exact: false }),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-5-no-pr.png` });

  // `gh` signed out (its real "gh auth login" stderr + exit 4) → the sign-in
  // copy with a copyable chip and Retry — never raw stderr, never "gh failed:".
  writeFileSync(failPath, "auth\n");
  await page.reload();
  await expect(tab(page, /^PR$/)).toBeVisible({ timeout: 30_000 });
  await tab(page, /^PR$/).click();
  await expect(
    page.getByText("Sign in to GitHub to see this PR", { exact: false }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("gh auth login")).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  await expect(page.getByText(/gh failed:/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-5-gh-auth.png` });

  // Retry re-probes for real: gh healthy again → the PR renders in place.
  rmSync(failPath);
  writeView(PR_VIEW);
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
  await page.getByText("Details").click();
  await expect(page.getByText(/fake gh: boom/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-5-gh-error.png` });
  rmSync(failPath);
});

test("AC-6 tabs render only when their host method answers; a session without a folder shows no Workbench", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);

  // A session on a plain (non-repo) folder: fs answers, git/forge don't →
  // only the Files tab renders. Browser/Terminal never render in this slice.
  await pickSessionFolder(page, plainDir);
  await send(page, "check the folder");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  await expect(workbenchToggle(page)).toBeVisible({ timeout: 30_000 });
  await expect(tab(page, "Files")).toBeVisible({ timeout: 30_000 });
  await expect(tab(page, /Changes/)).toHaveCount(0);
  await expect(tab(page, /PR/)).toHaveCount(0);
  await expect(tab(page, /Terminal/)).toHaveCount(0);
  await expect(tab(page, /Preview/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-6-plain-folder.png` });

  // A session without a folder: no Workbench at all. Focus has no sidebar
  // by design (#246) — Esc back to the panel, then use it.
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(PANEL_URL);
  await page
    .locator("aside")
    .getByRole("button", { name: /default/i })
    .click();
  await expect(page).toHaveURL(DM_URL);
  // The picker auto-selects the last session's folder — pick "just chat".
  await pickerButton(page).click();
  await page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last()
    .getByText("No folder · just chat")
    .click();
  await send(page, "just chat — no folder");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  await expect(workbenchToggle(page)).toHaveCount(0);
  await expect(tab(page, /Files|Changes|PR|Terminal|Preview/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-6-no-folder.png` });
});

test("AC-7 Focus + Workbench compose like the prototype (evidence screenshots)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  // AC-1's repo session — AC-6 added newer plain/no-folder rows on top.
  // #195: the row opens the panel; ↗ carries on into Focus.
  await page
    .locator("[data-session]", { hasText: "check in" })
    .getByRole("button", { name: /repl(y|ies)/ })
    .click();
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await page
    .locator("[data-thread-panel]")
    .getByTitle("Focus", { exact: true })
    .click();
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
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
  await dmDefault(page);
  await pickSessionFolder(page, regDir);
  await send(page, "say hi");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
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
