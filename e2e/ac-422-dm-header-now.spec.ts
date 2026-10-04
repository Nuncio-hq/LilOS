import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, type Stack } from "./helpers/stack";
import { wport } from "./ports";

/**
 * Issue #422 — the DM header's live "now:" line. Under the employee's name
 * the quiet line shows their role and, while a turn runs, the current step
 * ("now: <tool> <target>"); idle shows the role only. AC-3 runs the real
 * stack on engine-fake: a `slow:`-paced recall turn emits a scripted
 * terminal step the header must name, then clears at turn end.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-422");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack(
    "ac422",
    /* Ports reuse ac-27's base triple — every residue mod 100 is taken on
       main, and identical bases are safe (ports.spec): worker index
       separates live ports, and bootStack's identity check refuses a
       foreign stack anyway. */
    { relay: wport(4643), feed: wport(4647), web: wport(5241) },
    { LILOS_USER_NAME: "Oscar" },
  );
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

/** Land on Default's DM (first-run auto-hire), past the onboard card. */
async function dmDefault(page: Page) {
  await page.goto(`${stack.webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
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
    await aside.getByRole("button", { name: /default/i }).click();
  }
  await expect(page).toHaveURL(/\/dm\//);
}

/** The quiet line under the employee's name in the DM header. */
const quietLine = (page: Page) =>
  page.locator("main header [data-nowline]").first();

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

test("AC-1/AC-3: role at idle, 'now: <tool> <target>' on the scripted step, cleared at turn end", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  // AC-1 idle: the quiet line is the role only — no "now:".
  await expect(quietLine(page)).toContainText("stock employee profile", {
    timeout: 30_000,
  });
  await expect(quietLine(page)).not.toContainText("now:");

  // slow:1200 paces every turn boundary at 1.2s — the scripted
  // `terminal history --turns` step is observable well past CI jitter.
  // Sending lands the app in Focus mode; the DM header lives on the home
  // route — step back while the turn keeps running.
  await send(page, "slow:1200 recall: earlier turns");
  await page.getByRole("button", { name: /back to dm/i }).click();
  await expect(quietLine(page)).toContainText("now: thinking", {
    timeout: 30_000,
  });
  await expect(quietLine(page)).toContainText("now: terminal history --turns", {
    timeout: 30_000,
  });
  // The turn ended — the line falls back to the role only.
  await expect(quietLine(page)).not.toContainText("now:", {
    timeout: 60_000,
  });
});

test("AC-2 screenshot matrix: header 1288x700/1288x900/1440x900, light + dark, running and idle", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  await dmDefault(page);
  const html = page.locator("html");
  // lilos-theme defaults to "system" — emulateMedia drives it per leg
  // (ac-374's pattern; survives the app's own lilos-theme writes).
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).not.toHaveClass(/dark/);
  // slow:1500 paces the scripted turn to ~50s — room for the matrix,
  // still clears well inside the 90s idle wait.
  // Back out of Focus mode so the shots frame the DM header itself.
  await send(page, "slow:1500 recall: header shots");
  await page.getByRole("button", { name: /back to dm/i }).click();
  await expect(quietLine(page)).toContainText("now: terminal history --turns", {
    timeout: 60_000,
  });

  const shoot = (phase: string, scheme: "light" | "dark") =>
    (async () => {
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
    })();

  await shoot("run", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveClass(/dark/);
  await expect(quietLine(page)).toContainText("now:", { timeout: 30_000 });
  await shoot("run", "dark");

  // Idle: the step line is gone; same matrix without "now:".
  await expect(quietLine(page)).not.toContainText("now:", {
    timeout: 90_000,
  });
  await expect(quietLine(page)).toContainText("stock employee profile");
  await shoot("idle", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).not.toHaveClass(/dark/);
  await expect(quietLine(page)).toContainText("stock employee profile");
  await shoot("idle", "light");
});
