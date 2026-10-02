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
 * Issue #108 — comment on a diff line and the agent gets it: in Focus →
 * Workbench → Changes Oscar pins a note on a line or a dragged range, edits
 * or deletes it, and Send to agent posts ONE user message quoting every
 * comment's `path:line` + code. Mid-turn sends ride the composer's rule —
 * session.steer when the engine declares it (AC-3); sent comments stay as
 * resolved markers until the file changes (AC-4).
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

const SHOTS = path.join(repo, "test-results", "ac-108");

/* One tmp git repo the session runs in; uncommitted edits drive the diff. */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-108-"));
const repoDir = path.join(ROOT, "lilos-repo-a");
const ghFakeDir = path.join(ROOT, "gh-fake");
const ghLogFile = path.join(ghFakeDir, "gh.log");
mkdirSync(repoDir, { recursive: true });
mkdirSync(ghFakeDir, { recursive: true });
const git = (args: string[], cwd = repoDir) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });
git(["init", "-b", "trunk"]);
writeFileSync(path.join(repoDir, "a.txt"), "one\n");
writeFileSync(path.join(repoDir, "b.txt"), "bees\n");
git(["add", "."]);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac108", {
    relay: wport(4741),
    feed: wport(4827),
    web: wport(5328),
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
  /* Recents render async (relay list + live probe) — an immediate isVisible
     reads false while they load and Add-folder then dead-ends on "Already
     added". Give the row a beat to appear first. */
  const recentVisible = await recent
    .first()
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (recentVisible) {
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

/* See ac-114: send as a NEW turn (idle sends steer a running one instead). */
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

const FOCUS_URL = /\/dm\/[^/]+\/[^/]+\/focus$/;
const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });

const diff = (page: Page, file: string) =>
  page.locator(`[data-diff="${file}"]`);
const commentEditor = (page: Page) => page.locator("[data-comment-editor]");
const pending = (page: Page) => page.locator("[data-diff-pending]");
const commentsOn = (page: Page, file: string) =>
  diff(page, file).locator("[data-comment]");

/** Click the code cell of row `i` → single-line comment editor opens. */
async function commentLine(page: Page, file: string, i: number, text: string) {
  await diff(page, file).locator(`[data-diff-line="${i}"] td`).nth(2).click();
  await expect(commentEditor(page)).toBeVisible();
  await commentEditor(page).locator("[data-comment-input]").fill(text);
  await commentEditor(page).locator("[data-comment-save]").click();
  await expect(commentEditor(page)).toHaveCount(0);
}

/** Gutter-drag rows `from` → `to` → range comment editor opens. */
async function commentRange(
  page: Page,
  file: string,
  from: number,
  to: number,
  text: string,
) {
  const start = diff(page, file)
    .locator(`[data-diff-line="${from}"] td`)
    .first();
  const end = diff(page, file).locator(`[data-diff-line="${to}"] td`).first();
  const sb = await start.boundingBox();
  const eb = await end.boundingBox();
  if (!sb || !eb) throw new Error("diff rows not laid out for the drag");
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(commentEditor(page)).toBeVisible();
  await commentEditor(page).locator("[data-comment-input]").fill(text);
  await commentEditor(page).locator("[data-comment-save]").click();
  await expect(commentEditor(page)).toHaveCount(0);
}

const openChanges = async (page: Page) => {
  const changes = tab(page, /Changes/);
  await expect(changes).toBeVisible({ timeout: 30_000 });
  await changes.click();
};

/* The folder picks are per-page; each test sets up its own session. */
async function freshSession(page: Page) {
  await dmDefault(page);
  await pickSessionFolder(page, repoDir);
  await send(page, "check in");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
}

/* Uncommitted edits the Changes tab diffs (a.txt tracked+modified, notes.txt
   new). Written per test — filtered runs skip earlier tests but must still
   see the same repo state. */
const seedChanges = (a3 = false) => {
  writeFileSync(
    path.join(repoDir, "a.txt"),
    a3 ? "one\ntwo\nthree\n" : "one\ntwo\n",
  );
  writeFileSync(path.join(repoDir, "notes.txt"), "fresh\nlines\nhere\n");
};

test("AC-1 pending comments add/edit/delete on a line and a dragged range, surviving tab switches", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await freshSession(page);

  // Uncommitted edits → the Changes tab lists both files (live git.diff).
  seedChanges();
  await openChanges(page);
  await expect(diff(page, "a.txt")).toBeVisible({ timeout: 30_000 });
  await expect(diff(page, "notes.txt")).toBeVisible();

  // Single line: a.txt's "+two" row (hunk, ctx, add → row 2).
  await commentLine(page, "a.txt", 2, "rename this");
  await expect(commentsOn(page, "a.txt")).toHaveCount(1);
  await expect(commentsOn(page, "a.txt")).toContainText("rename this");
  await expect(commentsOn(page, "a.txt")).toContainText("a.txt:2");
  await expect(pending(page)).toHaveText(/1 pending/);

  // Edit it: the pencil re-opens the editor with the text.
  await commentsOn(page, "a.txt").locator("[data-comment-edit]").click();
  await expect(commentEditor(page)).toBeVisible();
  await expect(commentEditor(page).locator("[data-comment-input]")).toHaveValue(
    "rename this",
  );
  await commentEditor(page)
    .locator("[data-comment-input]")
    .fill("rename this variable");
  await commentEditor(page).locator("[data-comment-save]").click();
  await expect(commentsOn(page, "a.txt")).toContainText("rename this variable");

  // A dragged range on notes.txt (3 added lines → rows 1–3).
  await commentRange(page, "notes.txt", 1, 3, "why three lines?");
  await expect(commentsOn(page, "notes.txt")).toContainText("why three lines?");
  await expect(commentsOn(page, "notes.txt")).toContainText("notes.txt:1–3");
  await expect(pending(page)).toHaveText(/2 pending/);

  // Delete the range comment — counter drops back.
  await commentsOn(page, "notes.txt").locator("[data-comment-delete]").click();
  await expect(commentsOn(page, "notes.txt")).toHaveCount(0);
  await expect(pending(page)).toHaveText(/1 pending/);

  // AC-1: pending comments survive a tab switch (the tab unmounts content).
  await tab(page, "Files").click();
  await openChanges(page);
  await expect(commentsOn(page, "a.txt")).toContainText("rename this variable");
  await expect(pending(page)).toHaveText(/1 pending/);
  await page.screenshot({ path: `${SHOTS}/ac-1-pending.png` });
});

test("AC-2 + AC-4 Send posts one message quoting path:line + code; sent comments stay as resolved markers until the file changes", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await freshSession(page);
  seedChanges();
  await openChanges(page);
  await expect(diff(page, "a.txt")).toBeVisible({ timeout: 30_000 });
  await expect(diff(page, "notes.txt")).toBeVisible();

  // One comment per file so AC-4 can watch one drop while the other stays.
  await commentLine(page, "a.txt", 2, "rename this");
  await commentRange(page, "notes.txt", 1, 3, "why three lines?");
  await expect(pending(page)).toHaveText(/2 pending/);
  await page.screenshot({ path: `${SHOTS}/ac-1-pending-range.png` });

  // Idle → the send starts a fresh turn (AC-3's prompt branch).
  const sent = page
    .locator("main [data-msg]")
    .filter({ hasText: "Review comments on the diff" });
  await page.locator("[data-diff-send]").click();
  await expect(sent).toHaveCount(1, { timeout: 30_000 });
  await expect(sent).toContainText("a.txt:2");
  await expect(sent).toContainText("+two");
  await expect(sent).toContainText("rename this");
  await expect(sent).toContainText("notes.txt:1-3");
  await expect(sent).toContainText("why three lines?");
  // A new agent turn answers the message (AC-2).
  const turn = turns(page).last();
  await expect(turn).toBeVisible({ timeout: 60_000 });
  await allowAllWhile(page, expectSettled(turn));
  await page.screenshot({ path: `${SHOTS}/ac-2-sent.png` });

  // AC-4: sent comments render as resolved markers; the counter is gone.
  await openChanges(page);
  await expect(pending(page)).toHaveCount(0);
  await expect(diff(page, "a.txt").locator("[data-resolved]")).toHaveCount(1);
  await expect(diff(page, "notes.txt").locator("[data-resolved]")).toHaveCount(
    1,
  );
  await page.screenshot({ path: `${SHOTS}/ac-4-resolved.png` });

  /* The file's patch moving drops its markers while an untouched file's
     stay. The Changes tab polls while a turn runs, so do it mid-turn: an
     edit-ask parks on its approval card and the probe keeps refreshing. */
  const edit = await sendTurn(page, "Add a changelog note to the readme");
  await expect(edit.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  await openChanges(page);
  writeFileSync(path.join(repoDir, "a.txt"), "one\ntwo\nthree\n");
  await expect(diff(page, "a.txt").locator("[data-resolved]")).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(diff(page, "notes.txt").locator("[data-resolved]")).toHaveCount(
    1,
  );
  await allowAllWhile(page, expectSettled(edit));
  await page.screenshot({ path: `${SHOTS}/ac-4-file-changed.png` });
});

test("AC-3 send mid-turn rides session.steer — the message lands as a steered row", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await freshSession(page);
  seedChanges(true); // the "three lines" state — row 3 is the +three add

  // Park a turn on its approval so a send lands mid-turn.
  const edit = await sendTurn(page, "Add another note to the readme");
  await expect(edit.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });

  await openChanges(page);
  // a.txt is now "one\ntwo\nthree\n" — the "+three" add sits at row 3.
  await commentLine(page, "a.txt", 3, "and this one too");
  await expect(pending(page)).toHaveText(/1 pending/);
  await page.locator("[data-diff-send]").click();

  // engine-fake declares `steer`: the message waits in the queued tray…
  await expect(page.locator("[data-queued]")).toContainText(
    "and this one too",
    { timeout: 30_000 },
  );
  await page.screenshot({ path: `${SHOTS}/ac-3-steer-waiting.png` });

  // …then lands inside the turn as a steered row once it continues.
  await allowAllWhile(page, expectSettled(edit));
  await expect(
    edit.locator("[data-steerstate='landed']").filter({
      hasText: "and this one too",
    }),
  ).toHaveCount(1, { timeout: 30_000 });
  // It resolved like a sent comment — marker on a.txt, counter clear.
  await openChanges(page);
  await expect(diff(page, "a.txt").locator("[data-resolved]")).toHaveCount(1);
  await expect(pending(page)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-3-steered.png` });
});
