'use strict';
// LAN discovery for the two device families we can actually drive:
//   _googlecast._tcp  -> Chromecast / Google TV / Chromecast Audio (CASTV2 on :8009)
//   _musc._tcp        -> Bluesound / BluOS players (plain HTTP on :11000)
// BluOS supports neither Chromecast nor UPnP/DLNA by vendor decision, so it needs
// its own transport. Between them these two cover the whole house.

const { Bonjour } = require('bonjour-service');

const CAST_TYPE = 'googlecast';
const BLUOS_TYPE = 'musc';
const BLUOS_PORT = 11000;

class Discovery {
  constructor(onChange) {
    this.onChange = onChange;
    this.devices = new Map();
    this.bonjour = null;
    this.browsers = [];
  }

  start() {
    if (this.bonjour) return;
    this.bonjour = new Bonjour();
    const cast = this.bonjour.find({ type: CAST_TYPE }, (s) => this._add(this._fromCast(s)));
    const blu = this.bonjour.find({ type: BLUOS_TYPE }, (s) => this._add(this._fromBluOS(s)));
    this.browsers = [cast, blu];
    // Services that vanish (device powered off) should leave the picker.
    for (const b of this.browsers) b.on('down', (s) => this._remove(s));
  }

  stop() {
    for (const b of this.browsers) {
      try { b.stop(); } catch (e) { /* already torn down */ }
    }
    this.browsers = [];
    if (this.bonjour) {
      try { this.bonjour.destroy(); } catch (e) { /* already torn down */ }
      this.bonjour = null;
    }
  }

  list() {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  _address(service) {
    // Prefer IPv4; mDNS usually advertises both families.
    const v4 = (service.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    return v4 || (service.addresses || [])[0] || service.host;
  }

  _fromCast(service) {
    const txt = service.txt || {};
    return {
      id: `cast:${txt.id || service.fqdn || service.name}`,
      kind: 'cast',
      // `fn` is the user-set friendly name ("Living Room"); service.name is the raw id.
      name: txt.fn || service.name,
      model: txt.md || 'Google Cast',
      host: this._address(service),
      port: service.port || 8009,
    };
  }

  _fromBluOS(service) {
    return {
      id: `bluos:${this._address(service)}`,
      kind: 'bluos',
      name: service.name,
      model: 'BluOS',
      host: this._address(service),
      port: BLUOS_PORT,
    };
  }

  _add(dev) {
    if (!dev || !dev.host) return;
    this.devices.set(dev.id, dev);
    this.onChange(this.list());
  }

  _remove(service) {
    const host = this._address(service);
    for (const [id, d] of this.devices) {
      if (d.host === host) this.devices.delete(id);
    }
    this.onChange(this.list());
  }
}

module.exports = { Discovery, BLUOS_PORT };
