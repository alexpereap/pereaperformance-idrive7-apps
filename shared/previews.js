'use strict';
/**
 * previews.js - the theme pictures the settings page shows (page.js). Made on the bench by
 * tools/previews.py into hud/previews/<layout>.json ({ big, small }: w, h, z = base64 of the deflated
 * RGBA rows), packed with the rest of hud/ by the build. Each one is inflated on first use and handed to
 * the kit as a pixel image (record.js setImage): the renderer gets it once as a pixmap (renderd.js).
 */
const zlib = require('zlib');
const data = require('./hud_data');
const rec = require('./kit/record');

const BASE = 0x48500000;            // our image ids ('HP' + n): clear of the kit's own
const cache = Object.create(null);
let next = 0;

/** { id, w, h } of layout `name`'s picture ('big' or 'small'), or null when there is none. */
function get(name, size) {
    const key = name + ':' + size;
    if (cache[key] !== undefined) return cache[key];
    let out = null;
    try {
        const p = (data.json('previews/' + name + '.json') || {})[size];
        if (p && p.z) {
            const px = zlib.inflateSync(Buffer.from(p.z, 'base64'));
            if (px.length === p.w * p.h * 4) {
                const id = BASE + next++;
                rec.setImage(id, p.w, p.h, px);
                out = { id, w: p.w, h: p.h };
            }
        }
    } catch (e) { out = null; }
    cache[key] = out;
    return out;
}

module.exports = { get };
