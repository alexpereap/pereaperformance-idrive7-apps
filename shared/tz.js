'use strict';
/**
 * Time zones for the clock. The head unit's clock runs on UTC and no car signal gives the local zone (issues #6, #8),
 * so the "timeZone" setting picks one. Its value is minutes from UTC (a fixed offset), AUTO (the head unit's own),
 * or a ZONES code (10000+): a named zone that follows its daylight saving rules by itself.
 * US rules: from the second Sunday of March, 2:00 local, to the first Sunday of November, 2:00 local (since 2007).
 * EU rules: from the last Sunday of March to the last Sunday of October, both at 1:00 UTC.
 */
const AUTO = -9999;

// code: [name, standard offset in minutes, rule, [lat, lon] roughly the middle of the zone (for sunrise / sunset only;
// a point inside the zone is close enough to dim the colours at about the right time, and names no one's town)]
const ZONES = {
    10001: ['US Eastern', -300, 'us', [39, -79]],
    10002: ['US Central', -360, 'us', [38, -92]],
    10003: ['US Mountain', -420, 'us', [41, -108]],
    10004: ['Arizona', -420, null, [34, -111.5]],
    10005: ['US Pacific', -480, 'us', [40, -120]],
    10006: ['Alaska', -540, 'us', [62, -150]],
    10007: ['Hawaii', -600, null, [20.5, -157]],
    10008: ['Canada Atlantic', -240, 'us', [46, -64]],
    10009: ['Mexico', -360, null, [21, -101]],
    10011: ['UK, Ireland, Portugal', 0, 'eu', [52, -4]],
    10012: ['Central Europe', 60, 'eu', [48, 10]],
    10013: ['Eastern Europe', 120, 'eu', [46, 25]],
};
// no zone set ("Not set"): the middle of the contiguous US, where most of the apps' users are
const FALLBACK = { lat: 39.8, lon: -98.6 };

/** Where to work out sunrise / sunset for a setting value: a zone's middle, or for a plain offset 15 degrees of
 *  longitude per hour at latitude 40; null for AUTO or anything unknown. */
function place(v) {
    if (typeof v !== 'number' || v === AUTO) return null;
    const z = ZONES[v];
    if (z) return { lat: z[3][0], lon: z[3][1] };
    return v >= -720 && v <= 840 ? { lat: 40, lon: Math.max(-180, Math.min(180, v / 4)) } : null;
}

/** UTC ms of the n-th (1-based) Sunday of month m (0-based) in year y; n = -1: the last one. */
function sunday(y, m, n) {
    if (n < 0) {
        const last = new Date(Date.UTC(y, m + 1, 0));
        return Date.UTC(y, m, last.getUTCDate() - last.getUTCDay());
    }
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    return Date.UTC(y, m, 1 + ((7 - first) % 7) + (n - 1) * 7);
}

/** Is daylight saving on at UTC ms `t` for a zone with standard offset `std` (minutes) and `rule`? */
function dst(t, std, rule) {
    const y = new Date(t).getUTCFullYear(), H = 3600000;
    if (rule === 'us') {
        const on = sunday(y, 2, 2) + 2 * H - std * 60000;          // 2:00 standard time
        const off = sunday(y, 10, 1) + 2 * H - (std + 60) * 60000;  // 2:00 daylight time
        return t >= on && t < off;
    }
    if (rule === 'eu') return t >= sunday(y, 2, -1) + H && t < sunday(y, 9, -1) + H;
    return false;
}

/** Minutes from UTC for a setting value at UTC ms `t` (default now); null for AUTO or anything unknown. */
function offset(v, t) {
    if (typeof v !== 'number' || v === AUTO) return null;
    const z = ZONES[v];
    if (!z) return v >= -720 && v <= 840 ? v : null;
    t = t === undefined ? Date.now() : t;
    return z[1] + (dst(t, z[1], z[2]) ? 60 : 0);
}

/** The setting value as the settings row shows it. */
function name(v) {
    if (v === AUTO || typeof v !== 'number') return 'Not set (UTC)';   // the head unit's clock is UTC: pick a zone
    if (ZONES[v]) return ZONES[v][0];
    if (v === 0) return 'UTC';
    const a = Math.abs(v), h = Math.floor(a / 60), m = a % 60;
    return 'UTC' + (v < 0 ? '-' : '+') + h + (m ? ':' + (m < 10 ? '0' : '') + m : '');
}

module.exports = { AUTO, ZONES, FALLBACK, offset, name, place, dst };
