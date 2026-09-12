#!/usr/bin/env python3
"""Write the artist / albumartist changes from plan.json into the files.
Each change is applied only if the file still carries the exact old value
the plan was computed from, so a stale plan cannot clobber anything. The
applied log (path, field, old, new) is enough to reverse the run:
    python3 apply_tags.py plan.json applied.json --apply
    python3 apply_tags.py applied.json undo.json --apply --reverse
"""
import json, os, sys, time
from mutagen import File

plan = json.load(open(sys.argv[1])); out = sys.argv[2]
apply = '--apply' in sys.argv; reverse = '--reverse' in sys.argv
applied, skipped, errors = [], [], []
t0 = time.time()
for i, (path, ch) in enumerate(plan):
    if not os.path.exists(path):
        skipped.append((path, 'missing')); continue
    try:
        f = File(path, easy=True)
        if f is None:
            skipped.append((path, 'unreadable')); continue
        done = {}
        for field, (old, new) in ch.items():
            if reverse: old, new = new, old
            vals = [str(v) for v in (f.get(field) or [])]
            cur = '; '.join(vals) if len(vals) > 1 else (vals[0] if vals else '')
            if cur != old:
                skipped.append((path, f'{field}: expected {old!r}, found {cur!r}')); continue
            f[field] = [new]
            done[field] = [old, new]
        if done:
            if apply: f.save()
            applied.append([path, done])
    except Exception as e:
        errors.append((path, str(e)[:160]))
    if i % 500 == 0: print(i, len(plan), file=sys.stderr)
json.dump(applied, open(out, 'w'), ensure_ascii=False, indent=0)
json.dump({'skipped': skipped, 'errors': errors}, open(out + '.problems.json', 'w'), ensure_ascii=False, indent=0)
print(json.dumps({'planned': len(plan), 'applied': len(applied), 'skipped': len(skipped), 'errors': len(errors), 'apply': apply, 'reverse': reverse, 'secs': round(time.time() - t0)}))
for s in skipped[:10]: print('  skip', s, file=sys.stderr)
for e in errors[:10]: print('  err', e, file=sys.stderr)
