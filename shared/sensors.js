'use strict';
/**
 * sensors.js - what a readout slot can show (both apps). Only values the car really sends us (hud.js reads them);
 * nothing is made up. A layout names its slots ("slots": [{ id, where, default }]) and its text widgets show
 *   {{slot:<id>}}      the value            {{slotHead:<id>}}   the name, upper case (the box's heading)
 *   {{slotUnit:<id>}}  the unit, upper case {{slotSuffix:<id>}} '°' for temperatures, else nothing
 *   {{slotHeadU:<id>}} the name and, unless the value carries a °, its unit ("FUEL %": a slot with no unit box)
 *   {{slotHeadS:<id>}} the short name where a theme has less room ("short", else the name: M's slot rows)
 * The pick per layout and slot is kept in <data>/slots.json (hud.js slotSensor / setSlot).
 *
 * Each sensor: id, name (the page), cat (the page's chips), head (upper case, the cluster's heading fonts), tok (a
 * hud.js token, the value; digits, '.', ':' and '-' only, so it fits every value font), unit(us) (upper case).
 * Plain Node 8 (the car's 8.16.2).
 */
const CATS = ['Engine', 'Temps', 'Chassis', 'Fuel', 'Tyres', 'Drive'];
const T = (us) => (us ? '°F' : '°C');
const P = (us) => (us ? 'PSI' : 'BAR');

const LIST = [
    { id: 'rpm', name: 'Engine speed', cat: 'Engine', head: 'RPM', tok: 'rpm', unit: () => '' },
    { id: 'boost', name: 'Boost', cat: 'Engine', head: 'BOOST', tok: 'boost', unit: P },
    { id: 'torque', name: 'Engine torque', cat: 'Engine', head: 'TORQUE', tok: 'torque', unit: (us) => (us ? 'LB-FT' : 'NM') },
    { id: 'power', name: 'Power', cat: 'Engine', head: 'POWER', tok: 'power', unit: (us) => (us ? 'HP' : 'KW') },
    { id: 'torquePct', name: 'Torque, % of max', cat: 'Engine', head: 'TORQUE', tok: 'torquePct', unit: () => '%' },
    { id: 'powerPct', name: 'Power, % of max', cat: 'Engine', head: 'POWER', tok: 'powerPct', unit: () => '%' },
    { id: 'oil', name: 'Oil temperature', cat: 'Temps', head: 'OIL', tok: 'oil', unit: T, suffix: '°' },
    { id: 'coolant', name: 'Coolant temperature', cat: 'Temps', head: 'COOLANT', tok: 'coolant', unit: T, suffix: '°' },
    { id: 'intake', name: 'Intake air temperature', cat: 'Temps', head: 'INTAKE', tok: 'intake', unit: T, suffix: '°' },
    { id: 'ambient', name: 'Outside temperature', cat: 'Temps', head: 'OUTSIDE', tok: 'ambientN', unit: T, suffix: '°' },
    { id: 'speed', name: 'Speed', cat: 'Chassis', head: 'SPEED', tok: 'speed', unit: (us) => (us ? 'MPH' : 'KM/H') },
    { id: 'gLat', name: 'Cornering g', cat: 'Chassis', head: 'LAT G', tok: 'gLat', unit: () => 'G' },
    { id: 'gLong', name: 'Braking / accel g', cat: 'Chassis', head: 'LONG G', tok: 'gLong', unit: () => 'G' },
    { id: 'fuel', name: 'Fuel level', cat: 'Fuel', head: 'FUEL', tok: 'fuelPct', unit: () => '%' },
    { id: 'range', name: 'Range', cat: 'Fuel', head: 'RANGE', tok: 'range', unit: (us) => (us ? 'MI' : 'KM') },
    // plug-in hybrids (330e, X5 45e ...): the high-voltage battery's charge, read from its battery unit (hud.js HV_SOC)
    { id: 'hvSoc', name: 'Hybrid battery (plug-in hybrids)', cat: 'Fuel', head: 'BATTERY', tok: 'hvSoc', unit: () => '%' },
    { id: 'tyrePFL', name: 'Tyre pressure, front left', cat: 'Tyres', head: 'FL', tok: 'tyreP:FL', unit: P },
    { id: 'tyrePFR', name: 'Tyre pressure, front right', cat: 'Tyres', head: 'FR', tok: 'tyreP:FR', unit: P },
    { id: 'tyrePRL', name: 'Tyre pressure, rear left', cat: 'Tyres', head: 'RL', tok: 'tyreP:RL', unit: P },
    { id: 'tyrePRR', name: 'Tyre pressure, rear right', cat: 'Tyres', head: 'RR', tok: 'tyreP:RR', unit: P },
    { id: 'tyreTFL', name: 'Tyre temperature, front left', cat: 'Tyres', head: 'FL', tok: 'tyreT:FL', unit: T, suffix: '°' },
    { id: 'tyreTFR', name: 'Tyre temperature, front right', cat: 'Tyres', head: 'FR', tok: 'tyreT:FR', unit: T, suffix: '°' },
    { id: 'tyreTRL', name: 'Tyre temperature, rear left', cat: 'Tyres', head: 'RL', tok: 'tyreT:RL', unit: T, suffix: '°' },
    { id: 'tyreTRR', name: 'Tyre temperature, rear right', cat: 'Tyres', head: 'RR', tok: 'tyreT:RR', unit: T, suffix: '°' },
    { id: 'shiftAt', name: 'Shift point', cat: 'Drive', head: 'SHIFT AT', tok: 'shiftAt', unit: () => '' },
    { id: 'lastShift', name: 'Last shift', cat: 'Drive', head: 'LAST SHIFT', short: 'SHIFTED', tok: 'lastShift', unit: () => '' },
    { id: 'time', name: 'Clock', cat: 'Drive', head: 'TIME', tok: 'time', unit: null },
];
const BY_ID = {};
LIST.forEach((s) => { BY_ID[s.id] = s; });

module.exports = { CATS, LIST, get: (id) => BY_ID[id] || null };
