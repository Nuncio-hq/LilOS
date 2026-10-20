import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack, v3Sidebar } from "./helpers/stack";

/**
 * Issue #589 — first-run checks show the real relay and engine state, real
 * app (apps/web over relay + harness). AC-1 the two ticks follow
 * `system.status` — a failed leg shows its plain reason, never a timed
 * green. AC-2 a dead engine (like the #85 e2e) shows failure, not a green
 * tick, and the status dialog stays one click away.
 *
 * v3: first run is Welcome's "Engine check" step (step 2). Its two
 * `CheckRow`s carry `data-first-run-step` + `data-state` (wait · run · ok ·
 * fail), set from the same `system.status` legs the status banner reads.
 *
 * Success boot: the default engine-fake stack — both legs go green for real
 * before the company opens.
 * Failure boot: `LILOS_ENGINE=hermes` with `HERMES_BIN` aimed at nothing —
 * the relay leg ticks (the relay is really up) while the engine leg
 * fails with the engine's plain reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-589");

const steps = (page: Page) => page.locator("[data-first-run-step]");

/** Welcome step 1 (You and your company) → step 2 (Engine check). */
async function toEngineCheck(page: Page, webUrl: string) {
  await page.goto(`${webUrl}/?statusPollMs=500`);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Engine check" }),
  ).toBeVisible();
}

test("AC-1 the ticks follow the real legs — relay up, engine up, company opens", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack: Stack = await bootStack("ac589", await pickPorts());
  try {
    await toEngineCheck(page, stack.webUrl);
    /* Both checks tick from real state — never a fixed timer. */
    await expect(steps(page).nth(0)).toHaveAttribute("data-state", "ok", {
      timeout: 30_000,
    });
    await expect(steps(page).nth(1)).toHaveAttribute("data-state", "ok", {
      timeout: 60_000,
    });
    await page.screenshot({ path: `${SHOTS}/ac-1-success.png` });

    // With both legs green the way on is open: through to the company, where
    // the first agent (hired by the engine's default profile) is in the
    // sidebar.
    await page.getByRole("button", { name: "Next", exact: true }).click(); // agent
    await page.getByRole("button", { name: "Next", exact: true }).click(); // folder
    await page.getByRole("button", { name: "Open my company" }).click();
    await expect(
      v3Sidebar(page).getByRole("button", { name: /Default/ }),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await stack.stop();
  }
});

test("AC-2 a dead engine shows its plain reason, never a green tick; the status dialog opens", async ({
  page,
}) => {
  test.setTimeout(120_000);
  /* Hermes the real engine, aimed at a path that doesn't exist — the same
     dead-engine shape the #85 e2e drives. */
  const stack: Stack = await bootStack("ac589d", await pickPorts(), {
    LILOS_ENGINE: "hermes",
    HERMES_BIN: "/nonexistent/hermes-bin",
  });
  try {
    await toEngineCheck(page, stack.webUrl);
    /* The relay leg really is up — it ticks green on its own. */
    await expect(steps(page).nth(0)).toHaveAttribute("data-state", "ok", {
      timeout: 60_000,
    });
    /* The engine leg can't tick: it follows the engine row and fails
       instead of lying. */
    await expect(steps(page).nth(1)).toHaveAttribute("data-state", "fail", {
      timeout: 90_000,
    });
    const failed = steps(page).nth(1);
    await expect(failed).not.toHaveText(/ready/i);
    /* The failed leg's own row reads plain language — no `/` path, no env
       var (`HERMES_…`) — and carries "See status", which opens the system
       status dialog (the raw reason lives there). The engine's own sentence
       is printed just under the row by EngineFix. */
    const legText = await failed.innerText();
    expect(legText).not.toMatch(/\//);
    expect(legText).not.toMatch(/HERMES_/);
    /* Once a leg has failed, nothing on the page can claim it is still
       "Setting itself up…". */
    await expect(page.locator("body")).not.toContainText("Setting itself up");
    /* The engine's own plain words say what is wrong. */
    await expect(page.getByText(/Hermes not found/)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-2-dead-engine.png` });

    /* "See status" on the failed row opens the dialog, right on Welcome. */
    await failed.getByRole("button", { name: "See status" }).click();
    const dialog = page.getByRole("dialog", { name: /status/i }).first();
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${SHOTS}/ac-2-see-status-welcome.png` });
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);

    /* The way on stays shut while the engine is down... */
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Engine check" }),
    ).toBeVisible();

    /* ...and the status dialog is one click away once Welcome is left: the
       banner repeats the reason with Details. */
    await page.getByRole("button", { name: "Set up later" }).click();
    const banner = page.getByRole("status").filter({ hasText: /Hermes/ });
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await banner.getByRole("button", { name: "Details" }).click();
    await expect(
      page.getByRole("dialog", { name: /status/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${SHOTS}/ac-2-see-status.png` });
  } finally {
    await stack.stop();
  }
});
