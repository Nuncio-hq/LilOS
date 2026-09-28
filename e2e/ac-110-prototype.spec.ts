import { execSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/**
 * Issue #110 — the Workbench entry points (Files tree, Changes list, diff
 * rows) plus the Focus session header, on the prototype dev stack. The
 * shared webServer carries LILOS_APP_DIRS (fake Cursor.app/Zed.app in
 * e2e/os-fake), a fake `open` on PATH, and LILOS_OPEN_LOG — every fake
 * binary appends its argv there, so each click is verified against the
 * real host `os.open` running in the dev middleware.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const LOG = path.join(repo, "e2e", ".os-fake", "proto-open.log");
mkdirSync(path.dirname(LOG), { recursive: true });
writeFileSync(LOG, "");

const SHOTS = path.join(repo, "test-results", "ac-110");

/* A real git repo with a committed-and-then-edited file, so the Workbench's
   live fs.tree/git.diff have real rows (and the diff has new-file lines). */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-110-proto-"));
// realpath: /var → /private/var on macOS, and os.open logs the resolved path.
const repoDir = realpathSync(
  mkdirSync(path.join(ROOT, "lilos-wb"), { recursive: true })!,
);
execSync(
  "git init -b trunk && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
  { cwd: repoDir },
);
writeFileSync(path.join(repoDir, "main.swift"), "let a = 1\nlet b = 2\n");
execSync("git add -A && git -c user.email=t@t -c user.name=t commit -m add", {
  cwd: repoDir,
});
appendFileSync(path.join(repoDir, "main.swift"), "let c = 3\nlet d = 4\n");

const logLines = () => readFileSync(LOG, "utf8").split("\n").filter(Boolean);
const menu = (page: Page) =>
  page.locator('[role="menu"], [data-slot="dropdown-menu-content"]').last();

test.afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

test("AC-2/AC-3 workbench: open file, open file at line, reveal — real os.open argv", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/?roots=" + encodeURIComponent(ROOT));
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();
  // Add the fixture repo as the session folder (direct mode → cwd is the
  // real repoDir, not a worktree path that doesn't exist on disk).
  await page.locator('[data-ws="folder"]').click();
  await menu(page).getByText("Add a folder").click();
  const dialog = page.locator("[data-addfolder]");
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-pathinput]").fill(repoDir);
  await expect(dialog.locator("[data-folderinfo]")).toContainText("Git repo", {
    timeout: 15_000,
  });
  await dialog.locator("[data-addbtn]").click();
  await expect(dialog).toHaveCount(0);
  // git repos default to a new workstream — switch to direct so cwd=repoDir.
  await page.locator('[data-ws="branch"]').click();
  await menu(page)
    .getByText(/Edit .* directly/)
    .click();

  const box = page.getByPlaceholder(/New session with Builder/);
  await box.fill("work on main.swift");
  await box.press("Enter");

  // Session header badge → menu (Cursor first = default) → Open in Zed.
  const badge = page.locator("[data-wsbadge]");
  await expect(badge).toContainText("lilos-wb", { timeout: 15_000 });
  // os.editors resolves async — the badge becomes a menu trigger once it has.
  await expect(badge).toHaveRole("button");
  await badge.click();
  await expect(page.locator('[data-openwith="cursor"]')).toBeVisible();
  await page.locator('[data-openwith="zed"]').click();
  await expect
    .poll(() => logLines().join("|"), { timeout: 10_000 })
    .toContain(`arg:${repoDir}`);

  // Focus mode → Workbench on the live folder.
  await page.getByRole("button", { name: "Focus", exact: true }).click();
  // Files tab: the row's open affordance → Reveal in Finder on the file.
  await page.getByRole("tab", { name: "Files" }).click();
  const row = page.getByRole("treeitem", { name: /main\.swift/ });
  await expect(row.first()).toBeVisible({ timeout: 15_000 });
  await row.first().locator("[data-openpath]").click();
  await page.locator('[data-openwith="finder"]').click();
  const target = path.join(repoDir, "main.swift");
  await expect
    .poll(() => logLines().join("|"), { timeout: 10_000 })
    .toContain(`exec:open|arg:-R|arg:${target}`);

  // Changes tab: diff header menu → Open in Cursor; a new-file line number
  // opens at that line (cursor -g file:line, first editor = default).
  await page.getByRole("tab", { name: "Changes" }).click();
  await expect(page.locator("[data-openline]").first()).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-2-workbench.png` });
  await page.locator("[data-openline]").first().click();
  await expect
    .poll(() => logLines().join("|"), { timeout: 10_000 })
    .toMatch(/exec:cursor\|arg:-g\|arg:[^|]*main\.swift:\d+/);
  await page.screenshot({ path: `${SHOTS}/ac-2-line.png` });
});
