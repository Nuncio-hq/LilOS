import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron,
  type ElectronApplication,
  expect,
  type Page,
} from "@playwright/test";
import type { Stack } from "./stack";

const desktopDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "apps",
  "desktop",
);

/**
 * Build the Electron payload (`apps/desktop/scripts/dev.ts --payload-only`)
 * once per machine. Parallel workers race on the shared `build/app/` output
 * — concurrent `bun build` runs corrupt each other's write — so a tmpdir
 * lock serializes builds and fresh outputs skip building entirely.
 */
export async function ensureDesktopPayload(desktopDir: string): Promise<void> {
  const appDir = join(desktopDir, "build", "app");
  const srcDir = join(desktopDir, "src");
  /* Any change under src/ (imports included) needs a rebuild — a fixed file
     list once left a stale bundle running while the spec tested new code. */
  const inputs = (function walk(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    } catch {
      return [];
    }
  })(srcDir);
  const outputs = ["main.cjs", "preload.cjs", "index.html", "package.json"].map(
    (p) => join(appDir, p),
  );
  const newestInput = Math.max(
    ...inputs.filter(existsSync).map((p) => statSync(p).mtimeMs),
    0,
  );
  const fresh = () =>
    outputs.every((o) => existsSync(o) && statSync(o).mtimeMs >= newestInput);
  const lockDir = join(
    tmpdir(),
    `lilos-desktop-payload-${desktopDir.replaceAll(/[^a-zA-Z0-9]/g, "_")}.lock`,
  );
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline)
        throw new Error("desktop payload lock never released");
      await expect
        .poll(() => !existsSync(lockDir), { timeout: deadline - Date.now() })
        .toBe(true);
    }
  }
  try {
    if (fresh()) return;
    await new Promise<void>((resolve, reject) => {
      const build = spawn(
        "bun",
        [join(desktopDir, "scripts", "dev.ts"), "--payload-only"],
        { stdio: "inherit", env: { ...process.env } },
      );
      build.once("exit", (c) =>
        c === 0 ? resolve() : reject(new Error(`desktop build exit ${c}`)),
      );
    });
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * Screenshot an Electron window after it is visible AND painted — a bare
 * `page.screenshot` can race `ready-to-show`/first paint and throw
 * `captureScreenshot failed`. Waits via `expect.poll` on `isVisible()` and
 * two animation frames (never a fixed sleep), and retries, because the
 * window/paint state is still racy under load.
 */
export async function electronScreenshot(
  app: ElectronApplication,
  win: Page,
  path: string,
  attempts = 4,
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    await expect
      .poll(
        async () =>
          app.evaluate(
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0]?.isVisible() ?? false,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await win.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    try {
      await win.screenshot({ path });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Launch the desktop app against a booted stack, past first run.
 *
 * The shell shows Welcome until `localStorage["lilos-onboarded"]` is set, and
 * a fresh Electron profile never has it — so the window is flagged onboarded
 * and reloaded once (the reload keeps the hash, so a launch URL's
 * `#?page=…&open=…` lands where it says). A spec that is about first run
 * launches by hand instead.
 *
 * - `hash`: a `#?…` fragment, or the full URL `threadUrl`/`agentUrl` return.
 *   The packaged app loads from `file:`, where only the fragment navigates.
 * - `stateDir`: reuse a profile across a relaunch (tabs, cookies, the
 *   onboarded flag). Omitted, every launch gets a fresh scratch profile that
 *   is removed when the app closes — never the user's real Application
 *   Support.
 * - `env`: extra environment for the app process.
 */
export async function launchDesktop(
  stack: Stack,
  opts: { hash?: string; stateDir?: string; env?: Record<string, string> } = {},
): Promise<{ app: ElectronApplication; win: Page; stateDir: string }> {
  await ensureDesktopPayload(desktopDir);
  const stateDir =
    opts.stateDir ?? mkdtempSync(join(tmpdir(), "lilos-desktop-state-"));
  mkdirSync(stateDir, { recursive: true });
  const url = !opts.hash
    ? stack.webUrl
    : opts.hash.startsWith("#")
      ? `${stack.webUrl}/${opts.hash}`
      : opts.hash;
  const app = await _electron.launch({
    args:
      process.platform === "linux"
        ? [desktopDir, "--no-sandbox"]
        : [desktopDir],
    env: {
      ...process.env,
      LILOS_RELAY_HOME: stack.home,
      LILOS_RELAY_PORT: String(stack.ports.relay),
      LILOS_FEED_PORT: String(stack.ports.feed),
      LILOS_WEB_URL: url,
      LILOS_STATE_DIR: stateDir,
      ...opts.env,
    },
  });
  if (!opts.stateDir)
    app.once("close", () => rmSync(stateDir, { recursive: true, force: true }));
  const win = await app.firstWindow();
  await win.waitForURL((u) => u.href.startsWith(stack.webUrl), {
    timeout: 60_000,
  });
  const wasOnboarded = await win.evaluate(() => {
    const had = localStorage.getItem("lilos-onboarded") === "1";
    localStorage.setItem("lilos-onboarded", "1");
    return had;
  });
  if (!wasOnboarded) await win.reload();
  return { app, win, stateDir };
}
