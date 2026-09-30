import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";

/**
 * Build the Electron payload (`apps/desktop/scripts/dev.ts --payload-only`)
 * once per machine. Parallel workers race on the shared `build/app/` output
 * — concurrent `bun build` runs corrupt each other's write — so a tmpdir
 * lock serializes builds and fresh outputs skip building entirely.
 */
export async function ensureDesktopPayload(desktopDir: string): Promise<void> {
  const appDir = join(desktopDir, "build", "app");
  const inputs = ["src/main.ts", "src/preload.cjs", "src/index.html"].map((p) =>
    join(desktopDir, p),
  );
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
