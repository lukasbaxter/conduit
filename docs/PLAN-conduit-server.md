# Conduit Server: one container, your music folder, done

Status: PLAN (2026-09-17). Nothing here is built yet. Today Conduit runs on
Jellyfin + a relay + Meilisearch + Redis + nginx + Python hygiene scripts.
This is the plan to fold all of that into one image that any homelab user
can run with `docker compose up`, and to stop depending on Jellyfin.

## Why (what a day of measurement showed, 2026-09-16)

Every slow thing on the phone traced back to Jellyfin, not to the phone,
the network or the app:

| Jellyfin call | Measured | What the app needed it for |
|---|---|---|
| album list (500 of 3,226) | 5-12.5 s | Library tab, Search |
| artists (500) | 2.4-3.2 s | Home, Search |
| recently played / most played (IsPlayed sorts) | 1.5-4 s each | Home shelves |
| favourites for a 1,404-like account | 18-21 s | Liked Songs |
| rows by id, 150 at a time | 1.2-2.6 s per chunk | Liked Songs, playlists |
| lyrics | 10-300 ms, re-read from disk | lyrics view |
| covers | JPEG q90, Last-Modified = now, no max-age | every screen |
| audio transcode | flat-out chunked MP3, no ranges, no HLS for audio by default | phone streaming |

Plus: a stuck EF row made every update to one user 500 for days, the
Playback Reporting plugin threw every minute, `ChildCount` doubled a query,
and its 564 MB SQLite needed a VACUUM. We worked around all of it by moving
reads onto the relay (likes, liked rows, library lists, home, lyrics) and
putting nginx caches in front. That is the shape of the answer: **the
relay already is most of the server. Finish it.**

## The product

One image `conduit-server`. One compose file. The music folder is read
straight off disk by our own scanner and streamed straight off disk by our
own server; nothing else sits between the files and the app.

```yaml
services:
  conduit:
    image: ghcr.io/lukasbaxter/conduit-server
    ports: ["8080:8080"]
    volumes:
      - /path/to/music:/music:ro      # any layout; tags + folder covers + .lrc sidecars are enough
      - ./data:/data                  # database, artwork cache, transcode cache
    environment:
      PUBLIC_URL: https://music.example.com   # what phones and speakers reach
      # optional: Soulseek + Explo (leave unset = hidden)
      # SLSK_USER: ...
      # SLSK_PASS: ...
      # EXPLO_SPOTIFY_ID / EXPLO_SPOTIFY_SECRET / EXPLO_LISTENBRAINZ_TOKEN
```

First launch opens a setup page: create the admin account, pick the music
folder (already mounted), scan. Users are invited by link. TLS is the
reverse proxy's job (Caddy/nginx/CF tunnel), documented, not bundled.

The web app, the phone app, the desktop app and the speakers all talk to
this one process. Music gets into `/music` however the user likes (Lidarr,
slskd, rsync, a USB stick); the server only reads it.

## Architecture (single Node process, one SQLite file)

```
/music (ro) ──scan──► SQLite (WAL) ──► HTTP API + WebSocket session relay
                        │ tracks/albums/artists/genres
                        │ users/sessions/likes/playlists/plays/prefs
                        │ lyrics (in-memory map on top)
                        │ search: FTS5 + in-process fuzzy index (no Meilisearch)
                        └ artwork: pre-rendered 64/160/320/640 WebP+JPEG, content-hashed, immutable
/data/transcodes ◄── ffmpeg (HLS AAC segments + progressive MP3/Opus), cached per (track, profile)
```

Decisions, with the reason each way:

1. **Keep Jellyfin's item ids** (`MD5(UTF-16LE("MediaBrowser.Controller.Entities.Audio.Audio" + path))`,
   the formula the relay already uses for playlists and lyrics). Every
   existing like, play, playlist row and lyric key carries over with no
   remap, and the client's `Id` fields keep working. Albums/artists get the
   same treatment (Jellyfin hashes those from type + name/path too; verify).
2. **Own scanner, not Jellyfin's.** `music-metadata` for tags (fast, every
   format), folder `cover.jpg`/embedded art, `.lrc` sidecars, multi-artist
   splitting with the delimiter + whitelist rules from `tools/library-hygiene`
   (they become server config, not a Python cron). Incremental: mtime + size
   per file, inotify/chokidar for live additions, full rescan on demand.
3. **Search in-process.** FTS5 for exact/prefix over 30k tracks is ~ms;
   a small fuzzy layer (trigram or `minisearch`) for typos. Drops the
   Meilisearch container. If a library is 300k tracks it is still fine.
4. **Lyrics**: sidecars + LrcLib fetch by duration (the `lyrics_check.py`
   logic, in Node, run per track at scan) into a table; served from RAM.
   Drops Redis.
5. **Artwork**: rendered once at scan with `sharp` to 4 sizes, WebP with
   JPEG fallback, named by content hash so clients and proxies cache them
   forever (`Cache-Control: immutable`). Missing art: MusicBrainz/CAA and
   Deezer lookups are an optional Explo job, not core.
6. **Streaming is HLS + byte ranges, not a custom protocol.** Originals
   served with `Range` (lossless, seekable, what speakers and the desktop
   want). Transcodes: HLS (AAC, 3 s segments) for everything; Safari plays
   it natively, Chrome/Android through hls.js in the client. Segments are
   produced by one ffmpeg per (track, bitrate) and cached, so the second
   listener costs nothing and a skipped song costs one or two segments.
   Prewarm = ask for the playlist early (already in the client).
7. **Accounts are ours.** users (argon2id), long-lived device tokens, roles
   (admin/user), invite links. Likes, playlists, play history, prefs,
   scrobbling tokens: the relay tables already exist. Optional later:
   Subsonic API compatibility so third-party apps work too.
8. **The session model stays** (single active player, mirroring, transfer,
   speakers through the desktop). It is the relay code, moved in.
9. **Explo and Soulseek live in the same image.** Lukas's rule: one
   container, set env vars, done. The image ships the `slskd` binary
   (self-contained .NET build) and the server supervises it as a child
   process when `SLSK_USER`/`SLSK_PASS` are set; its web UI is proxied at
   `/slskd` for the curious, but the app never needs it: the server drives
   slskd's own API (search, enqueue, transfers) to do what Music Requests +
   `sldl` do today (whole-release requests, artist/album matching, the
   "index.sldl" and cover-art gotchas already learned). Downloads land in a
   staging dir inside `/data`, get tagged/checked (the retag + LrcLib +
   cover rules), then move into `/music/<Artist>/<Album>/` and the scanner
   picks them up. Explo's other sources are env vars too: `EXPLO_SPOTIFY_*`
   (playlist import), `EXPLO_LISTENBRAINZ` (recs), Deezer (no key). Nothing
   set = the Explo tab is hidden and slskd never starts. `/music` must be
   writable for this; read-only otherwise.

## Migration for us (no big bang)

The client already goes through `src/api/jellyfin.js` + `src/api/search.js`.
The server implements the same routes the client uses today under `/jf`
(Items, Users/AuthenticateByName, Audio/{id}/stream|main.m3u8, Images) plus
the `/relay/*` ones, so the client switches by base URL, then the Jellyfin
shapes are trimmed to what we actually use.

1. Server reads `/mnt/wd_nvme1/music`, ids match; import users (names, the
   `henryb`/`henrybaxter` cases), favourites + play counts once from
   Jellyfin's API; playlists from `playlist.xml`. The relay's SQLite comes
   along as-is.
2. Point the web build at the server; keep Jellyfin running for video.
3. Desktop + phone point at the server. Speakers fetch from `PUBLIC_URL`.
4. Retire the relay container, Meili, Redis, the hygiene cron, the nginx
   image/transcode locations. Jellyfin keeps the video library only.

## The perf checklist, mapped to this

From the list that started this: what is done, what the server makes
possible, what is a client task.

| Item | State |
|---|---|
| Cache API responses | client memo + persisted lists (6 h); server: ETag + `Cache-Control` on every list, `immutable` on art |
| Index the database | own schema, indexes on (album, disc, track), (artist), (uid, at) for plays/likes |
| Compress images | q72/82 now; pre-rendered WebP at scan in the server |
| Loading skeletons | done on the phone |
| Cache expensive queries | relay memo/SQLite cache now; server keeps counts (album track counts, play totals) as columns, not live aggregates |
| N+1 queries | today's `Items?Ids=` chunks and per-album counts; server answers lists in one query |
| Debounce input | search does |
| Code splitting | visualizer is split; History, Settings, Calibrate, the desktop-only device code next |
| CDN | not for a homelab; nginx/Caddy caching in front is documented |
| Server-side caching | relay memo now; server: list caches invalidated by scan events |
| Paginate large lists | album list is one 395 KB gz blob; server: cursor pagination + client virtualised lists |
| Lighthouse audit | run one against the phone build and fix what it lists |
| Compress payloads | gzip on /relay now; brotli in the server |
| Unnecessary re-renders | React profiler pass on Home and the track list (Player state changes every 250 ms: isolate) |
| Minify JS/CSS | Vite does |
| Lazy loading | cards/rows lazy; below-the-fold shelves render on scroll |
| Defer non-critical scripts | audiomotion/Calibrate already dynamic |
| Unused dependencies | castv2/bonjour only in Electron; audit the web bundle |
| DB connection pooling | n/a (SQLite, single process, WAL) |

## Order of work

1. **Server skeleton** in `server/`: SQLite schema, scanner (tags, covers,
   lyrics), id formula, static originals with Range, artwork sizes.
   Point the web build's `/jf` at it read-only alongside Jellyfin; compare
   lists and ids against Jellyfin's for our library (a script).
2. **Search + Home + Library + Liked + playlists** on the server (port the
   relay routes; FTS5 + fuzzy). Retire Meili.
3. **Streaming**: HLS transcodes with the segment cache; hls.js in the
   client for non-Safari; kill the nginx `/universal` shaping.
4. **Accounts + session relay** moved in; importer from Jellyfin; the
   phone/desktop/web switch over; Jellyfin becomes video-only.
5. **Packaging**: Dockerfile (Node + ffmpeg + slskd binary), compose,
   setup page, GHCR publish in the release workflow, README for homelab
   users; Explo + Soulseek behind env. Health: one `/healthz` that also
   reports slskd's state.
6. Perf pass from the table (pagination/virtualisation, Lighthouse,
   re-render profile, bundle audit).

Open questions for Lukas: ship Subsonic compatibility (other apps, more
users)? WebP vs JPEG-only for art (Safari fine either way)? Name of the
image: `conduit-server` vs just `conduit`?
