'use strict';
/**
 * calc.js - the ethanol blend arithmetic, pure functions (Node 8: no optional chaining).
 *
 * blend({ litres, can, target, purity, tank }): how much ethanol (at `purity` %) to add to the `litres` in
 * the tank, which the sensor reads at `can` % ethanol, to reach `target` %. Volumes are taken as additive
 * (the contraction when ethanol and petrol mix is under 1 %), the ethanol balance gives
 *     (V·C + x·P) / (V + x) = T   ->   x = V · (T - C) / (P - T)
 * with V the litres in the tank and C, T, P the fractions. Valid with V > 0, T > C and P > T.
 *
 * Returns { status, litres, gallons, totalLitres, overflowLitres }:
 *   status  'ok' | 'no-fuel' (no tank reading) | 'no-ethanol' (no CAN reading) | 'reached' (target at or
 *           under the content) | 'purity' (the ethanol is not purer than the target: impossible by adding it)
 *   litres / gallons        the ethanol to add (one decimal; US gallons); null unless 'ok'
 *   totalLitres             the tank afterwards; overflowLitres: what would not fit in `tank` litres (0 if it fits)
 * A later version adds a second output (pump petrol + ethanol); it will sit beside blend() and reuse the helpers.
 */
const GAL = 3.785411784;            // litres in a US gallon

const isNum = (x) => typeof x === 'number' && isFinite(x);
const round1 = (x) => Math.round(x * 10) / 10;
const toGallons = (litres) => litres / GAL;

function blend(i) {
    const V = i.litres, C = i.can, T = i.target, P = i.purity, tank = i.tank;
    const out = { status: 'ok', litres: null, gallons: null, totalLitres: null, overflowLitres: null };
    if (!isNum(V) || V <= 0) { out.status = 'no-fuel'; return out; }
    if (!isNum(C)) { out.status = 'no-ethanol'; return out; }
    if (!isNum(T) || T <= C) { out.status = 'reached'; return out; }
    if (!isNum(P) || P <= T) { out.status = 'purity'; return out; }
    const add = V * (T - C) / (P - T);
    out.litres = round1(add);
    out.gallons = round1(toGallons(add));
    out.totalLitres = round1(V + add);
    out.overflowLitres = isNum(tank) ? round1(Math.max(0, V + add - tank)) : 0;
    return out;
}

/**
 * pickFuel(all, mode): the litres the dial and the calculator use, from what the car gave:
 * all = { dme (the DME's two tank halves added, 0.5 l), kombi (the cluster's litres) }, each null when not
 * read. mode = the "Fuel source" setting: 'auto' takes the DME halves when there are, else the cluster;
 * 'dme' / 'kombi' take that one or nothing. Returns { litres, source } (source null when nothing).
 */
const ORDER = ['dme', 'kombi'];
function pickFuel(all, mode) {
    const a = all || {};
    const by = { dme: isNum(a.dme) ? a.dme : null, kombi: isNum(a.kombi) ? a.kombi : null };
    if (ORDER.indexOf(mode) >= 0) return { litres: by[mode], source: by[mode] == null ? null : mode };
    for (let i = 0; i < ORDER.length; i++) if (by[ORDER[i]] != null) return { litres: by[ORDER[i]], source: ORDER[i] };
    return { litres: null, source: null };
}

module.exports = { GAL, round1, toGallons, blend, pickFuel, ORDER };
