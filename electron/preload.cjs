const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kolobok", Object.freeze({
  getVersion: () => ipcRenderer.invoke("app:version"),
  getCandles: (interval = "1h", limit = 120) => ipcRenderer.invoke("market:klines", interval, limit),
  getQuote: () => ipcRenderer.invoke("market:quote"),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  getNews: () => ipcRenderer.invoke("news:list"),
  getMoex: () => ipcRenderer.invoke("moex:status")
}));