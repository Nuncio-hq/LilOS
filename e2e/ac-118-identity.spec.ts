import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  skipFirstRun,
  v3Main,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #118 — the user's name, company name and avatar colour are
 * relay-owned domain data (profile.get / profile.update), not hardcoded.
 * AC-1: a name set at first run is stored in the relay's sqlite and every
 * surface shows it. AC-2: the fields sit on the first-run Welcome, prefilled
 * from the OS user's full name ("<First>'s Co"), together on one step
 * (v3's Welcome is four steps — the old card's "3 steps or fewer" cap is
 * not a property of v3, see AC-2 below). AC-4: an existing install
 * (onboarded, nothing stored) shows the same prefilled identity without
 * re-running first run. (Settings editing is #132 — out of this slice.)
 *
 * v3 surfaces that carry the identity: the sidebar header (company; the top
 * bar names it only while the sidebar is hidden), Home's greeting
 * ("Good …, <name>") and the author line of the user's own turn in the
 * thread panel.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const BUN = process.env.LILOS_BUN_BIN ?? "bun";

const SHOTS = path.join(repo, "test-results", "ac-118");

/** Read the relay-owned profile straight out of sqlite — AC-1 evidence that
   the identity is domain data, not page state. */
function storedSettings(home: string): Record<string, string> {
  const out = spawnSync(
    BUN,
    [
      "-e",
      `const db = new (await import("bun:sqlite")).Database(${JSON.stringify(
        path.join(home, "relay.sqlite"),
      )});
       console.log(JSON.stringify(db.query("SELECT user_name, company_name, avatar_color FROM profile WHERE id = 1").get() ?? {}));`,
    ],
    { encoding: "utf8" },
  );
  if (out.status !== 0) throw new Error(`sqlite read failed: ${out.stderr}`);
  return JSON.parse(out.stdout.trim() || "{}") as Record<string, string>;
}

/** The company's name: the sidebar's Company section label (#797 took it out
 *  of the toolbar — it names the section that holds the company's work). */
const companyLabel = (page: Page) =>
  v3Sidebar(page).locator("[data-company-label]");

const greeting = (page: Page) =>
  page.getByRole("heading", { level: 1, name: /^Good \w+, / });

test.describe.configure({ mode: "serial" });

test("AC-2 first run folds name+company into the Welcome, prefilled; AC-1 the choice is stored and shown", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack = await bootStack("ac118a", await pickPorts(), {
    LILOS_USER_NAME: "Test User",
  });
  try {
    // No skipFirstRun: this is the first run.
    await page.goto(`${stack.webUrl}/?statusPollMs=500`);
    await expect(
      page.getByRole("heading", { name: "Welcome to LilOS" }),
    ).toBeVisible({ timeout: 30_000 });

    /* The name field sits on the Welcome's first step, prefilled from the
       OS user. (#885 dropped the company field — the name is all first run
       asks about you.) */
    const steps = page.getByRole("listitem").filter({ hasText: /\w/ });
    await expect(page.locator("[aria-current='step']")).toContainText(
      "Your name",
    );
    expect(await steps.count()).toBeGreaterThan(0);
    const nameInput = page.getByLabel("Your name");
    await expect(nameInput).toHaveValue("Test User", { timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/ac-2-first-run-prefilled.png` });

    await nameInput.fill("Ada");
    const next = page.getByRole("button", { name: "Next", exact: true });
    await next.click(); // → Your first agent
    await next.click(); // → First project
    await page.getByRole("button", { name: "Start", exact: true }).click();

    // Every surface renders the stored identity (AC-1).
    await expect(greeting(page)).toContainText("Ada", { timeout: 30_000 });
    /* #885: first run no longer asks a company name — the label derives
       from the person's name ("Ada's Co"). */
    await expect(companyLabel(page)).toHaveText("Ada's Co");
    // The company shows once: the toolbar names nothing, the page names
    // itself.
    await expect(page.locator("[data-v3-topbar]")).not.toContainText(
      "Ada's Co",
    );

    // The user's own message (`data-msg` wrapping the `data-userturn` bubble) is authored "Ada" in the thread panel — the name is on the line under the bubble, read by assistive tech.
    await v3Sidebar(page)
      .getByRole("button", { name: /Hermes/ })
      .click();
    await v3Main(page).getByRole("button", { name: "Message" }).click();
    await v3Peek(page)
      .getByPlaceholder("Message Hermes…")
      .fill("hello identity");
    await v3Peek(page).getByRole("button", { name: "Send" }).click();
    // The draft opened from the person's page: the thread joins that trail.
    await expect(page).toHaveURL(/[?&]open=([^&]*,)?thread:[^&,]+/, {
      timeout: 30_000,
    });
    const ownTurn = page
      .locator("[data-thread-panel] [data-msg]")
      .filter({ hasText: "hello identity" })
      .last();
    await expect(ownTurn).toContainText("Ada", { timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/ac-1-surfaces.png` });

    // And it is actually relay-owned: sqlite carries the row. #885: no
    // company field, so `company_name` stays unset — the label derives.
    await expect
      .poll(() => storedSettings(stack.home), { timeout: 10_000 })
      .toEqual({
        user_name: "Ada",
        company_name: null,
        avatar_color: "bg-blue-600",
      });
  } finally {
    await stack.stop();
  }
});

test("AC-4 an existing install without stored values shows the prefilled identity", async ({
  page,
}) => {
  const stack = await bootStack("ac118b", await pickPorts(), {
    LILOS_USER_NAME: "Test User",
  });
  try {
    await skipFirstRun(page);
    await page.goto(`${stack.webUrl}/`);
    // Onboarded → straight to Home, no Welcome.
    await expect(greeting(page)).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("heading", { name: "Welcome to LilOS" }),
    ).toHaveCount(0);
    await expect(page.locator("[data-first-run-step]")).toHaveCount(0);
    await expect(companyLabel(page)).toHaveText("Test's Co");
    await expect(greeting(page)).toContainText("Test User");
    await page.screenshot({ path: `${SHOTS}/ac-4-existing-install.png` });
  } finally {
    await stack.stop();
  }
});
