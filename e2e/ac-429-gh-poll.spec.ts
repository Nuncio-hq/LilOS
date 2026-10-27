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
  pickPorts,
  type Stack,
  startChatInFolder,
} from "./helpers/stack";

/**
 * Issue #429 — the Workbench's `forge.pr` re-read is a `gh pr view`
 * subprocess (~1s). Riding the running-turn poll loop it produced ~40
 * calls/min per open Workbench — GitHub rate-limit pressure and a Mac
 * spawning `gh`/`git` non-stop (#426). The read now runs on signals: a
 * `running` flip (turn start and end), the PR tab or the OS window
 * gaining focus, and a ≤1/min keep-alive while a turn runs — coalesced
 * so a burst still lands one call. This spec counts `pr view` lines in
 * the fake `gh`'s invocation log ($GH_FAKE_LOG — one argv line per call)
 * on the real stack (relay + harness + vite dev, engine-fake).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const fakeGh = path.join(repo, "packages", "host", "test", "fake-gh");

const SHOTS = path.join(repo, "test-results", "ac-429");

/* Fixture dir + the fake gh's state, all under one tmp root. */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-429-"));
const repoDir = path.join(ROOT, "lilos-repo-a");
const ghFakeDir = path.join(ROOT, "gh-fake");
const viewPath = path.join(ghFakeDir, "view.json");
const ghLogFile = path.join(ghFakeDir, "gh.log");
mkdirSync(repoDir, { recursive: true });
mkdirSync(ghFakeDir, { recursive: true });
const git = (args: string[], cwd = repoDir) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });
git(["init", "-b", "trunk"]);
writeFileSync(path.join(repoDir, "a.txt"), "one\n");
git(["add", "."]);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);

/* `gh pr view --json` fixture — an OPEN PR so the PR tab exists. */
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
  statusCheckRollup: [],
  comments: [],
};
const writeView = (v: unknown) =>
  writeFileSync(viewPath, `${JSON.stringify(v, null, 2)}\n`);

/* Every `forge.pr` lands a `gh pr view` argv line in the fake's log. */
const prViewCount = () =>
  readFileSync(ghLogFile, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("pr view")).length;

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  writeView(PR_VIEW);
  writeFileSync(ghLogFile, "");
  /* The fake gh rides PATH (forge.* shells out to it) and logs argv to
     GH_FAKE_LOG — the spec counts `pr view` lines. */
  stack = await bootStack("ac429", await pickPorts(), {
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

/* The session AC-1 starts; AC-2 reopens it as the session view. */
let ghConv: string;

/** A new session in the repo, the way a person starts one: the new-chat
    draft's folder chip, then Send. An id that names nobody opens the draft
    on the default agent, so the spec needs no employee lookup. */
const startSession = (page: Page, text: string) =>
  startChatInFolder(
    page,
    stack,
    { id: "default", name: "Hermes" },
    repoDir,
    text,
  );

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const turns = (page: Page) => page.locator("[data-agentturn]");

/* Send as a NEW turn (same anchoring as ac-114): wait for earlier turns to
   settle, send, return the agent turn right after THIS message. */
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

const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });

test("AC-1 a running turn makes at most one gh call per minute", async ({
  page,
}) => {
  test.setTimeout(180_000);
  ghConv = await startSession(page, "check in");
  // A send lands on the thread beside Threads — the PR tab lives in the
  // session view (widened) with the Workbench.
  await panelIntoFocus(page);
  /* The PR tab only exists once forge.pr has answered — its presence proves
     the probe's first `gh pr view` already logged. */
  await expect(tab(page, /PR/)).toBeVisible({ timeout: 30_000 });

  /* An approval-parked turn holds `running` for as long as we look — the
     window the old 1.5s poll filled with `gh pr view` calls (~10 here). */
  const edit = await sendTurn(page, "Add a changelog note to the readme");
  await expect(edit.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  /* Give the turn-start probe read (the `running` flip's own re-read) a
     couple of seconds to land, then sample the window. */
  await page.waitForTimeout(2_000);
  const before = prViewCount();
  /* The measurement window IS the assertion — a rate cap needs elapsed
     time; 15s is far short of the 60s keep-alive, so the scheduler fires
     0 calls here (the old loop logged ~10). */
  await page.waitForTimeout(15_000);
  const during = prViewCount() - before;
  expect(
    during,
    `${during} \`gh pr view\` calls inside 15s of a parked turn — ` +
      "the Workbench must stay under 1/min",
  ).toBeLessThanOrEqual(1);

  // Release the parked turn so the session is clean for the next test.
  await allowAllWhile(page, expectSettled(edit));
});

test("AC-2 the PR tab refreshes on turn end, tab focus and window focus", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openSession(page, stack.webUrl, ghConv);

  const prTab = tab(page, /PR/);
  await expect(prTab).toBeVisible({ timeout: 30_000 });

  /* Turn end: `running` flipping off re-runs the probe effect — the
     settle-time re-read lands within seconds of the turn closing. */
  const edit = await sendTurn(page, "Add a changelog note to the readme");
  await expect(edit.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(2_000); // the turn-start read has landed
  const preSettle = prViewCount();
  await allowAllWhile(page, expectSettled(edit));
  await expect
    .poll(() => prViewCount(), { timeout: 20_000 })
    .toBeGreaterThan(preSettle);

  /* PR-tab focus: leave and land back on PR — one fresh `pr view`. */
  const preTab = prViewCount();
  await tab(page, /Changes/).click();
  await prTab.click();
  await expect
    .poll(() => prViewCount(), { timeout: 15_000 })
    .toBeGreaterThan(preTab);
  await expect(page.locator("[data-pr='7']")).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-2-pr-tab.png` });

  /* OS-window focus rides the same signal — a focus event on the window
     re-reads the forge within seconds. */
  const preFocus = prViewCount();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect
    .poll(() => prViewCount(), { timeout: 15_000 })
    .toBeGreaterThan(preFocus);
});
