'use strict';
// mgu.js's start sequence against a stand-in oap-sdk, in the two shapes the head units have: iDrive 7's
// (SDK 24.x: _initialized, _appStatusService, the ID7 UI description's components) and iDrive 8's (SDK 50.x:
// isInitialized, appStatusService, getEntryPoints, the ID8 description: a host state, a note and a marker).
// The iDrive 7 trace must stay what it was before iDrive 8 support. No SDK, renderer or car needed:
//   node kit/tools/test_start.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const APP = 'perea_mhd_flex';
const ENTRY = '11111111-2222-3333-4444-555555555555';

/* ---------------- child: the app with the stand-in SDK ---------------- */
if (process.argv[2] === '--child') {
    const shape = process.argv[3], stage = process.argv[4], names = JSON.parse(process.argv[5]);
    const EventEmitter = require('events');
    const Module = require('module');
    const trace = [];
    const say = (s) => trace.push(s);
    const later = (v) => new Promise((r) => setImmediate(() => r(v)));
    let nextId = 1;
    const comps = {};
    names.forEach((n) => {
        const c = new EventEmitter();
        c.id = nextId++;
        c.getId = () => c.id;
        c.setValue = () => later(); c.setProperty = () => later(); c.setRowCount = () => later();
        c.updateResources = () => { say('comp ' + n + '.updateResources'); return later(); };
        c.values = [];
        if (n === 'KIT_NOTE') c.setValue = (row, cell, value) => { say('note ' + JSON.stringify(String(value).slice(0, 90))); return later(); };
        comps[n] = c;
    });
    const rhmi = new EventEmitter();
    rhmi.getByName = (n) => comps[n] || null;
    rhmi.mapEntryState = (uuid, st) => { say('rhmi.mapEntryState ' + (st && names.find((n) => comps[n] === st))); return later(); };
    rhmi.openEntryState = () => { say('rhmi.openEntryState'); setImmediate(() => rhmi.emit('applicationStackChanged', { ROOT_APP: [comps.MAIN.id] })); return later(); };
    rhmi.openState = (n) => { say('rhmi.openState ' + n); return later(); };
    rhmi.closeState = (n) => { say('rhmi.closeState ' + n); return later(); };
    rhmi.getResourceBundle = () => ({ createResourceHandles: () => later(), getResourceHandle: () => 1, destroyResourceHandles: () => later() });
    class OnlineApp extends EventEmitter {
        constructor() {
            super();
            say('new OnlineApp');
            this.startReason = 'ENTRY_POINT';
            if (shape === 'ID8') {
                this.isInitialized = false; this.appStatusService = {}; this.packageJson = { name: APP };
                this.appDescription = { application: { entryPoints: [{ uuid: ENTRY, textId: 'SID_TITLE', icon: 'icon.png' }] } };
                this.getVisibilityData = () => ({ reason: 'ENTRY_POINT' });
                this.getEntryPoints = () => [{
                    getDescription: () => ({ uuid: ENTRY, textId: 'SID_TITLE', icon: 'icon.png' }),
                    init: () => { say('entry.init'); return later(); },
                    setAvailability: (a) => { say('entry.setAvailability ' + a); return later(); },
                    entryPoint: { setText: () => later(), setIcon: () => later() },
                }];
            } else { this._initialized = false; this._appStatusService = {}; this._packageJson = { name: APP }; }
        }
        start() { say('app.start'); this.rhmiApplication = rhmi; setImmediate(() => this.emit('appStatusProxyReady')); return later(); }
        registerActive() { say('app.registerActive'); return later(); }
        registerInactive() { say('app.registerInactive'); return later(); }
        registerHmiVisible() { say('app.registerHmiVisible'); return later(); }
        unregisterHmiVisible() { say('app.unregisterHmiVisible'); return later(); }
        initialized() { say('app.initialized'); if (shape === 'ID8') this.isInitialized = true; else this._initialized = true; return later(); }
        getLastExecutedEntryPointUuid() { return ENTRY; }
        destroyBundles() { return later(); }
    }
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const sdk = { OnlineApp, logging: { getSDKLogger: () => logger }, someipBuilders: { buildAndInitTypedProxy: () => Promise.reject(new Error('stand-in: no SOME/IP')) } };
    const load = Module._load;
    Module._load = function (req) {
        if (req === 'oap-sdk') return sdk;
        if (req === 'oap-sdk/package.json') return { version: shape === 'ID8' ? '50.1.0' : '24.10.2' };
        if (req === 'someip') throw new Error('stand-in: no native someip');
        return load.apply(this, arguments);
    };
    const exit = process.exit;
    process.exit = (c) => { say('process.exit ' + c); };
    process.chdir(path.join(stage, 'data'));
    require(path.join(stage, 'source', 'javascript', 'app.js'));
    setTimeout(() => { process.stdout.write('\nTRACE ' + JSON.stringify(trace) + '\n'); exit(0); }, Number(process.env.MGU_TEST_MS || 1800));
    return;
}

/* ---------------- parent ---------------- */
function stageApp(hmi) {
    execFileSync('python3', [path.join(ROOT, 'kit', 'tools', 'build.py'), '--preview-only', '--hmi', hmi, APP], { stdio: 'pipe' });
    const stage = path.join(ROOT, 'dist', APP);
    for (const d of ['data', path.join('rhmiData', 'resources')]) fs.mkdirSync(path.join(stage, d), { recursive: true });
    fs.writeFileSync(path.join(stage, 'rhmiData', 'application.json'), JSON.stringify({ application: { entryPoints: [{ uuid: ENTRY }] } }));
    for (const f of fs.readdirSync(path.join(stage, 'data'))) fs.rmSync(path.join(stage, 'data', f), { recursive: true, force: true });
    return stage;
}
function run(shape, stage, names, env) {
    const r = spawnSync(process.execPath, [__filename, '--child', shape, stage, JSON.stringify(names)], {
        encoding: 'utf8', timeout: 20000,
        env: Object.assign({}, process.env, { MGU_RENDERD_SOCKET: path.join(os.tmpdir(), 'mgu-no-renderer-' + process.pid + '.sock') }, env || {}),
    });
    const m = /\nTRACE (.*)\n/.exec(r.stdout || '');
    assert(m, 'the app ran to the end: ' + (r.stderr || r.stdout || '').slice(-600));
    const logFile = path.join(stage, 'data', APP + '.log');
    return { trace: JSON.parse(m[1]), log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '' };
}
/** the component names of a UI description (uiDescription.json) */
function namesOf(ui) {
    const out = [];
    Object.keys(ui.containers).forEach((k) => {
        const c = ui.containers[k];
        out.push(c.name);
        Object.keys(c.components || {}).forEach((j) => out.push(c.components[j].name));
    });
    return out;
}

const id7Names = namesOf(JSON.parse(fs.readFileSync(path.join(__dirname, 'snapshots', APP, 'ID7.uiDescription.json'), 'utf8')));
// the iDrive 8 description's components, from build.py itself
const id8Names = namesOf(JSON.parse(execFileSync('python3', ['-c',
    'import sys, json; sys.path.insert(0, sys.argv[1]); import build; from test_build import spec_of; print(json.dumps(build.build_ui_id8(spec_of(sys.argv[2]))[1]))',
    __dirname, APP], { encoding: 'utf8' })));

if (process.argv[2] === '--print') {
    console.log(JSON.stringify(run(process.argv[3] || 'ID7', stageApp(process.argv[3] || 'ID7'), process.argv[3] === 'ID8' ? id8Names : id7Names).trace, null, 1));
    process.exit(0);
}

// iDrive 7: the SDK calls of the start, in order, as they were before iDrive 8 support (recorded on main at 1.4.0)
const ID7_TRACE = ['new OnlineApp', 'app.start', 'app.registerActive', 'rhmi.mapEntryState MAIN', 'app.registerActive',
    'comp SETTINGS.updateResources', 'app.initialized', 'comp MAIN.updateResources', 'rhmi.openEntryState', 'app.registerHmiVisible'];

let failed = 0;
const test = (name, fn) => { try { fn(); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n').slice(0, 6).join('\n      ')); } };

test('iDrive 7 shape (SDK 24.x, the ID7 description): the start is what it was', () => {
    const r = run('ID7', stageApp('ID7'), id7Names);
    assert.deepStrictEqual(r.trace, ID7_TRACE);
    assert(/diag: start=\{"hmi":"ID7","marker":false,"graphic":true/.test(r.log), 'the HMI found is logged');
    assert(!/typed proxy/.test(r.log), 'no typed SOME/IP proxies on iDrive 7');
    assert(/image MAIN_GFX: shown/.test(r.log), 'the software path draws in the HMI image');
});

test('iDrive 8 shape (SDK 50.x, the ID8 description): the lifecycle proven there, no HMI image, the note', () => {
    const r = run('ID8', stageApp('ID8'), id8Names, { MGU_NOTE_MS: '100' });
    const t = r.trace, at = (x) => t.indexOf(x);
    assert(/diag: start=\{"hmi":"ID8","marker":true/.test(r.log), 'the HMI found is logged: ' + (r.log.match(/diag: start=.{0,80}/) || [''])[0]);
    assert.strictEqual(t.filter((x) => x === 'app.registerActive').length, 1, 'ACTIVE once: ' + JSON.stringify(t));
    assert(at('app.registerActive') > 0 && at('app.registerActive') < at('app.initialized'), 'ACTIVE before initialized()');
    assert(at('comp MAIN.updateResources') < at('entry.init'), 'the state\'s resources before the entry point');
    assert(at('entry.init') < at('rhmi.mapEntryState MAIN') && at('rhmi.mapEntryState MAIN') < at('entry.setAvailability ENABLED'), 'entry point: init, map, ENABLED');
    assert(at('entry.setAvailability ENABLED') < at('app.initialized'), 'the entry point before initialized()');
    assert(at('rhmi.openEntryState') > at('app.initialized'), 'the state the app was started with is opened');
    assert(!t.some((x) => /HmiVisible|registerInactive/.test(x)), 'no visibility reports on iDrive 8');
    assert(!t.some((x) => /process\.exit/.test(x)), 'the app does not exit');
    assert(!/SETTINGS|BTN_SETTINGS|MAIN_GFX/.test(r.log.replace(/diag: start=.*\n/, '')), 'nothing asks for components the ID8 description lacks');
    assert(!/image MAIN_GFX/.test(r.log), 'no image pushed to the HMI');
    const note = t.filter((x) => x.indexOf('note ') === 0);
    assert(note.length >= 1 && /MGU Store renderer/.test(note[0]), 'the HMI page says why nothing is drawn: ' + JSON.stringify(note));
    assert(/signals backend: .*InternalTasu.* none: .*typed proxy/.test(r.log), 'the typed SOME/IP proxy is tried for the diagnostic link');
    assert(/diag: entry points: ENABLED ok/.test(r.log) && /diag: lifecycle=\{"reason":"ENTRY_POINT"/.test(r.log));
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', APP, 'data', APP + '-diag.json'), 'utf8'));
    assert.strictEqual(d.start.hmi, 'ID8');
    assert(d.events.applicationStackChanged && d.events.applicationStackChanged.length >= 1, 'event payloads are kept for the first run');
});

test('an ID7-built package on the iDrive 8 description: warned, and it runs as iDrive 8', () => {
    const r = run('ID8', stageApp('ID7'), id8Names);
    assert(/taken to be for ID7 .* but the HMI loaded the ID8 UI description/.test(r.log));
    assert(!r.trace.some((x) => /process\.exit/.test(x)));
    assert(r.trace.indexOf('entry.setAvailability ENABLED') >= 0);
});

test('iDrive 8 with the bare host state ("id8Labels": false: no marker, no note): known by the missing graphic', () => {
    const r = run('ID8', stageApp('ID8'), ['MAIN', 'MAIN_TITLE']);
    assert(/diag: start=\{"hmi":"ID8","marker":false,"graphic":false/.test(r.log), (r.log.match(/diag: start=.{0,90}/) || [''])[0]);
    assert(r.trace.indexOf('entry.setAvailability ENABLED') >= 0 && r.trace.indexOf('app.initialized') >= 0);
    assert(!r.trace.some((x) => /HmiVisible|process\.exit|^note /.test(x)));
});

stageApp('ID7');        // (leave the stage as the other tools make it)
console.log(failed ? failed + ' failed' : 'start: all ok');
process.exit(failed ? 1 : 0);
