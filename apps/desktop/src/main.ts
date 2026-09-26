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
import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { diskVersionStore, helperServiceControl } from "./control";

/**
 * LilOS shell: registers the relay + harness launch agents (AC-1/#34),
 * reconnects to the relay on every launch (AC-2/#34), then opens the app
 * window — apps/web, talking to that relay and the harness feed (#27).
 * Quitting never warns — launchd owns the services, so work continues
 * without the app.
 */

// `bun build` bakes __dirname to the source path, so resolve locations from
// getAppPath()/execPath with existence checks: packaged bundle puts lilos-svc
// and the UI next to Contents/MacOS/<exe> + Contents/Resources/app.
const APP_DIR = app.getAppPath();
const bundleHelper = join(dirname(process.execPath), "lilos-svc");

const paths = {
  helper: existsSync(bundleHelper)
    ? bundleHelper
    : join(APP_DIR, "build", "lilos-svc"),
  versionStoreFile: join(
    homedir(),
    "Library",
    "Application Support",
    "LilOS",
    "service-version",
  ),
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

function connectRelay(): void {
  const token = readRelayToken();
  if (!token) {
    relayNote = `no token at ${tokenPath} (relay not installed yet)`;
    // The relay agent may still be starting — retry so the app comes up clean
    // on first launch right after registration.
    connectTimer = setTimeout(connectRelay, 3_000);
    return;
  }
  relay = new RelayClient({
    url: relayUrl,
    token,
    client: { name: "lilos-desktop", version: app.getVersion() },
  });
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
    helper: paths.helper,
    agents: serviceReports,
    ensureError: lastEnsureError,
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

/* ------------------------------ windows --------------------------------- */

/**
 * The desktop app URL: explicit env override, else the packaged web bundle
 * (Contents/Resources/app/web), else a plain file from a sibling build of
 * apps/web, else the dev server on http://localhost:5200.
 */
function appUrl(): { file: string } | { url: string } {
  if (process.env.LILOS_WEB_FILE) return { file: process.env.LILOS_WEB_FILE };
  if (process.env.LILOS_WEB_URL) return { url: process.env.LILOS_WEB_URL };
  const bundled = join(APP_DIR, "web", "index.html");
  if (existsSync(bundled)) return { file: bundled };
  return { url: "http://localhost:5200" };
}

function createAppWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "LilOS",
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
  // Never open a new window; external links go to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  const target = appUrl();
  if ("file" in target) void win.loadFile(target.file);
  else void win.loadURL(target.url);
}

let statusWin: BrowserWindow | undefined;

/** Status surface (#34 AC-2): launch agents + live relay connection. */
function createStatusWindow(): void {
  if (statusWin) {
    statusWin.focus();
    return;
  }
  statusWin = new BrowserWindow({
    width: 760,
    height: 560,
    title: "LilOS Status",
    webPreferences: { preload: join(UI_DIR, "preload.cjs") },
  });
  statusWin.on("closed", () => {
    statusWin = undefined;
  });
  void statusWin.loadFile(join(UI_DIR, "index.html"));
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

ipcMain.handle("lilos:status", statusWithLiveAgents);
ipcMain.handle("lilos:ensure", () =>
  ensureServices().then(statusWithLiveAgents),
);
ipcMain.handle("lilos:open-settings", openLoginItemsSettings);
ipcMain.handle("lilos:open-status", createStatusWindow);

app.whenReady().then(async () => {
  await ensureServices();
  connectRelay();
  // One menu item: the #34 status window stays one click away.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "LilOS",
        submenu: [
          {
            label: "Service Status",
            accelerator: "CmdOrCtrl+,",
            click: createStatusWindow,
          },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { label: "Edit", role: "editMenu" },
      { label: "View", role: "viewMenu" },
    ]),
  );
  createAppWindow();
});

// Quitting is the AC-2 point: no warning, work continues in the agents.
app.on("window-all-closed", () => {
  if (connectTimer) clearTimeout(connectTimer);
  relay?.close();
  app.quit();
});
