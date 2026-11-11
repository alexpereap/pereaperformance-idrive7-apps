'use strict';
/**
 * signals.js - read live vehicle signals over SOME/IP.
 *
 * Interface configs come from the app's own oap_<uid>/someipInterfaces/,
 * which the installer generates from the app's manifest.json with BMW's own
 * generator (kit/tools/oapgen) against the unit's master catalog
 * /etc/oap/someip/someip-interfaces.json - exactly what MainApp does when it
 * installs an app. So any interface/field listed in app.json "signals" is
 * reachable, not just the trimmed MainApp subset.
 *
 *   const sub = await signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
 *       statusEngineSpeed2: (v) => rpm = v.actualValueRPMEngineCrankshaft,
 *   });
 *   sub.available  // true once the provider (the car) answers
 *
 * iDrive 8 (allowTyped, set by mgu.js there): the app manager does not generate those configs, and the
 * apps that read the car there use the SDK's own typed proxies (someipBuilders.buildAndInitTypedProxy).
 * So where the native module or an interface's config is missing, the proxy is the SDK's, wrapped to the
 * shape the rest of this file uses (callMethod, subscribe, getValue, availability). backends() says which
 * each interface got.
 */
const fs = require('fs');
const path = require('path');

let someip = null;
try { someip = require('someip'); } catch (e) { /* host preview / not installed */ }

const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIRS = [path.join(APP_ROOT, 'someipInterfaces'), path.join(__dirname, '..', '..', 'someipdefs')];

// The native binding deadlocks (main thread stuck on a futex) when buildProxy/
// init run inline inside the app's promise chains next to the SDK's own SOME/IP
// traffic. The SDK always calls them from a fresh setImmediate tick, one at a
// time - do the same.
let typedOk = false, typedLog = null;
const backend = {};                          // interface -> 'raw' | 'typed' | 'none (why)'
function allowTyped(on, log) { typedOk = !!on; typedLog = log || null; }
function backends() { return Object.assign({}, backend); }

/** An SDK typed proxy in the raw proxy's shape. Fields and broadcasts are members with subscribe / getValue; methods are functions. */
function typedAdapter(px) {
    const member = (name) => (px && px[name] !== undefined ? px[name] : null);
    return {
        typed: true, px,
        init() { return Promise.resolve(this); },
        callMethod(method, params) {
            const fn = member(method);
            if (typeof fn !== 'function') return Promise.reject(new Error('typed proxy has no method ' + method));
            return Promise.resolve(fn.call(px, params || {}));
        },
        subscribe(o) {
            const m = member(o.name);
            if (!m || typeof m.subscribe !== 'function') return Promise.reject(new Error('typed proxy has no ' + o.name + ' to subscribe to'));
            return Promise.resolve(m.subscribe(o.onReceive));
        },
        hasGetter(name) { const m = member(name); return !!(m && typeof m.getValue === 'function'); },
        getValue(name) {
            const m = member(name);
            if (!m || typeof m.getValue !== 'function') return Promise.reject(new Error('typed proxy has no getter for ' + name));
            return Promise.resolve(m.getValue());
        },
        setValue(name, value) {
            const m = member(name);
            if (!m || typeof m.setValue !== 'function') return Promise.reject(new Error('typed proxy has no setter for ' + name));
            return Promise.resolve(m.setValue(value));
        },
        // (built and initialised means the provider answered)
        subscribeToAvailability(fn) { setImmediate(() => fn(true)); return null; },
        isAvailable() { return true; },
        shutdown() { return Promise.resolve(); },
    };
}
function typedProxy(iface, instance) {
    let builders = null;
    try { builders = require('oap-sdk').someipBuilders; } catch (e) { /* no SDK (host preview) */ }
    if (!builders || typeof builders.buildAndInitTypedProxy !== 'function') return Promise.reject(new Error('this oap-sdk has no someipBuilders.buildAndInitTypedProxy'));
    let timer;
    const late = new Promise((res, rej) => { timer = setTimeout(() => rej(new Error('typed proxy: no answer after 15 s')), 15000); });
    return Promise.race([Promise.resolve().then(() => builders.buildAndInitTypedProxy(iface, String(instance), { timeoutMs: 10000 })), late])
        .then((px) => { clearTimeout(timer); return typedAdapter(px); }, (e) => { clearTimeout(timer); throw e; });
}

/** The proxy for an interface instance: { p, cfg } - the raw one from the app's config, else (allowTyped) the SDK's typed one. */
function open(iface, instance) {
    let cfg = null, why = '';
    if (!someip) why = 'someip native module not available';
    else { try { cfg = loadConfig(iface); } catch (e) { why = String(e && e.message || e); } }
    if (cfg) {
        return nativeTick(() => someip.buildProxy(cfg, String(instance)).then((px) => px.init().then(() => px)))
            .then((p) => { backend[iface] = 'raw'; return { p, cfg }; });
    }
    if (!typedOk) { backend[iface] = 'none (' + why + ')'; return Promise.reject(new Error(why)); }
    return typedProxy(iface, instance).then((p) => {
        backend[iface] = 'typed';
        if (typedLog) typedLog.info('signals backend: ' + iface + ' (' + instance + ') typed proxy of the SDK (' + why + ')');
        return { p, cfg: null };
    }, (e) => {
        backend[iface] = 'none (' + why + '; typed: ' + (e && e.message || e) + ')';
        if (typedLog) typedLog.warn('signals backend: ' + iface + ' (' + instance + ') none: ' + why + '; typed proxy: ' + (e && e.message || e));
        throw new Error(why + '; typed proxy: ' + (e && e.message || e));
    });
}

let chain = Promise.resolve();
function nativeTick(fn) {
    const run = () => new Promise((resolve, reject) => setImmediate(() => { try { Promise.resolve(fn()).then(resolve, reject); } catch (e) { reject(e); } }));
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
}

function loadConfig(iface) {
    const f = iface.replace(/\./g, '_') + '.json';
    for (const d of DIRS) {
        try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch (e) { /* next */ }
    }
    throw new Error('no SOME/IP config for ' + iface + ' (add it to app.json "signals")');
}

/**
 * Build a proxy and subscribe to fields. handlers = { fieldName: fn(value) }.
 * Also does an initial getValue() for fields that have a getter, so values
 * show up without waiting for the next change.
 * opts.pollMs: also re-read those fields that often while the provider is available - for
 * fields a car may not notify (BMW's x_call only ever reads TPMS, it never subscribes).
 */
async function watch(iface, instance, handlers, log, opts) {
    const res = { iface, available: false, proxy: null, error: null, shutdown: () => Promise.resolve() };
    if (!someip && !typedOk) { res.error = 'someip native module not available'; return res; }
    try {
        const o = await open(iface, instance);
        const cfg = o.cfg, p = o.p;
        res.proxy = p;
        res.shutdown = () => Promise.resolve().then(() => p.shutdown && p.shutdown()).catch(() => {});
        const fields = Object.keys(handlers || {});
        const fetchAll = () => fields.forEach((f) => {
            if (cfg ? cfg.fields && cfg.fields[f] && cfg.fields[f].getter : p.hasGetter && p.hasGetter(f)) {
                p.getValue(f, 3000).then((v) => handlers[f](v)).catch(() => {});
            }
        });
        await nativeTick(() => {
            try { return p.subscribeToAvailability((a) => { res.available = !!a; if (a) setImmediate(fetchAll); }); } catch (e) { return null; /* older binding */ }
        });
        for (const f of fields) {
            try {
                await nativeTick(() => p.subscribe({ name: f, onReceive: (v) => { try { handlers[f](v); } catch (e) { if (log) log.warn(iface + '.' + f + ': ' + e); } } }));
            } catch (e) {
                if (log) log.warn('subscribe ' + iface + '.' + f + ': ' + e);
            }
        }
        if (p.isAvailable && p.isAvailable()) { res.available = true; fetchAll(); }
        if (opts && opts.pollMs) setInterval(() => { if (res.available) setImmediate(fetchAll); }, opts.pollMs);
    } catch (e) {
        res.error = String(e);
        if (log) log.warn('signals ' + iface + ': ' + e);
    }
    return res;
}

/** Call a method on an interface instance (e.g. UDS over InternalTasu). */
async function proxy(iface, instance) {
    if (!someip && !typedOk) throw new Error('someip native module not available');
    return (await open(iface, instance)).p;
}

/** Call a method on a proxy from proxy(); params = the method's argument struct. */
function call(p, method, params, timeoutMs) {
    return nativeTick(() => p.callMethod(method, params || {}, timeoutMs || 5000));
}

/**
 * Write a field that has a setter (e.g. ConditionBasedServicesLegacy.cBSReset) on a proxy from
 * proxy() or watch().proxy, as BMW's SDK does (_someIpProxy.setValue). value = the field's struct;
 * resolves when the provider took it. Needs "w" in the field's app.json flags, or the installer
 * leaves the setter out of the app's interface config.
 */
function set(p, field, value, timeoutMs) {
    return nativeTick(() => p.setValue(field, value, timeoutMs || 5000));
}

/** Subscribe to a broadcast/event or field on a proxy from proxy(). */
function on(p, name, fn, log) {
    return nativeTick(() => p.subscribe({ name, onReceive: (v) => { try { fn(v); } catch (e) { if (log) log.warn(name + ': ' + e); } } }));
}

/** Availability of a proxy's provider; fn(bool) on every change. */
function onAvailable(p, fn) {
    return nativeTick(() => { try { return p.subscribeToAvailability((a) => fn(!!a)); } catch (e) { return null; } })
        .then(() => { if (p.isAvailable && p.isAvailable()) fn(true); });
}

module.exports = { watch, proxy, call, set, on, onAvailable, loadConfig, hasNative: () => !!someip, allowTyped, backends };
