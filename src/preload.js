const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clockBotApi", {
  getState: () => ipcRenderer.invoke("clockbot:get-state"),
  saveSettings: (settings) => ipcRenderer.invoke("clockbot:save-settings", settings),
  startMonitoring: (credentials) => ipcRenderer.invoke("clockbot:start-monitoring", credentials),
  stopMonitoring: () => ipcRenderer.invoke("clockbot:stop-monitoring"),
  runAction: (payload) => ipcRenderer.invoke("clockbot:run-action", payload),
  toggleLogWindow: () => ipcRenderer.invoke("clockbot:toggle-log-window"),
  getBarkSettings: () => ipcRenderer.invoke("clockbot:get-bark-settings"),
  saveBarkSettings: (settings) => ipcRenderer.invoke("clockbot:save-bark-settings", settings),
  clearBarkSettings: () => ipcRenderer.invoke("clockbot:clear-bark-settings"),
  openExtensionFolder: () => ipcRenderer.invoke("clockbot:open-extension-folder"),
  openExternalUrl: (targetUrl) => ipcRenderer.invoke("clockbot:open-external-url", targetUrl),
  clearStoredCredentials: () => ipcRenderer.invoke("clockbot:clear-stored-credentials"),
  closeWindow: () => ipcRenderer.invoke("clockbot:close-window"),
  resizeWindowToContent: (height) => ipcRenderer.send("clockbot:resize-window-to-content", height),
  updateDraftCredentials: (credentials) => ipcRenderer.send("clockbot:update-draft-credentials", credentials),
  onStateChanged: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("clockbot:state-changed", handler);
    return () => ipcRenderer.removeListener("clockbot:state-changed", handler);
  }
});
