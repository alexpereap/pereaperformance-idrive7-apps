'use strict';
/**
 * runs.js - the 0-60 timer (the Drag theme): 0 to 60 mph, or 0 to 100 km/h in metric units.
 *
 * Armed once the car has stood still (under 1 km/h) for half a second. The clock starts the moment the speed
 * goes over 1 km/h and stops when it reaches the target; the finish time is interpolated between the two speed
 * samples either side of the target, so it isn't rounded to the signal's update rate. A run is dropped if the car
 * stops again or takes longer than 30 s. The best time per unit is kept in <data>/runs.json.
 * Timed from the car's speed signal (Vehicle2 statusCarSpeed2), which reads a little under BMW's own speedometer
 * (BMW over-reads on purpose), so it is honest but not a timing gear.
 *
 * Plain Node 8 (the car's 8.16.2).
 */
const fs = require('fs');
const path = require('path');

const STILL_KMH = 1;            // under this the car is standing
const ARM_MS = 500;             // standing this long arms the timer
const MAX_MS = 30000;           // a run that takes longer is dropped
const TARGET = { us: 96.5606, metric: 100 };   // 60 mph, 100 km/h, in km/h

class Runs {
    constructor(dataDir, log) {
        this.log = log;
        this.file = path.join(dataDir || '.', 'runs.json');
        this.best = {};             // { us: s, metric: s }
        try { this.best = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch (e) { /* none yet */ }
        this.state = 'idle';        // idle | armed | run | done
        this.stillSince = null;
        this.t0 = 0;
        this.last = null;           // the last finished run, s
        this.prev = null;           // the sample before this one: [t, kmh]
        this.onStart = null;        // called when a run starts (the Drag theme's peak boost resets)
    }

    /** One speed sample (km/h, or null) at time `now` (ms); `unit` 'us' | 'metric'. */
    update(kmh, now, unit) {
        if (typeof kmh !== 'number' || !isFinite(kmh)) { this.prev = null; return; }
        const target = TARGET[unit] || TARGET.us;
        if (kmh < STILL_KMH) {
            if (this.state === 'run') { this.state = 'idle'; this.log.info('0-60: run dropped (stopped)'); }
            if (this.stillSince === null) this.stillSince = now;
            if (now - this.stillSince >= ARM_MS && this.state !== 'armed') this.state = 'armed';
        } else {
            this.stillSince = null;
            if (this.state === 'armed') {
                this.state = 'run'; this.t0 = now;
                if (this.onStart) this.onStart();
            } else if (this.state === 'run') {
                if (now - this.t0 > MAX_MS) { this.state = 'idle'; this.log.info('0-60: run dropped (over 30 s)'); }
                else if (kmh >= target) {
                    let t = now;
                    if (this.prev && kmh > this.prev[1]) t = this.prev[0] + (now - this.prev[0]) * (target - this.prev[1]) / (kmh - this.prev[1]);
                    const s = Math.max(0, (t - this.t0) / 1000);
                    this.last = s; this.state = 'done';
                    this.log.info('0-' + (unit === 'metric' ? '100 km/h' : '60 mph') + ': ' + s.toFixed(2) + ' s');
                    if (!(this.best[unit] > 0) || s < this.best[unit]) {
                        this.best[unit] = s;
                        try { fs.writeFileSync(this.file, JSON.stringify(this.best)); } catch (e) { this.log.warn('runs: cannot save the best time: ' + e.message); }
                    }
                }
            }
        }
        this.prev = [now, kmh];
    }

    /** The time to show, s: the running clock during a run, else the last run, else null. */
    shown(now) {
        if (this.state === 'run') return (now - this.t0) / 1000;
        return this.last;
    }

    /** READY (armed), GO (timing), DONE, or '' */
    word() { return { armed: 'READY', run: 'GO', done: 'DONE' }[this.state] || ''; }
}

module.exports = Runs;
