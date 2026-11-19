'use strict';
/**
 * smart_temps.js - temperatures that speak up only when they matter (both apps), after cauliflowermossgrape's
 * Redline readouts (apps/redline/hud.js readoutsFor / TEMPS, README "Readouts", MIT).
 *
 * Bands (always in deg C, whatever is shown):
 *   oil      cold under 60 (blue), warming 60..80 (yellow; 80 = the cold guard's warm oil), hot over "warnOil" (red;
 *            130 when that warning is Off)
 *   coolant  cold under 60 (blue), hot over "warnCoolant" (red; 112 when that warning is Off)
 *   outside  3 and under: blue (ice is possible). Always, whatever the setting.
 * Anything else is normal: no colour of its own.
 *
 * Setting "smartTemps" ("Show temperatures only when they matter", off by default). While it is on:
 *  - a text with "showWhen": "abnormal" is empty while its temperature is normal (or not known yet). Its temperature
 *    is the one its text shows: {{oil}}, {{coolant}}, or a readout slot token ({{slot:N}}, {{slotHeadU:N}}, ...: the
 *    sensor that slot shows); "abnormal:oil" / "abnormal:coolant" names it (a plain label such as "OIL"). A slot
 *    showing anything but oil or coolant is never hidden. Outside and intake are never hidden.
 *  - an oil / coolant value is drawn in its band's colour (a hot one still flashes while over its warning limit).
 *  - bumping: an oil or coolant temperature over its hot limit that nothing on screen shows takes over the last
 *    shown readout slot with a plain reading (not engine speed, speed, the shift point or a temperature), until it
 *    is back under; the driver's own pick is kept (slots.json is not touched).
 *
 *   smartTemps.hidden(hud, w) -> true: draw the text empty
 *   smartTemps.role(hud, w, role) -> the colour role (or rgba) to draw it in
 *   smartTemps.bumpTick(hud) -> sets hud.slotBumps { slot id: sensor id } (once a second is plenty)
 * Plain Node 8 (the car's 8.16.2).
 */
const { VERDICT, LIGHTS } = require('./hud_themes');

const COLD = 60, WARM_OIL = 80, ICE = 3;
const HOT_DEFAULT = { oil: 130, coolant: 112 };          // Redline's, when our warning is Off (0)
const WARN_KEY = { oil: 'warnOil', coolant: 'warnCoolant' };
const BAND_COLOR = { cold: VERDICT.COLD, warm: LIGHTS.yellow.concat([255]), ice: VERDICT.COLD };
const HIDES = { oil: true, coolant: true };
// never bumped out of their slot: what a driver reads to drive
const KEEP = { rpm: true, speed: true, shiftAt: true, oil: true, coolant: true };
const VALUE_TOKENS = /\{\{(slot:[A-Za-z0-9]+|oil|coolant|ambient|ambientN)\}\}/;
const isNum = (v) => typeof v === 'number' && isFinite(v);

function on(hud) { return !!hud.ctx.settings.item('smartTemps') && hud.setting('smartTemps') === true; }

/** The temperature (sensor id) a text widget is about, or null. */
function tempOf(hud, w) {
    const sw = typeof w.showWhen === 'string' ? w.showWhen : '';
    if (sw.indexOf('abnormal:') === 0) return sw.slice(9);
    const t = String(w.text || '');
    const m = t.match(/\{\{slot(?:Head|HeadU|HeadS|Unit|Suffix)?:([A-Za-z0-9]+)\}\}/);
    if (m) { const sn = hud.slotSensor(hud.activeName, m[1], hud.layoutSlots); return sn ? sn.id : null; }
    if (t.indexOf('{{oil}}') >= 0) return 'oil';
    if (t.indexOf('{{coolant}}') >= 0) return 'coolant';
    if (t.indexOf('{{ambient}}') >= 0 || t.indexOf('{{ambientN}}') >= 0) return 'ambient';
    return null;
}

/** 'cold' | 'warm' | 'hot' | 'ice' | null (normal, or no reading) for a sensor id now. */
function band(hud, id) {
    const v = hud._raw(id);
    if (!isNum(v)) return null;
    if (id === 'ambient') return v <= ICE ? 'ice' : null;
    if (!WARN_KEY[id]) return null;
    const lim = hud.setting(WARN_KEY[id]), hot = isNum(lim) && lim > 0 ? lim : HOT_DEFAULT[id];
    if (v > hot) return 'hot';
    if (v < COLD) return 'cold';
    if (id === 'oil' && v < WARM_OIL) return 'warm';
    return null;
}

function hidden(hud, w) {
    if (typeof w.showWhen !== 'string' || w.showWhen.indexOf('abnormal') !== 0 || !on(hud)) return false;
    const id = tempOf(hud, w);
    return !!HIDES[id] && band(hud, id) === null;
}

function role(hud, w, r) {
    if (r !== (w.color || 'fg')) return r;              // something else (a grade, the shift point) already coloured it
    if (!VALUE_TOKENS.test(String(w.text || ''))) return r;   // a label: keeps its colour
    const id = tempOf(hud, w), b = id ? band(hud, id) : null;
    if (b === 'ice') return BAND_COLOR.ice;              // always
    if (!b || !on(hud)) return r;
    // hot: steady red only when no warning limit is set; over a set limit the usual flash (hud.js) shows it
    if (b === 'hot') return hud._warning(w) && w.warnFlash !== false ? r : 'hot';
    return BAND_COLOR[b];
}

/** Which shown readout slot shows a hot temperature that is on screen nowhere else (see the header). */
function bumpTick(hud) {
    const was = hud.slotBumps || {};
    const now = {};
    if (on(hud) && hud.activeName && hud.activeName !== 'off') {
        const shown = hud.shown || [], slots = [], direct = {};
        shown.forEach((w) => {
            const t = String(w.text || ''), re = /\{\{slot:([A-Za-z0-9]+)\}\}/g;
            let m;
            while ((m = re.exec(t))) if (slots.indexOf(m[1]) < 0) slots.push(m[1]);
            if (t.indexOf('{{oil}}') >= 0) direct.oil = true;
            if (t.indexOf('{{coolant}}') >= 0) direct.coolant = true;
        });
        const order = (hud.layoutSlots || []).map((s) => s.id).filter((id) => slots.indexOf(id) >= 0);
        const pick = {};
        order.forEach((id) => { const sn = hud.slotSensor(hud.activeName, id, hud.layoutSlots, true); pick[id] = sn ? sn.id : null; });
        ['oil', 'coolant'].forEach((id) => {
            if (band(hud, id) !== 'hot' || direct[id] || order.some((s) => pick[s] === id)) return;
            const keep = Object.keys(was).find((s) => was[s] === id && order.indexOf(s) >= 0);
            if (keep) { now[keep] = id; return; }
            for (let i = order.length - 1; i >= 0; i--) {
                const s = order[i];
                if (now[s] || KEEP[pick[s]]) continue;
                now[s] = id;
                hud.log.info('smart temps: ' + id + ' is hot, shown in readout slot ' + s + ' instead of ' + (pick[s] || 'nothing') + ' until it cools');
                break;
            }
        });
    }
    if (JSON.stringify(now) !== JSON.stringify(was)) {
        if (!Object.keys(now).length && Object.keys(was).length) hud.log.info('smart temps: readout slots back to their own picks');
        hud.slotBumps = now;
        hud.widgets.forEach((x) => { x.last = null; });
    }
}

module.exports = { hidden, role, bumpTick, band, tempOf, BANDS: { COLD, WARM_OIL, ICE, HOT_DEFAULT } };
