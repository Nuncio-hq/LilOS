import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";

/**
 * ACs 1-4 (issue #33) — the live status chain end to end: a real relay, the
 * harness demo (register handshake + supervisor + engine-fake + status
 * reporter), and the prototype fed by `?statusRelay=…&statusToken=…`.
 * Components are killed one by one and the dialog is asserted to explain
 * each failure in one line.
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const BUN =
  process.env.BUN ??
  (existsSync(join(homedir(), ".bun/bin/bun"))
    ? join(homedir(), ".bun/bin/bun")
    : "bun");
const SHOTS = join(REPO, "test-results", "ac33");

interface Proc {
  child: ChildProcess;
  out: string;
}

function spawnLogged(
  cmd: string[],
  env: Record<string, string>,
  cwd = REPO,
): Proc {
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd,
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
  const home = join(tmpdir(), `lilos-e2e-33-${name}-${Date.now()}`);
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
  logFile: string;
  engine?: string;
  sessions?: number;
  tag?: string;
}) {
  const proc = spawnLogged(
    [BUN, join(REPO, "apps/harness/scripts/demo-status.ts")],
    {
      LILOS_RELAY_URL: env.relayUrl,
      LILOS_RELAY_TOKEN: env.token,
      LILOS_ENGINE: env.engine ?? "fake",
      LILOS_DEMO_SESSIONS: String(env.sessions ?? 0),
      LILOS_STATUS_INTERVAL_MS: "800",
      LILOS_DEMO_LOG: env.logFile,
      ...(env.tag ? { LILOS_ENGINE_TAG: env.tag } : {}),
    },
  );
  return proc;
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

test.describe("AC-1-4 (#33) live system status", () => {
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

  test("AC-1+4 healthy chain shows four ok rows with RSS + live sessions", async ({
    page,
  }) => {
    const relay = await startRelay("healthy");
    const tag = engineTag("ac33a");
    const harness = startHarness({
      relayUrl: `ws://127.0.0.1:${relay.port}/ws`,
      token: relay.token,
      logFile: join(relay.home, "harness-demo.log"),
      sessions: 2,
      tag,
    });
    try {
      await waitFor(harness, "registered with relay");
      await page.goto(liveUrl(relay.port, relay.token));
      await expect(
        page.getByRole("button", { name: "System status" }),
      ).toContainText("All systems normal", { timeout: 30_000 });

      const dialog = await openDialog(page);
      for (const label of ["Relay", "Harness", "Engine", "Model"]) {
        await expect(
          dialog.locator("span.font-medium", { hasText: label }).first(),
        ).toBeVisible();
      }
      await expect(dialog).toContainText("running engine-fake");
      await expect(dialog).toContainText("MB");
      await expect(dialog).toContainText("2 sessions");
      await expect(dialog).toContainText("running fake-small");
      await page.screenshot({
        path: join(SHOTS, "ac1-healthy.png"),
        fullPage: true,
      });
    } finally {
      cleanup([relay.proc, harness], [relay.home]);
      await expectNoEngineLeak(tag);
    }
  });

  test("AC-1 each leg down in turn gets a one-line reason", async ({
    page,
  }) => {
    const relay = await startRelay("down");
    const broken = startHarness({
      relayUrl: `ws://127.0.0.1:${relay.port}/ws`,
      token: relay.token,
      logFile: join(relay.home, "harness-demo.log"),
      engine: "broken",
    });
    try {
      await waitFor(broken, "registered with relay");
      await page.goto(liveUrl(relay.port, relay.token));

      // Engine leg: launcher fails repeatedly → supervisor reports "failed"
      // (shown as the plain reason since #53; raw text sits in the Details line).
      const dialog = await openDialog(page);
      await expect(dialog).toContainText("engine", { timeout: 60_000 });
      await expect(dialog.getByText("down").first()).toBeVisible({
        timeout: 60_000,
      });
      await expect(dialog).toContainText("couldn't start", { timeout: 60_000 });
      await page.screenshot({
        path: join(SHOTS, "ac1-engine-down.png"),
        fullPage: true,
      });

      // Harness leg: kill the harness process — its ws closes and the
      // harness/engine/model rows all fall.
      broken.child.kill("SIGKILL");
      await expect(dialog).toContainText("Harness", {});
      await expect(dialog).toContainText("lost its connection", {
        timeout: 30_000,
      });
      await page.screenshot({
        path: join(SHOTS, "ac1-harness-down.png"),
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "Close" }).click();
      await page.screenshot({
        path: join(SHOTS, "ac1-harness-banner.png"),
        fullPage: true,
      });

      // Relay leg: kill the relay — the client synthesizes all four rows.
      relay.proc.child.kill("SIGKILL");
      await expect(
        page.getByRole("button", { name: "System status" }),
      ).toContainText(/issue|unreachable|reconnect/i, { timeout: 30_000 });
      await page.screenshot({
        path: join(SHOTS, "ac1-relay-down.png"),
        fullPage: true,
      });
    } finally {
      cleanup([relay.proc, broken], [relay.home]);
    }
  });

  test("AC-2 a stale harness handshake names the side to update", async ({
    page,
  }) => {
    const relay = await startRelay("mismatch");
    try {
      await page.goto(liveUrl(relay.port, relay.token));
      // A harness speaking a newer protocol gets rejected; status names relay.
      await page.evaluate(
        async ({ port, token }) => {
          const ws = new WebSocket(
            `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
          );
          await new Promise((res, rej) => {
            ws.onopen = res;
            ws.onerror = rej;
          });
          const send = (o: unknown) => ws.send(JSON.stringify(o));
          const next = (id: string) =>
            new Promise<Record<string, unknown>>((res) => {
              ws.onmessage = (e) => {
                const f = JSON.parse(e.data as string);
                if (f.id === id) res(f);
              };
            });
          send({
            jsonrpc: "2.0",
            id: "h",
            method: "session.hello",
            params: { protocolVersion: 1, token },
          });
          await next("h");
          send({
            jsonrpc: "2.0",
            id: "r",
            method: "harness.register",
            params: { protocolVersion: 9, version: "9.9.9" },
          });
          const res = await next("r");
          ws.close();
          return res;
        },
        { port: relay.port, token: relay.token },
      );
      const dialog = await openDialog(page);
      await expect(dialog).toContainText("different protocol version", {
        timeout: 30_000,
      });
      // The raw rejection stays available, collapsed behind Details (#53).
      await dialog.getByText("Details").click();
      await expect(dialog).toContainText("harness spoke protocol 9", {
        timeout: 30_000,
      });
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(page.locator("body")).toContainText("update the relay", {
        timeout: 30_000,
      });
      await page.screenshot({
        path: join(SHOTS, "ac2-version-mismatch.png"),
        fullPage: true,
      });
    } finally {
      cleanup([relay.proc], [relay.home]);
    }
  });

  test("AC-3 copy diagnostics ships versions, states, redacted log tails", async ({
    page,
  }) => {
    const relay = await startRelay("diag");
    const tag = engineTag("ac33d");
    const harness = startHarness({
      relayUrl: `ws://127.0.0.1:${relay.port}/ws`,
      token: relay.token,
      logFile: join(relay.home, "harness-demo.log"),
      sessions: 1,
      tag,
    });
    try {
      await waitFor(harness, "registered with relay");
      await page.goto(liveUrl(relay.port, relay.token));
      await expect(
        page.getByRole("button", { name: "System status" }),
      ).toContainText("All systems normal", { timeout: 30_000 });
      const dialog = await openDialog(page);
      await dialog.getByRole("button", { name: "Copy diagnostics" }).click();
      await expect(page.locator("body")).toContainText("Diagnostics copied");

      const bundle = await page.evaluate(() => navigator.clipboard.readText());
      expect(bundle).toContain("relay: ");
      expect(bundle).toContain("harness: ");
      expect(bundle).toContain("rss: ");
      expect(bundle).toContain("sessions: 1");
      expect(bundle).toContain("Relay log");
      expect(bundle).toContain("Harness log");
      // The install token rides in the page URL — it must never reach the bundle.
      expect(bundle).not.toContain(relay.token);
      await page.screenshot({
        path: join(SHOTS, "ac3-diagnostics.png"),
        fullPage: true,
      });
    } finally {
      cleanup([relay.proc, harness], [relay.home]);
      await expectNoEngineLeak(tag);
    }
  });
});
