import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/* Issue #37: the Workbench PR tab reads the conversation's PR through the host
   forge (`forge.*` → packages/host → `gh`) — no engine in the data path (the
   prototype's fake engine has no forge capability). `gh` here is the stateful
   fake (packages/host/test/fake-gh) the webServer puts on PATH; it serves and
   mutates e2e/.gh-fake/view.json, so comment/merge round-trips re-read the
   post-action truth exactly like real gh. Every invocation lands in
   .gh-fake/gh.log, which AC-4 asserts. */

const fakeDir = join(dirname(fileURLToPath(import.meta.url)), ".gh-fake");
const viewPath = join(fakeDir, "view.json");
const logFile = join(fakeDir, "gh.log");

/* `gh pr view --json` shape; all checks green so the merge control is armed. */
const PR_VIEW = {
  number: 7,
  title: "Add the forge tab",
  body: "## Summary\n\nWire the Workbench PR tab to the host forge.\n\n## Acceptance\n\n- checks + comments visible\n- merge asks which base",
  url: "https://github.com/acme/widgets/pull/7",
  state: "OPEN",
  author: { login: "builder" },
  baseRefName: "main",
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
    {
      __typename: "CheckRun",
      name: "lint",
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

let scanRoot = "";
let repo = "";
let repoReal = "";

test.beforeAll(() => {
  // Isolated parent dir: discovery + the picker list the repo's parent, so the
  // test must not depend on how crowded the machine's shared tmp dir is.
  scanRoot = mkdtempSync(join(tmpdir(), "lilos-forge-root-"));
  repo = join(scanRoot, "lilos-forge-e2e-repo");
  mkdirSync(repo);
  repoReal = realpathSync(repo);
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "e2e@lilos.dev"]);
  git(["config", "user.name", "e2e"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  // Reset the fake forge: OPEN PR, empty invocation log.
  // (trailing newline keeps the generated fixture biome-clean)
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(viewPath, `${JSON.stringify(PR_VIEW, null, 2)}\n`);
  rmSync(logFile, { force: true });
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

const ghLog = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");

test("AC-1..4 PR tab over the host forge (fake gh)", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  await page.goto(`/?roots=${encodeURIComponent(dirname(repoReal))}`);
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();

  // Pick the temp repo for the session, editing main directly (ws.cwd = repo).
  await page.locator("[data-ws='folder']").click();
  await page.getByText("Add a folder…").click();
  await expect(
    page.locator(`[data-discovered$="/${basename(repoReal)}"]`),
  ).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-pathinput]").fill(`${dirname(repoReal)}/`);
  const row = page.locator(`[data-fsrow="${basename(repoReal)}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.locator("[data-folderinfo]")).toContainText("Git repo");
  await page.locator("[data-addbtn]").click();
  // The "projects.create" toast and the composer hint span overlap the branch
  // pick's hit-test point — dispatch the click straight onto the trigger.
  await page.locator("[data-ws='branch']").dispatchEvent("click");
  await page.getByText(/Edit\s+main\s+directly/).click();

  const box = page.getByPlaceholder(/New session with Builder/);
  await box.fill("check in");
  await box.press("Enter");
  await page.getByRole("button", { name: "Focus" }).click({ timeout: 15_000 });

  // ── AC-1: the PR tab is the forge's PR: title, checks, comments ──
  await page.getByRole("tab", { name: /PR #7/ }).click({ timeout: 30_000 });
  const panel = page.locator("[data-pr='7']");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Add the forge tab");
  await expect(panel).toContainText("acme/widgets");
  await expect(panel).toContainText("feat/forge");
  await panel.locator("[data-prtab='checks']").click();
  await expect(panel).toContainText("typecheck");
  await expect(panel).toContainText("netlify");
  await panel.locator("[data-prtab='discussion']").click();
  await expect(panel).toContainText("Nice split. One nit on the merge copy.");

  // ── AC-2: a comment posts through `gh` and shows on the PR ──
  await panel.getByPlaceholder(/Add a comment/).fill("LGTM from e2e");
  await panel.locator("form button[type='submit']").click();
  // The comment is a <p> in the discussion list; the textarea holds the draft
  // until the forge round-trip resolves, so assert on the paragraph itself.
  await expect(
    panel.locator("p").filter({ hasText: "LGTM from e2e" }),
  ).toBeVisible({ timeout: 15_000 });
  expect(ghLog()).toContain("pr comment 7");
  expect(ghLog()).toContain("LGTM from e2e");

  // ── AC-3: merge asks to confirm the base branch + method, then reports the
  // re-read result (the fake flips view.json to MERGED). ──
  await page.getByRole("button", { name: /Squash and merge/ }).click();
  const confirm = page.locator("[data-mergeconfirm]");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("into");
  await expect(confirm.locator(".font-mono.font-medium")).toHaveText("main");
  await confirm.getByRole("button", { name: "Confirm merge" }).click();
  await expect(panel).toContainText("Merged", { timeout: 15_000 });
  expect(ghLog()).toContain("pr merge 7 --squash");
  // The panel re-read the PR: merged pill came from forge.pr, not the click.
  const view = JSON.parse(readFileSync(viewPath, "utf8")) as {
    state: string;
  };
  expect(view.state).toBe("MERGED");

  // ── AC-4: every PR op above was a `gh` invocation via the host API — the
  // fake engine running this session has no forge capability at all. ──
  expect(ghLog()).toContain("pr view");
  expect(errors).toEqual([]);
});
