// Client side of the Conduit relay. One instance per running app. It keeps a
// WebSocket to the relay, publishes this client as a controllable player, and
// surfaces the user's other clients + network-scoped LAN devices as targets.
//
// Audio never flows through here. This is presence + command routing only.

// Same-origin in the browser (wss via nginx); the desktop app points at the LAN
// relay directly.
function defaultUrl() {
  if (typeof window !== 'undefined' && window.conduit) return 'ws://192.168.1.85:8788/relay';
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/relay`;
  }
  return 'ws://192.168.1.85:8788/relay';
}

function clientId() {
  const KEY = 'conduit.relayClientId';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) { id = `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; localStorage.setItem(KEY, id); }
    return id;
  } catch {
    return `c_${Math.random().toString(36).slice(2)}`;
  }
}

export class Relay {
  constructor({ token, name, kind, canPlay = true, onRoster, onCommand }) {
    this.token = token;
    this.name = name;
    this.kind = kind; // 'desktop' | 'web' | 'mobile'
    this.canPlay = canPlay;
    this.onRoster = onRoster || (() => {});
    this.onCommand = onCommand || (() => {});
    this.id = clientId();
    this.ws = null;
    this.closed = false;
    this._backoff = 1000;
    this._pending = { devices: [], nowPlaying: null };
    this.connect();
  }

  connect() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(defaultUrl()); } catch { this._retry(); return; }
    this.ws = ws;

    ws.onopen = () => {
      this._backoff = 1000;
      this._send({ type: 'hello', token: this.token, clientId: this.id, name: this.name, kind: this.kind, canPlay: this.canPlay });
      // Flush whatever we last knew.
      if (this._pending.devices.length) this.reportDevices(this._pending.devices);
      if (this._pending.nowPlaying) this.reportNowPlaying(this._pending.nowPlaying);
      this._ping = setInterval(() => this._send({ type: 'ping' }), 25000);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'roster') this.onRoster({ players: m.players || [], lanDevices: m.lanDevices || [] });
      else if (m.type === 'command') this.onCommand(m.command, m.from);
    };
    ws.onclose = () => { clearInterval(this._ping); this._retry(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  _retry() {
    if (this.closed) return;
    setTimeout(() => this.connect(), this._backoff);
    this._backoff = Math.min(this._backoff * 2, 20000);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  reportDevices(devices) {
    this._pending.devices = devices;
    this._send({ type: 'devices', devices });
  }

  reportNowPlaying(np) {
    this._pending.nowPlaying = np;
    this._send({ type: 'nowplaying', nowPlaying: np });
  }

  // I just started playing here: make the user's other clients yield.
  claim() { this._send({ type: 'claim' }); }

  // Tell another client to do something.
  command(toClientId, command) {
    this._send({ type: 'command', to: toClientId, command });
  }

  close() {
    this.closed = true;
    clearInterval(this._ping);
    try { this.ws && this.ws.close(); } catch {}
  }
}
