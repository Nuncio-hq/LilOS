const { app, BrowserWindow, ipcMain } = require("electron");
const { execFile } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// smappservice-helper sits next to the main Electron binary in Contents/MacOS.
const HELPER = path.join(path.dirname(process.execPath), "smappservice-helper");
const PLISTS = {
  relay: "com.nuncio.lilos.spike.relay.plist",
  harness: "com.nuncio.lilos.spike.harness.plist",
};
const LOG_DIR = path.join(os.homedir(), "Library", "Logs", "LilOSSpike");

function runHelper(args) {
  return new Promise((resolve) => {
    execFile(HELPER, args, { timeout: 20000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: err ? err.code : 0,
      });
    });
  });
}

ipcMain.handle("svc:register", (_e, name) =>
  runHelper(["register", PLISTS[name]]),
);
ipcMain.handle("svc:unregister", (_e, name) =>
  runHelper(["unregister", PLISTS[name]]),
);
ipcMain.handle("svc:status", (_e, name) =>
  runHelper(["status", PLISTS[name]]),
);
ipcMain.handle("svc:openSettings", () => runHelper(["open-settings"]));
ipcMain.handle("svc:heartbeat", (_e, name) => {
  try {
    const file = path.join(LOG_DIR, `lilos-${name}.log`);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    return lines.slice(-5).join("\n");
  } catch {
    return "(no heartbeat log yet)";
  }
});
ipcMain.handle("app:version", () => app.getVersion());

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 720,
    height: 520,
    title: "LilOSSpike",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
