import { mkdirSync } from "node:fs";
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
 * fresh home shows Welcome alone (no sidebar); three plain steps — name,
 * first agent, first folder — and no company field, no engine check, no
 * internal names (#885). Finishing lands on Home with the first agent named
 * as typed, and that choice lives in the relay, not in the page.
 */

test("a fresh home: Welcome, three plain steps, then Home with the first agent as typed", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("v3first", await pickPorts(), {
    LILOS_USER_NAME: "Test User",
  });
  try {
    /* The picker's `fs.list` reads the typed dir's parent — keep it under
       the scratch home (few entries), not $TMPDIR's hundreds. */
    const folder = path.join(stack.home, "first-project");
    mkdirSync(folder, { recursive: true });

    await page.goto(`${stack.webUrl}/`);
    await expect(
      page.getByRole("heading", { name: "Welcome to LilOS" }),
    ).toBeVisible({ timeout: 30_000 });
    // First run owns the window: nothing to navigate yet.
    await expect(v3Sidebar(page)).toHaveCount(0);

    /* #885: no company pitch, no company field, no engine check — the words
       a user reads never name the inside parts. */
    await expect(page.getByLabel("Company name")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Engine check");
    await expect(page.locator("body")).not.toContainText(/engine[-\s]?fake/i);
    await expect(page.locator("body")).not.toContainText(/local relay/i);
    await expect(page.locator("[data-first-run-step]")).toHaveCount(0);

    // Step 1: the field starts from the OS user, and typing replaces it.
    await expect(page.getByLabel("Your name")).toHaveValue("Test User");
    await page.getByLabel("Your name").fill("Rowan Test");
    await page.getByRole("button", { name: "Next" }).click();

    // Step 2: name the first agent and pick its model.
    await expect(page.locator('[aria-current="step"]')).toContainText(
      "first agent",
    );
    await page.getByLabel("Name", { exact: true }).fill("Ada");
    await page.getByRole("radio", { name: /Fake Reasoning/ }).click();
    await expect(
      page.getByRole("radio", { name: /Fake Reasoning/ }),
    ).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Next" }).click();

    // Step 3: "Choose folder…" opens the app's own picker; the path it adds
    // lands in the typed field, and Start finishes.
    await expect(page.locator('[aria-current="step"]')).toContainText(
      "First project",
    );
    await page.getByRole("button", { name: "Choose folder…" }).click();
    const dialog = page.locator("[data-addfolder]");
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-pathinput]").fill(folder);
    await expect(dialog.locator("[data-addbtn]")).toBeEnabled();
    await dialog.locator("[data-addbtn]").click();
    await expect(dialog).toHaveCount(0);
    /* The picker hands back the path `~`-collapsed against the stack's
       home — the field takes exactly what the dialog added. */
    await expect(page.getByLabel(/path/i)).toHaveValue(
      `~/${path.basename(folder)}`,
    );
    await page.getByRole("button", { name: "Start" }).click();

    // Home, for the person who typed their name.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Good afternoon, Rowan Test",
      { timeout: 30_000 },
    );
    await expect(page).not.toHaveURL(/page=/);
    const side = v3Sidebar(page);
    // The agent the engine created on its own was renamed: still one agent.
    await expect(side.getByRole("button", { name: /Ada/ })).toBeVisible();
    await expect(side.getByRole("button", { name: /Default/i })).toHaveCount(0);
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

    // The choices are the app's, held by the relay: a browser that never
    // saw first run (past it) reads the same name and agent.
    const other = await browser.newContext();
    try {
      const second = await other.newPage();
      await skipFirstRun(second);
      await second.goto(`${stack.webUrl}/`);
      await expect(second.getByRole("heading", { level: 1 })).toHaveText(
        "Good afternoon, Rowan Test",
        { timeout: 30_000 },
      );
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
