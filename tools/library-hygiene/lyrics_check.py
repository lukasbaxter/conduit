#!/usr/bin/env python3
"""Synced lyrics that do not fit the file: some .lrc sidecars were matched to
a different edit of the song (other intro, other master), so the lines run
early or late by a constant on every device. Every track with a sidecar is
re-asked from LrcLib with the FILE's duration (/api/get needs it and only
answers with a record within a couple of seconds of it); a synced answer
whose timestamps differ from the sidecar replaces it, and Jellyfin refreshes
the item so /Audio/{id}/Lyrics serves the new one.

  lyrics_check.py --sample 40       # report only, random sample
  lyrics_check.py --dry             # report everything, write nothing
  lyrics_check.py                   # replace (old sidecar kept in lyrics_backup/), then
  refresh_lyrics.py lyrics_changed-*.json   # Jellyfin re-reads the touched tracks
"""
import argparse, json, os, random, re, sys, time, urllib.parse, urllib.request
from pathlib import Path
import mutagen

ROOT = Path("/mnt/wd_nvme1/music")
EXTS = {".flac", ".mp3", ".m4a", ".opus", ".ogg", ".wav"}
CACHE = Path.home() / "conduit-hygiene" / "lyrics_lrclib_cache.json"
BACKUP = Path.home() / "conduit-hygiene" / "lyrics_backup"
UA = "conduit-hygiene/1 (lyrics fit check; github.com/lukasbaxter)"
TS = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\]")

def stamps(text):
    out = []
    for line in (text or "").splitlines():
        m = TS.match(line)
        if m: out.append(int(m.group(1)) * 60 + float(m.group(2)))
    return out

def first(v):
    if isinstance(v, list): v = v[0] if v else ""
    return str(v or "").strip()

def tags(path):
    try: f = mutagen.File(path, easy=True)
    except Exception: return None
    if not f: return None
    t = f.tags or {}
    return { "title": first(t.get("title")), "artist": first(t.get("artist")), "album": first(t.get("album")),
             "duration": float(getattr(f.info, "length", 0) or 0) }

def lrclib_get(t, cache):
    key = json.dumps([t["title"], t["artist"], t["album"], round(t["duration"])], ensure_ascii=False)
    if key in cache: return cache[key]
    q = urllib.parse.urlencode({ "track_name": t["title"], "artist_name": t["artist"], "album_name": t["album"], "duration": round(t["duration"]) })
    req = urllib.request.Request(f"https://lrclib.net/api/get?{q}", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r: res = json.load(r)
    except urllib.error.HTTPError as e:
        res = None if e.code == 404 else {"error": e.code}
    except Exception as e:
        res = {"error": str(e)}
    if not (isinstance(res, dict) and "error" in res): cache[key] = res
    time.sleep(0.25)
    return res

def fit(old, new):
    """How far the sidecar's timestamps sit from LrcLib's (median shift, s)."""
    a, b = stamps(old), stamps(new)
    if not a or not b: return None
    n = min(len(a), len(b))
    d = sorted(x - y for x, y in zip(a[:n], b[:n]))
    return d[len(d) // 2]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=0)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()
    cache = json.load(open(CACHE)) if CACHE.exists() else {}
    files = [p for p in ROOT.rglob("*.lrc")]
    if args.sample: random.seed(); files = random.sample(files, min(args.sample, len(files)))
    stats = {"tracks": 0, "no_audio": 0, "no_tags": 0, "lrclib_miss": 0, "same": 0, "shifted": 0, "unsynced_only": 0, "replaced": 0}
    changed = []
    for i, lrc in enumerate(files):
        audio = next((lrc.with_suffix(e) for e in EXTS if lrc.with_suffix(e).exists()), None)
        if not audio: stats["no_audio"] += 1; continue
        t = tags(audio)
        if not t or not t["title"] or not t["duration"]: stats["no_tags"] += 1; continue
        stats["tracks"] += 1
        res = lrclib_get(t, cache)
        if i % 50 == 0: json.dump(cache, open(CACHE, "w"))
        if not res or "error" in res: stats["lrclib_miss"] += 1; continue
        new = res.get("syncedLyrics")
        if not new: stats["unsynced_only"] += 1; continue
        old = lrc.read_text(errors="replace")
        shift = fit(old, new)
        if shift is not None and abs(shift) < 0.6 and abs(len(stamps(old)) - len(stamps(new))) <= 2:
            stats["same"] += 1; continue
        stats["shifted"] += 1
        changed.append({"file": str(audio), "shift": shift, "old_lines": len(stamps(old)), "new_lines": len(stamps(new)), "lrclib_duration": res.get("duration"), "file_duration": round(t["duration"], 1)})
        if not args.dry and not args.sample:
            bak = BACKUP / lrc.relative_to(ROOT); bak.parent.mkdir(parents=True, exist_ok=True)
            if not bak.exists(): bak.write_text(old)
            lrc.write_text(new + "\n")
            stats["replaced"] += 1
    json.dump(cache, open(CACHE, "w"))
    print(json.dumps(stats))
    for c in changed[:60]: print(f'{c["shift"]!s:>8}s  {c["old_lines"]:>3}->{c["new_lines"]:<3} dur {c["file_duration"]} vs {c["lrclib_duration"]}  {c["file"][len(str(ROOT)) + 1:]}')
    if changed:
        out = Path.home() / "conduit-hygiene" / f"lyrics_changed-{time.strftime('%Y%m%d-%H%M')}.json"
        json.dump(changed, open(out, "w"), indent=1, ensure_ascii=False)
        print("list:", out)

if __name__ == "__main__": main()
