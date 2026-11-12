'use strict';
/**
 * fonts.js - loads the pre-baked glyph atlases (kit/runtime/fonts/*.json,
 * made by kit/tools/bake_fonts.py) and picks the best size for a request.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, 'fonts');
const families = Object.create(null);

function family(name) {
    if (families[name] !== undefined) return families[name];
    let fam = null;
    try {
        const j = JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));
        fam = j.sizes.map((s) => ({
            size: s.size, ascent: s.ascent, descent: s.descent, atlasW: s.atlasW, atlasH: s.atlasH,
            glyphs: s.glyphs, _alpha: s.alpha, alpha: null, family: name, cacheKey: j.cacheKey || '',
        }));
    } catch (e) { fam = null; }
    families[name] = fam;
    return fam;
}

/** Every character of the text has a glyph in this baked size. */
function covers(f, text) {
    for (const ch of text) if (f.glyphs[ch.codePointAt(0)] === undefined) return false;
    return true;
}

/**
 * Smallest baked size >= requested (downscaling looks better), else largest. The big sizes of a family may
 * hold fewer glyphs (num: digits and a few letters from 64 px up, the whole set at 40 px only): where the size
 * picked lacks a character of the text, the nearest size that has them all is taken instead (the smallest at or
 * over the request, else the largest under it), so "76.1 gal (288.0 L)" at 42 px is drawn whole from the 40 px
 * atlas rather than with holes from the 64 px one. A text no size covers keeps the size picked first.
 */
function get(name, size, text) {
    // Shared supplemental atlases avoid duplicating glyphs in every numeric size.
    if (text && /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff]/.test(text)) name = 'korean';
    else if (text && /[\u3000-\u9fff\uff00-\uffef]/.test(text)) name = 'cjk';
    else if (text && /[\u0400-\u04ff]/.test(text)) name = 'cyrillic';
    const fam = family(name) || family('label');
    if (!fam) return null;
    let best = null;
    for (const f of fam) if (f.size >= size && (!best || f.size < best.size)) best = f;
    if (!best) best = fam[fam.length - 1];
    if (text && fam.length > 1 && !covers(best, text)) {
        let full = null;
        for (const f of fam) {
            if (!covers(f, text)) continue;
            if (!full) full = f;
            else if (f.size >= size) { if (full.size < size || f.size < full.size) full = f; } else if (full.size < size && f.size > full.size) full = f;
        }
        if (full) best = full;
    }
    if (!best.alpha) best.alpha = zlib.inflateSync(Buffer.from(best._alpha, 'base64'));
    return best;
}

function measure(f, s) {
    let w = 0;
    for (const ch of s) { const g = f.glyphs[ch.codePointAt(0)] || f.glyphs[63]; if (g) w += g[6]; }
    return w;
}

module.exports = { get, measure };
