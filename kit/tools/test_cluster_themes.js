'use strict';

// Cluster Themes (apps/perea_cluster_themes) from this repository's build: stage it (build.py --preview-only,
// with the app.json "shared" files and the hud.pack), start it in the kit's stub head unit and let it draw
// its default theme on the bench's stand-in cluster-render (bench/server.js). Passes when the theme's layers
// are all registered there with their pixels, and the app neither threw nor left. No SDK, cluster-render or
// car needed:
//   node kit/tools/test_cluster_themes.js

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '../..');
const APP = 'perea_cluster_themes';
const TIMEOUT_MS = 90000;
const spec = JSON.parse(fs.readFileSync(path.join(root, 'apps', APP, 'app.json'), 'utf8'));
const layoutSetting = spec.settings.find((s) => s.key === 'hudLayout');
const theme = layoutSetting.options.find((o) => o[0] === layoutSetting.default)[1];    // "GT3"

const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/** The bench's first 'scene' event: the layers its stand-in service holds, and their pixel memory. */
const scene = (port) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { host: 'localhost' } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
            text += d;
            const events = text.split('\n\n');
            text = events.pop();
            for (const e of events) {
                if (!e.startsWith('data: ')) continue;
                const m = JSON.parse(e.slice(6));
                if (m.t === 'scene') { req.destroy(); resolve(m); return; }
            }
        });
        res.on('error', () => {});
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
});

(async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-themes-'));
    const port = await freePort();
    const bench = spawn(process.execPath, [path.join(root, 'bench', 'server.js'), APP], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { BENCH_PORT: String(port), BENCH_DATA: data }),
    });
    let out = '';
    const lines = () => out.split('\n');
    bench.stdout.on('data', (d) => { out += d; });
    bench.stderr.on('data', (d) => { out += d; });
    let exited = null;
    bench.on('exit', (code, sig) => { exited = 'bench exited (code ' + code + (sig ? ', ' + sig : '') + ')'; });

    // what must never show: a failed build, an exception the car would end the app for, the app gone, a
    // message the service would refuse
    const fatal = () => lines().find((l) => /build failed|uncaught|app exited|protocol \[|Cluster failed to start/.test(l)) || exited;
    const until = async (what, find) => {
        const end = Date.now() + TIMEOUT_MS;
        for (;;) {
            const hit = find();
            if (hit) return hit;
            const bad = fatal();
            assert.ok(!bad, what + ': ' + bad + '\n' + out);
            assert.ok(Date.now() < end, what + ': not within ' + TIMEOUT_MS / 1000 + ' s\n' + out);
            await new Promise((r) => setTimeout(r, 100));
        }
    };

    try {
        const staged = await until('the build', () => lines().find((l) => /build: .*offline preview/.test(l)));
        assert.ok(staged.indexOf(APP + ' ' + spec.version) >= 0, 'staged ' + APP + ' ' + spec.version + ': ' + staged);
        const js = path.join(root, 'dist', APP, 'source', 'javascript');
        for (const f of spec.shared.concat(['app.js', 'hud.pack', 'NOTICE', 'kit/car.js', 'kit/dids.js', 'kit/readonly-diag.js', 'kit/hud_claim.js', 'kit/pack.js'])) {
            assert.ok(fs.existsSync(path.join(js, f)), 'the stage has javascript/' + f);
        }
        console.log('ok    staged with ' + spec.shared.length + ' shared files, hud.pack and the kit modules the engine needs');

        // the engine's own count of the default theme's layers ...
        const built = await until('the default theme', () => lines().map((l) => /layout "([^"]+)": (\d+) widgets, (\d+) layers/.exec(l)).find(Boolean));
        assert.strictEqual(built[1], theme, 'the default theme is drawn');
        const want = Number(built[3]);
        assert.ok(want >= 1, 'the theme has layers');
        console.log('ok    ' + theme + ': ' + built[2] + ' widgets in ' + want + ' layers');

        // ... is what the stand-in service holds, every layer shown and the image layers with pixels
        const held = await until('the service\'s status', () => lines().map((l) => /cluster-render status: bench: (\d+) layers/.exec(l)).find(Boolean));
        assert.strictEqual(Number(held[1]), want, 'the service holds the theme\'s layers');
        const sc = await scene(port);
        const drawn = sc.layers.filter((l) => l.kind !== 'asset');
        assert.strictEqual(drawn.length, want, 'the scene has the theme\'s layers');
        const notShown = drawn.filter((l) => l.state !== 'shown').map((l) => l.key + ' ' + l.state + (l.reason ? ' (' + l.reason + ')' : ''));
        assert.deepStrictEqual(notShown, [], 'every layer is shown');
        assert.ok(drawn.every((l) => l.target === spec.config.target), 'every layer is on the ' + spec.config.target + ' target');
        assert.ok(sc.pixels > 0, 'the image layers have pixels');
        console.log('ok    the stand-in cluster-render shows all ' + want + ' layers on "' + spec.config.target + '" (' + (sc.pixels / 1048576).toFixed(1) + ' MiB of pixels)');

        // a few seconds of the demo drive: redraws, shifts, the status poll
        await new Promise((r) => setTimeout(r, 4000));
        const bad = fatal();
        assert.ok(!bad, 'while running: ' + bad + '\n' + out);
        console.log('ok    still up after 4 s of the demo drive, nothing thrown');
        console.log('cluster themes: all ok');
    } finally {
        if (!exited) bench.kill('SIGTERM');
        fs.rmSync(data, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e && e.message || e); process.exit(1); });
