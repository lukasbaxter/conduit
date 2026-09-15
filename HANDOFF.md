# Conduit — session handoff (2026-09-12)

Pick-up notes for the next session. Open: the HTTPS/DNS fix (still blocking the
phone PWA), the rest of the Liked Songs audit (#2.2-2.5), and a few library
leftovers listed at the bottom.

## 2026-09-15 (11:00-) -- search everywhere + discovery queue
- **Search everywhere** (Conduit): "Everywhere" chip on the search page -> relay `/gsearch?q=` -> Music Requests `/api/search` (Spotify albums/EPs/singles), each matched to a library album via Meili (exact title, or base title when unqualified) and to its request state. In-library rows open the album; the rest carry Request / Requested / Downloading / Added (same `requestRelease` as the artist page). Relay redeploy: `rsync relay/server.js server:/home/admin/services/conduit-relay/ && ssh server 'cd /home/admin/services/conduit-relay && sudo docker compose up -d --build'`.
- **Discovery queue** (server): `/home/admin/services/music-requests/discovery_queue.py` (host python3; MR is a host systemd service `music-requests.service`, not a container). Sources: `imports` (albums behind Henry's + Lukas's unmatched Spotify-import tracks), `recs` (ListenBrainz CF recommendations, public endpoints, username lukasbaxter), `similar` (LB labs similar-artists of the top listened artists -> their albums), `popular` (Deezer chart), `discover` (MR `/api/discover`). Skips compilations, anything queued/downloading/done, failures < 30 days, anything Jellyfin already has. `--dry` first. First run 2026-09-15 11:43 queued 610 (182/150/150/83/45). Weekly root cron Sun 04:00 (recs,similar,popular,discover) -> `discovery_queue.cron.log`. Gotchas found: `LISTENBRAINZ_USER_TOKEN` in explo/.env is EMPTY (sync_token.py finds no token in the Jellyfin prefs), the Navidrome container has been stopped for days so MR's Subsonic `album_in_library()` always says False, Spotify new-releases via MR returns 2024 material.

## 2026-09-15 (01:00-) -- phone: simulate at the real size, agents judge
Rule from Lukas after the first phone deploy shipped obvious bugs: never hand him a phone build that was only eyeballed at 390x844 without the notch. **Simulate at his exact phone (393x852 @3x, safe-area top 59 / bottom 34, real touch taps), then have review agents judge the screenshots against real Spotify, fix, re-run, THEN deploy.**
- Simulator: `APP=http://localhost:5175 node test/.probe/phone-sim.mjs` (gitignored, in `test/.probe/`; needs a dev server) walks every screen and writes PNGs + `findings.json` (overflow, clipped text, controls under the notch, small tap targets, console/page errors). The notch is emulated with the CDP command `Emulation.setSafeAreaInsetsOverride` so `env(safe-area-inset-*)` is real; this is what exposed the back chevron sitting 70pt down the page (`mobile-library.css` re-added a safe-area offset on a button already inside the padded fixed bar) and the mini-bar tap landing on the artist link.
- **The "press it 2-3 times" bug** (App.jsx long-press effect): its `touchend` cancel listener was in the bubble phase; the sheet scrim stops propagation there, so after dismissing any sheet the 450ms timer fired late and its click-swallow ate the NEXT tap (rows, mini bar). Listeners are capture-phase now. Also: TrackRow on the phone had only `onDoubleClick` (the play button is hidden) -> tap-to-play added; the mini bar's artist/art were links -> plain on the phone, any tap opens now playing on the album view (the last tab is no longer remembered on the phone); bottom sheets swipe down to close (App.jsx, dispatches an outside mousedown); Liked Songs caches every row (was capped at 1,500 -> refetched the tail on every open).
- Deploy = `npm run build:web && rsync -a --delete dist/ server:/home/admin/services/nginx/html/conduit/`; check `curl -s https://music.baxtergroup.io/ | grep -o 'assets/index-[^"]*\.js'` changed; he must force-quit the app to drop the cached bundle. The reviews from this pass live in `scratchpad/` of the session (not the repo).

## 2026-09-15 (00:00-02:00) -- phone layout rebuilt to Spotify iOS
Deployed to music.baxtergroup.io (the Expo shell wraps it; force-quit Expo Go to drop a cached bundle). Work was split across three git worktrees (`~/Projects/conduit-wt/{nowplaying,home-search,library}`, branches `wt/*`, all merged into master) plus review agents comparing screenshots against real Spotify shots (`scratchpad/spotify-ref`). Reviews: `scratchpad/review-1.md`, `review-2-browse.md`, `review-2-player.md`, `review-3.md`.

- **Per-area phone stylesheets** load after `app.css`: `src/styles/mobile-nowplaying.css`, `mobile-home-search.css`, `mobile-library.css` (all inside `@media (max-width: 760px)`). `usePhone()` (TrackRow.jsx) gates phone-only markup.
- **Navigation feel** (App.jsx): in-app stack mirrored into `history.pushState` (browser/Android back + iOS edge swipe walk it; WebView's own gesture disabled in `mobile/App.js`), edge-swipe back, page slide-in, detail top bar (`.mobile-topbar`) that turns solid with the title as the hero scrolls, per-tab stacks (the tab you came from stays lit; tapping the lit tab pops/scrolls to top), long-press = `contextmenu` (+haptic, synthesized click swallowed), swipe-down closes now playing (follows the finger; touches starting in sheets/lyrics/viz are ignored), mini player swipe = skip, account avatar = left drawer.
- **Sheets** (ContextMenu.jsx): `header` prop (art/title/sub) shown on the phone, slide-up, submenus stack as a second sheet (no hover-open on touch), Spotify's circled-plus / green check for likes ("Add to Liked Songs").
- **Track rows on the phone are flex** (the desktop grid template kept winning and squeezed titles to a third of the row).
- **Home/Search**: avatar + sticky chips row (chips filter in place), no greeting / Show all, 150pt cards, search focus mode with Cancel + recents (recents = items you opened, on every client), flat result list, empty states, browse tiles with covers. Navbar collapse rule is scoped with `:not(:has(.shell.show-lib))` (it used to fire on the Library tab and put the avatar over the chips).
- **Library/detail**: pinned header/chips/sort (only `.liblist` scrolls), 2-col grid, create-playlist sheet + name page, hero tints clamped/darkened on the phone (`heroTint(rgb, phone)`), Liked Songs with Find/Sort on top, artist "Popular releases" rows + See discography, Follow wired to Jellyfin favourite, Spotify-style Settings (Scrobbling sub-page), History chips, Profile Edit/⋯, skeleton rows while lists load.
- **Player**: NP = chevron / PLAYING FROM two-liner (`usePlayingFrom`) / ⋯ (full track sheet), cover on the 24pt gutter, circled-plus like, marquee titles, 44pt seek hit area, devices left / lyrics·viz·share·queue right; lyrics page = lyrics only over the blurred cover (owner's call), sung white / upcoming dim, no blank holes; queue page with long-press, lifted drag, pinned transport; device sheet "Connect to a device"; mini player floats over content (content padded), device line inside the card when the sound is elsewhere, keyed art, exit animations; `usePlayer.setError` swallows AbortError noise.
- Not done: NP cover carousel swipe, remaining-time display, search ranking of features vs primary artist (relay/Meili), Spotify Mix font.

## 2026-09-14 (night) -- state at hand-off
Everything below is deployed (web :8748 / music.baxtergroup.io, relay redeployed, desktop dev via `npm run dev`). Earlier-today sections were never written into this file; the commit log (`git log --since=2026-09-13`) and the memory note carry them.

### Shipped 2026-09-13/14
- **Relay store = SQLite** (`relay/db.js`, node:sqlite, `/data/relay.db`): sessions, listens/matches/history, caches, `likes`. Old JSON files imported once (`*.migrated`). Rule from Lukas: persistent state goes in a DB, never growing JSON.
- **Likes**: timestamps in relay `likes` (ws `like` msg, `GET/POST /likes`). Root cause of the liked-songs mess: `likedAt` lived in the Jellyfin DisplayPreferences blob and every client wrote its stale copy of the whole blob back (3 timestamps left for 1,419 favourites). Prefs now travel as PATCHES (relay + Jellyfin) and `setPrefs` re-reads before writing. Test `test/.probe/likes.mjs`.
- **Fast playlists**: relay `GET /playlist?id=` reads Jellyfin's `playlist.xml` (compose mounts `jellyfin/config/data/playlists` ro at `/jfdata/playlists`), derives item ids = .NET-Guid-ordered MD5 of UTF-16LE("MediaBrowser.Controller.Entities.Audio.Audio"+path) (verified), pulls rows from Meili (`id` filterable now); ~100 ms vs 780 ms. Client paints from it, Jellyfin's copy reconciles behind. PlaylistItemId == item id (XML has no per-entry ids).
- **Session memory**: relay remembers the session only from the active / last-active / actually-playing client (a paused mirror overwrote it when the active browser reloaded). Client: a client that has been mirroring adopts the session when its player vanishes instead of falling back to its old loaded track. Test `test/.probe/mirror-reload.mjs` (fails before, passes after).
- **Remote play latency**: the active player starts the chosen track as soon as its own record arrives and backfills the queue (~1 s saved). **Device switch** starts the new device before stopping the old one.
- **Music Requests -> Jellyfin**: requests download to the UNAS share, Conduit reads the SSD copy, nothing copied across since Sep 10. `sync_to_jellyfin()` in `app.py` rsyncs each finished album, writes `cover.jpg` (embedded -> Deezer; Jellyfin never uses embedded art for the ALBUM), notifies Jellyfin, schedules a hygiene pass 3 min later. `hygiene.sh` has a flock. Discography caches: relay 30 min, MR 6 h.
- **Jellyfin providers**: Fanart / Cover Art Archive / Discogs installed; library fetchers MusicBrainz+TheAudioDB (meta), TheAudioDB > CAA > Fanart (album images), TheAudioDB > Fanart (artists); MusicBrainz RateLimit 1.5 (SECONDS). They need MBIDs (~half the library), so hygiene `artist_images.py` + `album_covers.py` stay nightly; `fix_covers.py` squares non-square cover files (90 fixed). Lyrics were already Jellyfin's LrcLib.
- **UI**: History page = stats.fm clone (`src/components/History.jsx`, `.sf-*` CSS, relay `/history` ranges today/week/4w/6m/year/all, deltas, per-day charts, clocks); phone layout to Spotify iOS measurements (`@media (max-width:760px)` block, `isMobile`/`mobileLib` in App.jsx) + Expo shell `mobile/` (WebView; `npx expo start --lan`); now-playing view: seek on top, icon tabs vinyl/note/wave, device+volume bottom-right, lyrics Sync pill; footer untouched; pins in Your Library; mouse back/forward; header dots menu; context menus survive auto-scroll; playlist Recommended section; genre buckets by head word (`bucketsOf`); next always lands on a track (`artist:` contexts); artist Popular via relay `/popular` (Deezer); Milkdrop + all speaker-sync code REMOVED; visualizer shadow stream = transcode from exact offset + playbackRate trim.

- **Speaker timing** (commit `8cc7599`): BluOS's long-poll does NOT return on the second tick (verified: 30 s timeouts while playing), so the player polls `/Status` at 200 ms until two readings straddle a counter change (tick pinned to ~100 ms, measured drift < 30 ms over 17 s), then 1 s checks that leave the anchor alone while it agrees with the floor reading (this also killed the head's per-poll jitter; Cast likewise only re-anchors when off by > 0.3 s). This was the "head takes 30 s to match the Node" bug. The residual is the speaker's output buffer, which no protocol reports, so the viz menu has **Calibrate by tapping** (`src/components/Calibrate.jsx`, maths in `src/api/tapSync.js`): pause -> jump -> tap when the music returns (reaction tap = coarse, resolves which beat), then 12 s of tapping to the beat cross-correlated with the shadow stream's spectral-flux onsets. Result stored per device id on the relay (`devices` table, ws `offset`, in `hello-ok`), shared by every account; `Visualizer` runs the shadow `offset` seconds behind the reported playhead. Unknown speaker = 0, no mic, no constants. Only the client driving the speaker can calibrate (mirrors see a disabled item). Synthetic solver test: `node test/.probe/cal-solver.mjs` (recovers 0.12 / 1.23 / -0.30 s at 80-170 BPM within ~35 ms). **Not yet tapped through on the real Node/TV** -- Lukas to try.

### Open / check tomorrow
- Hygiene pass ran ~01:40 PDT for missing artist portraits (Tool, Tyla, Alex Isley), orphan "Calvin Harris; X" entries, "Tyla feat. X" splits (4 files retagged). Verify artists have images; nightly 04:30 covers the rest. Before: 29 artists / 12 albums without images.
- A stray **Windows Chrome tab** ("Web Player (1)") holds Lukas's session; close it or transfer.
- Jellyfin logs a PlaybackReporting DbUpdateConcurrencyException every 2 min since Sep 13 18:29 (two sessions of the same user); recheck once the Windows tab is gone.
- Discogs plugin is metadata-only, needs a token if enabled. Expo shell only wraps the web app.

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
- Jellyfin: .85:2101, user `lukasbaxter` / `<reset 2026-09-15 by the agent; Lukas has it in his password manager, not recorded here>`.
- Both `conduit-relay` and `conduit-lan` were Up and healthy at end of session.
- The desktop app was left running via `npm run dev`.
