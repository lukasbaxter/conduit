"""Shared normalisation: two spellings with the same key are the same artist."""
import re, unicodedata

_HYPHENS = dict.fromkeys(map(ord, '‐‑‒–—―−'), '-')
_QUOTES = {0x2018: "'", 0x2019: "'", 0x201a: "'", 0x201c: '"', 0x201d: '"', 0x201e: '"', 0x00b4: "'", 0x0060: "'"}
_TRANS = {**_HYPHENS, **_QUOTES}

def clean(s):
    """Light cleanup that is always safe to write back: strip BOM/zero-width
    junk and surrounding whitespace, collapse runs of spaces."""
    s = (s or '').replace('﻿', '').replace('​', '').replace(' ', ' ')
    return re.sub(r'\s+', ' ', s).strip()

def key(s):
    s = unicodedata.normalize('NFKC', clean(s)).translate(_TRANS).casefold()
    s = re.sub(r'\s*([&,/+])\s*', r'\1', s)    # "A & B" == "A&B"
    s = re.sub(r'\.(?=\s|$)', '', s)            # "Boogie T." == "Boogie T"
    return re.sub(r'\s+', ' ', s).strip()

# Separators. STRONG ones always mean a collaboration; WEAK ones only when the
# whole string is not itself a known artist and the pieces are.
STRONG = re.compile(r'\s(?:feat\.?|ft\.?|featuring|vs\.?|versus)\s', re.I)
WEAK = re.compile(r'\s*,\s*(?:&|and|with)\s+|\s(?:with|and|x|&|\+)\s|\s*[,/]\s*', re.I)
ANY = re.compile(STRONG.pattern + '|' + WEAK.pattern, re.I)

def parts(s):
    return [clean(p) for p in ANY.split(s) if clean(p)]
