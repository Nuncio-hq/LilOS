import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { allowAllWhile, expectSettled } from "./helpers/approvals";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Evidence capture for Group B (#587/#579/#584) — the Workbench/PR PR.
 *
 * Not part of the verify suite: skipped unless `LILOS_EVIDENCE=1` is set.
 * Run locally to regenerate the PR's screenshots:
 *
 *   LILOS_EVIDENCE=1 bunx playwright test e2e/evidence-group-b.spec.ts
 *
 * Output lands in test-results/evidence/group-b/{587,579,584}/ at the
 * 3x2 size/theme matrix, then gets pushed to the `pr-assets` branch.
 */

test.skip(
  process.env.LILOS_EVIDENCE !== "1",
  "evidence capture only — set LILOS_EVIDENCE=1",
);

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const fakeGh = path.join(repo, "packages", "host", "test", "fake-gh");
const OUT = path.join(repo, "test-results", "evidence", "group-b");

const SIZES = [
  { w: 1288, h: 700 },
  { w: 1288, h: 900 },
  { w: 1440, h: 900 },
];
const THEMES = ["light", "dark"] as const;

/* Ship-repo fixture (same shape as ac-107): a clone of a bare remote on
   `trunk`, repo-local identity so the app's own commits get an author that
   is plainly not the employee name — the point of #587 AC-3. */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-evid-b-"));
const remoteDir = path.join(ROOT, "ship-remote.git");
const repoDir = path.join(ROOT, "ship-repo");
const nonremoteDir = path.join(ROOT, "no-remote-repo");
const ghFakeDir = path.join(ROOT, "gh-fake");
const ghLogFile = path.join(ghFakeDir, "gh.log");
for (const d of [nonremoteDir, ghFakeDir]) mkdirSync(d, { recursive: true });

const git = (args: string[], cwd = repoDir) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });
const cfg = ["-c", "user.email=t@t", "-c", "user.name=t"];

git(["init", "--bare", "-b", "trunk", remoteDir], ROOT);
execFileSync("git", ["clone", remoteDir, repoDir], {
  cwd: ROOT,
  encoding: "utf8",
});
writeFileSync(path.join(repoDir, "a.txt"), "one\n");
writeFileSync(path.join(repoDir, "readme.md"), "# widgets\n");
git([...cfg, "add", "."]);
git([...cfg, "commit", "-m", "init: seed the widget repo"]);
git(["push", "-u", "origin", "trunk"]);
git(["remote", "set-head", "origin", "-a"]);
git(["config", "user.email", "e2e@lilos.dev"], repoDir);
git(["config", "user.name", "LilOS e2e"], repoDir);

git(["init", "-b", "trunk"], nonremoteDir);
writeFileSync(path.join(nonremoteDir, "n.txt"), "n\n");
git([...cfg, "add", "."], nonremoteDir);
git([...cfg, "commit", "-m", "init"], nonremoteDir);
git(["config", "user.email", "e2e@lilos.dev"], nonremoteDir);
git(["config", "user.name", "LilOS e2e"], nonremoteDir);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  for (const d of ["587", "579", "584"])
    mkdirSync(path.join(OUT, d), { recursive: true });
  stack = await bootStack("evid-b", await pickPorts(), {
    PATH: `${fakeGh}:${process.env.PATH}`,
    GH_FAKE_DIR: ghFakeDir,
    GH_FAKE_LOG: ghLogFile,
    LILOS_USER_NAME: "Oscar",
  });
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

const FOCUS_URL = /\/dm\/[^/]+\/[^/]+\/focus$/;
const PANEL_URL = /\/dm\/[^/]+\/conv_[^/]+$/;
const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });
const shot = (page: Page, dir: string, name: string) =>
  page.screenshot({ path: path.join(OUT, dir, `${name}.png`) });
const turns = (page: Page) => page.locator("[data-agentturn]");

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
  )
    await dmBtn.first().click();
  else await aside.getByRole("button", { name: /default/i }).click();
  await expect(page).toHaveURL(/\/dm\//);
}

const pickerButton = (page: Page) => page.locator('[data-ws="folder"]');

async function pickSessionFolder(page: Page, dir: string) {
  await pickerButton(page).click();
  const menu = page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last();
  const recent = menu.locator(`[data-wsfolder="${dir}"]`);
  /* Folders arrive async — give the rows a moment before deciding the
     folder isn't listed (a repeat pick must not fall into the Add-folder
     dialog, where the already-attached path stays disabled forever). */
  await expect(menu.locator("[data-wsfolder]").first())
    .toBeVisible({ timeout: 8_000 })
    .catch(() => {});
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
    const addable = await expect(dialog.locator("[data-addbtn]"))
      .toBeEnabled({ timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (addable) {
      await dialog.locator("[data-addbtn]").click();
      await expect(dialog).toHaveCount(0);
    } else {
      /* Already attached — back out and pick the listed row. */
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await pickerButton(page).click();
      await expect(recent.first()).toBeVisible({ timeout: 15_000 });
      await recent.first().click();
    }
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

const sendTurn = async (page: Page, text: string) => {
  /* Quiet window: no streaming, and the session's own turn minted+settled —
     without the second check a send during mint-lag lands as a steer. */
  await expect(turns(page).locator("[data-streaming]")).toHaveCount(0, {
    timeout: 60_000,
  });
  if ((await turns(page).count()) === 0) {
    await expect(turns(page).first()).toBeVisible({ timeout: 60_000 });
  }
  await expectSettled(turns(page).last(), 60_000);
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

/** Workbench open: auto-opens ≥lg once it has content. Post-reload the
   panel is open but its strip stays hidden while the probe round runs —
   wait for a tab before deciding, otherwise a toggle click during probing
   would close an opening panel (the previous flake). */
async function openTab(page: Page, name: RegExp | string) {
  const up = await expect(page.locator("[data-wb-tab]").first())
    .toBeVisible({ timeout: 45_000 })
    .then(() => true)
    .catch(() => false);
  if (!up) {
    await page.getByTitle("Workbench", { exact: true }).click();
    await expect(page.locator("[data-wb-tab]").first()).toBeVisible({
      timeout: 45_000,
    });
  }
  await expect(tab(page, name)).toBeVisible({ timeout: 30_000 });
  await tab(page, name).click();
}

for (const s of SIZES) {
  for (const t of THEMES) {
    const tag = `${s.w}x${s.h}-${t}`;
    /* One test per size/theme: a full scene loop takes ~3 min, so six in a
       single test would blow any sane timeout — and a late flake would lose
       the contexts after it. */
    test(`capture ${tag}`, async ({ browser }) => {
      test.setTimeout(600_000);
      const ctx = await browser.newContext({
        viewport: { width: s.w, height: s.h },
        colorScheme: t,
      });
      const page = await ctx.newPage();
      await page.addInitScript(
        (theme) => localStorage.setItem("lilos-theme", theme),
        t,
      );

      /* ── #587 AC-1: the folder session's tab strip — fixed membership,
         empties greyed but present, nothing rearranging mid-session. ── */
      await dmDefault(page);
      await pickSessionFolder(page, repoDir);
      await send(page, "evidence ship session");
      await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
      /* Unique file per context — the stack (and the repo) is shared
         across tests, so an already-committed name would leave no diff. */
      writeFileSync(
        path.join(repoDir, `notes-${tag}.md`),
        `release notes ${tag}\n`,
      );
      const seedTurn = await sendTurn(page, "Draft the release note");
      await allowAllWhile(page, expectSettled(seedTurn));
      await openTab(page, /Changes/);
      await expect(page.locator(`[data-diff="notes-${tag}.md"]`)).toBeVisible({
        timeout: 30_000,
      });
      // Whole strip present; Subagents/Plan greyed-empty on a quiet engine
      // (Terminal/Preview only exist once a live surface does).
      for (const name of [
        "Changes",
        "Files",
        "PR",
        "Background",
        "Subagents",
        "Plan",
      ])
        await expect(tab(page, name)).toBeVisible();
      await shot(page, "587", `${tag}-tabs-folder`);

      /* ── #587 folded-in: the file view keeps the file NAME visible — the
         breadcrumb truncates the long temp path on the left, not the tail. ── */
      await tab(page, "Files").click();
      await expect(page.getByText("readme.md").last()).toBeVisible({
        timeout: 30_000,
      });
      await page.getByText("readme.md").last().click();
      await expect(page.locator("[data-fileview]")).toContainText("readme.md", {
        timeout: 15_000,
      });
      await shot(page, "587", `${tag}-breadcrumb-tail`);

      /* ── #584 AC-1: Suggest fills the box through a side request — nothing
         lands in the transcript — and survives a reload. ── */
      await tab(page, /Changes/).click();
      await expect(page.locator("[data-shipbar]")).toBeVisible();
      await page.locator("[data-shipsuggest]").click();
      await expect(page.locator("[data-shipmessage]")).toHaveValue(
        /feat: update \S+/,
        { timeout: 60_000 },
      );
      const suggested = await page.locator("[data-shipmessage]").inputValue();
      await page.reload();
      await openTab(page, /Changes/);
      await expect(page.locator("[data-shipmessage]")).toHaveValue(suggested, {
        timeout: 30_000,
      });
      await shot(page, "584", `${tag}-suggest-survives-reload`);

      /* ── #587 AC-3: the Commits section shows the real git author — commit
         the suggestion and the row reads "LilOS e2e", not the employee. ── */
      await page.locator("[data-shipcommit]").click();
      await expect(page.locator(`[data-diff="notes-${tag}.md"]`)).toHaveCount(
        0,
        { timeout: 30_000 },
      );
      await expect(page.getByText("Commits on this branch")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText("LilOS e2e").first()).toBeVisible();
      await shot(page, "587", `${tag}-commit-author`);

      /* ── #579 AC-1: the session has a PR → the header carries a "PR #N"
         chip that opens the PR tab; there is no "Open PR" button. The chip
         reads the live `forge.pr` probe (`gh pr view`) → seed view.json;
         the conversations.prs list seam gets a matching row too. ── */
      writeFileSync(
        path.join(ghFakeDir, "view.json"),
        `${JSON.stringify({
          number: 12,
          title: "Ship the widget release notes",
          body: "notes",
          url: "https://github.com/acme/widgets/pull/12",
          state: "OPEN",
          author: { login: "oscar" },
          baseRefName: "main",
          headRefName: "trunk",
          createdAt: new Date().toISOString(),
          mergedAt: null,
          mergedBy: null,
          mergeCommit: null,
          mergeable: "MERGEABLE",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
          comments: [],
        })}\n`,
      );
      writeFileSync(
        path.join(ghFakeDir, "list-trunk.json"),
        `${JSON.stringify([
          {
            number: 12,
            url: "https://github.com/acme/widgets/pull/12",
            title: "Ship the widget release notes",
            state: "OPEN",
            isDraft: false,
            headRefName: "trunk",
            baseRefName: "main",
            createdAt: new Date().toISOString(),
            statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
          },
        ])}\n`,
      );
      const nudge = await sendTurn(page, "Add a changelog note");
      await allowAllWhile(page, expectSettled(nudge));
      await expect(page.locator("[data-prchip]")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator("[data-prchip]")).toContainText("#12");
      await expect(page.getByRole("button", { name: /open pr/i })).toHaveCount(
        0,
      );
      await shot(page, "579", `${tag}-pr-chip`);

      /* ── #579 AC-2: an error names a step Oscar can take — a push with no
         remote reads "This folder isn't on GitHub yet. Ask Default to
         publish it.", never a command to type. ── */
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
      await page
        .locator("aside")
        .getByRole("button", { name: /default/i })
        .click();
      await pickSessionFolder(page, nonremoteDir);
      await send(page, "no remote evidence");
      await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
      await openTab(page, /Changes/);
      writeFileSync(path.join(nonremoteDir, `n2-${tag}.txt`), "more\n");
      const nrTurn = await sendTurn(page, "Add a note");
      await allowAllWhile(page, expectSettled(nrTurn));
      await expect(page.locator("[data-shipbar]")).toBeVisible({
        timeout: 30_000,
      });
      await page.locator("[data-shipmessage]").fill("local only");
      await page.locator("[data-shipcommit]").click();
      await page.locator("[data-shippush]").click();
      await expect(page.locator("[data-shiperror]")).toContainText(
        /isn't on GitHub yet\. Ask .* to publish it/i,
        { timeout: 30_000 },
      );
      await shot(page, "579", `${tag}-error-asks-employee`);

      /* ── #587 AC-1 (folderless): a just-chat session still gets the
         Workbench — only the engine tabs render, all greyed-empty. ── */
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
      await page
        .locator("aside")
        .getByRole("button", { name: /default/i })
        .click();
      await pickerButton(page).click();
      await page
        .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
        .last()
        .getByText("No folder · just chat")
        .click();
      await send(page, "just chat evidence");
      await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
      await expect(page.getByTitle("Workbench", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      const stripUp = await expect(tab(page, "Background"))
        .toBeVisible({ timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (!stripUp) {
        await page.getByTitle("Workbench", { exact: true }).click();
      }
      await expect(tab(page, "Background")).toBeVisible({ timeout: 30_000 });
      await expect(tab(page, "Subagents")).toBeVisible();
      await expect(tab(page, "Plan")).toBeVisible();
      await expect(
        tab(page, /^(Changes|Files|Terminal|Preview|PR)$/),
      ).toHaveCount(0);
      await shot(page, "587", `${tag}-tabs-folderless`);

      await ctx.close();
      console.log(`captured ${tag}`);
    });
  }
}
