import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { allowAllWhile, expectSettled } from "./helpers/approvals";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

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
const fakeGh = path.join(repo, "packages", "host", "test", "fake-gh");

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
  stack = await bootStack("ac108", await pickPorts(), {
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

const turns = (page: Page) => page.locator("main [data-agentturn]");

/* #474: where a send lands is decided by the session, not the spec. An
   idle send claims its own bubble and a new agent turn answers it; a send
   landing mid-turn goes through `session.steer` and lands as an "Oscar
   steered …" row inside the running turn — no bubble, and no new turn
   ever mounts. Wait for whichever shape the send took and return the turn
   it landed in. `text` must be unique within the session — hasText is a
   substring match, and a stale row would silently satisfy the or-wait. */
const awaitSendLanding = async (page: Page, text: string) => {
  const mine = page
    .locator("main [data-msg]")
    .filter({ hasText: text })
    .filter({ hasNot: page.locator("[data-agentturn]") })
    .last();
  const steered = page
    .locator("main [data-agentturn]")
    .filter({
      has: page.locator("[data-steerstate='landed']").filter({ hasText: text }),
    })
    .last();
  await expect(mine.or(steered)).toBeVisible({ timeout: 60_000 });
  if (await steered.isVisible()) return steered;
  const turn = mine.locator(
    "xpath=following-sibling::*[.//*[@data-agentturn]][1]//*[@data-agentturn]",
  );
  await expect(turn).toBeVisible({ timeout: 60_000 });
  return turn;
};

/* See ac-114: send as a NEW turn (idle sends steer a running one instead).
   #474: the idle read is the thread's last row — it must be a settled
   agent turn. `turns.count() > 0` couldn't see a minted turn whose card
   hadn't mounted yet, so the old guard skipped the settle wait exactly
   when a turn was still dispatching (the wild flake's window). A pumped
   follow-up can still slip through that mount gap — awaitSendLanding
   resolves whichever landing the send takes. */
const sendTurn = async (page: Page, text: string) => {
  await expect(
    page
      .locator("main [data-msg]")
      .last()
      .locator("[data-agentturn] [data-turnsettled]"),
  ).toBeVisible({ timeout: 60_000 });
  await send(page, text);
  return awaitSendLanding(page, text);
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
  /* #474/#496: hand each test an idle session. While the seeded turn is
     still dispatching, a send can slip in mid-turn (steer) and a
     `turns.last()` read can latch the seeded turn while the real one is
     still minting — both wild flakes came out of that window. */
  await expectSettled(turns(page).last());
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
  /* Dirty the repo BEFORE the session mounts — the Workbench's git probe
     re-reads on mount, on `running` flips, and on a 3s poll that only
     exists while a turn runs. A settled session never sees a later write
     (the seeded turn used to keep that poll alive until it landed). */
  seedChanges();
  await freshSession(page);

  // Uncommitted edits → the Changes tab lists both files (live git.diff).
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

  /* #393 AC-1: every line a pending comment covers carries the anchor
     marker — one row on a.txt, the three range rows on notes.txt. */
  await expect(
    diff(page, "a.txt").locator("[data-comment-anchor]"),
  ).toHaveCount(1);
  await expect(
    diff(page, "notes.txt").locator("[data-comment-anchor]"),
  ).toHaveCount(3);

  // Delete the range comment — counter drops back, its anchors unmark.
  await commentsOn(page, "notes.txt").locator("[data-comment-delete]").click();
  await expect(commentsOn(page, "notes.txt")).toHaveCount(0);
  await expect(
    diff(page, "notes.txt").locator("[data-comment-anchor]"),
  ).toHaveCount(0);
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
  /* Same as AC-1: dirty before the session mounts so the Workbench's
     first git probe already sees the changes — an idle session never
     re-polls (its poll only lives while a turn runs). */
  seedChanges();
  await freshSession(page);
  await openChanges(page);
  await expect(diff(page, "a.txt")).toBeVisible({ timeout: 30_000 });
  await expect(diff(page, "notes.txt")).toBeVisible();

  // One comment per file so AC-4 can watch one drop while the other stays.
  await commentLine(page, "a.txt", 2, "rename this");
  await commentRange(page, "notes.txt", 1, 3, "why three lines?");
  await expect(pending(page)).toHaveText(/2 pending/);
  await page.screenshot({ path: `${SHOTS}/ac-1-pending-range.png` });

  // Idle → the send starts a fresh turn (AC-3's prompt branch). hasNot
  // [data-agentturn]: the answering turn echoes the prompt, so it also
  // carries the marker text — only the user message is the sent one.
  const sent = page
    .locator("main [data-msg]")
    .filter({ hasText: "Review comments on the diff" })
    .filter({ hasNot: page.locator("[data-agentturn]") });
  await page.locator("[data-diff-send]").click();
  await expect(sent).toHaveCount(1, { timeout: 30_000 });
  await expect(sent).toContainText("a.txt:2");
  await expect(sent).toContainText("+two");
  await expect(sent).toContainText("rename this");
  // #393 AC-4: one range separator — the same en-dash the diff label uses.
  await expect(sent).toContainText("notes.txt:1–3");
  await expect(sent).toContainText("why three lines?");
  /* A new agent turn answers the message (AC-2). #496: anchor it to the
     sent bubble's following sibling — `turns.last()` can still read the
     seeded turn while this one is minting, and `expectSettled` would pass
     on the wrong turn while the real one parks on its approval card. */
  const turn = sent.locator(
    "xpath=following-sibling::*[.//*[@data-agentturn]][1]//*[@data-agentturn]",
  );
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
  /* #393 AC-2: the marker says what happened in words — a "Sent" pill
     mirroring the toast's route; the suffix depends on whether the send
     landed mid-turn ("steered"/"queued") or after it settled ("Sent").
     #393 AC-1: the sent comment's anchors stay marked as resolved rows. */
  await expect(diff(page, "a.txt").locator("[data-sent-pill]")).toHaveText(
    /^Sent( · steered| · queued)?$/,
  );
  await expect(
    diff(page, "notes.txt").locator("[data-comment-anchor]"),
  ).toHaveCount(3);
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
  // #393 AC-2: the marker's pill mirrors the toast — "Sent · steered".
  await expect(diff(page, "a.txt").locator("[data-sent-pill]")).toHaveText(
    "Sent · steered",
  );
  await expect(pending(page)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-3-steered.png` });
});

test("AC-3b a send landing mid-turn steers — the landing wait resolves the turn it joined (#474)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);
  await pickSessionFolder(page, repoDir);
  /* #474: `slow:` paces the seeded turn and its edit-ask parks on the
     patch approval — a parked turn can't end, so the next send always
     lands mid-turn: claimed=0, `session.steer`, pairs into `turn.steers`.
     (A steer that outlives its drain window instead pumps as the next
     turn — also a correct landing, but not the one under test; the park
     makes the steer itself deterministic.) The wild flake hit exactly
     this when `sendTurn`'s count guard read the session as idle while the
     seeded turn was still dispatching. */
  await send(page, "slow:150 Add a readme note");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  /* The card mounts only after the harness has processed turn.started
     (runningTurnId set) — a send past this point provably steers. Send
     earlier and it queues behind the minting turn, draining as the next
     turn: a correct landing, but not the one under test. */
  await expect(turns(page).last()).toBeVisible({ timeout: 60_000 });
  await send(page, "Add a changelog note while it runs");

  /* The send sits in the queued tray until the turn continues — the same
     accepted-steer shape AC-3 asserts on the diff-send path. */
  await expect(page.locator("[data-queued]")).toContainText(
    "Add a changelog note while it runs",
    { timeout: 30_000 },
  );

  /* The landing wait must resolve the turn the send joined — waiting for
     a bubble + a new [data-agentturn] (the old shape) hangs, since neither
     mounts for a steer. Answer the parked approvals while it lands. */
  const landing = awaitSendLanding(page, "Add a changelog note while it runs");
  await allowAllWhile(
    page,
    landing.then((turn) => expectSettled(turn)),
  );
  const turn = await landing;
  await expect(
    turn.locator("[data-steerstate='landed']").filter({
      hasText: "Add a changelog note while it runs",
    }),
  ).toHaveCount(1);
});
