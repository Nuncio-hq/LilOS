import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { bootParts } from "./helpers/parts";
import { bootStack, pickPorts, type Stack, v3Sidebar } from "./helpers/stack";

/**
 * Issue #589 — first run follows the real relay and engine state, real app
 * (apps/web over relay + harness). With #885 the engine check is gone from
 * the happy path: a healthy stack walks straight through its steps, and a
 * failed startup shows the plain problem screen (`data-first-run-problem`)
 * in place of them — with the reason in the engine's own words, "Check
 * again" and "See status" for the detail.
 *
 * Success boot: the default engine-fake stack — the steps are there from
 * the start, no check in between.
 * Failure boot: `LILOS_ENGINE=hermes` with `HERMES_BIN` aimed at nothing —
 * the problem screen carries the engine's plain reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-589");

test("AC-1 a healthy stack has no check between the steps — name, agent, folder, Start", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack: Stack = await bootStack("ac589", await pickPorts());
  try {
    await page.goto(`${stack.webUrl}/?statusPollMs=500`);
    await expect(
      page.getByRole("heading", { name: "Welcome to LilOS" }),
    ).toBeVisible({ timeout: 30_000 });
    /* #885: no engine-check step — nothing waits on `system.status` here,
       and the inside parts are never named. */
    await expect(page.locator("[data-first-run-problem]")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Engine check");
    await expect(page.locator("body")).not.toContainText(/local relay/i);
    await page.screenshot({ path: `${SHOTS}/ac-1-welcome.png` });

    await page.getByRole("button", { name: "Next", exact: true }).click(); // agent
    await page.getByRole("button", { name: "Next", exact: true }).click(); // folder
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(
      v3Sidebar(page).getByRole("button", { name: /Hermes/ }),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await stack.stop();
  }
});

test("AC-2 a dead engine shows the plain problem screen; the status dialog opens", async ({
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
    await expect(
      page.getByRole("heading", { name: "Welcome to LilOS" }),
    ).toBeVisible({ timeout: 30_000 });
    /* The problem screen stands in for the steps: no fields to type into,
       no way on — just the reason and the two ways out. */
    const problem = page.locator("[data-first-run-problem]");
    await expect(problem).toBeVisible({ timeout: 90_000 });
    await expect(page.locator("body")).not.toContainText("Your name");
    await expect(
      page.getByRole("button", { name: "Next", exact: true }),
    ).toHaveCount(0);
    /* The engine's own plain words say what is wrong and how to fix it;
       none of the banned internal vocabulary shows on the screen (#885). */
    await expect(problem.getByText(/Hermes not found/)).toBeVisible({
      timeout: 30_000,
    });
    const text = await problem.innerText();
    expect(text).not.toMatch(/relay|harness|employee|engine-fake/i);
    await page.screenshot({ path: `${SHOTS}/ac-2-dead-engine.png` });

    /* "See status" on the problem screen opens the dialog, right on
       Welcome. */
    await problem.getByRole("button", { name: "See status" }).click();
    const dialog = page.getByRole("dialog", { name: /status/i }).first();
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${SHOTS}/ac-2-see-status-welcome.png` });
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);

    /* "Set up later" leaves Welcome for the home; the banner repeats the
       reason with Details — the status dialog is still one click away. */
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

test("AC-3 a harness that never registers shows the problem screen, not a stuck Start", async ({
  page,
}) => {
  test.setTimeout(120_000);
  /* Relay up, no harness ever (bootParts harness:false): the harness leg
     reads down and the engine waits on it — a state "Starting…" must not
     sit on forever (#885). */
  const parts = await bootParts("ac589h", await pickPorts(), {
    harness: false,
  });
  try {
    await page.goto(`${parts.webUrl}/?statusPollMs=500`);
    await expect(
      page.getByRole("heading", { name: "Welcome to LilOS" }),
    ).toBeVisible({ timeout: 30_000 });
    /* The problem screen stands in for the steps with the plain helper
       reason — the leg's own name stays behind See status. */
    const problem = page.locator("[data-first-run-problem]");
    await expect(problem).toBeVisible({ timeout: 60_000 });
    await expect(problem).toContainText(
      /starts the engine isn't answering|hasn't answered/,
    );
    const text = await problem.innerText();
    expect(text).not.toMatch(/\brelay\b|\bharness\b|employee|engine-fake/i);
    await page.screenshot({ path: `${SHOTS}/ac-3-no-harness.png` });
    /* No stuck "Starting…" button and no steps to type into. */
    await expect(
      page.getByRole("button", { name: "Start", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Your name");
  } finally {
    await parts.stop();
  }
});
