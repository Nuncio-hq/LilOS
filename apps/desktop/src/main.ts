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
import { app, BrowserWindow, ipcMain } from "electron";
import { diskVersionStore, helperServiceControl } from "./control";

/**
 * LilOS shell: registers the relay + harness launch agents (AC-1), shows live
 * status, and reconnects to the relay on every launch (AC-2). Quitting never
 * warns — launchd owns the services, so work continues without the app.
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
  if (!existsSync(tokenPath)) {
    relayNote = `no token at ${tokenPath} (relay not installed yet)`;
    // The relay agent may still be starting — retry so the app comes up clean
    // on first launch right after registration.
    connectTimer = setTimeout(connectRelay, 3_000);
    return;
  }
  const token = readFileSync(tokenPath, "utf8").trim();
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

app.whenReady().then(async () => {
  await ensureServices();
  connectRelay();
  const win = new BrowserWindow({
    width: 760,
    height: 560,
    title: "LilOS",
    webPreferences: { preload: join(UI_DIR, "preload.cjs") },
  });
  void win.loadFile(join(UI_DIR, "index.html"));
});

// Quitting is the AC-2 point: no warning, work continues in the agents.
app.on("window-all-closed", () => {
  if (connectTimer) clearTimeout(connectTimer);
  relay?.close();
  app.quit();
});
