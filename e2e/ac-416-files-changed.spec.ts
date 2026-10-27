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
} from "./helpers/stack";

/**
 * Issue #416 — the turn's "edited N files" (the fold's one files entry, which
 * opens Changes) counts the files the turn's write calls actually touched,
 * not just emitted diffs. AC-2 on the
 * real stack (relay + harness + vite dev, engine-fake): the scripted edit
 * turn patches `README.md` (diff) and writes `docs/decisions/0002-notes.md`
 * (no diff — engines that don't inline-diff creates exist, e.g. ACP) —
 * the fold must read "edited 2 files", matching Workbench → Changes.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");

const SHOTS = path.join(repo, "test-results", "ac-416");

/* One tmp git repo the session runs in — the scripted turn edits README.md
   and creates docs/decisions/0002-notes.md. */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-416-"));
const repoDir = path.join(ROOT, "files-repo");
mkdirSync(repoDir, { recursive: true });
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
git(["init", "-b", "trunk"]);
writeFileSync(path.join(repoDir, "README.md"), "# files repo\n");
git(["add", "."]);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac416", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

/* A session in `repoDir`, started the way a person starts one: the new-chat
   draft's folder chip, then Send (the recents get the folder first). The
   send lands on Threads with the thread open beside it. */
async function startSession(page: Page, text: string) {
  await startChatInFolder(
    page,
    stack,
    { id: "default", name: "Hermes" },
    repoDir,
    text,
  );
}

const turns = (page: Page) => page.locator("[data-agentturn]");

test('AC-2 create + edit in one turn → the fold reads "edited 2 files" and is the link to Changes', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await startSession(page, "Add a changelog note to the readme");
  /* A send lands on the thread beside Threads; the session view (chat beside
     the Workbench) opens by widening it. */
  await panelIntoFocus(page);

  const turn = turns(page).last();
  await allowAllWhile(page, expectSettled(turn));

  // patch → README.md (diff), write_file → docs/decisions/0002-notes.md
  // (no diff): the count reads both — one per file the calls touched. It is
  // the fold's one files entry (the footer has none), and opens Changes.
  const link = turn.locator("[data-files-changed]");
  await expect(link).toHaveText("edited 2 files");
  await expect(turn.locator("[data-turnsettled]")).not.toContainText(
    "files changed",
  );
  await link.click();
  await expect(page.getByRole("tab", { name: /Changes/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.screenshot({ path: `${SHOTS}/ac-2-footer.png` });
});
