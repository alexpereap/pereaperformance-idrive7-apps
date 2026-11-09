'use strict';
/**
 * poller.js - reads the two ethanol bytes from an MHD-flashed DME, one request at a time, and
 * keeps a state the screen can show:
 *
 *   no-link          no diagnostic transport at all (the emulator; the proxy not up yet)
 *   link-down        the transport is there but not available (car asleep)
 *   probing          2F 04 "MHD" is out
 *   no-mhd           the DME refused the probe: no MHD on it (probed again every 30 s)
 *   identifying      22 F1 01 / F1 02 are out
 *   unsupported-rom  MHD is there but no profile has this ROM's addresses (checked again every 60 s)
 *   defining         2C 03 / 2C 02 <did> are out: the first identifier of `dynamicDids` the DME takes
 *                    (F303, then F301: this DME has F300..F303 only and answered 7F 2C 31 to F304)
 *   reading          22 <did> every pollMs; the values are live
 *   error            something refused or went quiet: backoff 5 s, 10 s, 20 s, 30 s, then probe again
 *
 * Fuel in the tank: between the steps above, once every `fuelPollMs` (10 s; 0 turns it off) and in every
 * state where the DME can answer (not no-link / link-down, never while paused or hidden), one round of the
 * standard identifiers any DME has: 22 5949 and 22 594A (the two tank halves, 0.5 l each; the dial takes the
 * median of the last 3 of each) and 22 583B (the whole tank, litres). A source the DME refuses, or that
 * misses FUEL_MISSES answers in a row, is left alone for FUEL_RETRY_MS. (The OBD fuel level, 01 2F, was tried
 * in 1.2.0 and dropped: on the car it tracks the range, not the fuel.)
 *
 * Everything the loop sends comes from protocol.js; `physical(sid, data, timeoutMs, accept)` is the
 * transport (kit/diag.js Diag.physical bound to the DME), `available()` says whether it is up and
 * `hasLink()` whether it exists at all. `sleep` and `now` are injectable so tests run on a fake
 * clock, driving step() by hand instead of start().
 */
const P = require('./protocol');

const DEFAULTS = { dynamicDids: ['F303', 'F301'], pollMs: 500, readTimeoutMs: 1500, probeTimeoutMs: 3000, redefineLimit: 3, fuelPollMs: 10000 };
const RETRY_NO_MHD_MS = 30000, RETRY_ROM_MS = 60000, PROBE_RETRY_MS = 2000, PROBE_FAILS = 5;
const STALE_MISSES = 3, GIVE_UP_MISSES = 10, SLOW_POLL_MS = 1000, REDEFINE_GAP_MS = 1000;
const BACKOFF_MS = 5000, BACKOFF_MAX_MS = 30000;
const FUEL_KEYS = ['dmeL', 'dmeR', 'dmeTotal'], FUEL_MEDIAN = ['dmeL', 'dmeR'];
const FUEL_RETRY_MS = 300000, FUEL_MISSES = 3, FUEL_LOG_MS = 60000, FUEL_STALE_MS = 60000, MEDIAN_N = 3;

/** The median of a few numbers (the mean of the two middle ones when there is an even count). */
function median(a) {
    const s = a.slice().sort((x, y) => x - y), n = s.length;
    if (!n) return null;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
const round1 = (x) => Math.round(x * 10) / 10;

class Poller {
    constructor(o) {
        this.physical = o.physical;
        this.available = o.available || (() => true);
        this.hasLink = o.hasLink || (() => true);
        this.log = o.log || { info() {}, warn() {}, error() {} };
        this.cfg = Object.assign({}, DEFAULTS, o.config || {});
        this.profiles = o.profiles || P.PROFILES;
        this.sleep = o.sleep || ((ms) => new Promise((r) => { this._wake = r; setTimeout(r, ms); }));
        this.now = o.now || (() => Date.now());
        // the identifiers to try, in order (config `dynamicDids`; a single `dynamicDid` is honoured too)
        const given = o.config || {};
        const list = [].concat(given.dynamicDids || [], given.dynamicDid || []).map((d) => String(d).toUpperCase());
        this.dids = list.length ? list : DEFAULTS.dynamicDids.slice();
        this.didIndex = 0;
        this.visible = true;
        this.paused = false;        // demo data on: nothing is sent
        this.running = false;
        this.busy = false;
        this.state = 'no-link';
        this.reason = '';           // why the state is what it is (log / screen)
        this.active = null; this.can = null;
        this.lastGood = 0;
        this.mhd = null;            // { version, marker } once detected
        this.profile = null;
        this.seen = [];             // SVK ids found on an unsupported ROM
        this.nextAt = 0;            // the earliest time the next request may go
        this.misses = 0;            // reads in a row without an answer
        this.probeFails = 0;
        this.errors = 0;            // backoff steps
        this.redefines = 0;         // definitions since the last good read
        this.definedAt = 0;
        this.lastReply = '';        // the last reply's bytes (hex), for the screen while values are not readable
        this._wake = null;
        // the fuel sources: value (litres), when, the raw byte, the last 3 values (the median for the halves),
        // misses in a row, off (refused or quiet: left alone until `next`), the last exchange's bytes, seen (logged once)
        this.fuel = {};
        FUEL_KEYS.forEach((k) => { this.fuel[k] = { value: null, at: 0, raw: null, hist: [], misses: 0, off: false, next: 0, lastReply: '', seen: false }; });
        this.fuelQueue = [];        // the sources still to ask in this round
        this.fuelNextAt = 0;        // when the next round starts
        this.fuelLogAt = 0;
    }

    /** The loop: one step after another until stop(). Never throws. */
    start() {
        if (this.running) return;
        this.running = true;
        const run = async () => {
            while (this.running) {
                try { await this.step(); } catch (e) { this.log.error('perea_mhd_flex: ' + String(e && e.stack || e)); await this.sleep(1000); }
            }
        };
        run();
    }
    stop() { this.running = false; this.wake(); }
    wake() { const w = this._wake; this._wake = null; if (w) w(); }
    linkChanged(on) { if (on && this.state === 'link-down') this.nextAt = 0; this.wake(); }
    setVisible(on) { this.visible = !!on; this.wake(); }
    setPaused(on) { this.paused = !!on; this.wake(); }

    get did() { return this.dids[this.didIndex]; }

    _set(state, reason) {
        if (state !== this.state) this.log.info('perea_mhd_flex: ' + this.state + ' -> ' + state + (reason ? ' (' + reason + ')' : ''));
        this.state = state;
        this.reason = reason || '';
        if (state !== 'reading') { this.active = null; this.can = null; }
    }

    /** One request (or one wait). Returns the state afterwards. */
    async step() {
        if (this.busy) return this.state;
        if (!this.hasLink()) { this._set('no-link', 'no diagnostic transport'); await this.sleep(500); return this.state; }
        if (!this.available()) { this._set('link-down', 'transport not available'); await this.sleep(250); return this.state; }
        if (this.paused || !this.visible) { await this.sleep(250); return this.state; }
        const now = this.now();
        // the fuel sources, one request per step, between the MHD steps (the DME answers them with or without MHD)
        if (this.cfg.fuelPollMs > 0 && this.state !== 'no-link' && this.state !== 'link-down' && now >= this.fuelNextAt) {
            this.busy = true;
            try { await this._fuelStep(now); } finally { this.busy = false; }
            return this.state;
        }
        if (now < this.nextAt) { await this.sleep(Math.min(250, this.nextAt - now)); return this.state; }
        this.busy = true;
        try {
            switch (this.state) {
                case 'no-link': case 'link-down': case 'error': case 'no-mhd':
                    this._set('probing'); await this._probe(); break;
                case 'probing': await this._probe(); break;
                case 'unsupported-rom': this._set('identifying'); await this._identify(); break;
                case 'identifying': await this._identify(); break;
                case 'defining': await this._define(); break;
                case 'reading': await this._read(); break;
                default: this._set('probing');
            }
        } finally { this.busy = false; }
        return this.state;
    }

    async _send(req, timeoutMs) {
        const reply = await this.physical(req.sid, req.data, timeoutMs, req.accept);
        this.lastReply = P.bytesHex([req.sid].concat(req.data)) + ' -> ' + (reply && reply.length ? P.bytesHex(reply) : 'no answer');
        return reply;
    }

    _fail(reason) {
        this.errors++;
        const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * Math.pow(2, this.errors - 1));
        this.nextAt = this.now() + wait;
        this._set('error', reason);
        this.log.warn('perea_mhd_flex: ' + reason + ', next try in ' + Math.round(wait / 1000) + ' s');
    }

    async _probe() {
        const r = P.parseProbe(await this._send(P.probeRequest(), this.cfg.probeTimeoutMs));
        if (r.mhd) {
            this.mhd = { version: r.version, marker: r.marker };
            this.probeFails = 0;
            this._set('identifying', 'MHD marker ' + r.marker);
            return;
        }
        if (r.nrc != null) {
            this.nextAt = this.now() + RETRY_NO_MHD_MS;
            this._set('no-mhd', 'DME refused the MHD probe (' + r.reason + ')');
            return;
        }
        this.probeFails++;
        if (this.probeFails >= PROBE_FAILS) { this.probeFails = 0; this._fail('no answer to the MHD probe'); return; }
        this.nextAt = this.now() + PROBE_RETRY_MS;
        this.reason = r.reason;
    }

    async _identify() {
        const a = P.svkData(await this._send(P.svkRequest(0x01), this.cfg.readTimeoutMs), 0x01);
        const b = P.svkData(await this._send(P.svkRequest(0x02), this.cfg.readTimeoutMs), 0x02);
        if (!a && !b) { this._fail('no answer to the identification'); return; }
        const m = P.matchProfile([a, b], this.profiles);
        this.seen = m.seen;
        if (!m.profile) {
            this.nextAt = this.now() + RETRY_ROM_MS;
            this._set('unsupported-rom', 'ids ' + m.seen.join(', '));
            return;
        }
        this.profile = m.profile;
        this._set('defining', m.profile.name);
    }

    async _define() {
        if (this.redefines >= this.cfg.redefineLimit) { this.redefines = 0; this._fail('the definition keeps getting lost'); return; }
        const clear = P.parseDefine(await this._send(P.clearRequest(this.did), this.cfg.readTimeoutMs), 0x03);
        if (!clear.ok && clear.nrc == null) { this._fail('no answer to the clear'); return; }    // a refusal (nothing defined) is fine
        const def = P.parseDefine(await this._send(P.defineRequest(this.did, this.profile), this.cfg.readTimeoutMs), 0x02);
        if (!def.ok && def.nrc === 0x31 && this.didIndex + 1 < this.dids.length) {
            // this DME has no such identifier: the next candidate, right away
            this.log.info('mhd_flex: identifier ' + this.did + ' refused (out of range), trying ' + this.dids[this.didIndex + 1]);
            this.didIndex++;
            this.reason = 'identifier ' + this.dids[this.didIndex - 1] + ' refused, trying ' + this.did;
            return;
        }
        if (!def.ok) {
            const tried = this.dids.slice(0, this.didIndex + 1).join(', ');
            this.didIndex = 0;
            this._fail('definition refused: ' + def.reason + (def.nrc === 0x31 ? ' (identifiers ' + tried + ')' : ''));
            return;
        }
        this.redefines++;
        this.definedAt = this.now();
        this.misses = 0;
        this._set('reading', 'identifier ' + this.did + ' defined');
    }

    async _read() {
        const r = P.parseRead(await this._send(P.readRequest(this.did), this.cfg.readTimeoutMs), this.did);
        const now = this.now();
        if (r.ok) {
            this.active = r.active; this.can = r.can;
            this.lastGood = now; this.misses = 0; this.redefines = 0; this.errors = 0;
            this.nextAt = now + this.cfg.pollMs;
            return;
        }
        if (r.reason === 'timeout') {
            this.misses++;
            if (this.misses >= GIVE_UP_MISSES) { this.misses = 0; this._set('probing', 'the DME went quiet'); return; }
            this.nextAt = now + (this.misses >= STALE_MISSES ? SLOW_POLL_MS : this.cfg.pollMs);
            return;
        }
        if (r.nrc === 0x31 || r.reason === 'length') {
            // the DME forgot our identifier (ignition cycle, MHD's own session), or someone else defined it
            this.nextAt = Math.max(now, this.definedAt + REDEFINE_GAP_MS);
            this._set('defining', 'identifier lost (' + r.reason + ')');
            return;
        }
        this._fail('read refused: ' + r.reason);
    }

    /** One fuel request: the next source of the round; the round over, the next one starts in fuelPollMs. */
    async _fuelStep(now) {
        if (!this.fuelQueue.length) {
            this.fuelQueue = FUEL_KEYS.filter((k) => !this.fuel[k].off || now >= this.fuel[k].next);
            if (!this.fuelQueue.length) { this.fuelNextAt = now + this.cfg.fuelPollMs; return; }
        }
        const key = this.fuelQueue.shift(), f = this.fuel[key];
        if (f.off) { f.off = false; f.misses = 0; }           // the pause is over: try again
        const did = P.FUEL[key], req = P.fuelDidRequest(did);
        const reply = await this.physical(req.sid, req.data, this.cfg.readTimeoutMs, req.accept);
        f.lastReply = P.bytesHex([req.sid].concat(req.data)) + ' -> ' + (reply && reply.length ? P.bytesHex(reply) : 'no answer');
        const r = P.parseFuelDid(reply, did);
        if (r.ok) {
            const v = r.litres;
            f.hist.push(v);
            if (f.hist.length > MEDIAN_N) f.hist.shift();
            f.value = FUEL_MEDIAN.indexOf(key) >= 0 ? median(f.hist) : v;
            f.raw = r.raw; f.at = now; f.misses = 0;
            if (!f.seen) { f.seen = true; this.log.info('perea_mhd_flex: fuel ' + key + ' ' + f.lastReply + ' = ' + v + ' l'); }
        } else if (r.reason === 'timeout') {
            if (++f.misses >= FUEL_MISSES) this._fuelOff(key, now, 'no answer');
        } else {
            this._fuelOff(key, now, r.reason);
        }
        if (!this.fuelQueue.length) {
            this.fuelNextAt = now + this.cfg.fuelPollMs;
            if (now - this.fuelLogAt >= FUEL_LOG_MS) {
                this.fuelLogAt = now;
                this.log.info('perea_mhd_flex: fuel ' + FUEL_KEYS.map((k) => k + '=' + (this.fuel[k].off ? 'off' : this.fuel[k].value == null ? '--' : this.fuel[k].value) + ' [' + this.fuel[k].lastReply + ']').join('  '));
            }
        }
    }

    /** A fuel source the DME refuses or does not answer: nothing from it, asked again after FUEL_RETRY_MS. */
    _fuelOff(key, now, why) {
        const f = this.fuel[key];
        f.off = true; f.next = now + FUEL_RETRY_MS; f.value = null; f.raw = null; f.hist = []; f.misses = 0;
        this.log.info('perea_mhd_flex: fuel ' + key + ' unavailable (' + why + '; ' + f.lastReply + '), next try in ' + Math.round(FUEL_RETRY_MS / 60000) + ' min');
    }

    /** The fuel sources for the screen: { dmeL, dmeR, dmeTotal: { value, at, raw, off, fresh, lastReply }, dme (the halves added, both fresh) }. */
    fuelView(now) {
        const out = {};
        FUEL_KEYS.forEach((k) => {
            const f = this.fuel[k];
            out[k] = { value: f.value, at: f.at, raw: f.raw, off: f.off, fresh: f.value != null && now - f.at < FUEL_STALE_MS, lastReply: f.lastReply };
        });
        out.dme = out.dmeL.fresh && out.dmeR.fresh ? round1(out.dmeL.value + out.dmeR.value) : null;
        return out;
    }

    /** What the screen shows. */
    view() {
        const now = this.now();
        return {
            fuel: this.fuelView(now),
            state: this.state, reason: this.reason,
            active: this.state === 'reading' ? this.active : null,
            can: this.state === 'reading' ? this.can : null,
            stale: this.state === 'reading' && this.misses >= STALE_MISSES,
            age: this.lastGood ? now - this.lastGood : null,
            mhd: this.mhd, profile: this.profile ? this.profile.name : null, seen: this.seen.slice(),
            did: this.did, lastReply: this.lastReply,
        };
    }
}

module.exports = { Poller, DEFAULTS };
