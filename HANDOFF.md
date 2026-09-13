# Conduit — session handoff (2026-09-12)

Pick-up notes for the next session. Open: the HTTPS/DNS fix (still blocking the
phone PWA), the rest of the Liked Songs audit (#2.2-2.5), and a few library
leftovers listed at the bottom.

## Shipped 2026-09-13 (later; deployed, relay redeployed)
- Genre browse fixed: `bucketsOf(tag)` in relay/server.js files each of the
  600 raw genre tags under ONE bucket by its HEAD word ("Emo Rap" is rap,
  "Pop Punk" is punk, "Dance-Pop" is pop), two-word heads first ("trip hop",
  "drum and bass"), regex rescues for foreign spellings, and years / track
  numbers / one-letter fragments dropped. Tags with an indie/alternative
  modifier ALSO file under Indie. The old per-bucket substring regexes
  (`emo` -> Rock) are gone. Remaining unbucketed: ~1.1k tracks of junk tags.
- Search: the "N ms" counter is hidden (kept in the DOM, `hidden`, because
  test/search.test.mjs waits on `.search-took`).
- Playlist "Recommended" (Spotify's bottom-of-playlist section): 10 songs from
  instant mixes off 3 random members of the playlist, interleaved, minus what
  is already in it; outlined Add pill (row disappears, `onAddTo`), Refresh
  reseeds. Not on Liked Songs or Daily Mixes. `reco`/`recoGen` state in Library.jsx.
- HISTORY tab (profile menu -> History; `src/components/History.jsx`, kind
  'History'): stats.fm for the account. Relay `GET /history?range=4w|6m|1y|all&tzo=`
  mirrors the account's ListenBrainz listens to `/data/history-<uid>.json`
  (first open backfills everything in pages of 250 -- LB times out on 1000 --
  ~90 s for 2k listens; later opens serve at once and refresh behind if older
  than 3 min), matches each distinct artist|title to a library track through
  Meili once (`match` map in the store: id/albumId/artistId/duration/genre
  buckets) and computes streams, minutes, unique counts, top tracks / artists
  / albums, top genres, listening clock, weekday, streams per day (client
  timezone via `tzo`), and `sources` (conduit vs spotify -- LB's Spotify
  connector imports count automatically). `?recent=1&before=<ts>` pages the
  raw listens. Rows with a library match play (`jf.itemsByIds`). Users without
  a LB token get a "connect in Settings" card. LB's own stats endpoints
  return 204 on this account, which is why the relay computes them.
- Scrobble dedupe: `lbLast` per ACCOUNT -- the same item is not submitted
  twice within 90% of its length (a socket reconnect or handoff used to
  double-scrobble: "the fatalist" x2 62 s apart).

## Shipped 2026-09-13 (deployed to :8748, relay redeployed, probed headless)
- Search: no "Artist" subtitle under artist cards.
- Row artist links are inline SPANS (`ArtistLinks` in TrackRow.jsx), not
  buttons. An inline-block button that spilled past the ellipsized artist
  line was hidden whole by the ellipsis but stayed clickable in the blank
  space (narrow window, "Daft Punk, ..." opened Pharrell). Inline text
  ellipsizes per character and the clipped part is not hit-testable.
- Lyrics side panel: blurred cover behind it (`.panel-bg`, same recipe as
  `.fs-bg`); footer mic/queue icons actually turn green when their panel is
  open (`.player-right .icon-btn` used to override `.icon-btn.on`).
- NEXT always lands on a track (manual skip at the end of the queue, in
  `advance()` in usePlayer.js): repeat all / context (playlist, album, liked,
  mix) -> `restart()` (reshuffled from the original order when shuffle is on,
  never opening on the track that just played); artist context -> `moreOfArtist()`
  (the rest of the artist shuffled, then an instant mix off the artist);
  no context (song clicked in search, radio) -> `smartNext(true)` instant mix.
  A track ENDING on its own still parks at the end as before (no auto-loop).
  Artist contexts are `artist:<id>` (`src/api/context.js`: ctxOf/ctxItemId);
  Home's album/playlist/liked plays now pass a context too.
- Artist page Popular = real popularity: relay `GET /popular?artistId&name`
  (Deezer artist top-100 matched by `normTitle` to the library's tracks for
  that artist, one row per title = the most played copy, then the rest by
  plays; cached 24h). `openArtistById` reorders the tracks by those ids
  (search limit raised 50 -> 150 so ranked tracks with 0 plays are present).
  5 rows, "See more" -> 10 (unchanged).
- Visualizer on a speaker: the shadow stream's sync tick read `player.position`
  captured when the effect ran (refreshed only every 5 s), so it dragged the
  shadow back ~1.5 s every couple of seconds -> picture behind the node. Now a
  live clock ref (`clockRef`, position + elapsed), 0.35 s tolerance, 500 ms
  tick, snaps on `loadedmetadata`, and streams the ORIGINAL file
  (`jf.streamUrl`) instead of a transcode so seeks are exact.
- Milkdrop REMOVED entirely (Lukas does not like it): butterchurn packages
  uninstalled, engine choice gone (the ⋯ menu is Style / Colours only), the
  relay `viz` message + `vizState` and the client `sharedViz`/`sendViz`
  plumbing deleted, `.fs-vizfull`/`.md-full`/`.viz-preset` CSS gone. Stale
  `engine`/`preset`/`favorites` keys left in `prefs.viz` are ignored.

## Shipped 2026-09-12 (now-playing view + visualizer; deployed, relay redeployed)
- Now-playing view (`src/components/FullScreen.jsx`) no longer asks the OS for
  full screen: the expand button fills the app window; if the window is
  already full screen it fills that. Tabs: Album · Lyrics · Visualizer (chevron
  on the right of Visualizer opens the settings menu). In Electron the top
  strip still drags the window (buttons opt out).
- LAYOUT GOTCHA fixed: `.fs > * { position: relative }` outranked
  `.fs-bg { position: absolute }`, so the blurred art became a 4th grid row.
  That pushed the album art down, gave the visualizer box zero height (black
  screen) and let the Milkdrop canvas size feed back into the layout (the slow
  downward creep). Rule is now `.fs > *:not(.fs-bg):not(.fs-vizfull)`.
- Visualizer (`src/components/Visualizer.jsx`): engines Graphic EQ
  (audiomotion-analyzer, Line/Area/LED/Bars/Mirror/Radial, gradients) and
  Milkdrop (butterchurn). Milkdrop fills the whole window behind tabs and
  transport (`.fs-vizfull`, scrims top/bottom); the EQ keeps its box 7vh down;
  the viz tab never shows the album art. Only audio-reactive presets are
  offered (`isReactivePreset`: ≥3 reads of bass/mid/treb/vol in the preset
  JSON, or ≥1 plus a visible base waveform; 89 of 100 pass).
- Favourite presets: settings menu → Save preset / Favourites only /
  Favourites › list. ALL viz settings (engine, style, gradient, cycle,
  favourites, favOnly) live in account prefs (`prefs.viz`, Jellyfin
  DisplayPreferences + relay `prefs` fan-out); localStorage `conduit.viz` is
  only the first-paint cache.
- Preset sync: relay message `viz` (`sendViz`/`onViz` in `src/relay.js`);
  the server stamps, remembers per user (in-memory `vizState`) and echoes to
  EVERY client incl. the sender, so simultaneous changes settle on one
  server-ordered preset; new clients get it on hello. Cycling is a resettable
  25–28 s timer restarted by any incoming preset, so N screens advance once.
- Viz while another client plays: `local` now also requires
  `!player.mirroring` (exported from usePlayer). `current` stays set on a
  mirroring desktop with a paused local queue, which made it analyse the
  silent local element. Remote playback is analysed via the silent shadow
  `<audio>` synced to the session playhead.
- Space bar: only text fields swallow it (range/button/link focus no longer
  eats it; keyup is cancelled so a focused button does not double-toggle;
  repeats ignored).
- Headless probes: `window.__vizAm` (audioMotion instance) when `?debug`.

## Shipped 2026-09-11 evening (deployed to :8748 + relay redeployed, tested)
- Library hygiene pipeline (`tools/library-hygiene/`, mirrored to
  `.85:~/conduit-hygiene`, nightly cron 04:30): 2,869 files retagged (1,272
  collab credits split, ~100 spelling variants unified), 18 split albums folded
  into one folder each, 3,421 artist portraits + ~490 album covers added.
  Remaining blanks: ~76 albums with no art anywhere (DJ-pool packs, "Unknown
  Album" folders) now fall back to the artist portrait; 16 artists with no
  match anywhere. Whole story + gotchas in the README there and in memory.
- Row context menu (Spotify order, right-click + dots), downloads (original /
  flac / wav / mp3 / aac / ogg), taste-profile exclusion, release types on the
  artist page, in-app playlist-name dialog, pause bars on hover.
- Relay session memory: a client opening with nothing active gets the
  account's last playback (paused at its playhead). `test/session.test.mjs`.
- Tests run off-LAN through an ssh tunnel with `CONDUIT_HOST=localhost`.

## Library leftovers (not done)
- Folder-backed artist items with the OLD spelling (`/music/USHER` next to the
  tag "Usher", 46 of them) cannot be deleted through the API (it deletes the
  folder) and Jellyfin never considers them dead; the client dedupes them.
  Renaming the folders would change every track id under them (favourites
  lost) — only worth it with the merge tool's snapshot/restore approach.
- Two duplicate single folders left in place after the merge (collisions):
  `DNMO & Wolfy Lights & Blooom/Bombalaya`, `Kesha;3OH!3/Animal`.


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
