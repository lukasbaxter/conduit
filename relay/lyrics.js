// Lyrics in RAM: every .lrc sidecar of the library, keyed by the Jellyfin id
// of its audio file (derived from the path exactly as Jellyfin does), held
// in Redis and served by GET /lyrics?id= in the shape the client already
// parses ({ Lyrics: [{ Start (ticks), Text }] }). Jellyfin's own lyrics
// endpoint answered in hundreds of ms on a slow day and re-reads the file
// each time; this answers from memory. Loaded at start (~20k files, a few
// seconds off the SSD) and again on POST /lyrics/reload (the nightly
// hygiene pass, after lyrics_check.py replaced sidecars).
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from 'redis';

const AUDIO = new Set(['.flac', '.mp3', '.m4a', '.opus', '.ogg', '.wav', '.aac', '.wma', '.aiff', '.ape']);
const TS = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/;

let client = null;
export async function redis() {
  if (client) return client;
  const c = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
  c.on('error', (e) => console.error('redis', e.message));
  await c.connect();
  client = c;
  return c;
}

// Parse LRC text into Jellyfin's shape. Lines without a timestamp keep
// Start null (unsynced), and every [mm:ss.xx] of a repeated line gets its
// own entry.
export function parseLrc(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    let rest = line, starts = [];
    for (;;) {
      const m = /^\[(\d+):(\d+(?:\.\d+)?)\]/.exec(rest);
      if (!m) break;
      starts.push(Math.round((Number(m[1]) * 60 + Number(m[2])) * 1e7));
      rest = rest.slice(m[0].length);
    }
    if (/^\[[a-z]+:/i.test(rest) && !starts.length) continue; // [ar:], [ti:], [offset:] tags
    const textPart = rest.trim();
    if (!starts.length) out.push({ Text: textPart });
    else for (const s of starts) out.push({ Start: s, Text: textPart });
  }
  out.sort((a, b) => (a.Start ?? -1) - (b.Start ?? -1));
  return out;
}

async function* walk(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.lrc')) yield p;
  }
}

/** Load every sidecar under `root` (the library as mounted here) into Redis.
 *  `jfRoot` is the same directory as Jellyfin sees it (its ids hash that path). */
export async function loadAll({ root, jfRoot, jellyfinId, metaRoot = null }) {
  const r = await redis();
  const t0 = Date.now();
  let n = 0, missing = 0, internal = 0;
  const batch = [];
  const seen = new Set();
  const flush = async () => { if (!batch.length) return; const m = r.multi(); for (const [k, v] of batch) m.set(k, v); await m.exec(); batch.length = 0; };
  // Lyrics Jellyfin fetched itself (LrcLib) and kept in its metadata folder:
  // <metaRoot>/<2 hex>/<item id>/<name>.lrc. Loaded first; a sidecar next to
  // the file (which lyrics_check.py keeps right) overrides it below.
  if (metaRoot) {
    for await (const lrc of walk(metaRoot)) {
      const id = path.basename(path.dirname(lrc));
      if (!/^[0-9a-f]{32}$/.test(id)) continue;
      let text;
      try { text = await fs.readFile(lrc, 'utf8'); } catch { continue; }
      batch.push([`lyrics:${id}`, JSON.stringify(parseLrc(text))]);
      seen.add(id); internal++;
      if (batch.length >= 500) await flush();
    }
    await flush();
  }
  for await (const lrc of walk(root)) {
    const base = lrc.slice(0, -4);
    let audio = null;
    for (const ext of AUDIO) { try { await fs.access(base + ext); audio = base + ext; break; } catch { /* next */ } }
    if (!audio) { missing++; continue; }
    const jfPath = path.posix.join(jfRoot, path.relative(root, audio).split(path.sep).join('/'));
    const id = jellyfinId('MediaBrowser.Controller.Entities.Audio.Audio', jfPath);
    let text;
    try { text = await fs.readFile(lrc, 'utf8'); } catch { continue; }
    batch.push([`lyrics:${id}`, JSON.stringify(parseLrc(text))]);
    if (seen.has(id)) internal--; seen.add(id);
    n++;
    if (batch.length >= 500) await flush();
  }
  await flush();
  await r.set('lyrics:loaded', JSON.stringify({ at: Date.now(), count: seen.size, sidecars: n, internal, missing, ms: Date.now() - t0 }));
  console.log(`lyrics: ${seen.size} tracks in redis (${n} sidecars, ${internal} from Jellyfin's metadata folder only, ${missing} sidecars without audio) in ${Date.now() - t0} ms`);
  return { count: seen.size, sidecars: n, internal, missing };
}

export async function get(id) {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const r = await redis();
  const v = await r.get(`lyrics:${id}`);
  return v ? JSON.parse(v) : null;
}

export async function stats() {
  const r = await redis();
  const v = await r.get('lyrics:loaded');
  return v ? JSON.parse(v) : null;
}
