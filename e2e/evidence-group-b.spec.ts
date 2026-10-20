import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { allowAllWhile, expectSettled } from "./helpers/approvals";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
  startChatInFolder,
  startFolderlessChat,
  threadUrl,
} from "./helpers/stack";

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

/* The seeded employee. An id that names nobody opens the new-chat draft on
   the default agent, so the spec needs no employee lookup. Sessions start the
   way a person starts one: the draft's Folder chip (the app's recents, which
   `startChatInFolder` seeds over the relay — the old `?roots=` scan fed the
   DM-home picker's discovered list, which no longer exists), then Send. */
const DEFAULT_AGENT = { id: "default", name: "Default" };

const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });
const shot = (page: Page, dir: string, name: string) =>
  page.screenshot({ path: path.join(OUT, dir, `${name}.png`) });
const turns = (page: Page) => page.locator("[data-agentturn]");

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
      await startChatInFolder(
        page,
        stack,
        DEFAULT_AGENT,
        repoDir,
        "evidence ship session",
      );
      /* A send lands on the thread beside Threads; widening it is the
         session view (chat beside the Workbench). */
      await panelIntoFocus(page);
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
      await startChatInFolder(
        page,
        stack,
        DEFAULT_AGENT,
        nonremoteDir,
        "no remote evidence",
      );
      await panelIntoFocus(page);
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
      /* No folder is a draft choice no more — a just-chat session starts
         over the relay, and is opened as the session view. */
      const chatConv = await startFolderlessChat(
        page,
        stack,
        "just chat evidence",
      );
      await page.goto(threadUrl(stack.webUrl, chatConv));
      await panelIntoFocus(page);
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
