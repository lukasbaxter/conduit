# library-hygiene

Keeps the Jellyfin music library that Conduit fronts organised: one artist per
real artist, collaboration credits split into their members, a portrait on
every artist and a cover on every album. Everything runs on .85 (the music
lives at `/mnt/wd_nvme1/music`, Jellyfin at :2101, Lidarr at :8686) from
`~/conduit-hygiene`, which mirrors this directory plus its state files.

Pipeline (`hygiene.sh` runs it nightly):

1. `scan_tags.py` — dump artist/albumartist/album/title of every file.
2. `oracle.py` — ask Lidarr (MusicBrainz) and Deezer which strings are real
   artists, their canonical spelling, fan count and portrait URL. Cached in
   `oracle.json`; only new strings are looked up.
3. `plan_names.py` — decide the new tags. Strong separators (feat/ft/vs) always
   split. Weak ones (`, & / with and x +`) split only into pieces the oracles
   know, choosing the fewest pieces so "Earth, Wind & Fire" survives; joint
   credits that Deezer lists as pseudo-artists ("21 Savage & Metro Boomin")
   are recognised by their tiny fan count next to their members. Spelling
   variants of one artist collapse to a spelling already in the library.
   `overrides.json` `keep` pins names the oracles get wrong.
4. `apply_tags.py` — write the tags (mutagen), guarded by the exact old value;
   the applied log is the undo file (`--reverse`).
5. `refresh_changed.py` — Jellyfin re-probes exactly the changed tracks with
   `ReplaceAllMetadata` (a plain scan never overwrites existing Artists), then
   their albums.
6. `merge_split_albums.py` — an album ripped into several artist folders
   ("Tom Jones with Portishead/Reload", "Tom Jones with Space/Reload"...) is
   19 albums to Jellyfin; fold them into "<Lead>/<Album>". Item ids follow the
   path, so favourites/played flags are snapshotted and restored after the scan.
7. `cleanup_artists.py` — delete MusicArtist items no track references any
   more (case variants are never "dead" to Jellyfin, so it will not do this).
8. `artist_images.py` — Deezer/Lidarr portrait for every artist without one,
   uploaded through the API.
9. `album_covers.py` — `cover.jpg` in every album folder Jellyfin shows blank:
   embedded picture first, Deezer's cover otherwise.

Keys: `~/.jellyfin.key` (jellyseerr's Jellyfin admin key), `~/.lidarr.key`.

Jellyfin-side settings this relies on (Music library options):
`UseCustomTagDelimiters` with `/ | ; \ , &` and the `DelimiterWhitelist` of
real bands containing those characters (written by `whitelist.json`).
