'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { Discovery } = require('./discovery');
const { CastTransport } = require('./transports/cast');
const { BluOSTransport } = require('./transports/bluos');

const isDev = !app.isPackaged;

let win = null;
let discovery = null;
/** @type {Map<string, CastTransport|BluOSTransport>} */
const transports = new Map();

function transportFor(device) {
  if (!device || !device.id) throw new Error('No device supplied');
  let t = transports.get(device.id);
  if (!t) {
    t = device.kind === 'cast' ? new CastTransport(device) : new BluOSTransport(device);
    transports.set(device.id, t);
  }
  return t;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#0d0d10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open external links in the real browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.on('closed', () => { win = null; });
}

function startDiscovery() {
  discovery = new Discovery((devices) => {
    if (win && !win.isDestroyed()) win.webContents.send('devices:changed', devices);
  });
  discovery.start();
}

app.whenReady().then(() => {
  createWindow();
  startDiscovery();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (discovery) discovery.stop();
  for (const t of transports.values()) {
    if (typeof t.close === 'function') t.close();
  }
});

// --- IPC -------------------------------------------------------------------
// Every handler returns {ok, ...} rather than throwing across the bridge, so the
// renderer can surface a device error without an unhandled rejection.

const handle = (channel, fn) => {
  ipcMain.handle(channel, async (_evt, ...args) => {
    try {
      const value = await fn(...args);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
};

handle('devices:list', () => (discovery ? discovery.list() : []));

handle('device:play', (device, url, meta) => transportFor(device).play(url, meta));
handle('device:resume', (device) => transportFor(device).resume());
handle('device:pause', (device) => transportFor(device).pause());
handle('device:stop', (device) => transportFor(device).stop());
handle('device:seek', (device, seconds) => transportFor(device).seek(seconds));
handle('device:volume', (device, level) => transportFor(device).setVolume(level));
handle('device:status', (device) => transportFor(device).status());
handle('device:identify', (device) => {
  const t = transportFor(device);
  return typeof t.identify === 'function' ? t.identify() : { name: device.name };
});
