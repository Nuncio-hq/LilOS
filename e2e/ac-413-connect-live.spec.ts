import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  type Stack,
  skipFirstRun,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #413 — the per-profile Connect state reaches the app live, not only
 * on load. Before the fix the connect rows were fetched once by
 * `system.status`; the flip to connected only surfaced on the next poll (or a
 * reload). The reconciled rows now ride `harness.report` → the relay's
 * `connect.changed` broadcast → the client-runtime status atom — no polling.
 *
 * v3 surfaces the same rows in two places: the Welcome "Connect <engine>"
 * step and Settings → Engine & models. (The DM's "Not connected to LilOS"
 * notice belonged to the deleted employee home; no v3 surface draws it.)
 *
 * AC-2 (engine-fake): Connect in Settings → the row flips to connected and
 * the Connect button goes, without a reload.
 * AC-1: first run's Connect step approves the same rows; Settings → Engine
 * then reads the live connected row.
 * `LILOS_CONNECT_FAKE=1` opts the fake stack into `FakeConnect` — the real
 * engine has no plugin to install, so rows stay off the default stack.
 */

const bootConnectStack = async (tag: string): Promise<Stack> =>
  bootStack(tag, await pickPorts(), {
    LILOS_ENGINE: "fake",
    LILOS_CONNECT_FAKE: "1",
  });

/** The Settings → Engine & models pane, reached the way a person gets there. */
async function openEnginePane(page: Page) {
  await v3Sidebar(page).getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Engine & models" }).click();
  await expect(page).toHaveURL(/[#?&]view=engine(&|$)/);
}

test("AC-2 Connect in Settings → Engine flips the row to connected live", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack = await bootConnectStack("ac413");
  try {
    // Past first run: the app lands on Home.
    await skipFirstRun(page);
    await page.goto(stack.webUrl);
    await openEnginePane(page);

    // The harness's FakeConnect reports the hired profile as not connected.
    const row = page.locator("[data-connect-state]").first();
    await expect(row).toHaveAttribute("data-connect-state", "not-connected", {
      timeout: 30_000,
    });
    const connect = page.getByRole("button", { name: "Connect", exact: true });
    await connect.click();

    // The reconciled row lands on connect.changed — the row and the button
    // update live (no reload, no second poll).
    await expect(row).toHaveAttribute("data-connect-state", "connected", {
      timeout: 10_000,
    });
    await expect(connect).toBeHidden();
  } finally {
    await stack.stop();
  }
});

test("AC-1 Welcome's Connect step approves, and Settings reads the same live row", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack = await bootConnectStack("ac413w");
  try {
    await skipFirstRun(page);
    await page.goto(stack.webUrl);
    // The step list is fixed when Welcome opens (Connect only appears once
    // the status poll has reported rows), so wait for the rows to exist
    // before opening Welcome through its own route.
    await openEnginePane(page);
    await expect(page.locator("[data-connect-state]").first()).toHaveAttribute(
      "data-connect-state",
      "not-connected",
      { timeout: 30_000 },
    );
    await page.evaluate(() => {
      location.hash = "#?page=welcome";
    });

    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator('[aria-current="step"]')).toContainText(
      /^\d+\s*Connect /,
    );
    await expect(
      page.locator('[data-connect-state="not-connected"]').first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    // The approval moved the step on; the same row is live in Settings.
    await expect(page.locator('[aria-current="step"]')).toContainText(
      "Your first agent",
      { timeout: 10_000 },
    );
    await page.getByRole("button", { name: "Set up later" }).click();
    await openEnginePane(page);
    await expect(
      page.locator('[data-connect-state="connected"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: "Connect", exact: true }),
    ).toBeHidden();
  } finally {
    await stack.stop();
  }
});
