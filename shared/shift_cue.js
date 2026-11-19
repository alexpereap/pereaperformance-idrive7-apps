'use strict';
/**
 * shift_cue.js - the count-in shift lights (both apps), ported from cauliflowermossgrape's Redline (apps/redline/hud.js
 * shiftCue / reactionMs / upshift, README "Shift cue", MIT, Copyright (c) 2026 cauliflowermossgrape).
 *
 * Setting "shiftCue": "countin" (the default) or "rpm" (the fixed band from a layout's "from" rpm to the shift point,
 * as before Nov 13 2026). With the count-in:
 *  - Count-in: the lights fill over about the last second before the flash. The span (800..2000 rpm) comes from how
 *    fast the revs climb (rpm/s x 1 s), so the count takes about as long in 2nd as in 5th. Never climbed yet: 1500.
 *  - Early flash: the flash point "at" = the shift point minus what the revs climb in the driver's reaction time
 *    (at most 800 rpm early), so the shift itself lands on the shift point. The reaction time is Redline's own
 *    (shift.json "leadMs", while Redline runs) else learned here (<data>/shift_lead.json, 200 ms to start, 0..600):
 *    from each upshift made by hand (not in D or S) within 2 s of a flash the driver could see, not after a lift.
 *  - Latched: once it fires the flash holds; it ends on a gear change (the upshift; the next gear counts in afresh),
 *    without a gear signal on a drop 12 % under the highest rpm while flashing, or on revs falling for 300 ms (a lift).
 *  - Lifting before the flash steps the lights back down (the span is kept while the revs don't climb).
 * hud.js draws it with the existing shaders: the lights get the count (u_lit) and the 5 Hz flash (u_strobe); the
 * shift bars and arcs flash (u_flash) at 5 Hz while it is latched; everything that goes by "the shift point now"
 * (revbar u_shiftNow, the M rev blade, the dial, hotWhen "now", {{shiftPrompt}}) follows the latched flash.
 * No new uniforms.
 *
 *   const cue = new ShiftCue(dataDir, log)
 *   cue.tick(rpm, tMs, shift, redline, leadMs, gear, rpmShow) -> { from, at, shift, limiter, rate, fallSince }
 *   cue.fraction(rpmShow) -> 0..1 of the count lit;  cue.upshift(rpm, ok)   cue.lead(shareLeadMs) -> ms
 * Plain Node 8 (the car's 8.16.2).
 */
const fs = require('fs');
const path = require('path');

const BLINK_MS = 100;            // the flash: 5 Hz
const isNum = (v) => typeof v === 'number' && isFinite(v);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * Redline's shiftCue (count-in branch), unchanged in its maths: st = state kept between calls ({}). rpm = the real
 * reading (the climb rate goes by it), rpmShow = the smoothed rpm drawn (the count and the flash go by it).
 */
function shiftCue(st, rpm, tMs, shift, redline, leadMs, gear, rpmShow) {
    if (!isNum(rpm)) { st.rate = 0; st.on = false; st.fall = null; return { from: shift - 1500, at: shift, shift: false, limiter: false, rate: 0, fallSince: null }; }
    let rising = false;
    // the same reading again (a tick between two rpm samples) is no news: the rate is only updated on a new sample,
    // measured over the time since the last one; a reading unchanged for 500 ms is a real standstill of the revs
    const fresh = !isNum(st.rpm) || rpm !== st.rpm || tMs - st.t >= 500;
    if (isNum(st.rpm) && tMs > st.t && fresh) {
        const r = (rpm - st.rpm) * 1000 / (tMs - st.t);
        rising = r > 300;
        st.rate = r <= 0 ? (r < -500 ? 0 : (st.rate || 0) * 0.7) : (st.rate ? st.rate * 0.5 + r * 0.5 : r);
        if (r < -150) { if (st.fall == null) st.fall = st.t; } else st.fall = null;      // falling, sample after sample
    }
    if (fresh) { st.rpm = rpm; st.t = tMs; }
    const rate = st.rate || 0, climbing = rate > 300;
    // span and lead only from samples where the revs really rose (the smoothed rate decays over a hold or a lift)
    if (climbing && rising) { st.span = clamp(rate * 1.0, 800, 2000); st.lead = Math.min(800, rate * leadMs / 1000); }
    const at = shift - (st.lead || 0);
    const from = at - (st.span || 1500);
    const r = isNum(rpmShow) ? rpmShow : rpm;
    if (!climbing && r <= from) { st.span = 0; st.lead = 0; }          // count empty: back to the plain span
    const lifted = st.fall != null && tMs - st.fall >= 300;
    // a new gear (the upshift) ends the flash and starts the next gear's count afresh
    const changed = typeof gear === 'number' && typeof st.gear === 'number' && gear !== st.gear;
    if (typeof gear === 'number') st.gear = gear;
    if (changed) { st.on = false; st.span = 0; st.lead = 0; }
    if (!st.on && r >= at && !lifted && !changed) { st.on = true; st.at = at; st.peak = rpm; }
    else if (st.on) {
        st.peak = Math.max(st.peak || rpm, rpm);
        if (rpm < st.peak * 0.88 || lifted) st.on = false;
    }
    return { from: from, at: st.on ? st.at : at, shift: !!st.on, limiter: rpm >= redline - 40, rate: rate, fallSince: st.fall == null ? null : st.fall };
}

/** The driver's reaction time from one upshift after a flash (Redline's reactionMs): the lead the flash really had
 *  (capped at 800 rpm early) plus how late the shift was, 0..600 ms. */
function reactionMs(flash, rpm) {
    const effLead = Math.min(flash.lead, 800 / flash.rate * 1000);
    return clamp(effLead + (rpm - flash.target) / flash.rate * 1000, 0, 600);
}

class ShiftCue {
    constructor(dataDir, log) {
        this.log = log;
        this.file = path.join(dataDir || '.', 'shift_lead.json');
        this.st = {};
        this.now = { from: 0, at: 0, shift: false, limiter: false, rate: 0, fallSince: null };
        this.learned = 200; this.shifts = 0;
        this.flashInfo = null;          // { t, rate, target, lead, fall } of the last flash the driver could see
        this.recent = [];               // [t, rpm] of the last 600 ms, for an upshift's peak
        this.lastGear = null;
        try {
            const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (isNum(j.ms)) { this.learned = clamp(Math.round(j.ms), 0, 600); this.shifts = isNum(j.n) && j.n > 0 ? Math.floor(j.n) : 0; }
        } catch (e) { /* none yet */ }
    }

    /** The reaction time to use: Redline's (shift.json leadMs) while it gives one, else the learned one. */
    lead(shareLeadMs) { return isNum(shareLeadMs) && shareLeadMs >= 0 ? clamp(shareLeadMs, 0, 600) : this.learned; }

    reset() { this.st = {}; this.flashInfo = null; this.recent = []; this.lastGear = null; }

    /**
     * Every tick. rpm the real reading (or the shift-light test's), rpmShow the smoothed one, shift / redline rpm,
     * leadMs the reaction time, gear (number or not). seen(): the driver could see the flash now (lights shown).
     * learn: { mode: 'D' | 'S' | 'M' | null } on the car's own data, else null (the demo drive and the test teach nothing).
     */
    tick(rpm, tMs, shift, redline, leadMs, gear, rpmShow, seen, learn) {
        const was = this.st.on;
        const cue = shiftCue(this.st, rpm, tMs, shift, redline, leadMs, gear, rpmShow);
        if (cue.shift && !was) {
            this.flashInfo = learn && seen && seen() ? { t: tMs, rate: cue.rate, target: shift, lead: leadMs, fall: null } : null;
        }
        // the first moment the revs fell after the flash: a real upshift reports its new gear within ~0.7 s of that
        if (this.flashInfo && this.flashInfo.fall === null && cue.fallSince !== null) this.flashInfo.fall = cue.fallSince;
        // an upshift (gear + 1): its peak over the last 600 ms, for the reaction time
        if (isNum(rpm)) { this.recent.push([tMs, rpm]); while (this.recent.length && tMs - this.recent[0][0] > 600) this.recent.shift(); }
        if (isNum(gear) && gear > 0 && isNum(this.lastGear) && this.lastGear > 0 && gear === this.lastGear + 1 && this.recent.length) {
            this._upshift(Math.max.apply(null, this.recent.map((x) => x[1])), tMs, learn);
        }
        if (isNum(gear)) this.lastGear = gear;
        this.now = cue;
        return cue;
    }

    /** 0..1: how much of the count is lit at rpmShow (from -> at). */
    fraction(rpmShow) {
        const c = this.now;
        if (!isNum(rpmShow) || !(c.at > c.from)) return 0;
        return clamp((rpmShow - c.from) / (c.at - c.from), 0, 1);
    }

    /** The flash's on phase now (5 Hz), false while it isn't latched. */
    blink(nowMs) { return !!this.now.shift && Math.floor(nowMs / BLINK_MS) % 2 === 0; }

    _upshift(rpm, tMs, learn) {
        const f = this.flashInfo;
        this.flashInfo = null;
        if (!f || !learn || tMs - f.t > 2000 || f.rate < 300) return;
        if (f.fall !== null && tMs - f.fall > 700) return;                    // lifted first: says nothing about reaction
        if (learn.mode === 'D' || learn.mode === 'S') return;                 // the gearbox picked the moment
        const before = this.learned;
        this.learned = Math.round(clamp(this.learned + (reactionMs(f, rpm) - this.learned) * 0.3, 0, 600) / 10) * 10;
        this.shifts++;
        this.log.info('shift cue: upshift at ' + Math.round(rpm) + ' for ' + f.target + ', reaction lead now ' + this.learned + ' ms after ' + this.shifts + ' shifts');
        if (this.learned !== before) {
            try { fs.writeFileSync(this.file, JSON.stringify({ ms: this.learned, n: this.shifts })); } catch (e) { this.log.warn('shift cue: cannot save ' + this.file + ' (' + e.message + ')'); }
        }
    }
}

ShiftCue.shiftCue = shiftCue;
ShiftCue.reactionMs = reactionMs;
module.exports = ShiftCue;
