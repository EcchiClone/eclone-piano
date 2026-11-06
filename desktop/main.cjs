const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, dialog } = require('electron');
const path = require('node:path');
const { projectPaths } = require('../shared/paths.cjs');
const { pathToFileURL } = require('node:url');
let studio,
  overlay,
  backend,
  paths,
  quitting = false;
app.setName('EClone Piano');
if (process.env.ECLONE_USER_DATA_DIR)
  app.setPath('userData', path.resolve(process.env.ECLONE_USER_DATA_DIR));
const base = 'http://127.0.0.1:3210';
function overlayState() {
  return { active: !!overlay && !overlay.isDestroyed(), displayId: overlay?.displayId ?? null };
}
function publishOverlayState() {
  if (studio && !studio.isDestroyed()) studio.webContents.send('overlay-state', overlayState());
}
function toggleOverlay(displayId) {
  if (overlay && !overlay.isDestroyed()) {
    overlay.close();
    overlay = null;
    return;
  }
  const display =
    screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
  const window = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    resizable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  overlay = window;
  window.displayId = display.id;
  publishOverlayState();
  const applyPassThrough = () => {
    if (window.isDestroyed()) return;
    window.setFocusable(false);
    // The entire overlay, including painted piano keys, is display-only.
    // forward:true is for interactive hover regions and uses a separate Windows
    // forwarding hook; we do not need that hook or its renderer-lifecycle state.
    window.setIgnoreMouseEvents(true, { forward: false });
  };
  const reveal = () => {
    if (window.isDestroyed()) return;
    applyPassThrough();
    if (!window.isVisible()) window.showInactive();
    // Chromium may update native styles when first displaying its HWND.
    applyPassThrough();
  };
  window.setAlwaysOnTop(true, 'screen-saver');
  applyPassThrough();
  window.on('show', applyPassThrough);
  window.on('ready-to-show', reveal);
  window.webContents.on('dom-ready', applyPassThrough);
  window.webContents.on('did-finish-load', reveal);
  window.on('focus', () => {
    applyPassThrough();
    window.blur();
  });
  window.loadURL(base + '/stage?transparent=1&overlay=1');
  window.on('closed', () => {
    if (overlay === window) overlay = null;
    publishOverlayState();
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (studio) {
      studio.show();
      studio.focus();
    }
  });
  app.whenReady().then(async () => {
    paths = projectPaths(undefined, {
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      dataDir: app.isPackaged ? path.join(app.getPath('userData'), 'recordings') : undefined,
    });
    try {
      const mod = await import(pathToFileURL(path.join(__dirname, '../server/index.js')));
      backend = await mod.startServer({
        onOverlay: toggleOverlay,
        dataDir: paths.recordings,
        paths,
      });
    } catch (e) {
      dialog.showErrorBox(
        'EClone Piano 실행 실패',
        e.message + '\n이미 실행 중인 서버가 있다면 종료한 후 다시 시작하세요.',
      );
      app.quit();
      return;
    }
    studio = new BrowserWindow({
      width: 1480,
      height: 960,
      minWidth: 1000,
      minHeight: 720,
      backgroundColor: '#0a1016',
      title: 'EClone Piano',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    studio.loadURL(base);
    studio.on('closed', () => {
      studio = null;
      if (!quitting) app.quit();
    });
    studio.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(base + '/stage')) {
        const view = new BrowserWindow({
          width: 1280,
          height: 720,
          backgroundColor: '#080d13',
          autoHideMenuBar: true,
        });
        view.loadURL(url);
      } else if (url.startsWith('https://')) shell.openExternal(url);
      return { action: 'deny' };
    });
    studio.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(base + '/')) event.preventDefault();
    });
    ipcMain.handle('displays', () =>
      screen.getAllDisplays().map((d) => ({
        id: d.id,
        label: d.label || `모니터 ${d.id}`,
        width: d.bounds.width,
        height: d.bounds.height,
      })),
    );
    ipcMain.handle('overlay', (_, id) => toggleOverlay(id));
    ipcMain.handle('overlayState', () => overlayState());
    ipcMain.handle('recordings', () => shell.openPath(paths.recordings));
    ipcMain.handle('appInfo', () => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
      recordings: paths.recordings,
    }));
    ipcMain.handle('licenses', () =>
      shell.openPath(
        app.isPackaged
          ? path.join(process.resourcesPath, 'licenses')
          : path.join(__dirname, '../LICENSE'),
      ),
    );
    globalShortcut.register('CommandOrControl+Shift+F10', () => toggleOverlay());
    globalShortcut.register('CommandOrControl+Shift+F12', () => {
      if (overlay) {
        overlay.close();
        overlay = null;
      }
      if (studio && !studio.isDestroyed()) {
        studio.show();
        studio.focus();
      }
    });
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    globalShortcut.unregisterAll();
    if (overlay) overlay.close();
    Promise.resolve(backend?.close()).finally(() => app.exit(0));
  });
}
