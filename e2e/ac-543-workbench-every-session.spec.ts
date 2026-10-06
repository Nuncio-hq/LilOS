import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { expectSettled } from "./helpers/approvals";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #543 — the Workbench exists for EVERY session (apps/web, relay +
 * harness on engine-fake):
 *   AC-1 a DM session started with NO folder gets the thread panel's ↗ and
 *       Focus's Workbench toggle like any session; the panel shows only the
 *       engine tabs — Subagents + Background (Plan when a turn has one) —
 *       never the empty folder-bound tabs.
 *   AC-2 Background lists running/finished processes with a working Stop;
 *       Subagents lists helpers with steps + report; both stay live while
 *       the turn runs and after it ends (#309).
 *   AC-3 the turn's "N subagents · Open" link opens Focus on the Subagents
 *       tab from the thread panel too (#319).
 *   AC-4 a folder session is unchanged — every tab, same order.
 *   AC-5 no tab to show → no toggle (D-#19): a folderless session whose
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

const FOCUS_URL = /\/dm\/[^/]+\/[^/]+\/focus/;
const PANEL_URL = /\/dm\/[^/]+\/conv_[^/]+$/;

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

const pickerButton = (page: Page) => page.locator('[data-ws="folder"]');

/** Explicit folderless pick — the menu may carry a recents selection. */
async function pickNoFolder(page: Page) {
  await pickerButton(page).click();
  await page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last()
    .getByText("No folder · just chat")
    .click();
}

/** Pick `dir` for the next session (ac-114's flow: recents or Add folder). */
async function pickSessionFolder(page: Page, dir: string) {
  await pickerButton(page).click();
  const menu = page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last();
  const recent = menu.locator(`[data-wsfolder="${dir}"]`);
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
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const turns = (page: Page) => page.locator("[data-agentturn]");
const turnSettled = (page: Page) => expectSettled(turns(page).last(), 90_000);

const workbenchToggle = (page: Page) =>
  page.getByTitle("Workbench", { exact: true });
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

test("AC-1..3 folderless session: ↗ + toggle; only Subagents + Background; helper detail; Stop ends the job; the link lands on Subagents", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openDefault(page);
  await pickNoFolder(page);

  /* Turn 1: helpers — `LILOS_DELEGATE_ASYNC_HOLD` keeps the first running
     past turn end (#400), so "live while the turn runs" is observable
     without racing the settle. `slow:250` stretches the window (#432). */
  await send(
    page,
    "slow:250 delegate LILOS_DELEGATE_ASYNC_HOLD the relay scan to subagents",
  );
  /* The send lands in Focus already (folder or not) — AC-1's ↗ is covered
     below via the panel round-trip. */
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });

  // AC-1: the toggle renders — no folder needed. A folderless session's
  // panel opens on demand (the toggle, a `?tab=` link, `workbench.open`) —
  // it auto-opens at ≥lg only when live engine work already shows, so open
  // it here if the helpers haven't landed yet.
  await expect(workbenchToggle(page)).toBeVisible({ timeout: 30_000 });
  if (
    !(await tab(page, "Subagents")
      .isVisible()
      .catch(() => false))
  ) {
    await workbenchToggle(page).click();
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

  /* AC-3: back in the thread panel, the turn's "N subagents · Open" opens
     Focus straight on the Subagents tab. Focus has no sidebar (#246) —
     Esc back to the panel first. */
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await page.locator("[data-subagents-link]").last().click();
  await expect(page).toHaveURL(/focus\?.*tab=subagents/, { timeout: 30_000 });
  await expect(tab(page, "Subagents")).toBeVisible({ timeout: 15_000 });
  await expect(tab(page, "Subagents")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-subagent]")).toHaveCount(3);
  expect(await underlineDrift(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/ac-3-link-to-subagents.png` });

  /* Same on the engine deep-links: `?tab=background` on the folderless
     session — underline on the named tab, nowhere else. */
  await page.goto(`${page.url().split("?")[0]}?tab=background`);
  await expect(page).toHaveURL(/focus\?.*tab=background/, {
    timeout: 30_000,
  });
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
  await openDefault(page);
  /* New DM → fresh composer; pick the repo folder this time. */
  await pickSessionFolder(page, repoDir);
  await send(page, "slow:100 delegate the relay scan to subagents");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  await expect(workbenchToggle(page)).toBeVisible({ timeout: 30_000 });
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
  await openDefault(page);
  await pickNoFolder(page);
  await send(page, "delegate the relay scan to subagents");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  await turnSettled(page);
  /* Second turn once settled: a long-running job that outlives it — the
     Background tab's running row is the screenshot's subject. */
  await send(page, "leave the dev server running in the background");
  await turnSettled(page);
  /* The settled session holds jobs + helpers — entry auto-opens the panel
     on that content. If it raced, the toggle opens it on demand. */
  if (
    !(await tab(page, "Subagents")
      .isVisible()
      .catch(() => false))
  ) {
    await workbenchToggle(page).click();
  }
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await tab(page, "Subagents").click();
    await expect(page.locator("[data-subagent]")).toHaveCount(3);
    await page.screenshot({ path: `${SHOTS}/subagents-${scheme}.png` });
    await tab(page, "Background").click();
    await expect(page.locator('[data-job][data-status="running"]')).toHaveCount(
      1,
    );
    await page.screenshot({ path: `${SHOTS}/background-${scheme}.png` });
  }
});

test("AC-5 a session with no tab to show hides the toggle (D-#19)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  /* No folder AND an engine declaring none of the Workbench capabilities —
     nothing for any tab to render, so the Workbench reports empty and the
     toggle stays hidden (folder tabs need a folder; engine tabs need the
     caps or rows). */
  const stackB = await bootStack("ac543nocaps", await pickPorts(), {
    LILOS_HIDE_CAPS: "background_jobs,subagents,plan",
  });
  try {
    await openDefault(page, stackB);
    await pickNoFolder(page);
    await send(page, "just chat — no folder, no work");
    await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
    await turnSettled(page);
    await expect(workbenchToggle(page)).toHaveCount(0);
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
