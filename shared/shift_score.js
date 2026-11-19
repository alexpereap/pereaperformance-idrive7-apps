'use strict';
/**
 * Shift scoring and the cold-engine rev guard, for the Redline HUD layout. The rules are ported
 * from cauliflowermossgrape's Redline app (apps/redline/main.js, MIT, Copyright (c) 2026
 * cauliflowermossgrape; updated from Redline 2.0.40), with the petrol defaults this car needs:
 *
 *  - shift point = redline - "shiftBefore" (never below 2500 rpm)
 *  - cold guard ("coldGuard" on): until the oil reaches 80 °C the shift point is pulled down to
 *    4500 rpm at 30 °C oil and climbs with the oil temperature, in 50 rpm steps
 *  - every upshift (gear number +1; or, with no gear signal, rpm falling over 18 % within 0.4 s
 *    while moving) is scored on the highest rpm in the 0.6 s before it:
 *    LIMITER (within 25 rpm of the redline), EARLY (over 250 under the shift point),
 *    LATE (over 200 above it; COLD REV while the guard holds it down), else SPOT ON.
 *    Only shifts aimed at the shift point are graded: one over 1500 rpm under it is CRUISE, one the
 *    gearbox made itself (in D or S, when the car says so) is AUTO; those two are logged but leave
 *    the last grade on screen. Shifts under 2500 rpm aren't scored.
 *  - peak rpm, held 15 s; limiter hits (within 60 rpm) counted per session.
 *
 * Redline's own values, when it runs: Redline writes /dev/shm/redline/shift.json (Redline 2.0.28+, bimmer-lab/apps#4)
 * with its shift point for the gear (learned per gear from the torque curve) and its last graded shift. While that
 * file is under 3 s old, the shift point and the last shift come from it; else from the rules above.
 *
 *   const score = new ShiftScore(car, () => ({ redline, shiftBefore, coldGuard, mode }), log)   // mode: 'D' / 'S' / 'M' / null
 *   score.shiftPoint(oil) -> { rpm, cold }
 *   score.last -> { at, from, to, rpm, target, verdict } or null; score.peak, score.limiterHits
 */
const fs = require('fs');
const path = require('path');

const WARM_OIL = 80;           // °C
const COLD_LIMIT = 4500;       // rpm at 30 °C oil (Redline's petrol default)
const PEAK_HOLD_MS = 15000;
const GRADE_FROM = 1500;       // rpm under the shift point below which a shift is CRUISE
const SHARE_FILE = path.join(process.env.REDLINE_SHARE_DIR || '/dev/shm/redline', 'shift.json');
const SHARE_FRESH_MS = 3000;
const SHARE_READ_MS = 500;     // read the file at most this often
const isNum = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const graded = (v) => v !== 'CRUISE' && v !== 'AUTO';

class ShiftScore {
    constructor(car, opts, log) {
        this.opts = opts;
        this.log = log;
        this.car = car;
        this.own = null;           // our last graded shift
        this.peak = 0;
        this.peakT = 0;
        this.limiterHits = 0;
        this.recent = [];          // [t, rpm, speed], the last ~1.2 s
        this.lastGear = null;
        this.onLimiter = false;
        this.lastAt = 0;           // the last shift of any grade (for the no-gear-signal detector)
        this.share = null;         // Redline's shift.json, parsed
        this.shareRead = 0;
        this.shareUsed = false;
        this.shareLast = null;     // Redline's last graded shift (its CRUISE / AUTO ones leave it)
        car.onSample((d, t) => this._sample(d, t), () => { this.recent.length = 0; this.lastGear = null; });
    }

    /** Redline's shift.json while it is fresh, else null. Never throws. */
    redline() {
        const now = Date.now();
        if (now - this.shareRead >= SHARE_READ_MS) {
            this.shareRead = now;
            try {
                const j = JSON.parse(fs.readFileSync(SHARE_FILE, 'utf8'));
                this.share = j && j.v === 1 && isNum(j.t) ? j : null;
                const l = this.share && this.share.lastShift;
                if (l && isNum(l.at) && isNum(l.rpm) && typeof l.verdict === 'string' && graded(l.verdict)) this.shareLast = l;
            } catch (e) { this.share = null; }
        }
        const s = this.share && Math.abs(now - this.share.t) < SHARE_FRESH_MS ? this.share : null;
        if (!!s !== this.shareUsed) {
            this.shareUsed = !!s;
            this.log.info(s ? 'shift points from Redline (shift.json)' : 'shift points: own (no fresh shift.json)');
        }
        return s;
    }

    /** The last graded shift: Redline's while its file is fresh and it has graded one, else ours. */
    get last() {
        return (this.redline() && this.shareLast) || this.own;
    }

    _normal() { const o = this.opts(); return Math.max(2500, o.redline - o.shiftBefore); }

    /** Our own shift point: lowered while the oil is cold (cold guard on). */
    _ownPoint(oil) {
        const n = this._normal();
        if (!this.opts().coldGuard || !isNum(oil) || oil >= WARM_OIL) return { rpm: n, cold: false };
        const cold = Math.min(COLD_LIMIT, n);
        const f = clamp((oil - 30) / (WARM_OIL - 30), 0, 1);
        return { rpm: Math.round((cold + (n - cold) * f) / 50) * 50, cold: true };
    }

    /** The shift point right now: Redline's for this gear while its file is fresh, else our own. */
    shiftPoint(oil) {
        const s = this.redline();
        if (s && isNum(s.shiftNow) && s.shiftNow > 0) return { rpm: s.shiftNow, cold: !!s.cold };
        return this._ownPoint(oil);
    }

    verdict(rpm, target, cold) {
        const red = this.opts().redline;
        return rpm >= red - 25 ? 'LIMITER' : rpm < target - 250 ? 'EARLY' : rpm > target + 200 ? (cold ? 'COLD REV' : 'LATE') : 'SPOT ON';
    }

    _record(t, from, to) {
        const win = this.recent.filter((r) => t - r[0] < 600);
        if (!win.length) return;
        const rpm = Math.max.apply(null, win.map((r) => r[1]));
        if (!(rpm > 2500)) return;
        this.lastAt = Date.now();
        const sp = this._ownPoint(this.car.data().oil), mode = this.opts().mode;
        const v = mode === 'D' || mode === 'S' ? 'AUTO' : rpm < sp.rpm - GRADE_FROM ? 'CRUISE' : this.verdict(rpm, sp.rpm, sp.cold);
        const shift = { at: this.lastAt, from, to, rpm: Math.round(rpm), target: sp.rpm, verdict: v };
        if (graded(v)) this.own = shift;
        this.log.info('shift ' + from + '->' + to + ' @' + shift.rpm + ' (shift point ' + sp.rpm + ') ' + v);
    }

    _sample(d, t) {
        if (!isNum(d.rpm)) return;
        const r = this.recent;
        r.push([t, d.rpm, d.speed]);
        while (r.length && t - r[0][0] > 1200) r.shift();
        const now = Date.now();
        if (d.rpm >= this.peak || now - this.peakT > PEAK_HOLD_MS) { this.peak = d.rpm; this.peakT = now; }
        const lim = d.rpm >= this.opts().redline - 60;
        if (lim && !this.onLimiter) this.limiterHits++;
        this.onLimiter = lim;
        const g = d.gear;
        if (isNum(g) && g > 0 && isNum(this.lastGear) && this.lastGear > 0 && g === this.lastGear + 1) this._record(t, this.lastGear, g);
        else if (!isNum(g) && r.length > 4 && d.speed > 10) {
            const back = r.filter((x) => t - x[0] < 400);
            const hi = Math.max.apply(null, back.map((x) => x[1]));
            if (hi > 3000 && d.rpm < hi * 0.82 && now - this.lastAt > 800) this._record(t, '?', '?');
        }
        if (isNum(g)) this.lastGear = g;
    }
}

module.exports = ShiftScore;
