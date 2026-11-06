const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  displays: () => ipcRenderer.invoke('displays'),
  overlay: (id) => ipcRenderer.invoke('overlay', id),
  overlayState: () => ipcRenderer.invoke('overlayState'),
  onOverlayState: (callback) => {
    const listener = (_, state) => callback(state);
    ipcRenderer.on('overlay-state', listener);
    return () => ipcRenderer.removeListener('overlay-state', listener);
  },
  recordings: () => ipcRenderer.invoke('recordings'),
  appInfo: () => ipcRenderer.invoke('appInfo'),
  licenses: () => ipcRenderer.invoke('licenses'),
});
