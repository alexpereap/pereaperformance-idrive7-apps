'use strict';

// Kit runtime (display.js, renderd.js, mgu.js Settings) against a stand-in mgu-render on a Unix socket: the
// unchanged-frame skip and its keepalive, a sheet that throws, X_STATE front flips, a reconnect after a cut
// message, the theme kept on a fresh install; and iDrive 8: the 2880 x 960 screen's app area, the page scaled into
// it, the kit running the screen by touch alone, Settings as the header's tab. No SDK, renderer or car needed:
//   node kit/tools/test_runtime.js

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-rt-'));
process.env.MGU_RENDERD_SOCKET = path.join(dir, 'render.sock');
['MGU_RENDERER', 'MGU_RENDERD_FILE', 'MGU_RENDERD_PROTO', 'MGU_NO_GRAB'].forEach((k) => delete process.env[k]);
const { Display } = require('../runtime/display');
const { RenderClient } = require('../runtime/renderd');
const themes = require('../runtime/themes');

const FRAME = 7, READY = 101, TICK = 102, TOUCH = 105, X_READY = 0x4d520101, X_STATE = 0x4d520102, X_CCU = 0x4d520103;
const uncaught = [];
process.on('uncaughtException', (e) => uncaught.push(e));     // (else node exits, as mgu.js does on the car)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u32 = (...a) => Buffer.from(new Uint32Array(a).buffer);
function msg(type, p) {
    const b = Buffer.alloc(8 + p.length + ((4 - (p.length & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4); p.copy(b, 8);
    return b;
}
async function waitFor(fn, ms) {
    for (const t0 = Date.now(); Date.now() - t0 < (ms || 2000); await sleep(10)) if (fn()) return true;
    return false;
}

// the renderer's side: the app's FRAMEs (time of each, a TICK back for each), READY on connect (onConn)
let onConn = null;
const server = net.createServer((s) => {
    const c = { s, frames: [], buf: Buffer.alloc(0), send: (t, p) => s.write(msg(t, p)) };
    s.on('data', (d) => {
        c.buf = Buffer.concat([c.buf, d]);
        while (c.buf.length >= 8) {
            const t = c.buf.readUInt32LE(0), n = c.buf.readUInt32LE(4);
            if (c.buf.length < 8 + n) break;
            c.buf = c.buf.slice(8 + n);
            if (t === FRAME) { c.frames.push(Date.now()); c.send(TICK, u32(c.frames.length, 0)); }
        }
    });
    s.on('error', () => {});
    onConn(c);
});
const ready = (c) => { c.send(X_READY, u32(1, 1, 7)); c.send(READY, u32(4, 1920, 720, 1)); };   // touch, controller, front gate
const ccu = (k, pb, df) => { const b = Buffer.alloc(5); b.writeUInt16BE(k, 1); b[3] = pb; b[4] = df; return b; };
const touch = (phase, x, y) => { const b = Buffer.alloc(12); b.writeUInt32LE(phase, 0); b.writeFloatLE(x, 4); b.writeFloatLE(y, 8); return b; };

/** A Display on the stand-in renderer, the kit running the screen (full-screen layout, touch), shown. */
async function setup() {
    let conn = null;
    onConn = (c) => { conn = c; ready(c); };
    const log = { errors: [], info() {}, warn() {}, debug() {}, error: (...a) => log.errors.push(a) };
    const vis = new Set(['MAIN']), visH = [];
    const ui = {
        rhmi: null, close() {}, visible() {}, onVisible: (fn) => visH.push(fn), isVisible: (n) => vis.has(n),
        setVisible: (v) => { if (v) vis.add('MAIN'); else vis.delete('MAIN'); visH.forEach((fn) => fn('MAIN', v)); },
    };
    const spec = { id: 'test', title: 'Test', screens: [{ name: 'MAIN', kind: 'canvas', buttons: [['BTN_SETTINGS', 'Settings']] }] };
    const d = new Display(ui, log, spec, { get: () => undefined, onChange() {} }, () => themes.theme());
    assert(await waitFor(() => conn && d.active() && d.own()), 'display on the renderer');
    return { d, ui, log, c: conn, end() { d.closeSheet(); d.gpu.close(); clearInterval(d.keepTimer); } };
}
/** The app draws its page (v: what changes) and hands it over, as ui.image does. */
function page(d, v) {
    const r = d.canvas(1600, 520);
    r.fillRect(100, 100, 400, 200, '#ff0000'); r.fillRect(0, 300, v, 10, '#00ff00');
    d.present('MAIN', r, () => Promise.resolve());
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('unchanged frames: not sent again, but one a second (the renderer hides an app quiet for 3 s)', async () => {
    const t = await setup(), c = t.c;
    try {
        const t0 = Date.now();
        while (Date.now() - t0 < 2500) { page(t.d, 10); await sleep(16); }
        const f = c.frames.slice(), gaps = f.slice(1).map((x, i) => x - f[i]).concat(Date.now() - f[f.length - 1]);
        console.log('  a static page at 60 fps for 2.5 s: ' + f.length + ' FRAMEs, longest gap ' + Math.max(...gaps) + ' ms');
        assert(f.length >= 2 && f.length <= 6, 'FRAMEs for a static page: ' + f.length);
        assert(Math.max(...gaps) < 1600, 'the longest time without a FRAME: ' + Math.max(...gaps) + ' ms');
        // a changed page: at once
        let n = c.frames.length;
        page(t.d, 20); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'a changed page');
        // the header changed (the knob turned onto a tab), the page did not: at once, and only once
        n = c.frames.length;
        c.send(X_CCU, ccu(0, 0, 0)); c.send(X_CCU, ccu(1, 0, 0)); await sleep(50);
        assert.strictEqual(t.d.focusTab, 0);
        assert.strictEqual(c.frames.length, n + 1, 'the header changed');
        page(t.d, 20); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'the same page with the same header');
        // shown again: the picture comes back once the HMI's page has opened (display.js SHOW_DELAY_MS, 350 ms),
        // then the same page goes out at once
        t.ui.setVisible(false); t.ui.setVisible(true);
        await sleep(450);
        n = c.frames.length;
        page(t.d, 20); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'shown again');
        // a sheet painted every 33 ms that does not change: its first frame, then the keepalive
        n = c.frames.length;
        assert(t.d.openSheet({ draw: (r) => { r.fillRect(0, 0, 50, 50, '#0000ff'); return []; }, move() {} }));
        await sleep(1500);
        console.log('  a static sheet for 1.5 s: ' + (c.frames.length - n) + ' FRAMEs');
        assert(c.frames.length - n >= 2 && c.frames.length - n <= 4, 'FRAMEs for a static sheet: ' + (c.frames.length - n));
        // closed: the page again, at once
        n = c.frames.length;
        t.d.closeSheet(); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'the sheet closed');
    } finally { t.end(); }
});

test('a sheet\'s press, back and touch target that throw: logged, the app runs on', async () => {
    const t = await setup(), c = t.c;
    try {
        page(t.d, 10);
        const boom = (w) => () => { throw new Error(w); };
        assert(t.d.openSheet({ draw: () => [{ x: 0, y: 0, w: 1600, h: 520, act: boom('act') }], move() {}, press: boom('press'), back: boom('back') }));
        const n = uncaught.length;
        c.send(X_CCU, ccu(0, 0, 0)); c.send(X_CCU, ccu(0, 1, 0));                      // press
        c.send(X_CCU, ccu(0, 0, 0)); c.send(X_CCU, ccu(0, 0, 10));                     // push left
        c.send(TOUCH, touch(1, 800, 300)); c.send(TOUCH, touch(3, 800, 300));          // a tap on the target
        await sleep(100);
        // (an uncaught exception ends the app on the car: mgu.js process.exit(1), and the platform wipes its data)
        assert.deepStrictEqual(uncaught.slice(n).map((e) => e.message), [], 'uncaught in the socket\'s data handler');
        assert.deepStrictEqual(t.log.errors.map((a) => a[0] + ' ' + a[1].message), ['sheet press', 'sheet back', 'sheet act']);
        assert(t.d.sheet, 'the sheet stays open');
    } finally { t.end(); }
});

test('not in front, then in front (not on screen yet) within 1.5 s: the app stays on the renderer', async () => {
    const t = await setup(), c = t.c;
    try {
        page(t.d, 10);
        c.send(X_STATE, u32(1, 0, 0)); await sleep(100);
        c.send(X_STATE, u32(1, 0, 1)); await sleep(1700);
        assert(!t.d.blocked, 'blocked though in front');
        assert(t.d.own());
        // not in front for good: blocked after 1.5 s
        c.send(X_STATE, u32(1, 0, 0)); await sleep(1700);
        assert.strictEqual(t.d.blocked, true, 'not in front for 1.5 s');
    } finally { t.end(); }
});

test('a connection cut in the middle of a message: the next connection\'s READY is read', async () => {
    let n = 0;
    onConn = (c) => {
        if (n++) { ready(c); return; }
        c.s.write(Buffer.concat([u32(TICK, 8), u32(1)]));                              // 4 of TICK's 8 bytes
        setTimeout(() => c.s.destroy(), 50);
    };
    const g = new RenderClient('test', { info() {}, warn() {}, error() {} }, { native: true });
    try {
        let readyN = 0;
        g.on('ready', () => readyN++);
        g.connect();
        await waitFor(() => readyN, 5000);
        assert.strictEqual(n, 2, 'connected again');
        assert.strictEqual(readyN, 1, 'READY after the reconnect');
        assert(g.native && g.info && g.info.touch, 'X_READY after the reconnect');
    } finally { g.close(); }
});

test('the one-time move to the new default theme: a theme picked on a fresh install stays', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'mgu.js'), 'utf8').replace(/\r\n/g, '\n');
    const cls = src.match(/class Settings[\s\S]*?\n}\n/)[0];      // (as hu-stub.js: the real class without the SDK)
    const make = (sub) => {
        const dd = path.join(dir, sub);
        fs.mkdirSync(dd);
        return new Function('fs', 'path', 'DATA_DIR', 'log', cls + '\nreturn Settings;')(fs, path, dd, { warn() {}, error() {} });
    };
    const file = (sub) => path.join(dir, sub, 'settings.json');
    const schema = [{ key: 'theme', type: 'choice', default: 'm_tricolour', options: [] }, { key: 'units', type: 'choice', default: 'metric', options: [] }];
    // fresh install: no file until something is set; a theme set then stays
    let S = make('fresh');
    assert.strictEqual(new S(schema).get('theme'), 'm_tricolour');
    assert(!fs.existsSync(file('fresh')), 'a fresh start writes no file');
    new S(schema).set('theme', 'amber');
    assert.strictEqual(new S(schema).get('theme'), 'amber', 'theme picked on a fresh install, next start');
    // another setting set first, the theme later: stays too
    S = make('fresh2');
    new S(schema).set('units', 'imperial');
    new S(schema).set('theme', 'amber');
    assert.strictEqual(new S(schema).get('theme'), 'amber', 'theme picked after another setting, next start');
    // saved before the new default (no mark): moved to it once, the next choice stays
    S = make('old');
    fs.writeFileSync(file('old'), JSON.stringify({ theme: 'amber', units: 'imperial' }));
    const o = new S(schema);
    assert.strictEqual(o.get('theme'), 'm_tricolour', 'an old save moves to the new default');
    assert.strictEqual(o.get('units'), 'imperial');
    assert.strictEqual(JSON.parse(fs.readFileSync(file('old'), 'utf8'))._themeV, 2);
    o.set('theme', 'amber');
    assert.strictEqual(new S(schema).get('theme'), 'amber');
});

test('settings: aliases, "when" and "group" (the drawn settings sheet), "hidden"', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'mgu.js'), 'utf8').replace(/\r\n/g, '\n');
    const cls = src.match(/class Settings[\s\S]*?\n}\n/)[0];
    const dd = path.join(dir, 'when');
    fs.mkdirSync(dd);
    const S = new Function('fs', 'path', 'DATA_DIR', 'log', cls + '\nreturn Settings;')(fs, path, dd, { warn() {}, error() {} });
    fs.writeFileSync(path.join(dd, 'settings.json'), JSON.stringify({ tempUnit: 'F' }));
    const schema = [
        { key: 'tempUnit', label: 'Temperature unit', type: 'choice', default: 'c', options: [['c', 'Celsius'], ['f', 'Fahrenheit']], aliases: { C: 'c', F: 'f' } },
        { key: 'torqueUnit', label: 'Torque unit', type: 'choice', default: 'nm', options: [['nm', 'Nm'], ['kgm', 'kgm']] },
        { key: 'maxKgm', label: 'Torque gauge max', type: 'number', default: 100, steps: [50, 100], when: { torqueUnit: 'kgm' } },
        { key: 'showA', label: 'Tile A', type: 'choice', default: 'auto', options: [['auto', 'Auto'], ['off', 'Hide']], group: 'Tiles' },
        { key: 'showB', label: 'Tile B', type: 'choice', default: 'auto', options: [['auto', 'Auto'], ['off', 'Hide']], group: 'Tiles' },
        { key: 'names', label: 'Names', type: 'choice', default: 'en', options: [['en', 'English']], hidden: true },
        { key: 'advanced', label: 'Advanced settings', type: 'bool', default: false },
        { key: 'rate', label: 'Display rate', type: 'number', default: 10, steps: [5, 10], when: { advanced: true } },
    ];
    const st = new S(schema);
    assert.strictEqual(st.get('tempUnit'), 'f', 'a value saved as F reads as f');
    const { listSheet } = require(path.join(__dirname, '..', 'runtime', 'sheet.js'));
    const sh = listSheet(st, null, {});
    const labels = () => sh.rows().map((r) => r.label);
    assert.deepStrictEqual(labels(), ['Temperature unit', 'Torque unit', 'Tiles', 'Advanced settings'], 'kgm-only, grouped, hidden and advanced left out');
    st.set('torqueUnit', 'kgm');
    st.set('advanced', true);
    assert.deepStrictEqual(labels(), ['Temperature unit', 'Torque unit', 'Torque gauge max', 'Tiles', 'Advanced settings', 'Display rate'], 'offered once their "when" holds');
    // the group: one row that opens its settings; Back returns to it
    sh.focus = 3; sh.choose();
    assert.deepStrictEqual([sh.group, labels()], ['Tiles', ['Tile A', 'Tile B']]);
    sh.focus = 1; sh.choose();
    assert.strictEqual(sh.open.key, 'showB', 'a grouped setting opens its values');
    sh.sub = 1; sh.choose();
    assert.strictEqual(st.get('showB'), 'off');
    assert.deepStrictEqual([sh.back(), sh.group, sh.focus], [null, null, 3], 'Back: the main list, on the group');
    assert.strictEqual(sh.back(), 'close');
    // a switch that hides the setting the focus was on: the focus stays on the list
    sh.focus = 5; st.set('advanced', false);
    const r = new Proxy({}, { get: (o, k) => (k === 'extra' ? 0 : () => 40) });
    sh.draw(r, { bg: '#000', text: '#fff', dim: '#888', sel: '#00f' });
    assert.strictEqual(sh.focus, labels().length - 1);
});

test('a new scale keeps the uploads (the renderer keeps them), a new size sends them again', async () => {
    const t = await setup(), g = t.d.gpu;
    try {
        const pl = Object.assign({}, g.placement);
        g.sent.atlas.add(1); g.sent.ramp.add(2); g.sent.image.set(3, 1); g.sent.layer.add(4);
        g.place(Object.assign({}, pl, { scale: pl.scale * 0.9 }));
        assert.deepStrictEqual([g.sent.atlas.has(1), g.sent.ramp.has(2), g.sent.image.has(3)], [true, true, true], 'a new scale sends everything again');
        assert(!g.sent.layer.has(4), 'layers drawn at the old scale');
        g.place(Object.assign({}, pl, { w: pl.w - 8 }));
        assert.deepStrictEqual([g.sent.atlas.size, g.sent.ramp.size, g.sent.image.size], [0, 0, 0], 'a new size');
    } finally { t.end(); }
});

/* ---------------- iDrive 8: 2880 x 960, the renderer's layer over the app area ---------------- */
const ready8 = (c) => { c.send(X_READY, u32(1, 1, 1 | 8, 0, 0, 0, 0, 0, 76, 2880, 764, 2048, 60000)); c.send(READY, u32(4, 2880, 960, 1)); };   // touch, no controller gate
/** A Display as on iDrive 8: the UI description there has no bar button, settings screen or image (ui.rhmi finds none). */
async function setup8(o) {
    o = o || {};
    let conn = null;
    onConn = (c) => { conn = c; (o.ready || ready8)(c); };
    const log = { errors: [], warns: [], info() {}, warn: (...a) => log.warns.push(a.join(' ')), debug() {}, error: (...a) => log.errors.push(a) };
    const vis = new Set(['MAIN']), visH = [];
    const ui = {
        rhmi: { getByName: () => null }, hmi: o.hmi, noImage: true, close() {}, notes: [],
        visible: () => { throw new Error('an HMI component asked for on iDrive 8'); },
        onVisible: (fn) => visH.push(fn), isVisible: (n) => vis.has(n),
    };
    const spec = { id: 'test', title: 'Test', screens: [{ name: 'MAIN', kind: 'canvas', buttons: [['BTN_SETTINGS', 'Settings']] }] };
    // (with the HMI known, the "renderer" and "layout" settings do not apply there: set against it on purpose)
    const vals = !o.hmi ? {} : { renderer: 'software', layout: 'standard' }, changeH = [];
    const settings = { get: (k) => vals[k], onChange: (fn) => changeH.push(fn), set: (k, v) => { vals[k] = v; changeH.forEach((fn) => fn(k, v)); } };
    const d = new Display(ui, log, spec, settings, () => themes.theme());
    assert(await waitFor(() => conn && d.active()), 'display on the renderer');
    return { d, ui, log, settings, c: conn, end() { d.closeSheet(); d.gpu.close(); clearInterval(d.keepTimer); } };
}

test('iDrive 8: the page scaled into the app area the renderer reports, the kit runs the screen by touch', async () => {
    const t = await setup8({ hmi: 'ID8' }), d = t.d;
    try {
        assert(await waitFor(() => d.own()), 'the kit runs the screen');
        const pl = d.place;
        assert.deepStrictEqual([pl.x, pl.y, pl.w, pl.h, pl.scale, pl.ox, pl.oy, pl.full], [0, 76, 2880, 764, 1.394, 325, 33, true]);
        assert.deepStrictEqual(d.gpu.xready.appArea, { x: 0, y: 76, w: 2880, h: 764 });
        assert.strictEqual(d.geo.id, 'ID8');
        assert.strictEqual(d.geo.areaFrom, 'X_READY');
        assert.strictEqual(d.layout(), 'full', 'no standard layout there, whatever the setting says');
        assert.strictEqual(d.barH(), 0, 'no button bar');
        assert.deepStrictEqual(d.buttons(), []);
        assert(!d.gpu.grabbing, 'the controller is not grabbed (no gate in Hmi8)');
        // the page keeps its 1600 x 520 shape: its left and right edges are inside the area, the header above it
        const left = pl.ox + 12 * pl.scale, right = pl.ox + 1588 * pl.scale, top = pl.oy + 38 * pl.scale, bottom = pl.oy + 520 * pl.scale;
        assert(left > 300 && right < 2880 - 300 && top >= 80 && bottom <= 764, 'page window ' + [left, right, top, bottom].map(Math.round).join(','));
        // a frame: the header's tabs are the app's page and Settings; the claims cover the area (header and page)
        let softs = 0;
        const r = d.canvas(1600, 520);
        const G = require('../runtime/gauges');
        r.fillRect(100, 100, 400, 200, '#ff0000');
        G.frame(r, themes.theme(), ['Flex Fuel'], 0, []);
        await d.present('MAIN', r, () => { softs++; return Promise.resolve(); });
        assert.strictEqual(softs, 0, 'nothing drawn in the HMI (it has no image there)');
        const tl = d._tabList();
        assert.deepStrictEqual([tl.tabs, tl.settings], [['Flex Fuel', 'Settings'], 1]);
        const claims = JSON.parse(d.gpu.claimed);
        assert.strictEqual(claims.length, 2);
        const scr = claims.map((q) => ({ x: Math.round(q.x * pl.scale + pl.ox), y: Math.round(q.y * pl.scale + pl.oy), w: Math.round(q.w * pl.scale), h: Math.round(q.h * pl.scale) }));
        assert.deepStrictEqual(scr, [{ x: 0, y: 0, w: 2880, h: 80 }, { x: 0, y: 80, w: 2880, h: 684 }], 'claims in the layer\'s pixels');
        // a tap on the Settings tab: no HMI button there - the kit's own opener (mgu.js wireSettings sets it)
        let opened = 0;
        d.onSettings = () => { opened++; return null; };
        const tab = d.tabs.find((q) => q.i === 1);
        assert(tab, 'the Settings tab has a rect');
        t.c.send(TOUCH, touch(1, tab.x + tab.w / 2, tab.y + tab.h / 2)); t.c.send(TOUCH, touch(3, tab.x + tab.w / 2, tab.y + tab.h / 2));
        assert(await waitFor(() => opened === 1), 'the Settings tab opens the settings');
        // the settings sheet is drawn over the page
        assert(d.openSheet({ settings: true, draw: (rr) => { rr.fillRect(0, 0, 50, 50, '#0000ff'); return []; }, move() {} }), 'a sheet can open');
        assert.strictEqual(d._tabList().sel, 1, 'Settings is the lit tab while its sheet shows');
        d.closeSheet();
        // iDrive 8's own look: the frame knows what the layer shows under the header, in the page's px
        const v = r.view;
        assert(v && Math.abs(v.x0 + 233.1) < 0.2 && Math.abs(v.x1 - 1832.9) < 0.2 && Math.abs(v.y0 - 33.7) < 0.2 && Math.abs(v.y1 - 524.4) < 0.2, 'view ' + JSON.stringify(v));
        assert(Math.abs(v.x0 * pl.scale + pl.ox) < 0.01 && Math.abs(v.x1 * pl.scale + pl.ox - 2880) < 0.01 && Math.abs(v.y0 * pl.scale + pl.oy - 80) < 0.01 && Math.abs(v.y1 * pl.scale + pl.oy - 764) < 0.01, 'the view is the layer under the header');
        // the backdrop: the grey over all of it, the wide flag at its top left, the line to the right edge
        const { Recorder: Rec, play: playRec } = require('../runtime/record');
        const { Canvas: Cv } = require('../runtime/canvas');
        const b = new Rec(1600, 520);
        assert.strictEqual(G.backdrop(b, themes.theme()), false, 'no view (iDrive 7, software): nothing drawn');
        assert.strictEqual(b.words().length, 0);
        b.view = v;
        assert.strictEqual(G.backdrop(b, themes.theme()), true);
        assert(b.words().length > 20, 'the backdrop draws');
        playRec(b.words(), new Cv(1600, 520));              // (the software canvas takes it too)
        assert.deepStrictEqual([G.WIDE_FLAG.w, G.WIDE_FLAG.h], [300, 8], 'the flag: about 4 times the panel\'s 78 px bar');
        // the header: tabs only (the HMI's strip above has the app's name), so the first tab starts at its left edge
        assert.strictEqual(d.chromeRec.tabRects[0].x, 20, 'no app name before the tabs: ' + JSON.stringify(d.chromeRec.tabRects[0]));
        // the diagnostics column only with the setting on; changing it repaints
        const frames0 = t.c.frames.length, words0 = d.lastWords.length;
        t.settings.set('diag', true);
        assert(await waitFor(() => t.c.frames.length > frames0), 'the setting repaints');
        assert(d.lastWords.length > words0, 'the column is drawn with the setting on');
        t.settings.set('diag', false);
        assert(await waitFor(() => d.lastWords.length === words0), 'and gone with it off');
        // the diagnostics lines themselves
        const lines = d.diagLines().join('\n');
        assert(/hmi ID8 geo ID8/.test(lines) && /dialect mgu-render\/1/.test(lines) && /area 0,76,2880,764/.test(lines) && /screen 2880x960 touch 1/.test(lines) && /scale 1.394 off 325,33/.test(lines), lines);
        assert.deepStrictEqual(t.log.errors, []);
    } finally { t.end(); }
});

test('iDrive 8 without the UI description saying so: the 2880 x 960 screen is enough; a renderer that answers READY alone works too', async () => {
    let t = await setup8({});
    try {
        assert(await waitFor(() => t.d.own()), 'the kit runs the screen');
        assert.strictEqual(t.d.place.scale, 1.394);
    } finally { t.end(); }
    // (IterioDev's renderer: no mgu-render/1, touch routed) the same placement from the default area
    t = await setup8({ hmi: 'ID8', ready: (c) => c.send(READY, u32(4, 2880, 960, 1)) });
    try {
        assert(await waitFor(() => t.d.own()), 'the kit runs the screen on the upstream dialect');
        assert.deepStrictEqual([t.d.place.x, t.d.place.y, t.d.place.w, t.d.place.h, t.d.place.scale], [0, 76, 2880, 764, 1.394]);
        assert.strictEqual(t.d.geo.areaFrom, 'default');
    } finally { t.end(); }
    // no touch routing: shown, but the kit does not run the screen (nothing could be pressed)
    t = await setup8({ hmi: 'ID8', ready: (c) => { c.send(X_READY, u32(1, 1, 8, 0, 0, 0, 0, 0, 76, 2880, 764, 2048, 60000)); c.send(READY, u32(4, 2880, 960, 0)); } });
    try {
        assert(t.d.active() && !t.d.own());
        assert.strictEqual(t.d.place.full, true);
    } finally { t.end(); }
});

test('iDrive 7 is as it was: 1920 x 720 placement, the bar and the HMI button', async () => {
    const t = await setup(), d = t.d;
    try {
        assert.strictEqual(d.geo.id, undefined, 'the iDrive 7 geometry');
        // (the page right of the back column: scale floor(min((1920 - 84) / 1576, (720 - 80) / 482) * 1000) / 1000 = 1.164,
        // ox 84 + round((1836 - 1576 * 1.164) / 2 - 12 * 1.164) = 71: the numbers main gives)
        assert.deepStrictEqual([d.place.x, d.place.y, d.place.w, d.place.h, d.place.scale, d.place.ox, d.place.full], [0, 0, 1920, 720, 1.164, 71, true]);
        assert(d.gpu.grabbing, 'the controller is held where the gate is');
        assert.strictEqual(d.id8(), false);
        // no wide view there: the page draws its panel, and the header keeps the app's name before the tabs
        const r = d.canvas(1600, 520);
        assert.strictEqual(r.view, null);
        const G = require('../runtime/gauges');
        G.frame(r, themes.theme(), ['Flex Fuel'], 0, []);
        await d.present('MAIN', r, () => Promise.resolve());
        assert(d.chromeRec.tabRects[0].x > 100, 'the app name comes before the tabs: ' + JSON.stringify(d.chromeRec.tabRects[0]));
    } finally { t.end(); }
});

test('fonts: a size that has the text\'s glyphs (num holds letters and brackets at 40 px only)', async () => {
    const fonts = require('../runtime/fonts');
    // iDrive 8: 30 px x 1.394 = 41.8 px. The 64 px atlas has no "l", "(" or ")": the result read "76.1 ga 288.0 L"
    assert.strictEqual(fonts.get('num', 30 * 1.394, '76.1 gal (288.0 L)').size, 40);
    assert.strictEqual(fonts.get('num', 30 * 1.394, '13').size, 64, 'digits: the size picked as before');
    assert.strictEqual(fonts.get('num', 84 * 1.394, '14.8').size, 150);
    // iDrive 7 (x 1.164): the same atlases as before
    assert.strictEqual(fonts.get('num', 30 * 1.164, '15.4 gal (58.2 L)').size, 40);
    assert.strictEqual(fonts.get('num', 84 * 1.164, '59').size, 150);
    assert.strictEqual(fonts.get('label', 18 * 1.164, 'Purity 99 %').size, 24);
    assert.strictEqual(fonts.get('bold', 26 * 1.164, 'FLEX FUEL ACTIVE').size, 32);
    // a character no size has: the size picked first stays
    assert.strictEqual(fonts.get('num', 50, '12 \u2603').size, 64);
});

(async () => {
    await new Promise((r) => server.listen(process.env.MGU_RENDERD_SOCKET, r));
    let failed = 0;
    for (const [name, fn] of cases) {
        try { await fn(); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
    }
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(failed ? failed + ' of ' + cases.length + ' failed' : 'runtime: all ok');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
