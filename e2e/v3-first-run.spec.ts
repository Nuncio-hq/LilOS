import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  skipFirstRun,
  v3Main,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * First run in the v3 shell (real stack: relay + harness on engine-fake). A
 * fresh home shows Welcome alone (no sidebar); the engine check ticks from the
 * real relay and engine state; finishing lands on Home with the first agent
 * named as typed, and that choice lives in the relay, not in the page.
 */

test("a fresh home: Welcome, a real engine check, then Home with the first agent as typed", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("v3first", await pickPorts(), {
    LILOS_USER_NAME: "Test User",
  });
  try {
    const folder = mkdtempSync(path.join(tmpdir(), "lilos-v3-first-"));

    await page.goto(`${stack.webUrl}/`);
    await expect(
      page.getByRole("heading", { name: "Welcome to LilOS" }),
    ).toBeVisible({ timeout: 30_000 });
    // First run owns the window: nothing to navigate yet.
    await expect(v3Sidebar(page)).toHaveCount(0);

    // Step 1: the fields start from the OS user, and typing replaces them.
    await expect(page.getByLabel("Your name")).toHaveValue("Test User");
    await page.getByLabel("Your name").fill("Rowan Test");
    await page.getByLabel("Company name").fill("Rowan Labs");
    await page.getByRole("button", { name: "Next" }).click();

    // Step 2: both legs follow the real state (never a timer): the relay is
    // connected and the engine reports ready.
    const legs = page.locator("[data-first-run-step]");
    await expect(legs).toHaveCount(2);
    await expect(legs.nth(0)).toHaveAttribute("data-state", "ok", {
      timeout: 30_000,
    });
    await expect(legs.nth(0)).toContainText("Local relay");
    await expect(legs.nth(0)).toContainText("Connected");
    await expect(legs.nth(1)).toHaveAttribute("data-state", "ok", {
      timeout: 60_000,
    });
    // The engine names itself once it has reported: the row reads the real
    // identity, not a placeholder.
    await expect(legs.nth(1)).toContainText("Engine-fake", { timeout: 30_000 });
    await expect(legs.nth(1)).toContainText("Ready");
    await page.getByRole("button", { name: "Next" }).click();

    // Step 3: name the first agent and pick its model.
    await page.getByLabel("Name", { exact: true }).fill("Ada");
    await page.getByRole("radio", { name: /Fake Reasoning/ }).click();
    await expect(
      page.getByRole("radio", { name: /Fake Reasoning/ }),
    ).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Next" }).click();

    // Step 4: the first project folder, typed.
    await page.getByLabel("Path").fill(folder);
    await page.getByRole("button", { name: "Open my company" }).click();

    // Home, for the person who typed their name; the company is theirs.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Good afternoon, Rowan Test",
      { timeout: 30_000 },
    );
    await expect(page).not.toHaveURL(/page=/);
    const side = v3Sidebar(page);
    await expect(side).toContainText("Rowan Labs");
    // The agent the engine hired on its own was renamed: still one agent.
    await expect(side.getByRole("button", { name: /Ada/ })).toBeVisible();
    await expect(side.getByRole("button", { name: /Hermes/i })).toHaveCount(0);
    await expect(page.locator("main")).toContainText("1 agent");

    // Its model is the one picked, and its folder is the chat's folder. The
    // sidebar pick is a jump — the agent is the page now (D-#769); Message's
    // draft peeks beside it.
    await side.getByRole("button", { name: /Ada/ }).click();
    await expect(v3Main(page)).toContainText("Fake Reasoning");
    await v3Main(page).getByRole("button", { name: "Message" }).click();
    await expect(v3Peek(page).getByTitle(/^Project · /)).toHaveAttribute(
      "title",
      new RegExp(path.basename(folder)),
    );

    // A reload stays on Home: first run is done, not a state of the tab.
    await page.goto(`${stack.webUrl}/`);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Good afternoon, Rowan Test",
      { timeout: 30_000 },
    );
    await expect(
      page.getByRole("heading", { name: "Welcome to LilOS" }),
    ).toHaveCount(0);
    await expect(page.locator("[data-first-run-step]")).toHaveCount(0);

    // The choices are the company's, held by the relay: a browser that never
    // saw first run (past it) reads the same name, company and agent.
    const other = await browser.newContext();
    try {
      const second = await other.newPage();
      await skipFirstRun(second);
      await second.goto(`${stack.webUrl}/`);
      await expect(second.getByRole("heading", { level: 1 })).toHaveText(
        "Good afternoon, Rowan Test",
        { timeout: 30_000 },
      );
      await expect(v3Sidebar(second)).toContainText("Rowan Labs");
      await expect(
        v3Sidebar(second).getByRole("button", { name: /Ada/ }),
      ).toBeVisible();
    } finally {
      await other.close();
    }
  } finally {
    await stack.stop();
  }
});
