#!/usr/bin/env python3
"""Seed a ListenBrainz account with the listening history Jellyfin already
knows about, so Explo's recommendations have something to chew on from day
one instead of after weeks of scrobbling:

  - every Conduit play recorded by Jellyfin's Playback Reporting plugin (real
    timestamps)
  - Jellyfin play counts (one listen per count, spread over the past year)
  - favourites (one listen each, also spread) -- liked songs are the strongest
    taste signal we have

ListenBrainz de-duplicates identical (timestamp, track) pairs, so re-running
is harmless. Runs on .85.

    python3 backfill.py --jf-user lukasbaxter --lb-user <name> --token <token> [--dry]
"""
import argparse, json, os, random, sqlite3, sys, time, urllib.request
sys.path.insert(0, os.path.expanduser('~/conduit-hygiene'))
from jf import req, user_id

ap = argparse.ArgumentParser()
ap.add_argument('--jf-user', required=True); ap.add_argument('--lb-user', required=True); ap.add_argument('--token', required=True)
ap.add_argument('--dry', action='store_true')
a = ap.parse_args()
uid = user_id(a.jf_user)
random.seed(42)
now = int(time.time())
listens = []

def meta(t, extra=None):
    m = {'artist_name': (t.get('Artists') or [t.get('AlbumArtist') or 'Unknown'])[0], 'track_name': t['Name']}
    if t.get('Album'): m['release_name'] = t['Album']
    info = {'media_player': 'Conduit', 'submission_client': 'conduit-backfill'}
    if t.get('RunTimeTicks'): info['duration_ms'] = int(t['RunTimeTicks'] / 10000)
    if extra: info.update(extra)
    m['additional_info'] = info
    return m

# 1. real plays from Playback Reporting (ItemId -> track)
pr = sqlite3.connect('file:/home/admin/services/jellyfin/config/data/playback_reporting.db?mode=ro', uri=True)
rows = pr.execute("select DateCreated, ItemId, PlayDuration from PlaybackActivity where ItemType='Audio' and UserId=?", (uid,)).fetchall()
ids = sorted({r[1] for r in rows})
byid = {}
for i in range(0, len(ids), 150):
    d = req(f"/Items?userId={uid}&Ids={','.join(ids[i:i+150])}&Fields=ArtistItems")
    for it in d['Items']: byid[it['Id']] = it
for dt, iid, dur in rows:
    t = byid.get(iid)
    if not t or (dur or 0) < 30: continue
    ts = int(time.mktime(time.strptime(dt[:19], '%Y-%m-%d %H:%M:%S')))
    listens.append({'listened_at': ts, 'track_metadata': meta(t)})
n_real = len(listens)

# 2. play counts (minus the real ones we already have per track)
played = []
start = 0
while True:
    d = req(f"/Items?userId={uid}&IncludeItemTypes=Audio&Recursive=true&Filters=IsPlayed&Fields=UserData,ArtistItems&Limit=2000&StartIndex={start}", timeout=600)
    played += d['Items']; start += 2000
    if start >= d['TotalRecordCount']: break
real_per = {}
for dt, iid, dur in rows: real_per[iid] = real_per.get(iid, 0) + 1
for t in played:
    n = min(20, max(0, (t.get('UserData') or {}).get('PlayCount', 0) - real_per.get(t['Id'], 0)))
    for _ in range(n):
        listens.append({'listened_at': now - random.randint(3600, 365 * 86400), 'track_metadata': meta(t)})
n_counts = len(listens) - n_real

# 3. favourites
favs = []
start = 0
while True:
    d = req(f"/Items?userId={uid}&IncludeItemTypes=Audio&Recursive=true&Filters=IsFavorite&Fields=ArtistItems&Limit=2000&StartIndex={start}", timeout=600)
    favs += d['Items']; start += 2000
    if start >= d['TotalRecordCount']: break
for t in favs:
    listens.append({'listened_at': now - random.randint(3600, 365 * 86400), 'track_metadata': meta(t)})
print(f'listens: {n_real} real plays + {n_counts} from play counts + {len(favs)} favourites = {len(listens)}', file=sys.stderr)
if a.dry: sys.exit(0)

# submit in batches of 1000 (LB max), 1 req/s
for i in range(0, len(listens), 1000):
    body = json.dumps({'listen_type': 'import', 'payload': listens[i:i+1000]}).encode()
    r = urllib.request.Request('https://api.listenbrainz.org/1/submit-listens', data=body, method='POST',
                               headers={'Authorization': f'Token {a.token}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=60) as resp: print(f'  batch {i//1000+1}: {resp.status}', file=sys.stderr)
    except urllib.error.HTTPError as e:
        print(f'  batch {i//1000+1}: HTTP {e.code} {e.read()[:200]}', file=sys.stderr); sys.exit(1)
    time.sleep(1.2)
print('done')
