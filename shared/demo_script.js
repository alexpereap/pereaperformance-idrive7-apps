'use strict';
/**
 * demo_script.js - "Play demo" (the centre-screen page's button, both apps): a scripted one-minute drive on the real
 * HUD / cluster while the car is parked, so an owner sees what the layout does before driving. Idea after
 * cauliflowermossgrape's Redline "Play on HUD" (MIT); the script and the code here are our own.
 *
 *   const show = new DemoShow(car, hooks, log);   // car: the kit's Car; hooks below
 *   hud.car = show.car;      // a stand-in for car: data() and the samples are the script while the show plays, else the car's
 *   show.start(at) -> true, or false while the car moves (speed 3 km/h or more); show.stop(why); show.playing()
 *
 * The script (frameAt, time -> values): idle, a full-throttle pull 1st to 4th with the shift lights at the shift point
 * and three graded upshifts (spot on, early, spot on), the limiter, a hard stop (the G-meter's dot goes forward),
 * two corners while the oil runs over its warning limit (its readout flashes for a few seconds), then (with "Change
 * with the drive mode" on) a switch from Comfort to Sport, a kickdown pull with a late shift, braking, a cruise and
 * back to a stop.
 * Every value comes from the script: speed, rpm, gear, shifter programme, boost, torque, oil, coolant, g.
 *
 * Safety: it only starts while the car stands (the car's OWN speed, not demo data), keeps reading the car's own
 * speed while it plays and stops at once past 5 km/h; it ends by itself after SHOW_MS and is never resumed after a
 * restart (nothing is saved). Nothing is learned while it plays: data().demo is true, so the 0-60 timer, the trip and
 * the shift grades' gearbox mode ignore it, and hooks.begin / hooks.end let hud.js put the drive's own shift grade,
 * G-meter bests and peak boost back afterwards.
 *
 * hooks: { begin(), end(), redline() rpm, shiftPoint() rpm, warnOil() C (0 = off), modes() -> drive modes to show
 *          (['comfort', 'sport'], one, or [] for no drive-mode switch), drive(mode | null, force) (null: back to the car's; force: redraw even when the layout stays,
 *          for the DEMO tag) }
 *
 * Plain Node 8 (the car's 8.16.2).
 */
const textRaster = require('./hud_text');
const visible = require('./visible');

const SHOW_MS = 60000;
const START_MS = 3300;           // where Play starts in the script (the pull begins at 4 s)
const SWITCH_MS = 30000;          // the drive-mode switch (Comfort -> Sport)
const START_KMH = 3;              // starts only under this (the car's own speed)
const STOP_KMH = 5;               // and stops past this
const TICK_MS = 50;               // 20 Hz, as the car's own samples
// km/h per 1000 rpm in each gear (an 8-speed's 1st to 6th, as on the M40i)
const KMH_PER_K = [0, 8.5, 13.6, 20.6, 27.0, 33.5, 40.5];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, f) => a + (b - a) * clamp(f, 0, 1);
const ease = (f) => { f = clamp(f, 0, 1); return f * f * (3 - 2 * f); };
const isNum = (v) => typeof v === 'number' && isFinite(v);
/** rpm in gear g at kmh, and back */
const rpmAt = (kmh, g) => kmh * 1000 / KMH_PER_K[g];
const kmhAt = (rpm, g) => rpm * KMH_PER_K[g] / 1000;
/** The highest gear (up to top) that keeps the engine over `floor` rpm at kmh. */
function gearFor(kmh, top, floor) {
    for (let g = top; g > 1; g--) if (rpmAt(kmh, g) >= floor) return g;
    return 1;
}

/**
 * A pull: [gear, rpm from, rpm to, s] steps; the speed follows the rpm in each gear. Returns the plan with each
 * step's start time, and the speed at the end.
 */
function pull(t0, steps) {
    let t = t0;
    const out = steps.map((s) => { const p = { g: s[0], r0: s[1], r1: s[2], t0: t, t1: t + s[3], hold: !!s[4] }; t += s[3]; return p; });
    return { steps: out, t0, t1: t };
}

/**
 * The script's timeline for a redline and shift point (rpm): built once per show, so a setting changed mid-show
 * doesn't jump the speed.
 */
function plan(red, spIn) {
    const sp = Math.min(spIn, red - 40);
    const late = Math.min(sp + 280, red - 35), early = Math.max(2800, sp - 600);
    // pull 1 from a standing start: 1st (spot on), 2nd (early), 3rd (spot on), 4th onto the limiter
    const p1 = pull(4, [
        [1, 1900, sp + 20, 2.3],
        [2, rpmAt(kmhAt(sp + 20, 1), 2), early, 2.6],
        [3, rpmAt(kmhAt(early, 2), 3), sp + 20, 3.0],
        [4, rpmAt(kmhAt(sp + 20, 3), 4), red, 2.6],
        [4, red, red, 1.4, true],
    ]);
    const v1 = kmhAt(red, 4);
    // pull 2 after the drive-mode switch: a kickdown from 60 km/h, 2nd (late), 3rd (spot on), 4th, then a lift
    const p2 = pull(31, [
        [2, rpmAt(60, 2), late, 1.6],
        [2, late, late, 0.25],
        [3, rpmAt(kmhAt(late, 2), 3), sp + 20, 2.75],
        [4, rpmAt(kmhAt(sp + 20, 3), 4), Math.min(5800, red - 300), 2.3],
    ]);
    const v2 = kmhAt(Math.min(5800, red - 300), 4);
    return { red, sp, p1, v1, p2, v2 };
}

/** One frame of the show at ms into it: what car.data() gives (plus mode: the drive mode the show is in). */
function frameAt(ms, P, warnOil) {
    const t = ms / 1000, red = P.red;
    const idle = 760 + 12 * Math.sin(t * 9);
    const lim = warnOil > 0 ? warnOil : 130;
    // temperatures: warm, a little warmer from the pulls; the oil runs over its warning limit in the corners (about 24-28 s,
    // before the drive-mode switch, so the first layout shows it)
    const coolant = 88 + 6 * ease((t - 4) / 14) - 2 * ease((t - 20) / 10) + 4 * ease((t - 31) / 8) - 3 * ease((t - 50) / 10);
    const oilBase = 97 + 9 * ease((t - 4) / 30);
    const peak = Math.max(oilBase, lim + 3);
    const bump = t < 22 ? 0 : t < 25 ? ease((t - 22) / 3) : t < 27 ? 1 : ease(1 - (t - 27) / 3);
    const r = {
        rpm: idle, speed: 0, gear: 1, stage: 'D', program: t < SWITCH_MS / 1000 ? 'D' : 'S',
        gLong: 0, gLat: 0, boost: 0, torque: 25, oil: oilBase + (peak - oilBase) * bump, coolant,
        demo: true, demoShow: true,
    };
    const inPull = (p) => {
        const s = p.steps.find((x) => t >= x.t0 && t < x.t1);
        if (!s) return false;
        const f = (t - s.t0) / (s.t1 - s.t0);
        r.gear = s.g;
        if (s.hold) {
            // on the limiter: the cut makes the rpm bounce under the redline (8 Hz)
            r.rpm = red - 70 + 90 * (Math.floor(t * 16) % 2);
            r.speed = kmhAt(red, s.g);
            r.gLong = 0.05; r.torque = 220; r.boost = 1.1;
            return true;
        }
        r.rpm = lerp(s.r0, s.r1, f);
        // the launch: the clutch slips for the first part of 1st, so the speed starts from 0
        r.speed = kmhAt(r.rpm, s.g) * (s.g === 1 && s === p.steps[0] ? Math.min(1, f / 0.3) : 1);
        // turbo spool at the start of the pull, a dip in each shift; the push eases off in the higher gears
        const spool = ease((t - p.t0) / 0.9), shiftDip = f < 0.08 ? 0.75 : 1;
        r.boost = 1.25 * spool * shiftDip;
        r.torque = (430 + 70 * Math.sin(clamp(r.rpm / red, 0, 1) * Math.PI)) * spool;
        r.gLong = [0, 0.62, 0.48, 0.36, 0.27][s.g] * spool * shiftDip;
        r.gLat = 0.02 * Math.sin(t * 3);
        return true;
    };
    if (t < 4) {
        // standing in D, idling
    } else if (inPull(P.p1)) {
        // pull 1
    } else if (t < P.p1.t1 + 4.5) {
        // hard stop from the limiter to 55 km/h: about 0.85 g
        const f = (t - P.p1.t1) / 4.5;
        r.speed = lerp(P.v1, 55, f);
        r.gear = gearFor(r.speed, 4, 2300);
        r.rpm = rpmAt(r.speed, r.gear);
        r.gLong = -0.86 * ease(f / 0.12) * ease((1 - f) / 0.1) - 0.02 * Math.sin(t * 11);
    } else if (t < 29.5) {
        // two corners at about 0.9 g, 55-60 km/h in 3rd
        const t0 = P.p1.t1 + 4.5, f = (t - t0) / (29.5 - t0);
        r.speed = lerp(55, 60, f); r.gear = 3; r.rpm = rpmAt(r.speed, 3);
        r.gLat = 0.92 * Math.sin(f * Math.PI * 4) * ease(f / 0.08) * ease((1 - f) / 0.08);
        r.gLong = 0.06; r.boost = 0.25 + 0.2 * Math.abs(Math.sin(f * Math.PI * 4)); r.torque = 140;
    } else if (t < P.p2.t0) {
        // a straight at 60 before the kickdown (the drive mode switches at 30 s)
        r.speed = 60; r.gear = 3; r.rpm = rpmAt(60, 3); r.boost = 0.15; r.torque = 90; r.gLong = 0.02;
    } else if (inPull(P.p2)) {
        // pull 2
    } else if (t < P.p2.t1 + 4) {
        // braking to 80 km/h, about 0.6 g
        const f = (t - P.p2.t1) / 4;
        r.speed = lerp(P.v2, 80, f);
        r.gear = gearFor(r.speed, 4, 2300);
        r.rpm = rpmAt(r.speed, r.gear);
        r.gLong = -0.6 * ease(f / 0.15) * ease((1 - f) / 0.15);
    } else if (t < 52) {
        // cruising at 80 in 5th with gentle bends
        r.speed = 80 + 2 * Math.sin(t * 0.7); r.gear = 5; r.rpm = rpmAt(r.speed, 5);
        r.gLat = 0.3 * Math.sin((t - P.p2.t1) * 0.9); r.gLong = 0.03; r.boost = 0.2; r.torque = 110;
    } else if (t < 58) {
        // slowing to a stop
        const f = (t - 52) / 6;
        r.speed = lerp(80, 0, f);
        r.gear = gearFor(r.speed, 5, 1300);
        r.rpm = r.speed < 9 ? lerp(1100, idle, (9 - r.speed) / 9) : rpmAt(r.speed, r.gear);
        r.gLong = -0.38 * ease(f / 0.1) * ease((1 - f) / 0.06);
    }
    r.rpm = Math.max(idle - 20, r.rpm);
    return r;
}

/**
 * The DEMO tag on the HUD / cluster: a "badge" widget (tone "demo"), an image widget packed into a sheet like any
 * other text, so no new shader. Placed on a grid of spots the driver can see (visible.js: the HUD window clear of
 * BMW's own speed; the cluster under the hood line, clear of the driver camera, BMW's gear box, belt light and bottom
 * strip), clear of the layout's own widgets when it can be (else of its text at least). Of up to TAG_TRIES of those spots it
 * takes, in order: one that keeps the layout within the layer budget, the fewest layers, the fewest sheet pixels (the
 * planner's cost(list) -> { over, layers, px } from hud.js), then the one nearest the preferred place.
 */
function tagWidget(target, shown, cost) {
    const panel = target === 'panel';
    const fonts = panel ? ['head', 'unit', 'b_unit', 'label', 'mid'] : ['label', 'small', 'mid', 'head', 'unit'];
    let font = null;
    for (let i = 0; i < fonts.length && !font; i++) {
        try {
            const f = textRaster.loadFont(fonts[i]);
            if ('DEMO'.split('').every((c) => f.metrics.glyphs[c])) font = fonts[i];
        } catch (e) { /* not in this app */ }
    }
    if (!font) return null;
    const spacing = 2, text = 'DEMO';
    const ch = textRaster.loadFont(font).metrics.cellHeight;
    const h = Math.round(ch + 8), w = Math.round(textRaster.measure(text, font, spacing) + 2 * h * 0.7);
    // in the layout's biggest group of image widgets (class, z, connection), so it can share one of their sheets
    const groups = {};
    (shown || []).forEach((x) => { if (IMAGE[x.type] && x.own !== true) { const k = [x.class || 'content', x.z || 0, x.conn || 0].join('|'); groups[k] = (groups[k] || 0) + 1; } });
    const g = (Object.keys(groups).sort((a, b) => groups[b] - groups[a] || Number(b.split('|')[1]) - Number(a.split('|')[1]))[0] || 'content|0|0').split('|');
    const tag = (x, y) => {
        const t = { id: 'demo_tag', type: 'badge', tone: 'demo', text, font, spacing, x, y, w, h };
        if (g[0] !== 'content') t.class = g[0];
        if (Number(g[1])) t.z = Number(g[1]);
        if (Number(g[2])) t.conn = Number(g[2]);
        return t;
    };
    const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const inBox = (r, b) => r.x < b[2] && r.x + r.w > b[0] && r.y < b[3] && r.y + r.h > b[1];
    // the spots: a grid over what the driver sees, nearest the preferred place first
    const spots = [];
    if (panel) {
        for (let y = 20; y + h <= 655; y += 20) for (let x = 40; x + w <= 1880; x += 40) {
            const r = tag(x, y);
            if (!visible.check([r], 'panel').length && !inBox(r, visible.CAMERA)) spots.push(r);
        }
    } else {
        const v = visible.HUD_WINDOW;
        for (let y = v.y + 2; y + h <= v.y + v.h - 2; y += 10) for (let x = v.x + 4; x + w <= v.x + v.w - 4; x += 10) {
            const r = tag(x, y);
            if (!visible.check([r], 'hud').length) spots.push(r);
        }
    }
    const pref = panel ? [960, 130] : [680, 380];
    const dist = (r) => Math.hypot(r.x + r.w / 2 - pref[0], r.y + r.h / 2 - pref[1]);
    spots.sort((a, b) => dist(a) - dist(b));
    // what it should stay off: every widget (and every box of a one-layer frame) but a backdrop over half the target
    const full = (panel ? 1920 * 720 : 800 * 480) / 2, rects = [];
    (shown || []).forEach((x) => {
        const sub = Array.isArray(x.boxes) ? x.boxes : Array.isArray(x.tiles) ? x.tiles : null;
        (sub || [x]).forEach((b) => { if (b && isNum(b.x) && isNum(b.y) && isNum(b.w) && isNum(b.h) && b.w * b.h < full) rects.push({ r: b, img: !!IMAGE[x.type] }); });
    });
    const clear = spots.filter((r) => !rects.some((o) => hit(r, o.r)));
    const noText = spots.filter((r) => !rects.some((o) => o.img && hit(r, o.r)));
    // planning is cheap but not free on the car: at most TAG_TRIES spots, spread over the list (nearest first)
    const pool = clear.length ? clear : noText.length ? noText : spots, step = Math.max(1, pool.length / TAG_TRIES), tries = [];
    for (let k = 0; k < pool.length && tries.length < TAG_TRIES; k += step) tries.push(pool[Math.floor(k)]);
    let best = null;
    tries.forEach((r) => {
        const c = cost ? cost((shown || []).concat([r])) : { over: false, layers: 0, px: 0 };
        const key = [c.over ? 1 : 0, c.layers, c.px];
        let better = !best;
        for (let k = 0; !better && k < key.length && key[k] <= best.key[k]; k++) if (key[k] < best.key[k]) better = true;
        if (better) best = { r, key };
    });
    return best ? best.r : null;
}
const TAG_TRIES = 48;
// the widget types drawn as pixels (hud.js IMAGE_TYPES): the tag shouldn't cover their text
const IMAGE = { text: true, scale: true, stripe: true, badge: true, gridlabels: true, icon: true, swatchimg: true, atext: true };

class DemoShow {
    constructor(car, hooks, log) {
        this.real = car; this.hooks = hooks; this.log = log;
        this.t0 = 0; this.on = false; this.timer = null; this.plan = null; this.modes = []; this.modeAt = null;
        this.listeners = [];
        // the stand-in: everything as the car, but data() and the samples follow the script while the show plays
        const self = this, f = Object.create(car);
        f.data = function () { return self.on ? self.frame(Date.now()) : car.data(); };
        f.onSample = function (fn, reset) {
            self.listeners.push({ fn, reset });
            car.onSample((d, t) => { if (!self.on) fn(d, t); }, reset);
        };
        f.demoShow = this;
        this.car = f;
    }

    /** The car's own speed (never demo data), km/h, or null. */
    realSpeed() { const v = this.real.live && this.real.live.speed; return isNum(v) ? v : null; }
    /** Standing still by the car's own speed (no speed at all counts as standing). */
    standing() { const v = this.realSpeed(); return v === null || v < START_KMH; }
    playing() { return this.on; }
    /** ms left, or 0 */
    left() { return this.on ? Math.max(0, SHOW_MS - (Date.now() - this.t0)) : 0; }

    frame(now) { return frameAt(clamp(now - this.t0, 0, SHOW_MS), this.plan, this.hooks.warnOil()); }

    /** at: start that many ms into the show (the bench's /demo, for screenshots), else from the beginning. */
    start(at) {
        if (this.on) return true;
        if (!this.standing()) { this.log.info('demo show: not while the car moves'); return false; }
        this.plan = plan(this.hooks.redline(), this.hooks.shiftPoint());
        this.hooks.begin();
        // the script's first 4 s are idle: start 0.7 s before the first pull so something happens at once
        this.t0 = Date.now() - clamp(Math.max(START_MS, Number(at) || 0), 0, SHOW_MS - 1000); this.on = true;
        this._reset();
        this.modes = this.hooks.modes() || [];
        this.modeAt = this.modes[0] || null;
        this.hooks.drive(this.modeAt, false);
        this.log.info('demo show: playing (' + SHOW_MS / 1000 + ' s' + (this.modes.length ? ', drive mode ' + this.modes.join(' > ') : '') + ')');
        this.timer = setInterval(() => { try { this._tick(); } catch (e) { this.log.warn('demo show: ' + e); this.stop('error'); } }, TICK_MS);
        return true;
    }

    stop(why) {
        if (!this.on) return;
        this.on = false;
        clearInterval(this.timer); this.timer = null;
        this._reset();
        this.log.info('demo show: stopped (' + (why || 'stop') + ')');
        try { this.hooks.end(); } catch (e) { this.log.warn('demo show end: ' + e); }
        try { this.hooks.drive(null, false); } catch (e) { this.log.warn('demo show drive: ' + e); }
    }

    _reset() { this.listeners.forEach((l) => { try { if (l.reset) l.reset(); } catch (e) { this.log.warn('demo show reset: ' + e); } }); }

    _tick() {
        const now = Date.now(), ms = now - this.t0;
        // the real car moving ends it at once (it would hide the car's own speed and gear)
        const v = this.realSpeed();
        if (v !== null && v > STOP_KMH) return this.stop('the car moved');
        if (ms >= SHOW_MS) return this.stop('the end');
        const want = this.modes.length > 1 && ms >= SWITCH_MS ? this.modes[1] : this.modes[0] || null;
        if (want !== this.modeAt) { this.modeAt = want; this.log.info('demo show: drive mode ' + want); this.hooks.drive(want, false); }
        const d = this.frame(now);
        this.listeners.forEach((l) => { try { l.fn(d, now); } catch (e) { this.log.warn('demo sample: ' + e); } });
    }
}

DemoShow.SHOW_MS = SHOW_MS;
DemoShow.START_KMH = START_KMH;
DemoShow.STOP_KMH = STOP_KMH;
DemoShow.frameAt = frameAt;
DemoShow.plan = plan;
DemoShow.tagWidget = tagWidget;
module.exports = DemoShow;
