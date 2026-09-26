const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lilos", {
  status: () => ipcRenderer.invoke("lilos:status"),
  ensure: () => ipcRenderer.invoke("lilos:ensure"),
  openSettings: () => ipcRenderer.invoke("lilos:open-settings"),
});
