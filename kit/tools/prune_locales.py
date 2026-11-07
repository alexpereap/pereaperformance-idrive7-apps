#!/usr/bin/env python3
"""Keep in kit/runtime/locales/*.tsv only the rows this repository can show.

A row stays when its English key (trimmed, case-insensitive, as a whole word) occurs in a string
literal of the kit modules that draw or label text or of apps/*/*.js, in a value of apps/*/app.json,
or is on KEEP; a plural
row ("one|other") stays when either form does. A "# section" comment stays while a row follows it.

    python3 kit/tools/prune_locales.py          # rewrite the TSVs, then run sync_locales.py
    python3 kit/tools/prune_locales.py --check  # exit 1 when a row would be dropped (CI)

After pruning: python3 kit/tools/sync_locales.py, and rebake the atlases whose glyph set changed
(bake_cjk.py for zh-CN, bake_korean.py for ko).
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
RUNTIME = ROOT / 'kit/runtime'
# the kit modules that put text on screen or in the HMI (diag, signals, renderd draw nothing)
DRAWING = ['canvas.js', 'record.js', 'gauges.js', 'sheet.js', 'display.js', 'mgu.js', 'hmi-text.js', 'credits.js']
# strings the kit composes at runtime from fragments, so a literal search would miss them
KEEP = ['Settings', 'Back', 'Done', 'Version', '(default)', 'On', 'Off', 'PEAK', 'EST.']


STRING = re.compile(r"'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\"|`((?:[^`\\]|\\.)*)`")


def literals(source):
    """The string literals of a JavaScript source (comments and identifiers do not count)."""
    return [next(g for g in m.groups() if g is not None) for m in STRING.finditer(source)]


def json_strings(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in json_strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in json_strings(v)]
    return []


def corpus():
    parts = []
    for f in DRAWING:
        parts += literals((RUNTIME / f).read_text(encoding='utf-8'))
    for manifest in sorted((ROOT / 'apps').glob('*/app.json')):
        parts += json_strings(json.loads(manifest.read_text(encoding='utf-8')))
        for p in sorted(manifest.parent.glob('*.js')):
            parts += literals(p.read_text(encoding='utf-8'))
    return '\n'.join(parts).lower()


def used(key, text, keep):
    forms = [f.strip() for f in key.split('|')] if '|' in key else [key]
    return any(f.lower() in keep or re.search(r'(?<![a-z0-9])' + re.escape(f.lower()) + r'(?![a-z0-9])', text)
               for f in forms if f)


def prune(lines, text, keep):
    out, pending, dropped = [], [], 0
    for n, line in enumerate(lines):
        if n == 0:
            out.append(line)                    # the file's own header line
        elif not line.strip():
            pending.append('')
        elif line.startswith('#'):
            pending = [p for p in pending if p] + [line]   # a section header waits for a surviving row
        elif used(line.split('\t', 1)[0].strip(), text, keep):
            out += pending
            pending = []
            out.append(line)
        else:
            dropped += 1
    # no double blank lines, none at the end
    cleaned = []
    for line in out:
        if line or (cleaned and cleaned[-1]):
            cleaned.append(line)
    while cleaned and not cleaned[-1]:
        cleaned.pop()
    return cleaned, dropped


def main():
    check = '--check' in sys.argv[1:]
    text, keep = corpus(), {k.lower() for k in KEEP}
    unused = 0
    for tsv in sorted((RUNTIME / 'locales').glob('*.tsv')):
        lines = tsv.read_text(encoding='utf-8').splitlines()
        out, dropped = prune(lines, text, keep)
        kept = sum(1 for l in out if l and not l.startswith('#'))
        print('%s: %d rows kept, %d unused' % (tsv.stem, kept, dropped))
        if dropped and not check:
            tsv.write_text('\n'.join(out) + '\n', encoding='utf-8')
        unused += dropped
    if unused and check:
        raise SystemExit('%d catalog rows nothing shows: run python3 kit/tools/prune_locales.py (then sync_locales.py)' % unused)
    if unused:
        print('now: python3 kit/tools/sync_locales.py')


if __name__ == '__main__':
    main()
