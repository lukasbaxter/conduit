#!/usr/bin/env python3
"""Sidecars left behind by a rename: 2,956 .lrc files had no audio file of the
same base name (the retag pass turned "02. Milky Chance - Ego.flac" into
"02. Ego.flac" and left "02. Milky Chance - Ego.lrc"), so Jellyfin and the
relay's lyrics store both missed them. An orphan is renamed to the one audio
file in its folder that shares its "NN. " track-number prefix, when that file
has no sidecar of its own. --dry lists, default renames and prints a list of
the audio files touched (for refresh_lyrics.py).
"""
import json, os, re, sys, time
from pathlib import Path
ROOT = Path("/mnt/wd_nvme1/music")
EXTS = {".flac", ".mp3", ".m4a", ".opus", ".ogg", ".wav", ".aac", ".wma", ".aiff"}
dry = "--dry" in sys.argv
NUM = re.compile(r"^(?:(\d{1,2})-)?(\d{1,3})[.\-\s_]+")  # "1-12 Boys" = disc 1 track 12; "12. Boys" = track 12
renamed, ambiguous, nomatch = [], 0, 0
for lrc in ROOT.rglob("*.lrc"):
    if any(lrc.with_suffix(e).exists() for e in EXTS): continue
    m = NUM.match(lrc.name)
    if not m: nomatch += 1; continue
    n, disc = int(m.group(2)), m.group(1)
    cands = [p for p in lrc.parent.iterdir() if p.suffix.lower() in EXTS and (mm := NUM.match(p.name)) and int(mm.group(2)) == n and (not disc or not mm.group(1) or mm.group(1) == disc) and not p.with_suffix(".lrc").exists()]
    if len(cands) != 1: ambiguous += (len(cands) > 1); nomatch += (len(cands) == 0); continue
    target = cands[0].with_suffix(".lrc")
    renamed.append({"file": str(cands[0]), "from": lrc.name, "to": target.name})
    if not dry: lrc.rename(target)
print(json.dumps({"renamed": len(renamed), "ambiguous": ambiguous, "no_match": nomatch, "dry": dry}))
for r in renamed[:8]: print("  ", r["from"], "->", r["to"])
if renamed and not dry:
    out = Path.home() / "conduit-hygiene" / f"lyrics_changed-orphans-{time.strftime('%Y%m%d-%H%M')}.json"
    json.dump(renamed, open(out, "w"), indent=1, ensure_ascii=False); print("list:", out)
