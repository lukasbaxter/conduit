#!/usr/bin/env python3
"""Give every artist without a portrait one. Jellyfin's own artist image
fetchers (TheAudioDB, fanart.tv) need a MusicBrainz id, and the MusicBrainz
artist provider is disabled here (it 503-stalled every scan), so nothing ever
arrives on its own. Deezer's artist pictures are square 1000px and cover
nearly everything on streaming; Lidarr's fanart poster is the fallback.
Uploads go through the Jellyfin API (works for folder-backed and metadata-only
artists alike; Jellyfin keeps the file in its own metadata store). Runs on .85.

    python3 artist_images.py oracle.json [--apply] [--redo]
"""
import base64, json, os, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from jf import req, user_id
from namekey import key

oracle = json.load(open(sys.argv[1])); apply = '--apply' in sys.argv; redo = '--redo' in sys.argv
DONE = 'artist_images_done.json'
done = json.load(open(DONE)) if os.path.exists(DONE) and not redo else {}
u = user_id()
arts = req(f'/Artists?userId={u}&Recursive=true&Fields=ImageTags&Limit=20000')['Items']
todo = [a for a in arts if not (a.get('ImageTags') or {}).get('Primary') and a['Name'] not in done]
print('artists', len(arts), 'without portrait', sum(1 for a in arts if not (a.get('ImageTags') or {}).get('Primary')), 'to try', len(todo), file=sys.stderr)

def get(url, timeout=30):
    r = urllib.request.Request(url, headers={'User-Agent': 'conduit-hygiene/1'})
    with urllib.request.urlopen(r, timeout=timeout) as resp: return resp.read()

def deezer_live(name):
    d = json.loads(get(f'https://api.deezer.com/search/artist?q={urllib.parse.quote(name)}&limit=10'))
    for a in d.get('data', []):
        if key(a.get('name', '')) == key(name):
            pic = a.get('picture_xl') or a.get('picture_big')
            return None if not pic or '/artist//' in pic else pic
    return None

def source(name):
    o = oracle.get(name) or {}
    if (o.get('deezer') or {}).get('img'): return o['deezer']['img'], 'deezer'
    if (o.get('lidarr') or {}).get('img'): return o['lidarr']['img'], 'lidarr'
    if name not in oracle:
        time.sleep(0.15)  # Deezer: 50 req / 5 s
        try:
            pic = deezer_live(name)
            if pic: return pic, 'deezer-live'
        except Exception as e:
            return None, 'deezer-err:' + str(e)[:40]
    return None, 'nomatch'

def one(a):
    url, how = source(a['Name'])
    if not url: return a['Name'], how
    try:
        data = get(url)
        if len(data) < 2000: return a['Name'], 'tiny'
        ctype = 'image/png' if data[:4] == b'\x89PNG' else 'image/jpeg'
        if apply:
            req(f"/Items/{a['Id']}/Images/Primary", 'POST', raw=base64.b64encode(data), ctype=ctype)
        return a['Name'], 'ok:' + how
    except Exception as e:
        return a['Name'], 'err:' + str(e)[:60]

n = 0
with ThreadPoolExecutor(4) as ex:
    for name, status in ex.map(one, todo):
        done[name] = status; n += 1
        if n % 200 == 0:
            json.dump(done, open(DONE, 'w'), ensure_ascii=False); print(n, len(todo), file=sys.stderr)
json.dump(done, open(DONE, 'w'), ensure_ascii=False)
from collections import Counter
print(json.dumps(Counter(v.split(':')[0] + (':' + v.split(':')[1] if v.startswith('ok') else '') for v in done.values())))
