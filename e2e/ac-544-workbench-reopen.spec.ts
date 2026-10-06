import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #544 — the Workbench reopens instantly: closing the panel (or
 * leaving Focus and coming back) shows the last-known Files/Changes/PR on
 * the first frame from a per-folder cache (key host+cwd, bounded) while a
 * fresh round revalidates behind; reads land independently so a slow `gh`
 * never gates the folder tabs; an open file view + selection survive the
 * close/reopen. Assertions that prove "first frame" are one-shot `.count()`
 * reads right after the reopen click — a cached mount already has rows in
 * the DOM before any fresh read could possibly land.
 * #547 adds: the picked tab surviving a Focus remount (AC-1), per-tab
 * scroll offsets restored on reopen (AC-2), and the <50 ms first-row
 * budget on a ≥2,000-file repo (AC-5, windowed first frame).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const fakeGh = path.join(repo, "packages", "host", "test", "fake-gh");

const SHOTS = path.join(repo, "test-results", "ac-544");
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-544-"));
const repoDir = path.join(ROOT, "lilos-repo");
const ghFakeDir = path.join(ROOT, "gh-fake");
const viewPath = path.join(ghFakeDir, "view.json");
mkdirSync(repoDir, { recursive: true });
mkdirSync(ghFakeDir, { recursive: true });
const git = (args: string[], cwd = repoDir) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });
git(["init", "-b", "trunk"]);
writeFileSync(path.join(repoDir, "a.txt"), "alpha\n");
writeFileSync(path.join(repoDir, "b.txt"), "bravo\n");
mkdirSync(path.join(repoDir, "src"), { recursive: true });
writeFileSync(path.join(repoDir, "src", "deep.txt"), "deep\n");
git(["add", "."]);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
/* An uncommitted change so Changes has a row to reselect. */
writeFileSync(path.join(repoDir, "a.txt"), "alpha\nchanged\n");

/* #547 AC-5: a large repo — ≥ 2,000 tracked files so the Files tree's
   mount cost dominates the reopen measurement (LilOS itself measured
   114 ms before the windowed first frame). */
const bigDir = path.join(ROOT, "big-repo");
mkdirSync(bigDir, { recursive: true });
const gitBig = (args: string[]) =>
  execFileSync("git", args, { cwd: bigDir, encoding: "utf8" });
gitBig(["init", "-b", "trunk"]);
/* Flat on purpose: dirs without changed files start collapsed, so nested
   files would never mount as rows and the window would go unexercised. */
for (let f = 0; f < 2400; f++)
  writeFileSync(path.join(bigDir, `f${String(f).padStart(4, "0")}.txt`), "x\n");
gitBig(["add", "."]);
gitBig(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
const BIG_ROWS = 2400;

/* `gh pr view --json` fixture — one OPEN PR so the PR tab exists. */
writeFileSync(
  viewPath,
  `${JSON.stringify(
    {
      number: 9,
      title: "Cache the workbench",
      body: "Stale-while-revalidate.",
      url: "https://github.com/acme/widgets/pull/9",
      state: "OPEN",
      author: { login: "builder" },
      baseRefName: "trunk",
      headRefName: "feat/cache",
      createdAt: "2026-09-20T10:00:00Z",
      mergedAt: null,
      mergedBy: null,
      mergeCommit: null,
      mergeable: "MERGEABLE",
      statusCheckRollup: [],
      comments: [],
    },
    null,
    2,
  )}\n`,
);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac544", await pickPorts(), {
    PATH: `${fakeGh}:${process.env.PATH}`,
    GH_FAKE_DIR: ghFakeDir,
  });
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});
test.describe.configure({ mode: "serial" });

const FOCUS_URL = /\/dm\/[^/]+\/[^/]+\/focus$/;
const PANEL_URL = /\/dm\/[^/]+\/conv_[^/]+$/;

async function dmDefault(page: Page, roots = ROOT) {
  await page.goto(`${stack.webUrl}/?roots=${roots}`);
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

async function pickSessionFolder(page: Page, dir: string) {
  const menu = await (async () => {
    await pickerButton(page).click();
    return page
      .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
      .last();
  })();
  /* Recents populate async — `folders.list` plus a per-folder host probe —
     so a one-shot check can miss a row that lands right after; the dialog
     path then dead-ends because an already-attached folder's Add button
     stays disabled forever (#606). Wait for any recent row first: `folders`
     sets all rows in one atom write, so the first row means the list has
     settled. An empty list (first-ever pick) just costs the timeout. */
  await expect(menu.locator("[data-wsfolder]").first())
    .toBeVisible({
      timeout: 15_000,
    })
    .catch(() => {});
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

const workbenchToggle = (page: Page) =>
  page.getByTitle("Workbench", { exact: true });
const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });
const rows = (page: Page) => page.getByRole("treeitem");

/* Reopen path: close the panel on its toggle, click it back, and assert
   first-frame rows with a ONE-SHOT count (no polling) — a cold probe could
   not have produced them yet. Returns the measured reopen→rows ms. */
async function reopenTimed(page: Page) {
  await workbenchToggle(page).click();
  /* #547 AC-5: the panel hides (display:none) rather than unmounting —
     "closed" = the shell hidden; its rows stay in the DOM. */
  await expect(page.locator("[data-wb-shell]")).toBeHidden();
  /* Reopen + measure in-page: t0 = the click itself, t1 = first treeitem
     in the DOM — the number AC-6 compares before/after (target <50ms).
     `first` = rows present with NO "Reading" hold frame in between — the
     remount's first painted state already had rows (the cache painted).
     A cold probe renders the hold for many frames first → first=0. */
  const { first, ms } = await page.evaluate(
    () =>
      new Promise<{ first: number; ms: number }>((res) => {
        const t0 = performance.now();
        (document.querySelector('[title="Workbench"]') as HTMLElement)?.click();
        let sawHold = false;
        const tick = () => {
          if (document.querySelector("[data-wb-probing]")) sawHold = true;
          /* Rows stay mounted while the panel is hidden (#547 keep-mounted
             reopen) — count them only once the shell is actually shown. */
          const shell = document.querySelector("[data-wb-shell]");
          const vis = shell
            ? getComputedStyle(shell).display !== "none"
            : false;
          const n = vis
            ? document.querySelectorAll('[role="treeitem"]').length
            : 0;
          if (n > 0)
            return res({
              first: sawHold ? 0 : n,
              ms: performance.now() - t0,
            });
          if (performance.now() - t0 > 10_000) return res({ first: 0, ms: -1 });
          requestAnimationFrame(tick);
        };
        tick();
      }),
  );
  return { n: first, ms };
}

test("AC-1/2/4: reopen shows last-known rows on the first frame, no Reading hold, open file + tab survive", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  await dmDefault(page);
  await pickSessionFolder(page, repoDir);
  await send(page, "check the folder");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });

  // The panel auto-opens on a folder session at ≥lg — Files tab + rows.
  await expect(tab(page, "Files")).toBeVisible({ timeout: 30_000 });
  await tab(page, "Files").click();
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  // AC-2: the PR tab lands off the same session's forge.pr, in its own time.
  await expect(tab(page, /^PR/)).toBeVisible({ timeout: 30_000 });

  /* Reopen #1 — last-known rows on the FIRST frame: treeitems already in
     the DOM one frame after the remount click (one-shot count), no
     "Reading" hold anywhere. */
  const { n, ms } = await reopenTimed(page);
  console.log(`[ac-544] fixture reopen → first-frame rows=${n} in ${ms}ms`);
  expect(n).toBeGreaterThan(0);
  expect(page.locator("[data-wb-probing]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-1-reopen-first-frame.png` });

  /* The revalidate behind it settles into the same rows — the "updating…"
     cue has already come and gone by the next assert. */
  await expect(tab(page, "Files")).toBeVisible({ timeout: 30_000 });

  // Open a file view on a committed file (a changed one routes to the
  // diff instead) — AC-4's state to survive the close.
  await rows(page).filter({ hasText: "b.txt" }).first().click();
  await expect(page.locator("[data-fileview]")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("[data-fileview]")).toContainText("bravo");

  /* Reopen #2 — the open file view comes back on its cached content on the
     first frame (the tree is replaced by the editor, so no row count). */
  await workbenchToggle(page).click();
  await expect(page.locator("[data-wb-shell]")).toBeHidden();
  await workbenchToggle(page).click();
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => r(null))),
  );
  expect(await page.locator("[data-fileview]").count()).toBe(1);
  await expect(page.locator("[data-fileview]")).toContainText("bravo");
  expect(page.locator("[data-wb-probing]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-4-fileview-survives.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: `${SHOTS}/ac-4-fileview-dark.png` });
  await page.emulateMedia({ colorScheme: "light" });

  /* Esc out of Focus and back — the remount shows cached data too, and
     #547 AC-1: the picked tab (Files) survives the Focus remount, not
     only a panel toggle. */
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await page
    .locator("[data-thread-panel]")
    .getByTitle("Focus", { exact: true })
    .click();
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  expect(page.locator("[data-wb-probing]")).toHaveCount(0);
  await expect(tab(page, "Files")).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: `${SHOTS}/ac-1-refocus.png` });
});

test("AC-5/AC-2 on a 2,400-file repo: reopen → first row in the first frame under 50 ms, scroll offset restored", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  await dmDefault(page);
  await pickSessionFolder(page, bigDir);
  await send(page, "check the folder");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  await expect(tab(page, "Files")).toBeVisible({ timeout: 30_000 });
  await tab(page, "Files").click();
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  /* The windowed first frame grows to the full tree over the next
     frames — all 2,440 rows must land, none lost to the window. */
  await expect(rows(page)).toHaveCount(BIG_ROWS, { timeout: 60_000 });

  /* AC-2: park the Files list at a scrolled position so the reopen has
     an offset to restore. */
  const vp = page.locator(
    '[data-wb-scroll="files"] [data-slot="scroll-area-viewport"]',
  );
  await expect(vp).toHaveCount(1);
  await vp.evaluate((el) => {
    el.scrollTop = 600;
    el.dispatchEvent(new Event("scroll"));
  });

  /* AC-5: three reopens — the number AC-5 budgets is the best
     reopen→first-row time; every run also proves rows render in the
     first frame (`n` counts them with no Reading hold in between). */
  const msLog: number[] = [];
  for (let i = 0; i < 3; i++) {
    const { n, ms } = await reopenTimed(page);
    msLog.push(ms);
    expect(n).toBeGreaterThan(0);
    expect(page.locator("[data-wb-probing]")).toHaveCount(0);
  }
  console.log(
    `[ac-544] big-repo reopen → first-frame rows, ms=[${msLog.join(",")}]`,
  );
  expect(Math.min(...msLog)).toBeLessThan(50);
  /* AC-2: the scroll offset survived the close/reopen — the restored
     viewport is where it was left (rows keep mounting under it). */
  const st = await vp.evaluate((el) => el.scrollTop);
  expect(Math.abs(600 - st)).toBeLessThanOrEqual(8);
  await page.screenshot({ path: `${SHOTS}/ac-5-big-repo-reopen.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: `${SHOTS}/ac-5-big-repo-dark.png` });
  await page.emulateMedia({ colorScheme: "light" });
});

test("AC-6 on LilOS itself: Workbench reopen → Files visible, measured", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  await dmDefault(page, path.dirname(repo));
  await pickSessionFolder(page, repo);
  await send(page, "check the folder");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  await expect(tab(page, "Files")).toBeVisible({ timeout: 30_000 });
  await tab(page, "Files").click();
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });

  const { n, ms } = await reopenTimed(page);
  console.log(`[ac-544] lilos reopen → first-frame rows=${n} in ${ms}ms`);
  expect(n).toBeGreaterThan(0);
  expect(page.locator("[data-wb-probing]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-6-lilos-reopen.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: `${SHOTS}/ac-6-lilos-reopen-dark.png` });
  await page.emulateMedia({ colorScheme: "light" });
});

/* #606: the AC-6 flake was a tab-follow race, not an empty probe — the
   Files pick landed while the turn's first `live` row was still in the
   feed, the late row re-armed "follow", and the streaming steps stole the
   tab (lastStep `terminal` → the changes fallback). `slowstart:` holds
   `turn.started` so the pick reliably lands first — the same window a
   loaded CI runner opens. */
test("AC-6 #606 pick-hold: a Files pick while the turn starts survives its first live row", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  await dmDefault(page, path.dirname(repo));
  await pickSessionFolder(page, repo);
  await send(page, "slowstart:5000 check the folder");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  await expect(tab(page, "Files")).toBeVisible({ timeout: 30_000 });
  await tab(page, "Files").click();
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  /* The turn's live row + steps land ~5 s in — long after the pick. The
     reply text ("Short answer") marks turn end; the pick must still hold. */
  await expect(page.getByText("Short answer").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(tab(page, "Files")).toHaveAttribute("aria-selected", "true");
  await expect(rows(page).first()).toBeVisible();
});
