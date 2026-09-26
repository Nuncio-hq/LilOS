const { contextBridge, ipcRenderer } = require("electron");

/**
 * The only Node-adjacent code in any LilOS window. One bridge serves both:
 * - the app window (apps/web) reads `lilos.config` — relay/engine endpoints +
 *   token handed over via additionalArguments — and `lilos.openStatus()`.
 * - the status window (src/index.html) uses the service IPC methods.
 * contextIsolation is on; nothing else crosses.
 */
const arg = (key) =>
  process.argv
    .find((a) => a.startsWith(`--lilos-${key}=`))
    ?.split("=")
    .slice(1)
    .join("=") ?? "";

contextBridge.exposeInMainWorld("lilos", {
  config: {
    relayWs: arg("relay"),
    relayToken: arg("token"),
    engineWs: arg("engine"),
  },
  platform: process.platform,
  status: () => ipcRenderer.invoke("lilos:status"),
  ensure: () => ipcRenderer.invoke("lilos:ensure"),
  openSettings: () => ipcRenderer.invoke("lilos:open-settings"),
  openStatus: () => ipcRenderer.invoke("lilos:open-status"),
});
