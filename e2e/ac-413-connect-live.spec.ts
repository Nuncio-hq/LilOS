import { expect, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #413 — the per-profile Connect state reaches the app live, not only
 * on load. Before the fix the DM's "Not connected to LilOS" notice and
 * Settings → Engine read rows fetched once by `system.status`; the flip to
 * connected only surfaced on the next poll (or a reload). The reconciled
 * rows now ride `harness.report` → the relay's `connect.changed` broadcast →
 * the client-runtime status atom — no polling.
 *
 * AC-2 (engine-fake): Connect → the notice disappears without reload.
 * AC-1: Settings → Engine reflects the same live row.
 * `LILOS_CONNECT_FAKE=1` opts the fake stack into `FakeConnect` — the real
 * engine has no plugin to install, so rows stay off the default stack.
 */

let stack: Stack;

test.beforeAll(async () => {
  stack = await bootStack("ac413", await pickPorts(), {
    LILOS_ENGINE: "fake",
    LILOS_CONNECT_FAKE: "1",
  });
});

test.afterAll(async () => {
  await stack?.stop();
});

test("AC-2+AC-1 Connect clears the DM notice live; Settings reads the same row", async ({
  page,
}) => {
  // Past first run: the app lands on the auto-hired employee's DM.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("lilos-onboarded", "1");
    } catch {}
  });
  await page.goto(stack.webUrl);

  const notice = page.locator("[data-not-connected]");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText("Not connected to LilOS");

  await notice.getByRole("button", { name: "Connect" }).click();

  // The reconciled row lands on connect.changed — the notice unmounts live.
  await expect(notice).toBeHidden({ timeout: 10_000 });

  // Settings → Engine reads the same live row — no second poll or reload.
  await page.locator("aside").getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Engine", exact: true }).click();
  await expect(
    dialog.locator('[data-connect-state="connected"]').first(),
  ).toBeVisible({ timeout: 10_000 });
});
