#!/usr/bin/env python3
"""Merge one album that was ripped into several artist folders.

Soulseek/Lidarr imports filed each collaboration track of an album under its
own credit: "Tom Jones with Portishead/Reload", "Tom Jones with The
Cardigans/Reload"... Jellyfin groups albums by FOLDER, so that is 19 one-track
"Reload" albums. Files whose album folder has the same name, the same lead
artist and different artist folders move into "<Lead Artist>/<Album>/".

Jellyfin item ids derive from the path, so moved tracks get new ids: the
user's favourites and played flags on them are captured first and re-applied
after the rescan (--restore). Runs on .85.

    python3 merge_split_albums.py tags.json            # plan only
    python3 merge_split_albums.py tags.json --apply    # move files, snapshot user data
    python3 merge_split_albums.py --restore snapshot.json   # after the library scan
"""
import json, os, re, shutil, sys, time, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from namekey import key, clean
from jf import req, user_id

FS, JFP = '/mnt/wd_nvme1/music/', '/music/'
apply = '--apply' in sys.argv

def snapshot_userdata(dirs):
    """Favourite/played flags for every user, for tracks under these dirs."""
    out = []
    for u in req('/Users'):
        uid = u['Id']
        for d in dirs:
            jd = d.replace(FS, JFP, 1)
            r = req(f'/Items?userId={uid}&IncludeItemTypes=Audio&Recursive=true&Fields=Path,UserData&Limit=500&searchTerm=' + urllib.parse.quote(os.path.basename(d)))
            for it in r.get('Items', []):
                if os.path.dirname(it.get('Path', '')) == jd:
                    ud = it.get('UserData') or {}
                    if ud.get('IsFavorite') or ud.get('Played'):
                        out.append({'user': uid, 'file': os.path.basename(it['Path']), 'album': os.path.basename(d), 'fav': bool(ud.get('IsFavorite')), 'played': bool(ud.get('Played')), 'name': it['Name']})
    return out

if '--restore' in sys.argv:
    snap = json.load(open(sys.argv[sys.argv.index('--restore') + 1]))
    n = 0
    for s in snap:
        r = req(f"/Items?userId={s['user']}&IncludeItemTypes=Audio&Recursive=true&Fields=Path,UserData&Limit=50&searchTerm=" + urllib.parse.quote(s['name']))
        hit = next((it for it in r.get('Items', []) if os.path.basename(it.get('Path', '')) == s['file'] and os.path.basename(os.path.dirname(it['Path'])) == s['album']), None)
        if not hit: print('  not found after scan:', s['album'], s['file'], file=sys.stderr); continue
        if s['fav'] and not (hit.get('UserData') or {}).get('IsFavorite'):
            req(f"/Users/{s['user']}/FavoriteItems/{hit['Id']}", 'POST'); n += 1
        if s['played'] and not (hit.get('UserData') or {}).get('Played'):
            req(f"/Users/{s['user']}/PlayedItems/{hit['Id']}", 'POST'); n += 1
    print('restored flags:', n); sys.exit(0)

tags = json.load(open(sys.argv[1]))
SPLIT = re.compile(r';|\sfeat\.?\s|\sft\.?\s|\swith\s|,|\s&\s|\sx\s|/', re.I)
def lead_of(t):
    v = (t['albumartist'] or t['artist'] or [''])[0]
    return clean(SPLIT.split(v)[0])

# (lead key, album folder name) -> {dir: lead spelling}
groups = {}
for p, t in tags.items():
    if not t or 'error' in t: continue
    d = os.path.dirname(p)
    if os.path.dirname(d) == FS.rstrip('/'):  # no artist folder level
        continue
    lead = lead_of(t)
    if not lead: continue
    groups.setdefault((key(lead), os.path.basename(d)), {}).setdefault(d, lead)

plans = []
for (lk, album), dirs in groups.items():
    if len(dirs) < 2 or album.lower() in ('unknown album', ''): continue
    artist_dirs = {os.path.dirname(d) for d in dirs}
    if len(artist_dirs) < 2: continue
    # target artist folder: the one named exactly like the lead, else create it
    leads = list(dirs.values())
    spelling = max(set(leads), key=leads.count)
    existing = next((a for a in artist_dirs if key(os.path.basename(a)) == lk), None)
    target_artist = existing or os.path.join(FS.rstrip('/'), spelling.replace('/', '-'))
    target = os.path.join(target_artist, album)
    sources = sorted(d for d in dirs if d != target)
    plans.append({'album': album, 'lead': spelling, 'target': target, 'sources': sources})

print(f'{len(plans)} split albums, {sum(len(p["sources"]) for p in plans)} folders to fold in', file=sys.stderr)
for p in plans:
    print(f"  {p['lead']} / {p['album']}: {len(p['sources'])} -> {p['target'].replace(FS, '')}", file=sys.stderr)
if not apply: sys.exit(0)

snap = snapshot_userdata([d for p in plans for d in p['sources']] + [p['target'] for p in plans if os.path.isdir(p['target'])])
stamp = time.strftime('%Y%m%d-%H%M')
json.dump(snap, open(f'merge-snapshot-{stamp}.json', 'w'), ensure_ascii=False, indent=0)
print('user-data snapshot rows:', len(snap), '->', f'merge-snapshot-{stamp}.json', file=sys.stderr)

moves = []
for p in plans:
    os.makedirs(p['target'], exist_ok=True)
    for src in p['sources']:
        for f in sorted(os.listdir(src)):
            s, d = os.path.join(src, f), os.path.join(p['target'], f)
            if os.path.exists(d):
                if f.lower() in ('cover.jpg', 'folder.jpg', 'cover.png'): os.remove(s); continue
                print('  collision, left in place:', s, file=sys.stderr); continue
            shutil.move(s, d); moves.append([s, d])
        # drop the emptied album folder and, if nothing else is in it, the artist folder
        try: os.rmdir(src)
        except OSError: pass
        try: os.rmdir(os.path.dirname(src))
        except OSError: pass
json.dump(moves, open(f'merge-moves-{stamp}.json', 'w'), ensure_ascii=False, indent=0)
print('moved files:', len(moves), file=sys.stderr)
print(json.dumps({'albums': len(plans), 'moved': len(moves), 'snapshot': f'merge-snapshot-{stamp}.json'}))
