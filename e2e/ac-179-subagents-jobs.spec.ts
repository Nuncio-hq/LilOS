import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
} from "./helpers/stack";

/**
 * Issue #179 — subagents and background work in the real app (apps/web,
 * relay + harness on engine-fake), driven by real engine events:
 *   AC-1 the turn's Subagents block: one live row per helper, status +
 *       duration, opening a row shows brief/steps/report; rows survive a
 *       mid-turn reload (seq replay), no duplicates.
 *   AC-2 a helper's file write lands in Workbench → Changes (same checkout).
 *   AC-3 an employee-helper row shows that employee's avatar + Open session
 *       → their own session in their DM.
 *   AC-4 a background process lists under Workbench → Background with
 *       command/status/uptime/URL/output tail; Stop ends it ("stopped by you").
 *   AC-5 Background tab + Stop render only under the `background_jobs`
 *       capability (D-#19).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-179");

/* A git checkout the session's folder pick binds — the fake's helper writes
   land here, which is exactly what Workbench → Changes reads (AC-2). */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-179-"));
const repoDir = path.join(ROOT, "lilos-repo");
mkdirSync(repoDir, { recursive: true });
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
git(["init", "-b", "trunk"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
execFileSync(
  "sh",
  [
    "-c",
    'echo "# Fixture repo for #179 e2e" > README.md && git add -A && git commit -m init',
  ],
  { cwd: repoDir },
);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack(
    "ac179",
    await pickPorts(),
    /* #432: no stack-wide tick — the prompts needing a mid-turn window
       (the delegate turns below) mark themselves `slow:<ms>`; everything
       else runs flat out. */
  );
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

const FOCUS_URL = /\/dm\/[^/]+\/[^/]+\/focus$/;
const PANEL_URL = /\/dm\/[^/]+\/conv_[^/]+$/;

/* #195: a feed row opens the peek panel, not Focus; the panel's ↗ carries
   on into Focus. */
async function openSessionFocus(page: Page) {
  await sessionRow(page).click();
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await page
    .locator("[data-thread-panel]")
    .getByTitle("Focus", { exact: true })
    .click();
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
}

/** Open the app past first-run, landed on the auto-hired Default's DM. */
async function openDefault(page: Page, s: Stack = stack) {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await page.goto(`${s.webUrl}/?roots=${ROOT}`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /Default/ })).toBeVisible({
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
    await aside.getByRole("button", { name: /Default/i }).click();
  }
  await expect(page).toHaveURL(/\/dm\//);
}

/** Navigate to an employee's DM home from the sidebar. Focus has no
    sidebar (#246) — leave it first when the URL is a /focus one. */
async function openEmployee(page: Page, name: RegExp | string) {
  if (page.url().endsWith("/focus")) {
    await page.getByTitle("Back to DM").click();
  }
  await page.locator("aside").getByRole("button", { name }).click();
  await expect(page).toHaveURL(/\/dm\//);
}

const pickerButton = (page: Page) => page.locator('[data-ws="folder"]');

/** Pick `dir` for the next session (ac-114's flow: recents or Add folder). */
async function pickSessionFolder(page: Page, dir: string) {
  await pickerButton(page).click();
  const menu = page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last();
  const recent = menu.locator(`[data-wsfolder="${dir}"]`);
  /* Recents populate after the menu opens — a one-shot isVisible would race
     into the Add-a-folder dialog, which disables its button for an
     already-picked dir. */
  const recentVisible = await expect(recent.first())
    .toBeVisible({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (recentVisible) {
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
  const box = page.locator("main textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const turns = (page: Page) => page.locator("[data-agentturn]");
const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });
const sessionRow = (page: Page) => page.locator("[data-session] button").last();

/** Wait until the newest turn is settled (its steps/stream markers clear). */
async function turnSettled(page: Page) {
  await expect(turns(page).last().locator("[data-turnsettled]")).toBeVisible({
    timeout: 90_000,
  });
  await expect(turns(page).locator("[data-streaming]")).toHaveCount(0, {
    timeout: 90_000,
  });
}

test("AC-1 a delegate turn shows one live row per helper; opening a row shows brief/steps/report; mid-turn reload replays the rows without duplicates", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDefault(page);
  await pickSessionFolder(page, repoDir);
  /* `LILOS_DELEGATE_ASYNC_HOLD` (#400): the first helper's close is held
     until the next prompt — a live row is still there whenever this test
     looks, instead of hoping to catch it mid-turn on a loaded runner.
     `slow:200` (#432) stretches this turn to ~7 s so the reload below lands
     mid-turn — the held helper keeps the rows live either way. */
  await send(
    page,
    "slow:200 delegate LILOS_DELEGATE_ASYNC_HOLD the relay scan to subagents",
  );
  /* #577: a send lands on the panel; Focus opens via its ↗. */
  await panelIntoFocus(page);

  /* #317: in Focus the turn shows one "N subagents · Open" link; the rows live
     on Workbench → Subagents, which comes forward while the turn spins them off. */
  await expect(page.locator("[data-subagents-link]").last()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("[data-subagents-panel]")).toBeVisible({
    timeout: 60_000,
  });
  // First live row streams in — reload mid-turn right now.
  await expect(
    page.locator("[data-subagent][data-status='running']").first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-1-live.png` });
  await page.reload();
  // After a reload the turn's link opens the tab.
  await page.locator("[data-subagents-link]").last().click({ timeout: 60_000 });
  const replayed = page.locator("[data-subagents-panel]");
  await expect(replayed).toBeVisible({
    timeout: 60_000,
  });

  // Exactly one row per helper. Two closed inside the turn — one done, one
  // failed — while the held helper is still Running (#400).
  await expect(replayed.locator("[data-subagent]")).toHaveCount(3, {
    timeout: 60_000,
  });
  await expect(
    replayed.locator("[data-subagent][data-status='done']"),
  ).toHaveCount(1);
  await expect(
    replayed.locator("[data-subagent][data-status='failed']"),
  ).toHaveCount(1);
  await expect(
    replayed.locator("[data-subagent][data-status='running']"),
  ).toHaveCount(1);
  /* The release prompt is the signal the engine flushes the held close on
     — deterministic instead of racing a tick window. The first turn must
     be over first (a mid-turn send would steer into it instead of making
     the next prompt). Two done, one failed. */
  await turnSettled(page);
  await send(page, "wrap up the async helper");
  await expect(
    replayed.locator("[data-subagent][data-status='done']"),
  ).toHaveCount(2, { timeout: 60_000 });
  await expect(
    replayed.locator("[data-subagent][data-status='running']"),
  ).toHaveCount(0);
  await expect(page.locator("[data-subagents-link]").last()).toContainText(
    "1 failed",
  );
  // Durations render on finished rows.
  await expect(replayed.locator("[data-subagent]").first()).toContainText(
    /\d+s/,
  );

  // Opening a row shows its brief, its own steps and its report.
  // Finished rows list newest first — pick the relay scan by what it reported.
  const first = replayed
    .locator("[data-subagent]")
    .filter({ hasText: /Relay exports/ });
  await first.click();
  await expect(first).toContainText("Brief ·");
  await expect(first).toContainText(/Searched|search_files/);
  await expect(first).toContainText(
    /Relay exports.*envelope shape over the wire/,
  );
  await page.screenshot({ path: `${SHOTS}/ac-1-done.png` });
  await turnSettled(page);
});

test("AC-2 a helper's file write counts in Workbench → Changes (same checkout)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openDefault(page);
  await openSessionFocus(page);

  const changes = tab(page, /Changes/);
  await expect(changes).toBeVisible({ timeout: 30_000 });
  await changes.click();
  /* The "Draft the summary" helper wrote notes/summary.md into the session
     checkout during AC-1 — untracked rows list under Changes. */
  /* Assert inside the Changes panel: the diff row splits name and folder, and
     the helper's report elsewhere on the page also mentions the path. */
  await expect(
    page.getByRole("button", {
      name: "Open notes/summary.md in an editor or Finder",
    }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-2-changes.png` });
});

test("AC-3 an employee-helper row shows their avatar + Open session into their DM", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDefault(page);

  // Hire Reviewer (Use profile), then open its DM and send one message —
  // the engine links an employee-helper to their live session (D-#25).
  // A disabled row means the profile is already hired — skip straight to it.
  const reviewerAside = page
    .locator("aside")
    .getByRole("button", { name: "Reviewer" });
  if (!(await reviewerAside.isVisible().catch(() => false))) {
    await page
      .locator("aside")
      .getByRole("button", { name: "Add Employees" })
      .click();
    const dlg = page.locator("div.fixed.inset-0", {
      hasText: "Hire an employee",
    });
    await dlg.getByRole("button", { name: "Use profile" }).click();
    await page.screenshot({ path: `${SHOTS}/ac-3-hire-dialog.png` });
    const pickBtn = dlg.getByRole("button", { name: /reviewer/ }).first();
    await expect(pickBtn).toBeEnabled({ timeout: 15_000 });
    await pickBtn.click();
    await dlg
      .getByRole("button", { name: /Hire Reviewer/ })
      .dispatchEvent("click");
    await expect(reviewerAside).toBeVisible({ timeout: 30_000 });
  }
  await openEmployee(page, "Reviewer");
  await send(page, "wake up");
  await expect(page.locator("[data-agentturn]").last()).toBeVisible({
    timeout: 60_000,
  });
  await turnSettled(page);

  // Back on Default's open conversation, delegate with a @reviewer mention:
  // the third helper is reported as that employee's own helper.
  await openEmployee(page, /Default/);
  await openSessionFocus(page);
  /* A mid-string @mention stays literal text in the outgoing message — the
     fake keys the employee-helper branch on `@<profile>`. (Leading the draft
     with it would leave the mention menu open on Enter.) */
  await send(page, "delegate the summary work to subagents; @reviewer helps");
  /* The Subagents tab lists the whole session (AC-1's helpers too) — assert on
     this turn through its link, and on the employee helper's own row. */
  await page.locator("[data-subagents-link]").last().click({ timeout: 60_000 });
  const block = page.locator("[data-subagents-panel]");
  await expect(block).toBeVisible({ timeout: 60_000 });
  const helper = block
    .locator("[data-subagent]")
    .filter({ hasText: /Reviewer · Draft the summary/ });
  await expect(helper).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator("[data-subagents-link]").last()).not.toContainText(
    "running",
    { timeout: 60_000 },
  );
  await expect(page.locator("[data-subagents-link]").last()).toContainText(
    /3 subagents\s*· 1 failed/,
  );
  await page.screenshot({ path: `${SHOTS}/ac-3-employee-helper.png` });

  const open = helper.getByRole("button", { name: "Open session" });
  await expect(open).toBeVisible();
  await open.click();
  // Their own session in their DM — not a copy of the helper's work (D-#25).
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+$/, { timeout: 30_000 });
  await expect(page.locator("main").getByText("wake up").first()).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-3-open-session.png` });
});

test("AC-4 a background process lists in Background with command/status/uptime/URL/tail; Stop ends it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDefault(page);
  await openSessionFocus(page);
  await turnSettled(page);

  await send(page, "leave the dev server running in the background");
  const bg = tab(page, /Background/);
  /* #309: delegated subagents list here too (`sa:` ids) — scope to the
     dev-server job row, not just the first. */
  const row = page.locator("[data-job]", { hasText: "bun run dev" }).first();
  // The tab appears as soon as the engine reports the job (within seconds).
  // While the turn still runs, the workbench's follow-the-agent effects can
  // steal the selection back to Changes in the same commit as the click, so
  // re-click whenever the tab deselects until the row shows (#354).
  await expect(bg).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    if ((await bg.getAttribute("aria-selected")) !== "true") await bg.click();
    await expect(row).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(row).toContainText("bun run dev");
  await expect(row).toContainText(/running/);
  await expect(row).toContainText(/up \d+[smh]/);
  // URL appears once the dev server's "Local:" line prints.
  await expect(row.getByRole("link", { name: /localhost:4173/ })).toBeVisible({
    timeout: 30_000,
  });
  // Expanding the row shows the live output tail.
  await row.getByRole("button").first().click();
  await expect(row).toContainText(/vite v7 ready|GET \/ 200/, {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-4-running.png` });

  // Stop ends it — the row reads "stopped by you".
  await row.getByRole("button", { name: "Stop" }).click();
  await expect(row).toContainText("stopped by you", { timeout: 30_000 });
  await expect(row).toHaveAttribute("data-status", "stopped");
  await page.screenshot({ path: `${SHOTS}/ac-4-stopped.png` });
  await turnSettled(page);
});

test("AC-5 no `background_jobs` capability → no Background tab and no Stop (D-#19)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stackB = await bootStack("ac179nocaps", await pickPorts(), {
    LILOS_HIDE_CAPS: "background_jobs",
  });
  try {
    await openDefault(page, stackB);

    await send(page, "leave the dev server running in the background");
    /* #577: a send lands on the panel; Focus opens via its ↗. */
    await panelIntoFocus(page);
    await expect(turns(page).last().locator("[data-turnsettled]")).toBeVisible({
      timeout: 90_000,
    });
    // The engine emitted no job events and declared no capability: the tab
    // never renders and neither do job rows or a Stop control.
    await expect(tab(page, /Background/)).toHaveCount(0);
    await expect(page.locator("[data-job]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-5-no-capability.png` });
  } finally {
    await stackB.stop();
  }
});

/* #319 — the Subagents tab end to end: the thread-panel link opens Focus on
   Workbench → Subagents with `?tab=` in the URL (AC-1/AC-2), the tab tracks
   rows live across a reload without duplicates (AC-3), and an async helper
   stays under Running past turn.completed until its real close (AC-5). */
test("AC-319 the panel's 'N subagents · Open' lands on Focus → Subagents (?tab= survives reload + picks); an async helper stays Running past turn end", async ({
  page,
}) => {
  test.setTimeout(300_000);
  /* #400: LILOS_DELEGATE_ASYNC_HOLD holds the async helper's close until
     the next prompt — the Running row is observable for as long as the
     test wants, no tick stretching needed (#432 drops ENGINE_FAKE_TICK). */
  const stack319 = await bootStack("ac319", await pickPorts());
  try {
    await openDefault(page, stack319);
    await pickSessionFolder(page, repoDir);
    /* `slow:250` keeps this turn running (~9 s) through the mid-test
       reload (#432); `LILOS_DELEGATE_ASYNC_HOLD` marks the first helper
       async and holds its subagent.completed until the next prompt (#400):
       dispatch-receipt delegation on the real engine, but the test
       controls when the close lands — and the rows replay — regardless of
       where in the turn the reload happens. */
    await send(
      page,
      "slow:250 delegate LILOS_DELEGATE_ASYNC_HOLD the relay scan to subagents",
    );
    /* #577: a send lands on the panel; Focus opens via its ↗. */
    await panelIntoFocus(page);
    await expect(page.locator("[data-subagents-link]").last()).toBeVisible({
      timeout: 60_000,
    });

    /* AC-1: back in the DM thread panel the turn shows only the one-line
       link — the rows live on the Subagents tab, never inline. */
    await page.getByTitle("Back to DM").click();
    await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
    const panel = page.locator("[data-thread-panel]");
    const link = panel.locator("[data-subagents-link]").last();
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator("[data-subagents]")).toHaveCount(0);
    await expect(panel.locator("[data-subagent]")).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-319-1-panel-link.png` });

    /* AC-1/2: the link opens Focus on Workbench → Subagents, the tab named
       in the URL. */
    await link.click();
    await expect(page).toHaveURL(/focus\?tab=subagents$/, {
      timeout: 30_000,
    });
    await expect(tab(page, /Subagents/)).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 30_000 },
    );
    const subs = page.locator("[data-subagents-panel]");
    await expect(subs).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `${SHOTS}/ac-319-1-focus-subagents.png` });

    /* AC-2/AC-3: a reload mid-turn lands back on Subagents and replays the
       same rows — never duplicates. */
    await page.reload();
    await expect(page).toHaveURL(/focus\?tab=subagents$/);
    await expect(tab(page, /Subagents/)).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 30_000 },
    );
    await expect(subs.locator("[data-subagent]").first()).toBeVisible({
      timeout: 60_000,
    });

    /* AC-5: the async helper ("Scan the relay package") stays under Running
       after the turn settles — its close is held until the next prompt, so
       the assertion can't lose the window to a slow runner (#400). */
    await turnSettled(page);
    await tab(page, /Subagents/).click();
    const running = subs.locator(
      "[data-subagents-group='running'] [data-subagent]",
    );
    await expect(running).toHaveCount(1, { timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/ac-319-5-running-past-end.png` });
    /* The follow-up prompt is the release: the engine flushes the held close
       as it takes the new turn, and the row moves itself to Finished. */
    await send(page, "wrap up the async helper");
    await expect(running).toHaveCount(0, { timeout: 60_000 });
    await expect(
      subs.locator(
        "[data-subagents-group='finished'] [data-subagent][data-status='done']",
      ),
    ).toHaveCount(2);
    await expect(subs.locator("[data-subagent]")).toHaveCount(3);
    await page.screenshot({ path: `${SHOTS}/ac-319-5-finished.png` });

    /* AC-2: the user's own picks keep the URL honest — choosing Changes
       replaces `?tab=`, and a reload lands there. */
    await tab(page, /Changes/).click();
    await expect(page).toHaveURL(/focus\?tab=changes$/, { timeout: 30_000 });
    await page.reload();
    await expect(tab(page, /Changes/)).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 30_000 },
    );
    await page.screenshot({ path: `${SHOTS}/ac-319-2-tab-reload.png` });
  } finally {
    await stack319.stop();
  }
});

/* #319 — the deep link names the tab even on a session whose turns never
   spun off a helper: the tab renders its empty state rather than silently
   falling back to the first allowed tab. Runs on the shared stack's own
   fresh conversation (a steer can't reach it, so "say hi" lands from the
   DM home). */
test("AC-319 a `?tab=subagents` deep link on a zero-helper session lands on the tab's empty state", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openDefault(page);
  await page.goto(page.url().replace(/\/conv_[^/]+.*$/, ""));
  await pickSessionFolder(page, repoDir);
  /* `slowstart:2500` (#476): the prompt lands but the turn's mint waits —
     the same shape a loaded runner gives the dispatch when `turn.started`
     emits past this reload's feed attach. The deep link named the tab; a
     turn whose prompt predates the navigation must not steal it. The
     post-settle re-assert makes the steal unable to hide between the
     first paint and the check. */
  await send(page, "slowstart:2500 say hi");
  /* #577: a send lands on the panel; Focus opens via its ↗. */
  await panelIntoFocus(page);
  await page.goto(`${page.url()}?tab=subagents`);
  try {
    await expect(tab(page, /Subagents/)).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 30_000 },
    );
    /* The turn minted post-attach is still streaming here — the deep link
       must survive its steps, not just the first paint. */
    await turnSettled(page);
    await expect(tab(page, /Subagents/)).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 30_000 },
    );
  } catch (e) {
    /* A missing trigger means the tab state never took the deep link —
       the URL and the rendered tab set say which side lost it. */
    console.log(
      `[ac-319] url=${page.url()} tabs=${JSON.stringify(
        await page.getByRole("tab").allTextContents(),
      )}`,
    );
    throw e;
  }
  await expect(page.getByText("No subagents in this session yet.")).toBeVisible(
    { timeout: 30_000 },
  );
  await page.screenshot({ path: `${SHOTS}/ac-319-3-empty.png` });
});
