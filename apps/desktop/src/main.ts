import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AgentReport,
  ensureLaunchAgents,
  LILOS_AGENTS,
  plistFileName,
} from "@lilos/background";
import { RelayClient } from "@lilos/client-runtime";
import {
  DESKTOP_NOTIFY_CHANNEL,
  DESKTOP_ONLINE_CHANNEL,
  DESKTOP_OPEN_CONVERSATION_CHANNEL,
  DESKTOP_OPEN_SETTINGS_CHANNEL,
  DESKTOP_THEME_CHANNEL,
  type DesktopUpdateOutcome,
} from "@lilos/contracts/app";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  powerMonitor,
  shell,
} from "electron";
import { diskVersionStore, helperServiceControl } from "./control";
import { appMenuTemplate } from "./menu";
import { appDocumentUrl, guardWindow } from "./navigation-guard";
import { postDesktopNotification } from "./notify";
import { checkForUpdate } from "./update";
import {
  retryDelaysFromEnv,
  type UpdateScheduler,
  updateScheduler,
} from "./update/schedule";
import {
  addSkippedBuild,
  removeSkippedBuild,
  settlePendingUpdate,
  type UpdateStatus,
  updatePaths,
  writeStatus,
} from "./update/state";
import { nativeWindowChrome, watchWindowChrome } from "./window-chrome";

/**
 * LilOS shell: registers the relay + harness launch agents (AC-1/#34),
 * reconnects to the relay on every launch (AC-2/#34), then opens the app
 * window — apps/web, talking to that relay and the harness feed (#27).
 *
 * Release/update (#35): app + relay + harness share one stamped version; a
 * background feed check swaps the whole bundle via a detached applier and a
 * failed post-update handshake rolls the previous version back.
 * First run (#35 AC-2): when launchd wants approval the status window is the
 * guide — approve the background item and the app window opens on its own.
 * Quitting never warns — launchd owns the services, so work continues
 * without the app.
 *
 * Notifications (#32): the renderer sends validated DesktopNotifications over
 * `lilos:notify`; main posts a real macOS Notification and, on click, focuses
 * the window and sends `lilos:open-conversation` with the conversation id.
 */

// The app menu + window titles take the name from the app, not the dev
// binary: without this the macOS menu bar reads "Electron" (issue #71, AC-5).
app.setName("LilOS");

// `bun build` bakes __dirname to the source path, so resolve locations from
// getAppPath()/execPath with existence checks: packaged bundle puts lilos-svc
// and the UI next to Contents/MacOS/<exe> + Contents/Resources/app.
const APP_DIR = app.getAppPath();
const bundleHelper = join(dirname(process.execPath), "lilos-svc");

/** LilOS app-support dir: service pins + updater state. Env override so the
 * live proof on a dev machine doesn't touch real state. */
const stateDir =
  process.env.LILOS_STATE_DIR ??
  join(homedir(), "Library", "Application Support", "LilOS");

const paths = {
  helper: existsSync(bundleHelper)
    ? bundleHelper
    : join(APP_DIR, "build", "lilos-svc"),
  versionStoreFile: join(stateDir, "service-version"),
};

const UI_DIR = existsSync(join(APP_DIR, "preload.cjs"))
  ? APP_DIR
  : join(APP_DIR, "build", "app");

const relayHome = process.env.LILOS_RELAY_HOME ?? join(homedir(), ".lilos");
const relayPort = Number(process.env.LILOS_RELAY_PORT ?? "4577");
const relayHost = process.env.LILOS_RELAY_HOST ?? "127.0.0.1";
const relayUrl = `ws://${relayHost}:${relayPort}/ws`;
const tokenPath = join(relayHome, "relay-token");

// Harness feed ws — the read-only channel the app UI watches sessions on
// (apps/harness/src/feed.ts, bound on LILOS_FEED_PORT).
const feedPort = Number(process.env.LILOS_FEED_PORT ?? "4581");
const engineWs =
  process.env.LILOS_ENGINE_WS ?? `ws://${relayHost}:${feedPort}/ws`;

function readRelayToken(): string {
  try {
    return readFileSync(tokenPath, "utf8").trim();
  } catch {
    return "";
  }
}

/** Numeric build of the running bundle (CFBundleVersion); 0 in dev. */
function currentBuild(): number {
  try {
    const pkg = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8"));
    return Number(pkg.lilosBuild ?? 0);
  } catch {
    return 0;
  }
}

/** The installed .app — the update swap target; undefined in dev runs. */
const bundlePath = (() => {
  const p = dirname(dirname(dirname(APP_DIR)));
  return app.isPackaged && p.endsWith(".app") ? p : undefined;
})();
let serviceReports: AgentReport[] = [];
let lastEnsureError: string | undefined;

const svc = helperServiceControl(paths.helper);

async function ensureServices(): Promise<AgentReport[]> {
  try {
    serviceReports = await ensureLaunchAgents({
      control: svc,
      agents: LILOS_AGENTS,
      bundleVersion: app.getVersion(),
      versions: diskVersionStore(paths.versionStoreFile),
    });
    lastEnsureError = undefined;
    // update.log captures the app's stderr under the applier; keep one line
    // per agent so failed post-update verifications are diagnosable.
    console.error(
      `[lilos] agents: ${serviceReports.map((r) => `${r.label.split(".").pop()}=${r.status}/${r.action}${r.error ? ` ${r.error}` : ""}`).join(" ")}`,
    );
  } catch (error) {
    lastEnsureError = String(error);
  }
  return serviceReports;
}

function openLoginItemsSettings(): Promise<string> {
  return new Promise((resolve) => {
    execFile(paths.helper, ["open-settings"], (error) => {
      resolve(error ? `failed: ${error.message}` : "opened");
    });
  });
}

/* ------------------------------- relay ---------------------------------- */

let relay: RelayClient | undefined;
let welcome: Awaited<ReturnType<RelayClient["connect"]>> | undefined;
let relayNote = "not started";

let connectTimer: ReturnType<typeof setTimeout> | undefined;
let connectAttempt = 0;

function newRelayClient(): RelayClient {
  const token = readFileSync(tokenPath, "utf8").trim();
  return new RelayClient({
    url: relayUrl,
    token,
    client: { name: "lilos-desktop", version: app.getVersion() },
  });
}

function connectRelay(): void {
  const token = readRelayToken();
  if (!token) {
    relayNote = `no token at ${tokenPath} (relay not installed yet)`;
    // The relay agent may still be starting — retry so the app comes up clean
    // on first launch right after registration.
    connectTimer = setTimeout(connectRelay, 3_000);
    return;
  }
  relay = newRelayClient();
  // connect() rejection ends the client's own reconnect loop (it only retries
  // post-handshake drops), so retry here while the agent spins up.
  relay.connect().then(
    (w) => {
      welcome = w;
      relayNote = "";
      connectAttempt = 0;
    },
    (e) => {
      relayNote = `connect failed: ${e.message}`;
      connectTimer = setTimeout(
        connectRelay,
        Math.min(30_000, 2_000 * 2 ** connectAttempt++),
      );
    },
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One-shot connect for the post-update verifier: keeps retrying until the
 * re-registered relay answers or the deadline passes.
 */
async function connectOnce(deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      relay = newRelayClient();
      welcome = await relay.connect();
      relayNote = "";
      return;
    } catch (e) {
      relayNote = `connect failed: ${(e as Error).message}`;
      if (Date.now() >= deadline) throw e;
      await sleep(1_000);
    }
  }
}

interface RelayHealth {
  instanceId?: string;
  relayVersion?: string;
}

/** Live relay identity — /healthz reflects the *current* process after any
 * restart or internal reconnect; `welcome` alone goes stale. */
async function relayHealth(): Promise<RelayHealth> {
  try {
    const res = await fetch(`http://${relayHost}:${relayPort}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return {};
    return (await res.json()) as RelayHealth;
  } catch {
    return {};
  }
}

async function statusSnapshot() {
  const health = await relayHealth();
  return {
    version: app.getVersion(),
    build: currentBuild(),
    helper: paths.helper,
    agents: serviceReports,
    ensureError: lastEnsureError,
    update: updateStatus(),
    relay: {
      url: relayUrl,
      state: relay?.state.get() ?? "idle",
      note: relayNote,
      instanceId: health.instanceId ?? welcome?.instanceId,
      relayVersion: health.relayVersion ?? welcome?.relayVersion,
      engineHost: welcome?.engineHost,
      employees: relay?.employees.get().length,
    },
  };
}

/* ------------------------------ updates (#35) --------------------------- */

const updateBaseDir = stateDir;
const updateStateDir = join(updateBaseDir, "update");

function updateStatus(): UpdateStatus | undefined {
  try {
    const raw = readFileSync(join(updateStateDir, "status.json"), "utf8");
    return JSON.parse(raw) as UpdateStatus;
  } catch {
    return undefined;
  }
}

/* #539 AC-4: a rolled-back update was silent for eight builds — now the
   shell says it plainly once per failed build (the status.json `notified`
   flag keeps the dialog from re-firing on every launch while the Settings
   → About notice stays until the next update attempt). */
function markUpdateNotified(status: UpdateStatus): void {
  const { at: _at, notified: _n, ...rest } = status;
  writeStatus(updatePaths(updateBaseDir), { ...rest, notified: true });
}

async function retryUpdate(): Promise<DesktopUpdateOutcome> {
  const st = updateStatus();
  if (typeof st?.build === "number") {
    removeSkippedBuild(updateBaseDir, st.build);
  }
  const outcome = await checkAndApply();
  /* Un-skip only buys one attempt: a busy/failed retry re-skips the build
     so the periodic check doesn't silently retry a known-bad one. */
  if (outcome !== "apply-ready" && typeof st?.build === "number") {
    addSkippedBuild(updateBaseDir, st.build);
  }
  return outcome;
}

function notifyRolledBack(status: UpdateStatus): void {
  void dialog
    .showMessageBox({
      type: "warning",
      title: "Update failed",
      message: `Update to ${status.version ?? "the latest build"} failed — you're still on ${app.getVersion()}.`,
      detail:
        "LilOS rolled back to the last working build. You can retry the update or open Details to see what the updater saw.",
      buttons: ["Retry", "Details", "Dismiss"],
      defaultId: 1,
      cancelId: 2,
    })
    .then(({ response }) => {
      if (response === 0) void retryUpdate();
      else if (response === 1) createStatusWindow();
    });
}

let updatePoll: UpdateScheduler | undefined;
let updateCheckInFlight = false;

/** Feed check → stage → detached applier → quit. Dev builds skip.
 *  Returns the outcome so Settings → About's "Check for updates" can show
 *  it plainly (#132 AC-4). */
async function checkAndApply(): Promise<DesktopUpdateOutcome> {
  if (!bundlePath) return "disabled";
  if (updateCheckInFlight) return "busy";
  updateCheckInFlight = true;
  try {
    const outcome = await checkForUpdate({
      appVersion: app.getVersion(),
      currentBuild: currentBuild(),
      installPath: bundlePath,
      baseDir: updateBaseDir,
    });
    if (outcome === "apply-ready") {
      // The applier waits for this process to exit before swapping.
      app.quit();
    }
    return outcome;
  } finally {
    updateCheckInFlight = false;
  }
}

/**
 * Post-update gate (#35 AC-3/4): the freshly swapped build must prove it can
 * re-register its services, handshake the relay, and see relay + harness
 * converge on this release version — only then does it write boot-ok and the
 * applier calls the update good.
 */
async function verifyPostUpdate(): Promise<boolean> {
  try {
    await ensureServices();
    if (lastEnsureError) {
      console.error(`[lilos] verify: ensure failed: ${lastEnsureError}`);
      return false;
    }
    await connectOnce(30_000);
    const deadline = Date.now() + 60_000;
    const me = app.getVersion();
    let lastSeen = "no handshake";
    while (Date.now() < deadline) {
      try {
        const st = await relay?.systemStatus();
        if (st) {
          lastSeen = `relay=${st.versions.relay} harness=${st.versions.harness} mismatch=${st.mismatch}`;
          if (
            !st.mismatch &&
            st.versions.relay === me &&
            st.versions.harness === me
          ) {
            console.error(`[lilos] verify: converged on ${me}`);
            return true;
          }
        }
      } catch {
        lastSeen = "relay unreachable";
      }
      await sleep(1_500);
    }
    console.error(`[lilos] verify: timed out — ${lastSeen} (want ${me})`);
    return false;
  } catch (e) {
    console.error(`[lilos] verify: ${(e as Error).message}`);
    return false;
  }
}

/* ------------------------------ windows --------------------------------- */

/**
 * The desktop app URL: explicit env override, else the packaged web bundle
 * (Contents/Resources/app/web), else a plain file from a sibling build of
 * apps/web, else the dev server on http://localhost:5200. Packaged builds
 * without a web bundle keep the status window.
 */
function appUrl(): { file: string } | { url: string } | undefined {
  if (process.env.LILOS_WEB_FILE) return { file: process.env.LILOS_WEB_FILE };
  if (process.env.LILOS_WEB_URL) return { url: process.env.LILOS_WEB_URL };
  const bundled = join(APP_DIR, "web", "index.html");
  if (existsSync(bundled)) return { file: bundled };
  if (app.isPackaged) return undefined;
  return { url: "http://localhost:5200" };
}

let mainWindow: BrowserWindow | undefined;

/* #565: rendered links (agent markdown can carry any scheme) only leave the
   app through this path — the scheme filter lives in navigation-guard. */
const openInBrowser = (url: string) => {
  void shell.openExternal(url).catch((e) => {
    console.warn(`[lilos] openExternal failed for ${url}:`, e);
  });
};

/* #132 AC-1: ⌘, / LilOS → Settings… asks the app window to open its
   Settings screen. When no app window exists yet (the approval gate is up),
   one opens first and the request lands after it finishes loading. */
function openAppSettings(): void {
  if (!mainWindow) createAppWindow();
  const win = mainWindow;
  if (!win) return;
  const send = () => {
    // A Cmd+H-hidden app won't raise on win.focus() alone.
    app.focus({ steal: true });
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(DESKTOP_OPEN_SETTINGS_CHANNEL);
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function openConversation(conversationId: string): void {
  const win = mainWindow;
  if (!win) return;
  // A Cmd+H-hidden app won't raise on win.focus() alone.
  app.focus({ steal: true });
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send(DESKTOP_OPEN_CONVERSATION_CHANNEL, conversationId);
}

function wireNotifications(): void {
  ipcMain.on(DESKTOP_NOTIFY_CHANNEL, (event, raw: unknown) => {
    if (event.sender !== mainWindow?.webContents) return;
    if (!Notification.isSupported()) return;
    postDesktopNotification(raw, {
      show: (opts) => {
        const n = new Notification(opts);
        n.show();
        return { onClick: (cb) => n.on("click", cb) };
      },
      openConversation,
      onReject: (error) => console.warn("dropping bad notification:", error),
    });
  });
}

function createAppWindow(): void {
  const target = appUrl();
  if (!target) return; // no web surface in this bundle — status window stays
  if (mainWindow) {
    mainWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "LilOS",
    ...nativeWindowChrome("app"),
    webPreferences: {
      preload: join(UI_DIR, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      // The renderer reads relay/engine endpoints + token from argv.
      additionalArguments: [
        `--lilos-relay=${relayUrl}`,
        `--lilos-token=${readRelayToken()}`,
        `--lilos-engine=${engineWs}`,
      ],
    },
  });
  watchWindowChrome(win);
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  // #565: never open a new window, never navigate off the app's own origin;
  // https:/http:/mailto: links open in the user's browser instead.
  guardWindow(win.webContents, appDocumentUrl(target), openInBrowser);
  if ("file" in target) void win.loadFile(target.file);
  else void win.loadURL(target.url);
}

let statusWin: BrowserWindow | undefined;

/** Status + first-run surface (#34 status, #35 approve-the-agent guide). */
function createStatusWindow(): void {
  if (statusWin) {
    statusWin.focus();
    return;
  }
  const statusFile = join(UI_DIR, "index.html");
  statusWin = new BrowserWindow({
    width: 760,
    height: 560,
    title: "LilOS Status",
    ...nativeWindowChrome("status"),
    webPreferences: {
      preload: join(UI_DIR, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  watchWindowChrome(statusWin);
  statusWin.on("closed", () => {
    statusWin = undefined;
  });
  // #565: the status page has no links, but it gets the same guard anyway.
  guardWindow(
    statusWin.webContents,
    appDocumentUrl({ file: statusFile }),
    openInBrowser,
  );
  void statusWin.loadFile(statusFile);
}

/* -------------------------------- app ----------------------------------- */

async function statusWithLiveAgents() {
  // SMAppService status (enabled/requiresApproval) read fresh every snapshot,
  // even before ensureServices() has reported.
  const live = await Promise.all(
    LILOS_AGENTS.map(async (a) => {
      const plist = plistFileName(a);
      const report = serviceReports.find((r) => r.plist === plist);
      const status = await svc.status(plist).catch(() => "unknown");
      return {
        plist,
        label: a.label,
        status,
        action: report?.action,
        error: report?.error,
      };
    }),
  );
  return { ...(await statusSnapshot()), agents: live };
}

/**
 * AC-2 first-run gate: when a launch agent still needs the System Settings
 * toggle, the status window is what the user sees; the app window opens by
 * itself the moment both agents report enabled. Polls cheaply — the helper's
 * `status` call is a fast local read.
 */
function watchApprovalGate(): void {
  const t = setInterval(async () => {
    const snap = await statusWithLiveAgents();
    const needsApproval = snap.agents.some(
      (a) => a.status === "requiresApproval",
    );
    if (needsApproval) return;
    clearInterval(t);
    createAppWindow();
    if (statusWin && mainWindow) statusWin.close();
  }, 1_000);
}

ipcMain.handle("lilos:status", statusWithLiveAgents);
ipcMain.handle("lilos:ensure", () =>
  ensureServices().then(statusWithLiveAgents),
);
ipcMain.handle("lilos:open-settings", openLoginItemsSettings);
ipcMain.handle("lilos:open-status", createStatusWindow);
ipcMain.handle("lilos:open-app", createAppWindow);
ipcMain.handle("lilos:check-update", () => checkAndApply());
ipcMain.handle("lilos:update-status", () => updateStatus());
ipcMain.handle("lilos:update-retry", retryUpdate);
/* #132: Settings → About reads the app's own version/build (the relay's
   version comes from system.status in the renderer). */
ipcMain.handle("lilos:about", () => ({
  version: app.getVersion(),
  build: currentBuild(),
}));

// #232: the app's theme drives the window's appearance — vibrancy material,
// traffic lights and prefers-color-scheme — so the sidebar stays readable in
// either direction (dark app on light OS and vice versa).
ipcMain.on(DESKTOP_THEME_CHANNEL, (_e, raw: unknown) => {
  if (raw === "light" || raw === "dark" || raw === "system")
    nativeTheme.themeSource = raw;
});

// #674 AC-2: the preload forwards the renderer's `online` event — the
// network came back, so an update check may be due (scheduler rate-limits).
ipcMain.on(DESKTOP_ONLINE_CHANNEL, () => updatePoll?.poke());

app.whenReady().then(async () => {
  // #35: settle a pending swap before anything else opens. On the freshly
  // swapped build this verifies services + handshake and writes boot-ok (or
  // exits so the applier rolls back); on the old build it records the skip.
  const settle = await settlePendingUpdate(
    updateBaseDir,
    app.getVersion(),
    verifyPostUpdate,
  );
  if (settle === "failed") {
    app.exit(1);
    return;
  }

  await ensureServices();
  connectRelay();
  // The LilOS menu (#132): ⌘, opens Settings in the app window; the #34
  // status window stays one click away on its own item, no accelerator.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate(openAppSettings, createStatusWindow),
    ),
  );
  wireNotifications();

  const snap = await statusWithLiveAgents();
  const needsApproval = snap.agents.some(
    (a) => a.status === "requiresApproval",
  );
  if (needsApproval) {
    createStatusWindow();
    watchApprovalGate();
  } else {
    createAppWindow();
  }

  // #539 AC-4: a rollback used to be silent — say it once per failed build.
  if (settle === "rolled-back") {
    const st = updateStatus();
    if (st?.phase === "rolled-back" && !st.notified) {
      markUpdateNotified(st);
      notifyRolledBack(st);
    }
  }

  // #35 auto-update: packaged builds poll the feed; the interval is long so
  // checks stay cheap, and LILOS_UPDATE_CHECK_MS shortens it for tests.
  // #674: a failed check retries on the LILOS_UPDATE_RETRY_MS ladder
  // (1/5/15 min default) instead of waiting a whole interval, and sleep /
  // network-return triggers poke an early check, rate-limited to 10 min.
  if (bundlePath) {
    updatePoll = updateScheduler({
      check: checkAndApply,
      intervalMs: Number(process.env.LILOS_UPDATE_CHECK_MS ?? 4 * 60 * 60e3),
      retryDelaysMs: retryDelaysFromEnv(process.env),
    });
    updatePoll.start();
    powerMonitor.on("resume", () => updatePoll?.poke());
  }
});

// Quitting is the AC-2 point: no warning, work continues in the agents.
app.on("window-all-closed", () => {
  if (connectTimer) clearTimeout(connectTimer);
  updatePoll?.stop();
  relay?.close();
  app.quit();
});
