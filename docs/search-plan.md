# Search overhaul — research and plan

Goal: make search the thing people notice about Conduit. Spotify-grade or
better: instant, forgiving, ranked for *you*, and able to find a song from a
half-remembered lyric.

## Where we are (measured 2026-09-11)

Library: 27,062 tracks · 3,214 albums · 4,388 artists · 59 playlists ·
19,224 `.lrc` lyric files (~30 MB of text). All searches go straight to
Jellyfin (`/Items?searchTerm=` ×3 + `/Artists?searchTerm=`, in parallel).

| query | Jellyfin | notes |
|---|---|---|
| `daft` | 0.9 s | finds Daft Punk (the "disappearing" bug was OUR race: the reply for `daf` landed after `daft` and overwrote it; fixed) |
| `dft punk` | 0.6 s | **0 results** — no typo tolerance |
| `around the wrld` | 0.6 s | **0 results** |
| `beyonce` | 1.0 s | works only because Jellyfin folds accents on CleanName |
| `get lucky` | 0.5 s | fine, but no ranking: the Drumless Edition ties with the original |

Jellyfin's search is `LIKE %term%` over a cleaned name column, per entity
type, per request. Structural limits, not tunable:

- ~1 s per keystroke, three round trips, no cancellation → stale-result races
- substring only: no typo tolerance, no word-order freedom, no synonyms
  (`feat`/`ft`, `&`/`and`, `vol`/`volume`, `pt`/`part`)
- no ranking signal beyond alphabetical; no popularity, no *your* history
- can't search lyrics, years, genres, or combine them (`daft 2013`)
- can't produce a confident "Top result" (we guess client-side with `startsWith`)

## Options considered

### A. Client-side index (MiniSearch / FlexSearch / Fuse in a Web Worker)
Download every item once (~27k tracks; ~1 MB gzipped), build the index in the
browser, persist in IndexedDB, sync deltas. **Pros:** zero infra, ~1 ms
queries, works offline. **Cons:** every device builds and maintains its own
copy (a phone on data pays the megabyte, then the CPU); lyrics are out
(30 MB); ranking has to be hand-rolled; two implementations to keep in step if
the desktop and web ever diverge. Good enough for names alone; not a selling
feature.

### B. Meilisearch (server, Docker) — **recommended**
Purpose-built for exactly this: typo tolerance (1 typo ≥5 chars, 2 ≥9),
prefix search on every keystroke, diacritic folding, synonyms, stop words,
custom ranking rules, filters/facets, highlighting + cropping (for lyric
snippets), multi-search (one HTTP call for tracks+albums+artists+playlists),
sub-20 ms responses. Single binary, ~200 MB RAM for this corpus, official JS
client, `getmeili/meilisearch:v1.53` on Docker Hub. .85 has 16 GB free.

### C. Typesense
Equivalent feature set, also excellent. Slightly stricter schema, mandatory
API keys, fewer "it just works" defaults for ranking. Would also do the job;
Meilisearch's relevancy defaults and cropping are the better fit for
lyrics.

### D. Solr / Elasticsearch / OpenSearch
JVM, 1–2 GB RAM, schema and analyzer configuration, index tuning. Built for
100M-document clusters. For 35k documents this is all cost and no benefit —
Solr specifically would be the slowest to get right and the most to keep
patched. Not recommended.

### E. SQLite FTS5 (trigram) inside the relay
Lightweight and already in our stack (Node). Trigram tokenizer gives
substring + rough typo behaviour. But typo tolerance, prefix ranking,
synonyms and snippets would all be ours to write and tune — that is
Meilisearch's whole product, and we would end up with a worse copy of it.

**Decision: Meilisearch, fronted by the relay so no search key ever reaches a
browser.**

## Architecture

```
Jellyfin ──(sync, every 5 min + on LibraryChanged)──▶ Meilisearch (docker, .85, LAN only)
                                                            ▲
 browser / desktop ── GET /relay/search?q=…  ──▶  relay (verifies Jellyfin token,
                      Authorization: MediaBrowser Token   multi-search, personal re-rank)
```

- **Meilisearch container** at `/home/admin/services/meilisearch`, joined to
  `docker_internal` so the relay reaches it as `http://meilisearch:7700`;
  no host port. Master key in the compose env; the relay uses a search-only
  key. Data volume `./data`.
- **Sync** (`tools/search-sync/sync.py`, cron + relay-triggered): pulls
  tracks / albums / artists / playlists from Jellyfin with the fields below,
  reads each track's `.lrc` from disk (timestamps stripped), upserts by
  Jellyfin id, deletes ids that vanished. Full run ≈ 30 s; incremental via
  `DateLastSaved` after the first. Also fed by Jellyfin's `LibraryChanged`
  websocket so a new download is searchable within seconds.
- **Relay `/search`**: token-verified (already does this for the socket),
  fans out one Meili multi-search, applies the per-user re-rank (below), and
  returns `{ top, tracks, albums, artists, playlists, tookMs }`. Falls back to
  Jellyfin's search if Meili is down, so search never breaks.
- **Client**: `jf.search()` → `relaySearch()`; results stream per keystroke
  (no 250 ms debounce needed at 20 ms), stale replies dropped, keyboard
  navigation, recent searches, lyric snippets.

## Index design

**tracks** (27k): `id, name, artists[], artistIds[], album, albumId,
albumArtist, year, genres[], durationSec, plays (sum over users), favourites
(count), lyrics (plain text), path` — searchable in that order of weight
(`name` > `artists` > `album` > `lyrics`); filterable `artistIds, albumId,
year, genres`; sortable `plays`.

**albums** (3.2k): `id, name, artists[], year, type (album/single/EP/comp),
trackCount, plays`. **artists** (4.4k): `id, name, aliases[] (the old
spellings, so "JAY-Z" still finds "Jay-Z"), trackCount, plays`.
**playlists**: `id, name, owner, trackCount`.

Ranking rules per index: `words, typo, proximity, attribute, exactness,
plays:desc`. Synonyms: `feat ↔ ft ↔ featuring`, `& ↔ and`, `vol ↔ volume`,
`pt ↔ part`, `remix ↔ rmx`, `mix ↔ remix`? (no — different things). Stop
words: `the, a, of` only in ranking, not matching (Meili handles this).

## What makes it the selling feature

1. **Instant & forgiving.** Results on every keystroke, ≤30 ms, typos and
   accents don't matter: `dft pnuk`, `beyonce`, `arond the wrold` all work.
2. **Lyric search.** Type a line — *"we're up all night to get lucky"* — and
   the track appears with the matching lyric line highlighted under it,
   tappable to play from that line (we have the `.lrc` timestamps). Nobody
   else's home player does this.
3. **One confident Top result.** Artist exact/near-exact match beats album
   beats track; ties broken by *your* plays. Enter plays it.
4. **Ranked for you.** Meili ranks by relevance and global popularity; the
   relay re-ranks the top 50 with the requesting user's play counts,
   favourites and recent plays (from Jellyfin, cached 5 min), so *your*
   "Sit Next to Me" outranks a remix you never play.
5. **Operators when you want them.** `artist:daft`, `album:discovery`,
   `year:2013`, `year:2010-2015`, `genre:house`, `liked:` — parsed client-side
   into Meili filters; plain words otherwise.
6. **Search inside** a playlist / album / Liked Songs: same engine, filtered
   to that context (`playlistId`/`albumId` filter), so the 1,400-song Liked
   Songs page gets a filter box that actually works.
7. **Zero-state and recents.** Recent searches (per account, synced like
   prefs), "Browse all" genre tiles from the index facets.
8. **Keyboard-first.** `/` focuses search, `↑↓` moves, `Enter` plays the top
   result, `⌘Enter` opens it.

## Phases

- **Phase 1 — engine swap (one session):** Meilisearch container, sync
  script + cron, relay `/search` with token check and Jellyfin fallback,
  client swap, typo/prefix/federated results, Top result, stale-reply guard
  (done), keyboard nav. Ship behind a feature flag in Settings for a day.
- **Phase 2 — lyrics + operators:** `.lrc` ingestion, highlighted snippet,
  play-from-line, operator parsing, search-within-context, recents.
- **Phase 3 — personal ranking + browse:** per-user re-rank in the relay,
  genre facets zero-state, "did you mean" from Meili's typo info, analytics
  (what people search and don't find → what to download next via Music
  Requests).

## Risks / notes

- Relay must not become a single point of failure for search: keep the
  Jellyfin fallback path and a 2 s timeout.
- Item ids change when files move (see the album merge); the sync keys on
  Jellyfin ids and deletes stale ones each run, so this self-heals.
- Meili memory: ~200 MB now; lyrics add ~150 MB. Fine on .85.
- Public exposure: only the relay's `/search` is reachable from the internet
  (via `music.baxtergroup.io/relay`), and it requires a valid Jellyfin token.
