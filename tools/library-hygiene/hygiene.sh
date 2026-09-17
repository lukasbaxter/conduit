#!/bin/bash
# Nightly library hygiene on .85. Idempotent: every step skips what is done.
# Install: crontab -e ->  30 4 * * * /home/lukas/conduit-hygiene/hygiene.sh >> /home/lukas/conduit-hygiene/hygiene.log 2>&1
set -u
cd "$(dirname "$0")"
# One run at a time: the nightly cron and the on-arrival trigger from Music Requests share this.
exec 9>/tmp/conduit-hygiene.lock; flock -n 9 || { echo "hygiene already running"; exit 0; }
echo "=== $(date -Is) hygiene start"
# Rip leftovers: Jellyfin imports every .m3u as a "playlist" the user sees.
find /mnt/wd_nvme1/music -type f \( -iname "*.m3u" -o -iname "*.m3u8" -o -iname "*.sfv" -o -iname "*.url" -o -iname "*.torrent" \) -delete
find /mnt/wd_nvme1/music -maxdepth 1 -type f -size 0 -delete
python3 scan_tags.py /mnt/wd_nvme1/music tags.json || exit 1
python3 - <<'PY' || exit 1
# oracle terms: every distinct artist string and every span between separators
import json, re
from namekey import clean, ANY
tags = json.load(open('tags.json')); oracle = json.load(open('oracle.json')) if __import__('os').path.exists('oracle.json') else {}
SEP = re.compile(ANY.pattern, re.I); terms = set()
for t in tags.values():
    if not t or 'error' in t: continue
    for k in ('artist', 'albumartist'):
        for v in t[k]:
            for n in v.split(';'):
                c = clean(n)
                if not c: continue
                terms.add(c)
                if not ANY.search(c): continue
                toks, seps, pos = [], [], 0
                for m in SEP.finditer(c):
                    toks.append(clean(c[pos:m.start()])); seps.append(m.group(0)); pos = m.end()
                toks.append(clean(c[pos:]))
                for i in range(len(toks)):
                    for j in range(i, len(toks)):
                        out = toks[i]
                        for k2 in range(i, j): out += seps[k2] + toks[k2 + 1]
                        if clean(out): terms.add(clean(out))
new = sorted(t for t in terms if t not in oracle)
json.dump(new, open('terms-new.json', 'w'), ensure_ascii=False)
print('oracle terms new:', len(new))
PY
python3 oracle.py terms-new.json oracle.json || exit 1
python3 plan_names.py tags.json oracle.json plan.json whitelist.json || exit 1
STAMP=$(date +%Y%m%d-%H%M)
python3 apply_tags.py plan.json "applied-$STAMP.json" --apply || exit 1
if [ "$(python3 -c "import json;print(len(json.load(open('applied-$STAMP.json'))))")" != "0" ]; then
  python3 refresh_changed.py "applied-$STAMP.json"
else
  rm -f "applied-$STAMP.json" "applied-$STAMP.json.problems.json"
fi
# Albums ripped into several artist folders -> one folder. Needs a real scan
# (paths change) before the favourites/played flags can be put back.
MERGE=$(python3 merge_split_albums.py tags.json --apply 2>/dev/null | tail -1)
if echo "$MERGE" | grep -q '"moved": [1-9]'; then
  SNAP=$(echo "$MERGE" | python3 -c "import json,sys;print(json.load(sys.stdin)['snapshot'])")
  python3 - <<'PY'
from jf import req
import time
req('/Library/Refresh', 'POST'); time.sleep(30)
while next(t for t in req('/ScheduledTasks') if t['Key'] == 'RefreshLibrary')['State'] != 'Idle': time.sleep(30)
PY
  python3 merge_split_albums.py --restore "$SNAP"
fi
python3 cleanup_artists.py --apply
# Artwork now comes from Jellyfin's own providers (TheAudioDB / Fanart / Cover
# Art Archive via MusicBrainz ids) -- the Deezer/Lidarr fetchers below are
# retired (2026-09-14). fix_covers.py only squares off bad cover FILES.
python3 artist_images.py oracle.json --apply   # Deezer -> Lidarr -> own album cover; the Jellyfin providers need MusicBrainz ids most rips lack
python3 albums.py && python3 album_covers.py albums_noimg.json --apply  # embedded-first safety net for new arrivals
python3 fix_flac_pictures.py --apply   # Chrome refuses FLACs with a malformed PICTURE block
python3 fix_covers.py --apply
# Covers may have changed above: drop nginx's artwork cache (music.baxtergroup.io, 00-jfimg-cache.conf)
sudo docker exec nginx sh -c 'rm -rf /var/cache/nginx/jfimg/*' 2>/dev/null || true
echo "=== $(date -Is) hygiene done"
