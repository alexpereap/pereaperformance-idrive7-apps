'use strict';
/**
 * Small line icons, drawn here (no image files): straight RGBA for an image layer, w x h, in one colour.
 * Each icon is a distance function in a 0..1 box; coverage is anti-aliased over one pixel.
 *   gauge (engine), shock (chassis), wheel (steering), cog (gearbox), stack (the gear's shift program
 *   lines), therm (coolant), oilcan (oil), fuel (pump), tyre (a wheel seen from the side: ring, hub, tread notches).
 */
function seg(px, py, ax, ay, bx, by) {
    const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
    const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
    return Math.hypot(pax - bax * h, pay - bay * h);
}
const ring = (px, py, cx, cy, r) => Math.abs(Math.hypot(px - cx, py - cy) - r);
const disc = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;
function arc(px, py, cx, cy, r, a0, a1) {          // clockwise from 12 o'clock, radians, a0 < a1
    let a = Math.atan2(px - cx, -(py - cy)); if (a < a0) a += Math.PI * 2;
    if (a <= a1) return Math.abs(Math.hypot(px - cx, py - cy) - r);
    const e = (b) => Math.hypot(px - (cx + r * Math.sin(b)), py - (cy - r * Math.cos(b)));
    return Math.min(e(a0), e(a1));
}

/** Distance (in box units) from (x, y) to the icon's ink; < 0 or < stroke half-width = ink. */
const ICONS = {
    gauge: (x, y) => Math.min(arc(x, y, 0.5, 0.55, 0.36, -0.75 * Math.PI, 0.75 * Math.PI) - 0.045, seg(x, y, 0.5, 0.55, 0.7, 0.36) - 0.045, disc(x, y, 0.5, 0.55, 0.07)),
    shock: (x, y) => Math.min(seg(x, y, 0.24, 0.78, 0.5, 0.52) - 0.11, seg(x, y, 0.5, 0.52, 0.78, 0.24) - 0.035, seg(x, y, 0.14, 0.88, 0.2, 0.82) - 0.05, seg(x, y, 0.8, 0.22, 0.86, 0.16) - 0.05),
    wheel: (x, y) => Math.min(ring(x, y, 0.5, 0.5, 0.38) - 0.055, disc(x, y, 0.5, 0.55, 0.1), seg(x, y, 0.14, 0.5, 0.42, 0.55) - 0.05, seg(x, y, 0.58, 0.55, 0.86, 0.5) - 0.05, seg(x, y, 0.5, 0.62, 0.5, 0.86) - 0.05),
    cog: (x, y) => {
        let d = Math.min(ring(x, y, 0.5, 0.5, 0.27) - 0.06, ring(x, y, 0.5, 0.5, 0.1) - 0.04);
        for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; d = Math.min(d, seg(x, y, 0.5 + 0.3 * Math.sin(a), 0.5 - 0.3 * Math.cos(a), 0.5 + 0.42 * Math.sin(a), 0.5 - 0.42 * Math.cos(a)) - 0.06); }
        return d;
    },
    stack: (x, y) => Math.min(seg(x, y, 0.1, 0.22, 0.62, 0.22) - 0.055, seg(x, y, 0.1, 0.5, 0.78, 0.5) - 0.06, seg(x, y, 0.1, 0.8, 0.92, 0.8) - 0.075),
    therm: (x, y) => Math.min(seg(x, y, 0.42, 0.14, 0.42, 0.6) - 0.07, disc(x, y, 0.42, 0.74, 0.14), seg(x, y, 0.6, 0.24, 0.76, 0.24) - 0.035, seg(x, y, 0.6, 0.4, 0.76, 0.4) - 0.035),
    fuel: (x, y) => Math.min(Math.max(Math.abs(x - 0.38) - 0.18, Math.abs(y - 0.55) - 0.33, -Math.max(Math.abs(x - 0.38) - 0.1, Math.abs(y - 0.36) - 0.08)), seg(x, y, 0.12, 0.9, 0.64, 0.9) - 0.04, seg(x, y, 0.56, 0.36, 0.76, 0.48) - 0.04, seg(x, y, 0.76, 0.48, 0.76, 0.78) - 0.04, seg(x, y, 0.76, 0.78, 0.66, 0.84) - 0.04),
    tyre: (x, y) => {
        let d = Math.min(ring(x, y, 0.5, 0.5, 0.4) - 0.075, ring(x, y, 0.5, 0.5, 0.17) - 0.04);
        for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + Math.PI / 8; d = Math.min(d, seg(x, y, 0.5 + 0.42 * Math.sin(a), 0.5 - 0.42 * Math.cos(a), 0.5 + 0.49 * Math.sin(a), 0.5 - 0.49 * Math.cos(a)) - 0.04); }
        return d;
    },
    oilcan: (x, y) => Math.min(seg(x, y, 0.2, 0.62, 0.6, 0.62) - 0.12, seg(x, y, 0.6, 0.58, 0.9, 0.44) - 0.04, disc(x, y, 0.92, 0.66, 0.05), seg(x, y, 0.3, 0.46, 0.3, 0.34) - 0.035, seg(x, y, 0.22, 0.34, 0.38, 0.34) - 0.04),
};

function paintIcon(name, w, h, color) {
    const f = ICONS[name], out = Buffer.alloc(w * h * 4, 0);
    if (!f) return out;
    const s = Math.min(w, h), ox = (w - s) / 2, oy = (h - s) / 2, aa = 1 / s;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const d = f((x + 0.5 - ox) / s, (y + 0.5 - oy) / s);
            const a = Math.max(0, Math.min(1, 0.5 - d / aa));
            if (a <= 0) continue;
            const o = (y * w + x) * 4;
            out[o] = color[0]; out[o + 1] = color[1]; out[o + 2] = color[2]; out[o + 3] = Math.round(a * (color[3] === undefined ? 255 : color[3]));
        }
    }
    return out;
}

module.exports = { paintIcon, ICONS };
