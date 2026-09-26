import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/**
 * ACs 1-4 (issue #53) — the live status chain speaks Oscar: each downed leg
 * shows a one-line plain reason + a next step with the raw error collapsed in
 * Details and kept in Copy diagnostics; legs that only wait on an upstream
 * failure render as neutral `blocked` and never count as issues; the banner
 * carries the short reason plus a "View status" action. Runs against a real
 * relay + the harness demo, like e2e/ac-33-status.spec.ts.
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const BUN =
  process.env.BUN ??
  (existsSync(join(homedir(), ".bun/bin/bun"))
    ? join(homedir(), ".bun/bin/bun")
    : "bun");
const SHOTS = join(REPO, "test-results", "ac53");

interface Proc {
  child: ChildProcess;
  out: string;
}

function spawnLogged(cmd: string[], env: Record<string, string>): Proc {
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const proc: Proc = { child, out: "" };
  child.stdout?.on("data", (d) => (proc.out += d));
  child.stderr?.on("data", (d) => (proc.out += d));
  return proc;
}

async function waitFor(proc: Proc, needle: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.out.includes(needle)) return;
    if (proc.child.exitCode !== null) {
      throw new Error(`process exited ${proc.child.exitCode}: ${proc.out}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for "${needle}": ${proc.out.slice(-800)}`);
}

async function startRelay(name: string) {
  const home = join(tmpdir(), `lilos-e2e-53-${name}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  const proc = spawnLogged([BUN, join(REPO, "apps/relay/src/index.ts")], {
    LILOS_RELAY_HOME: home,
    LILOS_RELAY_PORT: "0",
  });
  await waitFor(proc, "listening on http://");
  const port = /http:\/\/127\.0\.0\.1:(\d+)/.exec(proc.out)?.[1];
  if (!port) throw new Error(`no relay port in output: ${proc.out}`);
  const token = readFileSync(join(home, "relay-token"), "utf8").trim();
  return { proc, home, port, token };
}

function startHarness(env: {
  relayUrl: string;
  token: string;
  engine?: string;
}) {
  return spawnLogged([BUN, join(REPO, "apps/harness/scripts/demo-status.ts")], {
    LILOS_RELAY_URL: env.relayUrl,
    LILOS_RELAY_TOKEN: env.token,
    LILOS_ENGINE: env.engine ?? "fake",
    LILOS_DEMO_SESSIONS: "0",
    LILOS_STATUS_INTERVAL_MS: "800",
  });
}

const liveUrl = (port: string, token: string) =>
  `/?statusRelay=${encodeURIComponent(`ws://127.0.0.1:${port}/ws`)}&statusToken=${token}&statusPollMs=800`;

async function openDialog(page: Page) {
  const dialog = page.getByRole("dialog", { name: "System status" });
  if (!(await dialog.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "System status" }).click();
  }
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("AC-1-4 (#53) plain-language status + blocked legs", () => {
  test.setTimeout(120_000);
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  const cleanup = (procs: Proc[], homes: string[]) => {
    for (const p of procs) {
      try {
        p.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  };

  test("AC-1+3+4 engine down: plain reason, next step, Details, banner action", async ({
    page,
  }) => {
    const relay = await startRelay("engine");
    const broken = startHarness({
      relayUrl: `ws://127.0.0.1:${relay.port}/ws`,
      token: relay.token,
      engine: "broken",
    });
    try {
      await waitFor(broken, "registered with relay");
      await page.goto(liveUrl(relay.port, relay.token));

      // AC-3: the banner shows the short reason + View status, no raw error.
      const banner = page.locator("[data-status-banner]");
      await expect(banner).toContainText("couldn't start", {
        timeout: 60_000,
      });
      await expect(banner).not.toContainText("ENOENT");
      await expect(banner).not.toContainText("posix_spawn");

      const dialog = await openDialog(page);
      // AC-1: one-line plain reason + one next step on the Engine row.
      const engineRow = dialog.locator("div.flex.items-start", {
        has: page.getByText("Engine", { exact: true }),
      });
      await expect(engineRow).toContainText(
        "Engine couldn't start — the engine program wasn't found.",
        { timeout: 60_000 },
      );
      await expect(engineRow).toContainText(
        "Check the engine path in Settings",
      );
      // AC-2: the model leg is blocked, not down; sidebar counts one issue.
      const modelRow = dialog.locator("div.flex.items-start", {
        has: page.getByText("Model", { exact: true }),
      });
      await expect(modelRow).toContainText("blocked");
      await expect(modelRow).toContainText("Waiting for the engine");
      await expect(
        page.getByRole("button", { name: "System status" }),
      ).toContainText("1 issue");

      // AC-1: the raw error stays collapsed behind a Details line.
      const details = engineRow.locator("details");
      await expect(details.locator("pre")).toBeHidden();
      await details.locator("summary").click();
      await expect(details.locator("pre")).toBeVisible();
      await expect(details).toContainText("ENOENT");
      await page.screenshot({
        path: join(SHOTS, "ac53-engine-down.png"),
        fullPage: true,
      });

      // AC-1: Copy diagnostics keeps the raw error.
      await dialog.getByRole("button", { name: "Copy diagnostics" }).click();
      await expect(page.locator("body")).toContainText("Diagnostics copied");
      const bundle = await page.evaluate(() => navigator.clipboard.readText());
      expect(bundle).toContain("ENOENT");
      expect(bundle).toContain("failed to start");
      expect(bundle).not.toContain(relay.token);
    } finally {
      cleanup([relay.proc, broken], [relay.home]);
    }
  });

  test("AC-2+4 harness down: engine and model blocked, one issue", async ({
    page,
  }) => {
    const relay = await startRelay("harness");
    const harness = startHarness({
      relayUrl: `ws://127.0.0.1:${relay.port}/ws`,
      token: relay.token,
    });
    try {
      await waitFor(harness, "registered with relay");
      await page.goto(liveUrl(relay.port, relay.token));
      await expect(
        page.getByRole("button", { name: "System status" }),
      ).toContainText("All systems normal", { timeout: 30_000 });

      harness.child.kill("SIGKILL");
      const dialog = await openDialog(page);
      await expect(dialog).toContainText("Harness lost its connection", {
        timeout: 30_000,
      });
      // Both downstream legs wait on the harness — neutral, not issues.
      await expect(dialog.getByText("blocked")).toHaveCount(2);
      await expect(dialog).toContainText("Waiting for the harness");
      await expect(
        page.getByRole("button", { name: "System status" }),
      ).toContainText("1 issue");
      await page.screenshot({
        path: join(SHOTS, "ac53-harness-down.png"),
        fullPage: true,
      });
    } finally {
      cleanup([relay.proc, harness], [relay.home]);
    }
  });

  test("AC-2+3+4 relay down: three blocked legs and a plain banner", async ({
    page,
  }) => {
    const relay = await startRelay("relay");
    const harness = startHarness({
      relayUrl: `ws://127.0.0.1:${relay.port}/ws`,
      token: relay.token,
    });
    try {
      await waitFor(harness, "registered with relay");
      await page.goto(liveUrl(relay.port, relay.token));
      await expect(
        page.getByRole("button", { name: "System status" }),
      ).toContainText("All systems normal", { timeout: 30_000 });

      relay.proc.child.kill("SIGKILL");
      // AC-3: a plain reconnecting banner — no socket errors, no stack.
      const banner = page.locator("[data-status-banner]");
      await expect(banner).toContainText("reconnecting", { timeout: 30_000 });
      await expect(banner).not.toContainText("ECONNREFUSED");
      await page.screenshot({
        path: join(SHOTS, "ac53-relay-down.png"),
        fullPage: true,
      });

      const dialog = await openDialog(page);
      await expect(
        dialog.locator("div.flex.items-start", {
          has: page.getByText("Relay", { exact: true }),
        }),
      ).toContainText("connecting");
      await expect(dialog.getByText("blocked")).toHaveCount(3);
      await expect(dialog).toContainText("Waiting for the relay");
    } finally {
      cleanup([relay.proc, harness], [relay.home]);
    }
  });
});
