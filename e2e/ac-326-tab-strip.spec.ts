import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectSettled } from "./helpers/approvals";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
  startChatInFolder,
} from "./helpers/stack";
import { openWorkbench } from "./helpers/workbench";

/* Issue #326 — the Workbench tab strip must never hard-clip a tab label.
   With the folder tabs plus Background and Subagents the strip no longer fits
   in the session view at ~1288px: justify-center overflowed both ways and cut
   the leftmost tab ("Changes 1" → "nges 1"). Wanted: short space collapses
   tabs to icon + count (label → tooltip, least-used first, active keeps its
   label); failing that, the strip scrolls left-anchored with an edge fade.

   The clip check reads `data-slot="tabs-trigger"`, so a build that clips
   fails on "tab Changes clipped", not on a missing fixture.

   Real app: a folder session whose `delegate` turn runs helpers and leaves a
   background job, opened as the session view (the thread widened over the
   page, chat beside the Workbench). Running-count assertions run while the
   badges are live; later legs locate triggers by `data-wb-tab`, which
   survives the badge unmounting. */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-326");

/* A real git folder, so Changes / Files / PR all join the strip. */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-326-"));
const repoDir = path.join(ROOT, "lilos-repo");
mkdirSync(repoDir, { recursive: true });
writeFileSync(path.join(repoDir, "a.txt"), "one\ntwo\nthree\n");
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
  stack = await bootStack("ac326", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

const list = (page: Page) => page.locator('[data-slot="tabs-list"]');
const trig = (page: Page, t: string) =>
  list(page).locator(`[data-wb-tab="${t}"]`);

/** A repo session whose turn spins helpers up and leaves a background job,
    opened as the session view with the Workbench strip showing. */
async function openFocus(page: Page) {
  await startChatInFolder(
    page,
    stack,
    { id: "default", name: "Default" },
    repoDir,
    "slow:250 delegate LILOS_DELEGATE_ASYNC_HOLD the relay scan to subagents",
  );
  await panelIntoFocus(page);
  /* The panel's open state is seeded at session-view mount, which can precede
     the conversation's folder landing — opening through the work strip's own
     tab is idempotent, so there is no toggle to race. Below ~lg the panel
     starts closed and the strip's tab opens its overlay. */
  await openWorkbench(page);
  await expect(list(page)).toBeVisible({ timeout: 30_000 });
}

/** Every trigger sits inside the list's visible box — or is icon-only with
    an aria-label (its label moved to the tooltip). Retried on the invariant
    itself: after a resize the strip needs a frame for the ResizeObserver to
    re-fold — the invariant must hold once laid out. Geometry is read in one
    atomic evaluate so a re-fold can't tear the measurement. */
async function expectNoClippedTab(page: Page) {
  await expect(list(page)).toBeVisible();
  await expect(async () => {
    const read = await list(page).evaluate((el) => {
      const lb = el.getBoundingClientRect();
      return [
        ...el.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger"]'),
      ].map((t) => {
        const b = t.getBoundingClientRect();
        const sp = t.querySelector<HTMLElement>("[data-wb-label]");
        /* No label span → label is shown. A folded tab hides the span and
           carries an aria-label, so the clip check still fails on a strip
           that cuts a label. */
        return {
          tab:
            t.dataset.wbTab ??
            t.getAttribute("value") ??
            t.textContent?.trim().slice(0, 24) ??
            "?",
          aria: t.getAttribute("aria-label") ?? "",
          labelVisible:
            sp == null ? true : getComputedStyle(sp).display !== "none",
          inside:
            b.x >= lb.x - 1 &&
            b.y >= lb.y - 1 &&
            b.right <= lb.right + 1 &&
            b.bottom <= lb.bottom + 1,
        };
      });
    });
    expect(read.length).toBeGreaterThan(0);
    for (const c of read)
      expect(
        c.inside || (c.aria.length > 0 && !c.labelVisible),
        `tab ${c.aria || c.tab} clipped`,
      ).toBe(true);
  }).toPass({ timeout: 10_000 });
}

/** A compacted trigger keeps icon + running count + tooltip label. */
async function expectCompactKeepsBadge(trigLoc: Locator, dataAttr: string) {
  await expect(trigLoc.locator(`[${dataAttr}]`)).toBeVisible();
  await expect(trigLoc.locator("[data-wb-label]:visible")).toHaveCount(0);
  await expect(trigLoc).toHaveAttribute("aria-label", /.+/);
  await expect(trigLoc).toHaveAttribute("title", /.+/);
}

test("AC: no tab clips at 1288 / 900 / ~1040px; collapsed tabs keep icon + count; active keeps its label", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  await openFocus(page);

  /* The held helper and the leftover job keep their counts up past the
     turn's end — these waits use the badge spans, so a strip that clips
     fails on the clip check itself. */
  const subagents = list(page).getByRole("tab", { name: /Subagents/ });
  const subBadge = subagents.locator("[data-subagents-running]");
  const bgBadge = trig(page, "background").locator("[data-bg-running]");
  await expect(subBadge).toBeVisible({ timeout: 30_000 });

  // Focus follows the agent → Subagents is the active tab and keeps its label.
  await expect(subagents.locator("text=Subagents")).toBeVisible();

  // 1288: nothing clips; the least-used tabs are already icon + count.
  await expectNoClippedTab(page);
  await expect(trig(page, "background")).toBeVisible();

  /* Narrower embed (~480px aside below the grid's 46%): more tabs go
     icon-only — Background folds first (least-used). */
  await page.setViewportSize({ width: 1040, height: 700 });
  await expectNoClippedTab(page);
  const folded = await list(page).evaluate(
    (el) => el.querySelectorAll(".wb-fold").length,
  );
  expect(folded).toBeGreaterThan(0);
  await expect(trig(page, "background")).toHaveClass(/wb-fold/);
  // If the job is still running, the folded strip still shows its count.
  if (await bgBadge.isVisible().catch(() => false)) {
    await expectCompactKeepsBadge(trig(page, "background"), "data-bg-running");
  }
  // Subagents is the active tab here, so it keeps its label — only its
  // count matters.
  if (await subBadge.isVisible().catch(() => false)) {
    await expect(subBadge).toBeVisible();
  }
  await page.screenshot({ path: `${SHOTS}/ac-1040.png` });

  // 900px window: the Workbench is the overlay strip — still nothing clips.
  await page.setViewportSize({ width: 900, height: 700 });
  await openWorkbench(page);
  await expectNoClippedTab(page);
  await page.screenshot({ path: `${SHOTS}/ac-900.png` });

  // The active tab keeps its label even when every other tab is icons.
  await subagents.click();
  await expect(subagents.locator("[data-wb-label]:visible")).toBeVisible();

  // Back up at 1288 everything fits again (labels return).
  await page.setViewportSize({ width: 1288, height: 700 });
  await expectNoClippedTab(page);
  await page.screenshot({ path: `${SHOTS}/ac-1288.png` });
  await expectSettled(page.locator("[data-agentturn]").last(), 90_000);
});
