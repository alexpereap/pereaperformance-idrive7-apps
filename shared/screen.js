'use strict';
/**
 * screen.js - Cluster Themes and HUD Widgets share one screen (cluster-render shows the cluster panel and the HUD
 * under one scene, never both at once), so the two apps tell each other what they show.
 *
 * Each app writes <dir>/<me>.json about every 2 s: { on, claim, at }. "on": it is drawing a theme or layout now.
 * "claim": when the driver last took the screen for it on its page (Date.now(), 0 = never since it started).
 * Each app reads the other's file. A claim from the other app that is newer than our own makes us step aside:
 * we draw nothing ("yielded") until the driver picks a theme or layout on our own page again (claim()). The
 * yield is saved in <dataDir>/screen.json, so it survives a restart of the unit (the files in /dev/shm don't).
 * The page asks first (page.js, "Turn HUD off?"); otherOn() says whether there is anything to ask about.
 * cluster-render 0.5.1+ gives the panel its own scene id (0x10004f8; the HUD keeps 0x1000400), so both can show at
 * once: while either app sees that in cluster-render's status ("apart" in its file), neither steps aside (Nov 11 2026).
 * A claim that was already there when we started is not acted on (it is old news).
 *
 *   dir: /dev/shm/bimmer-lab (0777: the two apps may run as different users); env SCREEN_DIR on the Mac bench.
 * Plain Node 8 (the car's 8.16.2).
 */
const fs = require('fs');
const path = require('path');

const DIR = '/dev/shm/bimmer-lab';
const BEAT_MS = 2000;
const FRESH_MS = 7000;           // the other app's file older than this: it isn't running
const NAMES = { cluster: 'Cluster Themes', hud: 'HUD Widgets' };

class Screen {
    /**
     * me: 'cluster' | 'hud'. isOn(): this app draws something now. onChange(): the yield changed (rebuild).
     * apart(): true when cluster-render gives the panel and the HUD their own scenes (0.5.1+), so both show at once:
     * then neither app steps aside (either app knowing is enough: it writes "apart" in its file).
     */
    constructor(me, dataDir, log, isOn, onChange, apart) {
        this.me = me;
        this.other = me === 'cluster' ? 'hud' : 'cluster';
        this.otherName = NAMES[this.other];
        this.dir = process.env.SCREEN_DIR || DIR;
        this.memo = dataDir ? path.join(dataDir, 'screen.json') : null;
        this.log = log;
        this.isOn = isOn;
        this.onChange = onChange || (() => {});
        this.apart = apart || (() => false);
        this.claimAt = 0;
        this.seen = null;            // the other app's last claim we know about (null: not read yet)
        this.peer = null;            // its last file: { on, claim, at } or null
        this.yielded = false;
        try { this.yielded = JSON.parse(fs.readFileSync(this.memo, 'utf8')).yielded === true; } catch (e) { /* first run */ }
    }

    start() {
        this.timer = setInterval(() => this.beat(), BEAT_MS);
        this.beat();
    }
    stop() { clearInterval(this.timer); this._write(false); }

    /** Both screens show at once (this app or the other one says so): nothing to share. */
    together() { return this.apart() === true || !!(this.peer && this.peer.apart); }

    /** The other app is drawing on the shared screen now (never while both can show: nothing to ask about). */
    otherOn() { return !this.together() && !!(this.peer && this.peer.on); }

    /** The driver picked a theme or layout here: take the screen (the other app steps aside on its next read). */
    claim() {
        this.claimAt = Date.now();
        this._setYield(false);
        this._write(this.isOn());
    }

    /** The driver picked "off" here: no claim, but no longer stepping aside either. */
    release() { this._setYield(false); }

    beat() {
        this._read();
        this._write(this.isOn());
    }

    _read() {
        let p = null;
        try {
            const f = path.join(this.dir, this.other + '.json');
            const st = fs.statSync(f);
            if (Date.now() - st.mtime.getTime() < FRESH_MS) p = JSON.parse(fs.readFileSync(f, 'utf8'));
        } catch (e) { p = null; }
        this.peer = p && typeof p === 'object' ? { on: p.on === true, claim: Number(p.claim) || 0, apart: p.apart === true } : null;
        const claim = this.peer ? this.peer.claim : 0;
        if (this.together() && this.yielded) {
            this.log.info('screen: the cluster and the HUD can show at once now, ' + this.otherName + ' no longer has to have it alone');
            this._setYield(false);
        }
        if (this.seen === null) { this.seen = claim; return; }      // there before we started
        if (claim > this.seen) {
            this.seen = claim;
            if (this.together()) return;
            if (claim > this.claimAt && !this.yielded) {
                this.log.info('screen: ' + this.otherName + ' took the screen, stepping aside');
                this._setYield(true);
            }
        }
    }

    _write(on) {
        try {
            try { fs.mkdirSync(this.dir); fs.chmodSync(this.dir, 0o777); } catch (e) { /* there already */ }
            const f = path.join(this.dir, this.me + '.json'), tmp = f + '.' + process.pid + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({ on: on === true, claim: this.claimAt, at: Date.now(), apart: this.apart() === true }));
            try { fs.chmodSync(tmp, 0o666); } catch (e) { /* best effort */ }
            fs.renameSync(tmp, f);
        } catch (e) {
            if (!this.warned) { this.warned = true; this.log.warn('screen: cannot write ' + this.dir + ' (' + e.message + ')'); }
        }
    }

    _setYield(on) {
        if (on === this.yielded) return;
        this.yielded = on;
        if (this.memo) { try { fs.writeFileSync(this.memo, JSON.stringify({ yielded: on })); } catch (e) { this.log.warn('screen: cannot save ' + this.memo); } }
        this.onChange();
    }
}

Screen.NAMES = NAMES;
module.exports = Screen;
