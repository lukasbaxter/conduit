#!/usr/bin/env python3
"""Delete MusicArtist items that no track credits any more. Jellyfin's own
ArtistsValidator only removes an artist when no ItemValue matches its
*case-folded* name, so "Tones And I" lives on for ever next to "Tones and I".
An artist item is dead here when no Audio item lists that exact spelling in
Artists or AlbumArtists. User data on the artist (favourite) is lost; that is
all. Runs on .85.

    python3 cleanup_artists.py [--apply]
"""
import json, sys
from jf import req, user_id

apply = '--apply' in sys.argv
u = user_id()
arts = req(f'/Artists?userId={u}&Recursive=true&Limit=20000')['Items']
credited = set()
start = 0
while True:
    d = req(f'/Items?userId={u}&IncludeItemTypes=Audio&Recursive=true&Fields=Artists,AlbumArtists&Limit=5000&StartIndex={start}', timeout=600)
    for it in d['Items']:
        credited.update(it.get('Artists') or [])
        credited.update(a['Name'] for a in (it.get('AlbumArtists') or []))
    start += 5000
    if start >= d['TotalRecordCount']: break
dead = [a for a in arts if a['Name'] not in credited]
# DELETE /Items/{id} deletes the item's files too. For an artist that lives in
# Jellyfin's metadata folder that is just its cached images; for one backed by
# a real /music/<Artist> folder it would be the music (the mount is read-only,
# but never lean on that). Folder-backed ghosts drop out of /Artists on their
# own once nothing credits them, so they are only reported here.
for a in dead:
    a['Path'] = req(f"/Items/{a['Id']}?userId={u}").get('Path') or ''
folder_backed = [a for a in dead if not a['Path'].startswith('/config/metadata/')]
dead = [a for a in dead if a['Path'].startswith('/config/metadata/')]
print('artists', len(arts), 'credited spellings', len(credited), 'dead (metadata-only, deletable)', len(dead), 'dead but folder-backed (left alone)', len(folder_backed), file=sys.stderr)
for a in dead: print('  ', a['Name'], file=sys.stderr)
for a in folder_backed: print('   keep:', a['Name'], a['Path'], file=sys.stderr)
if apply:
    n = 0
    for a in dead:
        try:
            req(f"/Items/{a['Id']}", 'DELETE'); n += 1
        except Exception as e:
            print('  failed', a['Name'], e, file=sys.stderr)
    print('deleted', n)
json.dump([a['Name'] for a in dead], open('dead_artists.json', 'w'), ensure_ascii=False)
