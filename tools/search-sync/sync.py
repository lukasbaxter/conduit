#!/usr/bin/env python3
"""Jellyfin -> Meilisearch. Builds the four indexes Conduit searches (tracks,
albums, artists, playlists), lyrics included, and removes documents whose
Jellyfin items are gone. Idempotent; a full run is ~30 s, so it simply runs
in full every time (cron + relay trigger). Runs on .85 next to jf.py.

    python3 sync.py            # full sync
    python3 sync.py --settings # (re)apply index settings only
"""
import json, os, re, sys, time, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'library-hygiene'))
sys.path.insert(0, os.path.expanduser('~/conduit-hygiene'))
from jf import req, user_id

MEILI = os.environ.get('MEILI_URL', 'http://127.0.0.1:7700')
MKEY = os.environ.get('MEILI_KEY') or open(os.path.expanduser('~/.meili.key')).read().strip()
FS, JFP = '/mnt/wd_nvme1/music/', '/music/'
LRC_TS = re.compile(r'\[[^\]]*\]')

def meili(path, method='GET', body=None):
    r = urllib.request.Request(MEILI + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                               headers={'Authorization': f'Bearer {MKEY}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(r, timeout=300) as resp:
        d = resp.read(); return json.loads(d) if d else None

def wait(task):
    uid = task['taskUid']
    while True:
        t = meili(f'/tasks/{uid}')
        if t['status'] in ('succeeded', 'failed', 'canceled'):
            if t['status'] != 'succeeded': print('  task failed:', json.dumps(t.get('error'))[:300], file=sys.stderr)
            return t
        time.sleep(0.5)

# --- index settings -------------------------------------------------------
SYNONYMS = {
    'feat': ['ft', 'featuring'], 'ft': ['feat', 'featuring'], 'featuring': ['feat', 'ft'],
    '&': ['and'], 'and': ['&'], 'vol': ['volume'], 'volume': ['vol'], 'pt': ['part'], 'part': ['pt'],
    'rmx': ['remix'], 'remix': ['rmx'], 'ost': ['soundtrack'], 'soundtrack': ['ost'], 'ep': ['e.p.'],
}
SETTINGS = {
    'tracks': {
        'searchableAttributes': ['name', 'artists', 'album', 'albumArtist', 'lyrics'],
        'filterableAttributes': ['id', 'artistIds', 'albumId', 'year', 'genres', 'liked', 'playlistIds', 'artists', 'album'],
        'sortableAttributes': ['plays', 'year'],
        'rankingRules': ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'plays:desc'],
        'synonyms': SYNONYMS,
        'typoTolerance': {'minWordSizeForTypos': {'oneTypo': 3, 'twoTypos': 7}},
        'displayedAttributes': ['id', 'name', 'artists', 'artistIds', 'album', 'albumId', 'albumArtist', 'year', 'genres', 'durationTicks', 'plays', 'liked', 'hasLyrics', 'lyrics', 'times'],
        'pagination': {'maxTotalHits': 200},
        'faceting': {'maxValuesPerFacet': 2000},
    },
    'albums': {
        'searchableAttributes': ['name', 'artists'],
        'filterableAttributes': ['artistIds', 'year', 'type'],
        'sortableAttributes': ['plays', 'year'],
        'rankingRules': ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'plays:desc'],
        'synonyms': SYNONYMS,
        'typoTolerance': {'minWordSizeForTypos': {'oneTypo': 3, 'twoTypos': 7}},
    },
    'artists': {
        'searchableAttributes': ['name', 'aliases'],
        'sortableAttributes': ['plays', 'trackCount'],
        'rankingRules': ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'plays:desc'],
        'synonyms': SYNONYMS,
        'typoTolerance': {'minWordSizeForTypos': {'oneTypo': 3, 'twoTypos': 7}},
    },
    'playlists': {
        'searchableAttributes': ['name', 'owner'],
        'rankingRules': ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'trackCount:desc'],
        'sortableAttributes': ['trackCount'],
    },
}

def apply_settings():
    for name, s in SETTINGS.items():
        try: meili('/indexes', 'POST', {'uid': name, 'primaryKey': 'id'})
        except Exception: pass
        wait(meili(f'/indexes/{name}/settings', 'PATCH', s))
    print('settings applied')

if '--settings' in sys.argv:
    apply_settings(); sys.exit(0)

# --- pull from Jellyfin -----------------------------------------------------
t0 = time.time()
users = req('/Users')
uid = user_id()  # any user sees the whole library

def page(kind, fields, extra=''):
    out, start = [], 0
    while True:
        d = req(f'/Items?userId={uid}&IncludeItemTypes={kind}&Recursive=true&Fields={fields}&Limit=2000&StartIndex={start}{extra}', timeout=600)
        out += d['Items']; start += 2000
        if start >= d['TotalRecordCount']: break
    return out

tracks = page('Audio', 'Path,ArtistItems,AlbumArtists,ProductionYear,Genres,UserData')
albums = page('MusicAlbum', 'ArtistItems,AlbumArtists,ProductionYear,ChildCount,Genres')
artists = req(f'/Artists?userId={uid}&Recursive=true&Limit=20000&Fields=ImageTags')['Items']
playlists = [p for p in req(f'/Items?userId={uid}&IncludeItemTypes=Playlist&Recursive=true&Fields=Path,ChildCount&Limit=1000')['Items']
             if (p.get('Path') or '').startswith('/config/data/playlists/')]
print(f'pulled {len(tracks)} tracks {len(albums)} albums {len(artists)} artists {len(playlists)} playlists in {time.time()-t0:.0f}s', file=sys.stderr)

# Popularity across ALL users: per-user play counts summed. One pass per user
# is a few seconds each; only the tracks with any plays come back.
plays, likes = {}, {}
for u in users:
    d = req(f"/Items?userId={u['Id']}&IncludeItemTypes=Audio&Recursive=true&Filters=IsPlayed&Fields=UserData&Limit=20000", timeout=600)
    for it in d['Items']:
        plays[it['Id']] = plays.get(it['Id'], 0) + (it.get('UserData') or {}).get('PlayCount', 0)
    d = req(f"/Items?userId={u['Id']}&IncludeItemTypes=Audio&Recursive=true&Filters=IsFavorite&Limit=20000", timeout=600)
    for it in d['Items']:
        likes.setdefault(it['Id'], []).append(u['Id'])

# Playlist membership, so "search within playlist" is a filter.
pl_of = {}
for p in playlists:
    d = req(f"/Playlists/{p['Id']}/Items?userId={uid}&Limit=5000", timeout=600)
    for it in d.get('Items', []):
        pl_of.setdefault(it['Id'], []).append(p['Id'])

LRC_LINE = re.compile(r'^\s*((?:\[\d+:\d+(?:\.\d+)?\])+)(.*)$')
LRC_T = re.compile(r'\[(\d+):(\d+(?:\.\d+)?)\]')
def lyrics_for(path):
    """(text, times): one lyric line per text line and, in parallel, the
    second each line starts at (None when unsynced), so a lyric hit can be
    played from that exact moment."""
    if not path: return None, None
    base = os.path.splitext(path.replace(JFP, FS, 1))[0] + '.lrc'
    try:
        lines, times = [], []
        with open(base, encoding='utf-8', errors='ignore') as fh:
            for raw in fh:
                m = LRC_LINE.match(raw)
                if m:
                    text = m.group(2).strip()
                    if not text: continue
                    mm, ss = LRC_T.findall(m.group(1))[0]
                    lines.append(text); times.append(round(int(mm) * 60 + float(ss), 2))
                else:
                    text = LRC_TS.sub('', raw).strip()
                    if not text or text.startswith(('[', 'ti:', 'ar:', 'al:', 'by:', 'length:')): continue
                    lines.append(text); times.append(None)
        if not lines: return None, None
        text = '\n'.join(lines)
        if len(text) > 12000:
            keep = 0; n = 0
            for i, l in enumerate(lines):
                n += len(l) + 1
                if n > 12000: break
                keep = i + 1
            lines, times = lines[:keep], times[:keep]; text = '\n'.join(lines)
        return text, times
    except OSError:
        return None, None

def album_type(a):
    n = a.get('ChildCount') or 0
    if re.search(r'various artists', a.get('AlbumArtist') or '', re.I): return 'compilation'
    if n and n <= 3: return 'single'
    if n and n <= 6: return 'ep'
    return 'album'

track_docs = []
album_plays, artist_plays, artist_tracks = {}, {}, {}
for t in tracks:
    p = plays.get(t['Id'], 0)
    lyr, times = lyrics_for(t.get('Path'))
    aids = [a['Id'] for a in (t.get('ArtistItems') or [])]
    track_docs.append({
        'id': t['Id'], 'name': t['Name'], 'artists': t.get('Artists') or [], 'artistIds': aids,
        'album': t.get('Album'), 'albumId': t.get('AlbumId'), 'albumArtist': t.get('AlbumArtist'),
        'year': t.get('ProductionYear'), 'genres': t.get('Genres') or [], 'durationTicks': t.get('RunTimeTicks'),
        'plays': p, 'liked': likes.get(t['Id'], []), 'playlistIds': pl_of.get(t['Id'], []),
        'hasLyrics': bool(lyr), 'lyrics': lyr, 'times': times,
    })
    if t.get('AlbumId'): album_plays[t['AlbumId']] = album_plays.get(t['AlbumId'], 0) + p
    for aid in aids:
        artist_plays[aid] = artist_plays.get(aid, 0) + p
        artist_tracks[aid] = artist_tracks.get(aid, 0) + 1

album_docs = [{
    'id': a['Id'], 'name': a['Name'], 'artists': [x['Name'] for x in (a.get('AlbumArtists') or [])] or ([a['AlbumArtist']] if a.get('AlbumArtist') else []),
    'artistIds': [x['Id'] for x in (a.get('AlbumArtists') or [])], 'year': a.get('ProductionYear'),
    'type': album_type(a), 'trackCount': a.get('ChildCount') or 0, 'plays': album_plays.get(a['Id'], 0),
} for a in albums]

# Spelling variants of one artist collapse to the item that has a portrait, the
# others become aliases so every spelling still finds them.
from collections import defaultdict
def akey(n): return re.sub(r'\s+', ' ', (n or '').replace('﻿', '')).strip().lower()
groups = defaultdict(list)
for a in artists: groups[akey(a['Name'])].append(a)
artist_docs = []
for k, grp in groups.items():
    grp.sort(key=lambda a: (not (a.get('ImageTags') or {}).get('Primary'), -artist_tracks.get(a['Id'], 0)))
    main = grp[0]
    artist_docs.append({
        'id': main['Id'], 'name': main['Name'], 'aliases': [a['Name'] for a in grp[1:] if a['Name'] != main['Name']],
        'trackCount': sum(artist_tracks.get(a['Id'], 0) for a in grp), 'plays': sum(artist_plays.get(a['Id'], 0) for a in grp),
        'hasImage': bool((main.get('ImageTags') or {}).get('Primary')),
    })

pl_docs = [{'id': p['Id'], 'name': p['Name'], 'owner': '', 'trackCount': p.get('ChildCount') or 0} for p in playlists]

# --- push -----------------------------------------------------------------
apply_settings()
for name, docs in (('tracks', track_docs), ('albums', album_docs), ('artists', artist_docs), ('playlists', pl_docs)):
    ids = {d['id'] for d in docs}
    # delete what is gone
    have = set()
    off = 0
    while True:
        d = meili(f'/indexes/{name}/documents?fields=id&limit=10000&offset={off}')
        have |= {x['id'] for x in d['results']}; off += 10000
        if off >= d['total']: break
    gone = sorted(have - ids)
    if gone: wait(meili(f'/indexes/{name}/documents/delete-batch', 'POST', gone))
    for i in range(0, len(docs), 5000):
        wait(meili(f'/indexes/{name}/documents?primaryKey=id', 'PUT', docs[i:i + 5000]))
    print(f'  {name}: {len(docs)} docs, {len(gone)} removed', file=sys.stderr)
print(json.dumps({'tracks': len(track_docs), 'albums': len(album_docs), 'artists': len(artist_docs), 'playlists': len(pl_docs),
                  'with_lyrics': sum(1 for d in track_docs if d['hasLyrics']), 'secs': round(time.time() - t0)}))
