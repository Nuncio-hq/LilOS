import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { bootParts } from "./helpers/parts";
import { pickPorts, relayRpc, skipFirstRun, startChat } from "./helpers/stack";
import {
  banner,
  clipboard,
  expectHealthy,
  leg,
  openDetails,
  openEnginePane,
  openPolled,
  openTroubleshooting,
} from "./helpers/status";

/**
 * ACs 1-4 (issue #33) — the live status chain end to end on the real app: a
 * real relay, the real harness with engine-fake, and the app polling
 * `system.status` (`?statusPollMs=500`). Components are killed one by one and
 * the status surfaces are asserted to explain each failure in one line.
 *
 * v3: the status surfaces are the banner above every page (drawn only while a
 * leg is down or reconnecting) with its Details dialog, and Settings → Engine
 * & models (always reachable: Local relay, Engine, Copy diagnostics). The old
 * sidebar row ("All systems normal") has no v3 counterpart, so a healthy
 * chain reads off Settings and the diagnostics bundle. A stale-protocol
 * harness is named in the Details dialog and, with which side to update, in
 * the bundle (`update the relay`); the page-level "update the relay" banner
 * is gone. The bundle carries no log tails: the app polls with `logLines: 0`.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac33");

/** A harness whose engine can never start: the launcher's program is missing. */
const BROKEN_ENGINE = {
  LILOS_ENGINE: "command",
  LILOS_ENGINE_COMMAND: "/nonexistent/lilos-engine",
};

test.describe("AC-1-4 (#33) live system status", () => {
  test.setTimeout(150_000);
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("AC-1+4 healthy chain reads Connected + Running, with RSS + live sessions in the bundle", async ({
    page,
  }) => {
    const parts = await bootParts("ac33a", await pickPorts());
    try {
      // Two live engine sessions, started the way a person does.
      await skipFirstRun(page);
      for (const text of ["first live session", "second live session"])
        await startChat(
          page,
          parts.webUrl,
          { id: "default", name: "Default" },
          text,
        );
      await openPolled(page, parts.webUrl);
      await expectHealthy(page);

      await openEnginePane(page);
      const main = await openTroubleshooting(page);
      await expect(main).toContainText("Local relay");
      /* The heartbeat carries the engine's RSS and session count into the
         row's reason; the bundle prints that row verbatim. */
      await expect
        .poll(
          async () => {
            await main
              .getByRole("button", { name: "Copy diagnostics" })
              .click();
            return clipboard(page);
          },
          { timeout: 60_000, intervals: [1_000] },
        )
        .toMatch(/running engine-fake · \d+ MB, 2 sessions/);
      await page.screenshot({
        path: path.join(SHOTS, "ac1-healthy.png"),
        fullPage: true,
      });
    } finally {
      await parts.stop();
    }
  });

  test("AC-1 each leg down in turn gets a one-line reason", async ({
    page,
  }) => {
    const parts = await bootParts("ac33b", await pickPorts(), {
      harnessEnv: BROKEN_ENGINE,
    });
    try {
      await openPolled(page, parts.webUrl);

      // Engine leg: the launcher fails repeatedly → the supervisor reports
      // "failed", shown as the plain reason (raw text sits behind Details).
      await expect(banner(page)).toContainText("couldn't start", {
        timeout: 90_000,
      });
      const dialog = await openDetails(page);
      const engine = leg(dialog, "Engine");
      await expect(engine).toContainText("down");
      await expect(engine).toContainText("couldn't start");
      await page.screenshot({
        path: path.join(SHOTS, "ac1-engine-down.png"),
        fullPage: true,
      });

      /* Harness leg: kill the harness process — its socket closes and the
         harness row falls, the engine and model rows wait on it. */
      await parts.kill("harness");
      await expect(leg(dialog, "Harness")).toContainText(
        "lost its connection",
        { timeout: 30_000 },
      );
      await expect(leg(dialog, "Engine")).toContainText("blocked");
      await page.screenshot({
        path: path.join(SHOTS, "ac1-harness-down.png"),
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(banner(page)).toContainText("lost its connection");
      await page.screenshot({
        path: path.join(SHOTS, "ac1-harness-banner.png"),
        fullPage: true,
      });

      // Relay leg: kill the relay — the client synthesizes all four rows.
      await parts.kill("relay");
      await expect(banner(page)).toContainText(/reconnecting|unreachable/i, {
        timeout: 30_000,
      });
      await page.screenshot({
        path: path.join(SHOTS, "ac1-relay-down.png"),
        fullPage: true,
      });
    } finally {
      await parts.stop();
    }
  });

  test("AC-2 a stale harness handshake names the side to update", async ({
    page,
  }) => {
    // No harness of its own: the stale one is the only thing that registers.
    const parts = await bootParts("ac33c", await pickPorts(), {
      harness: false,
    });
    try {
      await openPolled(page, parts.webUrl);
      // A harness speaking a newer protocol gets rejected by the relay.
      await expect(
        relayRpc(page, parts, "harness.register", {
          protocolVersion: 9,
          version: "9.9.9",
        }),
      ).rejects.toThrow(/protocol version mismatch/);

      await expect(banner(page)).toContainText("different protocol version", {
        timeout: 30_000,
      });
      const dialog = await openDetails(page);
      await expect(leg(dialog, "Harness")).toContainText(
        "different protocol version",
      );
      // The raw rejection stays available, collapsed behind Details (#53).
      await leg(dialog, "Harness").getByText("Details").click();
      await expect(dialog).toContainText("harness spoke protocol 9", {
        timeout: 30_000,
      });
      await page.screenshot({
        path: path.join(SHOTS, "ac2-version-mismatch.png"),
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "Close" }).click();

      // …and the bundle says which side is stale.
      await openEnginePane(page);
      const main = await openTroubleshooting(page);
      await main.getByRole("button", { name: "Copy diagnostics" }).click();
      await expect
        .poll(() => clipboard(page), { timeout: 15_000 })
        .toContain("update the relay — harness spoke protocol 9");
    } finally {
      await parts.stop();
    }
  });

  test("AC-3 copy diagnostics ships versions and states, never the install token", async ({
    page,
  }) => {
    const parts = await bootParts("ac33d", await pickPorts());
    try {
      await openPolled(page, parts.webUrl);
      await expectHealthy(page);
      await openEnginePane(page);
      const main = await openTroubleshooting(page);
      /* The heartbeat's describe probe (engine name, RSS) lands on the
         harness's first full report, a beat after the relay and engine rows
         read healthy — the bundle is read until it carries the engine
         block, not once. */
      await expect
        .poll(
          async () => {
            await main
              .getByRole("button", { name: "Copy diagnostics" })
              .click();
            return clipboard(page);
          },
          { timeout: 60_000, intervals: [1_000] },
        )
        .toContain("rss: ");
      const bundle = await clipboard(page);
      expect(bundle).toContain("relay: ");
      expect(bundle).toContain("harness: ");
      expect(bundle).toContain("sessions: 0");
      // The install token rides in the page's config — it must never reach
      // the bundle.
      expect(bundle).not.toContain(parts.relayToken);
      await page.screenshot({
        path: path.join(SHOTS, "ac3-diagnostics.png"),
        fullPage: true,
      });
    } finally {
      await parts.stop();
    }
  });
});
