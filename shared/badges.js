'use strict';
/**
 * badges.js - the model name a cluster theme can show (Cluster Themes, page.js Badge tab, the {{badge}} token).
 * Text only, in the theme's own font: no BMW or M logo artwork in this public repo (takedown risk).
 * The "badge" setting holds the model ("X3 M40i", or "none"); "badgeBMW" puts "BMW " in front.
 * app.json's "badge" options must list every model here (tools: none; keep the two in step by hand).
 * Plain Node 8 (the car's 8.16.2).
 */
const SERIES = [
    ['1', ['128ti', 'M135i']],
    ['2', ['228i', '230i', 'M235i', 'M240i']],
    ['3', ['320i', '330i', '330e', 'M340i']],
    ['4', ['430i', 'M440i', 'i4 eDrive40', 'i4 M50']],
    ['5', ['530i', '530e', '540i', '545e', 'M550i', 'i5 M60']],
    ['7', ['740i', '760i', 'i7 M70']],
    ['8', ['840i', 'M850i']],
    ['X', ['X1 M35i', 'X2 M35i', 'X3 30i', 'X3 M40i', 'X3 M50', 'X4 M40i', 'X5 40i', 'X5 M60i', 'X6 M60i', 'X7 M60i', 'XM']],
    ['Z', ['Z4 30i', 'Z4 M40i']],
    ['i', ['i4', 'i5', 'i7', 'iX', 'iX M60']],
    ['M', ['M2', 'M3', 'M4', 'M5', 'M8', 'X3 M', 'X4 M', 'X5 M', 'X6 M']],
    ['ALPINA', ['B3', 'B4', 'B5', 'B8', 'XB7', 'XD3']],
];

/** The series a model is listed under (the first one), or null. */
function seriesOf(model) {
    const s = SERIES.find((x) => x[1].indexOf(model) >= 0);
    return s ? s[0] : null;
}

/** What the cluster shows: "BMW X3 M40i", "X3 M40i", or '' for none. ALPINA models never get "BMW". */
function text(model, lettering) {
    if (!model || model === 'none') return '';
    return (lettering && seriesOf(model) !== 'ALPINA' ? 'BMW ' : seriesOf(model) === 'ALPINA' ? 'ALPINA ' : '') + model;
}

module.exports = { SERIES, seriesOf, text };
