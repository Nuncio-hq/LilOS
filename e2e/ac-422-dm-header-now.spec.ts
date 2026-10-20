import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  agentUrl,
  bootStack,
  openDefaultAgent,
  pickPorts,
  type Stack,
  startChat,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #422 — the live "now:" line under an employee's name. The quiet line
 * shows their role, and while a turn runs the current step ("now: <tool>
 * <target>"); idle shows the role only. AC-3 runs the real stack on
 * engine-fake: a `slow:`-paced recall turn emits a scripted terminal step,
 * then the line clears at turn end.
 *
 * v3: the person's page (side peek) is where that line lives now. Its title
 * line carries the role, and its "Now" row carries the status pill — Working
 * while a turn runs, Idle after. The v3 data does not carry the running
 * step's text (the Live card's `now` and the agent page have nothing to read
 * it from), so "now: <tool> <target>" has no v3 surface: what is asserted
 * here is the part that exists, role at idle and the Working/Idle swing.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-422");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac422", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const ROLE = /stock employee profile/;

/* The person's page: role in the title line, status in the "Now" row. The
   page lists the person's threads below it with their own pills, so the
   first match is the "Now" row's (it sits above them). */
const working = (page: Page) =>
  v3Peek(page).getByText("Working", { exact: true }).first();
const idle = (page: Page) =>
  v3Peek(page).getByText("Idle", { exact: true }).first();
/* The role leads the person's page in its title line (the first match); the
   Edit form's Description repeats it further down. */
const roleLine = (page: Page) => v3Peek(page).getByText(ROLE).first();

test("AC-1/AC-3: role at idle, Working while the turn runs, back to Idle at turn end", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await openDefaultAgent(page, stack.webUrl);
  // AC-1 idle: the quiet line is the role only — no "now:".
  await expect(roleLine(page)).toBeVisible({ timeout: 30_000 });
  await expect(idle(page)).toBeVisible();
  await expect(v3Peek(page)).not.toContainText("now:");

  // slow:1200 paces every turn boundary at 1.2s — the turn is observable
  // well past CI jitter. A send lands in a thread beside Threads; the
  // person's page is one hop away while the turn keeps running.
  await startChat(page, stack.webUrl, agent, "slow:1200 recall: earlier turns");
  await page.goto(agentUrl(stack.webUrl, agent.id));
  await expect(working(page)).toBeVisible({ timeout: 30_000 });
  await expect(roleLine(page)).toBeVisible();
  // The turn ended — the status falls back to Idle, the role stays.
  await expect(idle(page)).toBeVisible({ timeout: 60_000 });
  await expect(working(page)).toHaveCount(0);
  await expect(roleLine(page)).toBeVisible();
  await expect(v3Peek(page)).not.toContainText("now:");
});

test("AC-2 screenshot matrix: person's page 1288x700/1288x900/1440x900, light + dark, running and idle", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  const agent = await openDefaultAgent(page, stack.webUrl);
  const html = page.locator("html");
  // lilos-theme defaults to "system" — emulateMedia drives it per leg
  // (ac-374's pattern; survives the app's own lilos-theme writes).
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).not.toHaveClass(/dark/);
  // slow:1500 paces the scripted turn to ~50s — room for the matrix,
  // still clears well inside the 90s idle wait.
  await startChat(page, stack.webUrl, agent, "slow:1500 recall: header shots");
  await page.goto(agentUrl(stack.webUrl, agent.id));
  await expect(working(page)).toBeVisible({ timeout: 60_000 });

  const shoot = async (phase: string, scheme: "light" | "dark") => {
    for (const [w, h] of [
      [1288, 700],
      [1288, 900],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.screenshot({
        path: `${SHOTS}/${phase}-${w}x${h}-${scheme}.png`,
      });
    }
  };

  await shoot("run", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveClass(/dark/);
  await expect(working(page)).toBeVisible({ timeout: 30_000 });
  await shoot("run", "dark");

  // Idle: the Working pill is gone; same matrix.
  await expect(idle(page)).toBeVisible({ timeout: 90_000 });
  await expect(roleLine(page)).toBeVisible();
  await shoot("idle", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).not.toHaveClass(/dark/);
  await expect(roleLine(page)).toBeVisible();
  await shoot("idle", "light");
});
