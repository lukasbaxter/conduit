// Conduit relay — Spotify-Connect-style control plane.
//
// What it does: a user's clients (desktop app, phone PWA) each hold a WebSocket
// here. The relay knows who is online, routes control commands between them, and
// broadcasts presence + now-playing so any client sees what the others are doing.
//
// What it deliberately does NOT do: touch audio. Streams always go
// device -> Jellyfin directly. This carries JSON control messages only.
//
// Auth: a client connects with its Jellyfin token; we verify it against Jellyfin
// and file the socket under that Jellyfin user id. A client only ever sees and
// commands its OWN user's other clients.
//
// Network scoping: each client reports the LAN devices it can see (the desktop
// app discovers Cast/BluOS; the browser reports none). We tag every client with
// the network it is on -- grouped by the public IP the socket arrived from --
// so a client is only offered LAN devices reported by clients on the SAME
// network. Your home speakers therefore appear only when you are home; a
// friend's TV only on her LAN.

import http from 'http';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8788;
const JELLYFIN = process.env.JELLYFIN_URL || 'http://192.168.1.85:2101';

// userId -> Map(clientId -> client). A client:
//   { id, ws, name, kind, net, token, canPlay, devices:[], nowPlaying }
const users = new Map();
// userId -> clientId of the current active player (the one actually playing).
const active = new Map();

function userMap(uid) {
  if (!users.has(uid)) users.set(uid, new Map());
  return users.get(uid);
}

// Verify a Jellyfin token and return the user id + name, or null.
async function verify(token) {
  try {
    const res = await fetch(`${JELLYFIN}/Users/Me`, {
      headers: { Authorization: `MediaBrowser Token="${token}"` },
    });
    if (!res.ok) return null;
    const u = await res.json();
    return { id: u.Id, name: u.Name };
  } catch {
    return null;
  }
}

// The network a socket is on: the public IP it arrived from. Clients behind the
// same NAT share it, which is our proxy for "same LAN". Behind nginx/CF we read
// the forwarded chain's last hop.
function networkOf(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || req.socket.remoteAddress || 'unknown';
}

const server = http.createServer((req, res) => {
  // Health check for Docker.
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(426); res.end('Upgrade Required');
});

const wss = new WebSocketServer({ server, path: '/relay' });

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// The roster one client should see: the user's other clients as players, plus
// the LAN devices reported by clients sharing this client's network.
function rosterFor(self) {
  const map = userMap(self.uid);
  const players = [];
  const lanDevices = [];
  for (const c of map.values()) {
    if (c.id !== self.id) {
      players.push({
        id: c.id, name: c.name, kind: c.kind, canPlay: c.canPlay,
        nowPlaying: c.nowPlaying || null, sameNetwork: c.net === self.net,
      });
    }
    // LAN devices are only offered to clients on the same network as the
    // reporter (including the reporter's own view of them).
    if (c.net === self.net) {
      for (const d of c.devices || []) {
        lanDevices.push({ ...d, viaClient: c.id });
      }
    }
  }
  return { type: 'roster', players, lanDevices, activeClientId: active.get(self.uid) || null };
}

function broadcastRoster(uid) {
  const map = userMap(uid);
  for (const c of map.values()) send(c.ws, rosterFor(c));
}

wss.on('connection', (ws, req) => {
  const net = networkOf(req);
  let self = null;

  const timeout = setTimeout(() => { if (!self) ws.close(4001, 'auth timeout'); }, 10000);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // First message must be hello with a token.
    if (!self) {
      if (msg.type !== 'hello' || !msg.token) return;
      const who = await verify(msg.token);
      if (!who) { ws.close(4003, 'bad token'); return; }
      clearTimeout(timeout);
      const kind = msg.kind || 'web';
      const cid = msg.clientId;
      let name = msg.name || who.name || 'Conduit';
      if (kind === 'web' || kind === 'mobile') {
        // Number browser/phone clients: "Web Player (1)", "(2)", ... Exclude a
        // reconnecting client's own prior entry (same clientId) so it keeps its
        // number instead of stepping to the next one on every reconnect.
        const used = new Set(
          [...userMap(who.id).values()]
            .filter((c) => (c.kind === 'web' || c.kind === 'mobile') && c.id !== cid)
            .map((c) => c.name)
        );
        let n = 1;
        while (used.has(`Web Player (${n})`)) n += 1;
        name = `Web Player (${n})`;
      }
      self = {
        id: msg.clientId || `c_${Math.random().toString(36).slice(2)}`,
        ws, uid: who.id, net,
        name,
        kind,
        token: msg.token,
        canPlay: msg.canPlay !== false,
        devices: [],
        nowPlaying: null,
      };
      userMap(who.id).set(self.id, self);
      send(ws, { type: 'hello-ok', clientId: self.id, userId: who.id });
      broadcastRoster(self.uid);
      return;
    }

    switch (msg.type) {
      // A client updates the LAN devices it can currently see.
      case 'devices':
        self.devices = Array.isArray(msg.devices) ? msg.devices : [];
        broadcastRoster(self.uid);
        break;

      // A client reports what it is playing, for the shared now-playing view.
      case 'nowplaying':
        self.nowPlaying = msg.nowPlaying || null;
        // Safety net: if nobody currently holds the active claim (e.g. the relay
        // just restarted and forgot) and this client is actually playing, adopt
        // it as active. Only a genuinely-playing client reports this -- clients
        // that are merely mirroring another session report nothing -- so this
        // never steals playback, it only recovers a dropped claim.
        if (self.nowPlaying && self.nowPlaying.playing && !active.has(self.uid)) {
          active.set(self.uid, self.id);
        }
        broadcastRoster(self.uid);
        break;

      // Route a command to another of the user's clients (play/pause/seek/etc.).
      // { type:'command', to:<clientId>, command:{...} }
      case 'command': {
        const target = userMap(self.uid).get(msg.to);
        if (target) send(target.ws, { type: 'command', from: self.id, command: msg.command });
        break;
      }

      // This client just started playing -> it becomes the sole active device;
      // tell every other client of this user to yield (pause). Spotify Connect's
      // single-active-device model.
      case 'claim': {
        active.set(self.uid, self.id);
        for (const c of userMap(self.uid).values()) {
          if (c.id !== self.id) send(c.ws, { type: 'command', from: self.id, command: { action: 'yield' } });
        }
        broadcastRoster(self.uid);
        break;
      }

      // Keepalive.
      case 'ping':
        send(ws, { type: 'pong' });
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(timeout);
    if (self) {
      userMap(self.uid).delete(self.id);
      if (active.get(self.uid) === self.id) active.delete(self.uid);
      broadcastRoster(self.uid);
    }
  });
  ws.on('error', () => {});
});

// Drop dead sockets.
setInterval(() => {
  for (const map of users.values()) {
    for (const c of map.values()) {
      if (c.ws.readyState === c.ws.CLOSED) map.delete(c.id);
    }
  }
}, 30000);

server.listen(PORT, () => console.log(`conduit-relay on :${PORT}, jellyfin=${JELLYFIN}`));
