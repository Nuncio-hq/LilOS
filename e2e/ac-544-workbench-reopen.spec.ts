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
  await expect(rows(page).first()).toHaveCount(0);
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
          const n = document.querySelectorAll('[role="treeitem"]').length;
          if (n > 0)
            return res({ first: sawHold ? 0 : n, ms: performance.now() - t0 });
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
  await expect(tab(page, "Files")).toHaveCount(0);
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

  /* Esc out of Focus and back — the remount shows cached data too. */
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await page
    .locator("[data-thread-panel]")
    .getByTitle("Focus", { exact: true })
    .click();
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  expect(page.locator("[data-wb-probing]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-1-refocus.png` });
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
