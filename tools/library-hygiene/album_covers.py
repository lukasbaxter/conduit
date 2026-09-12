#!/usr/bin/env python3
"""Cover art for albums Jellyfin shows blank. Jellyfin only takes an album's
primary image from a file in the album folder (cover.jpg / folder.jpg), never
from the art embedded in the tracks, so 400-odd albums here had art in every
file and none on screen. Writes cover.jpg next to the tracks: embedded picture
first, Deezer's album cover (1000px) when the files carry none, then asks
Jellyfin to re-scan the album's images. Runs on .85.

    python3 album_covers.py albums_noimg.json [--apply]
"""
import json, os, sys, time, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mutagen import File
from mutagen.flac import FLAC
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4
from jf import req
from namekey import key

albums = json.load(open(sys.argv[1])); apply = '--apply' in sys.argv
FS, JF = '/mnt/wd_nvme1/music/', '/music/'
EXT = {'.flac', '.mp3', '.m4a', '.ogg', '.opus'}

def embedded(folder):
    for f in sorted(os.listdir(folder)):
        if os.path.splitext(f)[1].lower() not in EXT: continue
        try:
            m = File(os.path.join(folder, f))
        except Exception:
            continue
        if isinstance(m, FLAC) and m.pictures:
            p = max(m.pictures, key=lambda p: len(p.data)); return p.data, p.mime
        if isinstance(m, MP3) and m.tags:
            apics = [v for k, v in m.tags.items() if k.startswith('APIC')]
            if apics:
                p = max(apics, key=lambda p: len(p.data)); return p.data, p.mime
        if isinstance(m, MP4) and m.tags and m.tags.get('covr'):
            c = m.tags['covr'][0]
            return bytes(c), ('image/png' if c.imageformat == 14 else 'image/jpeg')
    return None, None

def get(url):
    r = urllib.request.Request(url, headers={'User-Agent': 'conduit-hygiene/1'})
    with urllib.request.urlopen(r, timeout=30) as resp: return resp.read()

def deezer_cover(artist, album):
    time.sleep(0.15)
    q = f'artist:"{artist}" album:"{album}"' if artist and artist != 'Various Artists' else album
    d = json.loads(get(f'https://api.deezer.com/search/album?q={urllib.parse.quote(q)}&limit=10'))
    for a in d.get('data', []):
        if key(a.get('title', '')) == key(album) and (not artist or artist == 'Various Artists' or key(a['artist']['name']) == key(artist)):
            return a.get('cover_xl') or a.get('cover_big')
    # a looser second pass: same title, any artist, when the folder is a single
    if d.get('data') and key(d['data'][0].get('title', '')) == key(album):
        return d['data'][0].get('cover_xl')
    return None

from collections import Counter
stats = Counter(); log = {}
for i, a in enumerate(albums):
    folder = a['Path'].replace(JF, FS, 1)
    if not os.path.isdir(folder) or not (a.get('ChildCount') or 0):
        stats['skip'] += 1; continue
    if any(f.lower() in ('cover.jpg', 'cover.png', 'folder.jpg', 'folder.png') for f in os.listdir(folder)):
        how = 'folder-image-present'
    else:
        data, mime = embedded(folder); how = 'embedded'
        if not data:
            try:
                url = deezer_cover(a.get('AlbumArtist') or '', a['Name'])
            except Exception as e:
                url = None; stats['deezer-err'] += 1
            if url:
                data = get(url); mime = 'image/jpeg'; how = 'deezer'
        if not data:
            stats['none'] += 1; log[a['Id']] = 'none'; continue
        name = 'cover.png' if 'png' in (mime or '') else 'cover.jpg'
        if apply:
            with open(os.path.join(folder, name), 'wb') as fh: fh.write(data)
            os.chmod(os.path.join(folder, name), 0o664)
    if apply:
        req(f"/Items/{a['Id']}/Refresh?ImageRefreshMode=FullRefresh&MetadataRefreshMode=Default&ReplaceAllImages=false", 'POST')
    stats[how] += 1; log[a['Id']] = how
    if i % 100 == 0: print(i, len(albums), dict(stats), file=sys.stderr)
json.dump(log, open('album_covers_done.json', 'w'))
print(json.dumps(stats))
