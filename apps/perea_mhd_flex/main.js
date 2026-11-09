'use strict';
/**
 * Flex Fuel - the ethanol content an MHD-flashed DME runs on, read over the head unit's own
 * diagnostic link (InternalTasu, DME 0x12): "Ethanol Content (Active)", what the tune uses,
 * and "Ethanol Content (CAN)", what the flex fuel sensor reports, as two dials; a third dial with
 * the fuel in the tank (the cluster's KombiIF signal, as the Live Data app shows it), and under them
 * the blend calculator: the ethanol to add, at the purity set in Settings, to take the tank from the
 * sensor's reading to the target (calc.js; the target is changed on the page with -5 / +5 where the
 * kit runs the screen, and in Settings anywhere).
 *
 * Read-only: the app sends 2F 04 "MHD" (is MHD there), 22 F1 01 / F1 02 (which ROM), 2C 03 / 2C 02
 * F303 (its own dynamic identifier over the two bytes; F301 when F303 is refused) and 22 F3 03 (the
 * read). Nothing is written to the car; the identifier is the DME's volatile table and goes with the
 * ignition. Protocol: protocol.js, loop and states: poller.js, screen: ui.js. With "Demo data" on (or
 * Auto without a diagnostic transport, as in the emulator) the dials show made-up values and nothing
 * is sent. The screen flags two disagreements between the sensor and the tune (ui.js): "Flex fuel
 * disabled" in amber when Active is 0 while CAN reads ethanol, and a MISMATCH badge when the two are
 * 10 points or more apart.
 *
 * Fuel level, from two sources so the finer one that answers on a car can be used (the setting "Fuel
 * source": Auto takes the DME, else the cluster; or one of them): the DME's two tank halves (22 5949 /
 * 22 594A, 0.5 l each, read by the poller between its MHD steps) and the cluster's SOME/IP
 * de.bmw.infotainment.KombiIF statusRangeTankStatus.fluidLevelFuelTank (whole litres; 255 and up: no data;
 * read again every 10 s since a car may not notify it). A reading older than 60 s counts as gone. "Show fuel
 * sources" draws them all on the screen, and the raw values go to the log once a minute.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Recorder } = require('./kit/record');
const { Diag } = require('./kit/diag');
const UI = require('./ui');
const { Poller } = require('./poller');
const { DME, PROFILES } = require('./protocol');
const LOGO = require('./logo');
const { round1, pickFuel } = require('./calc');

const KOMBI = 'de.bmw.infotainment.KombiIF';
const TANK_POLL_MS = 10000, TANK_STALE_MS = 60000, TANK_LOG_MS = 60000, TANK_NO_DATA = 255;
const TARGET_MIN = 10, TARGET_MAX = 100, TARGET_STEP = 5;
const DEFAULTS = { target: 85, purity: 99, tank: 60 };

/** A setting's value as a number, or `dflt` when it is missing or not numeric. */
const num = (x, dflt) => (x === null || x === undefined || x === '' || !isFinite(Number(x)) ? dflt : Number(x));

/**
 * Demo values: a slow wander around 50-80 %, CAN a touch off Active, and in every 25 s a spell of
 * 6 s with Active at 0 (the "disabled" note with the sensor still reading) and one of 6 s with CAN
 * 25 points above Active (the MISMATCH badge). The tank drifts slowly between 16.6 and 32.6 litres.
 */
function demoValues(t) {
    const base = Math.round(50 + 30 * Math.sin(t / 9000));
    const phase = t % 25000;
    const can = phase >= 12000 && phase < 18000 ? base + 25 : base + 2 * Math.sin(t / 2500);
    return { active: phase < 6000 ? 0 : base, can: Math.max(0, Math.min(100, Math.round(can))), fuel: round1(24.6 + 8 * Math.sin(t / 60000)) };
}

/** Demo readings of every fuel source, consistent with `fuel` litres (the sources line). */
function demoFuelAll(fuel) {
    const half = Math.round(fuel) / 2, dme = Math.round(fuel * 2) / 2;
    return { kombi: Math.round(fuel), kombiL: Math.floor(half), kombiR: Math.ceil(half), dme, dmeL: round1(dme / 2), dmeR: round1(dme - dme / 2), dmeTotal: Math.round(fuel) };
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const diag = new Diag(ctx.signals, log);
        diag.quiet = true;
        await diag.init();                 // never throws: without a transport diag.p stays null
        const poller = new Poller({
            physical: (sid, data, ms, accept) => diag.physical(DME, sid, data, ms, accept),
            available: () => !!diag.available,
            hasLink: () => !!diag.p,
            log, config: ctx.spec.config, profiles: PROFILES,
        });
        // demo: Always, or Auto without a diagnostic transport (the emulator, a preview); never while the car answers
        const demo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !diag.p);

        // the fuel in the tank from the cluster's signal (litres; null until it comes, or when it is gone), with
        // its two tank halves as sent (scale unknown: shown raw on the sources line)
        const tank = { litres: null, left: null, right: null, at: 0, logged: 0 };
        const kombiFresh = () => Date.now() - tank.at < TANK_STALE_MS;
        /** every fuel source as the screen compares them: null where there is no fresh reading */
        const fuelAll = (src) => ({
            kombi: tank.litres != null && kombiFresh() ? tank.litres : null,
            kombiL: tank.left != null && kombiFresh() ? tank.left : null,
            kombiR: tank.right != null && kombiFresh() ? tank.right : null,
            dme: src.dme, dmeL: src.dmeL.fresh ? src.dmeL.value : null, dmeR: src.dmeR.fresh ? src.dmeR.value : null,
            dmeTotal: src.dmeTotal.fresh ? src.dmeTotal.value : null,
        });
        const setting = (key) => num(settings.get(key), DEFAULTS[key]);
        /** -5 / +5 on the page: the target setting, kept to 10..100 (the setting's own steps) */
        const setTarget = (d) => settings.set('target', Math.max(TARGET_MIN, Math.min(TARGET_MAX, setting('target') + d)));

        const render = async () => {
            const v = poller.view();
            v.target = setting('target'); v.purity = setting('purity'); v.tankCap = setting('tank');
            const all = fuelAll(v.fuel);
            if (demo()) {
                Object.assign(v, demoValues(Date.now()), { state: 'reading', demo: true, stale: false });
                v.fuelSource = 'demo'; v.fuelAll = demoFuelAll(v.fuel);
            } else {
                const pick = pickFuel(all, settings.get('fuelSource'));
                v.fuel = pick.litres; v.fuelSource = pick.source; v.fuelAll = all;
            }
            v.showSources = !!settings.get('fuelSources');
            v.setTarget = setTarget;
            const cv = ctx.canvas(UI.W, UI.H) || new Recorder(UI.W, UI.H);   // (the kit records every frame; software plays it back)
            UI.draw(cv, G, ctx.theme(), v, LOGO);
            await ui.image('MAIN_GFX', cv);
        };
        const loop = ctx.loop('MAIN', 4, render);

        diag.on('available', (on) => { poller.linkChanged(on); loop.kick(); });
        ui.onVisible((name, on) => { if (name === 'MAIN') poller.setVisible(on); });
        poller.setVisible(ui.isVisible('MAIN'));
        poller.setPaused(demo());
        settings.onChange(() => { poller.setPaused(demo()); loop.kick(); });
        poller.start();

        // the cluster's fuel level (the installer leaves KombiIF out on a unit without it: then no fuel dial)
        if (ctx.signals && typeof ctx.signals.watch === 'function') {
            ctx.signals.watch(KOMBI, '1', {
                statusRangeTankStatus: (s) => {
                    const litres = (x) => { const n = num(x, NaN); return isFinite(n) && n >= 0 && n < TANK_NO_DATA ? n : null; };
                    const raw = s ? s.fluidLevelFuelTank : undefined;
                    tank.litres = litres(raw);
                    tank.left = litres(s ? s.fluidLevelFuelTankLeftHand : undefined);
                    tank.right = litres(s ? s.fluidLevelFuelTankRightHand : undefined);
                    tank.at = Date.now();
                    if (Date.now() - tank.logged > TANK_LOG_MS) {
                        tank.logged = Date.now();
                        log.info('perea_mhd_flex: fluidLevelFuelTank raw=' + JSON.stringify(raw) + (tank.litres == null ? ' (no data)' : ' -> ' + tank.litres + ' L')
                            + ' halves L=' + JSON.stringify(s ? s.fluidLevelFuelTankLeftHand : undefined) + ' R=' + JSON.stringify(s ? s.fluidLevelFuelTankRightHand : undefined));
                    }
                    loop.kick();
                },
            }, log, { pollMs: TANK_POLL_MS }).then((s) => {
                if (s && s.error) log.info('perea_mhd_flex: no fuel level signal (' + s.error + ')');
            }, (e) => log.warn('perea_mhd_flex: KombiIF ' + e));
        }

        await render();
        log.info('perea_mhd_flex ready (transport=' + (diag.p ? 'up' : 'none') + ', demo=' + demo() + ', target=' + setting('target') + ' %, purity=' + setting('purity') + ' %, tank=' + setting('tank') + ' L, fuel source=' + settings.get('fuelSource') + ')');
    },
});

module.exports = { demoValues, demoFuelAll, TARGET_STEP };
