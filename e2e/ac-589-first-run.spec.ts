import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #589 — first-run checks show the real relay and engine state, real
 * app (apps/web over relay + harness). AC-1 the two ticks follow
 * `system.status` — a failed leg shows its plain reason and a "See status"
 * link — never a timed green. AC-2 a dead engine (like the #85 e2e) shows
 * failure, not a green tick.
 *
 * Success boot: the default engine-fake stack — both legs go green for real
 * before the DM opens.
 * Failure boot: `LILOS_ENGINE=hermes` with `HERMES_BIN` aimed at nothing —
 * the relay leg ticks (the relay is really up) while the employee leg
 * fails with the engine's plain reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-589");

const steps = (page: import("@playwright/test").Page) =>
  page.locator("[data-first-run-step]");

test("AC-1 the ticks follow the real legs — relay up, engine up, DM opens", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack: Stack = await bootStack("ac589", await pickPorts());
  try {
    await page.goto(`${stack.webUrl}/?statusPollMs=500`);
    /* Both checks tick from real state — never a fixed timer. */
    await expect(steps(page).nth(0)).toHaveAttribute("data-state", "ok", {
      timeout: 30_000,
    });
    await expect(steps(page).nth(1)).toHaveAttribute("data-state", "ok", {
      timeout: 60_000,
    });
    await expect(
      page.getByRole("button", { name: /Open DM with Default/ }),
    ).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-1-success.png` });
  } finally {
    await stack.stop();
  }
});

test("AC-2 a dead engine shows its plain reason + See status, never a green tick", async ({
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
    await page.goto(`${stack.webUrl}/?statusPollMs=500`);
    /* The relay leg really is up — it ticks green on its own. */
    await expect(steps(page).nth(0)).toHaveAttribute("data-state", "ok", {
      timeout: 60_000,
    });
    /* The employee leg can't tick: it follows the engine row and fails
       with the plain reason instead of lying. */
    await expect(steps(page).nth(1)).toHaveAttribute("data-state", "failed", {
      timeout: 90_000,
    });
    const failed = steps(page).nth(1);
    await expect(failed).not.toHaveText(/ready/i);
    /* The visible text is plain language Oscar can act on — no `/` path,
       no env var (`HERMES_…`); the raw reason lives behind See status. */
    const legText = await failed.innerText();
    expect(legText).not.toMatch(/\//);
    expect(legText).not.toMatch(/HERMES_/);
    /* The reason is plain words, and "See status" opens the dialog. */
    const seeStatus = failed.getByRole("button", { name: "See status" });
    await expect(seeStatus).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-2-dead-engine.png` });
    await seeStatus.click();
    await expect(
      page.getByRole("dialog", { name: /status/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${SHOTS}/ac-2-see-status.png` });
  } finally {
    await stack.stop();
  }
});
