'use strict';
/**
 * fake-nav.js - a stand-in for BMW's guidance service on the Mac bench, to see the HUD's directions (the "nav"
 * widget, shared/nav.js + hud_nav.js) without a car. run-app.js installs it into the stub head unit: it answers
 * GuidanceEventList.queryContent (the one method the directions call) with a canned route in the car's own reply
 * format, says CarPlay is guiding (CarPlayManager.projectedGuidanceActive) and feeds the phone's lanes
 * (ProjectedModeGuiding.currentLaneGuiding), the way Redline's 2026-11-09 CarPlay drive showed them.
 *
 *   POST /nav { "scenario": "turn" | "roundabout" | "lanes" | "then" | "uturn" | "off" }   (bench/server.js)
 *
 * The distance counts down 10 m a second from the scenario's start, so the redraw of only the changed digits shows.
 * Street names are made up. Bench only; never on the car.
 */

const EVENT_LIST = 'de.bmw.infotainment.navigation.guiding.GuidanceEventList';
const CARPLAY = 'de.bmw.infotainment.a4a.carplay.CarPlayManager';
const PHONE = 'de.bmw.infotainment.navigation.projectedmodeguiding.ProjectedModeGuiding';

const dist = (m) => (m >= 1000 ? { distance: (m / 1000).toFixed(1), unit: 'KM' } : { distance: String(Math.max(0, Math.round(m / 10) * 10)), unit: 'METER' });
const road = (t) => ({ elements: [{ text: t }] });
const lane = (follow, hi, others) => ({ directionToFollow: follow, directionsToFollow: follow === 'NONE' ? [] : [follow], otherDirections: others || [], isHighlighted: hi, additionalLaneInfo: 'NONE' });

/** The scenarios: the events (first: the next turn) at metres m to go, and the lanes row (null: rows []). */
const SCENARIOS = {
    turn: { from: 450, events: (m) => [{ intersection: { uid: 1, direction: 'RIGHT', formattedDistance: dist(m), description: road('Example Street') } }] },
    roundabout: { from: 300, events: (m) => [{ roundabout: { uid: 2, exitNumber: 3, exitAngle: 270, driveDirection: 'RIGHT', formattedDistance: dist(m), description: road('Main Road') } }] },
    lanes: {
        from: 700,
        events: (m) => [{ intersection: { uid: 3, direction: 'STRAIGHT_ON', formattedDistance: dist(m), description: road('Harbour Bridge') } }],
        lanes: { rows: [{ lanes: [lane('NONE', false, ['LEFT']), lane('STRAIGHT_ON', true), lane('STRAIGHT_ON', true, ['RIGHT']), lane('NONE', false, ['RIGHT'])],
            recommendedCarPositionLaneIndex: 1, laneMarkers: ['SOLID', 'DASHED', 'DASHED', 'DASHED', 'SOLID'] }] },
    },
    // BMW's own navigation lists every turn with its distance to the destination: "then" shows the gap (80 m)
    then: {
        from: 120,
        events: (m) => [
            { intersection: { uid: 5, direction: 'LEFT', formattedDistance: dist(m), distanceToDestination: 900 + m, description: road('Station Road') } },
            { intersection: { uid: 6, direction: 'RIGHT', formattedDistance: dist(m + 80), distanceToDestination: 820 + m, description: road('Mill Lane') } },
        ],
    },
    uturn: { from: 200, events: (m) => [{ intersection: { uid: 7, direction: 'UTURN_LEFT', formattedDistance: dist(m), description: road('') } }] },
};

/** install(hu, log): patches the stub's ctx.signals; returns { set(scenario) }. */
function install(hu, log) {
    const S = hu.ctx.signals, proxy = S.proxy, call = S.call;
    let sc = null, since = 0, timer = null;
    const metres = () => Math.max(0, sc.from - Math.floor((Date.now() - since) / 1000) * 10);
    S.proxy = (iface, inst) => (iface === EVENT_LIST ? Promise.resolve({ fakeNav: true }) : proxy(iface, inst));
    S.call = (p, method, params, ms) => {
        if (!(p && p.fakeNav)) return call(p, method, params, ms);
        if (!sc) return Promise.resolve({ viewContent: [{ eventsInView: [] }] });
        return Promise.resolve({ viewContent: [{ eventsInView: sc.events(metres()) }] });
    };
    const feed = () => {
        hu.feed(CARPLAY, 'projectedGuidanceActive', !!sc);
        hu.feed(PHONE, 'currentLaneGuiding', sc && sc.lanes ? sc.lanes : { rows: [] });
    };
    return {
        set(name) {
            sc = SCENARIOS[name] || null;
            since = Date.now();
            if (!timer) timer = setInterval(feed, 1000);
            feed();
            log.info('bench: fake directions ' + (sc ? name : 'off (no route)'));
        },
    };
}

module.exports = { install, SCENARIOS };
