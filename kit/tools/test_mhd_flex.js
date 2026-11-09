'use strict';
// Flex Fuel: the MHD ethanol protocol and the poller against in-memory DMEs (MHD on the known ROM, a stock
// DME, MHD on another ROM, a DME that forgets the identifier, a quiet one), the accept filters, the blend
// calculator, the screen in every state (software canvas and GPU recorder) with its -5 / +5 buttons, and
// main.js with the kit stubbed (settings, the cluster's fuel signal). No SDK or car needed:
//   node kit/tools/test_mhd_flex.js
const assert = require('assert');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const kit = path.join(ROOT, 'kit/runtime');
const app = path.join(ROOT, 'apps/perea_mhd_flex');
// the app requires the kit as ./kit/<name>: map it to kit/runtime
const load = Module._load;
let mguApp = null;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu' && parent && parent.filename.startsWith(app)) return { run: (a) => { mguApp = a; } };
    if (req.startsWith('./kit/') && parent && parent.filename.startsWith(app)) return load.call(this, path.join(kit, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const P = require(path.join(app, 'protocol'));
const { Poller } = require(path.join(app, 'poller'));
const UI = require(path.join(app, 'ui'));
const C = require(path.join(app, 'calc'));
const LOGO = require(path.join(app, 'logo'));
const G = require(path.join(kit, 'gauges'));
const { Canvas } = require(path.join(kit, 'canvas'));
const { Recorder, play } = require(path.join(kit, 'record'));
const themes = require(path.join(kit, 'themes'));

const hex = (b) => b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const bytes = (s) => s.split(/\s+/).filter(Boolean).map((x) => parseInt(x, 16));
const quiet = { info() {}, warn() {}, error(e) { throw new Error('log.error: ' + e); } };

// the SVK replies as the user's DME gave them (ids at unaligned offsets on purpose in the second one)
const SVK_OWN_F101 = bytes('62 F1 01 01 01 00 06 26 11 04 8F 04 D2 01 00 00 00 10 00 00 01 00 00 3D DE 03 13 16 02 00 00 3D D1 FF FF FF 06 00 00 48 DB 01 23 05 08 00 00 5D 55 50 3C 05 0D 00 00 84 17 50 3C 1D 05 00 00 27 42 02 05 41');
const SVK_OWN_F102 = bytes('62 F1 02 01 01 00 05 22 02 18 8B 00 08 00 30 30 30 30 00 00 01 00 00 3D DE 03 1D 04 02 00 00 6E 45 FF FF FF 08 00 00 5D 55 50 3C 05 08 00 00 99 F6 14 46 06');
const SVK_OTHER_F101 = bytes('62 F1 01 01 01 00 06 26 10 16 8F 04 D2 01 00 00 00 10 00 00 06 00 00 48 DB 01 23 05 08 00 00 5C 64 14 6E 06 0D 00 00 8A 51 14 6E AD');
const MHD_MARKER = bytes('6F 04 4D 48 44 32 01 20 00 00 00 00 00 1C 06 00 00 42');

/**
 * An in-memory DME at 0x12. kind: 'mhd' (the owner's ROM), 'stock' (no MHD), 'other' (MHD, another ROM),
 * 'quiet' (never answers). Options: lose = reads that answer 7F 22 31 before a good one; short = reply with
 * one data byte; values = [active, can]; slots = the dynamic identifiers the DME has (F300..F303 like the
 * owner's: any other answers 7F 2C 31, as F304 did on the car). Fuel: fuel = { L, R, total } counts for
 * 22 5949 / 594A / 583B (L may be an array: one value per read), ethanol = the 22 550D byte (default 32 = 12.5 %;
 * false: 7F 22 31), noHalves = 7F 22 31 to the halves, fuelQuiet = no answer to any fuel request. Every reply is checked
 * against the request's accept().
 */
function dme(kind, o) {
    o = o || {};
    const d = { calls: [], inflight: 0, maxInflight: 0, defined: null, lose: o.lose || 0, values: o.values || [85, 83],
        slots: o.slots || ['F300', 'F301', 'F302', 'F303'], fuel: Object.assign({ L: 49, R: 48, total: 48 }, o.fuel || {}), reads: 0 };
    const didOf = (data) => hex(data.slice(1, 3)).replace(' ', '');
    d.physical = async (target, sid, data, timeoutMs, accept) => {
        assert.strictEqual(target, 0x12);
        assert.ok(typeof accept === 'function', 'every request filters its reply');
        d.inflight++; d.maxInflight = Math.max(d.maxInflight, d.inflight);
        await new Promise(setImmediate);
        d.inflight--;
        d.calls.push(hex([sid].concat(data)));
        const reply = (() => {
            if (kind === 'quiet') return null;
            if (sid === 0x2F) return kind === 'stock' ? [0x7F, 0x2F, 0x11] : MHD_MARKER.slice();
            if (sid === 0x22 && data[0] === 0xF1) {
                if (data[1] === 0x01) return kind === 'other' ? SVK_OTHER_F101.slice() : SVK_OWN_F101.slice();
                if (data[1] === 0x02) return kind === 'other' ? [0x7F, 0x22, 0x31] : SVK_OWN_F102.slice();
            }
            if (sid === 0x2C) {
                assert.strictEqual(kind, 'mhd', 'only the known ROM may be defined');
                const did = didOf(data);
                if (d.slots.indexOf(did) < 0) return [0x7F, 0x2C, 0x31];
                if (data[0] === 0x03) { const was = d.defined === did; if (was) d.defined = null; return was ? [0x6C, 0x03, data[1], data[2]] : [0x7F, 0x2C, 0x31]; }
                if (data[0] === 0x02) {
                    assert.strictEqual(hex(data.slice(3)), '14 B0 00 60 C2 01 B0 00 60 D2 01');
                    d.defined = did; return [0x6C, 0x02, data[1], data[2]];
                }
            }
            if (sid === 0x22 && (data[0] === 0x59 || data[0] === 0x58 || data[0] === 0x55)) {
                if (o.fuelQuiet) return null;
                const did = hex(data).replace(' ', '');
                if (did === '583B') return [0x62, 0x58, 0x3B, d.fuel.total];
                if (did === '550D') return o.ethanol === false ? [0x7F, 0x22, 0x31] : [0x62, 0x55, 0x0D, o.ethanol == null ? 32 : o.ethanol];
                if (did !== '5949' && did !== '594A') return [0x7F, 0x22, 0x31];
                if (o.noHalves) return [0x7F, 0x22, 0x31];
                const want = did === '5949' ? d.fuel.L : d.fuel.R;
                const v = Array.isArray(want) ? want[Math.min(want.length - 1, did === '5949' ? d.reads++ : 0)] : want;
                return [0x62, data[0], data[1], v];
            }
            if (sid === 0x22 && data[0] === 0xF3) {
                const did = hex(data).replace(' ', '');
                if (d.lose > 0) { d.lose--; d.defined = null; }
                if (d.defined !== did) return [0x7F, 0x22, 0x31];
                if (o.short) return [0x62, data[0], data[1], d.values[0]];
                return [0x62, data[0], data[1], d.values[0], d.values[1]];
            }
            return [0x7F, sid, 0x11];
        })();
        if (reply) assert.ok(accept(reply), 'the reply must pass the request\'s filter: ' + hex(reply));
        return reply;
    };
    return d;
}

/** A poller on a fake clock with instant sleeps, driven by step(). */
function poller(d, o) {
    const clock = { t: 1000000 };
    const p = new Poller(Object.assign({
        physical: (sid, data, ms, accept) => d.physical(0x12, sid, data, ms, accept), available: () => true, hasLink: () => true, log: quiet,
        sleep: async () => { await new Promise(setImmediate); }, now: () => clock.t,
    }, o || {}, { config: Object.assign({ fuelPollMs: 0 }, o && o.config) }));
    p.clock = clock;
    return p;
}
async function steps(p, n) { for (let i = 0; i < n; i++) await p.step(); return p.state; }

(async () => {
    /* ---------- pure protocol ---------- */
    assert.deepStrictEqual(P.probeRequest().data, [0x04, 0x4D, 0x48, 0x44]);
    assert.ok(P.probeRequest().accept(MHD_MARKER) && P.probeRequest().accept([0x7F, 0x2F, 0x11]));
    assert.ok(!P.probeRequest().accept([0x6F, 0x01, 0x02]), 'another 2F job\'s echo is not the probe\'s answer');
    assert.deepStrictEqual(P.parseProbe(MHD_MARKER), { mhd: true, version: '0120', marker: '4D484432012000000000001C06000042' });
    assert.deepStrictEqual(P.parseProbe([0x7F, 0x2F, 0x11]), { mhd: false, nrc: 0x11, reason: 'service not supported' });
    assert.strictEqual(P.parseProbe(bytes('6F 04 4D 48 44 31')).mhd, false, 'only MHD2 markers count');
    assert.strictEqual(P.parseProbe(null).reason, 'timeout');

    assert.strictEqual(P.findHex(SVK_OWN_F101.slice(3), '00005D55503C05'), 42);
    assert.strictEqual(P.findHex([1, 2, 3], '0203'), 1);
    assert.strictEqual(P.findHex([1, 2, 3], '0204'), -1);
    assert.deepStrictEqual(P.svkIds(SVK_OWN_F101.slice(3)), ['00005D55503C05', '00008417503C1D']);
    const own = P.matchProfile([SVK_OWN_F101.slice(3), SVK_OWN_F102.slice(3)]);
    assert.strictEqual(own.profile.active, 'B00060C2');
    assert.deepStrictEqual(own.seen, ['00005D55503C05', '00008417503C1D', '000099F6144606']);
    assert.strictEqual(P.matchProfile([SVK_OWN_F101.slice(3)]).profile.can, 'B00060D2', 'F1 01 alone carries both ids');
    const other = P.matchProfile([SVK_OTHER_F101.slice(3), null]);
    assert.strictEqual(other.profile, null);
    assert.deepStrictEqual(other.seen, ['00005C64146E06', '00008A51146EAD']);
    assert.strictEqual(P.matchProfile([SVK_OWN_F101.slice(3)], [{ prgid: '00005D55503C05', calid: '0000000000000A', active: 'B00060C2', can: 'B00060D2' }]).profile, null, 'both ids must match');

    assert.strictEqual(hex(P.clearRequest('F304').data), '03 F3 04');
    assert.strictEqual(hex(P.defineRequest('F304', P.PROFILES[0]).data), '02 F3 04 14 B0 00 60 C2 01 B0 00 60 D2 01');
    const accD = P.acceptDefine(0x02, 'F304');
    assert.ok(accD([0x6C, 0x02, 0xF3, 0x04]) && accD([0x7F, 0x2C, 0x31]) && accD([0x6C, 0x02]));
    assert.ok(!accD([0x6C, 0x02, 0xF3, 0x00]), 'MHD\'s own definition is not ours');
    assert.ok(!accD([0x6C, 0x03, 0xF3, 0x04]), 'a clear is not a define');
    assert.deepStrictEqual(P.parseDefine([0x6C, 0x02, 0xF3, 0x04], 0x02), { ok: true });
    assert.strictEqual(P.parseDefine([0x7F, 0x2C, 0x31], 0x03).nrc, 0x31);
    const accR = P.readRequest('F304').accept;
    assert.ok(accR([0x62, 0xF3, 0x04, 12, 12]) && accR([0x7F, 0x22, 0x31]));
    assert.ok(!accR([0x62, 0xF3, 0x00, 1, 2]), 'MHD\'s F300 answer is not ours');
    assert.deepStrictEqual(P.parseRead([0x62, 0xF3, 0x04, 12, 12], 'F304'), { ok: true, active: 12, can: 12 });
    assert.deepStrictEqual(P.parseRead([0x62, 0xF3, 0x04, 255, 0], 'F304'), { ok: true, active: null, can: 0 });
    assert.strictEqual(P.parseRead([0x62, 0xF3, 0x04, 12], 'F304').reason, 'length');
    assert.strictEqual(P.parseRead([0x7F, 0x22, 0x31], 'F304').nrc, 0x31);
    assert.throws(() => P.addressBytes('B00060'), /4 bytes/);

    /* ---------- happy path: MHD on the known ROM ---------- */
    {
        const d = dme('mhd'), p = poller(d);
        assert.strictEqual(await steps(p, 1), 'identifying');
        assert.strictEqual(await steps(p, 1), 'defining');
        assert.strictEqual(await steps(p, 1), 'reading');
        assert.strictEqual(await steps(p, 1), 'reading');
        assert.deepStrictEqual(d.calls, ['2F 04 4D 48 44', '22 F1 01', '22 F1 02', '2C 03 F3 03', '2C 02 F3 03 14 B0 00 60 C2 01 B0 00 60 D2 01', '22 F3 03']);
        let v = p.view();
        assert.strictEqual(v.state, 'reading'); assert.strictEqual(v.active, 85); assert.strictEqual(v.can, 83);
        assert.strictEqual(v.profile, P.PROFILES[0].name);
        assert.strictEqual(v.did, 'F303');
        assert.strictEqual(v.mhd.version, '0120');
        const t = themes.theme('m_tricolour');
        assert.deepStrictEqual(UI.note(v, t), ['Flex fuel active', UI.GO]);
        d.values = [0, 12];
        p.clock.t += 500;                         // the poll interval: nothing goes out before it
        assert.strictEqual((await steps(p, 1), d.calls.length), 7);
        v = p.view();
        assert.deepStrictEqual([v.active, v.can], [0, 12]);
        assert.deepStrictEqual(UI.note(v, t), ['Flex fuel disabled', t.warn], 'Active 0 while the sensor reads ethanol: amber');
        assert.strictEqual(UI.badge(v, t), null, 'no badge while live');
        assert.deepStrictEqual(UI.detail(v, t), { text: 'Sensor reads 12 %', colour: t.warn, literal: false });
        await steps(p, 3);
        assert.strictEqual(d.calls.length, 7, 'reads are paced by pollMs');
        assert.strictEqual(d.maxInflight, 1);

        /* the disagreements between the sensor and the tune */
        const read = async (values) => { d.values = values; p.clock.t += 500; await steps(p, 1); return p.view(); };
        v = await read([0, 0]);
        assert.deepStrictEqual(UI.note(v, t), ['Flex fuel disabled', t.dim], 'Active 0 and no ethanol at the sensor: plain');
        assert.strictEqual(UI.detail(v, t).text, P.PROFILES[0].name + '  ·  F303');
        v = await read([45, 70]);
        assert.deepStrictEqual(UI.note(v, t), ['Flex fuel active', UI.GO]);
        assert.deepStrictEqual(UI.badge(v, t), { text: 'MISMATCH', color: t.warn }, '25 points apart');
        assert.deepStrictEqual(UI.detail(v, t), { text: 'Active and CAN differ', colour: t.warn, literal: false });
        v = await read([70, 61]);
        assert.strictEqual(UI.badge(v, t), null, '9 points apart is not a mismatch');
        assert.ok(UI.detail(v, t).literal, 'the profile line again');
        v = await read([60, 70]);
        assert.strictEqual(UI.badge(v, t).text, 'MISMATCH', 'the gap counts either way');
        v = await read([0, 40]);
        assert.strictEqual(UI.badge(v, t), null, 'Active 0 is "disabled", never a mismatch');
        assert.deepStrictEqual(UI.note(v, t), ['Flex fuel disabled', t.warn]);
        v = await read([0xFF, 70]);
        assert.deepStrictEqual([v.active, v.can], [null, 70]);
        assert.deepStrictEqual(UI.note(v, t), ['Waiting for the DME', t.dim], 'an unreadable Active is not "disabled"');
        assert.strictEqual(UI.badge(v, t), null);
        assert.ok(/^22F303 -> 62F303FF46$/.test(UI.detail(v, t).text), UI.detail(v, t).text);
        v = await read([85, 0xFF]);
        assert.strictEqual(UI.badge(v, t), null, 'an unreadable CAN is not a mismatch');
        assert.deepStrictEqual(UI.note(v, t), ['Flex fuel active', UI.GO]);
        v = await read([85, 83]);
        assert.strictEqual(UI.badge(v, t), null);
        assert.strictEqual(p.state, 'reading');
        v.stale = true; v.can = 20;
        assert.strictEqual(UI.badge(v, t).text, 'LINK STALE', 'stale wins over the mismatch');
    }

    /* ---------- a stock DME: refused, nothing else is sent, probed again after 30 s ---------- */
    {
        const d = dme('stock'), p = poller(d);
        assert.strictEqual(await steps(p, 3), 'no-mhd');
        assert.deepStrictEqual(d.calls, ['2F 04 4D 48 44']);
        assert.ok(UI.note(p.view(), themes.theme('ice'))[0].indexOf('MHD not found') === 0);
        assert.strictEqual(UI.badge(p.view(), themes.theme('ice')).text, 'NO MHD');
        p.clock.t += 29000; await steps(p, 2);
        assert.strictEqual(d.calls.length, 1);
        p.clock.t += 2000; await steps(p, 1);
        assert.deepStrictEqual(d.calls, ['2F 04 4D 48 44', '2F 04 4D 48 44']);
    }

    /* ---------- MHD on another ROM: identified, never defined ---------- */
    {
        const d = dme('other'), p = poller(d);
        assert.strictEqual(await steps(p, 4), 'unsupported-rom');
        assert.deepStrictEqual(d.calls, ['2F 04 4D 48 44', '22 F1 01', '22 F1 02']);
        const v = p.view();
        assert.deepStrictEqual(v.seen, ['00005C64146E06', '00008A51146EAD']);
        assert.strictEqual(UI.badge(v, themes.theme('amber')).text, 'OTHER ROM');
        p.clock.t += 61000; await steps(p, 2);
        assert.strictEqual(d.calls.length, 5, 'identified again after a minute, still no 2C');
    }

    /* ---------- the DME forgets the identifier: defined again, then capped ---------- */
    {
        const d = dme('mhd', { lose: 1 }), p = poller(d);
        await steps(p, 3);                        // probing, identifying, defining -> reading
        assert.strictEqual(await steps(p, 1), 'defining', '7F 22 31 means the identifier is gone');
        p.clock.t += 1000;                        // a second between definitions
        assert.strictEqual(await steps(p, 1), 'reading');
        p.clock.t += 500;
        await steps(p, 1);
        assert.deepStrictEqual(p.view().active, 85);
        assert.strictEqual(d.calls.filter((c) => c.startsWith('2C 02')).length, 2);
    }
    {
        const d = dme('mhd', { lose: 99 }), p = poller(d);
        for (let i = 0; i < 30 && p.state !== 'error'; i++) { await p.step(); p.clock.t += 1000; }
        assert.strictEqual(p.state, 'error', 'a definition that never holds stops in error');
        assert.strictEqual(d.calls.filter((c) => c.startsWith('2C 02')).length, 3, 'redefineLimit');
        assert.strictEqual(UI.badge(p.view(), themes.theme('m_red')).text, 'DME ERROR');
        const probes = d.calls.filter((c) => c.startsWith('2F')).length;
        p.clock.t += 5000; await steps(p, 1);
        assert.strictEqual(p.state, 'identifying', 'after the backoff it starts over with the probe');
        assert.strictEqual(d.calls.filter((c) => c.startsWith('2F')).length, probes + 1);
    }

    /* ---------- the identifiers: F303 refused -> F301; all refused -> error; the car's F304 refusal ---------- */
    {
        const d = dme('mhd', { slots: ['F300', 'F301', 'F302'] }), p = poller(d);
        await steps(p, 2);
        assert.strictEqual(await steps(p, 1), 'defining', 'F303 refused: still defining, with the next identifier');
        assert.strictEqual(p.did, 'F301');
        assert.strictEqual(await steps(p, 1), 'reading');
        assert.deepStrictEqual(d.calls.slice(3), ['2C 03 F3 03', '2C 02 F3 03 14 B0 00 60 C2 01 B0 00 60 D2 01', '2C 03 F3 01', '2C 02 F3 01 14 B0 00 60 C2 01 B0 00 60 D2 01']);
        await steps(p, 1);
        assert.deepStrictEqual([p.view().active, p.view().can, p.view().did], [85, 83, 'F301']);
        assert.strictEqual(d.calls[d.calls.length - 1], '22 F3 01');
    }
    {
        const d = dme('mhd', { slots: ['F300'] }), p = poller(d);
        assert.strictEqual(await steps(p, 4), 'error', 'no identifier taken: error with backoff');
        assert.ok(/out of range \(identifiers F303, F301\)/.test(p.reason), p.reason);
        assert.strictEqual(d.calls.filter((c) => c.startsWith('2C 02')).length, 2);
        p.clock.t += 5000; await steps(p, 2);     // probe, identify: the next definition starts the list over
        assert.strictEqual(p.did, 'F303', 'after the backoff the list starts over');
        assert.strictEqual(d.calls.filter((c) => c.startsWith('2C 02')).length, 2);
    }
    {
        const d = dme('mhd'), p = poller(d, { config: { dynamicDid: 'F304' } });   // the first build on the car
        assert.strictEqual(await steps(p, 3), 'error');
        assert.ok(/definition refused: out of range/.test(p.reason), p.reason);
        assert.ok(/2C02F30414B00060C201B00060D201 -> 7F2C31$/.test(p.view().lastReply), p.view().lastReply);
    }
    {
        const p = poller(dme('mhd'), { config: { dynamicDids: ['f302'], dynamicDid: 'F300' } });
        assert.deepStrictEqual(p.dids, ['F302', 'F300'], 'config: the list first, then the single one, upper case');
    }

    /* ---------- a reply of the wrong length: someone else defined our identifier ---------- */
    {
        const d = dme('mhd', { short: true }), p = poller(d);
        await steps(p, 3);
        assert.strictEqual(await steps(p, 1), 'defining');
        assert.strictEqual(p.view().active, null);
    }

    /* ---------- a quiet DME: probe retries, then error with backoff ---------- */
    {
        const d = dme('quiet'), p = poller(d);
        for (let i = 0; i < 5; i++) { await steps(p, 1); p.clock.t += 2000; }
        assert.strictEqual(p.state, 'error');
        assert.strictEqual(d.calls.length, 5);
        assert.deepStrictEqual(UI.note(p.view(), themes.theme('ice')), ['Waiting for the DME', themes.theme('ice').warn]);
    }

    /* ---------- link states, visibility and demo pause ---------- */
    {
        const d = dme('mhd');
        let link = false, avail = false;
        const p = poller(d, { hasLink: () => link, available: () => avail });
        assert.strictEqual(await steps(p, 2), 'no-link');
        link = true;
        assert.strictEqual(await steps(p, 2), 'link-down');
        avail = true; p.linkChanged(true);
        assert.strictEqual(await steps(p, 3), 'reading');
        p.setVisible(false); p.clock.t += 5000;
        const n = d.calls.length; await steps(p, 3);
        assert.strictEqual(d.calls.length, n, 'hidden: nothing is sent');
        p.setVisible(true); p.setPaused(true); await steps(p, 3);
        assert.strictEqual(d.calls.length, n, 'demo on: nothing is sent');
        p.setPaused(false); await steps(p, 1);
        assert.strictEqual(d.calls.length, n + 1);
        avail = false;
        assert.strictEqual(await steps(p, 1), 'link-down');
        assert.strictEqual(p.view().active, null);
        assert.strictEqual(d.maxInflight, 1);
    }

    /* ---------- pure protocol: the fuel identifiers ---------- */
    assert.deepStrictEqual(P.FUEL, { dmeL: '5949', dmeR: '594A', dmeTotal: '583B', dmeEthanol: '550D' });
    assert.strictEqual(hex(P.fuelDidRequest('5949').data), '59 49');
    assert.ok(P.fuelDidRequest('5949').accept([0x62, 0x59, 0x49, 1]) && !P.fuelDidRequest('5949').accept([0x62, 0x59, 0x4A, 1]));
    assert.deepStrictEqual(P.parseFuelDid([0x62, 0x59, 0x49, 49], '5949'), { ok: true, raw: 49, value: 24.5, litres: 24.5 });
    assert.deepStrictEqual(P.parseFuelDid([0x62, 0x58, 0x3B, 24], '583B'), { ok: true, raw: 24, value: 24, litres: 24 });
    assert.ok(Math.abs(P.parseFuelDid([0x62, 0x55, 0x0D, 32], '550D').value - 12.549) < 0.001, '550D is 100/255 % per count');
    assert.strictEqual(P.parseFuelDid([0x62, 0x55, 0x0D, 255], '550D').reason, 'no data');
    assert.strictEqual(P.parseFuelDid([0x62, 0x59, 0x49, 0xFF], '5949').reason, 'no data');
    assert.strictEqual(P.parseFuelDid([0x62, 0x59, 0x49, 1, 2], '5949').reason, 'length');
    assert.deepStrictEqual(P.parseFuelDid([0x7F, 0x22, 0x31], '5949'), { ok: false, nrc: 0x31, reason: 'out of range' });
    assert.strictEqual(P.parseFuelDid(null, '5949').reason, 'timeout');
    assert.strictEqual(P.obdRequest, undefined, 'the OBD fuel level was dropped in 1.2.1: it tracks the range on the car');

    /* ---------- the fuel sources between the MHD steps ---------- */
    {
        const until = async (p, state, max) => { for (let i = 0; i < (max || 40) && p.state !== state; i++) await p.step(); return p.state; };
        const fuelCalls = (d) => d.calls.filter((c) => /^22 59 49|^22 59 4A|^22 58 3B|^22 55 0D/.test(c));
        // the owner's DME: the four identifiers answer in the first round, the MHD steps go on to reading, one request at a time
        let d = dme('mhd');
        let p = poller(d, { config: { fuelPollMs: 10000 } });
        assert.strictEqual(await until(p, 'reading'), 'reading');
        assert.deepStrictEqual(fuelCalls(d), ['22 59 49', '22 59 4A', '22 58 3B', '22 55 0D']);
        let f = p.view().fuel;
        assert.strictEqual(f.dme, 48.5);
        assert.deepStrictEqual([f.dmeL.value, f.dmeR.value, f.dmeTotal.value, f.dmeL.fresh, f.dmeTotal.fresh, f.dmeEthanol.fresh], [24.5, 24, 48, true, true, true]);
        assert.ok(Math.abs(f.dmeEthanol.value - 12.549) < 0.001);
        assert.ok(!d.calls.some((c) => c.indexOf('01 ') === 0), 'no OBD request');
        assert.strictEqual(d.maxInflight, 1);
        // no second round before fuelPollMs; then one, while the ethanol reads go on
        const n = fuelCalls(d).length, reads = d.calls.filter((c) => c === '22 F3 03').length;
        await steps(p, 4);
        assert.strictEqual(fuelCalls(d).length, n);
        p.clock.t += 10000; await steps(p, 6);
        assert.strictEqual(fuelCalls(d).length, n + 4);
        assert.ok(d.calls.filter((c) => c === '22 F3 03').length > reads, 'the ethanol is still read');
        assert.strictEqual(p.state, 'reading');
        // stale after 60 s without a round (hidden, say), fresh again after one
        p.setVisible(false); p.clock.t += 61000; await steps(p, 3);
        assert.strictEqual(p.view().fuel.dme, null);
        assert.strictEqual(p.view().fuel.dmeL.fresh, false);
        p.setVisible(true); await steps(p, 5);
        assert.strictEqual(p.view().fuel.dme, 48.5);
        // demo (paused): nothing is asked
        d = dme('mhd'); p = poller(d, { config: { fuelPollMs: 10000 } });
        p.setPaused(true); await steps(p, 6);
        assert.strictEqual(d.calls.length, 0);
        // fuelPollMs 0: never asked
        d = dme('mhd'); p = poller(d, { config: { fuelPollMs: 0 } });
        await until(p, 'reading'); await steps(p, 4);
        assert.strictEqual(fuelCalls(d).length, 0);
        // a stock DME (no MHD) still has the fuel identifiers
        d = dme('stock'); p = poller(d, { config: { fuelPollMs: 10000 } });
        assert.strictEqual(await until(p, 'no-mhd'), 'no-mhd');
        await steps(p, 4);
        assert.strictEqual(p.view().fuel.dme, 48.5);
        assert.strictEqual(p.view().fuel.dmeTotal.value, 48);
        // a DME without the halves: those go off (refused), the total stays; asked again after 5 min
        d = dme('mhd', { noHalves: true }); p = poller(d, { config: { fuelPollMs: 10000 } });
        await until(p, 'reading'); await steps(p, 4);
        f = p.view().fuel;
        assert.deepStrictEqual([f.dme, f.dmeL.off, f.dmeR.off, f.dmeTotal.value, f.dmeTotal.off], [null, true, true, 48, false]);
        let k = fuelCalls(d).length;
        p.clock.t += 10000; await steps(p, 4);
        assert.strictEqual(fuelCalls(d).length, k + 2, 'only the total and 550D are asked while the halves are off');
        p.clock.t += 300000; await steps(p, 6);
        assert.ok(d.calls.slice(-6).indexOf('22 59 49') >= 0, 'the halves are tried again after the pause');
        // the median of the last 3 reads of a half hides one odd value
        d = dme('mhd', { fuel: { L: [49, 60, 49, 49] } }); p = poller(d, { config: { fuelPollMs: 10000 } });
        await until(p, 'reading'); await steps(p, 4);
        assert.strictEqual(p.view().fuel.dmeL.value, 24.5);
        p.clock.t += 10000; await steps(p, 6);
        assert.strictEqual(p.view().fuel.dmeL.value, 27.25, 'two reads: the mean of both');
        p.clock.t += 10000; await steps(p, 6);
        assert.strictEqual(p.view().fuel.dmeL.value, 24.5, 'three reads: the median');
        assert.strictEqual(p.view().fuel.dme, 48.5);
        // a DME quiet on the fuel identifiers: off after 3 misses each, the MHD side unaffected
        d = dme('mhd', { fuelQuiet: true }); p = poller(d, { config: { fuelPollMs: 10000 } });
        await until(p, 'reading');
        for (let i = 0; i < 3; i++) { p.clock.t += 10000; await steps(p, 6); }
        f = p.view().fuel;
        assert.deepStrictEqual([f.dmeL.off, f.dmeR.off, f.dmeTotal.off, f.dmeEthanol.off, p.state], [true, true, true, true, 'reading']);
        // MHD on another ROM: no ethanol identifier, but the DME's own alcohol percentage is read all the same
        d = dme('other'); p = poller(d, { config: { fuelPollMs: 10000 } });
        assert.strictEqual(await until(p, 'unsupported-rom'), 'unsupported-rom');
        await steps(p, 5);
        assert.ok(Math.abs(p.view().fuel.dmeEthanol.value - 12.549) < 0.001);
        assert.strictEqual(p.view().active, null);
        // a DME that refuses 550D: off, the rest unaffected
        d = dme('mhd', { ethanol: false }); p = poller(d, { config: { fuelPollMs: 10000 } });
        await until(p, 'reading'); await steps(p, 5);
        assert.deepStrictEqual([p.view().fuel.dmeEthanol.off, p.view().fuel.dmeEthanol.value, p.view().fuel.dme], [true, null, 48.5]);
        assert.strictEqual(f.dme, null);
    }

    /* ---------- the blend calculator ---------- */
    {
        const b = (litres, can, target, purity, tank) => C.blend({ litres, can, target, purity, tank });
        // the user's example: 6.5 l at 12 % to E65 - with pure ethanol, with the default 99 %, and with E85
        assert.deepStrictEqual(b(6.5, 12, 65, 100, 60), { status: 'ok', litres: 9.8, gallons: 2.6, totalLitres: 16.3, overflowLitres: 0 });
        assert.deepStrictEqual(b(6.5, 12, 65, 99, 60), { status: 'ok', litres: 10.1, gallons: 2.7, totalLitres: 16.6, overflowLitres: 0 });
        assert.deepStrictEqual(b(6.5, 12, 65, 85, 60), { status: 'ok', litres: 17.2, gallons: 4.6, totalLitres: 23.7, overflowLitres: 0 });
        // 1.7 gal is 6.4 l: the dial's gallons round-trip
        assert.strictEqual(C.round1(C.toGallons(6.5)), 1.7);
        assert.strictEqual(Math.abs(C.GAL - 3.7854) < 0.001, true);
        // what cannot be computed, in the order the screen reports it
        assert.strictEqual(b(null, 12, 65, 99, 60).status, 'no-fuel');
        assert.strictEqual(b(0, 12, 65, 99, 60).status, 'no-fuel');
        assert.strictEqual(b(NaN, 12, 65, 99, 60).status, 'no-fuel');
        assert.strictEqual(b(6.5, null, 65, 99, 60).status, 'no-ethanol');
        assert.strictEqual(b(6.5, 70, 65, 99, 60).status, 'reached');
        assert.strictEqual(b(6.5, 65, 65, 99, 60).status, 'reached');
        assert.strictEqual(b(6.5, 12, 65, 60, 60).status, 'purity');
        assert.strictEqual(b(6.5, 12, 65, 65, 60).status, 'purity');
        assert.strictEqual(b(6.5, null, 65, 99, 60).litres, null);
        // more than the tank takes: 50 l of E10 to E85 needs 250 l of ethanol
        assert.deepStrictEqual(b(50, 10, 85, 100, 60), { status: 'ok', litres: 250, gallons: 66, totalLitres: 300, overflowLitres: 240 });
        assert.strictEqual(b(50, 10, 85, 100, null).overflowLitres, 0);     // no capacity known: no warning
        // the source the dial uses: the finest there is, or the one the setting names
        const all = { dme: 48.5, kombi: 48 };
        assert.deepStrictEqual(C.pickFuel(all, 'auto'), { litres: 48.5, source: 'dme' });
        assert.deepStrictEqual(C.pickFuel({ kombi: 48 }, 'auto'), { litres: 48, source: 'kombi' });
        assert.deepStrictEqual(C.pickFuel(all, 'kombi'), { litres: 48, source: 'kombi' });
        assert.deepStrictEqual(C.pickFuel({ kombi: 48 }, 'dme'), { litres: null, source: null });
        assert.deepStrictEqual(C.pickFuel(all, 'obd'), { litres: 48.5, source: 'dme' });        // a value saved by 1.2.0: as auto
        assert.deepStrictEqual(C.pickFuel(null, 'auto'), { litres: null, source: null });
        assert.deepStrictEqual(C.pickFuel(all, undefined), { litres: 48.5, source: 'dme' });   // no setting yet: auto
    }

    /* ---------- the screen in every state, software and GPU ---------- */
    const states = ['no-link', 'link-down', 'probing', 'no-mhd', 'identifying', 'unsupported-rom', 'defining', 'reading', 'error'];
    for (const name of Object.keys(themes.themes || { m_tricolour: 1, m_red: 1, ice: 1, amber: 1 })) {
        const t = themes.theme(name);
        for (const state of states) {
            const v = { state, active: state === 'reading' ? 12 : null, can: state === 'reading' ? 12 : null, stale: false,
                seen: ['00005C64146E06'], mhd: { version: '0120' }, profile: P.PROFILES[0].name, demo: false,
                fuel: state === 'reading' ? 24.6 : null, target: 85, purity: 99, tankCap: 60 };
            const r = new Recorder(UI.W, UI.H);
            UI.draw(r, G, t, v, LOGO);
            play(r.words(), new Canvas(UI.W, UI.H));      // the software path: the recording played into a canvas
        }
        UI.draw(new Recorder(UI.W, UI.H), G, t, { state: 'reading', active: 70, can: 72, demo: true }, LOGO);   // (no settings in the view: the defaults)
        [[45, 70, 24.6], [0, 12, 24.6], [null, 70, 24.6], [85, null, 24.6], [12, 12, null], [12, 12, 50]].forEach(([active, can, fuel]) => {
            const r = new Recorder(UI.W, UI.H);
            UI.draw(r, G, t, { state: 'reading', active, can, fuel, target: 85, purity: 99, tankCap: 60, stale: false, mhd: { version: '0120' }, profile: P.PROFILES[0].name, did: 'F303', lastReply: '22F303 -> 62F303FF46', demo: false }, LOGO);
            play(r.words(), new Canvas(UI.W, UI.H));
        });
    }

    /* ---------- the calculator's rows and the target buttons ---------- */
    {
        const t = themes.theme('m_tricolour');
        const v = { state: 'reading', active: 12, can: 12, fuel: 6.5, target: 65, purity: 99, tankCap: 60, stale: false, demo: false };
        assert.strictEqual(UI.fuelLine(v), '(6.5 L)');
        assert.strictEqual(UI.fuelLine({ fuel: null }), '--');
        assert.strictEqual(UI.fuelLine({ fuel: 24.5, fuelSource: 'dme' }), '(24.5 L \u00b7 DME)');
        assert.strictEqual(UI.fuelLine({ fuel: 24, fuelSource: 'kombi' }), '(24.0 L \u00b7 Kombi)');
        assert.strictEqual(UI.fuelLine({ fuel: 24.6, fuelSource: 'demo' }), '(24.6 L)');
        const all = { kombi: 24, kombiL: 12, kombiR: 12, dme: 24.5, dmeL: 12, dmeR: 12.5, dmeTotal: 24, dmeEthanol: 12.549 };
        assert.strictEqual(UI.sourcesLine({ fuelAll: all }), 'Kombi 24 L (L 12 R 12)   \u00b7   DME 12.0 + 12.5 = 24.5 L (583B 24 L)   \u00b7   DME alcohol 12.5 %');
        assert.strictEqual(UI.sourcesLine({ fuelAll: {} }), 'Kombi -- L (L -- R --)   \u00b7   DME -- + -- = -- L (583B -- L)   \u00b7   DME alcohol -- %');
        // without a profile the detail line carries the ids and the DME's alcohol percentage; the Active dial can show it
        const rom = { state: 'unsupported-rom', active: null, can: null, seen: ['00005D5550480C', '0000841750486D'], demo: false };
        assert.strictEqual(UI.detail(rom, t).text, '00005D5550480C  0000841750486D');
        assert.deepStrictEqual(UI.detail(Object.assign({}, rom, { fuelAll: all }), t), { text: '00005D5550480C  0000841750486D   \u00b7   DME alcohol 12.5 %', colour: t.dim, literal: true });
        [['mhd', 12], ['dme', 13]].forEach(([src, active]) => {
            const r = new Recorder(UI.W, UI.H);
            UI.draw(r, G, t, Object.assign({}, rom, { active, activeSource: src, fuelAll: all, showSources: true }), LOGO);
            play(r.words(), new Canvas(UI.W, UI.H));
        });
        assert.strictEqual(UI.sourcesLine({}), UI.sourcesLine({ fuelAll: {} }));
        [[all, true], [{}, true], [all, false]].forEach(([fa, show]) => {
            const r = new Recorder(UI.W, UI.H);
            UI.draw(r, G, t, Object.assign({}, v, { fuelAll: fa, showSources: show, fuelSource: 'dme' }), LOGO);
            play(r.words(), new Canvas(UI.W, UI.H));
        });
        assert.deepStrictEqual(UI.inputs({}), { litres: null, can: null, target: 85, purity: 99, tank: 60 });   // a view without the settings
        let r = UI.result(v, t);
        assert.deepStrictEqual(r, { text: '2.7 gal (10.1 L)', colour: t.accent, literal: true, detail: { text: 'Purity 99 %   ·   Tank after 16.6 / 60 L', colour: t.dim } });
        r = UI.result(Object.assign({}, v, { fuel: null }), t);
        assert.deepStrictEqual([r.text, r.colour, r.literal, r.detail.text], ['No fuel reading', t.dim, false, 'Purity 99 %']);
        assert.strictEqual(UI.result(Object.assign({}, v, { can: null }), t).text, 'No ethanol reading');
        assert.strictEqual(UI.result(Object.assign({}, v, { can: 70 }), t).text, 'Target reached');
        r = UI.result(Object.assign({}, v, { purity: 60 }), t);
        assert.deepStrictEqual([r.text, r.colour], ['Purity below target', t.warn]);
        r = UI.result(Object.assign({}, v, { fuel: 50, can: 10, target: 85, purity: 100 }), t);
        assert.deepStrictEqual([r.text, r.detail], ['66.0 gal (250.0 L)', { text: 'Exceeds tank capacity (+240.0 L)', colour: t.warn }]);
        // the buttons: targets on a page the kit runs (cv.own), none elsewhere; they move the target by 5
        let got = null;
        const own = new Recorder(UI.W, UI.H);
        own.own = true;
        UI.draw(own, G, t, Object.assign({}, v, { setTarget: (d) => { got = d; } }), LOGO);
        assert.deepStrictEqual(own.targets.map((q) => q.key).sort(), ['target+5', 'target-5']);
        own.targets.find((q) => q.key === 'target+5').run();
        assert.strictEqual(got, UI.TARGET_STEP);
        own.targets.find((q) => q.key === 'target-5').run();
        assert.strictEqual(got, -UI.TARGET_STEP);
        play(own.words(), new Canvas(UI.W, UI.H));
        const hmi = new Recorder(UI.W, UI.H);
        UI.draw(hmi, G, t, v, LOGO);
        assert.strictEqual(hmi.targets.length, 0);
        UI.draw(new Recorder(UI.W, UI.H), G, t, Object.assign({}, v, { setTarget: undefined }), LOGO);   // no handler: the buttons still draw
    }
    assert.ok(LOGO.w === 180 && LOGO.h > 40 && LOGO.runs.length > 100 && LOGO.palette.every((c) => /^#[0-9a-f]{8}$/.test(c)));

    /* ---------- main.js with the kit stubbed: no transport -> demo, one frame drawn ---------- */
    const mainMod = require(path.join(app, 'main'));
    assert.ok(mguApp && typeof mguApp.start === 'function');
    const vals = { theme: 'm_tricolour', layout: 'full', renderer: 'auto', demo: 'auto', target: 85, purity: 99, tank: 60, fuelSource: 'auto', fuelSources: false, ethanolSource: 'mhd' };
    let frames = 0, loopFn = null, last = null, watched = null, kicks = 0;
    const changes = [], sets = [];
    const ctx = {
        ui: { image: async () => { frames++; }, onVisible() {}, isVisible: () => true, onClick() {}, text() {} },
        settings: { get: (k) => vals[k], set: (k, v) => { vals[k] = v; sets.push([k, v]); changes.forEach((fn) => fn(k, v)); }, onChange: (fn) => changes.push(fn) },
        log: quiet,
        spec: { config: { dynamicDids: ['F303', 'F301'], pollMs: 500 } },
        signals: {
            proxy: async () => { throw new Error('preview'); },
            watch: async (iface, inst, handlers, log, opts) => { watched = { iface, inst, handlers, opts }; return { iface, available: false, error: 'stub', shutdown: () => Promise.resolve() }; },
        },
        theme: () => themes.theme(vals.theme),
        canvas: (w, h) => { last = new Recorder(w, h); last.own = true; return last; },
        loop: (name, fps, fn) => { loopFn = fn; return { stop() {}, kick() { kicks++; } }; },
        onTab() {}, hideButton() {},
    };
    await mguApp.start(ctx);
    assert.strictEqual(frames, 1);
    await loopFn();
    assert.strictEqual(frames, 2);
    // the cluster's fuel level is watched as the Live Data app does it
    assert.ok(watched && watched.iface === 'de.bmw.infotainment.KombiIF' && watched.inst === '1' && typeof watched.handlers.statusRangeTankStatus === 'function');
    assert.deepStrictEqual(watched.opts, { pollMs: 10000 });
    // the page's buttons move the target setting by 5 within 10..100 (the setting's steps)
    const press = (key) => last.targets.find((q) => q.key === key).run();
    press('target+5');
    assert.strictEqual(vals.target, 90);
    assert.strictEqual(sets.length, 1);
    vals.target = 100; press('target+5'); assert.strictEqual(vals.target, 100);
    vals.target = 10; press('target-5'); assert.strictEqual(vals.target, 10);
    vals.target = 'bad'; press('target+5'); assert.strictEqual(vals.target, 90);    // a value that is not a number: from the default
    assert.ok(kicks >= 4, 'a change of setting redraws');
    // the fuel reading: litres as sent, 255 is no data; the demo supplies its own while demo is on
    vals.demo = 'off';
    watched.handlers.statusRangeTankStatus({ fluidLevelFuelTank: 24 });
    await loopFn();
    assert.ok(last.words().length > 0);
    watched.handlers.statusRangeTankStatus({ fluidLevelFuelTank: 255 });
    await loopFn();
    watched.handlers.statusRangeTankStatus({});
    watched.handlers.statusRangeTankStatus(null);
    await loopFn();
    assert.strictEqual(frames, 5);
    // the sources line, with the cluster's halves as sent, in every fuel source mode and in demo
    watched.handlers.statusRangeTankStatus({ fluidLevelFuelTank: 24, fluidLevelFuelTankLeftHand: 12, fluidLevelFuelTankRightHand: 12 });
    vals.fuelSources = true;
    for (const mode of ['auto', 'dme', 'kombi']) { vals.fuelSource = mode; await loopFn(); }
    vals.ethanolSource = 'dme'; await loopFn();          // the Active dial from 550D (nothing read here: '--')
    vals.demo = 'on'; await loopFn();
    assert.strictEqual(frames, 10);
    assert.deepStrictEqual(mainMod.demoFuelAll(24.6, 70), { kombi: 25, kombiL: 12, kombiR: 13, dme: 24.5, dmeL: 12.3, dmeR: 12.3, dmeTotal: 25, dmeEthanol: 69 });
    assert.strictEqual(mainMod.demoFuelAll(24.6, null).dmeEthanol, null);
    vals.ethanolSource = 'mhd';
    assert.strictEqual(typeof mainMod.demoValues(0).fuel, 'number');
    vals.fuelSources = false; vals.fuelSource = 'auto';
    vals.demo = 'auto';
    await new Promise((r) => setTimeout(r, 30));     // the poller's loop idles in no-link without throwing
    console.log('Flex Fuel checks passed (protocol, poller states, filters, calculator, screen, main).');
    process.exit(0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
