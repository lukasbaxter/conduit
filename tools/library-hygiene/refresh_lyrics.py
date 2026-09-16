#!/usr/bin/env python3
"""Make Jellyfin re-read the .lrc sidecars lyrics_check.py replaced (its
lyrics endpoint serves what the item last scanned). A metadata refresh of
exactly those tracks, no ReplaceAllMetadata (tags are fine).

    python3 refresh_lyrics.py lyrics_changed-YYYYMMDD-HHMM.json
"""
import json, sys, time
from concurrent.futures import ThreadPoolExecutor
from jf import req, user_id

MUSIC_FS, MUSIC_JF = '/mnt/wd_nvme1/music/', '/music/'
paths = {c["file"].replace(MUSIC_FS, MUSIC_JF, 1) for c in json.load(open(sys.argv[1]))}
u = user_id()
by_path, start = {}, 0
while True:
    d = req(f'/Items?userId={u}&IncludeItemTypes=Audio&Recursive=true&Fields=Path&Limit=2000&StartIndex={start}', timeout=600)
    for it in d['Items']: by_path[it.get('Path')] = it['Id']
    start += 2000
    if start >= d['TotalRecordCount']: break
ids = [by_path[p] for p in paths if p in by_path]
print(f'{len(ids)} of {len(paths)} changed tracks found in Jellyfin', file=sys.stderr)
def refresh(i):
    try: req(f'/Items/{i}/Refresh?MetadataRefreshMode=FullRefresh&ImageRefreshMode=None&ReplaceAllMetadata=false&ReplaceAllImages=false', method='POST', timeout=60)
    except Exception as e: print('refresh failed', i, e, file=sys.stderr)
with ThreadPoolExecutor(4) as ex: list(ex.map(refresh, ids))
print('done')
