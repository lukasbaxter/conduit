#!/usr/bin/env python3
"""Cover art for albums Jellyfin shows blank. Jellyfin only takes an album's
primary image from a file in the album folder (cover.jpg / folder.jpg), never
from the art embedded in the tracks, so 400-odd albums here had art in every
file and none on screen. Writes cover.jpg next to the tracks: embedded picture
first, Deezer's album cover (1000px) when the files carry none, then asks
Jellyfin to re-scan the album's images. Runs on .85.

    python3 album_covers.py albums_noimg.json [--apply]
"""
import json, os, re, sys, time, urllib.parse, urllib.request
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

LIDARR = os.environ.get('LIDARR_URL', 'http://192.168.1.85:8686')
LKEY = os.environ.get('LIDARR_KEY') or open(os.path.expanduser('~/.lidarr.key')).read().strip()

def itunes_cover(artist, album):
    """Apple's search API: no key, generous coverage of singles and remixes.
    artworkUrl100 is a template; the size in the filename is arbitrary."""
    time.sleep(0.4)
    term = f'{artist} {album}' if artist and artist != 'Various Artists' else album
    d = json.loads(get(f'https://itunes.apple.com/search?term={urllib.parse.quote(term)}&entity=album&limit=10'))
    for r in d.get('results', []):
        if key(r.get('collectionName', '')) == key(album) or key(re.sub(r'\s*[-(].*$', '', r.get('collectionName', ''))) == key(album):
            return r.get('artworkUrl100', '').replace('100x100bb', '1200x1200bb') or None
    return None

def lidarr_cover(artist, album):
    r = urllib.request.Request(f'{LIDARR}/api/v1/album/lookup?term={urllib.parse.quote(album)}', headers={'X-Api-Key': LKEY})
    with urllib.request.urlopen(r, timeout=30) as resp: d = json.load(resp)
    for a in d[:10]:
        if key(a.get('title', '')) == key(album) and (not artist or artist == 'Various Artists' or key((a.get('artist') or {}).get('artistName', '')) == key(artist)):
            for im in a.get('images', []):
                if im.get('coverType') == 'cover' and (im.get('remoteUrl') or im.get('url')): return im.get('remoteUrl') or im.get('url')
    return None

def deezer_track_cover(artist, folder):
    """Singles are usually named after their track; ask Deezer for the track."""
    t = None
    for f in sorted(os.listdir(folder)):
        if os.path.splitext(f)[1].lower() in EXT:
            try: t = (File(os.path.join(folder, f), easy=True) or {}).get('title', [None])[0]
            except Exception: t = None
            break
    if not t: return None
    time.sleep(0.15)
    q = f'artist:"{artist}" track:"{t}"' if artist and artist != 'Various Artists' else t
    d = json.loads(get(f'https://api.deezer.com/search/track?q={urllib.parse.quote(q)}&limit=5'))
    for r in d.get('data', []):
        if key(r.get('title', '')) == key(t):
            return (r.get('album') or {}).get('cover_xl')
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
            url = None
            for how2, fn in (('deezer', deezer_cover), ('itunes', itunes_cover), ('lidarr', lidarr_cover)):
                try: url = fn(a.get('AlbumArtist') or '', a['Name'])
                except Exception: url = None
                if url: how = how2; break
            if not url:
                try: url = deezer_track_cover(a.get('AlbumArtist') or '', folder); how = 'deezer-track'
                except Exception: url = None
            if url:
                data = get(url); mime = 'image/jpeg'
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
