import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openSession,
  panelIntoFocus,
  pickPorts,
  relayRpc,
  type Stack,
  skipFirstRun,
  startChat,
  startChatInFolder,
} from "./helpers/stack";

/**
 * Issue #179 — subagents and background work in the real app (apps/web,
 * relay + harness on engine-fake), driven by real engine events:
 *   AC-1 the turn's Subagents block: one live row per helper, status +
 *       duration, opening a row shows brief/steps/report; rows survive a
 *       mid-turn reload (seq replay), no duplicates.
 *   AC-2 a helper's file write lands in Workbench → Changes (same checkout).
 *   AC-3 an employee-helper row shows that employee's avatar + Open thread
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

/* A thread beside Threads (the peek) vs. widened over the page (the session
   view: chat beside the Workbench). */
const THREAD_URL = /open=([^&]*,)?thread:[^&,]+$/;
const FULL_URL = /[#&]full=1(&|$)/;

/* The seeded employee. An id that names nobody opens the new-chat draft on
   the default agent, so the spec needs no employee lookup. */
const DEFAULT_AGENT = { id: "default", name: "Default" };

/* The Default employee's session AC-1 starts: later tests reopen it as the
   session view. */
let defaultConv: string;

/** A new session in the fixture repo, the way a person starts one: the
    new-chat draft's folder chip, then Send. Lands on the thread beside
    Threads; returns its conversation id. */
const startSession = (page: Page, text: string, s: Stack = stack) =>
  startChatInFolder(page, s, DEFAULT_AGENT, repoDir, text);

const send = async (page: Page, text: string) => {
  const box = page.locator("[data-thread-panel] textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const turns = (page: Page) => page.locator("[data-agentturn]");
const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });

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
  defaultConv = await startSession(
    page,
    /* `LILOS_DELEGATE_ASYNC_HOLD` (#400): the first helper's close is held
       until the next prompt — a live row is still there whenever this test
       looks, instead of hoping to catch it mid-turn on a loaded runner.
       `slow:200` (#432) stretches this turn to ~7 s so the reload below lands
       mid-turn — the held helper keeps the rows live either way. */
    "slow:200 delegate LILOS_DELEGATE_ASYNC_HOLD the relay scan to subagents",
  );
  /* A send lands on the thread beside Threads; widening it is the session
     view (chat beside the Workbench). */
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
  await openSession(page, stack.webUrl, defaultConv);

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

test("AC-3 an employee-helper row shows their avatar + Open thread into their DM", async ({
  page,
}) => {
  test.setTimeout(180_000);
  /* Hire Reviewer on the engine's "reviewer" profile, then open its DM and
     send one message — the engine links an employee-helper to their live
     session (D-#25). The hire itself goes over the relay: the v3 Hire page
     hires from role templates, never from an engine profile (ac-115 covers
     the page). Already hired (a retry) → straight to its id. */
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  const { employees } = await relayRpc<{
    employees: { id: string; name: string }[];
  }>(page, stack, "employees.list", {});
  let reviewerId = employees.find((e) => e.name === "Reviewer")?.id;
  if (!reviewerId) {
    const { employee } = await relayRpc<{ employee: { id: string } }>(
      page,
      stack,
      "employees.create",
      {
        name: "Reviewer",
        role: "Reviewer",
        status: "online",
        profile: "reviewer",
      },
    );
    reviewerId = employee.id;
    await relayRpc(page, stack, "channels.openDm", { employeeId: reviewerId });
  }
  // The shell reads the roster when it mounts: the draft must see Reviewer.
  await page.reload();
  const reviewerConv = await startChat(
    page,
    stack.webUrl,
    { id: reviewerId, name: "Reviewer" },
    "wake up",
  );
  await expect(page.locator("[data-agentturn]").last()).toBeVisible({
    timeout: 60_000,
  });
  await turnSettled(page);

  // Back on Default's open conversation, delegate with a @reviewer mention:
  // the third helper is reported as that employee's own helper.
  await openSession(page, stack.webUrl, defaultConv);
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

  const open = helper.getByRole("button", { name: "Open thread" });
  await expect(open).toBeVisible();
  await open.click();
  // Their own session in their DM — not a copy of the helper's work (D-#25):
  // the Reviewer's thread is the top of the trail.
  await expect(page).toHaveURL(
    new RegExp(`open=([^&]*,)?thread:${reviewerConv}(&|$)`),
    { timeout: 30_000 },
  );
  await expect(
    page.locator("[data-thread-panel]").getByText("wake up").first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-open-session.png` });
});

test("AC-4 a background process lists in Background with command/status/uptime/URL/tail; Stop ends it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openSession(page, stack.webUrl, defaultConv);
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
    await skipFirstRun(page);
    await startChat(
      page,
      stackB.webUrl,
      DEFAULT_AGENT,
      "leave the dev server running in the background",
    );
    await panelIntoFocus(page);
    await expect(turns(page).last().locator("[data-turnsettled]")).toBeVisible({
      timeout: 90_000,
    });
    // The engine emitted no job events and declared no capability: the tab
    // never renders and neither do job rows or a Stop control.
    await expect(tab(page, /Background/)).toHaveCount(0);
    await expect(page.locator("[data-job]")).toHaveCount(0);
    /* Scoped to the session view: the Threads row behind the widened peek
       carries the reply's preview text ("…**Stop** kills it."), which is
       part of its accessible name and not a job control. */
    await expect(
      page.locator("[data-thread-panel]").getByRole("button", { name: "Stop" }),
    ).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-5-no-capability.png` });
  } finally {
    await stackB.stop();
  }
});

/* #319 — the Subagents tab end to end: the thread's "N subagents · Open" link
   opens the session view on Workbench → Subagents (AC-1/AC-2), the tab
   tracks rows live across a reload without duplicates (AC-3), and an async
   helper stays under Running past turn.completed until its real close
   (AC-5). */
test("AC-319 the thread's 'N subagents · Open' lands on the session view → Subagents; an async helper stays Running past turn end", async ({
  page,
}) => {
  test.setTimeout(300_000);
  /* #400: LILOS_DELEGATE_ASYNC_HOLD holds the async helper's close until
     the next prompt — the Running row is observable for as long as the
     test wants, no tick stretching needed (#432 drops ENGINE_FAKE_TICK). */
  const stack319 = await bootStack("ac319", await pickPorts());
  try {
    /* `slow:250` keeps this turn running (~9 s) through the mid-test
       reload (#432); `LILOS_DELEGATE_ASYNC_HOLD` marks the first helper
       async and holds its subagent.completed until the next prompt (#400):
       dispatch-receipt delegation on the real engine, but the test
       controls when the close lands — and the rows replay — regardless of
       where in the turn the reload happens. */
    await startSession(
      page,
      "slow:250 delegate LILOS_DELEGATE_ASYNC_HOLD the relay scan to subagents",
      stack319,
    );
    await panelIntoFocus(page);
    await expect(page.locator("[data-subagents-link]").last()).toBeVisible({
      timeout: 60_000,
    });

    /* AC-1: back in the thread beside Threads the turn shows only the
       one-line link — the rows live on the Subagents tab, never inline. */
    await page.getByTitle("Back to DM").click();
    await expect(page).toHaveURL(THREAD_URL, { timeout: 30_000 });
    await expect(page).not.toHaveURL(FULL_URL);
    const panel = page.locator("[data-thread-panel]");
    const link = panel.locator("[data-subagents-link]").last();
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator("[data-subagents]")).toHaveCount(0);
    await expect(panel.locator("[data-subagent]")).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-319-1-panel-link.png` });

    /* AC-1/2: the link opens the session view on Workbench → Subagents. */
    await link.click();
    await expect(page).toHaveURL(FULL_URL, { timeout: 30_000 });
    await expect(tab(page, /Subagents/)).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 30_000 },
    );
    const subs = page.locator("[data-subagents-panel]");
    await expect(subs).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `${SHOTS}/ac-319-1-focus-subagents.png` });

    /* AC-3: a reload mid-turn lands back in the session view (full=1 rides
       the URL) and replays the same rows — never duplicates. The Workbench
       tab is the thread's own state now (no `?tab=`), so the Subagents tab
       is picked again after the reload. */
    await page.reload();
    await expect(page).toHaveURL(FULL_URL);
    await tab(page, /Subagents/).click();
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

    /* AC-2: the user's own pick is the selected tab. */
    await tab(page, /Changes/).click();
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

/* #319 — the Subagents tab on a session whose turns never spun off a helper
   renders its empty state rather than silently falling back to another tab.
   The `?tab=subagents` deep link that named the tab is gone (the pick is the
   thread's own state now, nothing in the URL), so the tab is picked by
   clicking it. */
test("AC-319 the Subagents tab on a zero-helper session lands on its empty state", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await startSession(page, "say hi");
  await panelIntoFocus(page);
  await turnSettled(page);
  await tab(page, /Subagents/).click();
  await expect(tab(page, /Subagents/)).toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 30_000 },
  );
  await expect(page.getByText("No subagents in this thread yet.")).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-319-3-empty.png` });
});
