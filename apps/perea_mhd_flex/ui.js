'use strict';
/**
 * ui.js - the Flex Fuel screen: three dials across the top (ethanol Active and CAN with their % in the
 * middle, and the fuel in the tank in US gallons with the litres under it), and two columns below.
 * Left, the blend calculator: the target row ("Target ethanol 85 %" with -5 / +5 buttons where the kit
 * runs the screen), the result ("Ethanol to add 2.6 gal (9.8 L)", or why there is none) and a detail
 * line (purity and the tank afterwards, or an overflow warning). Right, the link's state: a note
 * (green "Flex fuel active" while the tune uses the ethanol, "Flex fuel disabled" when Active is 0, in
 * amber when the sensor still reads ethanol; the link's state otherwise) and a detail line. The logo
 * sits bottom right. When Active and CAN are GAP points or more apart (the tune still blending after a
 * fill-up, or a sensor the map does not follow) the header says MISMATCH.
 *
 * GPU-safe: arc / circle / line / text / roundRect / fillRect only (the car's Recorder has no polygons).
 * v = Poller.view() + { demo, fuel (litres, from the source picked), fuelSource ('dme' | 'kombi' |
 * 'demo' | null), fuelAll (every source's reading, for the sources line), showSources (the setting),
 * target, purity, tankCap (%, %, litres: the settings), setTarget(delta) }; LOGO = logo.js (runs of a
 * palette; `ink` entries take the theme's text colour). With showSources a line along the bottom compares
 * the cluster's litres (and its halves as sent) with the DME's halves and total.
 */
const { withAlpha, rgba } = require('./kit/canvas');
const C = require('./calc');

const W = 1600, H = 520;
const GO = '#2fd27a';
const GAP = 10;                 // percentage points between Active and CAN that count as a mismatch
const DIAL_R = 135, DIAL_Y = 200, DIAL_X = [330, 800, 1270];
const LITRES_Y = 288;           // baseline of the litres under the fuel dial's "gal"
const COL_L = 70, VAL_X = 270, COL_R = 1070;              // left column (calculator), its values, right column (link)
const ROW_T = 330, ROW_R = 410, ROW_D = 446;              // target buttons' top; result and detail baselines
const BTN_W = 76, BTN_H = 42, BTN_X = [372, 462];
const SEP_X = 740;
const SOURCES_Y = 484;          // baseline of the fuel sources line (showSources)
const SOURCE_NAMES = { dme: 'DME', kombi: 'Kombi' };
const TARGET_STEP = 5;
const DEFAULTS = { target: 85, purity: 99, tank: 60 };    // (the settings' defaults, for a view without them)

const isNum = (x) => typeof x === 'number' && isFinite(x);
const live = (v) => v.state === 'reading' && v.active != null && v.can != null;

/** Active and CAN both readable, the tune using ethanol, and the two GAP points or more apart. */
function mismatch(v) { return live(v) && v.active > 0 && Math.abs(v.active - v.can) >= GAP; }

/** Active at 0 while the sensor reads ethanol: a map without flex fuel, or one that ignores the sensor. */
function sensorOnly(v) { return live(v) && v.active === 0 && v.can > 0; }

/** The note under the dials for a state: [text, colour]. */
function note(v, t) {
    switch (v.state) {
        case 'reading':
            if (v.active == null) return ['Waiting for the DME', t.dim];
            if (v.active > 0) return ['Flex fuel active', t.go || GO];
            return ['Flex fuel disabled', sensorOnly(v) ? t.warn : t.dim];
        case 'no-link': return ['No diagnostic link', t.dim];
        case 'link-down': return ['Diagnostic link down', t.dim];
        case 'probing': return ['Looking for MHD on the DME', t.dim];
        case 'no-mhd': return ['MHD not found on the DME', t.warn];
        case 'identifying': return ['Identifying the DME', t.dim];
        case 'unsupported-rom': return ['ROM not supported', t.warn];
        case 'defining': return ['Defining data identifier', t.dim];
        case 'error': return ['Waiting for the DME', t.warn];
        default: return ['', t.dim];
    }
}

/** The header badge for a state (none while live and consistent); draw() adds DEMO beside it. */
function badge(v, t) {
    switch (v.state) {
        case 'no-link': case 'link-down': return { text: 'NO LINK' };
        case 'no-mhd': return { text: 'NO MHD', color: t.warn };
        case 'unsupported-rom': return { text: 'OTHER ROM', color: t.warn };
        case 'error': return { text: 'DME ERROR', color: t.warn };
        case 'reading':
            if (v.stale) return { text: 'LINK STALE', color: t.warn };
            return mismatch(v) ? { text: 'MISMATCH', color: t.warn } : null;
        default: return null;
    }
}

/**
 * The line under the note: the ids seen on an unknown ROM; why the loop is waiting and the last
 * exchange in `error`; the last exchange's bytes while a value is not readable (what the DME really
 * answered); the mismatch or the sensor's reading while the tune disagrees with it; else the
 * profile and identifier in use. { text, colour, literal } (literal: not translated).
 */
function detail(v, t) {
    const lit = (text) => ({ text, colour: t.dim, literal: true });
    if (v.state === 'unsupported-rom') return lit(v.seen && v.seen.length ? v.seen.join('  ') : '');
    if (v.state === 'error') return lit([v.reason, v.lastReply].filter(Boolean).join('  ·  '));
    if (v.state !== 'reading') return lit('');
    if ((v.active == null || v.can == null) && !v.demo) return lit(v.lastReply || '');
    if (mismatch(v)) return { text: 'Active and CAN differ', colour: t.warn, literal: false };
    if (sensorOnly(v)) return { text: 'Sensor reads ' + v.can + ' %', colour: t.warn, literal: false };
    if (v.mhd && v.profile) return lit(v.profile + (v.did ? '  ·  ' + v.did : ''));
    return lit('');
}

/** The calculator's inputs from the view: the fuel and CAN readings, the settings (their defaults when missing). */
function inputs(v) {
    return {
        litres: isNum(v.fuel) ? v.fuel : null, can: isNum(v.can) ? v.can : null,
        target: isNum(v.target) ? v.target : DEFAULTS.target,
        purity: isNum(v.purity) ? v.purity : DEFAULTS.purity,
        tank: isNum(v.tankCap) ? v.tankCap : DEFAULTS.tank,
    };
}

/** The litres under the fuel dial's gallons and where they come from: '(24.5 L · DME)', or '--' without a reading. */
function fuelLine(v) {
    if (!isNum(v.fuel)) return '--';
    const src = SOURCE_NAMES[v.fuelSource];
    return '(' + v.fuel.toFixed(1) + ' L' + (src ? ' \u00b7 ' + src : '') + ')';
}

/**
 * Every fuel source side by side (the "Show fuel sources" setting), to compare them with the cluster's gauge:
 * the cluster's litres with its two halves as sent, and the DME's halves and their sum with its whole-tank
 * identifier. '--' where nothing came.
 */
function sourcesLine(v) {
    const a = v.fuelAll || {};
    const n = (x, d) => (isNum(x) ? x.toFixed(d) : '--');
    return 'Kombi ' + n(a.kombi, 0) + ' L (L ' + n(a.kombiL, 0) + ' R ' + n(a.kombiR, 0) + ')   \u00b7   DME ' + n(a.dmeL, 1) + ' + ' + n(a.dmeR, 1) + ' = ' + n(a.dme, 1) + ' L (583B ' + n(a.dmeTotal, 0) + ' L)';
}

/**
 * The result row and its detail line: { text, colour, literal, detail: { text, colour } }. The number
 * ("2.6 gal (9.8 L)") is literal; the texts for the other states are translated. The detail says the
 * purity in use and the tank afterwards ("16.3 / 60 L"), or that the blend would not fit.
 */
function result(v, t) {
    const i = inputs(v), r = C.blend(i);
    const purity = { text: 'Purity' + ' ' + i.purity + ' %', colour: t.dim };
    const other = (text, colour) => ({ text, colour, literal: false, detail: purity });
    switch (r.status) {
        case 'no-fuel': return other('No fuel reading', t.dim);
        case 'no-ethanol': return other('No ethanol reading', t.dim);
        case 'reached': return other('Target reached', t.dim);
        case 'purity': return other('Purity below target', t.warn);
        default: break;
    }
    const detailLine = r.overflowLitres > 0
        ? { text: 'Exceeds tank capacity' + ' (+' + r.overflowLitres.toFixed(1) + ' L)', colour: t.warn }
        : { text: purity.text + '   ·   ' + 'Tank after' + ' ' + r.totalLitres.toFixed(1) + ' / ' + i.tank + ' L', colour: t.dim };
    return { text: r.gallons.toFixed(1) + ' gal (' + r.litres.toFixed(1) + ' L)', colour: t.accent, literal: true, detail: detailLine };
}

/** The logo as a cached layer: one fillRect per run; ink runs in the theme's text colour at the baked alpha. */
function logoLayer(G, t, LOGO, textScale) {
    return G.layer('perea_mhd_flex_logo|' + t.name, LOGO.w, LOGO.h, (c) => {
        const colours = LOGO.palette.map((p, i) => (LOGO.ink.indexOf(i) >= 0 ? withAlpha(t.text, rgba(p)[3] / 255) : p));
        LOGO.runs.forEach((r) => c.fillRect(r[1], r[0], r[2], 1, colours[r[3]]));
    }, textScale);
}

function draw(cv, G, t, v, LOGO) {
    cv.clear(t.bg);
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
    // the label is drawn here, not by the dial: the dial's cached layer is only as wide as the dial and cuts a long one
    const dial = (cx, label, color, g) => {
        G.radial(cv, t, cx, DIAL_Y, DIAL_R, Object.assign({ min: 0, max: 100, unit: '%', decimals: 0, ticks: 10, majorEvery: 2, hot: false, color }, g));
        cv.text(label.toUpperCase(), cx, DIAL_Y + DIAL_R * 0.82, 26, t.text, { align: 'center', font: 'bold', spacing: 1.5 });
    };
    const i = inputs(v);
    dial(DIAL_X[0], 'Ethanol Content (Active)', 'accent', { value: v.active });
    dial(DIAL_X[1], 'Ethanol Content (CAN)', 'accent2', { value: v.can });
    // the tank in US gallons over the capacity set (the scale changes with the setting: ticks without numbers)
    dial(DIAL_X[2], 'Fuel in tank', 'accent', { value: i.litres == null ? null : C.toGallons(i.litres), max: Math.max(1, i.tank) / C.GAL, unit: 'gal', decimals: 1, tickLabels: false });
    cv.text(fuelLine(v), DIAL_X[2], LITRES_Y, 20, t.dim, { align: 'center', font: 'label', literal: true });

    // left: the calculator. The buttons draw (and take taps / the controller) only where the kit runs the screen.
    const ty = ROW_T + BTN_H / 2 + BTN_H * 0.15;                      // the buttons' text baseline
    cv.text('Target ethanol'.toUpperCase(), COL_L, ty, 20, t.dim, { font: 'bold', spacing: 2 });
    cv.text(i.target + ' %', VAL_X, ty, 30, t.text, { font: 'num', literal: true });
    G.button(cv, t, BTN_X[0], ROW_T, BTN_W, BTN_H, '-5', () => (v.setTarget ? v.setTarget(-TARGET_STEP) : null), { key: 'target-5' });
    G.button(cv, t, BTN_X[1], ROW_T, BTN_W, BTN_H, '+5', () => (v.setTarget ? v.setTarget(TARGET_STEP) : null), { key: 'target+5' });
    const r = result(v, t);
    cv.text('Ethanol to add', COL_L, ROW_R, 24, t.text, { font: 'bold' });
    cv.text(r.text, VAL_X, ROW_R, r.literal ? 30 : 22, r.colour, { font: r.literal ? 'num' : 'bold', literal: r.literal });
    cv.text(r.detail.text, COL_L, ROW_D, 18, r.detail.colour, { font: 'label' });
    cv.fillRect(SEP_X, ROW_T + 5, 1, 120, withAlpha(t.text, 0.12));

    // right: the link's state
    const [text, colour] = note(v, t);
    cv.text(text, COL_R, ROW_R, 26, colour, { align: 'center', font: 'bold', spacing: 1.5 });
    const d = detail(v, t);
    if (d.text) cv.text(d.text, COL_R, ROW_D, 16, d.colour, { align: 'center', font: 'label', literal: d.literal });

    if (v.showSources) cv.text(sourcesLine(v), COL_L, SOURCES_Y, 18, t.dim, { font: 'label', literal: true });

    if (LOGO && LOGO.runs && LOGO.runs.length) {
        const y = G.pageBottom(cv) - G.MARGIN - LOGO.h;
        cv.blit(logoLayer(G, t, LOGO, cv.textScale), W - 24 - G.MARGIN - LOGO.w, y);
    }
    G.frame(cv, t, ['Flex Fuel'], 0, [v.demo ? { text: 'DEMO' } : null, badge(v, t)]);
}

module.exports = { draw, note, badge, detail, mismatch, sensorOnly, inputs, fuelLine, sourcesLine, result, W, H, GO, GAP, TARGET_STEP, DEFAULTS, SOURCE_NAMES };
