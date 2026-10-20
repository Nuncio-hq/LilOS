import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { bootParts } from "./helpers/parts";
import { pickPorts } from "./helpers/stack";
import {
  banner,
  clipboard,
  expectHealthy,
  leg,
  openDetails,
  openPolled,
} from "./helpers/status";

/**
 * ACs 1-4 (issue #53) — the live status chain speaks plainly: each downed leg
 * shows a one-line plain reason + a next step with the raw error collapsed in
 * Details and kept in Copy diagnostics; legs that only wait on an upstream
 * failure render as neutral `blocked`; the banner carries the short reason
 * plus a "Details" action. Runs against a real relay + the real harness, like
 * e2e/ac-33-status.spec.ts.
 *
 * v3: the banner names the one worst leg and opens the System status dialog;
 * the old sidebar's "N issues" summary has no counterpart, so "blocked legs
 * are not issues" reads as the banner naming the failed leg (never a blocked
 * one) while the blocked rows stay neutral in the dialog.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac53");

/** A harness whose engine can never start: the launcher's program is missing. */
const BROKEN_ENGINE = {
  LILOS_ENGINE: "command",
  LILOS_ENGINE_COMMAND: "/nonexistent/lilos-engine",
};

test.describe("AC-1-4 (#53) plain-language status + blocked legs", () => {
  test.setTimeout(150_000);
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("AC-1+3+4 engine down: plain reason, next step, Details, banner action", async ({
    page,
  }) => {
    const parts = await bootParts("ac53a", await pickPorts(), {
      harnessEnv: BROKEN_ENGINE,
    });
    try {
      await openPolled(page, parts.webUrl);

      // AC-3: the banner shows the short reason + Details, no raw error.
      await expect(banner(page)).toContainText("couldn't start", {
        timeout: 90_000,
      });
      await expect(banner(page)).not.toContainText("ENOENT");
      await expect(banner(page)).not.toContainText("posix_spawn");

      const dialog = await openDetails(page);
      // AC-1: one-line plain reason + one next step on the Engine row.
      const engine = leg(dialog, "Engine");
      await expect(engine).toContainText(
        "Engine couldn't start — the engine program wasn't found.",
        { timeout: 60_000 },
      );
      await expect(engine).toContainText("Check the engine path in Settings");
      // AC-2: the model leg is blocked, not down — neutral, never an issue.
      const model = leg(dialog, "Model");
      await expect(model).toContainText("blocked");
      await expect(model).toContainText("Waiting for the engine");
      await expect(banner(page)).not.toContainText("Model");

      // AC-1: the raw error stays collapsed behind a Details line.
      const details = engine.locator("details");
      await expect(details.locator("pre")).toBeHidden();
      await details.locator("summary").click();
      await expect(details.locator("pre")).toBeVisible();
      await expect(details).toContainText("ENOENT");
      await page.screenshot({
        path: path.join(SHOTS, "ac53-engine-down.png"),
        fullPage: true,
      });

      // AC-1: Copy diagnostics keeps the raw error.
      await dialog.getByRole("button", { name: "Copy diagnostics" }).click();
      await expect
        .poll(() => clipboard(page), { timeout: 15_000 })
        .toContain("ENOENT");
      const bundle = await clipboard(page);
      expect(bundle).toContain("failed to start");
      expect(bundle).not.toContain(parts.relayToken);
    } finally {
      await parts.stop();
    }
  });

  test("AC-2+4 harness down: engine and model blocked, the harness is the one named", async ({
    page,
  }) => {
    const parts = await bootParts("ac53b", await pickPorts());
    try {
      await openPolled(page, parts.webUrl);
      await expectHealthy(page);

      await parts.kill("harness");
      await expect(banner(page)).toContainText("Harness lost its connection", {
        timeout: 30_000,
      });
      const dialog = await openDetails(page);
      // Both downstream legs wait on the harness — neutral, not issues.
      await expect(dialog.getByText("blocked", { exact: true })).toHaveCount(2);
      await expect(dialog).toContainText("Waiting for the harness");
      await expect(banner(page)).not.toContainText(/Engine|Model/);
      await page.screenshot({
        path: path.join(SHOTS, "ac53-harness-down.png"),
        fullPage: true,
      });
    } finally {
      await parts.stop();
    }
  });

  test("AC-2+3+4 relay down: three blocked legs and a plain banner", async ({
    page,
  }) => {
    const parts = await bootParts("ac53c", await pickPorts());
    try {
      await openPolled(page, parts.webUrl);
      await expectHealthy(page);

      await parts.kill("relay");
      // AC-3: a plain reconnecting banner — no socket errors, no stack.
      await expect(banner(page)).toContainText(/reconnecting/i, {
        timeout: 30_000,
      });
      await expect(banner(page)).not.toContainText("ECONNREFUSED");
      await page.screenshot({
        path: path.join(SHOTS, "ac53-relay-down.png"),
        fullPage: true,
      });

      const dialog = await openDetails(page);
      await expect(leg(dialog, "Relay")).toContainText("connecting");
      await expect(dialog.getByText("blocked", { exact: true })).toHaveCount(3);
      await expect(dialog).toContainText("Waiting for the relay");
    } finally {
      await parts.stop();
    }
  });

  test("AC-2 regression (#84): relay restart drops host — harness re-registers and status heals", async ({
    page,
  }) => {
    const parts = await bootParts("ac53d", await pickPorts());
    try {
      await openPolled(page, parts.webUrl);
      await expectHealthy(page);

      /* A relay restart drops every host registration (relay state is
         in-memory). The harness's socket reconnects, but unless it
         re-registers on reconnect the relay keeps host=null forever and the
         page wedges on "harness down". The respawn reuses the same home and
         port, so the existing token stays valid. */
      await parts.kill("relay");
      /* Prove the page actually observed the outage — otherwise the heal
         assertion below passes on the stale healthy state. Wait for it
         BEFORE respawning: a restart that completes inside one status-poll
         tick heals through the client's stale snapshot, so the DOM may show
         the outage for well under a second (#190). */
      await expect(banner(page)).toContainText(
        /reconnecting|unreachable|lost its connection/i,
        { timeout: 30_000 },
      );
      await parts.restartRelay();

      // The harness re-registers on reconnect → host is set → status heals.
      await expect(banner(page)).toHaveCount(0, { timeout: 60_000 });
      await expectHealthy(page);
    } finally {
      await parts.stop();
    }
  });
});
