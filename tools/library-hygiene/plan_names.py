#!/usr/bin/env python3
"""Decide, for every artist string in the library, what it should become:
collaboration strings are split into their real artists, and every spelling
variant of one artist (case, BOM, unicode hyphens, trailing dots) collapses to
one canonical spelling. Pure function of tags.json + oracle.json; writes
plan.json (per-file changes) and whitelist.json (real names that contain one
of Jellyfin's delimiter characters). Nothing is modified here.

    python3 plan_names.py tags.json oracle.json plan.json whitelist.json
"""
import json, os, re, sys
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from namekey import clean, key, STRONG, WEAK, ANY, _TRANS

tags = json.load(open(sys.argv[1]))
oracle = json.load(open(sys.argv[2]))
DELIMS = set('/|;\\,&')
JUNK = re.compile(r'\s*[\[(]\s*(?:www\.)?[\w.-]+\.(?:com|net|org|ru|info|me|to|cc)\S*\s*[\])]\s*', re.I)

LEAD = re.compile(r'^(?:&|and|with|feat\.?|ft\.?|featuring)\s+', re.I)
def tidy(s):
    s = clean(JUNK.sub(' ', clean(s)))
    s = re.sub(r'(?:\s*[,&/+]|\s(?:and|with|feat\.?|ft\.?))+$', '', s, flags=re.I).strip()  # "Swae Lee, NAV,"
    # "with The Emotions", "& Jimmy James": a separator that lost its lead artist
    m = LEAD.match(s)
    if m and not oracle_name(s) and oracle_name(s[m.end():]):
        s = clean(s[m.end():])
    return s

def oracle_name(s):
    # Deezer first: its spellings match what streaming apps show (SEVENTEEN,
    # FISHER), MusicBrainz's are more sober (Seventeen, Fisher).
    o = oracle.get(s) or oracle.get(clean(s)) or {}
    if o.get('deezer'): return o['deezer']['name']
    if o.get('lidarr'): return o['lidarr']['name']
    return None

# Names that appear on their own (no separator at all) somewhere in the
# library: a piece we recognise from elsewhere counts as known even when
# neither oracle has heard of it.
freq = Counter()
for t in tags.values():
    if not t or 'error' in t: continue
    for k in ('artist', 'albumartist'):
        for v in t[k]:
            for p in v.split(';'):
                p = tidy(p)
                if p: freq[p] += 1
standalone = {key(n) for n in freq if not ANY.search(n)}

# Pieces that are never an artist on their own; a split producing one is wrong.
JUNK_PARTS = {'cast', 'music', 'various', 'various artists', 'unknown', 'unknown artist', 'friends', 'others', 'more', 'va'}
# Hand overrides for the oracles' blind spots (bands spelled differently
# from MusicBrainz, credits it cannot see through).
OVR = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'overrides.json')))
KEEP = {key(n) for n in OVR.get('keep', [])}
def known(s):
    if key(s) in KEEP: return True
    if key(s) in JUNK_PARTS: return False
    return bool(oracle_name(s)) or key(s) in standalone

def fans(s):
    o = oracle.get(s) or oracle.get(clean(s)) or {}
    return (o.get('deezer') or {}).get('fans') or 0

def credit_not_band(s):
    """Deezer (and sometimes MusicBrainz) file joint credits like "21 Savage &
    Brent Faiyaz" as artists in their own right, so the oracle saying "real"
    is not enough for a string with & , or /. Treat it as a credit when every
    piece is a real artist, the lead artist appears on their own elsewhere in
    the library, and the lead is far bigger than the pairing."""
    if key(s) in KEEP or not re.search(r'[,&/]|\s[xX]\s', s): return False
    o = oracle.get(s) or oracle.get(clean(s)) or {}
    if (o.get('lidarr') or {}).get('type') == 'Group': return False  # MusicBrainz says it is a band
    ps = [clean(p) for p in WEAK.split(s) if clean(p)]
    if len(ps) < 2 or not all(oracle_name(p) for p in ps): return False
    if key(ps[0]) in standalone and fans(ps[0]) > 2 * fans(s): return True
    # no standalone lead, but Deezer lists the pairing and it is a nobody next
    # to its members (a MusicBrainz-only group with no Deezer page is a band)
    if not o.get('deezer'): return False
    return fans(s) < 5000 and max(fans(p) for p in ps) > 10 * max(fans(s), 1)

def band(s):
    """A string that may stand as one artist inside a longer credit."""
    return known(s) and not credit_not_band(s)

SEP = re.compile(ANY.pattern, re.I)
def segment(s):
    """Split one string at its separators into the fewest known artists.
    Returns None when no acceptable partition exists (keep the string whole)."""
    toks, seps = [], []
    pos = 0
    for m in SEP.finditer(s):
        toks.append(clean(s[pos:m.start()])); seps.append(m.group(0)); pos = m.end()
    toks.append(clean(s[pos:]))
    if any(not t for t in toks): return None
    n = len(toks)
    def piece(i, j):  # tokens i..j inclusive, with their original separators
        out = toks[i]
        for k in range(i, j): out += seps[k] + toks[k + 1]
        return clean(out)
    best = None  # (segments, -known, parts)
    def rec(i, parts, nknown):
        nonlocal best
        if i == n:
            if len({key(p) for p in parts}) < len(parts): return  # "Years & Years" -> Years, Years
            if len(parts) >= 2 and (best is None or (len(parts), -nknown) < (best[0], best[1])):
                best = (len(parts), -nknown, list(parts))
            return
        if best is not None and len(parts) + 1 > best[0] + 1: return
        for j in range(n - 1, i - 1, -1):
            p = piece(i, j)
            if band(p):
                rec(j + 1, parts + [p], nknown + 1)
            elif i > 0 and j == i and parts and known(parts[0]) and seps[i - 1].strip().lower() != 'and':
                # an unknown single token is fine as a featured artist behind a
                # known lead ("MACROSS 82-99 with Diana Shroomy"), but not
                # after "and": that is how band names look ("Island And Holiday")
                rec(j + 1, parts + [p], nknown)
    rec(0, [], 0)
    return best[2] if best else None

def transform(raw):
    """One raw artist string -> list of artist strings."""
    s = tidy(raw)
    if not s: return []
    if known(s) and not STRONG.search(s) and not credit_not_band(s):
        return [s]
    out = []
    # strong separators always split, whatever the oracle says about the whole
    for chunk in (STRONG.split(s) if STRONG.search(s) else [s]):
        chunk = clean(chunk)
        if not chunk: continue
        if not WEAK.search(chunk) or (known(chunk) and not credit_not_band(chunk)):
            out.append(chunk); continue
        seg = segment(chunk)
        if seg and any(key(p) in JUNK_PARTS for p in seg): seg = None
        out += seg if seg else [chunk]
    return out

# Pass 1: transform every distinct raw part.
raw_parts = Counter()
for t in tags.values():
    if not t or 'error' in t: continue
    for k in ('artist', 'albumartist'):
        for v in t[k]:
            for p in v.split(';'):
                if clean(p): raw_parts[clean(p)] += 1
split = {p: transform(p) for p in raw_parts}

# Pass 2: canonical spelling per key.  Oracle spelling wins; otherwise the
# most frequent spelling in the library.
by_key = defaultdict(Counter)
for p, outs in split.items():
    for o in outs: by_key[key(o)][o] += raw_parts[p]
canon = {}
def ascii_typo(s):  # same string with ASCII hyphens/quotes
    return s.translate(_TRANS)
for k, spellings in by_key.items():
    if len(spellings) == 1:
        canon[k] = next(iter(spellings)); continue
    # Never invent a spelling: choose among the library's own. Prefer the one
    # the oracle uses (ignoring hyphen/quote style), then plain ASCII
    # typography, then the most common.
    on = next((oracle_name(sp) for sp in spellings if oracle_name(sp) and key(oracle_name(sp)) == k), None)
    ranked = sorted(spellings.items(), key=lambda kv: (
        0 if on and ascii_typo(kv[0]) == ascii_typo(on) else 1,
        0 if ascii_typo(kv[0]) == kv[0] else 1,
        -kv[1]))
    canon[k] = ranked[0][0]

def final(raw_value):
    seen, res = set(), []
    for p in raw_value.split(';'):
        p = clean(p)
        if not p: continue
        for o in split.get(p) or [p]:
            c = canon.get(key(o), o)
            if key(c) not in seen:
                seen.add(key(c)); res.append(c)
    return res

changes = []
for path, t in tags.items():
    if not t or 'error' in t: continue
    ch = {}
    for k in ('artist', 'albumartist'):
        vals = t[k]
        if not vals: continue
        joined = '; '.join(vals) if len(vals) > 1 else vals[0]
        new = '; '.join(final(joined))
        if new and new != joined: ch[k] = [joined, new]
    if ch: changes.append([path, ch])

final_names = Counter()
for path, t in tags.items():
    if not t or 'error' in t: continue
    for k in ('artist', 'albumartist'):
        vals = t[k]
        if vals:
            for n in final('; '.join(vals)): final_names[n] += 1
whitelist = sorted(n for n in final_names if set(n) & DELIMS)

json.dump(changes, open(sys.argv[3], 'w'), ensure_ascii=False, indent=0)
json.dump(whitelist, open(sys.argv[4], 'w'), ensure_ascii=False, indent=0)
splits = {p: o for p, o in split.items() if len(o) > 1 or (o and o[0] != p)}
json.dump({'split': splits, 'canon': canon}, open('plan-debug.json', 'w'), ensure_ascii=False, indent=0)
print(json.dumps({'files_changed': len(changes), 'distinct_before': len(raw_parts), 'distinct_after': len(final_names),
                  'splits': sum(1 for o in split.values() if len(o) > 1), 'whitelist': len(whitelist)}))
