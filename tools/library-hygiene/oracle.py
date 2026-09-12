#!/usr/bin/env python3
"""Ask Lidarr (MusicBrainz-backed, via its own metadata proxy, no rate limit)
and Deezer (public search API, 50 req / 5 s) whether a string is a real artist
name, and what the canonical spelling + portrait URL is. Results are cached in
oracle.json so reruns only look up new terms. Runs on .85.

    python3 oracle.py terms.json oracle.json
"""
import json, os, sys, time, threading, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from namekey import key

LIDARR = os.environ.get('LIDARR_URL', 'http://192.168.1.85:8686')
LKEY = os.environ.get('LIDARR_KEY') or open(os.path.expanduser('~/.lidarr.key')).read().strip()

terms = json.load(open(sys.argv[1]))
OUT = sys.argv[2]
cache = json.load(open(OUT)) if os.path.exists(OUT) else {}
lock = threading.Lock()

def get(url, headers={}):
    for attempt in range(4):
        try:
            r = urllib.request.Request(url, headers={'User-Agent': 'conduit-hygiene/1', **headers})
            with urllib.request.urlopen(r, timeout=30) as resp:
                return json.load(resp)
        except Exception as e:
            err = e
            time.sleep(1.5 * (attempt + 1))
    raise err

def lidarr(term):
    d = get(f'{LIDARR}/api/v1/artist/lookup?term={urllib.parse.quote(term)}', {'X-Api-Key': LKEY})
    k = key(term)
    for a in d[:10]:
        if key(a.get('artistName', '')) == k:
            img = None
            for kind in ('poster', 'fanart', 'banner'):
                for im in a.get('images', []):
                    if im.get('coverType') == kind and (im.get('remoteUrl') or im.get('url')):
                        img = im.get('remoteUrl') or im.get('url'); break
                if img: break
            return {'name': a['artistName'], 'mbid': a.get('foreignArtistId'), 'img': img, 'type': a.get('artistType')}
    return None

# Deezer: 50 requests per 5 seconds per IP. A token bucket keeps us under it.
_dz = {'t': time.monotonic(), 'n': 0}
_dzlock = threading.Lock()
def _dz_wait():
    with _dzlock:
        now = time.monotonic()
        if now - _dz['t'] >= 5.5:
            _dz['t'], _dz['n'] = now, 0
        if _dz['n'] >= 40:
            time.sleep(5.5 - (now - _dz['t']) + 0.05)
            _dz['t'], _dz['n'] = time.monotonic(), 0
        _dz['n'] += 1

def deezer(term):
    _dz_wait()
    d = get(f'https://api.deezer.com/search/artist?q={urllib.parse.quote(term)}&limit=10')
    if 'error' in d:  # quota exceeded etc.
        time.sleep(6)
        _dz_wait()
        d = get(f'https://api.deezer.com/search/artist?q={urllib.parse.quote(term)}&limit=10')
        if 'error' in d:
            raise RuntimeError(d['error'])
    k = key(term)
    for a in d.get('data', []):
        if key(a.get('name', '')) == k:
            pic = a.get('picture_xl') or a.get('picture_big')
            # Deezer's placeholder for artists with no photo is a fixed hash.
            if pic and '/artist//' in pic:
                pic = None
            return {'name': a['name'], 'id': a['id'], 'img': pic, 'fans': a.get('nb_fan', 0)}
    return None

def look(term):
    res = {}
    try:
        res['lidarr'] = lidarr(term)
    except Exception as e:
        res['lidarr_err'] = str(e)[:80]
    try:
        res['deezer'] = deezer(term)
    except Exception as e:
        res['deezer_err'] = str(e)[:80]
    return term, res

todo = [t for t in terms if t not in cache or cache[t].get('lidarr_err') or cache[t].get('deezer_err')]
print('terms', len(terms), 'todo', len(todo), file=sys.stderr)
done = 0
with ThreadPoolExecutor(6) as ex:
    for term, res in ex.map(look, todo):
        with lock:
            cache[term] = res
            done += 1
            if done % 100 == 0:
                json.dump(cache, open(OUT, 'w'), ensure_ascii=False)
                print(done, len(todo), file=sys.stderr)
json.dump(cache, open(OUT, 'w'), ensure_ascii=False)
n = len(cache)
print(json.dumps({'terms': n,
                  'lidarr_exact': sum(1 for v in cache.values() if v.get('lidarr')),
                  'deezer_exact': sum(1 for v in cache.values() if v.get('deezer')),
                  'either': sum(1 for v in cache.values() if v.get('lidarr') or v.get('deezer')),
                  'errors': sum(1 for v in cache.values() if v.get('lidarr_err') or v.get('deezer_err'))}))
