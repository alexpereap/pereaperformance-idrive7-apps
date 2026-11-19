'use strict';
/**
 * Calibration probes for the car photos (hud.js types "swatch" and "swatchimg", each app's grid layout).
 *
 * The same picture drawn two ways, so one photo settles the colour curve of each path:
 *   SWATCH        a GLSL ES 1.00 fragment shader for an "effect" layer (drawn by the car's GPU)
 *   swatchImage   the identical picture painted into a straight-RGBA Buffer for an "image" layer
 * Top half: u_n grey steps 0.0 .. 1.0, left to right, each a solid block. Bottom half: four test
 * colours, the M theme's navy and three dark greys, (0.014,0.027,0.05), (0.055,0.105,0.155),
 * (0.1,0.1,0.1), (0.25,0.25,0.25). If the two strips photograph differently, the effect and image
 * paths are not on the same curve (gamma, premultiplied alpha, or a colour-space conversion).
 */
const TEST_COLOURS = [[0.014, 0.027, 0.05], [0.055, 0.105, 0.155], [0.1, 0.1, 0.1], [0.25, 0.25, 0.25]];

const SWATCH = `// Calibration swatch for a cluster-render "effect" layer (GLSL ES 1.00): u_n grey steps 0..1 across
// the top half, four dark test colours across the bottom half. v_uv (0,0) is the top-left.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_n;

void main() {
    vec2 p = v_uv * u_size;
    if (p.y < u_size.y * 0.5) {
        float i = min(floor(p.x * u_n / u_size.x), u_n - 1.0);
        float g = u_n > 1.0 ? i / (u_n - 1.0) : 1.0;
        gl_FragColor = vec4(g, g, g, 1.0);
    } else {
        float i = min(floor(p.x * 4.0 / u_size.x), 3.0);
        vec3 c = vec3(0.25, 0.25, 0.25);
        if (i < 0.5) c = vec3(0.014, 0.027, 0.05);
        else if (i < 1.5) c = vec3(0.055, 0.105, 0.155);
        else if (i < 2.5) c = vec3(0.1, 0.1, 0.1);
        gl_FragColor = vec4(c, 1.0);
    }
}
`;

/** The swatch as straight RGBA (w*h*4 bytes): the same steps and colours as SWATCH. */
function swatchImage(w, h, n) {
    const steps = n > 1 ? Math.floor(n) : 1;
    const buf = Buffer.alloc(w * h * 4, 0);
    const half = Math.floor(h / 2);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            if (y < half) {
                const i = Math.min(Math.floor(x * steps / w), steps - 1);
                const g = Math.round(255 * (steps > 1 ? i / (steps - 1) : 1));
                buf[o] = g; buf[o + 1] = g; buf[o + 2] = g;
            } else {
                const c = TEST_COLOURS[Math.min(Math.floor(x * 4 / w), 3)];
                buf[o] = Math.round(255 * c[0]); buf[o + 1] = Math.round(255 * c[1]); buf[o + 2] = Math.round(255 * c[2]);
            }
            buf[o + 3] = 255;
        }
    }
    return buf;
}

module.exports = { SWATCH, swatchImage, TEST_COLOURS };
