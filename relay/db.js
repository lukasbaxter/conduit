// The relay's store: one SQLite file (node:sqlite, no native build).
//
//   sessions   last thing each account played (nowPlaying + slim queue)
//   listens    the account's ListenBrainz history, mirrored row by row
//   history    per-account sync state (LB user, complete backfill?, synced at)
//   matches    listen key (artist|title) -> library track, shared by everyone
//   cache      JSON blobs with a timestamp (discography, popular, similar,
//              browse, radar) so a redeploy does not refetch everything
//
// The old JSON files (sessions.json, history-<uid>.json) are imported once
// on first start and renamed *.migrated.
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS sessions (uid TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS listens (
      uid TEXT NOT NULL, ts INTEGER NOT NULL, track TEXT NOT NULL, artist TEXT NOT NULL, album TEXT,
      dur INTEGER, src TEXT, key TEXT NOT NULL,
      PRIMARY KEY (uid, ts, track)
    );
    CREATE INDEX IF NOT EXISTS listens_uid_ts ON listens (uid, ts DESC);
    CREATE INDEX IF NOT EXISTS listens_key ON listens (key);
    CREATE TABLE IF NOT EXISTS history (uid TEXT PRIMARY KEY, user TEXT, complete INTEGER NOT NULL DEFAULT 0, synced_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS matches (key TEXT PRIMARY KEY, id TEXT, album_id TEXT, artist_id TEXT, dur INTEGER, genres TEXT);
    CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS likes (uid TEXT NOT NULL, item_id TEXT NOT NULL, at INTEGER NOT NULL, synced INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, item_id));
  `);
  try { db.exec('ALTER TABLE likes ADD COLUMN synced INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
  const q = {
    sessionGet: db.prepare('SELECT json, at FROM sessions WHERE uid = ?'),
    sessionPut: db.prepare('INSERT INTO sessions (uid, json, at) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET json = excluded.json, at = excluded.at'),
    sessionsAll: db.prepare('SELECT uid, json, at FROM sessions'),
    listenPut: db.prepare('INSERT OR IGNORE INTO listens (uid, ts, track, artist, album, dur, src, key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    listenLatest: db.prepare('SELECT MAX(ts) AS ts FROM listens WHERE uid = ?'),
    listenOldest: db.prepare('SELECT MIN(ts) AS ts, COUNT(*) AS n FROM listens WHERE uid = ?'),
    listensSince: db.prepare(`SELECT l.ts, l.track, l.artist, l.album, l.dur, l.src, l.key, m.id, m.album_id AS albumId, m.artist_id AS artistId, m.dur AS mdur, m.genres
                              FROM listens l LEFT JOIN matches m ON m.key = l.key WHERE l.uid = ? AND l.ts >= ? AND l.ts < ? ORDER BY l.ts DESC`),
    listensBefore: db.prepare(`SELECT l.ts, l.track, l.artist, l.album, l.dur, l.src, l.key, m.id, m.album_id AS albumId, m.artist_id AS artistId
                               FROM listens l LEFT JOIN matches m ON m.key = l.key WHERE l.uid = ? AND l.ts < ? ORDER BY l.ts DESC LIMIT ?`),
    unmatchedKeys: db.prepare('SELECT DISTINCT l.key, l.track, l.artist FROM listens l WHERE l.uid = ? AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.key = l.key)'),
    matchPut: db.prepare('INSERT OR REPLACE INTO matches (key, id, album_id, artist_id, dur, genres) VALUES (?, ?, ?, ?, ?, ?)'),
    histGet: db.prepare('SELECT user, complete, synced_at FROM history WHERE uid = ?'),
    histPut: db.prepare('INSERT INTO history (uid, user, complete, synced_at) VALUES (?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET user = excluded.user, complete = excluded.complete, synced_at = excluded.synced_at'),
    histReset: db.prepare('DELETE FROM listens WHERE uid = ?'),
    cacheGet: db.prepare('SELECT json, at FROM cache WHERE k = ?'),
    cachePut: db.prepare('INSERT INTO cache (k, json, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET json = excluded.json, at = excluded.at'),
    cacheDel: db.prepare('DELETE FROM cache WHERE k LIKE ?'),
    likePut: db.prepare('INSERT INTO likes (uid, item_id, at, synced) VALUES (?, ?, ?, 0) ON CONFLICT(uid, item_id) DO UPDATE SET at = excluded.at, synced = 0'),
    likeDel: db.prepare('DELETE FROM likes WHERE uid = ? AND item_id = ?'),
    likesAll: db.prepare('SELECT item_id, at, synced FROM likes WHERE uid = ? ORDER BY at DESC'),
    likeKeep: db.prepare('INSERT OR IGNORE INTO likes (uid, item_id, at, synced) VALUES (?, ?, ?, 1)'),
    likeSynced: db.prepare('UPDATE likes SET synced = 1 WHERE uid = ? AND item_id = ?'),
    likesUnsynced: db.prepare('SELECT uid, item_id FROM likes WHERE synced = 0'),
    likeCount: db.prepare('SELECT COUNT(*) AS n FROM likes WHERE uid = ?'),
  };
  return {
    db,
    // --- sessions
    sessionGet(uid) { const r = q.sessionGet.get(uid); return r ? { ...JSON.parse(r.json), at: r.at } : null; },
    sessionPut(uid, s) { q.sessionPut.run(uid, JSON.stringify({ nowPlaying: s.nowPlaying ?? null, queue: s.queue ?? null }), s.at || Date.now()); },
    sessionsAll() { return q.sessionsAll.all().map((r) => [r.uid, { ...JSON.parse(r.json), at: r.at }]); },
    // --- listens / history
    listenPut(uid, l) { return q.listenPut.run(uid, l.ts, l.track, l.artist, l.album || null, l.dur ?? null, l.src || null, l.key).changes; },
    listenPutMany(uid, rows) { let n = 0; db.exec('BEGIN'); try { for (const l of rows) n += this.listenPut(uid, l); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return n; },
    listenLatest(uid) { return q.listenLatest.get(uid)?.ts || 0; },
    listenTotals(uid) { const r = q.listenOldest.get(uid); return { firstTs: r?.ts || null, total: r?.n || 0 }; },
    listensSince(uid, since, until = 2 ** 40) { return q.listensSince.all(uid, since, until); },
    listensBefore(uid, before, limit) { return q.listensBefore.all(uid, before || 2 ** 40, limit); },
    unmatchedKeys(uid) { return q.unmatchedKeys.all(uid); },
    matchPutMany(rows) { db.exec('BEGIN'); try { for (const m of rows) q.matchPut.run(m.key, m.id || null, m.albumId || null, m.artistId || null, m.dur ?? null, m.genres ? JSON.stringify(m.genres) : null); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } },
    histGet(uid) { const r = q.histGet.get(uid); return r ? { user: r.user, complete: !!r.complete, syncedAt: r.synced_at } : { user: null, complete: false, syncedAt: 0 }; },
    histPut(uid, h) { q.histPut.run(uid, h.user || null, h.complete ? 1 : 0, h.syncedAt || 0); },
    histReset(uid) { q.histReset.run(uid); },
    // --- cache
    cacheGet(k, maxAgeMs) { const r = q.cacheGet.get(k); if (!r) return undefined; if (maxAgeMs != null && Date.now() - r.at > maxAgeMs) return undefined; return JSON.parse(r.json); },
    cachePut(k, v) { q.cachePut.run(k, JSON.stringify(v), Date.now()); },
    cacheClear(prefix) { q.cacheDel.run(`${prefix}%`); },
    // --- likes (when each track was liked; Jellyfin only knows THAT it is)
    likePut(uid, itemId, at = Date.now()) { q.likePut.run(uid, itemId, at); },
    likeDel(uid, itemId) { q.likeDel.run(uid, itemId); },
    likesAll(uid) { return q.likesAll.all(uid); },
    likeSeed(uid, rows) { db.exec('BEGIN'); try { for (const [id, at] of rows) q.likeKeep.run(uid, id, at); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } },
    likeSynced(uid, itemId) { q.likeSynced.run(uid, itemId); },
    likesUnsynced() { return q.likesUnsynced.all(); },
    likeCount(uid) { return q.likeCount.get(uid)?.n || 0; },
  };
}

// One-time import of the JSON files the relay used to keep in /data.
export function migrateJson(store, dir, listenKey) {
  const sessions = path.join(dir, 'sessions.json');
  if (fs.existsSync(sessions)) {
    try {
      const all = JSON.parse(fs.readFileSync(sessions, 'utf8'));
      for (const [uid, s] of Object.entries(all)) store.sessionPut(uid, s);
      fs.renameSync(sessions, `${sessions}.migrated`);
      console.log(`migrated sessions.json (${Object.keys(all).length} accounts)`);
    } catch (e) { console.error('sessions.json migration failed', e.message); }
  }
  for (const f of fs.readdirSync(dir)) {
    const m = /^history-([0-9a-f]+)\.json$/.exec(f); if (!m) continue;
    const uid = m[1], file = path.join(dir, f);
    try {
      const st = JSON.parse(fs.readFileSync(file, 'utf8'));
      const rows = (st.listens || []).map((l) => ({ ...l, key: listenKey(l) }));
      const n = store.listenPutMany(uid, rows);
      store.matchPutMany(Object.entries(st.match || {}).map(([key, v]) => (v ? { key, id: v.id, albumId: v.albumId, artistId: v.artistId, dur: v.dur, genres: v.genres } : { key })));
      store.histPut(uid, { user: st.user, complete: !!st.complete, syncedAt: st.syncedAt || 0 });
      fs.renameSync(file, `${file}.migrated`);
      console.log(`migrated ${f}: ${n} listens, ${Object.keys(st.match || {}).length} matches`);
    } catch (e) { console.error(`${f} migration failed`, e.message); }
  }
}
