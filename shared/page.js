'use strict';
/**
 * page.js - the app's own centre-screen page (both apps), in place of BMW's plain settings list.
 * Look: design/settings-mock-v2.png (approved Nov 7 2026): near-black with a soft blue glow, a rail of
 * tabs on the left (icon, name, current value), glass cards, BMW blue for what is on.
 *
 * Drawn on the kit's canvas screen (kit/runtime/display.js): on the Store's renderer it fills the screen at
 * up to 60 fps and every tap or controller press lands on a target (cv.target); without the renderer the
 * same drawing goes to the HMI as a picture. The kit's own Settings sheet (bar button) stays as the fallback.
 *
 *   new Page(ctx, hud, {
 *       title, what: 'cluster' | 'HUD',
 *       look: { name: 'Themes', style: 'hero' | 'cards', tags: { gt3: 'race dash', ... } },
 *       tabs: ['look', 'readouts', 'badge', 'map', 'alerts', 'gmeter', 'settings'],
 *       settings: ['units', 'clock', ...],          // the Settings tab's rows, in order
 *   }).start();
 *
 * Theme pictures: previews.js (shot on the bench by tools/previews.py; the centre screen can't draw our
 * cluster-render themes live). Plain Node 8 (the car's 8.16.2).
 */
const G = require('./kit/gauges');
const themes = require('./kit/themes');
const previews = require('./previews');
const sensors = require('./sensors');
const visible = require('./visible');
const badges = require('./badges');
const tz = require('./tz');

const W = 1600, H = 520;
const A = G.withAlpha;
const C = {
    bg: '#05070a', glow: '#0d1a2e', text: '#eef2f8', dim: '#8a96a8', label: '#6f7b8f', line: '#ffffff12',
    blue: '#2b7fff', blueHi: '#5aa2ff', blueDeep: '#1c69d4', live: '#7fd3a0', off: '#c3cad6',
};
const RAIL = { x: 16, y: 54, w: 252, h: 66, gap: 8 };
const RAIL7 = { x: 16, y: 54, w: 252, h: 58, gap: 6 };     // seven tabs or more: a little shorter, so they fit
const CX = 300, CR = 1584, CW = CR - CX;
const MODES = [['inComfort', 'Comfort'], ['inSport', 'Sport'], ['inEco', 'Eco Pro']];
const MODE_KEY = { comfort: 'inComfort', sport: 'inSport', eco: 'inEco' };
const TAB = {
    look: { icon: 'screen' },
    readouts: { name: 'Readouts', icon: 'lines' },
    position: { name: 'Position', icon: 'move' },
    map: { name: 'Map', icon: 'map' },
    badge: { name: 'Badge', icon: 'badge' },
    alerts: { name: 'Alerts', icon: 'alert' },
    gmeter: { name: 'G-meter', icon: 'gmeter' },
    colours: { name: 'Colours', icon: 'colour' },
    settings: { name: 'Settings', icon: 'cog' },
};

// the kit's own chrome (header, bar, Settings sheet) in BMW blue, to match the page
Object.assign(themes.THEMES.m_tricolour, { sel: C.blue, selText: '#ffffff', accent2: C.blueHi, bg: C.bg });

class Page {
    constructor(ctx, hud, cfg) {
        this.ctx = ctx; this.hud = hud; this.cfg = cfg;
        this.tab = cfg.tabs[0];
        this.picker = null;              // { key, title } while a list of choices is open over the page
        this.loop = null;
        this.slotLayout = null;          // Readouts: the layout whose slots are edited (null: the one showing)
        this.slot = null;                // Readouts: the slot picked (its id)
        this.cat = sensors.CATS[0];      // Readouts: the sensor group shown
        this.series = null;              // Badge: the series shown (null: the picked model's)
        this.confirm = null;             // { title, lines, yes, run } while a question is open over the page
    }

    start() {
        const ctx = this.ctx;
        this.loop = ctx.loop('MAIN', 10, () => this.render());
        ctx.settings.onChange(() => this.kick());
        ctx.onLayout(() => this.kick());
        this.hud.onStatus(() => this.kick());
        this.render();
    }
    kick() { if (this.loop && this.loop.kick) this.loop.kick(); }

    /* ---------- settings ---------- */
    get(k) { return this.hud.setting(k); }
    set(k, v) { if (this.ctx.settings.get(k) !== v) this.ctx.settings.set(k, v); this.kick(); }
    item(k) { return this.ctx.settings.item(k); }
    optLabel(k, v) {
        const s = this.item(k), o = s && (s.options || []).find((x) => x[0] === v);
        return o ? o[1] : String(v);
    }
    /** a layout's short name: "Off (BMW's own cluster)" -> "BMW's own" */
    layoutName(v) { return v === 'off' ? "BMW's own" : this.optLabel('hudLayout', v); }
    valueText(k) {
        const s = this.item(k), v = this.get(k);
        if (!s) return '';
        if (s.type === 'bool') return v ? 'On' : 'Off';
        if (s.type === 'number' && WARN_KEYS.indexOf(k) >= 0) return warnText(k, v, this.get('units') === 'us');
        if (k === 'timeZone') return tzText(v);
        if (k === 'tankLitres') return fmtInt(v) + ' L';
        if (s.type === 'number') return k === 'shiftBefore' ? (v ? fmtInt(v) + ' rpm before' : 'At the redline') : fmtInt(v) + ' rpm';
        return this.optLabel(k, v);
    }
    /** the layout showing now, else the one meant to (before cluster-render answers) */
    shownName() { return this.hud.activeName || this.hud._layoutName() || 'off'; }
    /** the layouts a theme card can show (not the calibration ones) */
    looks() { return ((this.item('inSport') || {}).options || []).map((o) => o[0]); }
    /**
     * A theme or layout picked on this page (key: hudLayout or a drive mode's). The cluster panel and the HUD
     * share one screen (screen.js): when the other app is drawing, ask first whether to turn it off; yes takes
     * the screen (the other app steps aside), Cancel changes nothing. Any pick here ends our own stepping aside.
     */
    chooseLayout(key, v) {
        const scr = this.hud.screen;
        if (v === 'off' || !scr || !scr.otherOn()) {
            if (scr) scr.release();
            this.set(key, v);
            return;
        }
        const cluster = this.cfg.what === 'cluster';
        this.confirm = {
            title: scr.otherName + ' is on',
            lines: cluster
                ? ['A cluster theme and the HUD can\'t show at the same time.', 'Turn HUD Widgets off so ' + this.layoutName(v) + ' shows?']
                : ['The HUD and a cluster theme can\'t show at the same time.', 'Turn the cluster theme off so ' + this.layoutName(v) + ' shows?'],
            yes: cluster ? 'Turn HUD off' : 'Turn theme off',
            run: () => { scr.claim(); this.set(key, v); },
        };
        this.kick();
    }
    /** what the Look tab says while the other app has the screen, else null */
    yieldNote() {
        const scr = this.hud.screen;
        return scr && scr.yielded ? 'Off · ' + scr.otherName + ' has the screen · pick one to take it back' : null;
    }

    /** the key a tap on a theme sets: the drive mode's own while it changes with the drive mode */
    lookKey() {
        const m = this.hud.driveMode;
        return this.get('byMode') === true && MODE_KEY[m] ? MODE_KEY[m] : 'hudLayout';
    }

    /* ---------- drawing ---------- */
    render() {
        const cv = this.ctx.canvas(W, H);
        const bottom = G.pageBottom(cv);
        const h = bottom + 8;
        cv.clear(C.bg);
        cv.gradientRect(0, 0, W, h, [[0, C.glow], [0.55, '#070a10'], [1, C.bg]]);
        const on = this.hud.activeName && this.hud.activeName !== 'off';
        const dd = this.hud.car && this.hud.car.data(), demo = dd && dd.demo;
        G.frame(cv, this.theme(), [], -1, [
            demo ? { text: dd.demoShow ? 'DEMO' : 'DEMO DATA', color: '#ffb020' } : null,
            { text: on ? 'ON THE ' + this.cfg.what.toUpperCase() : this.cfg.what.toUpperCase() + ' OFF', color: on ? '#3ddc84' : C.dim },
        ]);
        // the page under an open list takes no taps: the list (and a tap beside it to close) does
        const target = cv.target;
        if (this.picker || this.confirm) cv.target = function () { return this; };
        this.rail(cv, bottom);
        const body = { look: this.lookTab, readouts: this.readoutsTab, position: this.positionTab, map: this.mapTab, colours: this.coloursTab, badge: this.badgeTab, alerts: this.alertsTab, gmeter: this.gmeterTab, settings: this.settingsTab }[this.tab];
        if (body) body.call(this, cv, bottom);
        this.demoButton(cv);
        cv.target = target;
        if (this.picker) this.drawPicker(cv, bottom);
        if (this.confirm) this.drawConfirm(cv, bottom);
        return this.ctx.ui.image('MAIN_GFX', cv);
    }
    theme() { return this.ctx.theme(); }

    /**
     * "Play demo", top right on every tab: about a minute of a scripted drive on the real HUD / cluster
     * (hud.playDemo, demo_script.js), only while the car stands; "Stop demo" while it plays.
     */
    demoButton(cv) {
        const hud = this.hud;
        if (!hud.playDemo) return;
        const playing = hud.demoPlaying(), why = playing ? null : hud.demoBlocked();
        const text = playing ? 'Stop demo' : 'Play demo', h = 36, y = 44;
        const w = cv.textWidth(text, 16, { font: 'bold', literal: true }) + 62, x = CR - w;
        cv.roundRect(x, y, w, h, h / 2, playing ? '#ffffff14' : why ? '#ffffff12' : C.blue);
        if (playing) cv.strokeRoundRect(x, y, w, h, h / 2, 1, A(C.blueHi, 0.6));
        const ic = why ? C.dim : '#ffffff', ix = x + 22, iy = y + h / 2;
        if (playing) cv.fillRect(ix - 6, iy - 6, 12, 12, ic);
        else cv.quad([[ix - 5, iy - 8], [ix + 8, iy], [ix + 8, iy], [ix - 5, iy + 8]], ic);
        cv.text(text, x + 36 + (w - 36) / 2 - 10, y + 24, 16, why ? C.dim : '#ffffff', { align: 'center', font: 'bold', literal: true });
        const what = this.cfg.what === 'cluster' ? 'cluster' : 'HUD';
        const info = playing ? 'Playing on the ' + what + ' · ' + Math.ceil(hud.demoLeft() / 1000) + ' s'
            : why === 'moving' ? 'Stop the car to play the demo' : why === 'off' ? 'Pick a ' + (what === 'HUD' ? 'layout' : 'theme') + ' to play the demo'
                : why ? 'The ' + what + ' is not drawing yet' : '';
        if (info) cv.text(info, x - 16, y + 24, 15, playing ? C.blueHi : C.dim, { align: 'right', literal: true });
        if (!why) cv.target(x, y, w, h, () => { if (hud.demoPlaying()) hud.stopDemo(); else hud.playDemo(); this.kick(); }, 'demo:play', h / 2);
    }

    rail(cv, bottom) {
        cv.fillRect(RAIL.x + RAIL.w + 15, 50, 1, bottom - 56, C.line);
        const R = this.cfg.tabs.length > 6 ? RAIL7 : RAIL, dy = (66 - R.h) / 2;
        this.cfg.tabs.forEach((id, i) => {
            const x = R.x, y = R.y + i * (R.h + R.gap), w = R.w, h = R.h, sel = id === this.tab;
            if (sel) {
                cv.card(x, y, w, h, 12, [[0, A(C.blue, 0.30)], [1, A(C.blueDeep, 0.10)]]);
                cv.strokeRoundRect(x, y, w, h, 12, 1, A(C.blueHi, 0.35));
                cv.roundRect(x, y + 12, 4, h - 24, 2, C.blue);
            }
            icon(cv, (TAB[id] || {}).icon, x + 34, y + h / 2, sel ? C.text : C.dim);
            cv.text(this.tabName(id), x + 64, y + 30 - dy, 21, sel ? '#ffffff' : C.text, { font: 'bold', literal: true });
            cv.text(this.tabValue(id), x + 64, y + 53 - dy * 1.5, 15, sel ? A(C.blueHi, 0.95) : C.dim, { literal: true });
            cv.target(x, y, w, h, () => { this.tab = id; this.picker = null; this.kick(); }, 'tab:' + id, 12);
        });
    }
    tabName(id) { return id === 'look' ? this.cfg.look.name : TAB[id].name; }
    tabValue(id) {
        if (id === 'look') return this.layoutName(this.shownName());
        if (id === 'readouts') { const l = this.editLayout(); return l ? this.layoutName(l) + ' · ' + this.hud.slotsOf(l).length + ' slots' : 'none here'; }
        if (id === 'position') {
            const p = this.hud.placeInfo();
            return (p.x || p.y ? 'moved' : 'centred') + ' · ' + Math.round(p.scale * 100) + ' %';
        }
        if (id === 'map') return this.get('mapInTheme') ? 'Waze map · on' : 'Waze map · off';
        if (id === 'badge') return badges.text(this.get('badge'), this.get('badgeBMW') === true) || 'none';
        if (id === 'alerts') { const n = WARN_KEYS.filter((k) => this.get(k) > 0).length; return n ? n + ' warning' + (n > 1 ? 's' : '') + ' on' : 'warnings off'; }
        if (id === 'gmeter') return this.optLabel('gRange', this.get('gRange')) + ' · trail ' + this.optLabel('gTrail', this.get('gTrail')).toLowerCase();
        if (id === 'colours') return this.valueText('hudTheme').replace(/ \(.*\)$/, '');
        if (id === 'settings') return (this.get('units') === 'metric' ? 'km/h' : 'mph') + ' · ' + fmtInt(this.get('redline')) + ' rpm';
        return '';
    }

    /* ---------- Themes / Layouts ---------- */
    lookTab(cv, bottom) {
        if (this.cfg.look.style === 'hero') this.lookHero(cv, bottom);
        else this.lookCards(cv, bottom);
    }

    /** Cluster: the theme showing now, the drive modes beside it; every theme below in two rows. */
    lookHero(cv, bottom) {
        const shown = this.shownName();
        label(cv, CX, 70, 'Now showing');
        const pw = 523, ph = 196, px = CX, py = 82;
        this.picture(cv, shown, 'big', px, py, pw, ph);
        // right: name, tag line, the drive modes side by side
        const rx = px + pw + 28, rw = CR - rx;
        cv.text(this.layoutName(shown), rx, py + 32, 34, '#ffffff', { font: 'bold', literal: true });
        cv.text(this.yieldNote() || this.tag(shown), rx, py + 58, 17, this.yieldNote() ? '#e0a340' : C.dim, { literal: true });
        const y = this.toggleRow(cv, rx, py + 72, rw, 'Change with the drive mode', 'byMode', 46);
        if (this.get('byMode') === true) {
            const now = MODE_KEY[this.hud.driveMode], cw = (rw - 24) / 3;
            MODES.forEach((m, i) => this.modeCell(cv, rx + i * (cw + 12), y, cw, m[1] + (m[0] === now ? '  ·  now' : ''), m[0]));
        } else this.pickRow(cv, rx, y, rw, 'Theme', 'hudLayout', (v) => this.layoutName(v), 52);
        // the gallery, two rows: a tap shows that theme (in the drive mode the car is in, when it changes with it)
        const looks = this.looks(), cols = Math.max(5, Math.ceil(looks.length / 2)), gap = 12, gy = py + ph + 16;
        const gw = (CW - gap * (cols - 1)) / cols, gh = (bottom - gy - 4 - gap) / 2;
        looks.forEach((v, i) => {
            const x = CX + (i % cols) * (gw + gap), yy = gy + Math.floor(i / cols) * (gh + gap), sel = v === shown;
            glass(cv, x, yy, gw, gh, sel);
            const ih = Math.min(gh - 34, (gw - 16) * 0.375), iw = ih / 0.375;
            this.picture(cv, v, 'small', x + (gw - iw) / 2, yy + 8, iw, ih);
            cv.text(this.layoutName(v), x + 12, yy + gh - 10, 16, '#ffffff', { font: 'bold', literal: true });
            cv.text(this.tag(v), x + gw - 12, yy + gh - 10, 13, C.dim, { align: 'right', literal: true });
            cv.target(x, yy, gw, gh, () => this.chooseLayout(this.lookKey(), v), 'look:' + v, 16);
        });
    }

    /** A drive mode's theme as a small two-line cell (name over value), a tap opens the list. */
    modeCell(cv, x, y, w, name, key) {
        const h = 52;
        glass(cv, x, y, w, h, false);
        cv.text(name, x + 14, y + 20, 14, C.dim, { literal: true });
        cv.text(this.layoutName(this.get(key)), x + 14, y + 42, 18, C.blueHi, { font: 'bold', literal: true });
        chevron(cv, x + w - 18, y + h / 2, C.dim);
        cv.target(x, y, w, h, () => { this.picker = { key, title: name, fmt: (v) => this.layoutName(v) }; this.kick(); }, 'set:' + key, 14);
    }

    /** HUD: a card per layout with its picture and the drive modes that show it, in two rows. */
    lookCards(cv, bottom) {
        const shown = this.shownName();
        label(cv, CX, 70, this.yieldNote() || this.cfg.look.name + ' · tap a drive mode to give it that layout');
        const looks = this.looks(), cols = Math.max(5, Math.ceil(looks.length / 2)), gap = 12, y0 = 84;
        const cw = (CW - gap * (cols - 1)) / cols, ch = (bottom - y0 - 56 - 12 - gap) / 2;
        looks.forEach((v, i) => {
            const x = CX + (i % cols) * (cw + gap), y = y0 + Math.floor(i / cols) * (ch + gap), sel = v === shown;
            glass(cv, x, y, cw, ch, sel);
            const ih = Math.min(ch - 82, (cw - 20) * 0.624), iw = ih / 0.624;
            this.picture(cv, v, 'big', x + (cw - iw) / 2, y + 10, iw, ih);
            const ty = y + 10 + ih + 22;
            cv.text(v === 'off' ? 'Off' : this.layoutName(v), x + 12, ty, 17, '#ffffff', { font: 'bold', literal: true });
            cv.text(this.tag(v), x + cw - 12, ty, 12, C.dim, { align: 'right', literal: true });
            if (v === 'off') {
                // the off switch: BMW's own HUD in every drive mode
                cv.target(x, y, cw, ch, () => { this.set('byMode', false); this.chooseLayout('hudLayout', 'off'); }, 'look:off', 16);
                cv.text(sel ? 'HUD is off' : 'Tap to turn the HUD off', x + 12, ty + 30, 14, sel ? C.blueHi : C.dim, { literal: true });
                return;
            }
            cv.target(x, y, cw, ih + 20, () => this.chooseLayout(this.lookKey(), v), 'look:' + v, 16);
            let cx = x + 12;
            MODES.forEach((m) => {
                const lit = this.get(m[0]) === v;
                cx += miniChip(cv, cx, ty + 12, m[1], lit, () => this.chooseLayout(m[0], lit ? 'off' : v), 'mode:' + v + ':' + m[0]) + 6;
            });
        });
        // under the cards: switching with the drive mode, and what shows when it doesn't
        const by = y0 + 2 * ch + gap + 12;
        const half = (CW - 20) / 2;
        this.toggleRow(cv, CX, by, half, 'Change with the drive mode', 'byMode', 50);
        this.pickRow(cv, CX + half + 20, by, half, this.get('byMode') ? 'Otherwise' : 'Layout', 'hudLayout', (v) => this.layoutName(v), 50);
    }

    tag(v) { return v === 'off' ? 'stock ' + this.cfg.what : (this.cfg.look.tags || {})[v] || ''; }

    /** A theme's picture (black when there is none: BMW's own, or a build without previews). */
    picture(cv, name, size, x, y, w, h) {
        cv.roundRect(x, y, w, h, 10, '#000000');
        const p = name !== 'off' && previews.get(name, size);
        if (p) cv.image(p.id, x, y, w, h);
        else cv.text(name === 'off' ? "BMW's own " + this.cfg.what : this.layoutName(name), x + w / 2, y + h / 2 + 7, 18, C.dim, { align: 'center', literal: true });
        cv.strokeRoundRect(x, y, w, h, 10, 1, '#ffffff10');
    }

    /* ---------- Readouts ---------- */
    /** the layouts that have readout slots */
    slotLayouts() { return this.looks().filter((v) => v !== 'off' && this.hud.slotsOf(v).length); }
    /** the layout the Readouts tab edits: the one picked there, else the one showing, else the first with slots */
    editLayout() {
        const ls = this.slotLayouts();
        if (this.slotLayout && ls.indexOf(this.slotLayout) >= 0) return this.slotLayout;
        const shown = this.shownName();
        return ls.indexOf(shown) >= 0 ? shown : ls[0] || null;
    }
    sensorText(sn) {
        if (!sn) return '--';
        const u = this.hud.sensorUnit(sn), v = this.hud.sensorValue(sn);
        return v + (sn.suffix && u.charAt(0) === '°' ? u : u ? ' ' + u.toLowerCase().replace(/^°/, '°') : '');
    }

    /** Numbered slots of a layout with what each shows (live) on the left; the sensors to pick from on the right. */
    readoutsTab(cv, bottom) {
        const lay = this.editLayout();
        if (!lay) { label(cv, CX, 70, 'Readouts'); note(cv, CX, 110, ['None of these ' + this.cfg.look.name.toLowerCase() + ' has readout slots.']); return; }
        const slots = this.hud.slotsOf(lay);
        if (!slots.some((x) => x.id === this.slot)) this.slot = slots[0].id;
        // which layout: chips; Reset on the right
        label(cv, CX, 70, this.layoutName(lay) + ' · readout slots');
        let cx = CX;
        this.slotLayouts().forEach((v) => { cx += chip(cv, cx, 82, this.layoutName(v), v === lay, () => { this.slotLayout = v; this.kick(); }, 'slots:' + v) + 8; });
        const rw = cv.textWidth('Reset slots', 16, { font: 'bold', literal: true }) + 30;
        chip(cv, CX + 700 - rw, 82, 'Reset slots', false, () => { slots.forEach((x) => this.hud.setSlot(lay, x.id, null)); this.kick(); }, 'slots:reset');
        // the slots
        // more than 8 slots (Dyno's 13): two columns of compact rows, the name and value only
        const lw = 700, two = slots.length > 8, per = two ? Math.ceil(slots.length / 2) : slots.length;
        const sw = two ? (lw - 8) / 2 : lw, rh = Math.min(56, Math.floor((bottom - 132) / per) - 6);
        slots.forEach((sl, i) => {
            const x = CX + (two && i >= per ? sw + 8 : 0), y = 130 + (i % per) * (rh + 6);
            const sel = sl.id === this.slot, sn = this.hud.slotSensor(lay, sl.id, slots);
            glass(cv, x, y, sw, rh, sel);
            cv.circle(x + 26, y + rh / 2, 14, sel ? C.blue : A(C.blue, 0.75));
            cv.text(String(i + 1), x + 26, y + rh / 2 + 6, 15, '#ffffff', { align: 'center', font: 'bold', literal: true });
            if (two) {
                cv.text(sn ? sn.head : '--', x + 50, y + rh / 2 - 1, 17, '#ffffff', { font: 'bold', literal: true });
                cv.text(sl.where || '', x + 50, y + rh / 2 + 16, 13, C.dim, { literal: true });
                cv.text(this.sensorText(sn), x + sw - 32, y + rh / 2 + 6, 17, C.live, { align: 'right', font: 'bold', literal: true });
            } else {
                cv.text(sn ? sn.name : '--', x + 60, y + rh / 2 - 1, 19, '#ffffff', { font: 'bold', literal: true });
                cv.text(sl.where || '', x + 60, y + rh / 2 + 18, 14, C.dim, { literal: true });
                cv.text(this.sensorText(sn), x + sw - 40, y + rh / 2 + 7, 20, C.live, { align: 'right', font: 'bold', literal: true });
            }
            chevron(cv, x + sw - 18, y + rh / 2, C.dim);
            cv.target(x, y, sw, rh, () => { this.slot = sl.id; if (sn) this.cat = sn.cat; this.kick(); }, 'slot:' + sl.id, 14);
        });
        // the sensors for the picked slot
        const px = CX + lw + 24, pw = CR - px, py = 82, ph = bottom - py - 4;
        cv.card(px, py, pw, ph, 16, [[0, '#ffffff0b'], [1, '#ffffff03']]);
        cv.strokeRoundRect(px, py, pw, ph, 16, 1, C.line);
        const n = slots.findIndex((x) => x.id === this.slot) + 1, cur = this.hud.slotSensor(lay, this.slot, slots);
        label(cv, px + 20, py + 32, 'Slot ' + n + ' · pick a sensor');
        let kx = px + 20;
        sensors.CATS.forEach((c) => { kx += chip(cv, kx, py + 46, c, c === this.cat, () => { this.cat = c; this.kick(); }, 'cat:' + c) + 6; });
        const list = sensors.LIST.filter((x) => x.cat === this.cat), lh = Math.min(48, Math.floor((ph - 100) / list.length));
        list.forEach((sn, i) => {
            const y = py + 94 + i * lh, sel = cur && cur.id === sn.id;
            if (sel) cv.roundRect(px + 10, y, pw - 20, lh - 4, 10, A(C.blue, 0.35));
            else if (i) cv.fillRect(px + 20, y - 2, pw - 40, 1, C.line);
            cv.text(sn.name, px + 24, y + lh / 2 + 4, 18, sel ? '#ffffff' : C.text, { font: sel ? 'bold' : 'label', literal: true });
            cv.text(this.sensorText(sn), px + pw - 24, y + lh / 2 + 4, 17, sel ? '#ffffff' : C.dim, { align: 'right', literal: true });
            cv.target(px + 10, y, pw - 20, lh - 4, () => { this.hud.setSlot(lay, this.slot, sn.id); this.kick(); }, 'sensor:' + sn.id, 10);
        });
    }

    /* ---------- Position (HUD) ---------- */
    /** The whole HUD on black, the part seen through the windshield dashed, the layout where it sits now; move pad and size. */
    positionTab(cv, bottom) {
        const shown = this.shownName(), p = this.hud.placeInfo();
        label(cv, CX, 70, (shown === 'off' ? 'HUD' : this.layoutName(shown)) + ' · where it sits on the glass');
        const k = Math.min(0.9, (bottom - 96) / 480), bw = 800 * k, bh = 480 * k, bx = CX, by = 84;
        cv.card(bx - 10, by - 10, bw + 20, bh + 20, 18, [[0, '#ffffff0b'], [1, '#ffffff03']]);
        cv.roundRect(bx, by, bw, bh, 10, '#000000');
        const pic = shown !== 'off' && previews.get(shown, 'full');
        if (pic) {
            // the picture is the whole 800x480 HUD with the layout unmoved: move it, and scale it about the layout's centre
            const b = p.box, cx = b.w ? b.x + b.w / 2 : 400, cy = b.h ? b.y + b.h / 2 : 240, s = p.scale;
            cv.clip(bx, by, bw, bh);
            cv.image(pic.id, bx + (cx * (1 - s) + p.x) * k, by + (cy * (1 - s) + p.y) * k, 800 * k * s, 480 * k * s);
            cv.noclip();
        } else cv.text(shown === 'off' ? "BMW's own HUD" : 'no picture', bx + bw / 2, by + bh / 2 + 7, 18, C.dim, { align: 'center', literal: true });
        const v = visible.HUD_WINDOW;
        dashed(cv, bx + v.x * k, by + v.y * k, v.w * k, v.h * k, A(C.blueHi, 0.9));
        cv.strokeRoundRect(bx, by, bw, bh, 10, 1, '#ffffff14');
        // the pad
        const rx = bx + bw + 60, pad = 84, gap = 10, mx = rx + pad + gap, my = by + 40;
        label(cv, rx, my - 14, 'Move');
        const step = (dx, dy) => () => {
            if (dx) this.set('hudX', clampStep(this.item('hudX'), (this.get('hudX') || 0) + dx));
            if (dy) this.set('hudY', clampStep(this.item('hudY'), (this.get('hudY') || 0) + dy));
        };
        padBtn(cv, mx, my, pad, 'up', step(0, -10), 'move:up');
        padBtn(cv, rx, my + pad + gap, pad, 'left', step(-10, 0), 'move:left');
        padBtn(cv, mx, my + pad + gap, pad, 'centre', () => { this.set('hudX', 0); this.set('hudY', 0); }, 'move:centre');
        padBtn(cv, mx + pad + gap, my + pad + gap, pad, 'right', step(10, 0), 'move:right');
        padBtn(cv, mx, my + 2 * (pad + gap), pad, 'down', step(0, 10), 'move:down');
        const sy = my + 3 * (pad + gap) + 16, w = CR - rx;
        this.stepRow(cv, rx, sy, w, 'Size', 'hudScale', (val) => val + ' %');
        cv.text('x ' + p.x + '  y ' + p.y, rx, sy + 92, 16, C.dim, { literal: true });
        note(cv, rx, sy + 122, ['The dashed frame is the part of the HUD you can see.', 'Every tap moves the real HUD right away.']);
    }

    /* ---------- Map (cluster) ---------- */
    mapTab(cv) {
        label(cv, CX, 70, 'Navigation map on the cluster');
        let y = 84;
        const w = CW * 0.6;
        y = this.toggleRow(cv, CX, y, w, 'Show Waze map inside the theme', 'mapInTheme');
        // live state from waze.js: the map showing, waiting, the Waze app busy, Waze on Cluster missing
        const info = this.hud.waze ? this.hud.waze.info() : { text: 'Not available in this app', up: false, ok: false };
        let text = info.text;
        if (this.get('mapInTheme') && !this.hud.mapLayout && this.hud.activeName !== 'off') text = 'This theme has no map version (GT3, Sport and M do)';
        glass(cv, CX, y, w, 46, false);
        cv.circle(CX + 26, y + 23, 7, info.up ? C.live : info.ok ? C.dim : '#e0a340');
        cv.text(text, CX + 46, y + 30, 18, info.up ? C.live : C.text, { literal: true });
        y += 54;
        note(cv, CX, y + 26, [
            'On: GT3, Sport and M open a window in the middle and Waze on Cluster draws its map in it, above',
            'BMW\'s own map view, so nothing shows twice. When the map goes away the theme fills back in.',
            'While on, Waze\'s map on the HUD is off (the cluster and the HUD share one picture).',
            'Needs robertnisipeanu\'s Waze on Cluster. Turning this off gives Waze its usual place back.',
        ]);
    }

    /* ---------- Badge (cluster) ---------- */
    /** The series as chips, that series' models to tap, BMW lettering, and what the cluster shows. */
    badgeTab(cv, bottom) {
        const model = this.get('badge'), lw = 760;
        const series = this.series || badges.seriesOf(model) || 'X';
        label(cv, CX, 70, 'Series');
        let cx = CX;
        badges.SERIES.forEach((s) => { cx += chip(cv, cx, 82, s[0], s[0] === series, () => { this.series = s[0]; this.kick(); }, 'series:' + s[0]) + 6; });
        label(cv, CX, 150, 'Model');
        const list = (badges.SERIES.find((s) => s[0] === series) || [null, []])[1];
        const cw = (lw - 12) / 2, rh = Math.min(52, Math.floor((bottom - 162) / Math.ceil(list.length / 2)) - 6);
        list.forEach((m, i) => {
            const x = CX + (i % 2) * (cw + 12), y = 162 + Math.floor(i / 2) * (rh + 6), sel = m === model;
            glass(cv, x, y, cw, rh, sel);
            cv.text(m, x + 18, y + rh / 2 + 7, 19, sel ? '#ffffff' : C.text, { font: sel ? 'bold' : 'label', literal: true });
            if (sel) check(cv, x + cw - 30, y + rh / 2, '#ffffff');
            cv.target(x, y, cw, rh, () => this.set('badge', m), 'badge:' + m, 14);
        });
        // right: what shows, the lettering, none
        const rx = CX + lw + 30, rw = CR - rx, shown = badges.text(model, this.get('badgeBMW') === true);
        label(cv, rx, 70, 'On the cluster');
        cv.card(rx, 82, rw, 110, 16, [[0, '#000000'], [1, '#05070a']]);
        cv.strokeRoundRect(rx, 82, rw, 110, 16, 1, C.line);
        cv.text(shown || 'No badge', rx + rw / 2, 148, shown ? 34 : 22, shown ? '#ffffff' : C.dim, { align: 'center', font: 'bold', literal: true });
        let y = 204;
        y = this.toggleRow(cv, rx, y, rw, 'BMW lettering', 'badgeBMW');
        glass(cv, rx, y, rw, 56, model === 'none');
        cv.text('No badge', rx + 18, y + 35, 19, C.text, { literal: true });
        cv.target(rx, y, rw, 56, () => this.set('badge', 'none'), 'badge:none', 14);
        note(cv, rx, y + 92, ['Drawn as text in the theme\'s own font.', 'GT3: top left. Sport and M: bottom centre.']);
    }

    /* ---------- Alerts (both) ---------- */
    /** Warning limits (the readout flashes red over one) and the shift-light test. */
    alertsTab(cv) {
        label(cv, CX, 70, 'Warnings · the readout flashes red over its limit');
        let y = 84;
        const w = CW * 0.62;
        WARN_KEYS.forEach((k) => { if (this.item(k)) y = this.stepRow(cv, CX, y, w, this.item(k).label.replace(/ warning$/, ''), k); });
        y += 24;
        label(cv, CX, y, 'Shift lights');
        y += 14;
        const testing = this.hud.shiftTesting && this.hud.shiftTesting();
        const d = this.hud.car && this.hud.car.data(), moving = d && !d.demo && d.speed > 3;
        this.rowBox(cv, CX, y, w, 'Test the shift lights', 56);
        const bt = testing ? 'Running' : moving ? 'Stop the car first' : 'Run test', bw = cv.textWidth(bt, 16, { font: 'bold', literal: true }) + 40;
        cv.roundRect(CX + w - bw - 14, y + 10, bw, 36, 18, testing || moving ? '#ffffff12' : C.blue);
        cv.text(bt, CX + w - 14 - bw / 2, y + 34, 16, testing || moving ? C.dim : '#ffffff', { align: 'center', font: 'bold', literal: true });
        if (!testing && !moving) {
            cv.target(CX, y, w, 56, () => {
                if (this.hud.testShift()) { this.kick(); setTimeout(() => this.kick(), 4000); }
            }, 'test:shift', 14);
        }
        note(cv, CX, y + 92, [
            'Runs the rpm up to the shift point for about 4 seconds: the lights fill, go red and flash.',
            'Only while the car stands. Set a limit to 0 (Off) to turn that warning off.',
        ]);
        this.cueColumn(cv, CX + w + 24, CW - w - 24);
    }
    /** Alerts, right column: how the shift lights work (shift_cue.js), temperatures only when they matter (smart_temps.js)
     *  and, in HUD Widgets, the turn-by-turn directions ("navDirections"; the nav widget, hud.js). */
    cueColumn(cv, x, w) {
        let y = 84;
        if (this.item('shiftCue')) {
            label(cv, x, 70, 'Shift lights');
            y = this.pickRow(cv, x, y, w, 'Shift lights', 'shiftCue', (v) => (v === 'rpm' ? 'Rpm band' : 'Count-in'));
            note(cv, x, y + 22, this.get('shiftCue') === 'rpm' ? ['From a fixed rpm up to the shift point.'] : ['Fill over the last second, flash early', 'by your reaction time.']);
            y += 84;
        }
        if (this.item('smartTemps')) {
            label(cv, x, y, 'Temperatures');
            y = this.toggleRow(cv, x, y + 14, w, 'Only when they matter', 'smartTemps');
            note(cv, x, y + 22, ['Oil and coolant show only while cold,', 'warming up or hot. Outside: blue at ' + (this.get('units') === 'us' ? '37 °F.' : '3 °C.')]);
            y += 84;
        }
        if (this.item('navDirections')) {
            label(cv, x, y, 'Directions');
            y = this.pickRow(cv, x, y + 14, w, this.item('navDirections').label, 'navDirections');
            note(cv, x, y + 22, ['The next turn, its distance and the lanes.', 'CarPlay with Apple Maps. Waze sends no turns.']);
        }
    }

    /* ---------- G-meter (both) ---------- */
    /** The range, the trail, which way it draws, the bests with a reset, and a live copy of the meter. */
    gmeterTab(cv, bottom) {
        const lw = 840, g = this.hud.gState ? this.hud.gState() : null;
        label(cv, CX, 70, 'G-meter');
        let y = 84;
        y = this.chipRow(cv, CX, y, lw, 'Range', 'gRange');
        y = this.chipRow(cv, CX, y, lw, 'Trail', 'gTrail');
        const hw = (lw - 12) / 2;
        this.toggleRow(cv, CX, y, hw, 'Swap left / right', 'gFlipLat');
        y = this.toggleRow(cv, CX + hw + 12, y, hw, 'Brake on top', 'gFlipLong');
        // the bests this drive (the car's left / right: gFlipLat turns its sign round)
        glass(cv, CX, y, lw, 104, false);
        cv.text('BEST THIS DRIVE, IN G', CX + 18, y + 26, 13, C.label, { font: 'bold', spacing: 2, literal: true });
        const b = g ? g.best : null, sw = this.get('gFlipLat') === true;
        const cols = [['Left', b && (sw ? b.right : b.left)], ['Right', b && (sw ? b.left : b.right)], ['Accel', b && b.accel], ['Brake', b && b.brake], ['Peak', b && b.total]];
        cols.forEach((c, i) => {
            const x = CX + 18 + i * 118;
            cv.text(c[1] > 0 ? c[1].toFixed(2) : '--', x, y + 66, 28, i === 4 ? '#ffffff' : C.text, { font: 'bold', literal: true });
            cv.text(c[0], x, y + 90, 15, C.dim, { literal: true });
        });
        const bw = 150, bx = CX + lw - bw - 18, by = y + 34;
        cv.roundRect(bx, by, bw, 40, 20, '#ffffff14');
        cv.text('Reset', bx + bw / 2, by + 26, 17, C.text, { align: 'center', font: 'bold', literal: true });
        cv.target(bx, by, bw, 40, () => { if (this.hud.resetG) this.hud.resetG(); this.kick(); }, 'g:reset', 20);
        y += 112;
        note(cv, CX, y + 22, [
            'From the car\'s own acceleration sensor. Parked on level ground it reads 0.00; hills add a little.',
            'The outline is the most g this drive in every direction; Reset clears it with the bests.',
        ]);
        // right: the meter as the layout draws it, live
        const rx = CX + lw + 30, rw = CR - rx, r = Math.min(rw / 2 - 30, (bottom - 120) / 2), cx = rx + rw / 2, cy = 84 + 18 + r;
        label(cv, rx, 70, 'Live');
        if (g) this.gPreview(cv, cx, cy, r, g);
        const now = g && g.live ? (Math.sqrt(g.x * g.x + g.y * g.y)).toFixed(2) + ' g' : 'no g reading';
        cv.text(now, cx, cy + r + 34, 20, g && g.live ? C.text : C.dim, { align: 'center', font: 'bold', literal: true });
    }
    /** The page's copy of the G-meter shader (shaders.js gmeter): bezel, rings, envelope, trail, dot. */
    gPreview(cv, cx, cy, r, g) {
        const max = g.max, step = max > 1.2 ? 0.5 : 0.25, k = (r - 6) / max;
        const ring = (rr, w, c) => cv.arc(cx, cy, Math.max(0, rr - w / 2), rr + w / 2, 0, 360, c);
        ring(r - 1, 2.5, '#c3cad6');
        for (let v = step; v < max - 0.01; v += step) ring(v * k, 1, Math.abs(v / 0.5 - Math.round(v / 0.5)) < 0.01 ? '#ffffff55' : '#ffffff26');
        cv.line(cx - r + 8, cy, cx + r - 8, cy, 1, '#ffffff30');
        cv.line(cx, cy - r + 8, cx, cy + r - 8, 1, '#ffffff30');
        cv.text(max.toFixed(1) + ' g', cx + r * 0.72 + 4, cy - r * 0.72 - 2, 14, C.dim, { literal: true });
        const flipL = this.get('gFlipLong') === true;
        cv.text(flipL ? 'BRAKE' : 'ACCEL', cx, cy - r + 26, 13, C.label, { align: 'center', font: 'bold', spacing: 1.5, literal: true });
        cv.text(flipL ? 'ACCEL' : 'BRAKE', cx, cy + r - 14, 13, C.label, { align: 'center', font: 'bold', spacing: 1.5, literal: true });
        cv.text('L', cx - r + 16, cy - 6, 13, C.label, { align: 'center', font: 'bold', literal: true });
        cv.text('R', cx + r - 16, cy - 6, 13, C.label, { align: 'center', font: 'bold', literal: true });
        const P = (x, y) => { const m = Math.sqrt(x * x + y * y), s = m > max ? max / m : 1; return [cx + x * s * k, cy + y * s * k]; };
        // the envelope: drawn sector m at m * 7.5 degrees, + y up
        const n = g.env.length;
        for (let m = 0; m < n; m++) {
            const a = g.env[m], b = g.env[(m + 1) % n];
            if (!(a > 0.04 || b > 0.04)) continue;
            const t0 = m * 2 * Math.PI / n, t1 = (m + 1) * 2 * Math.PI / n;
            const p0 = P(Math.cos(t0) * a, -Math.sin(t0) * a), p1 = P(Math.cos(t1) * b, -Math.sin(t1) * b);
            cv.line(p0[0], p0[1], p1[0], p1[1], 2, '#eef2f8cc');
        }
        if (!g.live) return;
        const heat = (v) => (v >= 0.8 ? '#ff4b3e' : v >= 0.5 ? '#ffb028' : '#ffffff');
        const pts = [[g.x, g.y]].concat(g.trail);
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = P(pts[i][0], pts[i][1]), b = P(pts[i + 1][0], pts[i + 1][1]), f = i / 15;
            cv.line(a[0], a[1], b[0], b[1], 4 - 3 * f, A(heat(Math.sqrt(g.x * g.x + g.y * g.y)), 0.85 - 0.75 * f));
        }
        const d = P(g.x, g.y), c = heat(Math.sqrt(g.x * g.x + g.y * g.y));
        cv.circle(d[0], d[1], 18, A(c, 0.25));
        cv.circle(d[0], d[1], 10, c);
    }

    /* ---------- Colours (HUD) ---------- */
    coloursTab(cv) {
        label(cv, CX, 70, 'Colours on the glass');
        let y = 84;
        y = this.chipRow(cv, CX, y, CW, 'Theme', 'hudTheme');
        if (this.get('hudTheme') === 'auto') y = this.chipRow(cv, CX, y, CW, 'In daylight', 'dayTheme');
        note(cv, CX, y + 26, ['Auto switches to Night after sunset. The HUD is a projector: bright, solid colours read best.']);
    }

    /* ---------- Settings ---------- */
    settingsTab(cv, bottom) {
        label(cv, CX, 70, 'Settings');
        const keys = this.cfg.settings.filter((k) => this.item(k));
        const colW = (CW - 24) / 2, per = Math.ceil(keys.length / 2);
        // issue #8: the drive mode check (raw signal values, only the signals this app listens to: cfg.modeCheck)
        // under the right column while "Change with the drive mode" is on
        const diag = this.hud.modeDiagLines ? this.hud.modeDiagLines(this.cfg.modeCheck || []) : [];
        // the page's room depends on the screen (bottom 512 without extra room below it): compact rows (46 high,
        // 52 apart) when the full ones, the drive mode check and the status line don't all fit
        const fits = (h, pitch) => 84 + (per - 1) * pitch + h <= bottom - 24 &&
            84 + (keys.length - per) * pitch + 10 + 20 * diag.length <= bottom - 24;
        const h = fits(56, 64) ? 56 : 46, pitch = h === 56 ? 64 : 52;
        keys.forEach((k, i) => {
            const x = CX + (i < per ? 0 : colW + 24), y = 84 + (i % per) * pitch;
            if (y + h > bottom) return;
            const s = this.item(k);
            if (s.type === 'bool') this.toggleRow(cv, x, y, colW, s.label, k, h);
            else if (s.type === 'number') this.stepRow(cv, x, y, colW, s.label, k, null, h);
            else this.pickRow(cv, x, y, colW, s.label, k, null, h);
        });
        // what the engine says it is doing (layers, pixel memory, why nothing shows): for checking on the car
        cv.text(this.hud.lastStatus || '', CX, bottom - 6, 15, C.label, { literal: true });
        const dy = 84 + (keys.length - per) * pitch + 10;
        diag.forEach((t, i) => {
            if (dy + 20 * i > bottom - 24) return;
            // cut to the column (a long value would run off the screen)
            while (t.length > 8 && cv.textWidth(t, 15, { literal: true }) > colW) t = t.slice(0, -1);
            cv.text(t, CX + colW + 24, dy + 20 * i, 15, C.label, { literal: true });
        });
    }

    /* ---------- rows ---------- */
    /** A row's card (h: 56, or 46 for the compact ones); returns its text baseline. */
    rowBox(cv, x, y, w, name, h) {
        glass(cv, x, y, w, h, false);
        const base = y + h / 2 + 7;
        cv.text(name, x + 18, base, 19, C.text, { literal: true });
        return base;
    }
    toggleRow(cv, x, y, w, name, key, h) {
        h = h || 56;
        this.rowBox(cv, x, y, w, name, h);
        const on = this.get(key) === true, tx = x + w - 84, ty = y + h / 2 - 16;
        cv.roundRect(tx, ty, 66, 32, 16, on ? C.blue : '#ffffff1f');
        cv.circle(on ? tx + 50 : tx + 16, ty + 16, 12, on ? '#ffffff' : '#c9d1dc');
        cv.target(x, y, w, h, () => this.set(key, !on), 'set:' + key, 14);
        return y + h + (h < 56 ? 6 : 8);
    }
    pickRow(cv, x, y, w, name, key, fmt, h) {
        h = h || 56;
        const base = this.rowBox(cv, x, y, w, name, h);
        const v = this.get(key), text = fmt ? fmt(v) : this.valueText(key);
        cv.text(text, x + w - 40, base, 19, C.blueHi, { align: 'right', font: 'bold', literal: true });
        chevron(cv, x + w - 24, y + h / 2, C.dim);
        cv.target(x, y, w, h, () => { this.picker = { key, title: name, fmt }; this.kick(); }, 'set:' + key, 14);
        return y + h + (h < 56 ? 6 : 8);
    }
    stepRow(cv, x, y, w, name, key, fmt, h) {
        h = h || 56;
        const base = this.rowBox(cv, x, y, w, name, h);
        const s = this.item(key), steps = s.steps || [], i = steps.indexOf(this.get(key));
        const bx = x + w - 66, ax = bx - 236, by = y + (h - 38) / 2;
        stepBtn(cv, ax, by, '-', i > 0, () => this.set(key, steps[i - 1]), 'dn:' + key);
        cv.text(fmt ? fmt(this.get(key)) : this.valueText(key), ax + 140, base, 19, C.blueHi, { align: 'center', font: 'bold', literal: true });
        stepBtn(cv, bx, by, '+', i < steps.length - 1, () => this.set(key, steps[i + 1]), 'up:' + key);
        return y + h + (h < 56 ? 6 : 8);
    }
    chipRow(cv, x, y, w, name, key) {
        glass(cv, x, y, w, 64, false);
        cv.text(name, x + 18, y + 39, 19, C.text, { literal: true });
        const s = this.item(key), v = this.get(key);
        let cx = x + 220;
        (s.options || []).forEach((o) => { cx += chip(cv, cx, y + 14, o[1], o[0] === v, () => this.set(key, o[0]), 'opt:' + key + ':' + o[0]) + 10; });
        return y + 72;
    }

    /** A list of a setting's choices over the page; a tap on one sets it, a tap beside it closes. */
    drawPicker(cv, bottom) {
        const p = this.picker, s = this.item(p.key), opts = s.type === 'number' ? (s.steps || []).map((v) => [v, null]) : s.options || [];
        cv.fillRect(0, 36, W, bottom + 20, '#000000b0');
        const w = 620, rh = 58, h = 76 + opts.length * rh, x = (W - w) / 2, y = Math.max(52, (bottom + 44 - h) / 2);
        cv.card(x, y, w, h, 18, [[0, '#18233a'], [1, '#0c111b']]);
        cv.strokeRoundRect(x, y, w, h, 18, 1, A(C.blueHi, 0.3));
        cv.text(p.title.toUpperCase(), x + 26, y + 42, 15, C.label, { font: 'bold', spacing: 2.4, literal: true });
        const v = this.get(p.key);
        opts.forEach((o, i) => {
            const ry = y + 60 + i * rh, sel = o[0] === v;
            if (sel) cv.roundRect(x + 12, ry, w - 24, rh - 6, 12, A(C.blue, 0.35));
            const text = p.fmt ? p.fmt(o[0]) : o[1] !== null ? o[1] : fmtInt(o[0]) + ' rpm';
            cv.text(text, x + 30, ry + 34, 20, sel ? '#ffffff' : C.text, { font: sel ? 'bold' : 'label', literal: true });
            if (sel) check(cv, x + w - 50, ry + 26, '#ffffff');
            cv.target(x + 12, ry, w - 24, rh - 6, () => {
                this.picker = null;
                if (LOOK_KEYS.indexOf(p.key) >= 0) this.chooseLayout(p.key, o[0]); else this.set(p.key, o[0]);
            }, 'pick:' + p.key + ':' + o[0], 12);
        });
        cv.target(0, 36, W, bottom, () => { this.picker = null; this.kick(); }, 'pick:close');
    }

    /** The question chooseLayout asks, over the page: the answer button, Cancel, a tap beside it cancels. */
    drawConfirm(cv, bottom) {
        const q = this.confirm, close = () => { this.confirm = null; this.kick(); };
        cv.fillRect(0, 36, W, bottom + 20, '#000000b0');
        const w = 720, h = 96 + q.lines.length * 30 + 84, x = (W - w) / 2, y = Math.max(52, (bottom + 44 - h) / 2);
        cv.card(x, y, w, h, 18, [[0, '#18233a'], [1, '#0c111b']]);
        cv.strokeRoundRect(x, y, w, h, 18, 1, A(C.blueHi, 0.3));
        cv.text(q.title, x + 32, y + 56, 28, '#ffffff', { font: 'bold', literal: true });
        q.lines.forEach((s, i) => cv.text(s, x + 32, y + 98 + i * 30, 19, C.text, { literal: true }));
        const bh = 52, by = y + h - bh - 24;
        const yw = cv.textWidth(q.yes, 18, { font: 'bold', literal: true }) + 56, yx = x + w - 32 - yw;
        cv.roundRect(yx, by, yw, bh, bh / 2, C.blue);
        cv.text(q.yes, yx + yw / 2, by + 33, 18, '#ffffff', { align: 'center', font: 'bold', literal: true });
        cv.target(yx, by, yw, bh, () => { this.confirm = null; q.run(); this.kick(); }, 'confirm:yes', bh / 2);
        const nw = 150, nx = yx - 16 - nw;
        cv.roundRect(nx, by, nw, bh, bh / 2, '#ffffff14');
        cv.text('Cancel', nx + nw / 2, by + 33, 18, C.text, { align: 'center', font: 'bold', literal: true });
        cv.target(nx, by, nw, bh, close, 'confirm:no', bh / 2);
        cv.target(0, 36, W, bottom, close, 'confirm:close');
    }
}

/* ---------- small pieces ---------- */
const LOOK_KEYS = ['hudLayout', 'inComfort', 'inSport', 'inEco'];
const WARN_KEYS = ['warnOil', 'warnCoolant', 'warnBoost'];
/** A warning limit as the page shows it, in the display units: "266 °F", "1.2 bar", "Off". */
function warnText(k, v, us) {
    if (!(v > 0)) return 'Off';
    if (k === 'warnBoost') return us ? Math.round(v * 14.5038) + ' psi' : v.toFixed(1) + ' bar';
    return us ? Math.round(v * 9 / 5 + 32) + ' °F' : v + ' °C';
}
/** a "timeZone" setting value as the row shows it (shared/tz.js) */
function tzText(v) { return tz.name(v); }
function fmtInt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function label(cv, x, y, s) { cv.text(s.toUpperCase(), x, y, 14, C.label, { font: 'bold', spacing: 2.4, literal: true }); }
function note(cv, x, y, lines) { lines.forEach((s, i) => cv.text(s, x, y + i * 26, 17, C.dim, { literal: true })); }
function glass(cv, x, y, w, h, sel) {
    if (sel) {
        cv.card(x, y, w, h, 16, [[0, A(C.blue, 0.16)], [1, A(C.blueDeep, 0.05)]]);
        cv.strokeRoundRect(x, y, w, h, 16, 2, C.blue);
    } else {
        cv.card(x, y, w, h, 16, [[0, '#ffffff0b'], [1, '#ffffff04']]);
        cv.strokeRoundRect(x, y, w, h, 16, 1, C.line);
    }
}
function chip(cv, x, y, text, on, run, key) {
    const w = cv.textWidth(text, 16, { font: 'bold', literal: true }) + 30, h = 36;
    cv.roundRect(x, y, w, h, h / 2, on ? C.blue : '#ffffff12');
    cv.text(text, x + w / 2, y + 24, 16, on ? '#ffffff' : C.off, { align: 'center', font: 'bold', literal: true });
    cv.target(x, y, w, h, run, key, h / 2);
    return w;
}
/** A small chip (the HUD cards' drive modes). */
function miniChip(cv, x, y, text, on, run, key) {
    const w = cv.textWidth(text, 13, { font: 'bold', literal: true }) + 18, h = 28;
    cv.roundRect(x, y, w, h, h / 2, on ? C.blue : '#ffffff12');
    cv.text(text, x + w / 2, y + 19, 13, on ? '#ffffff' : C.off, { align: 'center', font: 'bold', literal: true });
    cv.target(x, y, w, h, run, key, h / 2);
    return w;
}
function stepBtn(cv, x, y, sign, live, run, key) {
    cv.roundRect(x, y, 48, 38, 10, live ? '#ffffff14' : '#ffffff07');
    const c = live ? C.text : '#ffffff30';
    cv.fillRect(x + 15, y + 18, 18, 2.5, c);
    if (sign === '+') cv.fillRect(x + 22.75, y + 10, 2.5, 18, c);
    if (live) cv.target(x, y, 48, 38, run, key, 10);
}
function clampStep(s, v) {
    const st = (s && s.steps) || [v];
    return st.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), st[0]);
}
function dashed(cv, x, y, w, h, c) {
    const d = 10, g = 7;
    for (let t = 0; t < w; t += d + g) { const l = Math.min(d, w - t); cv.fillRect(x + t, y, l, 2, c); cv.fillRect(x + t, y + h - 2, l, 2, c); }
    for (let t = 0; t < h; t += d + g) { const l = Math.min(d, h - t); cv.fillRect(x, y + t, 2, l, c); cv.fillRect(x + w - 2, y + t, 2, l, c); }
}
function padBtn(cv, x, y, s, what, run, key) {
    cv.card(x, y, s, s, 16, [[0, '#ffffff12'], [1, '#ffffff06']]);
    cv.strokeRoundRect(x, y, s, s, 16, 1, C.line);
    const cx = x + s / 2, cy = y + s / 2, a = 13, c = '#ffffff';
    if (what === 'up') cv.quad([[cx, cy - a], [cx + a, cy + a * 0.7], [cx, cy + a * 0.7], [cx - a, cy + a * 0.7]], c);
    else if (what === 'down') cv.quad([[cx, cy + a], [cx - a, cy - a * 0.7], [cx, cy - a * 0.7], [cx + a, cy - a * 0.7]], c);
    else if (what === 'left') cv.quad([[cx - a, cy], [cx + a * 0.7, cy - a], [cx + a * 0.7, cy], [cx + a * 0.7, cy + a]], c);
    else if (what === 'right') cv.quad([[cx + a, cy], [cx - a * 0.7, cy + a], [cx - a * 0.7, cy], [cx - a * 0.7, cy - a]], c);
    else cv.text('Centre', cx, cy + 6, 17, C.blueHi, { align: 'center', font: 'bold', literal: true });
    cv.target(x, y, s, s, run, key, 16);
}
function chevron(cv, x, y, c) { cv.line(x - 4, y - 7, x + 3, y, 2.5, c); cv.line(x + 3, y, x - 4, y + 7, 2.5, c); }
function check(cv, x, y, c) { cv.line(x - 9, y, x - 3, y + 6, 3, c); cv.line(x - 3, y + 6, x + 9, y - 7, 3, c); }

/** Line icons for the rail, about 26 px, centred on (x, y). */
function icon(cv, name, x, y, c) {
    const lw = 2.2;
    if (name === 'screen') {
        cv.strokeRoundRect(x - 13, y - 10, 26, 17, 3, lw, c);
        cv.line(x - 6, y + 12, x + 6, y + 12, lw, c);
    } else if (name === 'map') {
        cv.polyline([[x - 13, y - 8], [x - 5, y - 11], [x + 5, y - 7], [x + 13, y - 10], [x + 13, y + 9], [x + 5, y + 12], [x - 5, y + 8], [x - 13, y + 11], [x - 13, y - 8]], lw, c);
        cv.line(x - 5, y - 11, x - 5, y + 8, lw, c); cv.line(x + 5, y - 7, x + 5, y + 12, lw, c);
    } else if (name === 'colour') {
        cv.arc(x, y, 9.5, 12, 0, 360, c);
        cv.arc(x, y, 0, 10, 180, 360, c);
    } else if (name === 'lines') {
        [-8, 0, 8].forEach((d) => { cv.circle(x - 10, y + d, 2.2, c); cv.line(x - 4, y + d, x + 13, y + d, lw, c); });
    } else if (name === 'move') {
        cv.line(x - 13, y, x + 13, y, lw, c); cv.line(x, y - 13, x, y + 13, lw, c);
        [[0, -13, -4, -9, 4, -9], [0, 13, -4, 9, 4, 9], [-13, 0, -9, -4, -9, 4], [13, 0, 9, -4, 9, 4]].forEach((t) => {
            cv.line(x + t[0], y + t[1], x + t[2], y + t[3], lw, c); cv.line(x + t[0], y + t[1], x + t[4], y + t[5], lw, c);
        });
    } else if (name === 'badge') {
        cv.strokeRoundRect(x - 14, y - 9, 28, 18, 5, lw, c);
        cv.line(x - 7, y, x + 7, y, lw, c);
    } else if (name === 'alert') {
        cv.polyline([[x, y - 12], [x + 13, y + 10], [x - 13, y + 10], [x, y - 12]], lw, c);
        cv.line(x, y - 4, x, y + 3, lw, c);
        cv.circle(x, y + 6.5, 1.4, c);
    } else if (name === 'gmeter') {
        cv.arc(x, y, 11, 13.2, 0, 360, c);
        cv.line(x - 8, y, x + 8, y, 1.4, c); cv.line(x, y - 8, x, y + 8, 1.4, c);
        cv.circle(x + 4.5, y - 4, 3.2, c);
    } else if (name === 'cog') {
        cv.arc(x, y, 6.5, 9, 0, 360, c);
        for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4;
            cv.line(x + Math.sin(a) * 9, y - Math.cos(a) * 9, x + Math.sin(a) * 13, y - Math.cos(a) * 13, 3, c);
        }
    }
}

module.exports = Page;
