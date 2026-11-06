const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  displays: () => ipcRenderer.invoke('displays'),
  overlay: (id) => ipcRenderer.invoke('overlay', id),
  recordings: () => ipcRenderer.invoke('recordings'),
  appInfo: () => ipcRenderer.invoke('appInfo'),
  licenses: () => ipcRenderer.invoke('licenses'),
});
