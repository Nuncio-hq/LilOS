import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
  startChatInFolder,
  startFolderlessChat,
  threadUrl,
  v3Peek,
} from "./helpers/stack";
import { openWorkbench, workMenu } from "./helpers/workbench";

/**
 * Issue #590 — desktop polish on the thread surfaces:
 *
 *   AC-1 a plan's "Change…" puts the caret after the prefix in the
 *       composer; Approve/Reject clears an untouched prefix.
 *   AC-2 at 1024px the header names the employee, the composer keeps one
 *       row of controls, and icon-only tabs carry tooltips.
 *   AC-3 no internals on screen: no `lilos status --verbose`, no
 *       /private/… paths, the context meter has a real label.
 *
 * v3: a thread opens in the side peek beside Threads (`open=thread:<id>`),
 * and widening it (`full=1`) is the session view — chat beside the
 * Workbench — what Focus used to be. There is no composer folder picker with
 * an "Add a folder" dialog any more: a session in a folder is started from
 * the new-chat draft's Folder chip (over the app's recents), and a folder-less
 * thread's header link opens the same dialog to MOVE it into one. The System
 * status dialog has no sidebar row; the status banner's Details opens it
 * while a leg is down.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-590");

/* Two fixtures:
   - homeRepoDir under ~/repos — a workbench-probe-friendly cwd: fs.tree /
     git.diff / forge.pr all answer there, so the strip carries the full
     tab set (enough to fold icons at 1024px). It is also under $HOME, which
     the folder move requires (moving a live session is a home write).
   - repoDir under tmpdir resolves through /private — binding a session
     there exercises the prettyPath strip (a raw `/private/var/…` on
     screen is the internal-looking bug).
   The two basenames differ on purpose: the draft's Folder menu lists every
   recent and a leg picks its folder by name, so a shared name would match
   both rows once an earlier leg left its folder in the recents. */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-590-"));
const repoDir = path.join(ROOT, "lilos-repo-590");
/* homeRepoDir lives under the stack's scratch ~/repos (r10 — the host
   collapses `~` against the harness's home, so a real-home fixture
   shows absolute and lands outside the home gate entirely). */
let HOME_ROOT: string;
let homeRepoDir: string;
let homeRepoShown: string;
mkdirSync(repoDir);
execSync(
  "git init -b trunk && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
  { cwd: repoDir },
);
const realRepoDir = realpathSync(repoDir); // /private/var/folders/…

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac590", await pickPorts());
  mkdirSync(path.join(stack.home, "repos"), { recursive: true });
  HOME_ROOT = mkdtempSync(path.join(stack.home, "repos", "lilos-590-"));
  homeRepoDir = path.join(HOME_ROOT, "lilos-home-repo-590");
  homeRepoShown = `~/repos/${path.basename(HOME_ROOT)}/lilos-home-repo-590`;
  mkdirSync(homeRepoDir);
  execSync(
    "git init -b trunk && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
    { cwd: homeRepoDir },
  );
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

/* The seeded Default employee: an id that names nobody opens the new-chat
   draft on the default agent, so no employee lookup is needed. */
const DEFAULT_AGENT = { id: "default", name: "Default" };

const panel = (page: Page) => page.locator("[data-thread-panel]");

test("AC-1 plan 'Change…' focuses the composer after the prefix; Approve clears an untouched prefix", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await skipFirstRun(page);
  await startChat(
    page,
    stack.webUrl,
    DEFAULT_AGENT,
    "plan: propose — polish check",
  );
  const card = panel(page).locator("[data-plan]").last();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toHaveAttribute("data-planstatus", "proposed");

  /* "Change…" prefills the thread composer and puts the caret AFTER the
     prefix — Oscar starts typing his change, not at its start. */
  await card.getByRole("button", { name: "Change…" }).click();
  const box = panel(page).locator("textarea").last();
  await expect(box).toHaveValue("Change the plan: ", { timeout: 15_000 });
  await expect(box).toBeFocused();
  const caret = await box.evaluate(
    (el: HTMLTextAreaElement) => el.selectionStart,
  );
  expect(caret).toBe("Change the plan: ".length);
  await page.screenshot({ path: `${SHOTS}/ac-1-change-prefill.png` });

  /* Approve while the prefix is untouched — the dead prompt clears instead
     of sitting in the composer to edit a decided plan. */
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(box).toHaveValue("", { timeout: 15_000 });
  await expect(card).toHaveAttribute("data-planstatus", "approved");
  await page.screenshot({ path: `${SHOTS}/ac-1-approve-clears.png` });
});

test("AC-2 at 1024px the header names the employee, the composer stays one row, icon-only tabs have tooltips", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1024, height: 700 });

  /* A home-folder repo so every workbench probe answers — the strip then
     carries enough tabs to fold at 1024px. The session starts folder-less
     and is moved there through the header's "Add a folder" dialog; type the
     `~/x` path straight in: it resolves through fs.list. */
  const conv = await startFolderlessChat(
    page,
    stack,
    "build the readme section",
  );
  await page.goto(threadUrl(stack.webUrl, conv));
  const addFolder = panel(page).locator("[data-add-folder]");
  await expect(addFolder).toBeVisible({ timeout: 30_000 });
  await addFolder.click();
  const dialog = page.locator("[data-addfolder]");
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-pathinput]").fill(homeRepoShown);
  await expect(dialog.locator("[data-folderinfo]")).toContainText("Git repo", {
    timeout: 30_000,
  });
  await dialog.locator("[data-addbtn]").click();
  await expect(dialog).toHaveCount(0);
  const moved = panel(page).getByText(/Moved this thread to/);
  await expect(moved).toBeVisible({ timeout: 30_000 });
  await expect(moved).toContainText(homeRepoShown);
  await expect(addFolder).toHaveCount(0);

  await panelIntoFocus(page);
  const session = v3Peek(page);

  /* The peek's trail names the employee and, once the thread moved into the
     folder, its project ("Default · lilos-…") — the header under it does
     not say it a second time. */
  await expect(
    session.getByRole("navigation", { name: "Trail" }),
  ).toContainText(/\w+ · \S+/, { timeout: 15_000 });
  await expect(
    session.getByRole("navigation", { name: "Trail" }),
  ).not.toContainText("Chat", { timeout: 15_000 });
  await expect(session.locator("header")).not.toContainText(/Chat · \w+/);
  await page.screenshot({ path: `${SHOTS}/ac-2-header-1024.png` });

  /* Composer controls stay on one row — nothing overflows the footer's
     width (the hint truncates first instead of wrapping). */
  const footer = session
    .locator("form")
    .locator("[data-slot='input-group-addon']")
    .last();
  await expect(footer).toBeVisible();
  const overflows = await footer.evaluate(
    (el) => el.scrollWidth - el.clientWidth,
  );
  expect(overflows).toBeLessThanOrEqual(1);

  /* Workbench tabs that fold to icons still announce themselves — a title
     tooltip per icon-only tab (the strip marks folded tabs .wb-fold). The
     panel's open state is seeded at session-view mount, which can precede
     the conversation's folder landing — the work strip's tab opens it
     either way (an open panel stays as it is). */
  const wbTabs = session.locator("[data-wb-tab]");
  await openWorkbench(page);
  await expect(wbTabs.first()).toBeVisible({ timeout: 45_000 });
  const folded = session.locator("[data-wb-tab].wb-fold");
  await expect(folded.first()).toBeVisible({ timeout: 15_000 });
  const foldedCount = await folded.count();
  for (let i = 0; i < foldedCount; i++) {
    await expect(folded.nth(i)).toHaveAttribute("title", /./);
    await expect(folded.nth(i)).toHaveAttribute("aria-label", /./);
  }
  await page.screenshot({ path: `${SHOTS}/ac-2-tabs-1024.png` });
});

test("AC-3 Status reads plain: no CLI command in the System status dialog", async ({
  page,
}) => {
  test.setTimeout(180_000);
  /* The dialog has no sidebar row in v3: the status banner's Details opens
     it, and the banner is drawn only while a leg is down — so this leg boots
     an engine that cannot start (the dead-engine shape ac-85/ac-576 drive). */
  const dead = await bootStack("ac590dead", await pickPorts(), {
    LILOS_ENGINE: "hermes",
    HERMES_BIN: "/nonexistent/hermes-ac590",
  });
  try {
    await skipFirstRun(page);
    // A real query param, so it rides ahead of the hash: shortens the 15s poll.
    await page.goto(`${dead.webUrl}/?statusPollMs=500`);
    await page
      .getByRole("status")
      .getByRole("button", { name: "Details" })
      .click({ timeout: 90_000 });
    /* Status dialog: the legs read plain — no `lilos status --verbose`
       invocation shown to a non-terminal user. */
    const dialog = page.getByRole("dialog", { name: "System status" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog).not.toContainText(/lilos status/);
    await expect(dialog).not.toContainText(/--verbose/);
    await page.screenshot({ path: `${SHOTS}/ac-3-status-plain.png` });
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await dead.stop();
  }
});

test("AC-3 no internals on screen: no /private paths, the context meter is labelled", async ({
  page,
}) => {
  test.setTimeout(180_000);
  /* A session bound under /private/… — its folder shows on screen pretty,
     never the raw realpath (~/… for home paths, /var/… without the
     /private prefix for system tmp). The draft's Folder chip picks the
     /private/… realpath among the recents (it is added over the relay, not
     typed into a dialog: a folder move is refused outside $HOME). */
  await startChatInFolder(
    page,
    stack,
    DEFAULT_AGENT,
    realRepoDir,
    "look around",
  );
  await panelIntoFocus(page);
  const session = v3Peek(page);
  // Nowhere in the session view should "/private/…" leak.
  await expect(session).not.toContainText("/private/", { timeout: 30_000 });

  /* The context meter reads like a person, not a raw "3.5%" — it lives in
     the header's ⋯ menu now (#886). */
  await workMenu(page).click();
  const meter = session.locator("[title^='Context used:']").first();
  await expect(meter).toBeVisible({ timeout: 60_000 });
  await expect(meter).toHaveAttribute(
    "title",
    /^Context used: \d+(\.\d+)?% of ~?\d/,
  );
  await page.screenshot({ path: `${SHOTS}/ac-3-no-internals.png` });
});
