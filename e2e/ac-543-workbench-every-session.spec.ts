import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { expectSettled } from "./helpers/approvals";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
  startChatInFolder,
  startFolderlessChat,
  threadUrl,
} from "./helpers/stack";
import { openWorkbench, workbenchOffered } from "./helpers/workbench";

/**
 * Issue #543 — the Workbench exists for EVERY session (apps/web, relay +
 * harness on engine-fake):
 *   AC-1 a DM session started with NO folder gets the peek's Widen and
 *       Focus's Workbench strip like any session; the panel shows only the
 *       engine tabs — Subagents + Background (Plan when a turn has one) —
 *       never the empty folder-bound tabs.
 *   AC-2 Background lists running/finished processes with a working Stop;
 *       Subagents lists helpers with steps + report; both stay live while
 *       the turn runs and after it ends (#309).
 *   AC-3 the turn's "N subagents · Open" link opens Focus on the Subagents
 *       tab from the thread panel too (#319).
 *   AC-4 a folder session is unchanged — every tab, same order.
 *   AC-5 no tab to show → no Workbench entry (D-#19): a folderless session whose
 *       engine declares none of the Workbench capabilities hides it.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-543");

/* A real git folder for the AC-4 regression leg — git.diff must answer
   (an untracked-only dir still counts as a repo once it has a commit). */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-543-"));
const repoDir = path.join(ROOT, "lilos-repo");
mkdirSync(repoDir, { recursive: true });
writeFileSync(path.join(repoDir, "a.txt"), "one\n");
execFileSync("git", ["init", "-b", "trunk"], { cwd: repoDir });
execFileSync("git", ["add", "."], { cwd: repoDir });
execFileSync(
  "git",
  ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
  { cwd: repoDir },
);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac543", await pickPorts());
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

/** The folderless session `conv` as a person reaches the Workbench: the
    thread opens beside Threads, then the peek's Widen button turns it into
    the session view. */
async function openFolderless(page: Page, s: Stack, conv: string) {
  await page.goto(threadUrl(s.webUrl, conv));
  await panelIntoFocus(page);
}

const send = async (page: Page, text: string) => {
  const box = page.locator("[data-thread-panel] textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const turns = (page: Page) => page.locator("[data-agentturn]");
const turnSettled = (page: Page) => expectSettled(turns(page).last(), 90_000);

const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });

/* The selection underline is each trigger's ::after (inset-x-0 — its
   x-range IS its tab's box). Exactly the aria-selected tab may show it:
   a fading-out underline under the previous tab reads as a stale
   indicator (the #545 merge-review screenshot caught one mid-fade).
   Returns the tab labels whose underline disagrees with selection —
   one-shot, right after a switch, while the mid-fade window is open. */
const underlineDrift = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
      .filter((t) => {
        const lit = parseFloat(getComputedStyle(t, "::after").opacity) > 0.5;
        return lit !== (t.getAttribute("aria-selected") === "true");
      })
      .map((t) => t.textContent ?? "?"),
  );

test("AC-1..3 folderless session: Widen + the Workbench strip; only Subagents + Background; helper detail; Stop ends the job; the link lands on Subagents", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openFolderless(
    page,
    stack,
    await startFolderlessChat(
      page,
      stack,
      /* Turn 1: helpers — `LILOS_DELEGATE_ASYNC_HOLD` keeps the first
         running past turn end (#400), so "live while the turn runs" is
         observable without racing the settle. `slow:250` stretches the
         window (#432). */
      "slow:250 delegate LILOS_DELEGATE_ASYNC_HOLD the relay scan to subagents",
    ),
  );

  // AC-1: the work strip renders — no folder needed. A folderless session's
  // panel opens on demand (a strip tab, a panel link, `workbench.open`) —
  // it auto-opens at ≥lg only when live engine work already shows, so open
  // it here if the helpers haven't landed yet.
  await expect(workbenchOffered(page)).toBeVisible({ timeout: 30_000 });
  if (
    !(await tab(page, "Subagents")
      .isVisible()
      .catch(() => false))
  ) {
    await openWorkbench(page);
  }

  // Exactly the engine tabs — no empty Changes/Files/PR/Terminal/Preview.
  await expect(tab(page, "Subagents")).toBeVisible({ timeout: 30_000 });
  await expect(tab(page, "Background")).toBeVisible();
  /* #587 AC-1 changed the empty-tab policy: engine-owned tabs a capable
     engine declared (Plan included) render greyed-empty instead of popping
     in on first content — the strip is a fixed membership. What stays
     absent is the folder-bound set (and PR, which probes off a folder). */
  await expect(tab(page, /^(Changes|Files|Terminal|Preview|PR)$/)).toHaveCount(
    0,
  );
  await expect(tab(page, "Plan")).toBeVisible();
  await expect(tab(page, "Plan")).toHaveAttribute("data-wb-empty", "true");

  // AC-2: helper rows render live (the held one still Running).
  await tab(page, "Subagents").click();
  await expect(page.locator("[data-subagent]")).toHaveCount(3, {
    timeout: 30_000,
  });
  await expect(
    page.locator('[data-subagent][data-status="running"]'),
  ).toHaveCount(1);
  // Opening one shows brief, steps and report.
  const doneRow = page.locator('[data-subagent][data-status="done"]').first();
  await doneRow.click();
  await expect(doneRow.getByText("Brief ·")).toBeVisible();
  await expect(
    doneRow.locator("[data-subagent-step], .lilos-prose").first(),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-1-subagents-live.png` });

  await turnSettled(page);
  /* The held helper stays Running past the turn's settle (#309 AC-5), and
     the rows are still there after it. */
  await expect(
    page.locator('[data-subagent][data-status="running"]'),
  ).toHaveCount(1);

  /* Turn 2: a long-running background job (the held helper's close lands
     with this prompt — by settle all three are done/failed). */
  await send(page, "leave the dev server running in the background");
  await expect(turns(page).last()).toBeVisible({ timeout: 60_000 });
  await tab(page, "Background").click();
  await expect(tab(page, "Background")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // The underline sits under the active tab only — no drift on switch.
  expect(await underlineDrift(page)).toEqual([]);
  const job = page.locator('[data-job][data-status="running"]').first();
  await expect(job).toBeVisible({ timeout: 30_000 });
  await expect(job).toContainText("bun run dev");
  await page.screenshot({ path: `${SHOTS}/ac-2-background-live.png` });

  // Stop works — the job flips to "stopped by you" in place.
  await job.getByRole("button", { name: "Stop" }).click();
  await expect(
    page.locator('[data-job][data-status="stopped"]').first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("stopped by you")).toBeVisible();
  await turnSettled(page);
  /* …and the Subagents tab still lists all three helpers after the turn
     ended (rows live under their own tab). */
  await tab(page, "Subagents").click();
  await expect(page.locator("[data-subagent]")).toHaveCount(3);
  await expect(tab(page, "Subagents")).toHaveAttribute("aria-selected", "true");
  expect(await underlineDrift(page)).toEqual([]);

  /* AC-3: back in the thread beside Threads, the turn's "N subagents · Open"
     opens the session view straight on the Subagents tab. Esc steps the
     session view back to the thread first. */
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(THREAD_URL, { timeout: 30_000 });
  await expect(page).not.toHaveURL(FULL_URL);
  await page.locator("[data-subagents-link]").last().click();
  await expect(page).toHaveURL(FULL_URL, { timeout: 30_000 });
  await expect(tab(page, "Subagents")).toBeVisible({ timeout: 15_000 });
  await expect(tab(page, "Subagents")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-subagent]")).toHaveCount(3);
  expect(await underlineDrift(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/ac-3-link-to-subagents.png` });

  /* The Background tab on the folderless session after a reload (the
     session view rides the URL; the Workbench tab is the thread's own
     state, so it is picked again) — underline on the picked tab, nowhere
     else. */
  await page.reload();
  await expect(page).toHaveURL(FULL_URL);
  if (
    !(await tab(page, "Background")
      .isVisible({ timeout: 30_000 })
      .catch(() => false))
  ) {
    await openWorkbench(page);
  }
  await tab(page, "Background").click();
  await expect(tab(page, "Background")).toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 15_000 },
  );
  expect(await underlineDrift(page)).toEqual([]);
});

test("AC-4 a folder session is unchanged: every tab renders in the same order", async ({
  page,
}) => {
  test.setTimeout(240_000);
  /* A new chat in the repo folder this time. */
  await startChatInFolder(
    page,
    stack,
    { id: "default", name: "Hermes" },
    repoDir,
    "slow:100 delegate the relay scan to subagents",
  );
  /* A send lands on the thread beside Threads; widening it is the session
     view (chat beside the Workbench). */
  await panelIntoFocus(page);
  await expect(workbenchOffered(page)).toBeVisible({ timeout: 30_000 });
  /* Changes + Files answer (real fs/git), Background from the capability,
     Subagents once helpers land — PR needs `gh`, absent on this PATH, so it
     shows its error state; the point is folder tabs still render. */
  await expect(tab(page, "Changes")).toBeVisible({ timeout: 30_000 });
  await expect(tab(page, "Files")).toBeVisible();
  await expect(tab(page, "Background")).toBeVisible();
  await expect(tab(page, "Subagents")).toBeVisible({ timeout: 30_000 });
  await expect(tab(page, /^PR$/)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-4-folder-session.png` });
  await turnSettled(page);
});

test("screenshots: folderless Focus on Subagents + Background, light + dark (1288x700)", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  await openFolderless(
    page,
    stack,
    await startFolderlessChat(
      page,
      stack,
      "delegate the relay scan to subagents",
    ),
  );
  await turnSettled(page);
  /* Second turn once settled: a long-running job that outlives it — the
     Background tab's running row is the screenshot's subject. */
  await send(page, "leave the dev server running in the background");
  await turnSettled(page);
  /* The settled session holds jobs + helpers — entry auto-opens the panel
     on that content. If it raced, the strip opens it on demand. */
  if (
    !(await tab(page, "Subagents")
      .isVisible()
      .catch(() => false))
  ) {
    await openWorkbench(page);
  }
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    /* The context-usage hover card sits over the tab row once opened —
       park the pointer off the header so it closes before clicking. */
    await page.mouse.move(10, 300);
    await tab(page, "Subagents").click();
    await expect(page.locator("[data-subagent]")).toHaveCount(3);
    await page.screenshot({ path: `${SHOTS}/subagents-${scheme}.png` });
    await page.mouse.move(10, 300);
    await tab(page, "Background").click();
    await expect(page.locator('[data-job][data-status="running"]')).toHaveCount(
      1,
    );
    await page.screenshot({ path: `${SHOTS}/background-${scheme}.png` });
  }
});

test("AC-5 a session with no tab to show offers no Workbench (D-#19)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  /* No folder AND an engine declaring none of the Workbench capabilities —
     nothing for any tab to render, so the Workbench reports empty and the
     strip stays away (folder tabs need a folder; engine tabs need the
     caps or rows). */
  const stackB = await bootStack("ac543nocaps", await pickPorts(), {
    LILOS_HIDE_CAPS: "background_jobs,subagents,plan",
  });
  try {
    const conv = await startFolderlessChat(
      page,
      stackB,
      "just chat — no folder, no work",
    );
    await openFolderless(page, stackB, conv);
    await turnSettled(page);
    await expect(workbenchOffered(page)).toHaveCount(0);
    await expect(
      tab(
        page,
        /^(Changes|Files|Terminal|Preview|Background|Subagents|Plan|PR)$/,
      ),
    ).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-5-no-tabs.png` });
  } finally {
    await stackB.stop();
  }
});
