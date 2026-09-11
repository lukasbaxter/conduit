'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Unwrap the {ok, value|error} envelope from main so callers can just await a
// value, while a device failure still raises a real Error they can catch.
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || res.ok !== true) throw new Error(res?.error || `${channel} failed`);
  return res.value;
}

contextBridge.exposeInMainWorld('conduit', {
  platform: process.platform,

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
