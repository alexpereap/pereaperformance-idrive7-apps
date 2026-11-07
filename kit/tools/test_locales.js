'use strict';
// Every language the kit ships (kit/runtime/locales/*.tsv) for every app in apps/: build it with
// --preview-only --language <lang>, then check that (1) the JSON catalog is what sync_locales.py makes
// of the TSV and is what the stage's locale.json carries, (2) every app.json label with a space has a
// row, (3) every character of every translation (and of the credit) has a glyph in the atlas the
// runtime picks for that text, (4) the staged atlases fit the renderer's GPU budget. No SDK needed:
//   node kit/tools/test_locales.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '../..');
const python = process.env.MGU_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const apps = fs.readdirSync(path.join(root, 'apps')).filter((d) => fs.existsSync(path.join(root, 'apps', d, 'app.json'))).sort();
const langs = fs.readdirSync(path.join(root, 'kit/runtime/locales')).filter((f) => f.endsWith('.tsv')).map((f) => f.slice(0, -4)).sort();
assert.ok(apps.length && langs.length, 'apps and locales');

const readTsv = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).reduce((o, line) => {
    if (!line || line.startsWith('#')) return o;
    const i = line.indexOf('\t');
    o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    return o;
}, {});
const labelsOf = (spec) => {
    const out = [spec.title];
    (spec.screens || []).forEach((s) => { out.push(s.title || ''); (s.buttons || []).forEach((b) => out.push(b[1])); });
    (spec.settings || []).forEach((s) => { out.push(s.label); (s.options || []).forEach((o) => out.push(o[1])); });
    return out.filter((l) => typeof l === 'string');
};

let checked = 0;
for (const lang of ['en'].concat(langs)) {
    const catalog = lang === 'en' ? {} : readTsv(path.join(root, 'kit/runtime/locales', lang + '.tsv'));
    if (lang !== 'en') {
        const json = JSON.parse(fs.readFileSync(path.join(root, 'kit/runtime/locales', lang + '.json'), 'utf8'));
        assert.deepStrictEqual(json, catalog, lang + '.json is not what sync_locales.py makes of ' + lang + '.tsv');
    }
    for (const id of apps) {
        const built = spawnSync(python, [path.join(__dirname, 'build.py'), '--language', lang, '--preview-only', id], { encoding: 'utf8' });
        assert.strictEqual(built.status, 0, built.stderr || built.stdout);
        const kit = path.join(root, 'dist', id, 'source', 'javascript', 'kit');
        Object.keys(require.cache).filter((k) => k.startsWith(kit)).forEach((k) => delete require.cache[k]);   // same stage path, next language
        const locale = JSON.parse(fs.readFileSync(path.join(kit, 'locale.json'), 'utf8'));
        assert.strictEqual(locale.language, lang);
        assert.deepStrictEqual(locale.strings, catalog, lang + '/' + id + ': the stage carries another catalog');
        if (lang !== 'en') {
            const spec = JSON.parse(fs.readFileSync(path.join(root, 'apps', id, 'app.json'), 'utf8'));
            for (const label of labelsOf(spec)) {
                if (label.includes(' ') && /[A-Za-z]{2,}/.test(label) && !/^\d/.test(label)) {
                    assert.ok(Object.prototype.hasOwnProperty.call(catalog, label), lang + '/' + id + ': untranslated menu label "' + label + '"');
                }
            }
        }
        const fonts = require(path.join(kit, 'fonts'));
        const texts = Object.values(catalog).reduce((a, v) => a.concat(v.split('|')), []).concat(locale.credit ? [locale.credit] : []);
        for (const text of texts) {
            for (const family of ['label', 'bold']) {
                const f = fonts.get(family, 32, text);          // the atlas the runtime picks for this text (korean / cjk / cyrillic / latin)
                assert.ok(f, lang + '/' + id + ': no atlas for "' + text + '"');
                for (const ch of text) {
                    if (/\s/.test(ch)) continue;
                    assert.ok(f.glyphs[ch.codePointAt(0)], lang + '/' + id + ': no glyph for U+' + ch.codePointAt(0).toString(16) + ' "' + ch + '" in ' + f.family + ' ("' + text + '")');
                }
            }
        }
        let height = 0;
        for (const name of fs.readdirSync(path.join(kit, 'fonts')).filter((x) => x.endsWith('.json'))) {
            for (const s of JSON.parse(fs.readFileSync(path.join(kit, 'fonts', name), 'utf8')).sizes) {
                assert.ok(s.atlasW <= 1024 && s.atlasH <= 4096, name + ' atlas size');
                height += s.atlasH + 1;
            }
        }
        assert.ok(height < 8192, lang + '/' + id + ': GPU atlas budget (' + height + ')');
        checked++;
    }
}
console.log('PASS: ' + checked + ' language/app stages: catalogs in sync, menu labels translated, every glyph baked, atlases within the GPU budget');
