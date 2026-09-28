import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/* Issue #170 (prototype): subagents and background work in a session.
   Builder's "turns lost after sleep" session is the newest in its DM: turn 1
   already fanned out (subagents + Reviewer), turn 2 plays live when the
   thread opens. One screenshot per acceptance criterion. */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(repo, "test-results", "ac-170");

async function openDemo(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();
  await page.getByRole("button", { name: "Focus", exact: true }).click();
}

test("AC-1 + AC-2 subagents block: live rows, open one for steps + report, employee helper links to its session", async ({
  page,
}) => {
  await openDemo(page);
  const live = page.locator("[data-subagents]").last();
  // The live turn: all three helpers start running, then finish on their own.
  await expect(live.locator('[data-status="running"]').first()).toBeVisible();
  await expect(live).toContainText(/of 3 subagents running/);
  await page.screenshot({ path: `${SHOTS}/ac-1-running.png` });
  await expect(live.locator('[data-status="done"]')).toHaveCount(3, {
    timeout: 15_000,
  });
  await expect(live).toContainText("3 subagents");

  // Turn 1: a failed helper says why; opening a subagent shows its brief, steps, report.
  const first = page.locator("[data-subagents]").first();
  await expect(first.locator('[data-subagent="sa-issues"]')).toContainText(
    "rate-limited",
  );
  await first
    .locator('[data-subagent="sa-harness"]')
    .getByRole("button")
    .click();
  await expect(first).toContainText("Brief ·");
  await expect(first).toContainText("never resumes the feed from");
  await page.screenshot({ path: `${SHOTS}/ac-2-open-subagent.png` });

  // Employee helper: its row links to Reviewer's own session.
  await first
    .locator('[data-subagent="sa-review"]')
    .getByRole("button", { name: "Open session" })
    .click();
  await expect(page.getByText(/Monotonic per session/)).toBeVisible();
  await expect(page.getByText("ses_rv21").first()).toBeVisible();
});

test("AC-3 + AC-4 Workbench: Background tab lists processes with log + Stop; subagent edits count in Changes", async ({
  page,
}) => {
  await openDemo(page);
  const bg = page.getByRole("tab", { name: /Background/ });
  await expect(bg).toContainText("2");
  await bg.click();
  const dev = page.locator('[data-job="j-dev"]');
  await expect(dev).toContainText("bun run dev");
  await expect(dev).toContainText("localhost:5173");
  // The failed build opens to its log by default.
  await expect(page.locator('[data-job="j-build"]')).toContainText("TS2345");
  await page.screenshot({ path: `${SHOTS}/ac-3-background.png` });

  await dev.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator('[data-job="j-dev"]')).toHaveAttribute(
    "data-status",
    "stopped",
  );
  await expect(page.locator('[data-job="j-dev"]')).toContainText(
    "stopped by you",
  );
  await expect(bg).toContainText("1");

  // Subagents edited turns.ts and added sleep.test.ts — both show in Changes.
  await expect(
    page.locator("[data-subagents]").last().locator('[data-status="done"]'),
  ).toHaveCount(3, { timeout: 15_000 });
  await page.getByRole("tab", { name: /Changes/ }).click();
  await expect(page.getByText("turns.ts").first()).toBeVisible();
  await expect(page.getByText("sleep.test.ts").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-4-changes.png` });
});
