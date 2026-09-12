#!/usr/bin/env python3
"""Make Jellyfin re-read the tags of the files apply_tags.py touched.

A plain library scan is not enough: Jellyfin's audio prober only overwrites
Artists/AlbumArtists when ReplaceAllMetadata is set (or the field is empty),
so changed credits survive a normal scan. This refreshes exactly the changed
tracks with ReplaceAllMetadata, then their albums so the album's artist list
is rebuilt from the songs. Runs on .85 next to jf.py.

    python3 refresh_changed.py applied-YYYYMMDD-HHMM.json
"""
import json, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from jf import req, user_id

MUSIC_FS, MUSIC_JF = '/mnt/wd_nvme1/music/', '/music/'
paths = {p.replace(MUSIC_FS, MUSIC_JF, 1) for p, _ in json.load(open(sys.argv[1]))}
u = user_id()

# path -> (id, albumId) for the whole library, paged
by_path = {}
start = 0
while True:
    d = req(f'/Items?userId={u}&IncludeItemTypes=Audio&Recursive=true&Fields=Path&Limit=2000&StartIndex={start}', timeout=600)
    for it in d['Items']:
        by_path[it.get('Path')] = (it['Id'], it.get('AlbumId'))
    start += 2000
    if start >= d['TotalRecordCount']: break
print('library tracks', len(by_path), file=sys.stderr)

targets = [by_path[p] for p in paths if p in by_path]
missing = [p for p in paths if p not in by_path]
print('to refresh', len(targets), 'not in jellyfin', len(missing), file=sys.stderr)
for m in missing[:5]: print('  ', m, file=sys.stderr)

def refresh(item_id, replace):
    q = urllib.parse.urlencode({'MetadataRefreshMode': 'FullRefresh', 'ImageRefreshMode': 'Default',
                                'ReplaceAllMetadata': 'true' if replace else 'false', 'ReplaceAllImages': 'false'})
    for attempt in range(3):
        try:
            req(f'/Items/{item_id}/Refresh?{q}', 'POST'); return True
        except Exception as e:
            err = e; time.sleep(2)
    print('  failed', item_id, err, file=sys.stderr); return False

t0 = time.time()
with ThreadPoolExecutor(4) as ex:
    ok = sum(ex.map(lambda t: refresh(t[0], True), targets))
print('tracks queued', ok, 'in', round(time.time() - t0), 's', file=sys.stderr)

# Wait for the queue to drain before touching albums: a MusicAlbum refresh
# re-refreshes its children WITHOUT ReplaceAllMetadata, and when both were
# queued together every track came out with its old credits.
def refreshed_since(item_id, since):
    d = req(f'/Items/{item_id}?userId={u}')
    return (d.get('DateLastRefreshed') or '') > since
since = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(t0 - 5))
probe = [t[0] for t in targets[::max(1, len(targets) // 20)]]
while True:
    time.sleep(30)
    left = [i for i in probe if not refreshed_since(i, since)]
    print('  waiting on', len(left), 'of', len(probe), 'probe tracks', file=sys.stderr)
    if not left: break
time.sleep(60)
albums = sorted({a for _, a in targets if a})
with ThreadPoolExecutor(4) as ex:
    ok = sum(ex.map(lambda a: refresh(a, False), albums))
print('albums refreshed', ok, 'of', len(albums), file=sys.stderr)
