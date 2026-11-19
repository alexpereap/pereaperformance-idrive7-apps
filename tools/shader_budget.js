'use strict';
/**
 * What an effect shader asks of the instrument cluster's GPU (the KOMBI), measured against shaders that ran or failed
 * on cars. Past some size the KOMBI restarts or drops our content about 2 s after the layer shows. The real limits
 * are unknown; these are the known points.
 *
 * From james10424's cars (idrive7-custom tools/shader_budget.js, ported, MIT notice below):
 *   38 texture reads (Custom HUD 0.1.15 Miku)                 restarted the KOMBI
 *   32 texture reads (Custom HUD 0.1.16 / 0.1.17)             holds
 *   8724 tokens, inlined (Custom Cluster M, one layer)         crashed the display (Nov 10 2026)
 *   7835 tokens, inlined (Custom Cluster Sport)                holds
 * Tokens are counted as the compiler sees them: comments and #ifdef'd-out code gone, every function inlined into
 * main (a function called 6 times counts 6 times), a loop's body once.
 *
 * Our own (bimmer-lab's 2020 X3, G01):
 *   8748 tokens, inlined (Cluster Themes M "mdash", one whole-panel layer)  holds (Nov 10 2026, cluster-render 0.5.3)
 * That is over the 8724 that crashed james10424's display, so tokens alone are no hard limit: past 8748 is only
 * "untested". Texture reads keep their crash mark (no conflicting data).
 *
 * Uniform vectors, two counts: "declared" (a float, vec or sampler 1, mat3 3, mat4 4, arrays by length: what a driver
 * that gives every uniform its own vec4 row uses, the worst case) and "packed" (GLSL ES 1.00 Appendix A.7's packing:
 * vec4 / mat rows whole, vec3s one row each with a float in the 4th column, vec2s two to a row, floats filling what is
 * left; samplers take texture units, not rows). About 70 with 80-step loops restarted a G21 (kit Redline README), ~22
 * ran fine; the HUD rule (Nov 13 2026): a HUD shader stays at 20 or fewer, declared, so it holds on any driver. Over
 * 20 on the HUD target is a warning ("!"); elsewhere uniform vectors are shown, not judged.
 * Loop load (shown, not judged): tokens with each constant-bound loop's body counted as often as it runs, times the
 * layer's share of the 1920 x 720 panel. Dyno 0.14.0's whole-panel "tiles" (load 8306) dropped the cluster, yet M's
 * mdash (8748) holds: static counts don't explain Dyno, so they stay numbers.
 *
 *   node tools/shader_budget.js        every shader in shared/shaders.js: reads, tokens, uniform vectors, loop work
 *                                      (exits 1 if a shader reaches a crash mark, or doesn't compile)
 *   node tools/shader_budget.js --uniforms   also a table of every shader's uniform vectors, declared and packed
 *   require('./tools/shader_budget').layer(fs, w, h, target)   one effect layer: { level, text } (the bench uses it;
 *                                      target 'hud' applies the HUD's 20 uniform vector rule)
 * glslangValidator (brew install glslang), when installed, also compiles each shader as GLSL ES 1.00.
 *
 * ---
 * Ported from https://github.com/james10424/idrive7-custom (tools/shader_budget.js, f4fa569) under the MIT License:
 *
 * Copyright (c) 2026 bimmer-lab
 * Copyright (c) 2026 James Zhao
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 * to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of
 * the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
 * THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

const READS_GOOD = 32, READS_CRASH = 38;
const TOKENS_GOOD = 8748, TOKENS_THEIRS = 8724;   // ours holds (G01), theirs crashed (see the header)
const PANEL = 1920 * 720;
const HUD_UNIFORMS = 20;     // the HUD rule (see the header)
const NAME_COL = 10;

/** The source as the GPU compiles it: no comments, #define NAME / #ifdef / #ifndef / #else / #endif applied. */
function preprocess(src) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const defs = new Set(), active = [], out = [];
    for (const line of code.split('\n')) {
        const t = line.trim();
        let m;
        if ((m = t.match(/^#ifdef\s+(\w+)/))) { active.push(defs.has(m[1])); continue; }
        if ((m = t.match(/^#ifndef\s+(\w+)/))) { active.push(!defs.has(m[1])); continue; }
        if (t.startsWith('#else')) { active.push(!active.pop()); continue; }
        if (t.startsWith('#endif')) { active.pop(); continue; }
        if (!active.every(Boolean)) continue;
        if ((m = t.match(/^#define\s+(\w+)/))) defs.add(m[1]);
        if (!t.startsWith('#')) out.push(line);
    }
    return out.join('\n');
}

const TOKEN = /[A-Za-z_]\w*|\d+\.?\d*(?:[eE][-+]?\d+)?|[-+*/<>=!&|]=?|[(){}[\];,.?:]/g;
const tokens = (s) => (s.match(TOKEN) || []).length;

/** The text from `open` (an index just past a "{") to its matching "}", and the index after it. */
function block(code, open) {
    let i = open, depth = 1;
    while (depth && i < code.length) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}') depth--;
        i++;
    }
    return { body: code.slice(open, i - 1), end: i };
}

/** Work of a piece of code: its tokens, with each loop's body counted as many times as it runs (bound read from
 *  "< N" or "< NAME" with NAME a const int; unknown bounds count once) and called functions' work added per call. */
function work(code, consts, fnWork) {
    let total = 0, i = 0;
    const loop = /\bfor\s*\(([^)]*)\)\s*\{/g;
    let m;
    while ((m = loop.exec(code))) {
        total += tokens(code.slice(i, m.index)) + calls(code.slice(i, m.index), fnWork);
        const b = block(code, loop.lastIndex);
        const bound = m[1].match(/<=?\s*(\w+)/);
        let n = 1;
        if (bound) n = /^\d+$/.test(bound[1]) ? Number(bound[1]) : consts[bound[1]] || 1;
        total += tokens(m[0]) + n * work(b.body, consts, fnWork);
        i = b.end;
        loop.lastIndex = b.end;
    }
    return total + tokens(code.slice(i)) + calls(code.slice(i), fnWork);
}
function calls(code, fnWork) {
    let t = 0;
    Object.keys(fnWork).forEach((f) => { t += ((code.match(new RegExp('\\b' + f + '\\s*\\(', 'g')) || []).length) * fnWork[f]; });
    return t;
}

/** { reads, tokens, work, uniforms } of main with every function inlined; null without a main. */
function measure(src) {
    const code = preprocess(src);
    const bodies = {}, order = [];
    const head = /\b(?:void|bool|int|float|vec[234]|ivec[234]|bvec[234]|mat[234])\s+(\w+)\s*\([^)]*\)\s*\{/g;
    let m;
    while ((m = head.exec(code))) {
        const b = block(code, head.lastIndex);
        bodies[m[1]] = b.body; order.push(m[1]);
        head.lastIndex = b.end;
    }
    if (!bodies.main) return null;
    const consts = {};
    (code.match(/const\s+int\s+\w+\s*=\s*\d+/g) || []).forEach((d) => { const p = d.match(/(\w+)\s*=\s*(\d+)/); consts[p[1]] = Number(p[2]); });
    const memo = {};
    const cost = (name, seen) => {
        if (memo[name]) return memo[name];
        const body = bodies[name];
        const others = {}, fnWork = {};
        const total = { reads: (body.match(/\btexture2D\s*\(/g) || []).length, tokens: tokens(body), work: 0 };
        Object.keys(bodies).forEach((f) => {
            if (f === name || f === 'main' || seen.indexOf(f) >= 0) return;
            const n = (body.match(new RegExp('\\b' + f + '\\s*\\(', 'g')) || []).length;
            if (!n) return;
            const c = cost(f, seen.concat(name));
            total.reads += n * c.reads; total.tokens += n * c.tokens;
            others[f] = c; fnWork[f] = c.work;
        });
        total.work = work(body, consts, fnWork);
        return (memo[name] = total);
    };
    const r = cost('main', []);
    const u = uniformVectors(code);
    return { reads: r.reads, tokens: r.tokens, work: r.work, uniforms: u.declared, packed: u.packed };
}

/** { declared, packed } uniform vectors of preprocessed code (see the header). The packing follows GLSL ES 1.00
 *  Appendix A.7 in its counting: whole rows for vec4, mat2 (2), mat4 (4), mat3 (3) and vec3 (columns 0..2), then vec2s two to a
 *  row, then floats into the free 4th columns of the vec3 / mat3 rows, the half row a lone vec2 leaves, and new rows. */
function uniformVectors(code) {
    let declared = 0, rows = 0, col3 = 0, vec2s = 0, floats = 0;
    (code.match(/uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+\w+\s*(\[\s*\d+\s*\])?/g) || []).forEach((d) => {
        const parts = d.split(/\s+/), t = /^(lowp|mediump|highp)$/.test(parts[1]) ? parts[2] : parts[1];
        const arr = d.match(/\[\s*(\d+)\s*\]/), n = arr ? Number(arr[1]) : 1;
        declared += (t === 'mat3' ? 3 : t === 'mat4' ? 4 : t === 'mat2' ? 2 : 1) * n;
        if (/^sampler/.test(t)) return;
        if (t === 'mat4') rows += 4 * n;
        else if (t === 'mat2') rows += 2 * n;
        else if (/vec4$/.test(t)) rows += n;
        else if (t === 'mat3') { rows += 3 * n; col3 += 3 * n; }
        else if (/vec3$/.test(t)) { rows += n; col3 += n; }
        else if (/vec2$/.test(t)) vec2s += n;
        else floats += n;
    });
    rows += Math.ceil(vec2s / 2);
    let free = col3 + (vec2s % 2 ? 2 : 0);
    const left = Math.max(0, floats - free);
    rows += Math.ceil(left / 4);
    return { declared, packed: rows };
}

/** One effect layer: { level 'ok' | 'warn' | 'crash', text, ... } for fragment shader `src` on a w x h layer
 *  (w, h default the whole panel). */
function layer(src, w, h, target) {
    const m = measure(src);
    if (!m) return { level: 'ok', text: 'no main', reads: 0, tokens: 0, work: 0, uniforms: 0, packed: 0, load: 0 };
    const share = ((w || 1920) * (h || 720)) / PANEL, load = Math.round(m.work * share);
    const sum = m.reads + ' reads, ' + m.tokens + ' tokens, ' + m.uniforms + ' uniform vectors (' + m.packed + ' packed), loop load ' + load;
    const out = Object.assign({ load }, m);
    if (m.reads >= READS_CRASH) return Object.assign(out, { level: 'crash', text: sum + ': ' + READS_CRASH + ' reads restarted a cluster; cut to ' + READS_GOOD + ' or fewer' });
    const over = [];
    if (m.reads > READS_GOOD) over.push('reads over the ' + READS_GOOD + ' known to hold');
    if (target === 'hud' && m.uniforms > HUD_UNIFORMS) over.push('uniform vectors over the HUD\'s ' + HUD_UNIFORMS + ' (~70 restarted a cluster)');
    if (m.tokens > TOKENS_GOOD) over.push('size over the ' + TOKENS_GOOD + ' tokens known to hold (M; ' + TOKENS_THEIRS + ' crashed another car)');
    if (over.length) return Object.assign(out, { level: 'warn', text: sum + ': ' + over.join(', ') + '; untested on the car' });
    return Object.assign(out, { level: 'ok', text: sum });
}

/** Compiles a fragment shader as GLSL ES 1.00 with glslangValidator: { ok, missing, errors }. */
function compile(src) {
    const run = require('child_process').spawnSync('glslangValidator', ['--stdin', '-S', 'frag'], { input: src, encoding: 'utf8' });
    if (run.error) return { ok: false, missing: true, errors: String(run.error.message) };
    const errors = (run.stdout + run.stderr).split('\n')
        .filter((l) => /^(ERROR|WARNING):/.test(l) && !/compilation (terminated|errors)/.test(l)).join('\n');
    return { ok: run.status === 0, errors };
}

module.exports = { measure, layer, compile, uniformVectors, READS_GOOD, READS_CRASH, TOKENS_GOOD, HUD_UNIFORMS };

if (require.main === module) {
    // every effect layer of every built-in layout, at its real size (layouts are plain JSON)
    const fs = require('fs'), path = require('path');
    const shaders = require('../shared/shaders');
    const root = path.join(__dirname, '..', 'apps');
    let worst = 'ok';
    const compiled = {}, used = {};
    let compiler = true;
    fs.readdirSync(root).forEach((app) => {
        const dir = path.join(root, app, 'hud', 'layouts');
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().forEach((f) => {
            let lay;
            try { lay = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { console.log('X ' + app + '/' + f + ': ' + e.message); worst = 'crash'; return; }
            (lay.widgets || []).forEach((w) => {
                const src = shaders[w.type];
                if (!src) return;
                if (compiler && !(w.type in compiled)) {
                    const b = compile(src);
                    if (b.missing) { compiler = false; console.log('! glslangValidator not found (brew install glslang): shaders not compiled'); }
                    else compiled[w.type] = b;
                }
                const b = compiled[w.type], broken = b && !b.ok;
                const r = layer(src, w.w, w.h, app === 'idrive_hud_widgets' ? 'hud' : 'panel');
                (used[w.type] = used[w.type] || new Set()).add(app === 'idrive_hud_widgets' ? 'hud' : 'cluster');
                if (broken || r.level === 'crash') worst = 'crash';
                if (r.level === 'ok' && !broken && !process.argv.includes('--all')) return;
                console.log((broken || r.level === 'crash' ? 'X ' : r.level === 'warn' ? '! ' : '  ') + (app.replace('idrive_hud_widgets', 'hud').replace('perea_cluster_themes', 'cluster') + '/' + f.replace('.json', '') + ' ' + w.id + ' (' + w.type + ' ' + w.w + 'x' + w.h + ')').padEnd(44) + r.text + (broken ? ', does not compile' : ''));
                if (broken) console.log(b.errors.replace(/^/gm, '      '));
            });
        });
    });
    if (process.argv.includes('--uniforms')) {
        console.log('uniform vectors per shader (declared / packed; HUD rule: ' + HUD_UNIFORMS + ' or fewer declared):');
        Object.keys(shaders).forEach((k) => {
            const m = measure(shaders[k]);
            if (!m) return;
            const where = used[k] ? Array.from(used[k]).sort().join(' + ') : 'no built-in layout';
            const flag = used[k] && used[k].has('hud') && m.uniforms > HUD_UNIFORMS ? '! ' : '  ';
            console.log(flag + k.padEnd(10) + String(m.uniforms).padStart(4) + ' / ' + String(m.packed).padEnd(4) + where);
        });
    }
    console.log(worst === 'crash' ? 'some layers reach a crash mark or do not compile' : 'no layer reaches a crash mark' + (process.argv.includes('--all') ? '' : ' (--all lists every layer)'));
    process.exit(worst === 'crash' ? 1 : 0);
}
