const { contextBridge, ipcRenderer } = require("electron");

/**
 * The only Node-adjacent code in any LilOS window. One bridge serves both:
 * - the app window (apps/web) reads `lilos.config` — relay/engine endpoints +
 *   token handed over via additionalArguments — and `lilos.openStatus()`.
 * - the status window (src/index.html) uses the service/update IPC methods.
 * contextIsolation is on; nothing else crosses.
 */
const arg = (key) =>
  process.argv
    .find((a) => a.startsWith(`--lilos-${key}=`))
    ?.split("=")
    .slice(1)
    .join("=") ?? "";

// Channel names mirror DESKTOP_NOTIFY_CHANNEL / DESKTOP_OPEN_CONVERSATION_CHANNEL
// / DESKTOP_FULLSCREEN_CHANNEL in packages/contracts/src/app/desktop.ts —
// sandboxed preload requires only expose electron's own modules, so the
// literals live here.
let fullScreen = false;
const fsListeners = new Set();
ipcRenderer.on("lilos:fullscreen", (_e, fs) => {
  fullScreen = fs === true;
  for (const cb of fsListeners) cb(fullScreen);
});

contextBridge.exposeInMainWorld("lilos", {
  // #246: the renderer floats its window only in a plain browser tab; inside
  // Electron the OS window is the frame. #232: `isDesktop` also flips
  // `data-desktop` on <html> (traffic-light inset, drag regions, sidebar
  // vibrancy); main pushes full-screen changes over lilos:fullscreen.
  isDesktop: true,
  config: {
    relayWs: arg("relay"),
    relayToken: arg("token"),
    engineWs: arg("engine"),
  },
  platform: process.platform,
  fullscreen: {
    current: () => fullScreen,
    onChange: (cb) => {
      fsListeners.add(cb);
      return () => fsListeners.delete(cb);
    },
  },
  // The app theme also drives the window's appearance (#232).
  setThemeSource: (t) => ipcRenderer.send("lilos:theme-source", t),
  status: () => ipcRenderer.invoke("lilos:status"),
  ensure: () => ipcRenderer.invoke("lilos:ensure"),
  openSettings: () => ipcRenderer.invoke("lilos:open-settings"),
  openStatus: () => ipcRenderer.invoke("lilos:open-status"),
  openApp: () => ipcRenderer.invoke("lilos:open-app"),
  checkUpdate: () => ipcRenderer.invoke("lilos:check-update"),
  // #539: the rollback notice's status read + Retry path.
  updateStatus: () => ipcRenderer.invoke("lilos:update-status"),
  retryUpdate: () => ipcRenderer.invoke("lilos:update-retry"),
  // #132 Settings: the app's version/build for About, and the menu's ⌘, →
  // lilos:open-app-settings event the renderer opens its Settings screen on.
  about: () => ipcRenderer.invoke("lilos:about"),
  onOpenSettings: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("lilos:open-app-settings", listener);
    return () =>
      ipcRenderer.removeListener("lilos:open-app-settings", listener);
  },
  // #32 notifications: renderer posts a DesktopNotification; a click on the
  // macOS notification delivers the conversation id back over
  // lilos:open-conversation.
  notifications: {
    post: (notification) => ipcRenderer.send("lilos:notify", notification),
  },
  onOpenConversation: (cb) => {
    const listener = (_e, id) => {
      if (typeof id === "string") cb(id);
    };
    ipcRenderer.on("lilos:open-conversation", listener);
    return () =>
      ipcRenderer.removeListener("lilos:open-conversation", listener);
  },
});

/* #674 AC-2: the renderer's `online` event is the "network came back"
   signal (Electron's main-process `net` is poll-only — no event); main may
   run an early update check off it, rate-limited there. */
window.addEventListener("online", () => ipcRenderer.send("lilos:online"));
