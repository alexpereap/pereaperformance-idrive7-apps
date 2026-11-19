'use strict';
/**
 * The holiday light string (Nov 13 2026): a string of glowing coloured bulbs on a thin wire, like real Christmas
 * lights, hung along the top of every cluster theme (just under the hood line) and every HUD layout (the top edge of
 * the visible window) while a holiday is on. hud.js injects it at rebuild time (as the demo show's DEMO tag) as image
 * widgets of type "garland", one per stretch of string, each on its own image layer: no shader, pixels drawn here on
 * the CPU, sent once, then only the rects of the bulbs that change while the car stands (a gentle twinkle, at most
 * 4 times a second; nothing moves while it drives).
 *
 * Placement: the string hangs in swags from points along the top line (hood line + a margin on the cluster, y 101 on
 * the HUD) and is kept clear of every widget of the layout (a full-target backdrop excepted; GT3 / Dyno boxes and
 * tiles, and the Rally rev arc, by their own shapes), of the driver camera notch while "cameraNotch" is on and of BMW's
 * own HUD area. Where a widget is in the way the string stops and starts again past it (split); when the top is too
 * tight the bulbs get smaller (down to about half) or the string hangs a little lower. Too little room: no string.
 *
 * Plain Node 8 (the car's 8.16.2): no optional chaining, no ??, no dependencies but visible.js.
 *
 *   place(target, shown, opts)     the garland widgets for a layout ([] for none); opts { camera, colors, cost }
 *   paint(w, lvl, rect)             RGBA pixels of widget w (rect in widget px, null = all) at bulb levels lvl
 *   Twinkle                         per widget: step(now, standing) -> the bulbs that changed; rects(list)
 */
const visible = require('./visible');

// sizes at scale 1, target px. sag: the swag's dip; swag: hang point spacing; sp: bulb spacing along it;
// bl / bw: a bulb's length and widest half-width; capH / capW: the dark socket; wire: thickness; glow: halo sigma
const SIZE = {
    panel: { sag: 13, swag: 210, sp: 44, bl: 21, bw: 6.6, capH: 6, capW: 7.5, wire: 2.2, glow: 8, margin: 7, minSpan: 150,
        x0: 110, x1: 1810, bottom: 640, scales: [1, 0.85, 0.72, 0.6, 0.5], offs: [0, 15, 30, 45], pad: 5 },
    hud: { sag: 6, swag: 120, sp: 25, bl: 11, bw: 3.6, capH: 3.2, capW: 4.2, wire: 1.3, glow: 4.5, margin: 1, minSpan: 110,
        x0: 124, x1: 676, bottom: 378, scales: [1, 0.8, 0.65, 0.52], offs: [0], pad: 3 },
    // the HUD's fairy-light string: where a shift bar fills the top of the window (Sport, Track, Redline, ...) only
    // the strip above it is free (about 7 px), so tiny bulbs on a barely sagging wire
    micro: { sag: 1.1, swag: 70, sp: 15, bl: 5, bw: 2.3, capH: 0.6, capW: 1.8, wire: 1, glow: 2.6, margin: 1, minSpan: 110,
        x0: 124, x1: 676, bottom: 378, scales: [1], offs: [0], pad: 1.5, tight: true },
};
const STEP = 4;                 // column step of the placement search
const TWINKLE_MS = 250;         // at most 4 redraws a second
const DIM = 0.4;                // a twinkling bulb's level (1 = full)
const GLOW_R = 3;               // the glow's reach, in sigmas
const LAYERS_ALL = 28;          // a layout with its string stays within this many layers in all (cluster-render: 32 for every app)

const isNum = (v) => typeof v === 'number' && isFinite(v);

/** The string's top line (where it hangs from) at x. */
function topY(target, x) {
    return target === 'panel' ? visible.hoodY(x) + SIZE.panel.margin : visible.HUD_WINDOW.y + SIZE[target].margin;
}

/** Height a string needs below its top line at scale s (sag, socket, bulb, a little glow). */
function need(P, s) { return P.tight ? P.sag + P.capH + P.bl + 0.5 : (P.sag + P.capH + P.bl + P.glow * 0.8) * s + 2; }

/** What the string must stay off: [x0, y0, x1, y1] boxes, padded. */
function obstacles(target, shown, camera) {
    const P = SIZE[target], full = (target === 'panel' ? 1920 * 720 : 800 * 480) / 2, out = [];
    const add = (x0, y0, x1, y1) => out.push([x0 - P.pad, y0 - P.pad, x1 + P.pad, y1 + P.pad]);
    const panel = target === 'panel';
    (shown || []).forEach((w) => {
        if (!w || w.type === 'garland') return;
        if (w.type === 'revarc' && Array.isArray(w.center) && isNum(w.r)) {
            // the Rally rev arc by its band: a box per 1.5 degrees
            const cx = w.x + w.center[0], cy = w.y + w.center[1], r1 = w.r, r0 = w.r - (w.band || 40);
            const a0 = (w.start || 0) * Math.PI / 180, sw = (w.sweep || 0) * Math.PI / 180, n = Math.max(1, Math.ceil(Math.abs(sw) / 0.026));
            for (let i = 0; i < n; i++) {
                const xs = [], ys = [];
                [a0 + sw * i / n, a0 + sw * (i + 1) / n].forEach((a) => [r0, r1].forEach((r) => { xs.push(cx + r * Math.sin(a)); ys.push(cy - r * Math.cos(a)); }));
                add(Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys));
            }
            return;
        }
        if (w.type === 'sdash' && Array.isArray(w.geo)) {
            // the Sport dash: its top lines run at geo[0]; nothing under them (the dash's own space)
            add(w.x, w.y + w.geo[0] - 4, w.x + w.w, w.y + w.h);
        }
        if (w.type === 'mdash') {
            // the M dash: under its cards' top curve (both sides) and round its M stripes
            const ct = w.cardTop, cx0 = Array.isArray(w.card) ? w.card[0] : null;
            if (Array.isArray(ct) && isNum(cx0)) {
                for (let x = cx0; x < 960 - 40; x += 20) {
                    const y = ct[0] * x * x + ct[1] * x + ct[2];
                    if (y > w.h) continue;
                    add(x, y, x + 20, w.h);
                    add(1920 - x - 20, y, 1920 - x, w.h);
                }
            }
            if (Array.isArray(w.mark) && !camera) add(w.mark[0], w.mark[1], w.mark[0] + 54 * (w.mark[2] || 1), w.mark[1] + 22 * (w.mark[2] || 1));
        }
        const sub = Array.isArray(w.boxes) ? w.boxes : Array.isArray(w.tiles) ? w.tiles : null;
        (sub || [w]).forEach((b) => {
            if (!b || !isNum(b.x) || !isNum(b.y) || !isNum(b.w) || !isNum(b.h) || b.w * b.h >= full) return;
            add(b.x, b.y, b.x + b.w, b.y + b.h);
        });
    });
    if (panel && camera) add(visible.CAMERA[0], visible.CAMERA[1], visible.CAMERA[2], visible.CAMERA[3]);
    if (!panel) add(visible.HUD_BMW[0], visible.HUD_BMW[1], visible.HUD_BMW[2], visible.HUD_BMW[3]);
    return out;
}

/** Runs of free columns [x0, x1] for a band of height h starting off px under the top line. */
function spans(target, obs, h, off) {
    const P = SIZE[target], out = [];
    let start = null, last = null;
    for (let x = P.x0; x <= P.x1; x += STEP) {
        const slack = P.tight ? 1 : 2, y0 = topY(target, x) + off - slack, y1 = y0 + h + slack;
        let free = y1 <= P.bottom;
        for (let i = 0; free && i < obs.length; i++) {
            const o = obs[i];
            if (x >= o[0] && x <= o[2] && y1 > o[1] && y0 < o[3]) free = false;
        }
        if (free) { if (start === null) start = x; last = x; }
        else if (start !== null) { out.push([start, last]); start = null; }
    }
    if (start !== null) out.push([start, last]);
    return out.filter((r) => r[1] - r[0] >= P.minSpan);
}

/**
 * The stretches: { spans: [[x0, x1, scale, drop]], len }, or null. The biggest bulbs first, as high as they go; the gaps
 * left are filled with smaller ones (down to 60 % of the biggest used, and only well away from a bigger stretch), each
 * stretch a little apart from the others.
 */
function fit(target, obs) {
    const P = SIZE[target], taken = [], gap = target === 'panel' ? 30 : 12, apart = target === 'panel' ? 140 : 40;
    P.scales.forEach((s) => {
        if (taken.length && s < taken[0][2] * 0.6) return;
        P.offs.forEach((off) => spans(target, obs, need(P, s), off).forEach((r) => {
            // what of r is not taken yet (and keeps clear of the stretches already placed)
            let pieces = [[r[0], r[1]]];
            taken.forEach((t) => {
                const next = [];
                pieces.forEach((q) => {
                    if (q[1] < t[0] - gap || q[0] > t[1] + gap) { next.push(q); return; }
                    if (q[0] < t[0] - gap) next.push([q[0], t[0] - gap]);
                    if (q[1] > t[1] + gap) next.push([t[1] + gap, q[1]]);
                });
                pieces = next;
            });
            // a smaller-bulb piece right next to a bigger stretch reads as a break in it, not as its own string: left out
            const near = (q) => taken.some((t) => t[2] > s && q[0] < t[1] + apart && q[1] > t[0] - apart);
            pieces.forEach((q) => { if (q[1] - q[0] >= P.minSpan && !near(q)) taken.push([q[0], q[1], s, off]); });
        }));
    });
    if (!taken.length) return null;
    taken.sort((a, b) => a[0] - b[0]);
    return { spans: taken, len: taken.reduce((a, q) => a + q[1] - q[0], 0) };
}

/** One stretch of string over [x0, x1]: the wire (points) and the bulbs, in target px. */
function stretch(target, x0, x1, s, off, first) {
    const P = SIZE[target];
    const n = Math.max(1, Math.round((x1 - x0) / (P.swag * s)));
    const hang = [];
    for (let i = 0; i <= n; i++) { const x = x0 + (x1 - x0) * i / n; hang.push([x, topY(target, x) + off]); }
    const sag = P.sag * s, wire = [], bulbs = [];
    const at = (k, t) => {
        const a = hang[k], b = hang[k + 1];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + sag * 4 * t * (1 - t)];
    };
    let idx = first;
    for (let k = 0; k < n; k++) {
        const len = hang[k + 1][0] - hang[k][0];
        const segs = Math.max(2, Math.ceil(len / 3));
        for (let j = k ? 1 : 0; j <= segs; j++) wire.push(at(k, j / segs));
        const m = Math.max(1, Math.round(len / (P.sp * s)));
        for (let j = 0; j < m; j++) {
            const t = (j + 0.5) / m, p = at(k, t);
            // the wire's slope there: a bulb hangs a little along it, and alternately a few degrees left and right
            const a = hang[k], b = hang[k + 1];
            const dy = (b[1] - a[1]) / len + sag * 4 * (1 - 2 * t) / len;
            const ang = Math.atan(dy) * 0.55 + (idx % 2 ? 0.12 : -0.12);
            bulbs.push({ x: p[0], y: p[1], ang, ci: idx });
            idx++;
        }
    }
    return { wire, bulbs };
}

/**
 * The garland widgets for a layout: [] while there is no room. opts.camera: the driver camera notch is on;
 * opts.colors { bulbs: [rgb...], wire: rgb }; opts.cost(list) -> { counts: [layers per connection] } (hud.js's planner)
 * picks the connection: the first that still has room for every stretch, each on its own image layer. When that
 * would take the layout past LAYERS_ALL layers in all (cluster-render draws 32 for every app together) or no
 * connection has the room, the stretches share one image layer (their union box: more pixels, one layer).
 */
function place(target, shown, opts) {
    if (!SIZE[target] || !opts || !opts.colors) return [];
    let f = fit(target, obstacles(target, shown, !!opts.camera)), kind = target;
    if (target === 'hud') {
        // the fairy lights when the full-size string gets less than half as much of the window's top
        const m = fit('micro', obstacles('micro', shown, false)), len = (q) => (q ? q.len : 0);
        if (m && len(m) > 2 * len(f)) { kind = 'micro'; f = m; }
    }
    if (!f) return [];
    const P = SIZE[kind], parts = [];
    const lim = target === 'panel' ? [0, 0, 1920, 720]
        : [visible.HUD_WINDOW.x, visible.HUD_WINDOW.y, visible.HUD_WINDOW.x + visible.HUD_WINDOW.w, visible.HUD_WINDOW.y + visible.HUD_WINDOW.h];
    let first = 0;
    f.spans.forEach((r) => {
        // a stretch from the first to the last free column, its ends a little in from the obstacles
        const s = r[2], glowR = P.glow * s * GLOW_R;
        const st = stretch(kind, r[0] + 4, r[1] - 4, s, r[3], first);
        first += st.bulbs.length;
        if (!st.bulbs.length) return;
        // its box: the wire, the bulbs and their glow, kept within the free columns (and on the HUD the window)
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        const grow = (x, y, rr) => { bx0 = Math.min(bx0, x - rr); by0 = Math.min(by0, y - rr); bx1 = Math.max(bx1, x + rr); by1 = Math.max(by1, y + rr); };
        st.wire.forEach((p) => grow(p[0], p[1], P.wire * s + 1));
        st.bulbs.forEach((b) => { const c = bulbCentre(P, s, b); grow(c[0], c[1], glowR + P.bl * s * 0.5); });
        parts.push({
            x0: Math.max(lim[0], Math.floor(Math.max(bx0, r[0] - P.pad + 2))), x1: Math.min(lim[2], Math.ceil(Math.min(bx1, r[1] + P.pad - 2))),
            y0: Math.max(lim[1], Math.floor(by0)), y1: Math.min(lim[3], Math.ceil(by1)),
            s, wire: st.wire, bulbs: st.bulbs,
        });
    });
    if (!parts.length) return [];
    // one widget for some parts: its box the union of theirs, its geometry in its own px
    const widget = (list, i) => {
        const x0 = Math.min.apply(null, list.map((q) => q.x0)), y0 = Math.min.apply(null, list.map((q) => q.y0));
        const x1 = Math.max.apply(null, list.map((q) => q.x1)), y1 = Math.max.apply(null, list.map((q) => q.y1));
        const bulbs = [];
        list.forEach((q) => q.bulbs.forEach((b) => bulbs.push({ x: b.x - x0, y: b.y - y0, ang: b.ang, ci: b.ci, s: q.s })));
        return {
            id: 'garland_' + i, type: 'garland', own: true,
            class: target === 'panel' ? 'content' : 'overlay', z: target === 'panel' ? 6 : 10,
            x: x0, y: y0, w: x1 - x0, h: y1 - y0,
            g: { P, colors: opts.colors, s: list.map((q) => q.s).join('/'), bulbs, wires: list.map((q) => ({ s: q.s, pts: q.wire.map((p) => [p[0] - x0, p[1] - y0]) })) },
        };
    };
    const tryOn = (out) => {
        if (!opts.cost) return out;
        for (let c = 0; c < 4; c++) {
            out.forEach((w) => { if (c) w.conn = c; else delete w.conn; });
            const k = opts.cost((shown || []).concat(out)).counts;
            if (!k.some((v) => v > 8) && k.reduce((a, v) => a + v, 0) <= LAYERS_ALL) return out;
        }
        return null;
    };
    return tryOn(parts.map((q, i) => widget([q], i))) || (parts.length > 1 && tryOn([widget(parts, 0)])) || [];
}

/** Where a bulb's glass is centred (target or widget px, as b). */
function bulbCentre(P, s, b) {
    const d = (P.capH + P.bl * 0.45) * s;
    return [b.x - Math.sin(b.ang) * d, b.y + Math.cos(b.ang) * d];
}

/** A bulb's box (widget px) with its glow: what a twinkle redraws. */
function bulbRect(w, i) {
    const g = w.g, P = g.P, b = g.bulbs[i], s = b.s, c = bulbCentre(P, s, b);
    const r = Math.max(P.glow * s * GLOW_R, (P.bl * 0.6 + P.capH) * s) + 1;
    const x0 = Math.max(0, Math.floor(c[0] - r)), y0 = Math.max(0, Math.floor(c[1] - r));
    const x1 = Math.min(w.w, Math.ceil(c[0] + r)), y1 = Math.min(w.h, Math.ceil(c[1] + r));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** A bulb's half-width at t (0 the socket, 1 the tip): a C9 bulb, narrow at the neck, full at 40 %, round tip. */
function profile(t) {
    if (t < 0 || t > 1) return 0;
    if (t < 0.38) return 0.62 + 0.38 * Math.sin(t / 0.38 * Math.PI / 2);
    const q = (t - 0.38) / 0.62;
    return Math.pow(Math.max(0, 1 - q * q), 0.62);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The pixels of garland widget w (RGBA, straight alpha) over rect (widget px; null = all) with bulb levels lvl
 * (1 lit, DIM twinkling; missing = 1). Drawn back to front: the glow, the wire, each bulb's socket, glass, glint.
 */
function paint(w, lvl, rect) {
    const g = w.g, P = g.P, col = g.colors;
    const R = rect || { x: 0, y: 0, w: w.w, h: w.h };
    const W = R.w, H = R.h, acc = new Float32Array(W * H * 4);   // premultiplied, 0..1
    const level = (i) => (lvl && isNum(lvl[i]) ? lvl[i] : 1);
    const over = (o, r, gg, b, a) => {
        const k = 1 - a;
        acc[o] = r * a + acc[o] * k; acc[o + 1] = gg * a + acc[o + 1] * k; acc[o + 2] = b * a + acc[o + 2] * k; acc[o + 3] = a + acc[o + 3] * k;
    };
    const box = (cx, cy, r) => ({
        x0: Math.max(R.x, Math.floor(cx - r)), y0: Math.max(R.y, Math.floor(cy - r)),
        x1: Math.min(R.x + W, Math.ceil(cx + r)), y1: Math.min(R.y + H, Math.ceil(cy + r)),
    });
    const bulbColor = (b) => col.bulbs[b.ci % col.bulbs.length];
    // 1 the glow: a soft halo per bulb, added up
    const edge = Math.exp(-GLOW_R * GLOW_R / 2);
    g.bulbs.forEach((b, i) => {
        const s = b.s, sig = P.glow * s, gr = sig * GLOW_R;
        const L = level(i), c = bulbCentre(P, s, b), cc = bulbColor(b), bx = box(c[0], c[1], gr);
        const peak = 0.72 * L * L;
        for (let y = bx.y0; y < bx.y1; y++) for (let x = bx.x0; x < bx.x1; x++) {
            const dx = x + 0.5 - c[0], dy = (y + 0.5 - c[1]) * 0.85, d2 = dx * dx + dy * dy;
            if (d2 > gr * gr) continue;
            const a = peak * (Math.exp(-d2 / (2 * sig * sig)) - edge) / (1 - edge), o = ((y - R.y) * W + (x - R.x)) * 4;
            acc[o] += cc[0] / 255 * a; acc[o + 1] += cc[1] / 255 * a; acc[o + 2] += cc[2] / 255 * a; acc[o + 3] += a;
        }
    });
    for (let o = 0; o < acc.length; o += 4) if (acc[o + 3] > 1) { const k = 1 / acc[o + 3]; acc[o] *= k; acc[o + 1] *= k; acc[o + 2] *= k; acc[o + 3] = 1; }
    // 2 the wire: coverage of a thick polyline (the most of any segment), then over the glow
    const cov = new Float32Array(W * H);
    g.wires.forEach((wr) => { const half = P.wire * wr.s / 2; for (let k = 1; k < wr.pts.length; k++) {
        const a = wr.pts[k - 1], b = wr.pts[k];
        const x0 = Math.max(R.x, Math.floor(Math.min(a[0], b[0]) - half - 1)), x1 = Math.min(R.x + W, Math.ceil(Math.max(a[0], b[0]) + half + 1));
        const y0 = Math.max(R.y, Math.floor(Math.min(a[1], b[1]) - half - 1)), y1 = Math.min(R.y + H, Math.ceil(Math.max(a[1], b[1]) + half + 1));
        const vx = b[0] - a[0], vy = b[1] - a[1], ll = vx * vx + vy * vy || 1;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const px = x + 0.5 - a[0], py = y + 0.5 - a[1];
            const t = clamp01((px * vx + py * vy) / ll), ex = px - vx * t, ey = py - vy * t;
            const c = clamp01(half + 0.5 - Math.sqrt(ex * ex + ey * ey));
            const i = (y - R.y) * W + (x - R.x);
            if (c > cov[i]) cov[i] = c;
        }
    } });
    const wc = col.wire;
    for (let i = 0; i < cov.length; i++) if (cov[i] > 0) over(i * 4, wc[0] / 255, wc[1] / 255, wc[2] / 255, cov[i]);
    // 3 the bulbs: socket, glass, glint, in the bulb's own frame (u across, v down from the wire)
    g.bulbs.forEach((b, i) => {
        const s = b.s, capH = P.capH * s, capW = P.capW * s / 2, bl = P.bl * s, bw = P.bw * s;
        const L = level(i), cc = bulbColor(b), ca = Math.cos(b.ang), sa = Math.sin(b.ang);
        const c = bulbCentre(P, s, b), bx = box(c[0], c[1], bl * 0.6 + capH + 2);
        const lit = 0.25 + 0.75 * L;
        for (let y = bx.y0; y < bx.y1; y++) for (let x = bx.x0; x < bx.x1; x++) {
            const px = x + 0.5 - b.x, py = y + 0.5 - b.y;
            const u = px * ca + py * sa, v = -px * sa + py * ca;      // v: along the bulb, down
            const o = ((y - R.y) * W + (x - R.x)) * 4;
            // the socket: a short dark cylinder from the wire down to the glass, a lighter rim at its foot
            if (v > -0.8 && v < capH + 0.8) {
                const ws = capW * (0.8 + 0.2 * v / capH);
                const a = clamp01(ws + 0.5 - Math.abs(u)) * clamp01(v + 0.8) * clamp01(capH + 0.8 - v);
                if (a > 0) {
                    const shade = 0.75 + 0.5 * clamp01(1 - Math.abs(u) / ws) + (v > capH - 1.2 ? 0.25 : 0);
                    over(o, Math.min(1, wc[0] / 255 * shade * 1.3), Math.min(1, wc[1] / 255 * shade * 1.3), Math.min(1, wc[2] / 255 * shade * 1.3), a);
                }
            }
            // the glass
            const t = (v - capH + 0.3) / bl;
            if (t < -0.05 || t > 1.05) continue;
            const hw = bw * profile(clamp01(t));
            let a = clamp01(hw + 0.5 - Math.abs(u)) * clamp01((t + 0.02) * bl + 0.5) * clamp01((1 - t) * bl + 0.6);
            if (a <= 0) continue;
            const across = hw > 0 ? Math.abs(u) / hw : 1;                    // 0 middle .. 1 rim
            const core = Math.exp(-Math.pow((t - 0.42) / 0.3, 2)) * (1 - across * across);
            // the rim a little darker than the middle, the tip lit up again (light gathers in the point of a C9)
            const tip = t > 0.72 ? (t - 0.72) / 0.28 : 0;
            const rim = Math.min(1, 0.72 + 0.28 * (1 - across * across) + 0.22 * tip);
            let r = cc[0] / 255 * rim * lit, gg = cc[1] / 255 * rim * lit, bb = cc[2] / 255 * rim * lit;
            const hot = 0.62 * core * L * L;                                // the filament's white heat in the middle
            r += (1 - r) * hot; gg += (1 - gg) * hot; bb += (1 - bb) * hot;
            // the glint: a small soft white highlight on the upper left of the glass
            const gu = (u + hw * 0.42) / Math.max(0.8, bw * 0.28), gv = (t - 0.3) / 0.13;
            const glint = 0.55 * Math.exp(-(gu * gu + gv * gv)) * (0.5 + 0.5 * L);
            r += (1 - r) * glint; gg += (1 - gg) * glint; bb += (1 - bb) * glint;
            over(o, r, gg, bb, a);
        }
    });
    const out = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        const o = i * 4, a = acc[o + 3];
        if (a <= 0.002) continue;
        out[o] = Math.round(Math.min(1, acc[o] / a) * 255);
        out[o + 1] = Math.round(Math.min(1, acc[o + 1] / a) * 255);
        out[o + 2] = Math.round(Math.min(1, acc[o + 2] / a) * 255);
        out[o + 3] = Math.round(Math.min(1, a) * 255);
    }
    return out;
}

/**
 * The twinkle of one garland widget: while the car stands a few bulbs dim for a moment, at most every TWINKLE_MS;
 * moving, every bulb is lit and nothing changes. step() says which bulbs changed (indexes), lvl holds the levels.
 */
class Twinkle {
    constructor(w) {
        this.w = w;
        this.n = w.g.bulbs.length;
        this.lvl = [];
        this.hold = [];
        for (let i = 0; i < this.n; i++) { this.lvl.push(1); this.hold.push(0); }
        this.at = 0;
    }

    step(now, standing) {
        if (now - this.at < TWINKLE_MS) return [];
        this.at = now;
        const changed = [];
        if (!standing) {
            for (let i = 0; i < this.n; i++) if (this.lvl[i] !== 1) { this.lvl[i] = 1; this.hold[i] = 0; changed.push(i); }
            return changed;
        }
        for (let i = 0; i < this.n; i++) {
            if (this.lvl[i] !== 1 && --this.hold[i] <= 0) { this.lvl[i] = 1; changed.push(i); }
        }
        // about one bulb in twenty dims for one to three steps
        const k = Math.max(1, Math.round(this.n / 20));
        for (let j = 0; j < k; j++) {
            const i = Math.floor(Math.random() * this.n);
            if (this.lvl[i] !== 1 || changed.indexOf(i) >= 0) continue;
            this.lvl[i] = DIM; this.hold[i] = 1 + Math.floor(Math.random() * 3); changed.push(i);
        }
        return changed;
    }

    /** The rects (widget px) to redraw for these bulbs, overlapping ones merged. */
    rects(list) {
        const rs = [];
        list.forEach((i) => {
            const r = bulbRect(this.w, i);
            if (!r) return;
            const hit = rs.find((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h);
            if (!hit) { rs.push(r); return; }
            const x0 = Math.min(hit.x, r.x), y0 = Math.min(hit.y, r.y);
            hit.w = Math.max(hit.x + hit.w, r.x + r.w) - x0; hit.h = Math.max(hit.y + hit.h, r.y + r.h) - y0; hit.x = x0; hit.y = y0;
        });
        return rs;
    }
}

module.exports = { place, paint, Twinkle, obstacles, fit, SIZE, TWINKLE_MS };
