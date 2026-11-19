'use strict';
/**
 * Holiday editions of a cluster theme (Ribbon, Nov 2026). The "holiday" setting: "off", "auto" (by the date) or one
 * holiday by key (Halloween was taken out in Cluster Themes 0.16.0; a saved "halloween" now means none). A layout whose theme has `holidays: true` is drawn in the theme "<theme>_<key>" while one is on.
 * Auto windows (local date, US calendar):
 *   thanks     the Monday before Thanksgiving (4th Thursday of November) .. the Sunday after
 *   xmas       Dec 1 .. Dec 26
 *   newyear    Dec 27 .. Jan 2
 *   july4      Jul 1 .. Jul 5
 */
const KEYS = ['xmas', 'thanks', 'newyear', 'july4'];

/** The 4th Thursday of November in year y (day of the month). */
function thanksgiving(y) {
    const first = new Date(Date.UTC(y, 10, 1)).getUTCDay();          // 0 = Sunday
    return 1 + ((4 - first + 7) % 7) + 21;
}

/** The holiday on a date (month 1..12), or null. */
function onDate(y, m, d) {
    if (m === 11) { const t = thanksgiving(y); if (d >= t - 3 && d <= t + 3) return 'thanks'; }
    if (m === 12 && d <= 26) return 'xmas';
    if ((m === 12 && d >= 27) || (m === 1 && d <= 2)) return 'newyear';
    if (m === 7 && d <= 5) return 'july4';
    return null;
}

/** The holiday a setting value picks on a date: null for off, none in season, or an unknown value. */
function pick(setting, y, m, d) {
    if (setting === 'auto') return onDate(y, m, d);
    return KEYS.indexOf(setting) >= 0 ? setting : null;
}

module.exports = { KEYS, onDate, pick, thanksgiving };
