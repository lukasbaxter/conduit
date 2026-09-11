'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Jellyfin shows whatever we send as Device= in its session list, and the
// renderer only has navigator.platform ("MacIntel"), which is identical on
// every Mac. The real hostname therefore comes from the main process.
//
// It is passed via additionalArguments rather than require('os'): Electron
// sandboxes renderers by default, and a sandboxed preload may only require a
// short allowlist (electron, events, timers, url). Requiring 'os' here throws,
// which kills the WHOLE preload -- window.conduit ends up undefined and every
// device call silently does nothing.
function friendlyDeviceName() {
  const arg = process.argv.find((a) => a.startsWith('--conduit-device-name='));
  return arg ? decodeURIComponent(arg.split('=').slice(1).join('=')) : 'Desktop';
}

// Unwrap the {ok, value|error} envelope from main so callers can just await a
// value, while a device failure still raises a real Error they can catch.
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || res.ok !== true) throw new Error(res?.error || `${channel} failed`);
  return res.value;
}

// Report renderer crashes to the main process so they land in the trace file.
window.addEventListener('error', (e) => {
  ipcRenderer.send('renderer:error', `${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  ipcRenderer.send('renderer:error', `unhandled rejection: ${e.reason?.stack || e.reason}`);
});

contextBridge.exposeInMainWorld('conduit', {
  platform: process.platform,
  // Renderer-side breadcrumbs into the same trace file as device calls.
  debug: (msg) => ipcRenderer.send('renderer:debug', String(msg)),
  deviceName: friendlyDeviceName(),

  devices: {
    list: () => call('devices:list'),
    // Returns an unsubscribe function so React effects can clean up properly.
    onChanged: (cb) => {
      const handler = (_evt, devices) => cb(devices);
      ipcRenderer.on('devices:changed', handler);
      return () => ipcRenderer.removeListener('devices:changed', handler);
    },
  },

  remote: {
    play: (device, url, meta) => call('device:play', device, url, meta),
    resume: (device) => call('device:resume', device),
    pause: (device) => call('device:pause', device),
    stop: (device) => call('device:stop', device),
    seek: (device, seconds) => call('device:seek', device, seconds),
    setVolume: (device, level) => call('device:volume', device, level),
    status: (device) => call('device:status', device),
    identify: (device) => call('device:identify', device),
  },
});
