#!/usr/bin/env python3
"""Walk the music root and dump every file's artist / albumartist / album /
title tags to JSON. Runs on .85 (mutagen there). ~27k files, a minute or two.

    python3 scan_tags.py /mnt/wd_nvme1/music tags.json
"""
import json, os, sys
from concurrent.futures import ThreadPoolExecutor
from mutagen import File

ROOT, OUT = sys.argv[1], sys.argv[2]
EXT = {'.flac', '.mp3', '.m4a', '.ogg', '.opus', '.wav', '.aac', '.wma', '.aiff', '.alac'}

def read(path):
    try:
        f = File(path, easy=True)
        if f is None:
            return path, None
        g = lambda k: [str(v) for v in (f.get(k) or [])]
        return path, {'artist': g('artist'), 'albumartist': g('albumartist'),
                      'album': g('album')[:1], 'title': g('title')[:1]}
    except Exception as e:
        return path, {'error': str(e)[:120]}

paths = []
for dp, dn, fn in os.walk(ROOT):
    for n in fn:
        if os.path.splitext(n)[1].lower() in EXT:
            paths.append(os.path.join(dp, n))
print('files', len(paths), file=sys.stderr)
out = {}
with ThreadPoolExecutor(8) as ex:
    for i, (p, t) in enumerate(ex.map(read, paths, chunksize=64)):
        out[p] = t
        if i % 5000 == 0:
            print(i, file=sys.stderr)
json.dump(out, open(OUT, 'w'), ensure_ascii=False)
print('done', len(out), 'unreadable', sum(1 for v in out.values() if v is None or 'error' in v), file=sys.stderr)
