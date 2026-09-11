# Conduit — session handoff (2026-09-11)

Pick-up notes for the next session. Two open items: an HTTPS/DNS fix (blocking),
and a Liked Songs bug audit (in progress).

---

## 1. OPEN — browser no longer served over HTTPS (decision needed)

### Diagnosis (confirmed)
`music.baxtergroup.io` is **no longer proxied through Cloudflare** (grey cloud /
DNS-only). It resolves straight to the home origin on every resolver:

- `music.baxtergroup.io` → `205.250.241.235` (Telus origin) on 1.1.1.1, 8.8.8.8, LAN
- `jellyfin.baxtergroup.io` → `172.67.x / 104.21.x` (Cloudflare) — still orange, so its HTTPS is valid

Because it's grey, `:443` hits the origin directly, and the origin only has a
self-signed placeholder cert (`subject/issuer CN = break`, O = BaxterGroup) → the
browser rejects HTTPS. Plain HTTP `:80` returns 200, so the app half-works.
This also breaks the **PWA + relay WebSocket on the phone** (service workers and
`wss://` need valid HTTPS).

NOT caused by this session's code deploys — it's the DNS/proxy state. (Earlier
HTTPS checks only "worked" because `curl -k` ignored the bad cert.)

### Fix options (pick one next session)
- **A. Re-enable Cloudflare proxy (orange cloud) on the `music` record.** Matches
  jellyfin, CF serves a valid edge cert (Flexible → origin :80), re-hides the home
  IP. BLOCKER: no Cloudflare API token on .85, so this needs the CF dashboard, or
  the user pastes a token and we script it. **Recommended.**
- **B. Real Let's Encrypt cert on the origin** for `music.baxtergroup.io` + a
  proper `:443` nginx vhost proxying to the `conduit-lan` container (with `/jf`
  and `/relay`). Doable end-to-end from the server with no CF creds (origin IP is
  already public via the grey record, so nothing new is exposed). Verify HTTPS +
  the relay WS after.

### Facts to reuse for either path
- The app is served by the `conduit-lan` container (`:8748`), which proxies
  `/relay`→8788 and `/jf`→2101 and serves static from
  `/home/admin/services/nginx/html/conduit`. (The system-nginx `default` vhost
  serves empty `/var/www/html` — not the app.)
- `.85:443` currently answers with the self-signed `CN = break` cert (no real
  vhost/cert for music). For Path B, HTTP-01 is feasible since `:80` is publicly
  reachable (returns 200).
- Deploy web build = `npm run build:web` then
  `rsync -az --delete dist/ server:/home/admin/services/nginx/html/conduit/`.

---

## 2. IN PROGRESS — Liked Songs add/remove audit (user reported bugs)

User asked: "add/removing liked songs from different spots in different pages —
make sure it's all working, I was experiencing bugs." Audit not finished — was
mapping the code when we stopped.

### Where liking happens (all call the same `onLike(track, liked)` in App.jsx)
- `src/components/TrackRow.jsx` — heart on every track row (albums, artists,
  playlists, search, Liked Songs). `onLike(track, !liked)`.
- `src/components/Player.jsx` — footer heart. Uses `current.UserData?.IsFavorite`.
  NOTE: footer heart is gated on `current` (the local queue item) — likely BROKEN
  on a mirroring client where `current` is null (mirrors show `nowPlaying`, not
  `current`). Candidate bug. Consider using `nowPlayingId`/session track.
- Sidebar / Home / Library — open Liked Songs; Library shows the heart per row too.

### State flow (App.jsx ~lines 174-304)
- `onLike` (line 284): optimistic `patchLiked` → `jf.setFavorite` → toast +
  `likedCount` +/-1 → updates `likedCacheRef` + the open `detail` if it's the
  Liked Songs view; rolls back `patchLiked` on error.
- `patchLiked` (line 175): patches `detail.tracks` and `player.patchQueue`.
- `likedCacheRef` / persisted `'liked'`, `'likedCount'`.
- `jf.setFavorite` (src/api/jellyfin.js:320) → POST/DELETE
  `/Users/{userId}/FavoriteItems/{itemId}`.
- `favoriteTracks` / `favoriteCount` (jellyfin.js ~329-347), `Filters:IsFavorite`.

### Suspected bugs to verify next session
1. **Footer heart on a mirroring client**: `current` is null when mirroring, so
   the heart won't render / reflects the wrong track. Wire it to the session
   track (`nowPlayingId`) like lyrics were.
2. **Optimistic `patchLiked` doesn't touch `likedCacheRef`/home shortcuts** — a
   like/unlike from an album page may not reflect in an already-open Liked Songs
   page until reopened (partly handled in the try-block; confirm ordering — the
   optimistic patch and the cache update are in different spots).
3. **Cross-client sync**: liking on one device doesn't propagate to other clients
   (favorites aren't broadcast over the relay). Decide if in scope.
4. **`likedCount` drift** when liking an already-liked / unliking an already-
   unliked track (double taps) — count math is unconditional +/-1.
5. **`row` in onLike hardcodes `IsFavorite: true`** even on the unlike branch
   (harmless since it's filtered out, but confirm).

### Plan for next session
- Reproduce each spot (album row, artist row, playlist row, search row, Liked
  Songs row, footer heart, Library row) liking + unliking; watch count, the open
  page, and the heart state.
- Fix the footer-heart-while-mirroring first (clearest bug).
- Add a headless test (`test/liked.test.mjs`) that likes/unlikes from a couple of
  surfaces and asserts count + row state + Liked Songs page membership stay
  consistent. Kill any running desktop app first (it shares the session and
  pollutes tests — see below).

---

## Shipped 2026-09-11 (done, deployed to :8748, tested)
- Speakers everywhere: the active player broadcasts its output `device`
  ({id,kind,name}); the green bar says "Playing on NODE 2i-98C1" on EVERY
  client (including the one driving it) when the session is on a speaker, and
  the picker shows the speaker. Browser pickers list LAN speakers from
  `roster.lanDevices`; picking one sends `transfer{deviceId}` to `viaClient`
  (the desktop), which stops its old output, switches device and resumes.
  Picking a client = its own output (`deviceId:'local'`). RELAY FIX: every
  private IP (+ the home WAN IP, learned via ipify hourly / HOME_PUBLIC_IP)
  folds into one 'lan' network -- before, desktop (192.168.1.x direct) and
  browser (192.168.1.y via nginx XFF) were "different networks", so the web
  never saw the speakers. `test/speaker.test.mjs`. Relay redeployed.
- Footer heart follows the SESSION track (nowPlaying.itemId/liked): works on
  a mirroring client; a like there sends `patchLiked` to the active player so
  its queue (source of the mirrored state) updates. `test/liked.test.mjs`.
  Handoff item #2.1 done; #2.2-2.5 of the Liked audit still unverified.
- Playback memory: last track/queue/playhead/modes restored PAUSED on open;
  play resumes at the saved spot; queue end parks on the last track (no more
  "Nothing playing"). `test/restore.test.mjs`.
- Mirrored cover art resolved by item id via the local jf client (desktop
  mirroring a web player had a broken image).
- Browser local device is "This Web Player" (was "This Computer").
- `_lsPrefix` getter fix (first-session caches were written under the wrong key).
- ALL TESTS NOW USE THE `conduittest` JELLYFIN USER (pw Conduit-Test-9921). A
  run as lukasbaxter hijacked the live web player. Do not switch back.

## Shipped earlier this session (done, deployed, tested)
- Browser→desktop transfer via device picker (was restarting at 0:00 / looping):
  new `transfer` command — target claims + resumes current track at position,
  sender stops + mirrors + shows green bar.
- Device picker reflects the SESSION's active device (fixed "this computer" vs
  "this browser" contradiction).
- Relay restart no longer loses the green bar: client re-claims on reconnect
  (`_claimed` in src/relay.js), server adopts a playing client if no active claim.
- Browser/phone clients auto-named "Web Player (N)".
- Repeat (off/all/one) + shuffle (off/on/smart) with Spotify-style buttons; end of
  queue repeats or, on smart shuffle, continues via Jellyfin InstantMix.
- Controller toggle-off fix: cycle next-mode is computed from the mirrored mode,
  not a stale local ref (was stuck "on").
- Flat consistent-stroke icons for shuffle/repeat/smart-star and the green-bar
  cast icon (old fill icons had vanishing thin strips / broken glyph).
- Synced lyrics follow the session track (`player.nowPlayingId`), so they work on
  mirroring clients too.

### Tests (all green): run with `node test/<name>.test.mjs`, hit `:8748` directly
- `mirror.test.mjs`, `handoff.test.mjs`, `coldopen.test.mjs`, `modes.test.mjs`
- **GOTCHA:** kill any running desktop (`npm run dev` / electron) before tests —
  it joins the same shared session as the same user and pollutes results.

## Environment quick ref
- Repo: `~/Projects/conduit`. Web: `npm run build:web`. Desktop (dev):
  `npm run dev` (unpackaged loads localhost:5173; packaged loads dist).
  Package a real app: `npm run dist:mac`.
- Relay: `conduit-relay` container on .85:8788; source `~/Projects/conduit/relay/`;
  `ssh server` → `/home/admin/services/conduit-relay`; redeploy
  `sudo docker compose up -d --build`. In-memory state (wiped on redeploy — that's
  why re-claim/adopt exist).
- Jellyfin: .85:2101, user `lukasbaxter` / `Conduit-Temp-4417`.
- Both `conduit-relay` and `conduit-lan` were Up and healthy at end of session.
- The desktop app was left running via `npm run dev`.
