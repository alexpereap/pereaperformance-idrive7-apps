"""
previews.py - the pictures the settings page shows of each theme (shared/page.js, shared/previews.js).

The centre screen can't draw our themes live (they are cluster-render layers, many of them GLSL), so each
one is shot on the bench with fixed demo values and shipped as a picture inside the app:
apps/<app>/hud/previews/<layout>.json = { big, small[, full]: {w, h, z} } (full: the HUD's whole 800x480), z = base64 of the
zlib-deflated RGBA rows (opaque). The build packs hud/ into hud.pack; previews.js inflates them.

    # the app's bench must be running (node bench/server.js <app>, BENCH_PORT=...)
    python3 -I tools/previews.py perea_cluster_themes 8078

The bench's settings are put back afterwards. The raw shots are kept in out/previews-src/<app>/ (gitignored).
Chrome: CHROME=/path/to/chrome, else the first of google-chrome, chromium, chromium-browser on PATH.
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zlib

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = os.environ.get('CHROME') or next((p for p in (shutil.which(n) for n in ('google-chrome', 'chromium', 'chromium-browser')) if p),
                                          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
SKIP = {'off', 'grid', 'mapcal', 'wincal'}           # calibration layouts get no picture
# the values every picture shows: 3rd gear at 4200 rpm, 61 mph, warm engine, a little boost, braking into a left turn
SIGNALS = {'rpm': 4200, 'speed': 98, 'gear': 3, 'oil': 95, 'coolant': 90, 'boost': 1.1, 'torque': 290,
           'fuelL': 38, 'range': 310, 'ambient': 18, 'tyreP': 2.4, 'tyreT': 30, 'gLat': 0.42, 'gLong': -0.3,
           # a made-up song for the Vector layouts' music panel (the bench feeds it as the head unit's now playing)
           'mediaTitle': 'Demo Song', 'mediaArtist': 'Artist Name', 'mediaElapsed': 83, 'mediaTotal': 250}
# picture sizes in device px (the page is drawn at logical px and scaled about 1.165 on the car's screen)
SIZES = {
    'panel': {'src': (1920, 720), 'crop': (0, 0, 1920, 720), 'big': (888, 333), 'small': (280, 105)},
    # the HUD: the part seen through the windshield (shared/visible.js HUD_WINDOW 120,100 560x280) with room around it,
    # cut at the pictures' 1.6 : 1
    'hud': {'src': (800, 480), 'crop': (90, 47, 710, 433), 'big': (560, 349), 'small': (300, 187), 'full': (840, 504)},
}


def post(port, path, body):
    req = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path), data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    urllib.request.urlopen(req, timeout=5).read()


def shot(port, size, out):
    # headless Chrome sometimes hangs on a cluster page (Nov 7 2026: twice in one run), and once shot GT3 before
    # anything had drawn (a black 1 KB picture); three tries, 60 s each, and a picture with almost nothing lit is a miss
    for attempt in range(3):
        if os.path.exists(out):
            os.remove(out)           # a stale file would look like success
        try:
            subprocess.run([CHROME, '--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                            '--virtual-time-budget=20000', '--hide-scrollbars', '--window-size=%d,%d' % size,
                            '--screenshot=' + out, 'http://localhost:%d/?only=1&backdrop=0&clean=1&car=0' % port],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
            lit = sum(Image.open(out).convert('L').point(lambda v: 255 if v > 40 else 0).histogram()[255:])
            if lit >= 400:
                return
            print('  (picture came out blank, try %d of 3)' % (attempt + 1), flush=True)
        except subprocess.TimeoutExpired:
            subprocess.run(['pkill', '-f', '--screenshot=' + out], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print('  (Chrome hung, try %d of 3)' % (attempt + 1), flush=True)
    raise SystemExit('no good picture in three tries: ' + out)


def pack(img, size):
    im = img.resize(size, Image.LANCZOS).convert('RGBA')
    return {'w': size[0], 'h': size[1], 'z': base64.b64encode(zlib.compress(im.tobytes(), 9)).decode()}


def main():
    app, port = sys.argv[1], int(sys.argv[2])
    spec = json.load(open(os.path.join(ROOT, 'apps', app, 'app.json')))
    target = spec.get('config', {}).get('target', 'hud')
    sz = SIZES['panel' if target == 'panel' else 'hud']
    layouts = [o[0] for o in next(s for s in spec['settings'] if s['key'] == 'hudLayout')['options'] if o[0] not in SKIP]
    data = os.path.join(ROOT, 'bench', '.data', app, 'settings.json')
    saved = json.load(open(data)) if os.path.exists(data) else {}
    defaults = {s['key']: s.get('default') for s in spec['settings']}
    raw = os.path.join(ROOT, 'out', 'previews-src', app)
    os.makedirs(raw, exist_ok=True)
    out = {}
    # a short lap of g first (brake, both turns, accelerate), so a G-meter shows a grip outline, not one wedge
    lap = [(0, -0.9), (0.5, -0.6), (0.85, -0.15), (0.6, 0.2), (0, 0.35), (-0.6, 0.2), (-0.8, -0.1), (-0.45, -0.55), (0, -0.9)]
    for (a, b), (c, d) in zip(lap, lap[1:]):
        for i in range(6):
            t = i / 6
            post(port, '/signals', {'mode': 'manual', 'values': dict(SIGNALS, gLat=a + (c - a) * t, gLong=b + (d - b) * t)})
            time.sleep(0.12)
    post(port, '/signals', {'mode': 'manual', 'values': SIGNALS})
    post(port, '/setting', {'key': 'byMode', 'value': False})
    if 'nightDim' in defaults:       # the pictures show the day colours, whatever the time
        post(port, '/setting', {'key': 'nightDim', 'value': 'off'})
    if 'hudTheme' in defaults:       # HUD Widgets: the day colours too (Auto shot after sunset came out Night)
        post(port, '/setting', {'key': 'hudTheme', 'value': defaults.get('dayTheme') or 'classic'})
    try:
        for name in layouts:
            post(port, '/setting', {'key': 'hudLayout', 'value': name})
            time.sleep(4)
            png = os.path.join(raw, name + '.png')
            shot(port, sz['src'], png)
            whole = Image.open(png).convert('RGB')
            img = whole.crop(sz['crop'])
            out[name] = {'big': pack(img, sz['big']), 'small': pack(img, sz['small'])}
            if 'full' in sz:         # the whole HUD, the layout unmoved (the page's Position tab)
                out[name]['full'] = pack(whole, sz['full'])
            print('  %s: %s' % (name, ', '.join('%s %d KB' % (k, len(v['z']) // 1024) for k, v in out[name].items())))
    finally:
        for k in ('hudLayout', 'byMode', 'nightDim', 'hudTheme'):
            if k not in defaults:
                continue
            post(port, '/setting', {'key': k, 'value': saved.get(k, defaults.get(k))})
        post(port, '/signals', {'mode': 'demo', 'values': {}})
    dst = os.path.join(ROOT, 'apps', app, 'hud', 'previews')
    os.makedirs(dst, exist_ok=True)
    for name, v in out.items():
        with open(os.path.join(dst, name + '.json'), 'w') as f:
            json.dump(v, f, separators=(',', ':'))
    print('%d previews -> %s' % (len(out), os.path.relpath(dst, ROOT)))


if __name__ == '__main__':
    main()
