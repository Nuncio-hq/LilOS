const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("spike", {
  register: (name) => ipcRenderer.invoke("svc:register", name),
  unregister: (name) => ipcRenderer.invoke("svc:unregister", name),
  status: (name) => ipcRenderer.invoke("svc:status", name),
  openSettings: () => ipcRenderer.invoke("svc:openSettings"),
  heartbeat: (name) => ipcRenderer.invoke("svc:heartbeat", name),
  version: () => ipcRenderer.invoke("app:version"),
});
