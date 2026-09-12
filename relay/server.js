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

import fs from 'fs';
import http from 'http';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8788;
const JELLYFIN = process.env.JELLYFIN_URL || 'http://192.168.1.85:2101';

// userId -> Map(clientId -> client). A client:
//   { id, ws, name, kind, net, token, canPlay, devices:[], nowPlaying }
const users = new Map();
// userId -> clientId of the current active player (the one actually playing).
const active = new Map();

// userId -> { nowPlaying, queue, at }: the account's last known playback, kept
// after the client that produced it disconnects and across relay restarts.
// A client that opens with no active session anywhere adopts this, so the
// account never comes up on "Nothing playing" -- the song you left on your
// phone is what the desktop shows, paused where it was.
const lastSession = new Map();
const SESSIONS_FILE = process.env.SESSIONS_FILE || null;
try {
  if (SESSIONS_FILE && fs.existsSync(SESSIONS_FILE)) {
    for (const [uid, s] of Object.entries(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')))) lastSession.set(uid, s);
  }
} catch (e) { console.error('sessions load failed', e.message); }
let saveTimer = null;
function saveSessions() {
  if (!SESSIONS_FILE || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(lastSession))); }
    catch (e) { console.error('sessions save failed', e.message); }
  }, 2000);
}
function rememberSession(uid, patch) {
  const cur = lastSession.get(uid) || { nowPlaying: null, queue: null, at: 0 };
  lastSession.set(uid, { ...cur, ...patch, at: Date.now() });
  saveSessions();
}
function sessionMsg(uid) {
  const s = lastSession.get(uid);
  return s && s.nowPlaying ? { type: 'session', nowPlaying: s.nowPlaying, queue: s.queue || [], at: s.at } : null;
}

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

// The network a socket is on. Clients behind the same NAT share a public IP,
// which is our proxy for "same LAN". Behind nginx/CF we read the forwarded
// chain's last hop.
//
// Every private address is the relay's OWN LAN (the relay runs at home): a
// desktop connecting straight to :8788 shows as 192.168.1.x, a browser on the
// same LAN via nginx shows as ITS 192.168.1.y -- different strings, same
// network. Without this fold the web player never saw the speakers the desktop
// reported. A LAN client that hairpins through the public hostname arrives as
// the home's WAN IP, so that is folded into 'lan' too (learned at startup and
// refreshed hourly; HOME_PUBLIC_IP env overrides).
let homePublicIp = process.env.HOME_PUBLIC_IP || null;
async function learnPublicIp() {
  if (process.env.HOME_PUBLIC_IP) return;
  try {
    const r = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) });
    const ip = (await r.text()).trim();
    if (/^[0-9a-f.:]+$/i.test(ip)) homePublicIp = ip;
  } catch { /* keep the last known value */ }
}
learnPublicIp();
setInterval(learnPublicIp, 60 * 60 * 1000);

function isPrivate(ip) {
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip)
    || ip === '::1' || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);
}
function networkOf(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  let ip = xff[xff.length - 1] || req.socket.remoteAddress || 'unknown';
  ip = ip.replace(/^::ffff:/, '');
  if (isPrivate(ip) || (homePublicIp && ip === homePublicIp)) return 'lan';
  return ip;
}

// --- search ---------------------------------------------------------------
// Meilisearch sits on the docker network with no public port; this endpoint
// is the only way in. It checks the caller's Jellyfin token (cached), runs one
// multi-search over the four indexes and picks the Top result. See
// docs/search-plan.md.
const MEILI = process.env.MEILI_URL || 'http://meilisearch:7700';
const MEILI_KEY = process.env.MEILI_KEY || '';
const tokenCache = new Map(); // token -> { who, at }
async function whoIs(token) {
  const c = tokenCache.get(token);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.who;
  const who = await verify(token);
  if (who) tokenCache.set(token, { who, at: Date.now() });
  return who;
}
function tokenOf(req) {
  const h = req.headers.authorization || '';
  const m = /Token="([^"]+)"/.exec(h);
  if (m) return m[1];
  return req.headers['x-emby-token'] || new URL(req.url, 'http://x').searchParams.get('api_key') || null;
}
// Normalise for exact-match checks: case, accents, punctuation.
const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function search(q, { limit = 10, filter = null } = {}) {
  const track = { indexUid: 'tracks', q, limit: limit * 2, attributesToRetrieve: ['id', 'name', 'artists', 'artistIds', 'album', 'albumId', 'albumArtist', 'year', 'durationTicks', 'plays', 'hasLyrics'],
    attributesToCrop: ['lyrics'], cropLength: 12, attributesToHighlight: ['lyrics', 'name'], highlightPreTag: '\u0001', highlightPostTag: '\u0002', showRankingScore: true };
  if (filter) track.filter = filter;
  const body = { queries: [
    { indexUid: 'artists', q, limit, showRankingScore: true },
    { indexUid: 'albums', q, limit, showRankingScore: true },
    track,
    { indexUid: 'playlists', q, limit: 5, showRankingScore: true },
  ] };
  const r = await fetch(`${MEILI}/multi-search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEILI_KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(2500) });
  if (!r.ok) throw new Error(`meili ${r.status}`);
  const [artists, albums, tracks, playlists] = (await r.json()).results.map((x) => x.hits);
  // A lyric-only hit carries the matched line as a snippet; name hits do not.
  const nq = norm(q);
  for (const t of tracks) {
    const f = t._formatted || {};
    const hits = (x) => ((x || '').match(/\u0001/g) || []).length;
    // Show the lyric line when the lyrics matched more of the query than the title did.
    t.snippet = f.lyrics && hits(f.lyrics) > hits(f.name) ? f.lyrics.replace(/\s+/g, ' ').trim() : null;
    delete t._formatted;
  }
  // Top result: an exact artist wins, then an exact album, then the best
  // track by Meili's score; otherwise whichever entity scores highest with a
  // nudge towards artists (Spotify's behaviour).
  const exactA = artists.find((a) => norm(a.name) === nq || (a.aliases || []).some((x) => norm(x) === nq));
  const exactAl = albums.find((a) => norm(a.name) === nq);
  let top = null;
  if (exactA) top = { kind: 'Artist', item: exactA };
  else if (exactAl) top = { kind: 'Album', item: exactAl };
  else {
    const cands = [
      artists[0] && { kind: 'Artist', item: artists[0], s: (artists[0]._rankingScore || 0) + 0.05 },
      albums[0] && { kind: 'Album', item: albums[0], s: (albums[0]._rankingScore || 0) },
      tracks[0] && { kind: 'Song', item: tracks[0], s: (tracks[0]._rankingScore || 0) + (tracks[0].snippet ? -0.1 : 0.02) },
      playlists[0] && { kind: 'Playlist', item: playlists[0], s: (playlists[0]._rankingScore || 0) - 0.05 },
    ].filter(Boolean).sort((a, b) => b.s - a.s);
    top = cands[0] ? { kind: cands[0].kind, item: cands[0].item } : null;
  }
  // Meili's 'words' rule keeps partial matches for multi-word queries ("sit"
  // alone matches an artist for "sit next to me"); below this score they are
  // noise for entities, so hide them unless nothing better exists.
  const strong = (list) => { const s = list.filter((x) => (x._rankingScore || 0) >= 0.6); return s.length ? s : list.slice(0, 1); };
  return { top, artists: strong(artists), albums: strong(albums), tracks: tracks.slice(0, limit * 2), playlists: strong(playlists) };
}

const server = http.createServer(async (req, res) => {
  // Health check for Docker.
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/search' || url.pathname === '/relay/search') {
    // The desktop calls this cross-origin (file:// or localhost:5173).
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, X-Emby-Token, Content-Type', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const t0 = Date.now();
    try {
      const token = tokenOf(req);
      const who = token && await whoIs(token);
      if (!who) { res.writeHead(401, cors); res.end('{"error":"unauthorized"}'); return; }
      const q = (url.searchParams.get('q') || '').slice(0, 200);
      const limit = Math.min(50, Number(url.searchParams.get('limit')) || 10);
      const filter = url.searchParams.get('filter') || null;
      const out = q.trim() ? await search(q, { limit, filter }) : { top: null, artists: [], albums: [], tracks: [], playlists: [] };
      out.tookMs = Date.now() - t0;
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(503, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
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
  // Messages that land while the hello's token is still being verified (the
  // client flushes devices/claim/nowplaying right behind its hello). Dropping
  // them lost the desktop's speaker list until the next mDNS change.
  let verifying = false;
  const backlog = [];

  const onMessage = async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // First message must be hello with a token.
    if (!self) {
      if (verifying) { backlog.push(raw); return; }
      if (msg.type !== 'hello' || !msg.token) return;
      verifying = true;
      const who = await verify(msg.token);
      verifying = false;
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
        queue: null,
      };
      userMap(who.id).set(self.id, self);
      send(ws, { type: 'hello-ok', clientId: self.id, userId: who.id });
      broadcastRoster(self.uid);
      // The queues the user's other clients have already published, so this
      // client can show the active player's queue straight away.
      for (const c of userMap(self.uid).values()) {
        if (c.id !== self.id && c.queue) send(ws, { type: 'queue', from: c.id, queue: c.queue });
      }
      // Nobody is playing right now: hand over what the account played last.
      if (!active.has(self.uid)) { const sm = sessionMsg(self.uid); if (sm) send(ws, sm); }
      // Now replay what arrived during verification, in order.
      for (const b of backlog.splice(0)) await onMessage(b);
      return;
    }

    switch (msg.type) {
      // A client updates the LAN devices it can currently see.
      case 'devices':
        self.devices = Array.isArray(msg.devices) ? msg.devices : [];
        broadcastRoster(self.uid);
        break;

      // A client publishes its play queue (slim track objects). Kept per
      // client and fanned out to the user's other clients, so the queue panel
      // on a mirroring client shows what the active player will play next.
      case 'queue':
        self.queue = Array.isArray(msg.queue) ? msg.queue : null;
        if (self.queue && (!active.has(self.uid) || active.get(self.uid) === self.id)) rememberSession(self.uid, { queue: self.queue });
        for (const c of userMap(self.uid).values()) {
          if (c.id !== self.id) send(c.ws, { type: 'queue', from: self.id, queue: self.queue });
        }
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
        if (self.nowPlaying && (!active.has(self.uid) || active.get(self.uid) === self.id)) {
          rememberSession(self.uid, { nowPlaying: self.nowPlaying, queue: self.queue || (lastSession.get(self.uid) || {}).queue || null });
        }
        broadcastRoster(self.uid);
        break;

      // Account settings changed on one client (theme, quality): tell the
      // user's other clients so they repaint right away. Jellyfin holds the
      // persistent copy; this is only the live nudge.
      case 'prefs':
        for (const c of userMap(self.uid).values()) {
          if (c.id !== self.id) send(c.ws, { type: 'prefs', prefs: msg.prefs || {} });
        }
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
  };
  ws.on('message', onMessage);

  ws.on('close', () => {
    clearTimeout(timeout);
    if (self) {
      userMap(self.uid).delete(self.id);
      const wasActive = active.get(self.uid) === self.id;
      if (wasActive) active.delete(self.uid);
      broadcastRoster(self.uid);
      // The player that was driving the session is gone: the mirrors would
      // fall back to whatever they had locally, so give them the session to
      // keep showing (paused) instead.
      if (wasActive) {
        const sm = sessionMsg(self.uid);
        if (sm) for (const c of userMap(self.uid).values()) send(c.ws, sm);
      }
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
