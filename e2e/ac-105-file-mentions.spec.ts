import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { expectSettled } from "./helpers/approvals";
import {
  bootStack,
  pickPorts,
  relayRpc,
  type Stack,
  skipFirstRun,
  startChat,
  startChatInFolder,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #105 — `@`-mention files and folders in the thread composer, end to
 * end on the real stack (relay + harness + vite dev, engine-fake). The
 * fixture repo is real git on disk: tracked + untracked + gitignored files,
 * and enough files to prove the 20-row cap. engine-fake echoes the prompt's
 * follow-up text, which is the AC-4 proof that the engine got `@path` as
 * plain text.
 *
 * v3: the first message is written in the new-chat draft beside Threads,
 * whose `@` menu (People, then the Files of the folder its Folder chip picks)
 * is the old home composer's; later messages go through the thread's
 * composer in the peek, whose file search runs over that same session folder.
 * The legs that need a settled thread start a chat in the fixture repo first.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");

const SHOTS = path.join(repo, "test-results", "ac-105");

/* Real fixture repo: tracked + untracked + gitignored + a dir of generated
   files so an empty query exceeds the 20-row cap. */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-105-"));
const repoDir = path.join(ROOT, "lilos-105-repo");
mkdirSync(path.join(repoDir, "src", "util"), { recursive: true });
mkdirSync(path.join(repoDir, "src", "gen"), { recursive: true });
mkdirSync(path.join(repoDir, "docs"), { recursive: true });
mkdirSync(path.join(repoDir, "logs"), { recursive: true });
writeFileSync(path.join(repoDir, ".gitignore"), "secret.env\nlogs/\n");
writeFileSync(path.join(repoDir, "README.md"), "# repo\n");
writeFileSync(path.join(repoDir, "src", "app.tsx"), "export {}\n");
writeFileSync(path.join(repoDir, "src", "util", "deep.ts"), "export {}\n");
writeFileSync(path.join(repoDir, "docs", "guide.md"), "# guide\n");
for (let i = 0; i < 25; i++) {
  writeFileSync(
    path.join(repoDir, "src", "gen", `gen${String(i).padStart(2, "0")}.ts`),
    "export {}\n",
  );
}
execSync(
  "git init -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -m init",
  { cwd: repoDir },
);
// Dirty state on top of the commit: untracked + ignored files.
writeFileSync(path.join(repoDir, "untracked.ts"), "export {}\n");
writeFileSync(path.join(repoDir, "secret.env"), "TOKEN=x\n");
writeFileSync(path.join(repoDir, "logs", "debug.log"), "log\n");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac105", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });
/* Every leg starts a chat and waits out its first turn before it can type an
   `@` — setup the old DM-home flow did not have. */
test.setTimeout(120_000);

const DEFAULT_AGENT = { id: "default", name: "Default" };

const panel = (page: Page) => v3Peek(page).locator("[data-thread-panel]");
/** The thread's reply box — the composer that takes `@`. */
const replyBox = (page: Page) => panel(page).locator("textarea");
const menu = (page: Page) => page.getByRole("listbox");
const fileRows = (page: Page) => page.locator("[data-mention-file]");

/** The panel is up and its first turn settled, so a reply is a plain
    follow-up and the composer is the idle one. */
async function settled(page: Page) {
  await expect(replyBox(page)).toBeVisible({ timeout: 30_000 });
  await expect(panel(page).locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 60_000,
  });
}

/** The new-chat draft's box, and its `@` menu rows. */
const draftBox = (page: Page) =>
  v3Peek(page).getByPlaceholder(`Message ${DEFAULT_AGENT.name}…`);

/** The draft with Default open, its Folder chip on the fixture repo (which
    joins the app's recents over the relay first; the page reloads, the app
    reads them at mount). */
async function openDraftInRepo(page: Page) {
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  await relayRpc(page, stack, "folders.add", { path: repoDir });
  await page.goto(
    `${stack.webUrl}/#?page=threads&open=newchat:${DEFAULT_AGENT.id}`,
  );
  await page.reload();
  const chip = v3Peek(page).getByTitle(/^Folder · /);
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  await v3Peek(page)
    .getByRole("menuitemradio", { name: new RegExp(path.basename(repoDir)) })
    .click();
  await expect(chip).toContainText(path.basename(repoDir), { timeout: 15_000 });
  await expect(draftBox(page)).toBeVisible();
}

/** A chat with Default working in the fixture repo (the draft's Folder
    chip), settled. */
async function chatInRepo(page: Page, text = "open a thread") {
  await startChatInFolder(page, stack, DEFAULT_AGENT, repoDir, text);
  await settled(page);
}

/** Employees sit above the Files section; ↓ walks the flat list (wraps). */
async function arrowDownTo(
  box: ReturnType<Page["locator"]>,
  row: ReturnType<Page["locator"]>,
) {
  for (let i = 0; i < 10; i++) {
    if ((await row.getAttribute("aria-selected")) === "true") return;
    await box.press("ArrowDown");
  }
  await expect(row).toHaveAttribute("aria-selected", "true");
}

/** File hits land asynchronously per keystroke and each applied result
    resets the menu's active row — Enter must wait for the response to the
    FINAL query's `fs.search`, not just for a row to be visible (a stale
    earlier query's hits can satisfy a visible/count check, then the final
    response resets the selection before Enter, picking row 0 → "@Default").
    Arm before typing; the predicate filters by wire params. Resolves once
    the response is in AND the hits have been painted (React applies them
    within a frame), so the selection is settled when it returns. */
function waitForFileSearch(page: Page, query: string) {
  return page
    .waitForResponse((r) => {
      if (!r.url().endsWith("/host")) return false;
      try {
        const m = JSON.parse(r.request().postData() ?? "{}") as {
          method?: string;
          params?: { query?: string };
        };
        return m.method === "fs.search" && m.params?.query === query;
      } catch {
        return false; // OPTIONS preflight carries no JSON body
      }
    })
    .then(() =>
      page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      ),
    );
}

test("AC-2 with no folder picked the @ menu has an Employees section only (D-#19)", async ({
  page,
}) => {
  /* A company with no recent folders: the draft shows no Folder chip, so the
     chat has no session folder — and no Files section to search. This runs
     first, before any test adds the fixture repo to the recents. */
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:default`);
  await expect(v3Peek(page).getByPlaceholder("Message Default…")).toBeVisible({
    timeout: 30_000,
  });
  await expect(v3Peek(page).getByTitle(/^Folder · /)).toHaveCount(0);
  await startChat(page, stack.webUrl, DEFAULT_AGENT, "open a thread");
  await settled(page);
  const mention = replyBox(page);
  await mention.click();
  await mention.pressSequentially("@");
  await expect(menu(page)).toBeVisible();
  await expect(
    page.locator('[data-mention-section="employees"]'),
  ).toBeVisible();
  await expect(page.locator('[data-mention-section="files"]')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-2-no-folder.png` });
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
});

test("AC-1 @ opens one menu: Employees then Files, fuzzy match, cap 20, arrows + Enter pick, Esc closes", async ({
  page,
}) => {
  await chatInRepo(page);
  const box = replyBox(page);

  await box.click();
  await box.pressSequentially("@");
  await expect(menu(page)).toBeVisible();
  await expect(
    page.locator('[data-mention-section="employees"]'),
  ).toBeVisible();
  const files = page.locator('[data-mention-section="files"]');
  await expect(files).toBeVisible({ timeout: 15_000 });
  // Cap: the fixture has >20 candidates on an empty query; the section shows 20.
  await expect(fileRows(page)).toHaveCount(20, { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-1-menu-sections.png` });

  // Fuzzy match narrows it; dirs are marked with a trailing slash.
  const appHits = waitForFileSearch(page, "app");
  await box.pressSequentially("app");
  await appHits;
  const appRow = page.locator('[data-mention-file="src/app.tsx"]');
  await expect(appRow).toBeVisible({ timeout: 15_000 });
  await expect(fileRows(page)).toHaveCount(1);

  // Arrow keys move the highlight across both sections; Enter inserts the
  // token as text instead of submitting.
  await arrowDownTo(box, appRow);
  await box.press("Enter");
  await expect(box).toHaveValue("@src/app.tsx ");
  await expect(menu(page)).toHaveCount(0);

  // Reopen and Esc closes it.
  await box.pressSequentially("@ap");
  await expect(menu(page)).toBeVisible();
  await box.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(box).toHaveValue("@src/app.tsx @ap");
});

test("AC-2 files come from the session folder: gitignored out, untracked in, folders marked", async ({
  page,
}) => {
  await chatInRepo(page);
  const box = replyBox(page);
  await box.click();
  await box.pressSequentially("@sec");
  await expect(menu(page)).toBeVisible();
  await expect(page.locator('[data-mention-file="secret.env"]')).toHaveCount(0);
  await expect(
    page.locator('[data-mention-section="files"]').getByText("No matches"),
  ).toBeVisible();
  await box.fill("@untrack");
  await expect(page.locator('[data-mention-file="untracked.ts"]')).toBeVisible({
    timeout: 15_000,
  });
  await box.fill("@sr");
  const dirRow = page.locator('[data-mention-file="src"][data-kind="dir"]');
  await expect(dirRow).toBeVisible({ timeout: 15_000 });
  await expect(dirRow).toContainText("src/");
  await page.screenshot({ path: `${SHOTS}/ac-2-files.png` });
});

test("AC-1 + AC-3 the first message takes @: People then Files of the picked folder, a chip, and it is sent as text", async ({
  page,
}) => {
  await openDraftInRepo(page);
  const box = draftBox(page);
  await box.click();
  await box.pressSequentially("@");
  await expect(menu(page)).toBeVisible();
  await expect(
    page.locator('[data-mention-section="employees"]'),
  ).toBeVisible();
  await expect(page.locator('[data-mention-section="files"]')).toBeVisible({
    timeout: 15_000,
  });
  await expect(fileRows(page)).toHaveCount(20, { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-1-draft-menu.png` });
  await box.press("Escape");
  await expect(menu(page)).toHaveCount(0);

  // Pick a file by keyboard: the text becomes a whole `@path` token, and one
  // Backspace takes the whole token back out.
  await box.fill("");
  const hits = waitForFileSearch(page, "app");
  await box.pressSequentially("read @app");
  await hits;
  const row = page.locator('[data-mention-file="src/app.tsx"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await arrowDownTo(box, row);
  await box.press("Enter");
  await expect(box).toHaveValue("read @src/app.tsx ");
  await box.press("Backspace");
  await expect(box).toHaveValue("read ");
  const hits2 = waitForFileSearch(page, "app");
  await box.pressSequentially("@app");
  await hits2;
  await expect(row).toBeVisible({ timeout: 15_000 });
  await arrowDownTo(box, row);
  await box.press("Enter");
  await expect(box).toHaveValue("read @src/app.tsx ");

  // The draft survives a reload (the per-agent draft store, #103).
  await page.reload();
  await expect(draftBox(page)).toHaveValue("read @src/app.tsx ", {
    timeout: 30_000,
  });

  // Sent, the opener shows the mention as a chip and the thread runs in the
  // repo the chip picked.
  await draftBox(page).press("Enter");
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
  await settled(page);
  await expect(
    panel(page).locator("code").filter({ hasText: "@src/app.tsx" }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-draft-sent-chip.png` });
});

test("AC-2 the first message's @ menu has People only without a folder to search (D-#19)", async ({
  page,
}) => {
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:default`);
  await draftBox(page).click();
  await draftBox(page).pressSequentially("@");
  await expect(menu(page)).toBeVisible();
  await expect(
    page.locator('[data-mention-section="employees"]'),
  ).toBeVisible();
  // The chip says "No folder" or is absent: either way there is nothing to
  // search, so no Files section.
  const chip = v3Peek(page).getByTitle(/^Folder · /);
  if (await chip.count()) {
    await draftBox(page).press("Escape");
    await chip.click();
    await v3Peek(page)
      .getByRole("menuitemradio", { name: /No folder/ })
      .click();
    await draftBox(page).fill("");
    await draftBox(page).pressSequentially("@");
  }
  await expect(page.locator('[data-mention-section="files"]')).toHaveCount(0);
  await draftBox(page).press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await draftBox(page).fill("");
});

test("AC-3 + AC-4 picking a file inserts a chip; Backspace removes it; it survives reload and ↑ recall; the engine gets @path as text", async ({
  page,
}) => {
  await chatInRepo(page);
  const box = replyBox(page);

  // Pick via the menu (keyboard path — focus stays in the textarea).
  await box.click();
  const hits = waitForFileSearch(page, "app");
  await box.pressSequentially("read @app");
  await hits;
  const row = page.locator('[data-mention-file="src/app.tsx"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(fileRows(page)).toHaveCount(1);
  await arrowDownTo(box, row);
  await box.press("Enter");
  await expect(box).toHaveValue("read @src/app.tsx ");

  // Backspace removes the whole chip (token + trailing space).
  await box.press("Backspace");
  await expect(box).toHaveValue("read ");

  // Re-insert, verify the draft survives a reload (draft store #103).
  const hits2 = waitForFileSearch(page, "app");
  await box.pressSequentially("@app");
  await hits2;
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(fileRows(page)).toHaveCount(1);
  await arrowDownTo(box, row);
  await box.press("Enter");
  await expect(box).toHaveValue("read @src/app.tsx ");
  await page.screenshot({ path: `${SHOTS}/ac-3-chip-draft.png` });
  await page.reload();
  await expect(replyBox(page)).toHaveValue("read @src/app.tsx ", {
    timeout: 30_000,
  });

  // Send: the message shows the mention as a chip (inline code). The session
  // already runs in the repo (the draft's Folder chip carried its cwd through,
  // like #113) — the Files section above could not have searched it otherwise.
  /* Turns are addressed by position, never by a count taken here: right after
     the reload above the thread has not re-rendered its turns yet (the count
     reads 0), so a relative "+1" was met by the FIRST turn re-appearing, and
     `turns.last()`'s settled footer was that first turn's — the spec moved on
     while the second turn still ran, and the follow-up below was steered into
     it (no third turn, ever). */
  const turns = panel(page).locator("[data-agentturn]");
  await expect(turns).toHaveCount(1, { timeout: 30_000 });
  await replyBox(page).press("Enter");
  await expect(
    page.locator("code").filter({ hasText: "@src/app.tsx" }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(turns).toHaveCount(2, { timeout: 30_000 });
  // The second turn's own settled footer — the first turn's is already there.
  await expectSettled(turns.nth(1));
  await page.reload();
  await expect(
    page.locator("code").filter({ hasText: "@src/app.tsx" }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-sent-chip.png` });

  // ↑ recall in the thread composer brings the mention text back (#104).
  await replyBox(page).click();
  await replyBox(page).press("ArrowUp");
  await expect(replyBox(page)).toHaveValue("read @src/app.tsx");

  // AC-4: a follow-up mention reaches the engine as plain text — the fake's
  // reply plan echoes it verbatim. The previous turn is settled (above): a
  // message sent mid-turn is a steer (no new reply), not a follow-up. After
  // the reload both turns are back, and the second one is already over.
  await expect(turns).toHaveCount(2, { timeout: 30_000 });
  await expectSettled(turns.nth(1));
  await replyBox(page).fill("note @docs/guide.md ");
  await replyBox(page).press("Enter");
  await expect(turns).toHaveCount(3, { timeout: 30_000 });
  await expect(turns.last()).toContainText("Noted. Plan for this session", {
    timeout: 30_000,
  });
  await expect(turns.last()).toContainText("@docs/guide.md");
  await expect(
    page.locator("code").filter({ hasText: "@docs/guide.md" }).last(),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-4-engine-plain-text.png` });
});

test("AC-5 the first results land inside the keystroke budget and fs.search is called per query", async ({
  page,
}) => {
  const searchCalls: number[] = [];
  page.on("request", (r) => {
    if (!r.url().endsWith("/host")) return;
    try {
      const m = JSON.parse(r.postData() ?? "{}") as {
        method?: string;
        params?: { query?: string };
      };
      if (m.method === "fs.search") searchCalls.push(Date.now());
    } catch {
      /* OPTIONS preflight carries no JSON body */
    }
  });
  await chatInRepo(page);
  const box = replyBox(page);
  await box.click();
  const t0 = Date.now();
  await box.pressSequentially("@");
  await expect(fileRows(page).first()).toBeVisible({ timeout: 15_000 });
  const firstMs = Date.now() - t0;
  expect(firstMs).toBeLessThan(2000); // e2e smoke bound; the ~200ms AC is asserted in the host vitest
  await box.pressSequentially("app");
  await expect(page.locator('[data-mention-file="src/app.tsx"]')).toBeVisible({
    timeout: 15_000,
  });
  expect(searchCalls.length).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: `${SHOTS}/ac-5-responsive.png` });
});
