import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

/* Issue #11: the composer's folder picker + Workbench Files/Changes read a real
   git repo through the host API (POST /api/host → packages/host) — no engine
   involved (the prototype's fake engine has no fs capability). The fixture is a
   temp git repo: one commit, then a modified file and an untracked file. */

let scanRoot = "";
let repo = "";
let repoReal = "";

test.beforeAll(() => {
  // Isolated parent dir: discovery and the picker list the repo's parent, so
  // the result must not depend on what else lives in the machine's shared tmp
  // dir (discovery and listings are capped).
  scanRoot = mkdtempSync(join(tmpdir(), "lilos-e2e-root-"));
  repo = join(scanRoot, "lilos-e2e-repo");
  mkdirSync(repo);
  repoReal = realpathSync(repo); // git canonicalizes /var → /private/var on macOS
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "e2e@lilos.dev"]);
  git(["config", "user.name", "e2e"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "app.ts"), "export const x = 1\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n"); // modified
  writeFileSync(join(repo, "notes.md"), "# scratch\n"); // untracked
});
test.afterAll(() => rmSync(scanRoot, { recursive: true, force: true }));

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test("AC-1..4 picker + session cwd + Workbench Files/Changes over host API", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  // ?roots= points git.discoverRepos at the temp dir's parent.
  await page.goto(`/?roots=${encodeURIComponent(dirname(repoReal))}`);
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();

  // ── AC-1: folder picker lists real dirs + marks repos ──
  await page.locator("[data-ws='folder']").click();
  await page.getByText("Add a folder…").click();
  // "Found on this Mac" = git.discoverRepos result (paths may come back
  // `~`-collapsed, so match the row by its basename).
  await expect(
    page.locator(`[data-discovered$="/${basename(repoReal)}"]`),
  ).toBeVisible({ timeout: 15_000 });
  // Type the repo's parent: fs.list lazy-loads each hop (the parent, then the
  // dir itself) and the repo row carries a git mark.
  await page.locator("[data-pathinput]").fill(`${dirname(repoReal)}/`);
  const row = page.locator(`[data-fsrow="${basename(repoReal)}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.locator("svg").first()).toBeVisible();
  await row.click();
  await expect(page.locator("[data-folderinfo]")).toContainText("Git repo");
  await expect(page.locator("[data-folderinfo]")).toContainText("main");
  await page.locator("[data-addbtn]").click();

  // The new folder is picked for this DM; switch it to direct mode (edit in place).
  await page.locator("[data-ws='branch']").click();
  await page.getByText(/Edit\s+main\s+directly/).click();

  // Send → the session's cwd is the picked folder; the turn's first step is `pwd`.
  const box = page.getByPlaceholder(/New session with Builder/);
  await box.fill("check in");
  await box.press("Enter");
  await page.getByRole("button", { name: "Focus" }).click({ timeout: 15_000 });

  // ── AC-1 cont.: Terminal shows `$ pwd` → the picked folder ──
  await page.getByRole("tab", { name: /Terminal/ }).click();
  const termOut = page.locator("pre.whitespace-pre-wrap").first();
  await expect(termOut).toContainText("$ pwd", { timeout: 30_000 });
  await expect(termOut).toContainText(repoReal);

  // ── AC-2: Files tab shows the real tree + file contents ──
  await page.getByRole("tab", { name: /Files/ }).click();
  await expect(page.getByText("a.txt", { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.getByText("src", { exact: true }).first().click();
  await expect(page.getByText("app.ts", { exact: true }).first()).toBeVisible();
  // unchanged file → opens its contents; changed files open their diff instead
  await page.getByText("app.ts", { exact: true }).first().click();
  await expect(page.locator("[data-fileview]")).toContainText(
    "export const x = 1",
  );
  await page.getByRole("button", { name: "← Files" }).click();

  // ── AC-3: Changes tab = working-tree diff (stat + patch) ──
  await page.getByRole("tab", { name: /Changes/ }).click();
  await expect(page.getByText("2 files changed", { exact: true })).toBeVisible();
  const mod = page.locator("[data-diff='a.txt']");
  await expect(mod).toBeVisible();
  await expect(mod).toContainText("+1");
  await expect(mod).toContainText("+two");
  const added = page.locator("[data-diff='notes.md']");
  await expect(added).toBeVisible();
  await expect(added).toContainText("+# scratch");

  // ── AC-4: whole flow ran on the fake engine (no fs capability) ──
  // covered implicitly: this session's steps are the canned fake-engine script;
  // the Files/Changes data above came from /api/host, not from any engine call.
  expect(errors).toEqual([]);
});
