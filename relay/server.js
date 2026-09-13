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

// --- ListenBrainz scrobbling -----------------------------------------------
// The active player already reports what it plays; once a track has been
// heard for half its length (or 4 minutes) it is submitted as a listen to
// the account's ListenBrainz (token kept in the user's Conduit settings). That
// history is what feeds Explo's Weekly Exploration / Daily Jams.
const lbTokens = new Map();   // uid -> { user, token } | null
const lbSeen = new Map();     // clientId -> { itemId, startedAt, sent }
const lbLast = new Map();     // uid -> { itemId, at }: the last listen submitted for the account
async function lbTokenFor(self) {
  if (lbTokens.has(self.uid)) return lbTokens.get(self.uid);
  try {
    const r = await fetch(`${JELLYFIN}/DisplayPreferences/conduit?userId=${self.uid}&client=conduit`, { headers: { Authorization: `MediaBrowser Token="${self.token}"` }, signal: AbortSignal.timeout(5000) });
    const dp = r.ok ? await r.json() : null;
    const raw = dp?.CustomPrefs?.listenbrainz;
    const v = raw ? JSON.parse(raw) : null;
    lbTokens.set(self.uid, v && v.token ? v : null);
  } catch { lbTokens.set(self.uid, null); }
  return lbTokens.get(self.uid);
}
async function submitListen(lb, np) {
  const body = { listen_type: 'single', payload: [{ listened_at: Math.floor(Date.now() / 1000), track_metadata: {
    artist_name: (np.artist || '').split(',')[0].trim() || np.artist || 'Unknown', track_name: np.title, release_name: np.album || undefined,
    additional_info: { media_player: 'Conduit', submission_client: 'conduit-relay', duration_ms: np.duration ? Math.round(np.duration * 1000) : undefined } } }] };
  const r = await fetch('https://api.listenbrainz.org/1/submit-listens', { method: 'POST', headers: { Authorization: `Token ${lb.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  if (!r.ok) console.error('listenbrainz', r.status, (await r.text()).slice(0, 120));
}
async function maybeScrobble(self, np) {
  if (!np || !np.itemId || !np.playing) return;
  let st = lbSeen.get(self.id);
  if (!st || st.itemId !== np.itemId) { st = { itemId: np.itemId, startedAt: Date.now(), sent: false }; lbSeen.set(self.id, st); }
  if (st.sent) return;
  const pos = np.position || 0, dur = np.duration || 0;
  if (dur < 30) return;
  if (pos >= Math.min(240, dur / 2)) {
    st.sent = true;
    // Per ACCOUNT, not per socket: a reconnect (new client id) or a handoff
    // mid-song must not scrobble the same play twice. A replay counts again
    // only once the song could actually have finished.
    const last = lbLast.get(self.uid);
    if (last && last.itemId === np.itemId && Date.now() - last.at < Math.max(60, dur * 0.9) * 1000) return;
    lbLast.set(self.uid, { itemId: np.itemId, at: Date.now() });
    const lb = await lbTokenFor(self);
    if (lb) submitListen(lb, np).catch((e) => console.error('listenbrainz', e.message));
  }
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

// Operators typed into the box: artist:daft  album:discovery  year:2013
// year:2010-2015  genre:house  liked:  -- resolved to Meili filters; the rest
// of the words stay free text. artist:/album: names are looked up in their
// own index first (typo-tolerant) so "artist:dft pnk" still works.
async function meiliOne(index, body) {
  const r = await fetch(`${MEILI}/indexes/${index}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEILI_KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
  if (!r.ok) throw new Error(`meili ${r.status}`);
  return r.json();
}
const OP = /(^|\s)(artist|album|year|genre|liked|in):("([^"]*)"|(\S*))/gi;
async function parseOperators(raw, userId) {
  const filters = [];
  const chips = [];
  let text = raw;
  const ops = [...raw.matchAll(OP)];
  for (const m of ops) {
    const key = m[2].toLowerCase(), val = (m[4] ?? m[5] ?? '').trim();
    text = text.replace(m[0], ' ');
    if (key === 'year') {
      const r = /^(\d{4})(?:\s*-\s*(\d{4}))?$/.exec(val);
      if (r) { filters.push(r[2] ? `year ${r[1]} TO ${r[2]}` : `year = ${r[1]}`); chips.push({ key, label: r[2] ? `${r[1]}–${r[2]}` : r[1] }); }
    } else if (key === 'liked') {
      filters.push(`liked = "${userId}"`); chips.push({ key, label: 'Liked Songs' });
    } else if (key === 'artist' && val) {
      const hit = (await meiliOne('artists', { q: val, limit: 1 })).hits[0];
      if (hit) { filters.push(`artistIds = "${hit.id}"`); chips.push({ key, label: hit.name, id: hit.id }); }
    } else if (key === 'album' && val) {
      const hit = (await meiliOne('albums', { q: val, limit: 1 })).hits[0];
      if (hit) { filters.push(`albumId = "${hit.id}"`); chips.push({ key, label: hit.name, id: hit.id }); }
    } else if (key === 'genre' && val) {
      const f = await fetch(`${MEILI}/indexes/tracks/facet-search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEILI_KEY}` }, body: JSON.stringify({ facetName: 'genres', facetQuery: val }), signal: AbortSignal.timeout(2000) });
      const hit = f.ok ? (await f.json()).facetHits?.[0] : null;
      if (hit) { filters.push(`genres = "${hit.value.replace(/"/g, '\\"')}"`); chips.push({ key, label: hit.value }); }
    } else if (key === 'in' && val) {
      filters.push(`playlistIds = "${val}"`); chips.push({ key, label: 'this playlist' });
    }
  }
  return { text: text.replace(/\s+/g, ' ').trim(), filter: filters.join(' AND ') || null, chips };
}

async function search(rawQ, { limit = 10, filter: extraFilter = null, userId = null } = {}) {
  const { text: q, filter: opFilter, chips } = await parseOperators(rawQ, userId);
  const filter = [opFilter, extraFilter].filter(Boolean).join(' AND ') || null;
  const track = { indexUid: 'tracks', q, limit: limit * 2,
    attributesToRetrieve: ['id', 'name', 'artists', 'artistIds', 'album', 'albumId', 'albumArtist', 'year', 'durationTicks', 'plays', 'liked', 'hasLyrics', 'times'],
    attributesToHighlight: ['lyrics', 'name'], highlightPreTag: '\u0001', highlightPostTag: '\u0002', showRankingScore: true };
  if (filter) track.filter = filter;
  // With a filter the query is scoped to tracks (search within a playlist,
  // artist:, year:), so the entity indexes are not asked.
  const scoped = Boolean(filter);
  const body = { queries: scoped ? [track] : [
    { indexUid: 'artists', q, limit, showRankingScore: true },
    { indexUid: 'albums', q, limit, showRankingScore: true },
    track,
    { indexUid: 'playlists', q, limit: 5, showRankingScore: true },
  ] };
  const r = await fetch(`${MEILI}/multi-search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEILI_KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(2500) });
  if (!r.ok) throw new Error(`meili ${r.status}`);
  const results = (await r.json()).results.map((x) => x.hits);
  const [artists, albums, tracks, playlists] = scoped ? [[], [], results[0], []] : results;
  const nq = norm(q);
  for (const t of tracks) {
    const f = t._formatted || {};
    const hits = (x) => ((x || '').match(/\u0001/g) || []).length;
    // Lyric hit: the whole matching LINE (not a crop) and the second it starts
    // at, so the client can play the song from that line.
    t.snippet = null; t.snippetAt = null;
    if (f.lyrics && hits(f.lyrics) > hits(f.name)) {
      const lines = f.lyrics.split('\n');
      let best = -1, bestN = 0;
      lines.forEach((l, i) => { const n = hits(l); if (n > bestN) { bestN = n; best = i; } });
      if (best >= 0) { t.snippet = lines[best].trim(); t.snippetAt = Array.isArray(t.times) ? t.times[best] ?? null : null; }
    }
    delete t._formatted; delete t.times;
  }
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
  const strong = (list) => { const s2 = list.filter((x) => (x._rankingScore || 0) >= 0.6); return s2.length ? s2 : list.slice(0, 1); };
  return { top, artists: strong(artists), albums: strong(albums), tracks: tracks.slice(0, limit * 2), playlists: strong(playlists), chips, scoped };
}

// --- browse ---------------------------------------------------------------
// The tiles on the empty search page. Raw genre tags are a mess (600 spellings,
// "R&B" split into "R" and "B" by the tag delimiter), so each tag is filed
// under a bucket by bucketsOf() below; each bucket gets its track count and
// the cover of its most-played album. Cached for 10 minutes.
const BUCKETS = [
  { id: 'hiphop', name: 'Hip-Hop', color: '#4b7d9b' },
  { id: 'pop', name: 'Pop', color: '#8d67ab' },
  { id: 'electronic', name: 'Electronic', color: '#e13300' },
  { id: 'rock', name: 'Rock', color: '#e61e32' },
  { id: 'indie', name: 'Indie & Alternative', color: '#1e3264' },
  { id: 'rnb', name: 'R&B & Soul', color: '#ba5d07' },
  { id: 'kpop', name: 'K-Pop', color: '#e8115b' },
  { id: 'metal', name: 'Metal', color: '#503750' },
  { id: 'country', name: 'Country', color: '#d84000' },
  { id: 'jazz', name: 'Jazz & Blues', color: '#477d95' },
  { id: 'classical', name: 'Classical', color: '#7d4b32' },
  { id: 'latin', name: 'Latin', color: '#e1118c' },
  { id: 'reggae', name: 'Reggae & Dancehall', color: '#148a08' },
  { id: 'folk', name: 'Folk & Acoustic', color: '#a56752' },
  { id: 'chill', name: 'Chill & Ambient', color: '#0d73ec' },
  { id: 'soundtrack', name: 'Soundtracks', color: '#27856a' },
];
// One bucket per tag, decided by the tag's HEAD word (genre names are
// modifier + head: "emo rap" is rap, "pop punk" is punk, "dance-pop" is pop).
// Two-word heads ("trip hop", "drum and bass") are tried before one-word
// ones, then a few regex rescues for foreign and odd spellings. Tags that are
// years, track numbers or one-letter fragments are dropped.
const HEADS = {
  kpop: ['kpop', 'k pop', 'korean', 'k rap', 'k indie', 'k rock'],
  hiphop: ['rap', 'hop', 'hiphop', 'trap', 'drill', 'grime', 'phonk', 'crunk', 'bounce', 'boom bap', 'plugg', 'rage', 'conscious', 'dirty south', 'rapcore'],
  metal: ['metal', 'metalcore', 'deathcore', 'thrash', 'doom', 'sludge', 'nu metal', 'djent', 'grindcore'],
  rock: ['rock', 'punk', 'grunge', 'emo', 'shoegaze', 'britpop', 'hardcore', 'post hardcore', 'psychedelic', 'psychedelia', 'stoner', 'new wave', 'post punk', 'pop punk', 'surf', 'prog', 'progressive', 'glam', 'roll', 'krautrock', 'psychobilly', 'aor', 'industrial', 'screamo', 'alternrock', 'rockabilly', 'merseybeat', 'psychadelic', 'gothic'],
  electronic: ['electronic', 'electronica', 'electro', 'house', 'techno', 'trance', 'edm', 'dubstep', 'dnb', 'drum and bass', 'drum n bass', 'bass', 'drum', 'garage', 'breakbeat', 'breaks', 'breakstep', 'hardstyle', 'jungle', 'idm', 'step', 'dance', 'big beat', 'trip hop', 'glitch hop', 'synthwave', 'vaporwave', 'complextro', 'moombahton', 'hyperpop', 'glitch', 'brostep', 'eurodance', 'club', 'rave', 'wave', 'bassline', 'tech', 'electronique', 'elettronica', 'indietronica', 'funktronica', 'wonky', 'dj', 'hi nrg', 'nrg', 'electronica', 'boogie', 'electroclash', 'spacesynth', 'minimal', '댄스'],
  chill: ['ambient', 'chill', 'chillout', 'chillwave', 'chillsynth', 'lo fi', 'lofi', 'downtempo', 'lounge', 'sleep', 'meditation', 'new age', 'relax', 'study', 'chillhop', 'beats', 'instrumental', 'mood'],
  rnb: ['rnb', 'r b', 'r&b', 'soul', 'funk', 'motown', 'disco', 'neo soul', 'quiet storm', 'r', 'b', 'rhythm and blues', 'rhythm & blues', 'rhythm n blues', 'new jack swing'],
  country: ['country', 'americana', 'bluegrass', 'honky tonk', 'western', 'outlaw'],
  jazz: ['jazz', 'blues', 'swing', 'bebop', 'fusion', 'bossa nova', 'big band', 'ragtime', 'dixieland', 'j fusion'],
  classical: ['classical', 'orchestral', 'orchestra', 'symphony', 'symphonic', 'baroque', 'opera', 'piano', 'concerto', 'chamber', 'choral', 'romantic', 'romanticism', 'impressionism', 'neoclassical', 'ballet', 'art song', 'klassik', 'etude', 'early', 'minimalism'],
  soundtrack: ['soundtrack', 'soundtracks', 'ost', 'score', 'scores', 'film', 'films', 'movie', 'movies', 'anime', 'game', 'games', 'video game', 'musical', 'musicals', 'broadway', 'stage', 'screen', 'themes', 'tv', 'jeux video', 'juegos', 'peliculas', 'bandas sonoras', 'bandes originales', 'bande originale', 'cinematic'],
  latin: ['latin', 'latino', 'reggaeton', 'salsa', 'bachata', 'cumbia', 'corrido', 'corridos', 'banda', 'mariachi', 'tango', 'flamenco', 'urbano', 'espanol', 'brasileira', 'mpb', 'samba', 'bolero', 'merengue', 'dembow', 'sertanejo', 'pagode', 'mambo', 'latin music'],
  reggae: ['reggae', 'dancehall', 'ska', 'dub', 'afrobeat', 'afrobeats', 'afro', 'amapiano', 'afropop', 'highlife', 'soca', 'calypso', 'roots', 'ragga', 'kizomba'],
  folk: ['folk', 'acoustic', 'singer songwriter', 'songwriter', 'celtic', 'traditional', 'bardcore'],
  indie: ['indie', 'alternative', 'alt', 'alternativa', 'alternativo', 'alternatif et inde', 'inde', 'bedroom', 'experimental', 'twee', 'jangle', 'indiepop'],
  pop: ['pop', 'electropop', 'synthpop', 'dance pop', 'teen pop', 'europop', 'j pop', 'jpop', 'schlager', 'adult contemporary', 'easy listening', 'singer', 'ballad', 'ballads', 'vocal', 'vocalists', 'contemporary', 'mainstream', 'top 40', 'chanson', 'chanson francaise', 'variete', 'boy band', 'idol', 'christmas', 'holiday', 'worship', 'christian', 'gospel', 'oldies', 'neo mellow', 'mellow', 'pop?', '팝', 'christmas'],
};
const ORDER = ['kpop', 'hiphop', 'metal', 'rnb', 'reggae', 'latin', 'country', 'jazz', 'classical', 'soundtrack', 'chill', 'folk', 'rock', 'electronic', 'indie', 'pop'];
const RESCUE = [
  [/\bk[\s-]?pop\b|\bkorean\b/, 'kpop'],
  [/\bhip[\s-]?hop\b|\brap\b/, 'hiphop'],
  [/metal/, 'metal'],
  [/\br\s*(&|and|n)\s*b\b|\brnb\b|\bsoul\b/, 'rnb'],
  [/\bfilm\w*\b|\bgame\w*\b|\bjeux\b|\bjuegos\b|\bpel[ií]culas?\b|\bscore\w*\b|\bscreen\b|\bmusical\w*\b|\bsoundtrack\w*\b|\bcin[eé]ma\w*\b|\bost\b/, 'soundtrack'],
  [/\breggae\w*\b|\bdancehall\b|\bafro\w*\b/, 'reggae'],
  [/\blatin\w*\b|\bbrasil\w*\b|\bespa[ñn]ol\b|\bmexican\w*\b/, 'latin'],
  [/\bcountry\b/, 'country'],
  [/\bjazz\b|\bblues\b/, 'jazz'],
  [/\bclassic(al|a|o)\b|\borchestr\w*\b|\bsymphon\w*\b|\bbaroque\b|\bopera\b/, 'classical'],
  [/\bchill\w*\b|\bambient\b|\blo[\s-]?fi\b/, 'chill'],
  [/\bfolk\b|\bacoustic\b|\bsongwriter\b/, 'folk'],
  [/rock\b|\bpunk\b|\bgrunge\b|\bemo\b|\bpsychedel\w*\b|\bindustrial\b/, 'rock'],
  [/electr[oó]n\w*|\bhouse\b|\btechno\b|\btrance\b|\bedm\b|\bdubstep\b|\bdance\b|\bdrum\b|\bbass\b|\bbreak\w*\b|танц/, 'electronic'],
  [/\bind[eé]\b|\bindie\b|\balternati\w*\b|\balt\b|\bexperimental\b/, 'indie'],
  [/pop\b|поп|\bgospel\b|\bchristian\b|\bballad\w*\b/, 'pop'],
];
// Modifiers that also file a tag under Indie & Alternative (an "indie rock"
// track belongs on both the Rock and the Indie tile).
const INDIE_MOD = /\b(indie|alternative|alt\.?|bedroom|dream|art|shoegaze|inde|indé|alternatif|experimental)\b/;
const cleanGenre = (g) => String(g || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^[\s"'\[\(«»]+|[\s"'\]\)«»]+$/g, '').replace(/«multiple values»/g, '').replace(/[_/+]+/g, ' ').replace(/\s+/g, ' ').replace(/\s?musi[cq]u?e?s?$/, '').replace(/^r'?n'?b$/, 'rnb').trim();
function bucketsOf(raw) {
  const g = cleanGenre(raw);
  if (!g) return [];
  if (g === 'r' || g === 'b') return ['rnb']; // "R&B" split by the tag delimiter
  if (/\d/.test(g) && !/\b2[\s-]?step\b|\b(60|70|80|90)s\b|\btop 40\b/.test(g)) return []; // years, track numbers, "5+ wochen"
  if (g.replace(/[^a-zЀ-ӿ]/g, '').length < 3) return [];
  const words = g.split(/[\s-]+/);
  const head1 = words[words.length - 1], head2 = words.slice(-2).join(' '), head3 = words.slice(-3).join(' ');
  let b = null;
  for (const k of ORDER) if (HEADS[k].includes(head3) || HEADS[k].includes(head2)) { b = k; break; }
  if (!b) for (const k of ORDER) if (HEADS[k].includes(head1)) { b = k; break; }
  if (!b) for (const [re, k] of RESCUE) if (re.test(g)) { b = k; break; }
  if (!b) return [];
  // A generic head with a stronger family in the modifier.
  if (b === 'pop' && /\bk[\s-]?pop\b|\bkorean\b/.test(g)) b = 'kpop';
  else if (b === 'pop' && /\bpunk\b/.test(g)) b = 'rock';
  else if (b === 'rock' && /\bmetal\b/.test(g)) b = 'metal';
  else if (b === 'hiphop' && /\btrip\b|\bglitch\b/.test(g)) b = 'electronic';
  else if (b === 'jazz' && /\brhythm\b/.test(g)) b = 'rnb';
  const out = [b];
  if (b !== 'indie' && INDIE_MOD.test(g)) out.push('indie');
  return out;
}
let browseCache = { at: 0, tiles: null };
async function browse() {
  if (browseCache.tiles && Date.now() - browseCache.at < 10 * 60 * 1000) return browseCache.tiles;
  const facets = await meiliOne('tracks', { q: '', limit: 0, facets: ['genres'] });
  const dist = facets.facetDistribution?.genres || {};
  const tiles = [];
  for (const b of BUCKETS) {
    const genres = Object.keys(dist).filter((g) => bucketsOf(g).includes(b.id));
    const count = genres.reduce((n, g) => n + dist[g], 0);
    if (count < 15) continue;
    const filter = `genres IN [${genres.map((g) => JSON.stringify(g)).join(', ')}]`;
    const top = await meiliOne('tracks', { q: '', limit: 1, filter, sort: ['plays:desc'], attributesToRetrieve: ['albumId', 'name'] }).catch(() => ({ hits: [] }));
    tiles.push({ id: b.id, name: b.name, color: b.color, count, filter, coverId: top.hits[0]?.albumId || null });
  }
  tiles.sort((a, b) => b.count - a.count);
  browseCache = { at: Date.now(), tiles };
  return tiles;
}

// --- discography / requests / release radar --------------------------------
// Music Requests (the Soulseek pipeline at :8732) owns the Spotify credentials:
// /api/artist gives every release for an artist, /api/request queues an album
// for download. The relay matches those releases against the library (Meili
// albums index) so the artist page can show what is here and offer the rest.
const MUSIC_REQUESTS = process.env.MUSIC_REQUESTS_URL || 'http://192.168.1.85:8732';
const normTitle = (t) => norm(String(t || '').replace(/\s*[\(\[](deluxe|expanded|remaster(ed)?|edition|version|bonus|anniversary|explicit|clean|drumless|feat\.?|ft\.?)[^\)\]]*[\)\]]/gi, '').replace(/\s*-\s*(single|ep)$/i, ''));
const discogCache = new Map(); // artistId -> { at, v }
async function discography(artistId, artistName) {
  const c = discogCache.get(artistId);
  if (c && Date.now() - c.at < 60 * 60 * 1000) return c.v;
  const [mr, lib, reqs] = await Promise.all([
    fetch(`${MUSIC_REQUESTS}/api/artist?name=${encodeURIComponent(artistName)}`, { signal: AbortSignal.timeout(25000) }).then((r) => r.json()),
    meiliOne('albums', { q: '', limit: 200, filter: `artistIds = "${artistId}"` }).catch(() => ({ hits: [] })),
    fetch(`${MUSIC_REQUESTS}/api/requests?limit=2000`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => ({ requests: [] })),
  ]);
  // Exact title first; a library "Deluxe" satisfies a plain Spotify title, but a
  // Spotify "(Drumless Edition)" is only present if that exact edition is.
  const exact = new Map((lib.hits || []).map((a) => [norm(a.name), a]));
  const base = new Map((lib.hits || []).map((a) => [normTitle(a.name), a]));
  const qualified = (t) => normTitle(t) !== norm(t);
  const have = { get: (t) => exact.get(norm(t)) || (!qualified(t) ? base.get(normTitle(t)) : null) };
  const status = new Map((reqs.requests || []).map((r) => [r.album_id, r.status]));
  const releases = (mr.releases || []).map((r) => {
    const local = have.get(r.title) || null;
    return { ...r, inLibrary: local ? local.id : null, localName: local?.name || null, requestStatus: status.get(r.album_id) || null };
  });
  // Library albums Spotify does not list (bootlegs, compilations) still belong on the page.
  const listed = new Set(releases.filter((r) => r.inLibrary).map((r) => r.inLibrary));
  const extra = (lib.hits || []).filter((a) => !listed.has(a.id)).map((a) => ({ album_id: null, title: a.name, rtype: a.type === 'single' ? 'Single' : a.type === 'ep' ? 'EP' : a.type === 'compilation' ? 'Compilation' : 'Album', year: a.year ? String(a.year) : '', date: a.year ? `${a.year}` : '', image: null, total_tracks: a.trackCount, inLibrary: a.id, localName: a.name, requestStatus: null }));
  const v = { artist: mr.artist || null, releases: [...releases, ...extra] };
  discogCache.set(artistId, { at: Date.now(), v });
  return v;
}

let radarCache = { at: 0, v: null };
async function releaseRadar() {
  if (radarCache.v && Date.now() - radarCache.at < 6 * 60 * 60 * 1000) return radarCache.v;
  // The library's most played artists; their releases from the last 90 days.
  const top = await meiliOne('artists', { q: '', limit: 40, sort: ['plays:desc'], attributesToRetrieve: ['id', 'name', 'plays'] });
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const out = [];
  for (const a of top.hits || []) {
    try {
      const d = await discography(a.id, a.name);
      for (const r of d.releases) {
        if (r.album_id && r.date && r.date >= since && r.group !== 'appears_on') out.push({ ...r, artistId: a.id, artistName: a.name });
      }
    } catch { /* one artist failing must not sink the radar */ }
  }
  out.sort((x, y) => (y.date || '').localeCompare(x.date || ''));
  radarCache = { at: Date.now(), v: out };
  return out;
}

// "Fans also like": Deezer's related artists, kept only when the library has
// them (so every card opens a real page). Cached a day per artist.
const similarCache = new Map();
async function similarArtists(artistId, name) {
  const c = similarCache.get(artistId);
  if (c && Date.now() - c.at < 24 * 60 * 60 * 1000) return c.v;
  const nk = (x) => norm(x);
  const s = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=5`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
  const dz = (s.data || []).find((a) => nk(a.name) === nk(name)) || (s.data || [])[0];
  let out = [];
  if (dz) {
    const rel = await fetch(`https://api.deezer.com/artist/${dz.id}/related?limit=40`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    const names = (rel.data || []).map((a) => a.name);
    // one multi-search: each related name against the artists index
    if (names.length) {
      const body = { queries: names.slice(0, 40).map((n) => ({ indexUid: 'artists', q: n, limit: 1 })) };
      const r = await fetch(`${MEILI}/multi-search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEILI_KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
      const res = r.ok ? (await r.json()).results : [];
      res.forEach((x, i) => { const h = x.hits[0]; if (h && nk(h.name) === nk(names[i]) && h.id !== artistId) out.push({ id: h.id, name: h.name, hasImage: h.hasImage }); });
    }
  }
  const v = out.slice(0, 12);
  similarCache.set(artistId, { at: Date.now(), v });
  return v;
}

// The artist page's Popular rows in real-world order. Deezer's top-100 for the
// artist (no key needed) is matched by title against the library's tracks for
// that artist; ranked titles come first in Deezer's order, one row per title
// (the most played copy wins), then everything else by local plays. The
// library's own play counts are too sparse to rank a catalogue on their own.
const popularCache = new Map(); // artistId -> { at, v }
async function popularTracks(artistId, name) {
  const c = popularCache.get(artistId);
  if (c && Date.now() - c.at < 24 * 60 * 60 * 1000) return c.v;
  const lib = await meiliOne('tracks', { q: '', limit: 500, filter: `artistIds = "${artistId}"`, attributesToRetrieve: ['id', 'name', 'plays'] }).catch(() => ({ hits: [] }));
  let order = [];
  try {
    const s = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=5`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    const dz = (s.data || []).find((a) => norm(a.name) === norm(name)) || (s.data || [])[0];
    if (dz) {
      const top = await fetch(`https://api.deezer.com/artist/${dz.id}/top?limit=100`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
      order = (top.data || []).map((t) => [normTitle(t.title_short || t.title), normTitle(t.title)]);
    }
  } catch { /* Deezer down: plays only */ }
  const rank = new Map();
  order.forEach((keys, i) => keys.forEach((k) => { if (k && !rank.has(k)) rank.set(k, i); }));
  const keyOf = (t) => normTitle(t.name);
  const best = new Map(); // title key -> best library copy
  for (const t of lib.hits || []) {
    const k = keyOf(t);
    const cur = best.get(k);
    if (!cur || (t.plays || 0) > (cur.plays || 0)) best.set(k, t);
  }
  const rows = [...best.entries()].map(([k, t]) => ({ id: t.id, r: rank.has(k) ? rank.get(k) : Infinity, plays: t.plays || 0 }));
  rows.sort((a, b) => (a.r - b.r) || (b.plays - a.plays));
  const v = { ids: rows.map((r) => r.id), ranked: rows.filter((r) => r.r !== Infinity).length, source: order.length ? 'deezer' : 'plays' };
  popularCache.set(artistId, { at: Date.now(), v });
  return v;
}

// --- listening history (stats.fm-style) ------------------------------------
// ListenBrainz is the union of everything the account has played: the relay
// scrobbles Conduit plays there, the backfill seeded Jellyfin's play history,
// and LB's own Spotify connector imports Spotify listens. LB's stats endpoints
// are computed on a slow schedule (204 for weeks on a new account), so the
// relay mirrors the raw listens to /data and computes the numbers itself.
// Each listen is matched to a library track once (Meili) for art and playback.
const HISTORY_DIR = process.env.SESSIONS_FILE ? process.env.SESSIONS_FILE.replace(/[^/]+$/, '') : null;
const histCache = new Map(); // uid -> store
const histSyncing = new Map(); // uid -> Promise
function histFile(uid) { return HISTORY_DIR ? `${HISTORY_DIR}history-${uid}.json` : null; }
function loadHist(uid) {
  if (histCache.has(uid)) return histCache.get(uid);
  let st = { user: null, listens: [], match: {}, syncedAt: 0, complete: false };
  const f = histFile(uid);
  try { if (f && fs.existsSync(f)) st = { ...st, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch (e) { console.error('history load', e.message); }
  histCache.set(uid, st);
  return st;
}
function saveHist(uid) {
  const f = histFile(uid); if (!f) return;
  try { fs.writeFileSync(f, JSON.stringify(histCache.get(uid))); } catch (e) { console.error('history save', e.message); }
}
const lbGet = async (path, token) => {
  const r = await fetch(`https://api.listenbrainz.org/1${path}`, { headers: token ? { Authorization: `Token ${token}` } : {}, signal: AbortSignal.timeout(15000) });
  if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 3000)); return lbGet(path, token); }
  if (!r.ok) throw new Error(`listenbrainz ${r.status}`);
  return r.json();
};
function slimListen(l) {
  const m = l.track_metadata || {}, ai = m.additional_info || {};
  const dur = ai.duration_ms ? Math.round(ai.duration_ms / 1000) : ai.duration ? Math.round(ai.duration) : null;
  const src = /spotify/i.test(ai.music_service || ai.origin_url || '') || ai.spotify_id ? 'spotify' : (ai.submission_client || ai.media_player || '').toLowerCase().includes('conduit') ? 'conduit' : 'other';
  return { ts: l.listened_at, artist: m.artist_name || '', track: m.track_name || '', album: m.release_name || '', dur, src };
}
const listenKey = (l) => `${norm((l.artist || '').split(/,|&| feat\.? | ft\.? /i)[0])}|${normTitle(l.track)}`;
// Pull everything newer than what we have (or the whole history the first
// time), then match the new keys against the library.
async function syncHistory(uid, lb) {
  if (histSyncing.has(uid)) return histSyncing.get(uid);
  const job = (async () => {
    const st = loadHist(uid);
    if (lb.user !== st.user) { st.user = lb.user; st.listens = []; st.complete = false; }
    const seen = new Set(st.listens.map((l) => `${l.ts}|${l.track}`));
    const add = (rows) => { let n = 0; for (const raw of rows) { const l = slimListen(raw); const k = `${l.ts}|${l.track}`; if (!seen.has(k)) { seen.add(k); st.listens.push(l); n += 1; } } return n; };
    if (!st.complete) {
      // Backfill: walk back from now in pages of 1000 until LB has nothing older.
      let maxTs = Math.floor(Date.now() / 1000) + 60;
      for (let i = 0; i < 200; i += 1) {
        const p = await lbGet(`/user/${encodeURIComponent(lb.user)}/listens?count=250&max_ts=${maxTs}`, lb.token);
        const rows = p.payload?.listens || [];
        add(rows);
        if (rows.length < 250) break;
        maxTs = Math.min(...rows.map((r) => r.listened_at));
      }
      st.complete = true;
    } else {
      for (let i = 0; i < 50; i += 1) {
        const latest = st.listens.reduce((m, l) => Math.max(m, l.ts), 0);
        const p = await lbGet(`/user/${encodeURIComponent(lb.user)}/listens?count=250&min_ts=${latest}`, lb.token);
        const rows = p.payload?.listens || [];
        const n = add(rows);
        if (rows.length < 250 || n === 0) break;
      }
    }
    st.listens.sort((a, b) => b.ts - a.ts);
    // Match unseen keys to the library in batches of 60 Meili queries.
    const keys = [...new Set(st.listens.map(listenKey))].filter((k) => !(k in st.match));
    for (let i = 0; i < keys.length; i += 60) {
      const batch = keys.slice(i, i + 60);
      const byKey = new Map(); for (const l of st.listens) { const k = listenKey(l); if (batch.includes(k) && !byKey.has(k)) byKey.set(k, l); }
      const qs = batch.map((k) => { const l = byKey.get(k); return { indexUid: 'tracks', q: `${l.track} ${(l.artist || '').split(/,|&/)[0]}`.slice(0, 200), limit: 5, attributesToRetrieve: ['id', 'name', 'artists', 'artistIds', 'albumId', 'album', 'durationTicks', 'genres'] }; });
      try {
        const r = await fetch(`${MEILI}/multi-search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEILI_KEY}` }, body: JSON.stringify({ queries: qs }), signal: AbortSignal.timeout(8000) });
        const res = r.ok ? (await r.json()).results : [];
        batch.forEach((k, j) => {
          const l = byKey.get(k); const want = normTitle(l.track); const wa = norm((l.artist || '').split(/,|&| feat\.? | ft\.? /i)[0]);
          const hit = (res[j]?.hits || []).find((h) => normTitle(h.name) === want && (h.artists || []).some((a) => norm(a) === wa))
            || (res[j]?.hits || []).find((h) => normTitle(h.name) === want);
          st.match[k] = hit ? { id: hit.id, albumId: hit.albumId || null, artistId: (hit.artistIds || [])[0] || null, dur: hit.durationTicks ? Math.round(hit.durationTicks / 1e7) : null, genres: [...new Set((hit.genres || []).flatMap(bucketsOf))] } : null;
        });
      } catch (e) { console.error('history match', e.message); break; }
    }
    st.syncedAt = Date.now();
    saveHist(uid);
    return st;
  })().finally(() => histSyncing.delete(uid));
  histSyncing.set(uid, job);
  return job;
}
// stats.fm's ranges: today / this week / 4 weeks / 6 months / this year / lifetime.
const RANGES = { '4w': 28 * 86400, '6m': 183 * 86400, '1y': 365 * 86400, week: 7 * 86400, all: Infinity };
function historyStats(st, range, tzo = 0) {
  // tzo = the client's getTimezoneOffset() (minutes west of UTC), so hours and
  // days are the listener's, not the container's.
  const local = (ts) => new Date((ts - tzo * 60) * 1000);
  const now = Math.floor(Date.now() / 1000);
  let span = RANGES[range] ?? RANGES.all;
  if (range === 'today' || range === 'year') {
    // Since local midnight / local Jan 1.
    const d = local(now); const start = range === 'today' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : Date.UTC(d.getUTCFullYear(), 0, 1);
    span = now - (Math.floor(start / 1000) + tzo * 60);
  }
  const since = span === Infinity ? 0 : now - span;
  const rows = st.listens.filter((l) => l.ts >= since);
  const secs = (l) => l.dur || st.match[listenKey(l)]?.dur || 210;
  const artists = new Map(), tracks = new Map(), albums = new Map(), genres = new Map();
  const byHour = new Array(24).fill(0), byHourSeconds = new Array(24).fill(0), byDow = new Array(7).fill(0);
  const days = new Map();
  let seconds = 0;
  for (const l of rows) {
    const s2 = secs(l); seconds += s2;
    const k = listenKey(l), m = st.match[k] || null;
    const an = (l.artist || '').split(/,|&| feat\.? | ft\.? /i)[0].trim() || l.artist || 'Unknown';
    const ak = norm(an);
    const a = artists.get(ak) || { name: an, count: 0, seconds: 0, artistId: m?.artistId || null }; a.count += 1; a.seconds += s2; if (!a.artistId && m?.artistId) a.artistId = m.artistId; artists.set(ak, a);
    const t = tracks.get(k) || { name: l.track, artist: an, album: l.album, count: 0, seconds: 0, id: m?.id || null, albumId: m?.albumId || null, artistId: m?.artistId || null }; t.count += 1; t.seconds += s2; tracks.set(k, t);
    if (l.album) { const alk = `${ak}|${norm(l.album)}`; const al = albums.get(alk) || { name: l.album, artist: an, count: 0, seconds: 0, albumId: m?.albumId || null }; al.count += 1; al.seconds += s2; if (!al.albumId && m?.albumId) al.albumId = m.albumId; albums.set(alk, al); }
    for (const g of m?.genres || []) genres.set(g, (genres.get(g) || 0) + 1);
    const d = local(l.ts);
    byHour[d.getUTCHours()] += 1; byHourSeconds[d.getUTCHours()] += s2; byDow[d.getUTCDay()] += 1;
    const dk = d.toISOString().slice(0, 10); days.set(dk, (days.get(dk) || 0) + 1);
  }
  const top = (map, n = 50) => [...map.values()].sort((x, y) => y.count - x.count || y.seconds - x.seconds).slice(0, n);
  // Streams per day for the chart: the range's days (capped at 365), oldest first.
  const nDays = span === Infinity ? Math.min(365, rows.length ? Math.ceil((now - rows[rows.length - 1].ts) / 86400) + 1 : 1) : Math.min(365, Math.ceil(span / 86400));
  const perDay = [];
  for (let i = nDays - 1; i >= 0; i -= 1) { const dk = local(now - i * 86400).toISOString().slice(0, 10); perDay.push({ day: dk, count: days.get(dk) || 0 }); }
  const firstTs = st.listens.length ? st.listens[st.listens.length - 1].ts : null;
  return {
    range, since: since || firstTs, streams: rows.length, minutes: Math.round(seconds / 60),
    uniqueTracks: tracks.size, uniqueArtists: artists.size, uniqueAlbums: albums.size,
    topArtists: top(artists), topTracks: top(tracks), topAlbums: top(albums),
    topGenres: [...genres.entries()].map(([id, count]) => ({ id, name: (BUCKETS.find((b) => b.id === id) || {}).name || id, count })).sort((x, y) => y.count - x.count).slice(0, 8),
    byHour, byHourSeconds, byDow, perDay,
    sources: rows.reduce((o, l) => { o[l.src] = (o[l.src] || 0) + 1; return o; }, {}),
    total: st.listens.length, firstTs, syncedAt: st.syncedAt, user: st.user,
  };
}
function historyRecent(st, before, limit = 60) {
  const out = [];
  for (const l of st.listens) {
    if (before && l.ts >= before) continue;
    const m = st.match[listenKey(l)] || null;
    out.push({ ...l, id: m?.id || null, albumId: m?.albumId || null, artistId: m?.artistId || null });
    if (out.length >= limit) break;
  }
  return out;
}
// GET /history?range= -> stats; GET /history?recent=1&before=<ts> -> a page of listens.
async function history(self, url) {
  const lb = await lbTokenFor(self);
  if (!lb || !lb.user) return { connected: false };
  const st = loadHist(self.uid);
  const stale = Date.now() - (st.syncedAt || 0) > 3 * 60 * 1000;
  if (!st.complete) await syncHistory(self.uid, lb); // first open waits for the backfill
  else if (stale) syncHistory(self.uid, lb).catch((e) => console.error('history sync', e.message)); // later opens: serve now, refresh behind
  if (url.searchParams.get('recent')) return { connected: true, listens: historyRecent(st, Number(url.searchParams.get('before')) || 0) };
  return { connected: true, ...historyStats(st, url.searchParams.get('range') || '4w', Number(url.searchParams.get('tzo')) || 0) };
}

async function requestAlbum(albumId) {
  const r = await fetch(`${MUSIC_REQUESTS}/api/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ album_id: albumId }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `request ${r.status}`);
  discogCache.clear();
  return j;
}

const server = http.createServer(async (req, res) => {
  // Health check for Docker.
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/relay/, '');
  if (path === '/discography' || path === '/radar' || path === '/request' || path === '/similar' || path === '/popular' || path === '/history') {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, X-Emby-Token, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    try {
      const token = tokenOf(req);
      const who = token ? await whoIs(token) : null;
      if (!who) { res.writeHead(401, cors); res.end('{"error":"unauthorized"}'); return; }
      let out;
      if (path === '/history') out = await history({ uid: who.id, token }, url);
      else if (path === '/discography') out = await discography(url.searchParams.get('artistId') || '', url.searchParams.get('name') || '');
      else if (path === '/radar') out = { releases: await releaseRadar() };
      else if (path === '/similar') out = { artists: await similarArtists(url.searchParams.get('artistId') || '', url.searchParams.get('name') || '') };
      else if (path === '/popular') out = await popularTracks(url.searchParams.get('artistId') || '', url.searchParams.get('name') || '');
      else {
        let body = ''; for await (const chunk of req) body += chunk;
        const { album_id } = JSON.parse(body || '{}');
        if (!album_id) throw new Error('album_id required');
        out = await requestAlbum(album_id);
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(503, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (url.pathname === '/browse' || url.pathname === '/relay/browse') {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, X-Emby-Token, Content-Type', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    try {
      const token = tokenOf(req);
      if (!token || !(await whoIs(token))) { res.writeHead(401, cors); res.end('{"error":"unauthorized"}'); return; }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ tiles: await browse() }));
    } catch (e) {
      res.writeHead(503, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
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
      const out = (q.trim() || filter) ? await search(q, { limit, filter, userId: who.id }) : { top: null, artists: [], albums: [], tracks: [], playlists: [], chips: [] };
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
        maybeScrobble(self, self.nowPlaying);
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
        if (msg.prefs && 'listenbrainz' in msg.prefs) lbTokens.set(self.uid, msg.prefs.listenbrainz && msg.prefs.listenbrainz.token ? msg.prefs.listenbrainz : null);
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
