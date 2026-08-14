// 更新窗口专用 preload：只暴露最小更新 API（contextIsolation + sandbox 下安全桥接）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshUpdate', {
  getState: () => ipcRenderer.invoke('update:get-state'),
  check: () => ipcRenderer.invoke('update:check'),
  start: () => ipcRenderer.invoke('update:start'),
  onProgress: (cb) => ipcRenderer.on('update:progress', (_e, msg) => cb(msg)),
  onDone: (cb) => ipcRenderer.on('update:done', (_e, result) => cb(result)),
});
