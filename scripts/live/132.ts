/**
 * Issue #132 live leg — a real ⌘, opens Settings inside the app window.
 *
 *   bun scripts/live/132.ts [--seconds N]
 *
 * Builds the desktop payload, boots the same dev stack the e2e specs use
 * (relay + harness with engine-fake + web on free ports), launches Electron
 * against it, then:
 *
 *   1. macOS: sends a REAL ⌘, key event via System Events → the app's own
 *      menu accelerator fires (the exact path Oscar's fingers take). Other
 *      OSes fall back to clicking the built menu item — same handler.
 *   2. asserts the Settings screen rendered inside the app window (AC-1/2)
 *   3. asserts "Service Status" still opens its own window (AC-1)
 *
 * Needs Accessibility permission for the terminal on macOS (the keystroke
 * is a real input event). Prints PASS/FAIL. Exit 0 only on PASS.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "@playwright/test";

const repo = process.env.LILOS_REPO_ROOT ?? process.cwd();
const webDir = join(repo, "apps", "web");
const desktopDir = join(repo, "apps", "desktop");
const BUN = process.env.LILOS_BUN_BIN ?? "bun";

const out = (line: string) => console.log(`[live-132] ${line}`);
let ok = false;
const fail = (line: string): never => {
  console.error(`[live-132] FAIL ${line}`);
  process.exit(1);
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

const waitForHttp = async (url: string, ms = 30_000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    const up = await fetch(url)
      .then((r) => r.ok || r.status === 404)
      .catch(() => false);
    if (up) return;
    if (Date.now() - start > ms) throw new Error(`timed out on ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

const procs: ChildProcess[] = [];
const cleanup = async () => {
  for (const p of procs)
    try {
      process.kill(-(p.pid ?? 0), "SIGKILL");
    } catch {
      try {
        p.kill("SIGKILL");
      } catch {}
    }
};
process.on("exit", () => {
  for (const p of procs)
    try {
      process.kill(-(p.pid ?? 0), "SIGKILL");
    } catch {
      try {
        p.kill("SIGKILL");
      } catch {}
    }
});

const [relayPort, feedPort, webPort] = await Promise.all([
  freePort(),
  freePort(),
  freePort(),
]);
const home = mkdtempSync(join(tmpdir(), "lilos-live-132-"));

out(`building desktop payload (${desktopDir})`);
const build = spawn(BUN, ["scripts/dev.ts", "--payload-only"], {
  cwd: desktopDir,
  env: { ...process.env },
  stdio: "inherit",
});
await new Promise<void>((resolve, reject) => {
  build.once("exit", (c) =>
    c === 0 ? resolve() : reject(new Error(`desktop build exit ${c}`)),
  );
});

out(`booting dev stack (home ${home})`);
const stack = spawn(BUN, ["run", "dev"], {
  cwd: webDir,
  detached: true,
  env: {
    ...process.env,
    LILOS_HOME: home,
    LILOS_RELAY_PORT: String(relayPort),
    LILOS_FEED_PORT: String(feedPort),
    LILOS_WEB_PORT: String(webPort),
  },
  stdio: "inherit",
});
procs.push(stack);
const webUrl = `http://127.0.0.1:${webPort}`;
await waitForHttp(webUrl);
await waitForHttp(`http://127.0.0.1:${relayPort}`);

out("launching LilOS (Electron)");
const app = await _electron.launch({
  args:
    process.platform === "linux"
      ? [desktopDir, "--no-sandbox"]
      : [desktopDir],
  env: {
    ...process.env,
    LILOS_RELAY_HOME: home,
    LILOS_RELAY_PORT: String(relayPort),
    LILOS_FEED_PORT: String(feedPort),
    LILOS_WEB_URL: webUrl,
  },
});

try {
  const win = await app.firstWindow();
  await win.waitForSelector("aside", { timeout: 60_000 });

  // The menu carries Settings… on ⌘,; Service Status has none.
  const menu = await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.items
      .find((i) => i.label === "LilOS")
      ?.submenu?.items.map((i) => ({
        id: i.id,
        label: i.label,
        accelerator: i.accelerator,
      })),
  );
  const settings = menu?.find((i) => i.id === "settings");
  if (settings?.accelerator !== "CmdOrCtrl+,")
    fail(`menu Settings… accelerator is ${settings?.accelerator ?? "missing"}`);
  if (menu?.find((i) => i.id === "service-status")?.accelerator)
    fail("Service Status must not carry an accelerator");
  out("menu carries Settings… on CmdOrCtrl+, and Service Status plain");

  if (process.platform === "darwin") {
    // A REAL ⌘, through the OS event tap → the app's own NSMenu fires —
    // the exact path a user's keypress takes. Needs Accessibility perms.
    const pid = app.process().pid;
    const act = spawnSync("osascript", [
      "-e",
      `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
    ]);
    if (act.status !== 0)
      out(`note: couldn't foreground the app (${act.stderr?.trim()})`);
    const ks = spawnSync("osascript", [
      "-e",
      'tell application "System Events" to keystroke "," using command down',
    ]);
    if (ks.status !== 0)
      fail(
        `real ⌘, keystroke failed (${ks.stderr?.trim()}) — grant the ` +
          "terminal Accessibility permission and re-run",
      );
    out("sent a real ⌘, keystroke to the app");
  } else {
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()?.getMenuItemById("settings")?.click(),
    );
    out("clicked the menu's Settings… item (same ⌘, handler)");
  }

  await win.waitForSelector('[role="dialog"][aria-label="Settings"]', {
    timeout: 15_000,
  });
  out("Settings opened inside the app window — AC-1/AC-2");

  // Service Status still opens its own window.
  const second = app.waitForEvent("window", { timeout: 15_000 });
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.getMenuItemById("service-status")?.click(),
  );
  await second;
  out("Service Status opened its own window — AC-1");

  ok = true;
} finally {
  await app.close();
  await cleanup();
}

if (!ok) fail("unreachable");
out("PASS — ⌘, opens Settings; Service Status stays its own menu item");
