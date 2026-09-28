import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
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

/**
 * Issue #114 — Focus mode + Workbench in the real app (apps/web), on the real
 * stack (relay + harness + vite dev, engine-fake): a session opens full-window
 * Focus at /dm/$employeeId/$conversationId/focus; the Workbench's Changes
 * (git.diff), Files (fs.tree/fs.read) and PR (forge.pr/comment/merge) tabs read
 * the session's real folder — here a tmp git repo served by the stateful fake
 * `gh` (packages/host/test/fake-gh) on the stack's PATH.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const WORKER = Number(process.env.TEST_WORKER_INDEX ?? "0");
const wport = (p: number) => p + WORKER * 100;
const webDir = path.join(repo, "apps", "web");
const fakeGh = path.join(repo, "packages", "host", "test", "fake-gh");

interface Stack {
  home: string;
  webUrl: string;
  stop: () => Promise<void>;
}

async function waitForHttp(url: string, ms = 30_000): Promise<void> {
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
    proc.kill("SIGKILL");
    throw e;
  }
}

const SHOTS = path.join(repo, "test-results", "ac-114");

/* Fixture dirs + the fake gh's state, all under one tmp root. */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-114-"));
const repoDir = path.join(ROOT, "lilos-repo-a");
const plainDir = path.join(ROOT, "lilos-plain-b");
const ghFakeDir = path.join(ROOT, "gh-fake");
const viewPath = path.join(ghFakeDir, "view.json");
const ghLogFile = path.join(ghFakeDir, "gh.log");
mkdirSync(repoDir, { recursive: true });
mkdirSync(plainDir, { recursive: true });
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
    feed: wport(4741),
    web: wport(5300),
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
async function pickFolder(page: Page, dir: string) {
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

/** The open session's chip row on the DM home. */
const sessionRow = (page: Page) => page.locator("[data-session] button").last();

async function allowAll(page: Page) {
  for (let i = 0; i < 6; i++) {
    const b = page.getByRole("button", { name: "Allow once" });
    if (
      !(await b
        .first()
        .isVisible()
        .catch(() => false))
    )
      return;
    await b.first().click();
    await page.waitForTimeout(400);
  }
}

const FOCUS_URL = /\/dm\/[^/]+\/[^/]+\/focus$/;
const DM_URL = /\/dm\/[^/]+$/;
const workbenchToggle = (page: Page) => page.getByTitle("Workbench");
const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });

test("AC-1 a session opens straight into Focus; the URL carries it; Esc/Back return", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await pickFolder(page, repoDir);
  await send(page, "check in");
  // The session opens full-window in Focus, at its own URL.
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

  // Esc returns to the DM home with no panel open.
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(DM_URL);
  await expect(workbenchToggle(page)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-1-esc-dm.png` });

  // Clicking the session's row re-opens Focus.
  await sessionRow(page).click();
  await expect(page).toHaveURL(FOCUS_URL);
  // The back arrow does the same as Esc.
  await page.getByTitle("Back to DM").click();
  await expect(page).toHaveURL(DM_URL);
});

test("AC-2 Focus is the same live conversation: streaming, steps, approvals, model picker, steer + stop", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);
  await sessionRow(page).click();
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });

  // A reply turn streams in — reasoning + tool steps render live. `.last()`:
  // AC-1's "check in" turn sits above it and carries no tool steps.
  await send(page, "Say hello then list files");
  const turn = page.locator("[data-agentturn]").last();
  await expect(turn).toBeVisible({ timeout: 30_000 });
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

  // An edit-ask prompt parks on an approval card; answering it continues the turn.
  await send(page, "Add a release note to the readme");
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-2-approval.png` });
  await allowAll(page);
  await expect(
    page.getByText(/Allowed once|Always allowed/).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("[data-agentturn]").last()).toContainText(
    /Done on|Review it|done/i,
    { timeout: 60_000 },
  );

  // Esc inside the composer is still the turn's Stop — Focus stays open.
  await send(page, "Add another note to the readme");
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  const box = page.locator("main textarea");
  await box.click();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Stopped · session.interrupt")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page).toHaveURL(FOCUS_URL);
  await page.screenshot({ path: `${SHOTS}/ac-2-stopped.png` });
});

test("AC-3 Changes lists uncommitted files with +/− and refreshes while the agent works", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);
  await sessionRow(page).click();
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });

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
  await send(page, "Add a changelog note to the readme");
  await expect(page.getByText("Approval needed").first()).toBeVisible({
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
  await allowAll(page);
  await expect(page.locator("[data-agentturn]").last()).toContainText(
    /Done on|Review it|done/i,
    { timeout: 60_000 },
  );
  await expect(page.locator('[data-diff="notes.txt"]')).toBeVisible();
});

test("AC-4 Files shows the folder tree (fs.tree) and file contents (fs.read)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await sessionRow(page).click();
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });

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
  await sessionRow(page).click();
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });

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
  await expect(page).toHaveURL(FOCUS_URL);
  await expect(tab(page, /^PR$/)).toBeVisible({ timeout: 30_000 });
  await tab(page, /^PR$/).click();
  await expect(
    page.getByText(/No pull request on/, { exact: false }),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-5-no-pr.png` });

  // A `gh` failure (unauthenticated, missing) reads plainly too.
  writeFileSync(viewPath, "{not json\n");
  await page.reload();
  await expect(tab(page, /^PR$/)).toBeVisible({ timeout: 30_000 });
  await tab(page, /^PR$/).click();
  await expect(
    page.getByText(/gh failed|can't reach GitHub|Could not/i),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-5-gh-error.png` });
  writeView(PR_VIEW);
});

test("AC-6 tabs render only when their host method answers; a session without a folder shows no Workbench", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);

  // A session on a plain (non-repo) folder: fs answers, git/forge don't →
  // only the Files tab renders. Browser/Terminal never render in this slice.
  await pickFolder(page, plainDir);
  await send(page, "check the folder");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  await expect(workbenchToggle(page)).toBeVisible({ timeout: 30_000 });
  await expect(tab(page, "Files")).toBeVisible({ timeout: 30_000 });
  await expect(tab(page, /Changes/)).toHaveCount(0);
  await expect(tab(page, /PR/)).toHaveCount(0);
  await expect(tab(page, /Terminal/)).toHaveCount(0);
  await expect(tab(page, /Preview/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-6-plain-folder.png` });

  // A session without a folder: no Workbench at all.
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
  await page
    .locator("[data-session]", { hasText: "check in" })
    .getByRole("button", { name: /repl(y|ies)/ })
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
