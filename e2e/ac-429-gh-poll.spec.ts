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
    await killProc(proc);
    throw e;
  }
}

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
  stack = await bootStack("ac429", {
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

const sessionRow = (page: Page) => page.locator("[data-session] button").last();

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
const PANEL_URL = /\/dm\/[^/]+\/conv_[^/]+$/;
const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });

test("AC-1 a running turn makes at most one gh call per minute", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);
  await pickSessionFolder(page, repoDir);
  await send(page, "check in");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
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
  await dmDefault(page);
  await openFocus(page);

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
