'use strict';
/**
 * The drawing engine, shared by every bimmer-lab app that draws through cluster-render
 * (robertnisipeanu/idrive-apps, native/cluster-render): it connects, builds the active layout's layers in
 * the active theme (one effect layer per shader widget, the image widgets packed into sheets, below), and
 * keeps live widgets updated from the kit's car.js.
 * Started by an app's main.js with the kit's ctx (settings, signals, log, spec, dataDir).
 * It lives in the repo's shared/ folder; app.json "shared" ships it with each app.
 *
 * Which display: app.json config.target, "hud" (800x480, the windshield HUD; the default) or
 * "panel" (1920x720, the whole instrument cluster, drawn over BMW's own gauges).
 * config.statusName names it on the status row ("HUD", "Cluster").
 * Which layout: with the "byMode" setting on and the car's drive mode known (FES
 * statusFESVehicleDynamicSwitchHMI), the "inComfort" / "inSport" / "inEco" setting; otherwise "hudLayout".
 * The layout name "off" draws nothing, so BMW's own HUD or cluster shows (and the other app can have the
 * shared scene: cluster-render never shows the HUD and the cluster panel at once). The two apps tell each other
 * what they show (screen.js): when the driver gives the screen to the other one (page.js asks first), this one
 * draws nothing until a theme or layout is picked on its own page again.
 * The colour theme is the layout's own "theme" when it has one (the cluster themes), else the "hudTheme"
 * setting (auto = Night after sunset).
 *
 * Effect shaders: cluster-render's v_uv has (0,0) at the TOP-left (PROTOCOL.md; confirmed on the car,
 * Nov 4 2026, when a box's header strip drew at the bottom). The bench draws the same way.
 *
 * Layer packing (Nov 5 2026): cluster-render draws at most 8 layers per client connection (its
 * CompositorLimits.per_client; 32 across all clients; a 9th is refused with "too many layers"), which the car
 * photos showed as a theme's shaders plus the first few text widgets. So the image widgets (text, scale, stripe, badge, gridlabels, icon, swatchimg) are
 * packed into SHEETS, one image layer per sheet, instead of one layer each. Widgets are grouped by
 * (class, z) and placed in file order: a widget goes into the first sheet of its group opened after every
 * earlier layer or widget its rect intersects (so an image widget never clobbers one it overlaps, and
 * file order still decides what is on top) AND whose union box with it stays within the sheet size limit,
 * else a new sheet is opened. A sheet's rect is the union box of its members (iw/ih that size). On create
 * every member is painted into a local buffer and the sheet is sent whole once (a 1920x720 RGBA whole write
 * is 5,529,600 bytes, under the 5,529,664 message limit; the client keeps its own whole copy); after that
 * every member update is a dirty rect of the sheet, translated by the sheet's offset (_blit; gridlabels
 * keeps its small-rects path). Effect widgets are one layer each, as before. An image widget with
 * "own": true gets its own layer as before (the calibration probes use it to count how many layers the car
 * draws).
 * Sheet size vs layer count: a rebuild re-sends every sheet whole, through the car's upload budget (floor
 * 2000 KB/s, ceiling 5500, the HUD gets at most half), so sheets are kept small: the limit starts at a
 * quarter of the target area (345,600 px on the panel, 96,000 on the HUD). If that needs more than
 * LAYER_BUDGET (8) layers in all (effects + own + sheets), the limit is doubled and the layout re-planned,
 * up to unlimited; if even unlimited needs more than 8, a warning says so and the layout is drawn anyway.
 * The rebuild log line names the layout, widget and layer counts, the limit used and the bytes of the
 * whole-sheet writes; the status row names the layer count, not the widget count; and two seconds after a
 * rebuild cluster-render's own status text is asked for and logged.
 *
 * Widget types (hud/layouts/*.json, or <data>/layouts/ overrides, see layouts.js):
 *   text      image layer; template tokens below, a font from hud/fonts, colour role
 *   scale     image layer; the shift bar's rpm numbers (0 .. bar max / 1000), evenly spread
 *   stripe    image layer; the M tricolour stripe
 *   shiftbar  effect layer; shaders.js shiftbar, lit by rpm, zones from the redline
 *   arc       effect layer; shaders.js arc, lit by a signal between min and max
 *   revbar    effect layer; shaders.js revbar, the G20-style slanted rev bar (Redline layout):
 *             "barH" bar height, "top" room for the marks above it, "slant" px, "over" rpm past the
 *             redline's thousand the scale runs to (1000: a 7000 redline gives 0..8)
 *   lights    effect layer; shaders.js lights, shift lights filling from "from" rpm (3000) up to the shift point
 *   badge     image layer; a rounded tag with text: "tone" verdict (the last shift's grade colour) or cold
 *   fill      effect layer; a solid colour (role "color", default "bg") over the whole widget, with an
 *             optional see-through "hole": [x, y, w, h] in target px, cut only while the bool setting
 *             "holeWhen" is on (true: always; the cluster's map window), shrunk by "holeInset" px on every side (6) with
 *             "holeRadius" px corners (28), so BMW's own cluster doesn't peek out at the window's corners.
 *             Opaque fill hides BMW's gauges under it.
 *   box       effect layer; a framed box: "fill" and "line" roles, "border" px, "radius" px, and a
 *             header strip "head" px tall in role "headColor" (its label is a text widget on top)
 *   mdash     effect layer; the M theme's whole backdrop (shaders.js mdash): "card" [x, yBottom, rBottom, rTop] (the
 *             left card, traced off the M8 photo: outer edge x, bottom y, the big round at the bottom outer corner, the
 *             rounding where the top curve meets the outer edge; the right card is its mirror), "cardTop" [a, b, c] (the
 *             card's top edge, y = a x^2 + b x + c), "cardCutR" [cx, cy, r] (the right card's lower outer corner cut on
 *             that circle, in the mirrored left frame), "cardFill" 0..1 (grey level, 0 = black: outline only), "blade" { xm, ym,
 *             kTop, kBot, round } (the left rev blade's outer edge, as mtach; the card ends "bladeGap" px before it),
 *             "line" [x0, y, x1, cap], "tyres" [cx, cy, scale] (the tyre block's car glyph and dividers; the eight
 *             readouts are text widgets with {{tyreP:FL}} .. {{tyreT:RR}} and {{u:pressure}}), "gaugeL" / "gaugeR" { cx, cy, r, (a dial as the M8's: a thin glass bracket whose outer edge is the circle cx, cy, r, lit from the bottom up to the value, drawn over the card; the right one is the left one's mirror)
 *             signal, min, max }, "mark" [x, y, scale], "segbars" [{ x, y, w, h, max, signal } x up to 4] (the
 *             setup level bars, "segSlant" px; the segment at round(signal) is red). Positions in target px.
 *   mtach     effect layer; the M rev bar: "side" left|right, "max" rpm, and in target px for the LEFT bar
 *             "y0" (0 rpm), "y8" (max), "ym" (the bend), "xm" (outer edge x at the bend; the right bar gives
 *             its own, mirrored), "kTop" / "kBot" (x per y px above / below the bend), "round", "wBot" / "wTop" / "wBend"
 *   mview     effect layer; the whole M view theme (shaders.js mview, layout made by design/gen_mview.py): "path" (the
 *             left scale's line, target px, at most 32 points, its corners already rounded; the right scale is its
 *             mirror), "scale" [arc length at 0, at the top mark], "dial" [x, y, r] and "dialAng" [full, empty] (the fuel
 *             dial; the oil one is its mirror), "line" [x0, x1, y, bottom line end x]; speed 0..MVIEW_SPEED, revs
 *             0..MVIEW_RPM; the map window as fill ("hole", "holeWhen"), an oval feathered over "holeOval" px if set;
 *             "panel" [[top x, y], [middle x, y], [bottom x, y], inset]: the dark panel inside the left scale (from
 *             inset px inside the line to that chevron edge; mirrored right) and BMW's red glow by the needle. A layout with "mapLive": true and no widget
 *             toggled on mapUp opens and closes the window by u_hole alone, without a rebuild
 *   vdash     effect layer; the whole Vector theme (shaders.js vdash, layout made by design/gen_vector.py): "tach" [cx, cy,
 *             inner r, outer r, start deg, sweep deg, segments] (revs 0..VDASH_RPM), "segs" (the bracket lines, at most
 *             20: [x0, y0, x1, y1, width, brightness 0..1]), "rings" (at most 4: {cx, cy, r, signal, min, max, color
 *             [r, g, b] 0..1}), "bars" (at most 3, gone while the map shows: {x, y, w, signal, min, max}), "panel" [x, y,
 *             w, h] (the music panel's plate), "vinyl" [cx, cy, r] (red label while something plays), "prog" [x, y, w]
 *             (the track's progress); the map window as fill ("hole", "holeWhen") with its corners cut "holeCut" px
 *   sdash     effect layer; the whole Sport theme (shaders.js sdash), optional "road" [horizonY, scale] (a road in the
 *             middle while no map shows, its dashes running with the speed): "geo" [yTop, yBend, yBottom, xBend] and
 *             "k" [above, below, round] for the left bracket's outer line (the right one is mirrored), "band"
 *             width, "inner" (the inner line's distance from the outer one), "scale" [y of 0, y of the top mark],
 *             "ticks" [speed, rpm], "rpmMax" (speed follows SPEED_SCALE), "fuelSeg" / "oilSeg" [fullX, fullY,
 *             emptyX, emptyY], "strip" [left end x, y, h, slant], "topEnd" x; the middle is black, and the map
 *             window is cut see-through while "holeWhen" is on ("hole", "holeInset", "holeRadius" as fill)
 *   segbar    effect layer; "max" segments, the first round(signal) lit (e.g. "setupLevel:engine"), "slant" px
 *   icon      image layer; a line icon from icons.js ("icon": gauge, shock, wheel, cog, stack, therm, oilcan, fuel)
 *   arc also takes "start" and "sweep" in degrees (clockwise from 12 o'clock; negative = anticlockwise)
 *   grid      calibration: effect layer of lines every "step" px (brighter every "major" steps)
 *   gridlabels  calibration: image layer, "x/y" at every "step" px (only the labels are uploaded)
 *   swatch    calibration: effect layer (calibration.js SWATCH), "steps" (11) grey steps 0..1 over the top
 *             half, four dark test colours over the bottom half
 *   swatchimg calibration: image layer, the identical picture painted into pixels (calibration.js
 *             swatchImage), so a photo of the two strips shows how the effect and image paths differ
 *   atext     effect layer (shaders.js atext): text drawn by the GPU from a glyph atlas, the probe for the path
 *             that needs no pixel writes. The font's glyphs go up once per connection as an R8 asset (one byte a
 *             pixel, not a layer, shared by every atext widget on that font); the widget is "cells" equal cells
 *             across its width ("w" / cells wide each; the glyphs keep their shape when w = cells x the font's
 *             widest advance and h = its cell height, logged at creation), and a new value is one uniform
 *             message of glyph codes. "text" tokens as text, "font", "color" role, "align" left | right | center.
 *             Up to 32 cells; only the characters the font has.
 *   meter     effect layer (shaders.js meter): a segmented bar, "signal" between "min" and "max" (raw units: km/h, C,
 *             bar, rpm), "segments" (20), "gap" px (4), "vertical": true fills upward; "colors" [3 roles] lit below
 *             "at"[0] / up to "at"[1] / past it (fractions of the bar), "trackColor" (track); "peak": ms (true = 3 s)
 *             holds the highest segment lit in "peakColor" (fg). arc takes "peak" too: a dot on the stroke.
 *   gmeter    effect layer (shaders.js gmeter): a G-meter: a bezel, rings every 0.25 g (0.5 g past 1.2 g) out to the
 *             setting "gRange" (1.2 g; the layout's "max" only when the setting is missing), the grip envelope (the
 *             furthest g this drive in 48 directions, role "envColor", fg), a trail of the last "gTrail" seconds (2;
 *             0 = none) and the dot: role "dot" (fg) under 0.5 g, amber to 0.8 g, the shift red past it; roles "line"
 *             (dim), "lineAlpha" 0-255 (150; 255 on the HUD, where see-through is faint). The dot moves the way the
 *             car accelerates (into the turn, up when speeding up), as cauliflowermossgrape's G-Force draws it; the
 *             settings "gFlipLat" (the car's left / right the other way round) / "gFlipLong" (brake on top) swap the
 *             drawing, a layout's "flipX" / "flipY" swap again. g is averaged over 150 ms and a sample over 3 g is
 *             dropped (also for the tokens). The envelope and the bests (tokens, the page's G-meter tab) last until
 *             resetG(), the app's restart or the switch between demo and car data.
 *   revarc    effect layer (shaders.js revarc): a segmented rev arc, the Rally theme's: centre "center" [x, y] (layer px, may
 *             sit below the layer), outer radius "r", "band" px (40), "start" / "sweep" degrees clockwise from 12 o'clock,
 *             "segments" (30); colours, flash and scale as the shiftbar.
 *   tiles     effect layer (shaders.js tiles): the Dyno theme's readout tiles in ONE layer: the background (role "color",
 *             bg) and up to 14 rounded tiles "tiles": [{ id, x, y, w, h (target px), slot, bar (false: none), toggle }],
 *             each with a thin "accent" strip on top and a bar along the bottom for its slot's sensor (TILE_BAR; zoned
 *             ones run "colors" [bar1, bar2, hot] split at "at" [0.6, 0.85], the rest all bar1). A tile turns role
 *             "warn" while its oil / coolant / boost reading is over the warning limit (put "warnFlash": false on
 *             its texts). Roles "fill" (panel), "line", "trackColor" (track); "radius" (8), "border" (1.5), "strip"
 *             (3), "barH" (6) px. The labels and values are text widgets on top.
 *   ribbon    effect layer (shaders.js ribbon): the Ribbon theme's rev line, one smooth curve under the hood line, panel px:
 *             y = a u^2 + b u + c with u = (x - cx) / half, "curve" [a, b, c], "span" [x0, x1, cx, half]; lit up to rpm / the bar
 *             max, coloured by the theme's "ribbon" { stops: 5 rgb, at: [4 of 0..1] } with a glow, a dot at every thousand (the
 *             last two red). "dip" px: while "Leave room for the driver camera" is on, the middle drops this far (the ends stay)
 *             so the line passes under the camera. A theme with "bulbs": true draws a string of Christmas bulbs instead.
 *             Its numbers are text widgets toggled by the virtual setting "ribScale" (thousands on the scale, "c" added
 *             while the camera dip is on: "7", "7c").
 *   deco      effect layer (shaders.js deco): the Ribbon theme's whole backdrop: role "bg" over the panel, a rounded frame
 *             "pill" [x, y, w, h] (role "accent") round the gear, and the theme's holiday art ("deco": 1 snow, 2 unused,
 *             3 Fourth of July, 4 New Year, 5 Thanksgiving; colours "decoColors" [3 rgb]) kept out of "keep" [[x0, y0, x1,
 *             y1] x up to 4]. The holiday comes from the "holiday" setting (shared/holidays.js): a layout whose theme has
 *             "holidays": true is drawn in "<theme>_<holiday>" while one is on.
 *   nav       image layer, always its own (never packed): turn-by-turn directions, Redline's (cauliflowermossgrape/
 *             idrive7-apps, MIT; shared/nav.js reads BMW's guidance service, shared/hud_nav.js draws the 200x76 picture:
 *             arrow, distance, street or lanes, "then", roundabouts). The picture is always 200x76; the widget's w / h
 *             place it (a smaller box scales it down, bilinear). Drawn in role "color" (fg), right-aligned ("align":
 *             "left": from its left edge, beside something on its right). Redrawn only when what it
 *             shows changes (the distance counting down sends only the changed rect), see-through while there is no
 *             fresh turn. The setting "navDirections": route (while a route runs), near (under 1 km, or lanes), off (no
 *             layer: the layouts toggle it with "!navDirections=off"). Redline's safety rules hold: no turn older than
 *             3 s, a reply asked before a route change is dropped, no arrow while two phones claim a route, a direction
 *             the car's catalog doesn't name is a dot (never a guessed arrow), BMW's event list is asked once a second
 *             only while a route runs and a nav widget is up with the directions on, with a back-off after failures.
 *             nav.js and hud_nav.js are loaded only when a layout has a nav widget (Cluster Themes never does).
 *             Proven by Redline with CarPlay / Apple Maps only; Waze over CarPlay sends the car no turns.
 *             Any text or badge with "navHide": true is drawn empty while the nav widget shows a turn (a layout with no
 *             free corner puts the directions over something less needed then).
 * Any image widget: "own": true gives it its own image layer instead of a place in a packed sheet (above).
 * Any widget: "conn": 0..3 puts its layer (or its sheet) on that connection to cluster-render. The 8-layer limit
 *   is per connection, so a second socket from the same app gets another 8 (DukeAPenguin saw 28 layers over four
 *   sockets on his car, Nov 5 2026; the calibration grids probe it here: L5..L16 on connections 2..4). 0 (the
 *   default) is the app's own connection; a layout never asks for more than it needs, each extra one is opened
 *   on first use and named <app id>_<n>. Sheets never span connections.
 * Pixel memory: cluster-render has 16 MiB for every app's images together and counts each image twice
 *   (Compositor::add_image; a layer past it is refused with "the service's pixel memory is full"), so every
 *   image layer costs w*h*8 bytes. The rebuild log and the status row say what a layout costs.
 * Text and badge updates send only the one rectangle around the pixels that changed since the last paint
 *   (changes() below, after PenguinDukeYDAuto/idrive7-EVAHUD's eva_canvas.js, MIT): a 3-digit readout
 *   that goes 123 -> 124 sends its last digit, not the widget.
 *   boxes     effect layer; the GT3 dash's frame in ONE layer (shaders.js boxes; the car draws only a few effect
 *             layers): the background (role "color", default "bg") with the optional map "hole" as fill, and up to
 *             12 framed boxes "boxes": [{ id, x, y, w, h (target px), head (header strip px), border (2), radius
 *             (0), headColor "accent" (else the "head" role), toggle }]. Roles "fill" (panel), "line", "head",
 *             "accent" for all of them; the labels are text widgets on top. Sent as array uniforms (vec4 x 12).
 * Any widget: "toggle": "<bool setting>" hides it when that setting is off, "!<setting>" when it is on,
 * "<choice setting>=<value>" shows it only while that choice is picked (also with "!");
 * "mapUp" (toggle or holeWhen) is not a saved setting: on while the Waze map shows inside the theme (waze.js; the
 * "mapInTheme" setting); the map is a content z 0 layer, so a frame meant to sit over it is content z 1 or more.
 * "themes": [...] shows it only in those themes. Text "color2": a second role, the colour at the bottom
 * of the box (a top-to-bottom gradient, the chrome look). Text: "hotWhen": "now" turns it the shift red
 * at the shift point; "coldWhen": "cold" turns it blue while the cold guard lowers the shift point.
 * scale: "over" as revbar; "redFrom": true draws the numbers from the redline on in red.
 * lights: "count" (12), "from" rpm (3000) where the first light comes on, "tail" (0): the last "tail" lights are blue
 *   (the GT3 look); "round": true for dots; with the setting "shiftCue" on "countin" (the default) the lights count in
 *   over the last second before an early, latched 5 Hz flash instead, and "from" is not used (shift_cue.js);
 * "off" the alpha of an unlit light (0.14).
 * Text "warnFlash": false: no flash over the warning limit (a tile that turns red itself).
 * Text "showWhen": "abnormal" (or "abnormal:oil" / "abnormal:coolant" on a plain label): empty while that temperature is
 *   normal and the setting "smartTemps" is on; temperature values take their band's colour, outside blue at 3 C and
 *   under (smart_temps.js).
 * Text "showWhen": "media" / "!media" (something with a title is playing, HmiMediaState, or not) and "mapUp" / "!mapUp"
 *   (the Waze map shows inside the theme): empty otherwise, without a rebuild. Text "ellipsis": true: a text wider than
 *   the box is cut to fit, ending in "...".
 * Switch-off guard (vehicle_state.js): no new layer while BMW's vehicle state is off / switching on / off, the layers
 *   dropped at 12 or 5 and under, built again when the car is on.
 * HUD holiday colours (shared/hud_holiday.js, the "holiday" setting on the HUD target): the theme's accents in the holiday's
 *   colours, Christmas lights as a string of bulbs, and {{greeting}} (MERRY CHRISTMAS, ...) only while the car stands.
 *   garland   image layer(s), never written in a layout: the holiday light string (shared/garland.js, Nov 13 2026). While the
 *             "holiday" setting picks a holiday (holidays.js, either app) every layout gets one at rebuild time, as the
 *             demo's DEMO tag: glowing C9 bulbs on a thin wire (colours: hud_holiday.js garland()) hung in swags under the
 *             hood line on the cluster, along the top of the visible window on the HUD (tiny "fairy lights" in the strip
 *             above a shift bar that fills the top), kept off every widget, the camera notch ("cameraNotch") and BMW's own
 *             HUD area; split round what is in the way, smaller bulbs where the top is tight, none without room. Not on
 *             the calibration layouts nor a theme with its own holiday art (Ribbon). Each stretch is its own image layer
 *             ("own"), all on the first connection with room for them; past 28 layers in all they share one. Drawn on the
 *             CPU once; while the car stands (under 3 km/h) a few bulbs dim for a moment (at most 4 redraws a second, only
 *             those bulbs' rects sent), moving nothing changes. The rebuild log line "holiday lights" gives its boxes.
 * Text "colorBy": "verdict" colours it by the last shift's grade. Text "near": ["speed" | "rpm", i] turns it
 * "nearColor" (fg) while scale label i is the one nearest the value (BMW lights up the label by the needle).
 *
 * rpm is smoothed (a 120 ms filter, and the readout moves in 50 rpm steps only when it changes by 40 or
 * more), so idle wobble doesn't show, as on BMW's own tach. Shift scoring uses the raw rpm.
 * Boost: FES displayBoostPressure while it's valid, else (app.json config.dme) the engine unit over
 * read-only UDS, absolute pressure minus outside air pressure, as cauliflowermossgrape's car_vitals does.
 *
 * Text tokens: {{speed}} {{u:speed}} {{oil}} {{coolant}} {{boost}} {{u:boost}} {{rpm}}
 * {{gear}} (P / R / N, D3 / S3 / M3 by the shifter programme, or just 3 when the selector position is unknown), {{gearnum}} (3, or P / R / N)
 * {{spd:<i>}} (speed scale label i of SPEED_SCALE: 0..200 mph, 0..320 km/h) {{range}} {{u:distLc}} (mi, km) {{u:dist}} (MI, KM) {{ambient}} (outside, signed: +75) {{u:speedLc}} (mph, km/h) {{speed2}} {{u:speed2Lc}} {{u:speed2}} (the speed in the other unit) {{mediaTitle}} {{mediaArtist}} {{mediaElapsed}} {{mediaLeft}} (now playing, HmiMediaState; empty without) {{ampmLc}} (am, pm) {{torque}} {{u:torque}} (lb-ft, Nm) {{torquePct}} {{powerPct}} (% of config.engine's peak) {{boostHi}} {{boostMid}}
 * (gauge labels for 1.4 / 0.7 bar in the display unit) {{stage}} (P R N, D / S / M by the shifter programme) {{gearInD}} (gear number while in D) {{mode}} (COMFORT, SPORT, SPORT PLUS, SPORT INDIVIDUAL, ECO PRO, ...)
 * {{temp:<deg C>}} (that temperature in the display unit, °F rounded to 10, for gauge labels) {{setup:engine|chassis|steering|gearbox}} (what that part is set to in the drive mode now)
 * {{time}} {{ampm}} {{u:temp}} (°F / °C) {{gLat}} {{gLong}} (g, 2 decimals) {{gSide}} ("0.42 L", "0.42 R")
 * {{gFwd}} ("0.31 ACC", "0.31 BRK") {{gBest}} (the most g this drive) {{gMax}} (the G-meter's range, "1.2") {{signal:<car.data() key>}} (raw, 1 decimal).
 * Redline (shift_score.js): {{rpm10}} (rpm to 10) {{shiftAt}} {{lastShift}} {{lastGears}} (4 > 5)
 * {{verdict}} {{shiftPrompt}} (SHIFT at the shift point) {{coldNote}} (only while the oil is cold).
 * Units follow the "units" setting: us = mph, °F, psi; metric = km/h, °C, bar.
 * {{intake}} (intake air, from the engine unit: app.json config.dme.intake) {{boostPeak}} (the highest boost since the last
 * 0-60 run started) {{avgSpeed}} (average moving speed this drive, from its first minute) {{run}} (the 0-60 clock running, else the last time, s) {{runBest}} {{runState}} (READY / GO / DONE)
 * {{runLabel}} (0-60 MPH, 0-100 KM/H): runs.js. {{warm}}: WARMING UP while the oil is under 80 C, then ENGINE WARM.
 * {{badge}}: the model picked on the Badge tab (badges.js), "BMW X3 M40i" with the lettering on, '' for none.
 * Warnings: a text showing oil, coolant or boost (a {{oil}} / {{coolant}} / {{boost}} token, or a readout slot with that
 * sensor) flashes in the shift red while the value is over "warnOil" / "warnCoolant" (C) / "warnBoost" (bar); 0 = off.
 * Shift-light test (testShift(), the page's Alerts tab): for about 4 s the rpm every widget sees climbs from 1500 to just
 * past the shift point and holds there; only while the car stands. Shift scoring keeps the car's own rpm.
 * Play demo (demo_script.js, the page's button): a scripted one-minute drive on the real HUD / cluster with a DEMO tag,
 * only while the car stands; it stops past 5 km/h of the car's own speed. this.car is its stand-in for the kit's Car.
 * Night colours (Cluster Themes "nightDim" on Auto): after sunset (sun.js, at _sunPlace(): the time zone's middle) a layout's own theme is
 * built with its whites and greys at 60 %; the minute timer rebuilds at sunset and sunrise.
 *
 * Boost is a PUSH signal, not a diagnostic poll: tracing cauliflowermossgrape's
 * car_vitals showed its boost reading is de.bmw.infotainment.drivingexcitement.FES /
 * statusSwitchDriveDynamicSport2.displayBoostPressure, factor 0.01, offset 0,
 * invalid 255. car_vitals itself treats that field as unreliable on some cars, so
 * whether this X3 fills it is checked on the first drive. Reported here in bar.
 *
 * Never throws out of a timer or event: the kit turns an uncaught exception into an
 * app exit, and on the car a second unexpected exit uninstalls the app.
 */
const fs = require('fs');
const path = require('path');
const sensors = require('./sensors');
const { ClusterRender, DEFAULT_PATH } = require('./cluster_render_client.js');
const Layouts = require('./layouts');
const { THEMES, M_STRIPE, LIGHTS, VERDICT, color } = require('./hud_themes');
const ShiftScore = require('./shift_score');
const visible = require('./visible');
const sun = require('./sun');
const textRaster = require('./hud_text');
const { paintIcon } = require('./icons');
const shaders = require('./shaders');
const calibration = require('./calibration');
const Car = require('./kit/car');
const Waze = require('./waze');
const Screen = require('./screen');
const badges = require('./badges');
const Runs = require('./runs');
const tz = require('./tz');
const holidays = require('./holidays');
const VehicleState = require('./vehicle_state');    // the switch-off guard: no new layer while the car switches off
const ShiftCue = require('./shift_cue');            // the count-in shift lights (setting "shiftCue")
const smartTemps = require('./smart_temps');        // "showWhen": "abnormal", temperature colours, slot bumping
const hudHoliday = require('./hud_holiday');
const DemoShow = require('./demo_script');
const Garland = require('./garland');               // the holiday light string (widget type "garland")
const DEMO_AMBER = [255, 176, 40];      // the DEMO tag's colour
const CAL_LAYOUTS = { grid: true, wincal: true, mapcal: true };
// sharing the HUD with other kit apps (Redline, issue #4): kit/runtime/hud_claim.js, from cauliflowermossgrape's kit
// (MIT). HUD Widgets is a "standing" app, like Cluster functions: it gives way while another app holds a fresh
// claim, and says it is on so that app hands the HUD back at the car's switch-off.
const { HudClaim } = require('./kit/hud_claim');
const CLAIM_ID = 'idrive_hud_widgets';
const CLAIM_MS = 1000;

const BOOST_SCALE = { factor: 0.01, offset: 0, invalid: 255 }; // see header comment
// the widget types drawn as pixels (image layers, packed into sheets unless "own": true); the rest are shaders
const IMAGE_TYPES = { text: true, scale: true, stripe: true, badge: true, gridlabels: true, icon: true, swatchimg: true, nav: true, garland: true };
const STATUS_ASK_MS = 2000;      // after a rebuild: ask cluster-render for its own status text
// an image layer is "stalled" until its first pixels reach cluster-render, which after a rebuild takes a second or two
// through the upload budget: normal. Only one still stalled this long is logged as a problem (and its recovery)
const STALL_WARN_MS = 5000;
const LAYER_BUDGET = 8;          // cluster-render's limit per client connection (CompositorLimits.per_client; confirmed on the car Nov 5 2026)
const MAX_CONN = 4;              // connections a layout may ask for ("conn"): 32 layers service-wide / 8 per connection
const PIXEL_BYTES = 16 * 1024 * 1024;   // cluster-render's pixel memory for every app's images together (CompositorLimits.pixel_bytes)
const SHEET_AREA_FRAC = 4;       // the first sheet size limit: 1/4 of the target area (see the header)
const TICK_MS = 50;              // 20 Hz: shift bar and gauges
const TEXT_MS = 200;             // text re-draws at most 5 times a second (what BMW's own readouts do)
const TARGET_SIZES = { hud: [800, 480], panel: [1920, 720] };
const MODE_KEY = { comfort: 'inComfort', sport: 'inSport', eco: 'inEco' };
const TYRE_CORNERS = ['FL', 'FR', 'RL', 'RR'];
// the HUD's place (the page's Position tab): settings that move / scale the layers already there, no rebuild
const PLACE_KEYS = ['hudX', 'hudY', 'hudScale'];
// (0.17.4: "Leave BMW's bottom strip clear" is gone. Since 0.17.0 every cluster theme ends above BMW's strip anyway;
// its squeeze to 662 / 720 only lifted the theme off the bottoms of BMW's own gauges, car photo Nov 14 2026.)
// settings that only change what a text shows (the next tick paints it), no rebuild
const LIVE_KEYS = ['warnOil', 'warnCoolant', 'warnBoost', 'badge', 'badgeBMW', 'gFlipLat', 'gFlipLong', 'gRange', 'gTrail'];
// g (after cauliflowermossgrape's G-Force, MIT, idea only): a sample over G_BAD is a bad reading, not a corner;
// the rest are averaged over G_AVG_MS so kerbs and potholes don't throw the dot about
const G_BAD = 3;
const G_AVG_MS = 150;
// the G-meter's grip envelope: G_SECTORS directions, a reading also lifts the G_SPREAD sectors either side of it
// (by the cosine), so the outline closes up between nearby readings; the trail holds G_TRAIL points
const G_SECTORS = 48, G_SPREAD = 3, G_TRAIL = 16;
const G_ENV_TEX = 64;                   // the envelope asset's width (R8, 64 x 1; sectors in texels 0..47)
// warnings (page.js Alerts): a readout of oil / coolant / boost over its limit flashes in the shift red
const WARN = { oil: 'warnOil', coolant: 'warnCoolant', boost: 'warnBoost' };
const WARN_FLASH_MS = 300;
// a tile's bar (the Dyno theme's "tiles") per sensor (sensors.js id): the raw reading (hud _raw) between min and
// max, "z" for a zoned bar (blue, dark blue, red past u_at); a sensor not here has no bar. rpm runs to the bar max.
const TILE_BAR = {
    rpm: { raw: 'rpm', min: 0, max: 'rpm', z: 1 }, speed: { raw: 'speed', min: 0, max: 260 },
    boost: { raw: 'boost', min: 0, max: 1.6, z: 1 }, torque: { raw: 'torquePct', min: 0, max: 100, z: 1 },
    power: { raw: 'powerPct', min: 0, max: 100, z: 1 }, torquePct: { raw: 'torquePct', min: 0, max: 100, z: 1 },
    powerPct: { raw: 'powerPct', min: 0, max: 100, z: 1 }, oil: { raw: 'oil', min: 40, max: 150, z: 1 },
    coolant: { raw: 'coolant', min: 40, max: 130, z: 1 }, intake: { raw: 'intake', min: 0, max: 80, z: 1 },
    ambient: { raw: 'ambient', min: -20, max: 45 }, gLat: { raw: 'gLat', min: 0, max: 1.2, z: 1, abs: true },
    gLong: { raw: 'gLong', min: 0, max: 1.2, z: 1, abs: true }, fuel: { raw: 'fuel', min: 0, max: 1 },
    range: { raw: 'range', min: 0, max: 700 }, hvSoc: { raw: 'hvSoc', min: 0, max: 100 },
};
const TILE_MAX = 14;       // half a flash: red, then the normal colour
// widgets that show the shift cue (the reaction time is learned only while one of them is drawn)
const MVIEW_RPM = 8000;            // the M view theme's rev scale: 0..8
const MVIEW_SPEED = { us: 200, metric: 330 };
const VDASH_RPM = 8000;            // the Vector theme's rev counter: 0..8
const MEDIA_IF = 'de.bmw.infotainment.hmi.hmimediastate.HmiMediaState';   // the head unit's now playing (front)
// Its instances have names, and none is '1': the units' catalogs list HMI_CID (the centre display), HMI_FoMo_Left and
// HMI_FoMo_Right. Asked for as '1' (0.19.0), BMW's installer refused the whole app (bimmer-lab/apps issue #26).
const MEDIA_INSTANCE = 'HMI_CID';
const MEDIA_TYPES = { 1: 'ARTIST', 2: 'ALBUM', 3: 'TITLE' };
/** A song's text for the baked fonts: accents dropped, curly quotes and dashes made plain, the rest left out. */
function mediaText(v) {
    let t = String(v === undefined || v === null ? '' : v);
    try { t = t.normalize('NFD'); } catch (e) { /* no ICU: keep it */ }
    return t.replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
        .replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
}
/** Seconds as m:ss. */
function clockOf(sec) { const t = Math.max(0, Math.floor(sec)); return Math.floor(t / 60) + ':' + ('0' + (t % 60)).slice(-2); }   // its speed scale: 0..200 mph by 20, 0..330 km/h by 30 (linear)
const ROAD_DASH_M = 12;            // the Sport road: metres per dash and gap (shaders.js sdash u_road)
const CUE_TYPES = { lights: true, shiftbar: true, revbar: true, revarc: true, ribbon: true, mtach: true };
// the shift-light test (page.js Alerts): rpm climbs from TEST_FROM to just past the shift point, then holds
const TEST_FROM = 1500, TEST_CLIMB_MS = 2500, TEST_HOLD_MS = 1200;
// night colours (Cluster Themes "nightDim"): after sunset the theme's whites and greys go to this brightness
const NIGHT_DIM = 0.6;
// the car's display units (Vehicle statusNewCurrentUnitsStatusExt, as BMW's own x_call reads them; car_vitals, MIT)
const PRESS_UNITS = { 1: 'BAR', 2: 'KPA', 3: 'PSI' }, TEMP_UNITS = { 1: 'C', 2: 'F' };
const PRESS_TO_BAR = { BAR: 1, KPA: 0.01, PSI: 1 / 14.5038 };
const unitName = (map, v) => map[v] || (Object.values(map).indexOf(v) >= 0 ? v : null);
// MDrive dataDisplayGearbox.displayProgramGearbox: the programme the cluster shows next to the gear (car_vitals, MIT)
const PROGRAMS = { S_MINUS_PROGRAMM: 'S', M_MINUS_PROGRAMM: 'M', 1: 'S', 2: 'M' };
const MODE_NAME = { comfort: 'Comfort', sport: 'Sport', eco: 'Eco Pro' };
const FRESH_MS = 3000;
const TZ_AUTO = -9999;           // the "timeZone" setting's Automatic: the head unit's own time zone
// A plug-in hybrid's high-voltage battery charge: read-only UDS 22 DDBC from its battery unit (SME, 0x07), 0.1 %.
// The read Redline 2.0 and eDrive use (cauliflowermossgrape/idrive7-apps, MIT; apps/redline/electrical.js).
// Asked every HV_EVERY_MS only while a shown readout uses it; a car that doesn't answer is asked once a minute.
// Not checked on a car by us (no hybrid here, Nov 10 2026).
const HV_SOC = { ecu: 0x07, did: 'DDBC', bytes: 2, at: 0, factor: 0.1, offset: 0, min: 0, max: 100, timeoutMs: 1000 };
// The fuel level as a % from the engine unit: standard OBD-II PID 2F ("fuel tank level input", A x 100 / 255), as
// cauliflowermossgrape's Live Data lists it (apps/live_data/std.js, MIT). A % needs no tank size; the car's own fuel
// signal is litres only. Whether BMW engine units answer it is not known yet (Nov 11 2026): without an answer the
// gauge falls back to litres / the "tankLitres" setting.
const FUEL_OBD = { obd: '2F', bytes: 1, at: 0, factor: 100 / 255, offset: 0, min: 0, max: 100, timeoutMs: 1000 };
const FUEL_EVERY_MS = 10000, FUEL_RETRY_MS = 300000, FUEL_STALE_MS = 60000;
const HV_EVERY_MS = 5000, HV_RETRY_MS = 60000, HV_STALE_MS = 20000;
// BMW's speed scale: even steps to 120 mph (180 km/h), then wider ones to 200 mph (320 km/h)
const SPEED_SCALE = { us: [0, 20, 40, 60, 80, 100, 120, 160, 200], metric: [0, 30, 60, 90, 120, 150, 180, 250, 320] };
/** speed (display unit) -> 0..1 along a scale of evenly spaced labels */
function scaleFrac(v, marks) {
    if (!(v > 0)) return 0;
    for (let i = 1; i < marks.length; i++) if (v <= marks[i]) return (i - 1 + (v - marks[i - 1]) / (marks[i] - marks[i - 1])) / (marks.length - 1);
    return 1;
}           // a boost reading older than this is not used

/**
 * The drive mode from FES statusFESVehicleDynamicSwitchHMI.actualValueModeDrivingExperience: names or wire
 * numbers (cauliflowermossgrape's live_data signals.js, MIT): 1 Sport, 2 Sport+, 3 Sport individual,
 * 4 Comfort, 5 Comfort+, 6 Comfort individual, 7 Eco Pro, 8 Eco Pro+, 9 Eco Pro individual, 10 Adaptive.
 */
/** The mode's variant: 'plus' (Sport+ / Comfort+ / Eco Pro+: wire 2, 5, 8, or PLUS / EXPERT in the name), 'individual'
 *  (wire 3, 6, 9, or INDIVID in the name), else null. */
/**
 * M cars (issue #8): MDrive.controlDisplayMSystems.controlDisplayEngineMode, the engine mode M Setup shows; FES's
 * driving experience stays on Comfort on these cars. KOMFORT 1 is what M calls Efficient, SPORT 2, SPORT_PLUS 3;
 * 0, 4 and 7 carry no mode. The enum comes as its name or its number. Signal and values: ALMSTRA/idv7lol (tested on
 * an F98 X4 M Competition, Nov 14 2026; facts only, no code taken). Returns { mode, variant } or null.
 */
function mEngineModeOf(v) {
    let n = v && typeof v === 'object' ? v.controlDisplayEngineMode : v;
    if (typeof n === 'string') n = /^\d+$/.test(n.trim()) ? Number(n.trim()) : { KOMFORT: 1, SPORT: 2, SPORT_PLUS: 3 }[n.trim().toUpperCase()];
    return n === 1 ? { mode: 'comfort', variant: null } : n === 2 ? { mode: 'sport', variant: null } : n === 3 ? { mode: 'sport', variant: 'plus' } : null;
}

function driveVariantOf(raw) {
    const v = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
    if (typeof v === 'number') return v === 2 || v === 5 || v === 8 ? 'plus' : v === 3 || v === 6 || v === 9 ? 'individual' : null;
    if (typeof v !== 'string') return null;
    return /PLUS|EXPERT/i.test(v) ? 'plus' : /INDIVID/i.test(v) ? 'individual' : null;
}

/** The M theme's setup rows: what each part is set to in a drive mode (they follow the mode buttons). */
const SETUP = {
    eco:       { engine: 'EFFICIENT', chassis: 'COMFORT', steering: 'COMFORT', gearbox: 'EFFICIENT' },
    comfort:   { engine: 'COMFORT', chassis: 'COMFORT', steering: 'COMFORT', gearbox: 'COMFORT' },
    sport:     { engine: 'SPORT', chassis: 'SPORT', steering: 'SPORT', gearbox: 'SPORT' },
    sportplus: { engine: 'SPORT PLUS', chassis: 'SPORT', steering: 'SPORT', gearbox: 'SPORT PLUS' },
    // the car reports only that an Individual setup is on, not what each part is set to (no signal found yet)
    individual: { engine: 'INDIVIDUAL', chassis: 'INDIVIDUAL', steering: 'INDIVIDUAL', gearbox: 'INDIVIDUAL' },
};
const SETUP_LEVEL = { EFFICIENT: 1, COMFORT: 1, SPORT: 2, 'SPORT PLUS': 3, INDIVIDUAL: 0 };

function driveModeOf(raw) {
    let v = raw;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v.trim());
    if (typeof v === 'number') {
        if (v >= 1 && v <= 3) return 'sport';
        if (v >= 7 && v <= 9) return 'eco';
        if ((v >= 4 && v <= 6) || v === 10) return 'comfort';
        return null;
    }
    if (typeof v !== 'string') return null;
    const u = v.trim().toUpperCase();
    if (u.indexOf('SPORT') === 0) return 'sport';
    if (u.indexOf('ECO') === 0 || u.indexOf('EFFICIEN') === 0) return 'eco';
    if (u.indexOf('COMFORT') === 0 || u.indexOf('ADAPTIVE') === 0) return 'comfort';
    return null;
}

/**
 * The panel's and the HUD's scene ids from cluster-render's status text ("target panel: slot 0x203 scene 0x10004f8
 * 1920x720: ..."), as numbers in hex; null when either line is missing (an older service, the bench).
 */
function sceneIdsOf(text) {
    const id = (t) => { const m = String(text).match(new RegExp('target ' + t + ':[^\\n]*?scene (0x[0-9a-fA-F]+)')); return m ? '0x' + parseInt(m[1], 16).toString(16) : null; };
    const panel = id('panel'), hud = id('hud');
    return panel && hud ? { panel, hud } : null;
}

function rgb(c) { return [c[0] / 255, c[1] / 255, c[2] / 255]; }

/**
 * The one rectangle around what differs between two RGBA images of the same size, with its pixels, or null
 * when they are the same (after idrive7-EVAHUD's eva_canvas.js, MIT). The link is what is short, not the CPU:
 * comparing a widget costs about a tenth of painting it.
 */
function changes(was, now, w, h) {
    const row = w * 4;
    const sameRow = (y) => now.compare(was, y * row, (y + 1) * row, y * row, (y + 1) * row) === 0;
    const samePx = (o) => now[o] === was[o] && now[o + 1] === was[o + 1] && now[o + 2] === was[o + 2] && now[o + 3] === was[o + 3];
    let top = 0;
    while (top < h && sameRow(top)) top++;
    if (top === h) return null;
    let bottom = h - 1;
    while (sameRow(bottom)) bottom--;
    let left = w, right = -1;
    for (let y = top; y <= bottom; y++) {
        if (sameRow(y)) continue;
        const o = y * row;
        for (let x = 0; x < left; x++) if (!samePx(o + x * 4)) { left = x; break; }
        for (let x = w - 1; x > right; x--) if (!samePx(o + x * 4)) { right = x; break; }
    }
    const rect = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
    const px = Buffer.allocUnsafe(rect.w * rect.h * 4);
    for (let y = 0; y < rect.h; y++) now.copy(px, y * rect.w * 4, (top + y) * row + left * 4, (top + y) * row + (right + 1) * 4);
    return { rect, px };
}
function rgba(c) { return [c[0] / 255, c[1] / 255, c[2] / 255, (c[3] === undefined ? 255 : c[3]) / 255]; }
function isNum(v) { return typeof v === 'number' && isFinite(v); }

class HudApp {
    constructor(ctx) {
        this.ctx = ctx;
        this.log = ctx.log;
        this.config = (ctx.spec && ctx.spec.config) || {};
        // HUD_CLUSTER_SOCKET: the Mac bench's fake cluster-render; never set on the car
        this.socketPath = process.env.HUD_CLUSTER_SOCKET || this.config.socketPath || DEFAULT_PATH;
        this.clients = [];               // the connections to cluster-render: [0] the app's own, more for "conn" widgets
        this.started = false;
        this.layerStates = new Map();    // "<conn>:<ref>" -> { state, reason, since, long } from cluster-render
        this.stallTimers = new Map();    // "<conn>:<ref>" -> timer: warns if the layer is still stalled after STALL_WARN_MS
        this.client = this._clientAt(0);
        this.target = TARGET_SIZES[this.config.target] ? this.config.target : 'hud';
        this.size = TARGET_SIZES[this.target];
        this.label = this.config.statusName || 'HUD';
        this.layoutTheme = null;         // the active layout's own theme, if it has one
        this.layouts = new Layouts(ctx.dataDir, this.log, this.size);
        this.widgets = new Map();        // widget.id -> { w, ref, sheet | null, last, lastPaint }
        this.sheets = [];                // the packed image layers: { ref, klass, z, x, y, w, h, members, buf }
        this.boostFes = null; this.boostFesAt = 0;    // bar, from the sport display signal
        this.boostDme = null; this.boostDmeAt = 0;    // bar, from the engine unit (fallback)
        this.needsBoost = false;         // a shown widget uses boost (the engine unit is only asked then)
        this.intakeDme = null; this.intakeDmeAt = 0;  // C, intake air from the engine unit (config.dme.intake)
        this.needsIntake = false;        // a shown widget uses the intake temperature
        this.hvSoc = null; this.hvSocAt = 0;  // %, a plug-in hybrid's battery charge (HV_SOC)
        this.needsHv = false;            // a shown widget uses it
        this.fuelObd = null; this.fuelObdAt = 0;  // %, the fuel level from the engine unit (FUEL_OBD)
        this.needsFuel = false;          // a shown widget uses the fuel level
        this.boostPeak = null;           // bar, the highest boost since the last 0-60 run started ({{boostPeak}})
        this.runs = new Runs(ctx.dataDir, this.log);   // the 0-60 timer (runs.js)
        this.runs.onStart = () => { this.boostPeak = null; };
        this.tripKm = 0;                 // this drive (since the app started with the car): km driven and
        this.tripMs = 0;                 // ms moving, for {{avgSpeed}}
        this.tripT = 0;
        this.driveMode = null;           // 'comfort' | 'sport' | 'eco', once the car has said
        this.driveRaw = null;            // a drive mode value the car sent that we don't know (shown in the status)
        this.driveVariant = null;        // 'plus' (Sport+ / Comfort+ / Eco Pro+), 'individual', or null
        this.carUnits = { press: null, temp: null, psiSeen: false };   // the car's display units, for the TPMS values
        this.program = null;             // 'S' / 'M' from the MDrive gearbox display, else null (D)
        this.gradeMode = null;           // the same display for the shift grades: D / S / M, null while unknown
        this.fuelL = null; this.rangeKm = null; this.ambient = null;   // KombiIF tank / range, outside temperature
        this.tyres = { p: {}, t: {} };                                  // TPMS pressure (bar) and temperature (C) per corner FL FR RL RR
        this.activeName = null;          // the layout shown now ('off' = nothing)
        this.pixelBytes = 0;             // what the layout's image layers and glyph atlases cost of cluster-render's pixel memory
        this.atlases = new Map();        // "<conn>:<font>" -> { ref, c, ci, cols, rows, cellW, cellH, chars, bytes }: R8 assets, kept across rebuilds
        this.targetState = null;         // { state, holder, reason } of our target
        this.rpmF = null; this.rpmShown = null; this.lastTickT = 0;
        this.themeName = null;
        this.flash = false;
        this.problem = null;             // why nothing shows (a bad layout), for the status line
        this.statusListeners = [];
        this.lastStatus = null;
        this.modeDiag = {};              // issue #8 (M cars): the raw drive-mode candidates by short name, shown while byMode is on
        this.modeDiagLogged = {};        // how many distinct values of each went to the log (20 at most)
        this.lastDiag = '';
        this.diagTimer = null;
        this.mDrive = false;             // issue #8: the drive mode comes from M Drive (an M car)
        this.fesWorks = false;           // FES has shown a mode other than Comfort: its mode is right on this car
        this.diagAt = {};                // when each busy candidate (Engine, Sport2: boost rides on it) was last looked at

        this.slotsFile = path.join(ctx.dataDir || '.', 'slots.json');
        this.slotPicks = {};             // { layout: { slot id: sensor id } }: the readout slots' picks (page.js Readouts)
        try { this.slotPicks = JSON.parse(fs.readFileSync(this.slotsFile, 'utf8')) || {}; } catch (e) { /* none yet */ }
        this.layoutSlots = [];           // the active layout's "slots"
        this.placed = [];                // every layer made for the layout: { c, ref, x, y, w, h } (where the layout puts it)
        this.mapLayout = false;          // the active layout has a map window (a widget with holeWhen "mapUp")
        // the Waze map inside the theme (Cluster Themes, config.waze; waze.js): "mapUp" is on while it shows
        this.waze = this.config.waze ? new Waze(Object.assign({ dataDir: ctx.dataDir }, this.config.waze), this.log, () => this._guard('waze', () => {
            if (this.mapLayout && this.setting('mapUp') !== this.mapShown) { if (this.mapLive) this._mapLive(); else this._rebuild(); } else this._status();
        })) : null;
        this.mapShown = false;           // "mapUp" when the layout was built (or last opened / closed, mapLive)
        this.mapLive = false;            // the active layout opens and closes its map window without a rebuild
        // the screen shared with the other app (screen.js): stepping aside while the driver gave it to the other one
        this.screen = new Screen(this.target === 'panel' ? 'cluster' : 'hud', ctx.dataDir, this.log,
            () => !!(this.started && this.activeName && this.activeName !== 'off'), () => this._guard('screen', () => this._rebuild()),
            () => this.scenesApart === true);
        // cluster-render 0.5.1+ gives the panel its own scene id, so the cluster and the HUD can show at once; null until
        // its status says (sceneIdsOf), false while they share one (older versions, or a panel fallen back after the guard)
        this.scenesApart = null;
        this.claimBy = null;             // the id of another kit app holding the HUD now (hud_claim), we step aside
        this.testAt = null;              // the shift-light test's start (Date.now()), while it runs
        this.nightOn = false;            // the layout was built with the night colours (nightDim)

        this.vstate = new VehicleState(this.log, () => this._guard('vehicle state', () => this._vehicleState()));
        this.cue = new ShiftCue(ctx.dataDir, this.log);
        this.slotBumps = {};             // { slot id: sensor id }: a hot temperature shown there for now (smart_temps.js)
        this._setupVehicleData();
        this.layouts.onChange(() => this._rebuild());
        ctx.settings.onChange((key) => {
            // a theme or layout picked anywhere (the page asks first, the kit's All settings list doesn't): no longer stepping aside
            if (['hudLayout', 'inComfort', 'inSport', 'inEco', 'byMode'].indexOf(key) >= 0 && this.screen.yielded) this.screen.release();
            if (PLACE_KEYS.indexOf(key) >= 0) this._guard('place', () => this._place());
            else if (LIVE_KEYS.indexOf(key) >= 0) this.widgets.forEach((x) => { x.last = null; });
            else if (key !== 'demo') this._rebuild(); else this._status();
        });
    }

    /* ---------------- readout slots ---------------- */

    /** The sensor (sensors.js) slot `id` of `layout` shows: the pick, else the layout's default. */
    slotSensor(layout, id, slots, own) {
        // a hot temperature bumped into this slot for now (smart_temps.js); own: the driver's pick regardless
        const bump = !own && layout === this.activeName && this.slotBumps && this.slotBumps[id];
        if (bump && sensors.get(bump)) return sensors.get(bump);
        const pick = (this.slotPicks[layout] || {})[id];
        if (pick && sensors.get(pick)) return sensors.get(pick);
        const def = (slots || []).find((x) => x.id === id);
        return def ? sensors.get(def.default) : null;
    }
    /** The slots of `layout` ([{ id, where, default }]), [] when it has none or can't be read. */
    slotsOf(layout) {
        if (layout === this.activeName) return this.layoutSlots;
        try { return this.layouts.load(layout).slots || []; } catch (e) { return []; }
    }
    /** Show `sensorId` in slot `id` of `layout` (null: back to its default); saved in <data>/slots.json, shown at once. */
    setSlot(layout, id, sensorId) {
        const m = this.slotPicks[layout] || (this.slotPicks[layout] = {});
        if (sensorId) m[id] = sensorId; else delete m[id];
        if (!Object.keys(m).length) delete this.slotPicks[layout];
        try { fs.writeFileSync(this.slotsFile, JSON.stringify(this.slotPicks, null, 1)); } catch (e) { this.log.warn('slots: cannot save ' + this.slotsFile + ' (' + e.message + ')'); }
        this.widgets.forEach((x) => { x.last = null; });       // the slot texts paint again on the next tick
        if (layout === this.activeName && this.shownW) this._setNeeds(this.shownW);
    }
    /** needsBoost / needsIntake from the widgets shown: their own text and the sensors their readout slots show
     *  (before Nov 8 2026 only the text counted, so a slot picked to intake never asked the engine unit). */
    _setNeeds(shown) {
        this.shownW = shown;
        const ids = [];
        shown.forEach((w) => [w].concat(Array.isArray(w.tiles) ? w.tiles : []).forEach((b) => {
            const sn = b && b.slot ? this.slotSensor(this.activeName, b.slot, this.layoutSlots) : null;
            if (sn) ids.push(sn.id);
        }));
        const j = JSON.stringify(shown) + ' ' + ids.join(' ');
        this.needsBoost = /boost/.test(j);
        this.needsIntake = /intake/.test(j);
        this.needsHv = /hvSoc/.test(j);
        this.needsFuel = /fuel/i.test(j);
    }
    /** A sensor's value now, as its slot shows it ('--' without one). */
    sensorValue(sn) { return sn ? this._token(sn.tok) : '--'; }
    sensorUnit(sn) {
        if (!sn) return '';
        const us = this.setting('units') === 'us';
        return sn.unit ? sn.unit(us) : this._token('ampm');
    }

    /* ---------------- the HUD's place ---------------- */

    /**
     * Move (hudX, hudY px) and scale (hudScale %) every layer of the layout, kept on the target: the move is cut
     * so the layout's box stays inside it. The scale is cluster-render's layer sx / sy about the layout's centre.
     */
    _place() {
        const off = this._offset(), sc = this._scale();
        if (!this.placed.length) return;
        const b = this._placedBox(), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        this.placed.forEach((l) => {
            const o = { x: l.x + off.x, y: l.y + off.y };
            if (sc !== 1 || l.scaled) { o.sx = sc; o.sy = sc; o.px = cx - l.x; o.py = cy - l.y; l.scaled = sc !== 1; }
            l.c.set(l.ref, o);
        });
    }
    _placedBox() {
        const ls = this.placed;
        if (!ls.length) return { x: 0, y: 0, w: 0, h: 0 };
        const x0 = Math.min.apply(null, ls.map((l) => l.x)), y0 = Math.min.apply(null, ls.map((l) => l.y));
        const x1 = Math.max.apply(null, ls.map((l) => l.x + l.w)), y1 = Math.max.apply(null, ls.map((l) => l.y + l.h));
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    /**
     * "Leave room for the driver camera" (cluster): a row of shift lights or rev segments that crosses the camera's spot
     * on newer cars (visible.CAMERA) becomes two mirrored wings either side of it, filling from the outer ends in
     * towards the camera. The empty middle as { s, e } px from the widget's left; null when off or not crossing it.
     */
    _wings(w) {
        const C = visible.CAMERA;
        if (!this._cameraOn() || !(w.y < C[3] && w.x < C[0] && w.x + w.w > C[2])) return null;
        return { s: C[0] - w.x, e: C[2] - w.x };
    }
    /** The same for an arc (Rally's revarc, symmetric about 12 o'clock): half the empty middle in radians, 0 = none. */
    _arcWing(w) {
        const C = visible.CAMERA;
        if (!this._cameraOn() || !w.center || w.y + w.center[1] - w.r >= C[3]) return 0;
        const cx = w.x + w.center[0], half = Math.max(cx - C[0], C[2] - cx), inner = w.r - (w.band || 40);
        return half < inner ? Math.asin(half / inner) : 0;
    }
    _cameraOn() { return this.target === 'panel' && !!this.ctx.settings.item('cameraNotch') && this.setting('cameraNotch') === true; }

    _scale() {
        if (!this.ctx.settings.item('hudScale')) return 1;
        const v = this.setting('hudScale');
        return isNum(v) && v >= 50 && v <= 150 ? v / 100 : 1;
    }
    /** The move asked for, cut so the layout (at its scale) stays on the target. */
    _offset() {
        if (!this.ctx.settings.item('hudX')) return { x: 0, y: 0 };
        const want = { x: this.setting('hudX') || 0, y: this.setting('hudY') || 0 };
        if (!this.placed.length) return want;
        const b = this._placedBox(), sc = this._scale();
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2, hw = b.w * sc / 2, hh = b.h * sc / 2;
        const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
        return {
            x: Math.round(clamp(want.x, hw - cx, this.size[0] - hw - cx)),
            y: Math.round(clamp(want.y, hh - cy, this.size[1] - hh - cy)),
        };
    }
    /** Where the HUD sits now, for the page: { x, y, scale, box } (box: the layout's own, unmoved). */
    placeInfo() { return { x: this._offset().x, y: this._offset().y, scale: this._scale(), box: this._placedBox() }; }

    /** A setting's value, or its default when the saved value isn't one the schema allows. */
    setting(key) {
        // "mapUp": not saved, the Waze map is showing inside the theme now (the setting on, waze.js says so)
        if (key === 'mapUp') return !!(this.waze && this.waze.up && this.ctx.settings.get('mapInTheme') === true);
        // "ribScale": not saved, the Ribbon's scale numbers to show: thousands on the bar, "c" while the camera dip is on
        if (key === 'ribScale') return String(this._barMax() / 1000) + (this._cameraOn() ? 'c' : '');
        const s = this.ctx.settings.item(key);
        const v = this.ctx.settings.get(key);
        if (!s) return v;
        const ok = s.type === 'bool' ? typeof v === 'boolean'
            : s.type === 'choice' ? (s.options || []).some((o) => o[0] === v)
                : s.type === 'number' ? isNum(v) && (!s.steps || s.steps.indexOf(v) >= 0) : true;
        return ok ? v : s.default;
    }

    _setupVehicleData() {
        const extra = {
            // BMW's vehicle state, for the switch-off guard (vehicle_state.js)
            'de.bmw.infrastructure.VehicleCondition': { VehicleCondition: (v) => this.vstate.feed(v) },
            // fuel and range (cauliflowermossgrape's live_data, MIT): litres (255 = none) and km (4095 = none)
            'de.bmw.infotainment.KombiIF': {
                statusRangeTankStatus: (v) => {
                    const f = v && v.fluidLevelFuelTank, r = v && v.range;
                    this.fuelL = isNum(f) && f >= 0 && f < 255 ? f : null;
                    this.rangeKm = isNum(r) && r >= 0 && r < 4095 ? r : null;
                },
            },
            // tyre pressure and temperature per corner, in the car's own display units (_tyreBar / _tyreC).
            // The car never notifies these (BMW's own x_call only ever reads them), so they are polled.
            'de.bmw.infotainment.vehicle.TPMS': {
                $pollMs: 10000,
                statusTyrePressure: (v) => TYRE_CORNERS.forEach((k) => { this.tyres.p[k] = this._tyreBar(v && v['actualValuePressureTyre' + k + 'H']); }),
                statusTyreTemperature: (v) => TYRE_CORNERS.forEach((k) => { this.tyres.t[k] = this._tyreC(v && v['actualValueTemperatureTyre' + k + 'H']); }),
            },
            // the car's display units: the TPMS reports pressure as 0.1 x raw in the car's pressure unit and temperature
            // as the car's degrees + 40 (car_vitals, MIT; a car set to psi / F showed 32 psi as 464 psi until this was read)
            'de.bmw.infotainment.vehicle.Vehicle': {
                statusNewCurrentUnitsStatusExt: (v) => {
                    const press = unitName(PRESS_UNITS, v && v.unitOfMeasurementAirPressure), temp = unitName(TEMP_UNITS, v && v.unitOfMeasurementTemperature);
                    if (press === this.carUnits.press && temp === this.carUnits.temp) return;
                    this.carUnits.press = press; this.carUnits.temp = temp;
                    this.log.info('car units: pressure ' + (press || '?') + ', temperature ' + (temp || '?'));
                },
            },
            // S / M next to the gear: the gearbox status carries no programme on some cars, the M drive display does
            'de.bmw.infotainment.misc.MDrive': {
                // issue #8: an M car's drive mode (M Setup's engine mode). Used unless FES has ever shown a mode other
                // than Comfort (then this car's FES works and stays in charge)
                controlDisplayMSystems: (v) => {
                    this._diag('MDrive', v);
                    const m = mEngineModeOf(v);
                    if (!m || this.fesWorks) return;
                    if (!this.mDrive) this.log.info('drive mode: from M Drive (M Setup\'s engine mode)');
                    this.mDrive = true;
                    this._driveMode(m.mode, m.variant, 'M Drive ' + JSON.stringify(v && typeof v === 'object' ? v.controlDisplayEngineMode : v));
                },
                dataDisplayGearbox: (v) => {
                    const raw = v && v.displayProgramGearbox;
                    this.program = PROGRAMS[raw] || null;
                    // for the shift grades (as Redline): D / S (the gearbox shifts: AUTO) or M, null while the car hasn't said
                    this.gradeMode = PROGRAMS[raw] || (raw === 0 || /^D/i.test(String(raw)) ? 'D' : null);
                },
            },
            // outside temperature: raw * 0.5 - 40 deg C, 255 = none (car_vitals, MIT)
            'de.bmw.infrastructure.EnvironmentalInformation': {
                ExteriorTemperature: (v) => {
                    const t = v && v.temperatureExterior;
                    this.ambient = isNum(t) && t !== 255 ? t * 0.5 - 40 : null;
                },
            },
            'de.bmw.infotainment.drivingexcitement.FES': {
                statusSwitchDriveDynamicSport2: (v) => {
                    this._diag('Sport2', v, ['displayBoostPressure', 'displayMaximumValueBoostPressure']);
                    const raw = v && v.displayBoostPressure;
                    if (typeof raw !== 'number' || raw === BOOST_SCALE.invalid) return;
                    this.boostFes = raw * BOOST_SCALE.factor + BOOST_SCALE.offset;
                    this.boostFesAt = Date.now();
                },
                // the HMI's sport display: power and torque in % of the car's maximum (car_vitals, MIT); 255 = none
                statusVehicleDynamicEngine: (v) => {
                    this._diag('Engine', v, ['displaySportEnginePower', 'displaySportEngineTorque']);
                    const p = v && v.displaySportEnginePower, t = v && v.displaySportEngineTorque;
                    this.sportPower = isNum(p) && p >= 0 && p <= 150 ? p : null;
                    this.sportTorque = isNum(t) && t >= 0 && t <= 150 ? t : null;
                    this.sportAt = Date.now();
                },
                statusFESVehicleDynamicSwitchHMI: (v) => {
                    this._diag('HMI', v);
                    const raw = v && v.actualValueModeDrivingExperience;
                    const m = driveModeOf(raw), variant = m ? driveVariantOf(raw) : null;
                    if (!m) {
                        // a value we don't know (M cars: Efficient / Sport / Sport+, issue #8): logged and shown on the
                        // Settings tab's status line, so a driver can tell us what the car sends
                        const t = String(JSON.stringify(raw)).slice(0, 60);
                        if (t !== this.driveRaw) { this.driveRaw = t; this.log.info('drive mode not recognised: ' + t); this._status(); }
                        return;
                    }
                    this.driveRaw = null;
                    if (m !== 'comfort') this.fesWorks = true;      // not an M car whose FES is stuck on Comfort
                    if (this.mDrive && !this.fesWorks) return;     // an M car: M Drive has the mode
                    this._driveMode(m, variant, raw);
                },
            },
        };
        // now playing (the Vector layouts' music panel): the head unit's own media state, front screen only. Optional
        // (app.json): not every unit may have it, and whether CarPlay fills it is not known yet. Added last, so the
        // one-at-a-time SOME/IP setup (signals.js) reaches every vehicle signal before it, whatever this one does
        extra[MEDIA_IF] = {
            $instance: MEDIA_INSTANCE,
            playerMetadata: (v) => this._mediaFeed('meta', v),
            trackProgress: (v) => this._mediaFeed('progress', v),
        };
        this.car = new Car(this.ctx, ['rpm', 'speed', 'temps', 'accel', 'gear', 'torque'], extra);
        // "Play demo": this.car becomes the show's stand-in (the car's own data unless the show plays)
        this.demo = new DemoShow(this.car, this._demoHooks(), this.log);
        this.car = this.demo.car;
        this.car.setRedline(this.setting('redline'));
        this.gBuf = [];                  // [t, lat, long] of the last G_AVG_MS
        this.gSm = null;                 // { lat, long, at }: their average
        this.car.onSample((d, t) => this._gSample(d, t), () => { this.gBuf = []; this.gSm = null; this.resetG(); });
        this.resetG();
        this.score = new ShiftScore(this.car, () => ({
            redline: this.setting('redline'), shiftBefore: this.setting('shiftBefore'), coldGuard: this.setting('coldGuard'),
            mode: this.car.data().demo ? null : this.gradeMode || null,
        }), this.log);
    }

    /**
     * Connection i to cluster-render, made on first use: 0 is the app's own (named after the app); a widget's
     * "conn" asks for 1..3, named <app id>_2 .. _4, each with its own 8 layers. Layers made before a connection
     * is up are replayed by the client when it connects.
     */
    _clientAt(i) {
        while (this.clients.length <= i) {
            const ci = this.clients.length;
            const c = new ClusterRender(ci ? this.ctx.spec.id + '_' + (ci + 1) : this.ctx.spec.id, this.socketPath);
            this.clients.push(c);
            this._wireClientEvents(c, ci);
            if (this.started) { this.log.info('connection ' + (ci + 1) + ' to cluster-render'); c.connect(); }
        }
        return this.clients[i];
    }

    _wireClientEvents(c, ci) {
        const tag = ci ? ' [connection ' + (ci + 1) + ']' : '';
        c.on('ready', () => { this.log.info('cluster-render ready' + tag + ' (backend=' + c.backend + ')'); if (ci === 0) this._rebuild(); else this._status(); });
        c.on('disconnected', () => { this.log.warn('cluster-render disconnected' + tag + ', client will retry'); this._status(); });
        c.on('layer', (ref, state, reason) => {
            const key = ci + ':' + ref;
            const old = this.layerStates.get(key);
            const same = old && old.state === state;
            const st = { state, reason, since: same ? old.since : Date.now(), long: same ? old.long : false };
            this.layerStates.set(key, st);
            const name = () => { const w = this._widgetOf(ci, ref); return 'layer ' + ref + tag + (w ? ' (' + w + ')' : ''); };
            if (state === 'error' || (state === 'waiting' && !same)) this.log.warn(name() + ' ' + state + (reason ? ': ' + reason : ''));
            if (state === 'stalled' && !same) {
                // normal for a moment after a rebuild (pixels on their way); a problem only if it lasts
                clearTimeout(this.stallTimers.get(key));
                this.stallTimers.set(key, setTimeout(() => this._guard('stall check', () => {
                    this.stallTimers.delete(key);
                    const now = this.layerStates.get(key);
                    if (now !== st) return;
                    st.long = true;
                    this.log.warn(name() + ' still stalled after ' + STALL_WARN_MS / 1000 + ' s: no pixels reached cluster-render' + (reason ? ' (' + reason + ')' : ''));
                }), STALL_WARN_MS));
            } else if (state !== 'stalled') {
                clearTimeout(this.stallTimers.get(key)); this.stallTimers.delete(key);
                if (old && old.state === 'stalled' && old.long) this.log.info(name() + ' ' + state + ' after ' + ((Date.now() - old.since) / 1000).toFixed(1) + ' s stalled');
            }
            this._statusSoon();
        });
        c.on('target', (name, state, holder, reason) => {
            if (name !== this.target) return;
            this.targetState = { state, holder, reason };
            this.log.info('target ' + name + tag + ' ' + state + (holder ? ' (holder ' + holder + ')' : '') + (reason ? ': ' + reason : ''));
            this._statusSoon();
        });
        c.on('refused', (op, ref, reason) => {
            const w = this._widgetOf(ci, ref);
            this.log.warn('refused ' + op + ' on ' + ref + tag + (w ? ' (' + w + ')' : '') + ': ' + reason);
            if (!this.refused) this.refused = (w || op) + ': ' + reason;   // the first one, until the next rebuild
            this._statusSoon();
        });
        c.on('budget', (capKb, maxKb, reason) => this.log.info('budget' + tag + ' ' + capKb + '/' + maxKb + ' kb/s (' + reason + ')'));
        c.on('status', (text) => {
            this.log.info('cluster-render status: ' + text);
            this._stallsFromStatus(text);
            const ids = sceneIdsOf(text);
            if (!ids) return;
            const apart = ids.panel !== ids.hud;
            if (apart === this.scenesApart) return;
            this.scenesApart = apart;
            this.log.info(apart ? 'cluster and HUD on their own scenes (panel ' + ids.panel + ', hud ' + ids.hud + '): both apps can show at once'
                : 'cluster and HUD share scene ' + ids.panel + ': one app at a time');
            this.screen.beat();
        });
    }

    /**
     * cluster-render's status lists every layer of every client with its state. After a reconnect it may show our layers
     * without a per-layer event for each (car log Nov 14 2026: "still stalled after 5 s" 3 s after the status had them all
     * shown): when the status shows as many of a connection's layers as we made, none of them is stalled any more.
     */
    _stallsFromStatus(text) {
        const lines = String(text).split('\n');
        this.clients.forEach((c, ci) => {
            const re = new RegExp('^layer \\d+ \\w+ of ' + c.app.replace(/[^\w-]/g, '') + ' on ' + this.target + ',.*: shown$');
            const shown = lines.filter((l) => re.test(l.trim())).length;
            const mine = this._layerRefs().filter((r) => r.ci === ci).length;
            if (!mine || shown < mine) return;
            this.layerStates.forEach((st, key) => {
                if (key.indexOf(ci + ':') !== 0 || st.state !== 'stalled') return;
                clearTimeout(this.stallTimers.get(key)); this.stallTimers.delete(key);
                if (st.long) this.log.info('layer ' + key.slice(key.indexOf(':') + 1) + (ci ? ' [connection ' + (ci + 1) + ']' : '') + ' shown (cluster-render status)');
                this.layerStates.set(key, { state: 'shown', reason: null, since: Date.now(), long: false });
            });
        });
    }

    start() {
        this.log.info('connecting to cluster-render at ' + this.socketPath);
        this.started = true;
        this.clients.forEach((c) => c.connect());
        this.tickTimer = setInterval(() => this._guard('tick', () => this._tick()), TICK_MS);
        // Auto theme: check for sunrise / sunset once a minute; the status line too
        this.themeTimer = setInterval(() => this._guard('theme check', () => {
            if (this._themeName() !== this.themeName || this._nightDim() !== this.nightOn || this._hudHoliday() !== (this.hudHoliday || null) ||
                this._holidayNow() !== (this.holidayAt || null)) this._rebuild();
            this._status();
            if (this.client.ready) this.client.status();      // the scene ids (scenesApart) can change: guard, update
        }), 60000);
        this.statusTimer = setInterval(() => this._guard('status', () => this._status()), 5000);
        if (this.target === 'hud') this.claimTimer = setInterval(() => this._guard('hud claim', () => this._hudClaim()), CLAIM_MS);
        this._status();
        this._startDme();
        if (this.waze) { this.waze.start(); this._wazeWant(); }
        this.screen.start();
    }

    /** Waze's map on the panel only while the setting is on and the theme shown has a map window. */
    _wazeWant() {
        if (this.waze) this.waze.want(this.started && this.setting('mapInTheme') === true && this.mapLayout);
    }

    /** Boost, intake, fuel % and hybrid battery from the car's units (config.dme), over the read-only link. */
    _startDme() {
        const dme = this.config.dme;
        const hasBoost = !!(dme && Array.isArray(dme.boost) && dme.boost.length);
        const hasIntake = !!(dme && Array.isArray(dme.intake) && dme.intake.length);
        let rd = null, busy = false, baro = 101.3, baroAt = 0, intakeAsk = 0, hvAsk = 0, hvMiss = 0, fuelAsk = 0, fuelMiss = 0;
        try {
            // the kit's read-only link: anything but a read (22 / OBD 01) is refused before it leaves the head unit.
            // silentAfter Infinity: never skip a unit that stopped answering; the retry timers below pace that.
            const { ReadOnlyDiag } = require('./kit/readonly-diag');
            const { DidReader } = require('./kit/dids');
            const link = new ReadOnlyDiag(this.ctx.signals, this.log, { silentAfter: Infinity });
            Promise.resolve().then(() => link.init()).catch((e) => this.log.info('engine unit link not available: ' + (e && e.message || e)));
            rd = new DidReader(link, { ecu: (dme && dme.ecu) || 18 });
        } catch (e) { this.log.info('engine unit boost off: ' + (e && e.message || e)); return; }
        this.dmeTimer = setInterval(() => this._guard('engine unit boost', () => {
            const now = Date.now();
            const wantBoost = hasBoost && this.needsBoost && now - this.boostFesAt >= FRESH_MS;
            const wantIntake = hasIntake && this.needsIntake && now - intakeAsk >= 2000;   // a temperature: every 2 s is plenty
            const wantHv = this.needsHv && now - hvAsk >= (hvMiss >= 3 ? HV_RETRY_MS : HV_EVERY_MS);
            const wantFuel = this.needsFuel && now - fuelAsk >= (fuelMiss >= 3 ? FUEL_RETRY_MS : FUEL_EVERY_MS);
            if (busy || this.car.data().demo || (!wantBoost && !wantIntake && !wantHv && !wantFuel)) return;
            busy = true;
            (async () => {
                if (wantFuel) {
                    fuelAsk = now;
                    const v = await rd.read(FUEL_OBD);
                    if (isNum(v)) {
                        if (fuelMiss >= 3 || !isNum(this.fuelObd)) this.log.info('fuel level: ' + v.toFixed(0) + ' % from the engine unit (OBD 2F)');
                        this.fuelObd = v; this.fuelObdAt = Date.now(); fuelMiss = 0;
                    } else if (++fuelMiss === 3) {
                        this.log.info('fuel level: the engine unit gives no OBD 2F (' + ((rd.raws[rd.key(FUEL_OBD)] || {}).why || '?') + '); litres / tank size, asked again every 5 min');
                    }
                }
                if (wantHv) {
                    hvAsk = now;
                    const v = await rd.read(HV_SOC);
                    if (isNum(v)) {
                        if (hvMiss >= 3 || !isNum(this.hvSoc)) this.log.info('hybrid battery: ' + v.toFixed(1) + ' % from the battery unit (SME 0x07, DDBC)');
                        this.hvSoc = v; this.hvSocAt = Date.now(); hvMiss = 0;
                    } else if (++hvMiss === 3) {
                        this.log.info('hybrid battery: no answer from the battery unit (' + ((rd.raws[rd.key(HV_SOC)] || {}).why || '?') + '); asked once a minute');
                    }
                }
                if (wantIntake) {
                    intakeAsk = now;
                    const t = await rd.value('intake', dme.intake);
                    if (isNum(t)) { this.intakeDme = t; this.intakeDmeAt = Date.now(); }
                }
                if (!wantBoost) return;
                if (now - baroAt > 60000 && Array.isArray(dme.baro)) {
                    baroAt = now;
                    const b = await rd.value('baro', dme.baro);
                    if (isNum(b)) baro = b;
                }
                const m = await rd.value('boost', dme.boost);
                if (isNum(m)) { this.boostDme = (m - baro) / 100; this.boostDmeAt = Date.now(); }
            })().catch((e) => this.log.info('engine unit boost: ' + (e && e.message || e))).then(() => { busy = false; });
        }), 400);
    }

    stop() {
        clearInterval(this.tickTimer);
        clearInterval(this.themeTimer);
        clearInterval(this.statusTimer);
        clearInterval(this.dmeTimer);
        clearInterval(this.claimTimer);
        clearTimeout(this.statusAskT);
        clearTimeout(this.diagTimer); this.diagTimer = null;
        this.vstate.stop();
        this.stallTimers.forEach((t) => clearTimeout(t)); this.stallTimers.clear();
        if (this.waze) this._guard('waze stop', () => this.waze.stop());
        if (this.directions) this._guard('directions stop', () => this.directions.stop());
        this._guard('screen stop', () => this.screen.stop());
        this.clients.forEach((c) => c.close());
        this.atlases.clear();
        if (this.gEnvTex) this.gEnvTex.clear();
    }

    /**
     * The glyph atlas of a font on a connection: an R8 asset of the font's characters in equal cells (cols x
     * rows), made on first use and kept while the connection lives (the client re-sends it by itself after a
     * reconnect). A widget's effect layer samples it; nothing is drawn by the asset itself.
     */
    _atlas(fontName, ci) {
        const key = ci + ':' + fontName;
        if (this.atlases.has(key)) return this.atlases.get(key);
        const font = textRaster.loadFont(fontName), glyphs = font.metrics.glyphs;
        const chars = Object.keys(glyphs).filter((ch) => ch.length === 1 && ch >= ' ' && ch <= '~').sort().slice(0, 64);
        if (!chars.length) throw new Error('font "' + fontName + '" has no printable glyphs for an atlas');
        const cellW = Math.max(1, Math.ceil(Math.max.apply(null, chars.map((ch) => glyphs[ch].advance)))) + 2;
        const cellH = font.metrics.cellHeight;
        const cols = Math.max(1, Math.min(16, Math.floor(2048 / cellW))), rows = Math.ceil(chars.length / cols);
        const w = cols * cellW, h = rows * cellH;
        const buf = Buffer.alloc(w * h, 0);
        chars.forEach((ch, i) => {
            const cell = textRaster.mask(cellW, cellH, ch, { font: fontName, align: 'center' });
            const cx = (i % cols) * cellW, cy = Math.floor(i / cols) * cellH;
            for (let y = 0; y < cellH; y++) cell.copy(buf, (cy + y) * w + cx, y * cellW, (y + 1) * cellW);
        });
        const c = this._clientAt(ci);
        const ref = c.asset({ target: this.target, format: 'r8', w, h, sampling: 'bilinear' });
        if (!ref) throw new Error('font "' + fontName + '": atlas asset refused (' + w + 'x' + h + ')');
        c.pixels(ref, null, buf);
        const a = { ref, c, ci, cols, rows, cellW, cellH, chars, bytes: w * h * 2 };
        this.atlases.set(key, a);
        this.log.info('glyph atlas "' + fontName + '"' + (ci ? ' on connection ' + (ci + 1) : '') + ': ' + chars.length + ' glyphs in ' +
            cellW + 'x' + cellH + ' cells, ' + w + 'x' + h + ' R8 asset, ' + mib(a.bytes) + ' of pixel memory');
        return a;
    }

    _atlasBytes() {
        let n = 0;
        this.atlases.forEach((a) => { n += a.bytes; });
        return n;
    }

    /**
     * A G-meter's envelope asset (R8, G_ENV_TEX x 1, 128 bytes of pixel memory), kept per connection and widget id across
     * rebuilds like the glyph atlases (the client re-sends it after a reconnect); the update fills it. Null if refused.
     */
    _gEnvAsset(x) {
        if (!this.gEnvTex) this.gEnvTex = new Map();
        const key = x.ci + ':' + x.w.id;
        if (this.gEnvTex.has(key)) return this.gEnvTex.get(key);
        const ref = x.c.asset({ target: this.target, format: 'r8', w: G_ENV_TEX, h: 1 });
        if (!ref) { this.log.warn('widget "' + x.w.id + '": envelope asset refused; the G-meter draws without it'); return null; }
        x.c.pixels(ref, null, Buffer.alloc(G_ENV_TEX, 0));
        this.gEnvTex.set(key, ref);
        return ref;
    }

    /** The glyph codes of a text in an atlas widget's cells, aligned; -1 is an empty cell. */
    _atlasCodes(x, s) {
        const a = x.atlas, n = x.cells, text = String(s).slice(0, n);
        const pad = n - text.length, w = x.w;
        const lead = w.align === 'right' ? pad : w.align === 'center' ? Math.floor(pad / 2) : 0;
        const codes = [];
        for (let i = 0; i < 32; i++) {
            const j = i - lead;
            const ch = j >= 0 && j < text.length ? text[j] : null;
            const k = ch === null ? -1 : a.chars.indexOf(ch);
            codes.push(i < n && ch !== null ? (k < 0 ? a.chars.indexOf(' ') : k) : -1);
        }
        return codes;
    }

    _guard(what, fn) {
        try { fn(); } catch (e) { this.log.error('hud ' + what + ': ' + (e && e.stack || e)); }
    }

    /* ---------------- status line (the center screen's first row) ---------------- */

    /** fn(text) whenever the status line changes. */
    onStatus(fn) { this.statusListeners.push(fn); if (this.lastStatus) fn(this.lastStatus); }

    /** The layout name to show now: per drive mode when that's on and known, else the plain setting. */
    _layoutName() {
        if (this.screen && this.screen.yielded) return 'off';
        if (this.claimBy) return 'off';
        if (this.vstate.hold()) return 'off';           // the switch-off guard (_vehKeep keeps what is up at 8)
        return this._chosenName();
    }
    /** The layout the driver picked for now, before anything that makes us step aside. */
    _chosenName() {
        if (this.setting('byMode') === true && this.driveMode && MODE_KEY[this.driveMode]) {
            const v = this.setting(MODE_KEY[this.driveMode]);
            if (v) return v;
        }
        return this.setting('hudLayout');
    }

    /**
     * Another kit app (Redline) holding the HUD: step aside while its claim is fresh, come back when it lets go.
     * Every second; also tells the other apps whether we are on (HudClaim.standing).
     */
    _hudClaim() {
        const others = HudClaim.others(CLAIM_ID);
        const by = others.length ? others[0] : null;
        if (by !== this.claimBy) {
            this.claimBy = by;
            this.log.info(by ? 'HUD claim: ' + by + ' has the HUD, stepping aside' : 'HUD claim: the HUD is free again');
            this._rebuild();
        }
        const want = this._chosenName();
        HudClaim.standing(CLAIM_ID, !!(want && want !== 'off'));
    }

    /**
     * The switch-off guard (vehicle_state.js) at a rebuild: true = keep the layers that are up and make none (the car's
     * drive readiness starting, 8, or a state we don't know); the rebuild waits for the state to clear. Otherwise the
     * rebuild goes on, and draws nothing while the state holds new layers back (_layoutName 'off').
     */
    _vehKeep() {
        if (this.vstate.hold() && !this.vstate.drop() && this.widgets.size) {
            if (!this.vehPending) this.log.info('vehicle state ' + this.vstate.text() + ': the layers that are up stay, no new ones until the car is on');
            this.vehPending = true;
            return true;
        }
        this.vehHeld = this.vstate.hold();
        if (!this.vehHeld) this.vehPending = false;
        return false;
    }
    /** The vehicle state changed: drop at switch-off, build again once it is back to normal. */
    _vehicleState() {
        if (this.vstate.drop()) this._rebuild();
        else if (!this.vstate.hold() && (this.vehHeld || this.vehPending)) this._rebuild();
        else this._status();
    }

    _layoutLabel(name) {
        const lay = this.ctx.settings.item('hudLayout');
        const o = lay && (lay.options || []).find((x) => x[0] === name);
        return o ? o[1] : name;
    }

    /** The first widget on that layer, for the logs; a sheet is named by its first member plus how many more it holds. */
    _widgetOf(ci, ref) {
        let id = null, n = 0;
        this.widgets.forEach((x) => { if (x.ci === ci && x.ref === ref) { if (!id) id = x.w.id; n++; } });
        return n > 1 ? id + ' +' + (n - 1) : id;
    }

    /** Every layer of the layout now (effects, sheets and own image layers), each once: { c, ci, ref, key }. */
    _layerRefs() {
        const refs = [], seen = {};
        this.widgets.forEach((x) => {
            const key = x.ci + ':' + x.ref;
            if (!seen[key]) { seen[key] = true; refs.push({ c: x.c, ci: x.ci, ref: x.ref, key }); }
        });
        return refs;
    }

    /** How many connections the layout now uses. */
    _connCount() {
        const seen = {};
        this.widgets.forEach((x) => { seen[x.ci] = true; });
        return Object.keys(seen).length;
    }

    /** The connection a widget asks for ("conn", 0..3; 0 the app's own). */
    _connOf(w) {
        const n = isNum(w.conn) ? Math.floor(w.conn) : 0;
        return Math.max(0, Math.min(MAX_CONN - 1, n));
    }

    /** Layers per connection in a plan: [n on connection 1, n on 2, ...]. */
    _connCounts(plan) {
        const counts = [];
        plan.forEach((e) => { counts[e.conn] = (counts[e.conn] || 0) + 1; });
        for (let i = 0; i < counts.length; i++) counts[i] = counts[i] || 0;
        return counts;
    }

    _layerCount(n) { return n === 1 ? '1 layer' : n + ' layers'; }

    _statusSoon() {
        if (this._statusT) return;
        this._statusT = setTimeout(() => { this._statusT = null; this._guard('status', () => this._status()); }, 500);
    }

    /** ", 3 of 5 layers drawn (2 waiting: <reason>)" while some layers aren't shown; "" when all are. Counts layers, not widgets. */
    _drawnNote() {
        const ts = this.targetState;
        if (ts && (ts.state === 'waiting' || ts.state === 'parked') && ts.holder) {
            return ts.holder === 'foreign' ? ', waiting: another app has this display' : ', waiting: BMW is using this display';
        }
        const refused = this.refused ? ', refused ' + this.refused : '';
        const refs = this._layerRefs();
        if (!refs.length) return refused;
        let shown = 0, why = null, whyN = 0;
        refs.forEach((r) => {
            const st = this.layerStates.get(r.key);
            if (st && st.state === 'shown') shown++;
            else if (st) { whyN++; if (!why) why = st.state + (st.reason ? ': ' + st.reason : ''); }
        });
        if (shown === refs.length || (!why && !shown)) return refused;
        return ', ' + shown + ' of ' + this._layerCount(refs.length) + ' drawn' + (why ? ' (' + whyN + ' ' + why + ')' : '') + refused;
    }

    statusText() {
        if (!this.client.ready) {
            let there = false;
            try { there = fs.existsSync(this.socketPath); } catch (e) { /* treat as missing */ }
            return there ? this.label + ': connecting to cluster-render' : this.label + ' off: cluster-render is not installed or not running';
        }
        if (this.problem) return this.label + ': ' + this.problem;
        const byMode = this.setting('byMode') === true;
        const mode = byMode ? (this.driveRaw ? ' (drive mode not recognised: the car sends ' + this.driveRaw + ')'
            : this.driveMode ? ' (' + MODE_NAME[this.driveMode] + ')' : ' (drive mode not seen yet)') : '';
        const what = this.target === 'panel' ? 'cluster' : 'HUD';
        if (this.activeName === 'off' && this.vehHeld) return this.label + ' paused: the car is off or switching on / off (vehicle state ' + this.vstate.text() + '); it comes back when the car is on';
        if (this.activeName === 'off' && this.claimBy) return this.label + ' off: ' + this.claimBy.charAt(0).toUpperCase() + this.claimBy.slice(1) + ' has the HUD; it comes back when that app lets go';
        if (this.activeName === 'off' && this.screen.yielded) return this.label + ' off: ' + this.screen.otherName + ' has the screen, pick one here to take it back';
        if (this.activeName === 'off') return this.label + ' off' + mode + ": BMW's own " + what + ' shows';
        const name = this._layoutLabel(this.activeName);
        const d = this.car.data();
        const demo = d.demoShow ? ', playing the demo' : d.demo ? ', demo data' : '';
        const drawn = this._drawnNote();
        const conns = this._connCount();
        const layers = ', ' + this._layerCount(this._layerRefs().length) + (conns > 1 ? ' on ' + conns + ' connections' : '')
            + (this.pixelBytes ? ', ' + mib(this.pixelBytes) + ' of 16 MiB pixels' : '');
        if (this.layoutTheme) return this.label + ' on' + mode + ': ' + name + ' theme' + layers + demo + drawn;
        const theme = THEMES[this.themeName] ? THEMES[this.themeName].name : this.themeName;
        const auto = this.setting('hudTheme') === 'auto' ? ' (Auto)' : '';
        return this.label + ' on' + mode + ': ' + name + ' layout, ' + theme + ' theme' + auto + layers + demo + drawn;
    }

    _status() {
        // the Waze map's state rides along while that setting is on (and redraws the page's Map tab when it changes)
        const s = this.statusText() + (this.waze && this.setting('mapInTheme') === true ? '; Waze: ' + this.waze.info().text : '');
        const d = this.modeDiagLines().join('\n');
        if (s === this.lastStatus && d === this.lastDiag) return;
        this.lastStatus = s; this.lastDiag = d;
        this.statusListeners.forEach((fn) => { try { fn(s); } catch (e) { this.log.warn('status listener: ' + e); } });
    }

    /**
     * Issue #8: M cars keep FES's drive mode on Comfort whatever their M Setup says, so the real mode is somewhere
     * else. While "Change with the drive mode" is on, the Settings tab shows the raw contents of the candidates
     * (FES HMI switch, MDrive's engine mode, FES engine display, FES sport display 2) for a driver to photograph in each
     * mode. Fields that change all the time while driving (boost, power, torque) are left out. Never throws.
     */
    /** A drive mode from the car (FES, or M Drive on M cars): the layout for it, or the status line. */
    _driveMode(m, variant, raw) {
        if (this.demoKeep) { this.demoKeep.mode = m; this.demoKeep.variant = variant; return; }   // the demo show has the mode; kept for after
        if (m === this.driveMode && variant === this.driveVariant) return;
        this.log.info('drive mode ' + MODE_NAME[m] + (variant ? ' ' + variant : '') + ' (' + raw + ')');
        this.driveMode = m; this.driveVariant = variant;
        if (this._layoutName() !== this.activeName) this._rebuild(); else this._status();
    }

    _diag(name, v, drop) {
        try {
            // nothing to show while byMode is off; the busy candidates (drop: they notify with every boost or power
            // change) are looked at once a second at most, never on every notification
            if (this.setting('byMode') !== true) return;
            if (drop) {
                const now = Date.now();
                if (now - (this.diagAt[name] || 0) < 1000) return;
                this.diagAt[name] = now;
            }
            let o = v;
            if (v && typeof v === 'object' && drop) { o = {}; Object.keys(v).forEach((k) => { if (drop.indexOf(k) < 0) o[k] = v[k]; }); }
            const t = String(JSON.stringify(o)).replace(/"/g, '').slice(0, 84);
            if (this.modeDiag[name] === t) return;
            this.modeDiag[name] = t;
            const n = this.modeDiagLogged[name] = (this.modeDiagLogged[name] || 0) + 1;
            if (n <= 20) this.log.info('drive mode check ' + name + ': ' + t);
            // at most two page redraws a second, however often a value changes
            if (!this.diagTimer) this.diagTimer = setTimeout(() => { this.diagTimer = null; try { this._status(); } catch (e) { /* next status */ } }, 500);
        } catch (e) { /* a diagnostic never stops the app */ }
    }
    /**
     * The drive mode check's lines for the Settings tab (one per signal), [] while byMode is off. names: the
     * candidates the app listens to (its app.json; main.js gives them to the page), so none shows "--" for ever.
     */
    modeDiagLines(names) {
        if (this.setting('byMode') !== true) return [];
        return (names || ['HMI', 'MDrive', 'Engine', 'Sport2']).map((n, i) => (i ? '' : 'Drive mode check: ') + n + '  ' + (this.modeDiag[n] || '--'));
    }

/* ---------------- theme, units, values ---------------- */

    _themeName() {
        if (this.layoutTheme) {
            // a theme with holiday editions (Ribbon): "<theme>_<holiday>" while the "holiday" setting picks one
            const base = THEMES[this.layoutTheme];
            if (!base || !base.holidays || !this.ctx.settings.item('holiday')) return this.layoutTheme;
            const d = this._localDate(), h = holidays.pick(this.setting('holiday'), d.y, d.m, d.d);
            return h && THEMES[this.layoutTheme + '_' + h] ? this.layoutTheme + '_' + h : this.layoutTheme;
        }
        const t = this.setting('hudTheme');
        if (t !== 'auto') return t;
        return sun.isNight(Date.now(), ...this._sunPlace()) ? 'night' : this.setting('dayTheme');
    }

    /** The holiday the HUD is drawn in now (hud_holiday.js; the "holiday" setting, as Cluster Themes'), or null. */
    _hudHoliday() {
        if (this.target !== 'hud' || !this.ctx.settings.item('holiday')) return null;
        const d = this._localDate();
        return holidays.pick(this.setting('holiday'), d.y, d.m, d.d) || null;
    }

    /** The holiday the "holiday" setting picks today (holidays.js), or null: the light string's, on either target. */
    _holidayNow() {
        if (!this.ctx.settings.item('holiday')) return null;
        const d = this._localDate();
        return holidays.pick(this.setting('holiday'), d.y, d.m, d.d) || null;
    }

    /** The holiday whose light string (garland.js) this layout gets, or null: not on a calibration layout, nor on a
     *  theme with holiday editions of its own (Ribbon hangs its own bulbs). */
    _garlandHoliday(name, shown) {
        if (['grid', 'wincal', 'mapcal'].indexOf(name) >= 0 || shown.some((w) => ['grid', 'gridlabels', 'swatch', 'swatchimg'].indexOf(w.type) >= 0)) return null;
        const base = this.layoutTheme && THEMES[this.layoutTheme];
        if (base && base.holidays) return null;
        return this.holidayAt || null;
    }

    /** The light string's twinkle: while the car stands (under 3 km/h) a few bulbs dim for a moment, only their rects
     *  sent, at most 4 times a second; while it moves every bulb is lit and nothing is sent. */
    _garlandTick(x, now) {
        if (!x.tw) return;
        const sp = this.car.data().speed;
        const changed = x.tw.step(now, isNum(sp) && sp < 3);
        if (!changed.length) return;
        const rects = x.tw.rects(changed);
        if (rects.length) this._blit(x, rects, Buffer.concat(rects.map((r) => Garland.paint(x.w, x.tw.lvl, r))));
    }

    /** Night colours now: Cluster Themes' "nightDim" on Auto, a theme of the layout's own, and the sun down. */
    _nightDim() {
        if (!this.ctx.settings.item('nightDim') || this.setting('nightDim') !== 'auto' || !this.layoutTheme) return false;
        return sun.isNight(Date.now(), ...this._sunPlace());
    }

    /** Start the shift-light test: the rpm the lights, bars and readouts see climbs to the shift point and holds there
     *  (about 4 s). Only while the car stands (or on demo data). Returns false when it can't run now. */
    testShift() {
        const d = this.car.data(), sp = d.speed;
        if (isNum(sp) && sp > 3 && !d.demo) return false;
        this.testAt = Date.now();
        this.log.info('shift-light test');
        return true;
    }
    shiftTesting() { return this.testAt !== null; }

    /* ---------------- "Play demo" (demo_script.js) ---------------- */

    /** Why the demo can't start now ('moving', 'off': nothing would show, 'notready': cluster-render not connected), else null. */
    demoBlocked() {
        if (this.demo.playing()) return null;
        if (!this.demo.standing()) return 'moving';
        if (this.screen.yielded || this.claimBy) return 'off';
        if (!this.client.ready) return 'notready';
        return this._demoModes().length || this._chosenName() !== 'off' ? null : 'off';
    }
    /** Start the show (about a minute; at: ms into it, the bench's screenshots); false when it can't run now. */
    playDemo(at) { return !this.demoBlocked() && this.demo.start(at); }
    stopDemo() { this.demo.stop('Stop pressed'); }
    demoPlaying() { return this.demo.playing(); }
    /** ms of the show left, 0 when it doesn't play. */
    demoLeft() { return this.demo.left(); }
    /** With "Change with the drive mode" on: Comfort then Sport, leaving out one whose layout is off (it would show nothing). */
    _demoModes() {
        if (this.setting('byMode') !== true) return [];
        return ['comfort', 'sport'].filter((m) => { const v = this.setting(MODE_KEY[m]); return v && v !== 'off'; });
    }
    /** The show's hooks (demo_script.js): the drive's own shift grade, G-meter and peak boost are put aside while it plays. */
    _demoHooks() {
        return {
            redline: () => this.setting('redline'),
            shiftPoint: () => this.score.shiftPoint(90).rpm,
            warnOil: () => Number(this.setting('warnOil')) || 0,
            modes: () => this._demoModes(),
            begin: () => {
                const s = this.score;
                this.demoSaved = { own: s.own, peak: s.peak, peakT: s.peakT, limiterHits: s.limiterHits, boostPeak: this.boostPeak,
                    gEnv: this.gEnv.slice(), gBest: Object.assign({}, this.gBest), gTrail: this.gTrail.slice() };
            },
            end: () => {
                const k = this.demoSaved, s = this.score;
                this.demoSaved = null;
                if (!k) return;
                s.own = k.own; s.peak = k.peak; s.peakT = k.peakT; s.limiterHits = k.limiterHits; this.boostPeak = k.boostPeak;
                this.gEnv = k.gEnv; this.gBest = k.gBest; this.gTrail = k.gTrail; this.gEnvAt = Date.now();
                this.widgets.forEach((x) => { x.last = null; });
            },
            // the drive mode the show is in (null: the car's own again); redrawn when the layout changes, or always with force
            drive: (m, force) => {
                if (m && !this.demoKeep) this.demoKeep = { mode: this.driveMode, variant: this.driveVariant };
                if (m) { this.driveMode = m; this.driveVariant = null; }
                else if (this.demoKeep) { this.driveMode = this.demoKeep.mode; this.driveVariant = this.demoKeep.variant; this.demoKeep = null; }
                // a calibration layout carries the DEMO tag only while the show plays (CAL_LAYOUTS): Play and Stop rebuild it
                if (force || this._layoutName() !== this.activeName || CAL_LAYOUTS[this.activeName]) this._rebuild(); else this._status();
            },
        };
    }

    /** The test's rpm now, or null when no test runs (it ends by itself). */
    _testRpm(now) {
        if (this.testAt === null) return null;
        const t = now - this.testAt;
        if (t > TEST_CLIMB_MS + TEST_HOLD_MS || t < 0) { this.testAt = null; return null; }
        const top = this._shiftPointRaw() + 200;
        return TEST_FROM + (top - TEST_FROM) * Math.min(1, t / TEST_CLIMB_MS);
    }
    _shiftPointRaw() { return this.score.shiftPoint(this.car.data().oil).rpm; }

    /** A readout over its warning limit ("warnOil" C, "warnCoolant" C, "warnBoost" bar; 0 = off): which sensor, else null. */
    _warning(w) {
        const t = String(w.text || '');
        let id = null;
        if (t.indexOf('{{slot:') >= 0 && w.slot) id = (this.slotSensor(this.activeName, w.slot, this.layoutSlots) || {}).id;
        else if (t.indexOf('{{oil}}') >= 0) id = 'oil';
        else if (t.indexOf('{{coolant}}') >= 0) id = 'coolant';
        else if (t.indexOf('{{boost}}') >= 0) id = 'boost';
        return this._overLimit(id);
    }
    /** `id` (oil / coolant / boost) if that reading is over its warning limit now, else null. */
    _overLimit(id) {
        if (!WARN[id]) return null;
        const lim = this.setting(WARN[id]), v = this._raw(id);
        return isNum(lim) && lim > 0 && isNum(v) && v > lim ? id : null;
    }

    _barMax(w) { return Math.ceil(this.setting('redline') / 1000) * 1000 + ((w && w.over) || 0); }

    /** The shift point now ({ rpm, cold }) and whether the rpm is at or past it. */
    _shift() {
        const d = this.car.data();
        const sp = this.score.shiftPoint(d.oil);
        const rpm = isNum(this.rpmF) ? this.rpmF : d.rpm;
        // the count-in (setting "shiftCue"): "now" is the cue's early, latched flash (shift_cue.js), else the rpm at the point
        sp.now = this._countIn() ? this.cue.now.shift : isNum(rpm) && rpm >= sp.rpm;
        sp.oilCold = isNum(d.oil) && d.oil < 80;
        return sp;
    }

    /** The shift lights count in (setting "shiftCue" on "countin", the default), else the fixed rpm band. */
    _countIn() { return !this.ctx.settings.item('shiftCue') || this.setting('shiftCue') !== 'rpm'; }

    /** Every tick: the count-in cue from the rpm (the test's while it runs) and the reaction time (shift_cue.js). */
    _cueTick(now) {
        const d = this.car.data(), test = this._testRpm(now), testing = isNum(test);
        if (d.demo !== this.cueDemo) { this.cueDemo = d.demo; this.cue.reset(); }
        const share = this.score.redline();
        const sp = this.score.shiftPoint(d.oil).rpm, lead = this.cue.lead(share && share.leadMs);
        // learned only on the car's own data, not in the test, and only from flashes the driver could see
        const learn = d.demo || testing || !this._countIn() ? null : { mode: this.gradeMode };
        const seen = () => this.activeName !== 'off' && !!this.client.ready && Array.from(this.widgets.values()).some((x) => CUE_TYPES[x.w.type]);
        this.cue.tick(testing ? test : d.rpm, now, sp, this.setting('redline'), lead, testing ? undefined : d.gear, this.rpmF, seen, learn);
    }

    /** Boost in bar: the sport display's value while fresh, else the engine unit's, else null. */
    _boost() {
        const now = Date.now();
        if (this.demo && this.demo.playing()) return this.car.data().boost;
        if (isNum(this.boostFes) && now - this.boostFesAt < FRESH_MS) return this.boostFes;
        if (isNum(this.boostDme) && now - this.boostDmeAt < FRESH_MS) return this.boostDme;
        return null;
    }

    /** A tyre's pressure ('p', bar) or temperature ('t', C) at corner FL FR RL RR; steady made-up values on the demo drive. */
    /** A TPMS pressure raw (0.1 x the car's unit, 65532 and up = none) in bar: by the car's unit when known, else by the
     *  unit whose plausible tyre pressures the value falls in (bar 0.5-6, psi 7-60, kPa 60-600; psi also means F). */
    _tyreBar(raw) {
        if (!isNum(raw) || raw < 0 || raw >= 65532) return null;
        const v = raw / 10, k = PRESS_TO_BAR[this.carUnits.press];
        if (k) return v * k;
        if (v >= 0.5 && v <= 6) return v;
        if (v >= 7 && v < 60) { this.carUnits.psiSeen = true; return v / 14.5038; }
        if (v >= 60 && v <= 600) return v / 100;
        return v;
    }

    /** A TPMS temperature raw (the car's degrees + 40, 65535 = none) in C (the car sends F when set to F). */
    _tyreC(raw) {
        if (!isNum(raw) || raw < 0 || raw >= 65535) return null;
        const v = raw - 40, f = this.carUnits.temp ? this.carUnits.temp === 'F' : this.carUnits.psiSeen;
        return f ? (v - 32) * 5 / 9 : v;
    }

    /** The shifter programme letter next to the gear: S or M from the M drive display, else from the gearbox status, else D. */
    _program(d) {
        const p = this.program || d.program;
        return p === 'S' || p === 'M' ? p : 'D';
    }

    _tyre(kind, corner) {
        const v = this.tyres[kind][corner];
        if (isNum(v)) return v;
        if (!this.car.data().demo) return null;
        const rear = corner === 'RL' || corner === 'RR';
        return kind === 'p' ? (rear ? 2.5 : 2.3) : (rear ? 27 : 24);
    }

    /** Peak hold for a gauge: the highest value of the last `hold` ms (true: 3 s), as 0..1. */
    _peakHold(x, v, now, hold) {
        const ms = hold === true ? 3000 : hold;
        if (!isNum(x.peakV) || v >= x.peakV || now - x.peakAt > ms) { x.peakV = v; x.peakAt = now; }
        return x.peakV;
    }

    /** One car sample: the g average (G_BAD, G_AVG_MS). */
    _gSample(d, t) {
        if (!isNum(d.gLong) || Math.abs(d.gLong) > G_BAD || (isNum(d.gLat) && Math.abs(d.gLat) > G_BAD)) return;
        this.gBuf.push([t, isNum(d.gLat) ? d.gLat : 0, d.gLong]);
        while (this.gBuf.length && t - this.gBuf[0][0] > G_AVG_MS) this.gBuf.shift();
        const n = this.gBuf.length;
        this.gSm = { lat: this.gBuf.reduce((a, s) => a + s[1], 0) / n, long: this.gBuf.reduce((a, s) => a + s[2], 0) / n, at: Date.now() };
    }

    /** Forget the G-meter's envelope, trail and bests (the page's Reset button, the demo / car switch). */
    resetG() {
        this.gEnv = new Array(G_SECTORS).fill(0);    // car frame: sector n at n * 7.5 degrees, atan2(long, lat)
        this.gBest = { left: 0, right: 0, accel: 0, brake: 0, total: 0 };
        this.gTrail = [];                            // [t, lat, long], newest first
        this.gEnvAt = Date.now();                    // changes when the envelope does (widgets resend it)
    }

    /** The G-meter's range in g: the setting, else the layout's "max", else 1.2. */
    _gRange(w) {
        const v = Number(this.setting('gRange'));
        return v > 0 ? v : (w && w.max) || 1.2;
    }

    /** The g every tick (car frame, lat + = left, long + = speeding up): the envelope, bests and trail. */
    _gTick(now) {
        const lat = this._raw('gLat'), lon = this._raw('gLong');
        if (!isNum(lat) || !isNum(lon)) return;
        const r = Math.sqrt(lat * lat + lon * lon), B = this.gBest;
        if (lat > B.left) B.left = lat;
        if (-lat > B.right) B.right = -lat;
        if (lon > B.accel) B.accel = lon;
        if (-lon > B.brake) B.brake = -lon;
        if (r > B.total) B.total = r;
        if (r > 0.05) {
            const n = Math.round(Math.atan2(lon, lat) / (2 * Math.PI) * G_SECTORS);
            for (let o = -G_SPREAD; o <= G_SPREAD; o++) {
                const i = ((n + o) % G_SECTORS + G_SECTORS) % G_SECTORS;
                const v = Math.round(r * Math.cos(o * 2 * Math.PI / G_SECTORS) * 50) / 50;
                if (v > this.gEnv[i]) { this.gEnv[i] = v; this.gEnvAt = now; }
            }
        }
        const secs = Number(this.setting('gTrail')), step = secs > 0 ? secs * 1000 / (G_TRAIL - 1) : 0;
        if (!step) { this.gTrail = []; return; }
        if (!this.gTrail.length || now - this.gTrail[0][0] >= step) {
            this.gTrail.unshift([now, lat, lon]);
            if (this.gTrail.length > G_TRAIL - 1) this.gTrail.length = G_TRAIL - 1;
        }
    }

    /** Screen signs for the G-meter: [sx, sy], drawn x = sx * lat, drawn y (down) = sy * long. */
    _gSigns(w) {
        const fx = (this.setting('gFlipLat') === true) !== !!(w && w.flipX), fy = (this.setting('gFlipLong') === true) !== !!(w && w.flipY);
        return [fx ? 1 : -1, fy ? 1 : -1];
    }

    /** What the page's G-meter tab shows: the g now, the trail and envelope as drawn, the bests, the range. */
    gState() {
        const S = this._gSigns(null), lat = this._raw('gLat'), lon = this._raw('gLong');
        return {
            x: isNum(lat) ? S[0] * lat : null, y: isNum(lon) ? S[1] * lon : null,
            trail: this.gTrail.map((p) => [S[0] * p[1], S[1] * p[2]]), env: this._gEnvDrawn(S),
            best: this.gBest, max: this._gRange(null), live: isNum(lat) && isNum(lon),
        };
    }

    /** The envelope by drawn sector: sector m at m * 7.5 degrees counter-clockwise from + x, + y up. */
    _gEnvDrawn(S) {
        const out = new Array(G_SECTORS);
        for (let m = 0; m < G_SECTORS; m++) {
            const a = m * 2 * Math.PI / G_SECTORS;
            // drawn up vector u = (sx * lat, -sy * long), so the car's direction is (sx cos a, -sy sin a)
            const n = Math.round(Math.atan2(-S[1] * Math.sin(a), S[0] * Math.cos(a)) / (2 * Math.PI) * G_SECTORS);
            out[m] = this.gEnv[((n % G_SECTORS) + G_SECTORS) % G_SECTORS];
        }
        return out;
    }

    _raw(name) {
        if (name === 'boost') return this._boost();
        if (name === 'gLat' || name === 'gLong') {
            // the 150 ms average while samples come in; else the car's last reading, unless it is a bad one
            if (this.gSm && Date.now() - this.gSm.at < 1000) return name === 'gLat' ? this.gSm.lat : this.gSm.long;
            const g = this.car.data()[name];
            return isNum(g) && Math.abs(g) <= G_BAD ? g : null;
        }
        if (name === 'intake') {
            if (isNum(this.intakeDme) && Date.now() - this.intakeDmeAt < 10000) return this.intakeDme;
            return this.car.data().demo ? 31 : null;
        }
        if (name === 'rpm' && isNum(this.rpmF)) return this.rpmF;
        if (name === 'hvSoc') return isNum(this.hvSoc) && Date.now() - this.hvSocAt < HV_STALE_MS ? this.hvSoc : this.car.data().demo ? 64 : null;
        if (name === 'fuel' || name === 'range' || name === 'ambient') {
            // the kit's demo drive has none of these: made-up but steady values while it runs
            const demo = this.car.data().demo;
            if (name === 'fuel') {
                if (isNum(this.fuelObd) && Date.now() - this.fuelObdAt < FUEL_STALE_MS) return this.fuelObd / 100;
                return isNum(this.fuelL) ? Math.min(1, this.fuelL / this._tankLitres()) : demo ? 0.62 : null;
            }
            if (name === 'range') return isNum(this.rangeKm) ? this.rangeKm : demo ? 368 : null;
            return isNum(this.ambient) ? this.ambient : demo ? 24 : null;
        }
        if (name === 'torquePct' || name === 'powerPct') {
            // the car's own sport display % while it sends one, else from the crank torque and app.json
            // config.engine's peaks (an M40i makes 500 Nm, 285 kW)
            if (Date.now() - (this.sportAt || 0) < FRESH_MS) {
                const v = name === 'powerPct' ? this.sportPower : this.sportTorque;
                if (isNum(v)) return v;
            }
            const e = this.config.engine || {}, d = this.car.data();
            if (!isNum(d.torque)) return null;
            if (name === 'torquePct') return Math.max(0, d.torque) / (e.torqueNm || 500) * 100;
            return isNum(d.rpm) ? Math.max(0, d.torque) * d.rpm / 9549 / (e.powerKw || 285) * 100 : null;
        }
        if (name === 'mediaPct') { const e = this._mediaElapsed(); return e === null ? null : e / this.media.total * 100; }   // the song's progress
        if (name.indexOf('setupLevel:') === 0) { const s = this._setup(); return s ? SETUP_LEVEL[s[name.slice(11)]] || 0 : 0; }
        const d = this.car.data();
        return Object.prototype.hasOwnProperty.call(d, name) ? d[name] : null;
    }

    /** Where the red and orange marks start on a rev scale that ends at `max` rpm, as fractions 0..1: red from the
     *  redline, but always covering at least the last 500 rpm (the M40i's scale ends right at its 7000 redline),
     *  orange over the 700 rpm before the red. */
    _redMarks(max) {
        const redFrom = Math.min(this.setting('redline'), max - 500) / max;
        return [redFrom, redFrom - 700 / max];
    }

    /** The scale label nearest the value now: 'speed' (SPEED_SCALE index) or 'rpm' (thousands); null without data. */
    _nearMark(kind) {
        if (kind === 'rpm') { const r = this._raw('rpm'); return isNum(r) ? Math.round(r / 1000) : null; }
        const v = this._raw('speed');
        if (!isNum(v)) return null;
        const us = this.setting('units') === 'us';
        return Math.round(scaleFrac(us ? v * 0.621371 : v, SPEED_SCALE[us ? 'us' : 'metric']) * 8);
    }

    /** The setup rows for the drive mode now, or null before the car has said. */
    _setup() {
        if (!this.driveMode) return null;
        if (this.driveVariant === 'individual') return SETUP.individual;
        return SETUP[this.driveMode === 'sport' && this.driveVariant === 'plus' ? 'sportplus' : this.driveMode];
    }

    /** {{token}} -> display text. */
    _token(tok) {
        const us = this.setting('units') === 'us';
        const fix = (v, n) => (isNum(v) ? v.toFixed(n) : '--');
        if (tok.indexOf('slot') === 0 && tok.indexOf(':') > 0) {
            const kind = tok.slice(0, tok.indexOf(':')), sn = this.slotSensor(this.activeName, tok.slice(kind.length + 1), this.layoutSlots);
            if (kind === 'slot') return this.sensorValue(sn);
            if (kind === 'slotHead') return sn ? sn.head : '';
            if (kind === 'slotHeadS') return sn ? sn.short || sn.head : '';     // M's slot rows: LAST SHIFT -> SHIFTED
            // the heading with the unit, for a slot with no unit of its own: "FUEL %" (a temperature's ° is on its value)
            if (kind === 'slotHeadU') { const u = sn && !sn.suffix ? this.sensorUnit(sn) : ''; return sn ? sn.head + (u ? ' ' + u : '') : ''; }
            if (kind === 'slotUnit') return this.sensorUnit(sn);
            if (kind === 'slotSuffix') return sn && sn.suffix ? sn.suffix : '';
        }
        if (tok.indexOf('tyreP:') === 0) { const v = this._tyre('p', tok.slice(6)); return isNum(v) ? (us ? fix(v * 14.5038, 0) : fix(v, 1)) : '--'; }
        if (tok.indexOf('tyreT:') === 0) { const v = this._tyre('t', tok.slice(6)); return isNum(v) ? String(Math.round(us ? v * 9 / 5 + 32 : v)) : '--'; }
        switch (tok) {
            case 'u:pressure': return us ? 'psi' : 'bar';
            case 'intake': { const v = this._raw('intake'); return fix(isNum(v) ? (us ? v * 9 / 5 + 32 : v) : v, 0); }
            case 'boostPeak': { const v = this.boostPeak; return us ? fix(isNum(v) ? v * 14.5038 : v, 1) : fix(v, 2); }
            case 'run': { const v = this.runs.shown(Date.now()); return isNum(v) ? v.toFixed(this.runs.state === 'run' ? 1 : 2) : '0.00'; }
            case 'runBest': { const v = this.runs.best[us ? 'us' : 'metric']; return v > 0 ? v.toFixed(2) : '-.--'; }
            case 'runState': return this.runs.word();
            case 'runLabel': return us ? '0-60 MPH' : '0-100 KM/H';
            case 'warm': { const o = this._raw('oil'); return isNum(o) ? (o < 80 ? 'WARMING UP' : 'ENGINE WARM') : ''; }
            case 'badge': return badges.text(this.setting('badge'), this.setting('badgeBMW') === true);
            case 'speed': { const v = this._raw('speed'); return fix(isNum(v) ? (us ? v * 0.621371 : v) : v, 0); }
            case 'u:speed': return us ? 'MPH' : 'KM/H';
            case 'mediaTitle': return this._mediaOn() ? this.media.title : '';
            case 'mediaArtist': return this._mediaOn() ? this.media.artist : '';
            case 'mediaElapsed': { const e = this._mediaElapsed(); return e === null ? '' : clockOf(e); }
            case 'mediaLeft': { const e = this._mediaElapsed(); return e === null ? '' : '-' + clockOf(this.media.total - e); }
            case 'speed2': { const v = this._raw('speed'); return fix(isNum(v) ? (us ? v : v * 0.621371) : v, 0); }   // the other unit
            case 'u:speed2Lc': return us ? 'km/h' : 'mph';
            case 'u:speed2': return us ? 'KM/H' : 'MPH';
            case 'oil': case 'coolant': { const v = this._raw(tok); return fix(isNum(v) ? (us ? v * 9 / 5 + 32 : v) : v, 0); }
            case 'boost': { const v = this._raw('boost'); return us ? fix(isNum(v) ? v * 14.5038 : v, 1) : fix(v, 2); }
            case 'u:boost': return us ? 'PSI' : 'BAR';
            case 'u:boostLc': return us ? 'psi' : 'bar';
            case 'holiday': return this.theme.greeting || '';
            case 'greeting': {                  // the HUD's holiday greeting (hud_holiday.js), only while the car stands
                const sp = this.car.data().speed;
                return this.theme.hudGreeting && isNum(sp) && sp < 3 ? this.theme.hudGreeting : '';
            }
            case 'u:temp': return us ? '°F' : '°C';
            case 'u:speedLc': return us ? 'mph' : 'km/h';
            case 'u:distLc': return us ? 'mi' : 'km';
            case 'u:dist': return us ? 'MI' : 'KM';
            case 'avgSpeed': { const v = this._avgSpeed(); return fix(isNum(v) ? (us ? v * 0.621371 : v) : v, 0); }
            case 'range': { const v = this._raw('range'); return fix(isNum(v) ? (us ? v * 0.621371 : v) : v, 0); }
            case 'ambient': {
                const v = this._raw('ambient');
                if (!isNum(v)) return '--';
                const n = Math.round(us ? v * 9 / 5 + 32 : v);
                return (n > 0 ? '+' : '') + n;
            }
            case 'u:torque': return us ? 'lb-ft' : 'Nm';
            case 'power': {          // kW from the crank torque and rpm; hp in US units
                const d = this.car.data(), rpm = this._raw('rpm');
                if (!isNum(d.torque) || !isNum(rpm)) return '--';
                const kw = Math.max(0, d.torque) * rpm / 9549;
                return String(Math.round(us ? kw * 1.341 : kw));
            }
            case 'hvSoc': { const v = this._raw('hvSoc'); return isNum(v) ? String(Math.round(v)) : '--'; }
            case 'fuelPct': { const v = this._raw('fuel'); return isNum(v) ? String(Math.round(v * 100)) : '--'; }
            case 'ambientN': { const v = this._raw('ambient'); return isNum(v) ? String(Math.round(us ? v * 9 / 5 + 32 : v)) : '--'; }
            case 'torque': { const v = this._raw('torque'); return fix(isNum(v) ? (us ? v * 0.737562 : v) : v, 0); }
            case 'torquePct': case 'powerPct': { const v = this._raw(tok); return isNum(v) ? String(Math.min(100, Math.round(v))) : '--'; }
            case 'boostHi': return us ? '20' : '1.4';
            case 'boostMid': return us ? '10' : '0.7';
            case 'ampmLc': return this._token('ampm').toLowerCase();
            case 'gLat': case 'gLong': { const v = this._raw(tok); return isNum(v) ? Math.abs(v).toFixed(2) : '--'; }
            case 'gSide': case 'gFwd': {
                // the car's left / right (gFlipLat: its sign the other way round); brake on top doesn't change the words
                const v = this._raw(tok === 'gSide' ? 'gLat' : 'gLong');
                if (!isNum(v)) return '--';
                const a = Math.abs(v).toFixed(2);
                if (a === '0.00') return a;
                if (tok === 'gFwd') return a + (v > 0 ? ' ACC' : ' BRK');
                return a + ((v > 0) !== (this.setting('gFlipLat') === true) ? ' L' : ' R');
            }
            case 'gBest': return this.gBest.total > 0 ? this.gBest.total.toFixed(2) : '--';
            case 'gMax': return this._gRange(null).toFixed(1);
            case 'rpm': case 'rpm10': return isNum(this.rpmShown) ? String(this.rpmShown) : (tok === 'rpm' ? '--' : '----');
            case 'shiftAt': return String(this._shift().rpm);
            case 'lastShift': return this.score.last ? String(this.score.last.rpm) : '--';
            case 'lastGears': { const l = this.score.last; return l && l.from !== '?' ? l.from + ' > ' + l.to : ''; }
            case 'verdict': return this.score.last ? this.score.last.verdict : '';
            case 'shiftPrompt': return this._shift().now ? 'SHIFT' : '';
            case 'coldNote': {
                const sp = this._shift();
                if (!sp.oilCold) return '';
                return sp.cold ? 'COLD · LIMIT ' + sp.rpm : 'OIL COLD · GO EASY';
            }
            case 'gearnum': {
                const d = this.car.data();
                if (d.stage === 'P' || d.stage === 'R' || d.stage === 'N') return d.stage;
                return isNum(d.gear) && d.gear > 0 ? String(d.gear) : (d.gear === 0 ? 'N' : '-');
            }
            case 'stage': {          // the selector letter alone: P R N, or D / S / M by the shifter programme
                const d = this.car.data();
                return d.stage === 'D' || (!d.stage && isNum(d.gear) && d.gear > 0) ? this._program(d) : (d.stage || '-');
            }
            case 'gearInD': {        // the gear number while driving, else nothing (the M "2D")
                const d = this.car.data();
                return (d.stage === 'D' || (!d.stage && isNum(d.gear))) && isNum(d.gear) && d.gear > 0 ? String(d.gear) : '';
            }
            case 'mode': {
                if (!this.driveMode) return '';
                const base = this.driveMode === 'sport' ? 'SPORT' : this.driveMode === 'eco' ? 'ECO PRO' : 'COMFORT';
                return base + (this.driveVariant === 'plus' ? ' PLUS' : this.driveVariant === 'individual' ? ' INDIVIDUAL' : '');
            }
            case 'gear': {
                const d = this.car.data();
                if (d.stage === 'P' || d.stage === 'R' || d.stage === 'N') return d.stage;
                const g = isNum(d.gear) && d.gear > 0 ? String(d.gear) : '';
                return d.stage === 'D' ? this._program(d) + g : g;
            }
            case 'time': case 'ampm': {
                const now = this._now();
                const h = now.getHours(), m = now.getMinutes();
                if (tok === 'ampm') return this.setting('clock') === '12h' ? (h < 12 ? 'AM' : 'PM') : '';
                if (this.setting('clock') === '24h') return pad2(h) + ':' + pad2(m);
                return ((h % 12) || 12) + ':' + pad2(m);
            }
            default:
                if (tok.indexOf('spd:') === 0) { const v = SPEED_SCALE[us ? 'us' : 'metric'][Number(tok.slice(4))]; return v === undefined ? '' : String(v); }   // speed scale labels
                if (tok.indexOf('temp:') === 0) { const c = Number(tok.slice(5)); return isNum(c) ? String(us ? Math.round((c * 9 / 5 + 32) / 10) * 10 : Math.round(c)) : '--'; }   // gauge labels: °F to the 10
                if (tok.indexOf('setup:') === 0) { const s = this._setup(); return s ? s[tok.slice(6)] || '' : '--'; }
                if (tok.indexOf('signal:') === 0) { const v = this._raw(tok.slice(7)); return isNum(v) ? (Math.round(v * 10) / 10).toString() : '--'; }
                return '{{' + tok + '}}';
        }
    }

    /** The fuel tank's size in litres: the "tankLitres" setting, else config.tankLitres (the car sends litres only). */
    _tankLitres() {
        const s = this.ctx.settings.item('tankLitres') ? this.setting('tankLitres') : null;
        return isNum(s) && s > 0 ? s : (this.config.tankLitres || 65);
    }

    /**
     * Local time. The head unit's clock runs on UTC (issues #6, #8: the clock 5 to 7 hours ahead), so the "timeZone"
     * setting wins (minutes from UTC, or a named zone that follows its own daylight saving: shared/tz.js;
     * TZ_AUTO = the unit's own), then config.utcOffsetMinutes.
     */
    _now() {
        const setting = this.ctx.settings.item('timeZone') ? this.setting('timeZone') : TZ_AUTO;
        const zoned = tz.offset(setting);            // a fixed offset, or a named zone with its daylight saving
        const off = isNum(zoned) ? zoned : this.config.utcOffsetMinutes;
        if (!isNum(off)) return new Date();
        const d = new Date(Date.now() + off * 60000);
        return { getHours: () => d.getUTCHours(), getMinutes: () => d.getUTCMinutes() };
    }

    /** Today's local date { y, m (1..12), d } by the same time zone as the clock (_now). */
    _localDate() {
        const setting = this.ctx.settings.item('timeZone') ? this.setting('timeZone') : TZ_AUTO;
        const zoned = tz.offset(setting);
        const off = isNum(zoned) ? zoned : this.config.utcOffsetMinutes;
        if (!isNum(off)) { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() }; }
        const n = new Date(Date.now() + off * 60000);
        return { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate() };
    }

    /**
     * Where sunrise and sunset are worked out (the Auto theme, Night colours): config.location if a layout author set
     * one, else the middle of the zone the "timeZone" setting names (shared/tz.js), else the middle of the US.
     */
    _sunPlace() {
        const c = this.config.location;
        if (c && isNum(c.lat) && isNum(c.lon)) return [c.lat, c.lon];
        const setting = this.ctx.settings.item('timeZone') ? this.setting('timeZone') : TZ_AUTO;
        const p = tz.place(isNum(setting) && setting !== TZ_AUTO ? setting : this.config.utcOffsetMinutes);
        return p ? [p.lat, p.lon] : [tz.FALLBACK.lat, tz.FALLBACK.lon];
    }

    _resolve(template) { return String(template).replace(/\{\{([a-zA-Z0-9:]+)\}\}/g, (_, t) => this._token(t)); }

    /* ---------------- layers ---------------- */

    _rebuild() {
        this._guard('rebuild', () => this._rebuildInner());
        this._status();
    }

    _rebuildInner() {
        if (!this.client.ready) return; // the 'ready' handler calls us again
        if (this._vehKeep()) return;
        this._layerRefs().forEach((r) => r.c.drop(r.ref));
        this.placed = [];
        this.widgets.clear();
        this.navShown = false;           // the nav widget shows a turn ("navHide" texts are empty then)
        this.sheets = [];
        this.pixelBytes = 0;
        this.layerStates.clear();
        this.stallTimers.forEach((t) => clearTimeout(t)); this.stallTimers.clear();
        this.refused = null;
        clearTimeout(this.statusAskT); this.statusAskT = null;
        this.car.setRedline(this.setting('redline'));
        const name = this._layoutName();
        this.activeName = name;
        this.holidayAt = this._holidayNow();     // the light string's holiday (garland.js); the minute timer rebuilds when it changes
        this.mapLayout = false;
        this.mapShown = this.setting('mapUp');
        if (name === 'off') {
            this._wazeWant();
            this.problem = null; this.layoutTheme = null; this.needsBoost = false; this.needsIntake = false; this.needsHv = false; this.needsFuel = false;
            this.log.info('off: nothing drawn, BMW\'s own ' + (this.target === 'panel' ? 'cluster' : 'HUD') + ' shows');
            return;
        }
        let layout;
        try { layout = this.layouts.load(name); } catch (e) {
            this.problem = e.message;
            this.log.warn('layout "' + name + '" unusable (' + e.message + '); showing nothing');
            this._wazeWant();
            return;
        }
        this.problem = null;
        this.mapLayout = layout.widgets.some((w) => w.holeWhen === 'mapUp');
        // "mapLive" holds only while nothing else changes with the map (a widget toggled on mapUp needs the rebuild)
        this.mapLive = layout.mapLive === true && !layout.widgets.some((w) => typeof w.toggle === 'string' && w.toggle.indexOf('mapUp') >= 0);
        this._wazeWant();
        this.layoutSlots = layout.slots || [];
        this.layoutTheme = layout.theme && THEMES[layout.theme] ? layout.theme : null;
        this.themeName = this._themeName();
        this.theme = THEMES[this.themeName] || THEMES.classic;
        this.hudHoliday = this._hudHoliday();      // the HUD's holiday colours (hud_holiday.js), null for none
        if (this.hudHoliday) this.theme = hudHoliday.theme(this.theme, this.hudHoliday);
        this.nightOn = this._nightDim();
        if (this.nightOn) this.theme = dimTheme(this.theme, NIGHT_DIM);
        this.log.info('layout "' + layout.name + '", theme ' + this.theme.name + (this.layoutTheme ? '' : ' (' + this.setting('hudTheme') + ')'));
        // full screen (Nov 14 2026): the layout's strip widgets (design/genlib.py full_screen) cover BMW's strip except a
        // window over its gear letter, and the theme's own strip row ("stripRow" l / r) shows the clock, range and outside
        // temperature. "Leave BMW's bottom strip clear" is gone again (0.17.7): with the gear letter uncovered BMW draws no
        // black box (car test of 0.17.6), so the switch had nothing left to fix.
        // Copies, since the strip row's connection is set below.
        const shown = layout.widgets.filter((w) => !(w.toggle && !this._toggleOn(w.toggle)) && !(w.themes && w.themes.indexOf(this.themeName) < 0))
            .map((w) => (w.stripRow ? Object.assign({}, w) : w));
        this.shown = shown;              // for a scale to find its rev bar (driver camera wings)
        this._setNeeds(shown);
        // plan the layers first (a sheet's size is only known once every member is placed), then make them
        // in that order: within a class and z, cluster-render puts the newer layer on top. Small sheets
        // first; a bigger limit only when the layer budget needs it (see the header).
        const area = this.size[0] * this.size[1];
        const over = (p) => this._connCounts(p).some((k) => k > LAYER_BUDGET);
        // a layout's "packWaste" (the Nov 7 2026 themes): a widget joins a sheet only while the sheet's box stays within
        // that many times its members' own area, so far-apart readouts don't share one mostly empty sheet (pixel
        // memory); relaxed along with the size limit when the layer budget needs it. Without it: the size limit only.
        let waste = isNum(layout.packWaste) ? layout.packWaste : Infinity;
        // the strip row goes on the connection where it costs the fewest pixels without going over the layer budget
        const row = shown.filter((w) => w.stripRow);
        if (row.length) {
            let best = null;
            for (let ci = 0; ci < MAX_CONN; ci++) {
                row.forEach((w) => { w.conn = ci; });
                const p = this._plan(shown, Math.floor(area / SHEET_AREA_FRAC), waste);
                if (over(p)) continue;
                const px = p.reduce((a, e) => a + (e.kind === 'sheet' ? e.w * e.h : 0), 0), conns = this._connCounts(p).length;
                if (!best || px < best.px || (px === best.px && conns < best.conns)) best = { ci, px, conns };
            }
            if (!best) {
                // the layout alone is already over at the first size limit: the least used connection (a new one if one is left)
                const base = this._connCounts(this._plan(shown.filter((w) => !w.stripRow), Math.floor(area / SHEET_AREA_FRAC), waste));
                let ci = base.length < MAX_CONN ? base.length : 0;
                base.forEach((k, i) => { if (k < (ci < base.length ? base[ci] : 0)) ci = i; });
                best = { ci };
            }
            row.forEach((w) => { w.conn = best.ci; });
        }
        // the demo show's DEMO tag (demo_script.js), at a free spot that costs the fewest layers and pixels. It is in every
        // layout (drawn empty until the show plays), so pressing Play changes one small image and rebuilds nothing;
        // the calibration layouts only get it while the show plays (there it would cost a layer)
        if (this.demo && (this.demo.playing() || !CAL_LAYOUTS[name])) {
            const tag = DemoShow.tagWidget(this.target, shown, (l) => { const p = this._plan(l, Math.floor(area / SHEET_AREA_FRAC), waste); return { over: over(p), layers: p.length, px: p.reduce((a, e) => a + (e.kind === 'sheet' ? e.w * e.h : 0), 0) }; });
            if (tag) shown.push(tag);
        }
        // the holiday light string (garland.js): its own image layers on a connection with room for them
        const gk = this._garlandHoliday(name, shown);
        if (gk) {
            const gs = Garland.place(this.target, shown, { camera: this._cameraOn(), colors: hudHoliday.garland(gk, this.target, this.nightOn),
                cost: (l) => ({ counts: this._connCounts(this._plan(l, Math.floor(area / SHEET_AREA_FRAC), waste)) }) });
            gs.forEach((g) => shown.push(g));
            this.log.info('holiday lights (' + gk + '): ' + (gs.length ? gs.length + ' stretch' + (gs.length > 1 ? 'es' : '') + ', ' +
                gs.reduce((a, g) => a + g.g.bulbs.length, 0) + ' bulbs (' + gs.map((g) => g.w + 'x' + g.h + ' at ' + g.x + ',' + g.y + ' scale ' + g.g.s).join(', ') + ')' +
                ', connection ' + ((gs[0].conn || 0) + 1) : 'no room'));
        }
        let maxPx = Math.floor(area / SHEET_AREA_FRAC), plan = this._plan(shown, maxPx, waste);
        while (over(plan) && (maxPx !== Infinity || waste !== Infinity)) {
            maxPx = maxPx * 2 >= area ? Infinity : maxPx * 2;
            waste = waste * 2 > 64 ? Infinity : waste * 2;
            plan = this._plan(shown, maxPx, waste);
        }
        let effects = 0, own = 0, sheets = 0, bytes = 0, px = 0;
        plan.forEach((e) => {
            if (e.kind === 'sheet') { sheets++; bytes += e.w * e.h * 4; px += e.w * e.h * 8; this._guard('sheet ' + e.members[0].id, () => this._createSheet(e)); }
            else {
                if (IMAGE_TYPES[e.w.type]) { own++; px += e.w.w * e.w.h * 8; } else effects++;
                this._guard('widget ' + e.w.id, () => this._create(e.w, null));
            }
        });
        if (this._offset().x || this._offset().y || this._scale() !== 1) this._place();
        const atlasBytes = this._atlasBytes();
        px += atlasBytes;
        this.pixelBytes = px;
        const n = this._layerRefs().length, counts = this._connCounts(plan);
        this.log.info('layout "' + layout.name + '": ' + shown.length + ' widgets, ' + this._layerCount(n) + ' (' + effects + ' effects, ' +
            sheets + ' image sheets' + (own ? ', ' + own + ' own image layers' : '') + ')' +
            (counts.length > 1 ? ' on ' + counts.length + ' connections (' + counts.join(' + ') + ')' : '') + ', sheet limit ' +
            (maxPx === Infinity ? 'unlimited' : maxPx + ' px') + ', whole-sheet writes ' + bytes + ' bytes, pixel memory ' + mib(px) + ' of 16 MiB' +
            (atlasBytes ? ' (' + this.atlases.size + ' glyph atlas' + (this.atlases.size > 1 ? 'es' : '') + ' ' + mib(atlasBytes) + ')' : ''));
        counts.forEach((k, ci) => {
            if (k > LAYER_BUDGET) this.log.warn('layout "' + layout.name + '" needs ' + k + ' layers on connection ' + (ci + 1) + ', cluster-render draws at most ' + LAYER_BUDGET + ' per connection');
        });
        if (px > PIXEL_BYTES) this.log.warn('layout "' + layout.name + '" needs ' + mib(px) + ' of pixel memory; cluster-render has 16 MiB for every app together (each image counts twice)');
        this.statusAskT = setTimeout(() => { this.statusAskT = null; this._guard('status request', () => this.client.status()); }, STATUS_ASK_MS);
    }

    /**
     * The layers of a layout, in the order to make them: { kind: 'layer', w } for an effect or an "own"
     * image widget, { kind: 'sheet', klass, z, x, y, w, h, members } for a packed image layer. Widgets are
     * taken in file order; an image widget joins the first sheet of its (class, z) group that was opened
     * after every earlier entry of that group its rect intersects (so what overlaps it stays under it, as
     * file order says) and whose union box with it stays within maxPx pixels, else a new sheet is opened
     * at the end.
     */
    _plan(widgets, maxPx, waste) {
        if (!isNum(waste)) waste = Infinity;
        const plan = [];
        const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        const union = (s, w) => {
            const x = Math.min(s.x, w.x), y = Math.min(s.y, w.y);
            return { x, y, w: Math.max(s.x + s.w, w.x + w.w) - x, h: Math.max(s.y + s.h, w.y + w.h) - y };
        };
        widgets.forEach((w) => {
            const klass = w.class || 'content', z = w.z || 0, conn = this._connOf(w);
            if (!IMAGE_TYPES[w.type] || w.own === true || w.type === 'nav') { plan.push({ kind: 'layer', w, klass, z, conn }); return; }
            let after = -1;
            plan.forEach((e, i) => {
                if (e.klass !== klass || e.z !== z || e.conn !== conn) return;
                if (e.kind === 'layer' ? hit(e.w, w) : e.members.some((m) => hit(m, w))) after = i;
            });
            let sheet = null, box = null;
            for (let i = after + 1; i < plan.length && !sheet; i++) {
                const s = plan[i];
                if (s.kind !== 'sheet' || s.klass !== klass || s.z !== z || s.conn !== conn) continue;
                const u = union(s, w);
                const own = s.members.reduce((a, m) => a + m.w * m.h, 0) + w.w * w.h;
                // the strip row: one sheet a side of BMW's gear window, never shared with the rest (a sheet's box must not
                // reach over the window: car test Nov 14 2026, BMW blacks out its gear slot while its strip is covered)
                if (!s.members.every((m) => (m.stripRow || '') === (w.stripRow || ''))) continue;
                if (u.w * u.h <= maxPx && (u.w * u.h <= waste * own || w.stripRow)) { sheet = s; box = u; }
            }
            if (!sheet) { sheet = { kind: 'sheet', klass, z, conn, x: w.x, y: w.y, w: w.w, h: w.h, members: [], ref: 0, c: null, ci: conn, buf: null }; plan.push(sheet); }
            else { sheet.x = box.x; sheet.y = box.y; sheet.w = box.w; sheet.h = box.h; }
            sheet.members.push(w);
        });
        return plan;
    }

    /** One image layer for a sheet: every member painted into a local buffer, then sent whole once. */
    _createSheet(s) {
        const c = this._clientAt(s.conn);
        const ref = c.image({ target: this.target, klass: s.klass, z: s.z, x: s.x, y: s.y, w: s.w, h: s.h, iw: s.w, ih: s.h });
        if (!ref) { this.log.warn('sheet ' + s.klass + '/' + s.z + ' at ' + s.x + ',' + s.y + ' ' + s.w + 'x' + s.h + ': layer refused'); return; }
        s.ref = ref; s.c = c; s.ci = s.conn;
        this.placed.push({ c, ref, x: s.x, y: s.y, w: s.w, h: s.h });
        s.buf = Buffer.alloc(s.w * s.h * 4, 0);
        this.sheets.push(s);
        s.members.forEach((w) => this._guard('widget ' + w.id, () => this._create(w, s)));
        const buf = s.buf;
        s.buf = null;                    // from here on _blit sends dirty rects
        c.pixels(ref, null, buf);
    }

    /**
     * Every pixel painter goes through here: the widget's pixels (rects in the widget's own px, or null for
     * the whole widget) to its own layer, or into its sheet: the local buffer while the sheet is being
     * filled on create, else dirty rects translated by the sheet's offset.
     */
    _blit(x, rects, buf) {
        const w = x.w, s = x.sheet;
        if (!s) { x.c.pixels(x.ref, rects, buf); return; }
        const rs = rects && rects.length ? rects : [{ x: 0, y: 0, w: w.w, h: w.h }];
        const dx = w.x - s.x, dy = w.y - s.y;
        const moved = rs.map((r) => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }));
        if (!s.buf) { s.c.pixels(s.ref, moved, buf); return; }
        let off = 0;
        moved.forEach((r) => {
            for (let y = 0; y < r.h; y++) {
                buf.copy(s.buf, ((r.y + y) * s.w + r.x) * 4, off, off + r.w * 4);
                off += r.w * 4;
            }
        });
    }

    /**
     * A whole repaint of an image widget: the first time (or while its sheet is being filled) the whole widget
     * goes up; after that only the one rectangle around the pixels that changed, or nothing at all.
     */
    _blitDiff(x, buf) {
        const w = x.w, was = x.px;
        x.px = buf;
        if (!was || (x.sheet && x.sheet.buf)) { this._blit(x, null, buf); return; }
        const c = changes(was, buf, w.w, w.h);
        if (c) this._blit(x, [c.rect], c.px);
    }

    /** "key" is on while that bool setting is on; "!key" while it is off. */
    _toggleOn(t) {
        const not = t.charAt(0) === '!';
        const k = not ? t.slice(1) : t, eq = k.indexOf('=');
        const on = eq > 0 ? String(this.setting(k.slice(0, eq))) === k.slice(eq + 1) : this.setting(k) !== false;
        return not ? !on : on;
    }

    /** A widget: on its own layer (sheet null: an effect, or an image widget with "own": true), or a member of a sheet. */
    _create(w, sheet) {
        let ref, c;
        if (sheet) { ref = sheet.ref; c = sheet.c; }
        else {
            c = this._clientAt(this._connOf(w));
            const base = { target: this.target, klass: w.class || 'content', z: w.z || 0, x: w.x, y: w.y, w: w.w, h: w.h };
            if (IMAGE_TYPES[w.type]) ref = c.image(Object.assign({ iw: w.w, ih: w.h }, w.type === 'nav' ? this._navImage(w) : null, base));
            else ref = c.effect(Object.assign({ fs: w.type === 'swatch' ? calibration.SWATCH : shaders[w.type] }, base));
            if (!ref) { this.log.warn('widget "' + w.id + '": layer refused'); return; }
            this.placed.push({ c, ref, x: w.x, y: w.y, w: w.w, h: w.h });
        }
        const x = { w, ref, c, ci: sheet ? sheet.ci : this._connOf(w), sheet: sheet || null, last: null, lastPaint: 0, px: null };
        this.widgets.set(w.id, x);
        const t = this.theme;
        if (w.type === 'atext') {
            const a = this._atlas(w.font, x.ci);
            x.atlas = a;
            x.cells = Math.max(1, Math.min(32, isNum(w.cells) ? Math.floor(w.cells) : Math.floor(w.w / a.cellW)));
            c.bind(ref, 'u_font', a.ref);
            c.uniform(ref, 'u_cells', [x.cells]);
            c.uniform(ref, 'u_grid', [a.cols, a.rows]);
            c.uniform(ref, 'u_color', rgba(color(t, w.color || 'fg')));
            c.uniform(ref, 'u_text', this._atlasCodes(x, ''), { type: 'vec4' });
            if (w.w !== x.cells * a.cellW || w.h !== a.cellH) {
                this.log.info('widget "' + w.id + '": ' + x.cells + ' cells of ' + (w.w / x.cells).toFixed(1) + 'x' + w.h +
                    ' px; the glyphs keep their shape at w ' + x.cells * a.cellW + ', h ' + a.cellH);
            }
        } else if (w.type === 'gridlabels') this._paintGridLabels(x);
        else if (w.type === 'nav') this._navCreate(x);
        else if (w.type === 'garland') { x.tw = new Garland.Twinkle(w); this._blit(x, null, Garland.paint(w, x.tw.lvl, null)); }
        else if (w.type === 'icon') this._blit(x, null, paintIcon(w.icon, w.w, w.h, color(t, w.color || 'fg')));
        else if (w.type === 'sdash') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_geo', w.geo);
            c.uniform(ref, 'u_k', w.k);
            c.uniform(ref, 'u_w', [w.band]);
            c.uniform(ref, 'u_inner', [w.inner || w.band + 18]);
            c.uniform(ref, 'u_scale', w.scale || [w.geo[2], w.geo[0]]);
            c.uniform(ref, 'u_ticks', w.ticks);
            const [redFrom, orange] = this._redMarks(w.rpmMax || 8000);
            c.uniform(ref, 'u_redFrom', [redFrom]);
            c.uniform(ref, 'u_orange', [orange]);
            c.uniform(ref, 'u_fuelSeg', w.fuelSeg);
            c.uniform(ref, 'u_oilSeg', w.oilSeg);
            c.uniform(ref, 'u_hole', this._hole(w));
            c.uniform(ref, 'u_holeR', [this._holeRadius(w)]);
            c.uniform(ref, 'u_strip', w.strip);
            c.uniform(ref, 'u_topEnd', [w.topEnd]);
            c.uniform(ref, 'u_road', w.road ? [w.road[0], w.road[1], 0, 1] : [0, 1, 0, 0]);
        } else if (w.type === 'mview') {
            // the left scale's line: points (layer px) and the arc length at each (the shader mirrors it for the right)
            const pts = [], cum = [];
            let acc = 0;
            w.path.slice(0, 32).forEach((pt, i) => {
                if (i) acc += Math.hypot(pt[0] - w.path[i - 1][0], pt[1] - w.path[i - 1][1]);
                pts.push(pt[0] - w.x, pt[1] - w.y); cum.push(acc);
            });
            while (pts.length < 64) pts.push(0);
            while (cum.length < 32) cum.push(0);
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_path', pts, { type: 'vec2' });
            c.uniform(ref, 'u_cum', cum, { type: 'float' });
            c.uniform(ref, 'u_n', [Math.min(32, w.path.length)]);
            c.uniform(ref, 'u_scale', [w.scale[0], w.scale[1], 0, acc]);
            const us = this.setting('units') === 'us';
            c.uniform(ref, 'u_ticks', us ? [10, 2, 8, 2] : [11, 3, 8, 2]);   // a mark every 10 mph / 10 km/h; every 500 rpm
            const [redFrom, orange] = this._redMarks(MVIEW_RPM);
            c.uniform(ref, 'u_redFrom', [redFrom]);
            c.uniform(ref, 'u_orange', [orange]);
            c.uniform(ref, 'u_dial', [w.dial[0] - w.x, w.dial[1] - w.y, w.dial[2], 0]);
            c.uniform(ref, 'u_dialAng', w.dialAng);
            c.uniform(ref, 'u_line', [w.line[0] - w.x, w.line[1] - w.x, w.line[2] - w.y, w.line[3] - w.x]);
            c.uniform(ref, 'u_hole', this._hole(w));
            c.uniform(ref, 'u_holeR', [this._holeRadius(w)]);
            const pn = w.panel;     // [[top x, y], [middle x, y], [bottom x, y], inset]
            c.uniform(ref, 'u_panel', pn ? [pn[0][0] - w.x, pn[0][1] - w.y, pn[1][0] - w.x, pn[1][1] - w.y] : [0, 0, 0, 1]);
            c.uniform(ref, 'u_panelB', pn ? [pn[2][0] - w.x, pn[2][1] - w.y, pn[3], 0] : [0, 2, 0, 0]);
            c.uniform(ref, 'u_oval', [isNum(w.holeOval) ? w.holeOval : 0]);
        } else if (w.type === 'vdash') {
            // the bracket lines (target px): [x0, y0, x1, y1, width, brightness 0..1]
            const seg = [], segW = [];
            (w.segs || []).slice(0, 20).forEach((g) => {
                seg.push(g[0] - w.x, g[1] - w.y, g[2] - w.x, g[3] - w.y);
                segW.push(Math.max(1, Math.floor(g[4] || 2)) + Math.min(0.99, Math.max(0, isNum(g[5]) ? g[5] : 0.99)));
            });
            const nseg = segW.length;
            while (seg.length < 80) seg.push(0);
            while (segW.length < 20) segW.push(0);
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_seg', seg, { type: 'vec4' });
            c.uniform(ref, 'u_segW', segW, { type: 'float' });
            c.uniform(ref, 'u_nseg', [nseg]);
            const T = w.tach;      // [cx, cy, inner r, outer r, start deg, sweep deg, segments]
            c.uniform(ref, 'u_tach', [T[0] - w.x, T[1] - w.y, T[2], T[3]]);
            c.uniform(ref, 'u_redFrom', [this._redMarks(VDASH_RPM)[0]]);
            const rc = [];
            [0, 1, 2, 3].forEach((i) => { const g = (w.rings || [])[i]; rc.push.apply(rc, g && g.color ? g.color : [1, 1, 1]); });
            c.uniform(ref, 'u_ringC', rc, { type: 'vec3' });
            const pn = w.panel, vn = w.vinyl, pr = w.prog;
            c.uniform(ref, 'u_panel', pn ? [pn[0] - w.x, pn[1] - w.y, pn[2], pn[3]] : [0, 0, 0, 0]);
            x.vinyl = vn ? [vn[0] - w.x, vn[1] - w.y, vn[2]] : [0, 0, 0];
            x.prog = pr ? [pr[0] - w.x, pr[1] - w.y, pr[2]] : [0, 0, 0];
            c.uniform(ref, 'u_hole', this._hole(w));
            c.uniform(ref, 'u_holeC', [isNum(w.holeCut) ? w.holeCut : 40]);
        } else if (w.type === 'mdash') {
            const ty = w.tyres || [0, 0, 0], L = w.gaugeL || {}, R = w.gaugeR || {}, b = w.blade || {};
            const bars = Array.isArray(w.segbars) ? w.segbars.slice(0, 4) : [];
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_card', w.card || [0, 0, 0, 0]);
            c.uniform(ref, 'u_cardTop', w.cardTop || [0, 0, -99999]);
            c.uniform(ref, 'u_cardCutR', w.cardCutR || [0, 0, 0]);
            c.uniform(ref, 'u_cardFill', [isNum(w.cardFill) ? w.cardFill : 0]);
            c.uniform(ref, 'u_blade', [isNum(b.xm) ? b.xm - w.x : 99999, (b.ym || 0) - w.y, b.kTop || 0, b.kBot || 0]);
            c.uniform(ref, 'u_bladeB', [b.round || 40, isNum(w.bladeGap) ? w.bladeGap : 14]);
            c.uniform(ref, 'u_line', w.line || [0, -99, 0, 1]);
            c.uniform(ref, 'u_tyre', [ty[0] - w.x, ty[1] - w.y, ty[2] || 0]);
            c.uniform(ref, 'u_mark', w.mark && !this._cameraOn() ? w.mark : [0, 0, 0]);   // no M stripes where the driver camera sits
            c.uniform(ref, 'u_red', rgb(t.hot));
            [0, 1, 2, 3].forEach((i) => {
                const s = bars[i];
                c.uniform(ref, 'u_seg' + i, s ? [s.x - w.x, s.y - w.y, s.w, s.h] : [0, 0, 0, 0]);
            });
            c.uniform(ref, 'u_segMax', [0, 1, 2, 3].map((i) => (bars[i] && bars[i].max) || 1));
            c.uniform(ref, 'u_segSlant', [isNum(w.segSlant) ? w.segSlant : 9]);
            c.uniform(ref, 'u_hole', this._hole(w));
            c.uniform(ref, 'u_holeR', [this._holeRadius(w)]);
            x.gauges = [['u_gaugeL', L], ['u_gaugeR', R]];
            x.bars = bars;
        } else if (w.type === 'mtach') {
            const max = w.max || 8000, [redFrom, orange] = this._redMarks(max);
            const right = w.side === 'right';
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_side', [right ? 1 : -1]);
            c.uniform(ref, 'u_geoA', [w.y0 - w.y, w.y8 - w.y, w.ym - w.y, right ? w.x + w.w - w.xm : w.xm - w.x]);
            c.uniform(ref, 'u_geoB', [w.kTop, w.kBot, w.round || 40]);
            c.uniform(ref, 'u_wid', [w.wBot, w.wTop, w.wBend || 0]);
            c.uniform(ref, 'u_ticks', [max / 1000]);
            c.uniform(ref, 'u_orange', [orange]);
            c.uniform(ref, 'u_redFrom', [redFrom]);
            c.uniform(ref, 'u_red', rgb(t.hot));
        }
        else if (w.type === 'grid') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_step', [w.step || 50]);
            c.uniform(ref, 'u_major', [w.major || 2]);
            c.uniform(ref, 'u_minor', rgba([255, 255, 255, 90]));
            c.uniform(ref, 'u_majorC', rgba([0, 255, 140, 255]));
        } else if (w.type === 'stripe') this._paintStripe(x);
        else if (w.type === 'scale') this._paintScale(x);
        else if (w.type === 'shiftbar') {
            const max = this._barMax(), red = this.setting('redline');
            const midAt = t.bar.midAt === 'shift' ? (red - 1500) / max : t.bar.midAt;
            c.uniform(ref, 'u_size', [w.w, w.h]);
            const wg = this._wings(w);         // driver camera wings: half the segments on each side
            c.uniform(ref, 'u_segs', [wg ? Math.round((w.segments || 40) / 2) : w.segments || 40]);
            c.uniform(ref, 'u_skip', wg ? [wg.s, wg.e] : [0, 0]);
            c.uniform(ref, 'u_low', rgb(t.bar.low));
            c.uniform(ref, 'u_mid', rgb(t.bar.mid));
            c.uniform(ref, 'u_high', rgb(t.bar.high));
            c.uniform(ref, 'u_midAt', [midAt]);
            c.uniform(ref, 'u_highAt', [(red - 500) / max]);
            c.uniform(ref, 'u_track', rgba(t.track));
            c.uniform(ref, 'u_flash', [0]);
        } else if (w.type === 'gmeter') {
            // 14 uniform vectors (shaders.js gmeter): u_geo [w, h, range, step] and u_dot [x, y, trail points, envelope
            // on] go from the update below; the dot's amber [255, 176, 40] and its 0.5 / 0.8 g marks are constants in the shader;
            // the envelope is the R8 asset _gEnvAsset() bound to u_env
            const L = color(t, w.line || 'dim');
            c.uniform(ref, 'u_line', rgba([L[0], L[1], L[2], isNum(w.lineAlpha) ? w.lineAlpha : 150]));
            c.uniform(ref, 'u_c1', rgb(color(t, w.dot || 'fg')));
            c.uniform(ref, 'u_c3', rgb(t.hot));
            c.uniform(ref, 'u_envC', rgb(color(t, w.envColor || 'fg')));
            c.uniform(ref, 'u_trail', new Array(32).fill(0), { type: 'vec4' });
            x.gEnv = this._gEnvAsset(x);
            if (x.gEnv) c.bind(ref, 'u_env', x.gEnv);
        } else if (w.type === 'revarc') {
            const max = this._barMax(), red = this.setting('redline');
            const midAt = t.bar.midAt === 'shift' ? (red - 1500) / max : t.bar.midAt;
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_center', w.center);
            c.uniform(ref, 'u_r', [w.r]);
            c.uniform(ref, 'u_w', [w.band || 40]);
            c.uniform(ref, 'u_start', [w.start * Math.PI / 180]);
            c.uniform(ref, 'u_sweep', [w.sweep * Math.PI / 180]);
            const wa = this._arcWing(w);       // driver camera wings: half the segments on each side
            c.uniform(ref, 'u_segs', [wa ? Math.round((w.segments || 30) / 2) : w.segments || 30]);
            c.uniform(ref, 'u_wing', [wa]);
            c.uniform(ref, 'u_low', rgb(t.bar.low));
            c.uniform(ref, 'u_mid', rgb(t.bar.mid));
            c.uniform(ref, 'u_high', rgb(t.bar.high));
            c.uniform(ref, 'u_midAt', [midAt]);
            c.uniform(ref, 'u_highAt', [(red - 500) / max]);
            c.uniform(ref, 'u_track', rgba(t.track));
            c.uniform(ref, 'u_flash', [0]);
            c.uniform(ref, 'u_value', [0]);
        } else if (w.type === 'meter') {
            const cs = w.colors || ['fg', 'fg', 'hot'];
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_segs', [w.segments || 20]);
            c.uniform(ref, 'u_gap', [isNum(w.gap) ? w.gap : 4]);
            c.uniform(ref, 'u_vertical', [w.vertical ? 1 : 0]);
            c.uniform(ref, 'u_c1', rgb(color(t, cs[0])));
            c.uniform(ref, 'u_c2', rgb(color(t, cs[1] || cs[0])));
            c.uniform(ref, 'u_c3', rgb(color(t, cs[2] || cs[1] || cs[0])));
            c.uniform(ref, 'u_at', w.at || [1, 1]);
            c.uniform(ref, 'u_track', rgba(color(t, w.trackColor || 'track')));
            c.uniform(ref, 'u_peak', [-1]);
            c.uniform(ref, 'u_peakC', rgb(color(t, w.peakColor || 'fg')));
        } else if (w.type === 'arc') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_peak', [-1]);
            c.uniform(ref, 'u_peakC', rgb(color(t, w.peakColor || 'fg')));
            c.uniform(ref, 'u_color', rgb(color(t, w.color || 'arc')));
            c.uniform(ref, 'u_track', rgba(t.track));
            c.uniform(ref, 'u_width', [w.width || 7]);
            c.uniform(ref, 'u_start', [(w.start === undefined ? 225 : w.start) * Math.PI / 180]);
            c.uniform(ref, 'u_sweep', [(w.sweep === undefined ? 270 : w.sweep) * Math.PI / 180]);
        } else if (w.type === 'segbar') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_segs', [w.max]);
            c.uniform(ref, 'u_on', rgba(color(t, w.color || 'hot')));
            c.uniform(ref, 'u_offC', rgba(color(t, 'track')));
            c.uniform(ref, 'u_slant', [w.slant || 0]);
        } else if (w.type === 'revbar') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_top', [w.top || 8]);
            c.uniform(ref, 'u_barH', [w.barH]);
            c.uniform(ref, 'u_slant', [w.slant || 12]);
            c.uniform(ref, 'u_max', [this._barMax(w)]);
            c.uniform(ref, 'u_red', [this.setting('redline')]);
            c.uniform(ref, 'u_from', rgb(t.rev.from));
            c.uniform(ref, 'u_to', rgb(t.rev.to));
            c.uniform(ref, 'u_hot', rgb(t.hot));
            c.uniform(ref, 'u_track', rgba(t.track));
            c.uniform(ref, 'u_tick', rgba(t.dim));
            c.uniform(ref, 'u_fg', rgba(t.fg));
        } else if (w.type === 'lights') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            // driver camera wings: half the lights (and the blue tail) on each side, filling in towards the camera
            const wg = this._wings(w), n = w.count || 12;
            c.uniform(ref, 'u_n', [wg ? Math.ceil(n / 2) : n]);
            c.uniform(ref, 'u_tail', [wg ? Math.ceil((w.tail || 0) / 2) : w.tail || 0]);
            c.uniform(ref, 'u_skip', wg ? [wg.s, wg.e] : [0, 0]);
            // a holiday string of bulbs (hud_holiday.js "lightBulbs" [red, green, gold, blue]): u_round 2 = round lights in
            // those colours in turn, through the same four colour uniforms
            const B = t.lightBulbs;
            c.uniform(ref, 'u_round', [B ? 2 : w.round ? 1 : 0]);
            c.uniform(ref, 'u_green', rgb(B ? B[1] : LIGHTS.green));
            c.uniform(ref, 'u_yellow', rgb(B ? B[2] : LIGHTS.yellow));
            c.uniform(ref, 'u_red', rgb(B ? B[0] : LIGHTS.red));
            c.uniform(ref, 'u_blue', rgb(B ? B[3] : LIGHTS.blue));
            c.uniform(ref, 'u_off', [w.off === undefined ? 0.14 : w.off]);
        } else if (w.type === 'ribbon') {
            const R = t.ribbon || { stops: [t.fg, t.fg, t.fg, t.hot, t.hot], at: [0.5, 0.8, 0.9, 1] };
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_org', [w.x, w.y]);
            c.uniform(ref, 'u_curve', w.curve.concat([this._cameraOn() ? w.dip || 0 : 0]));
            c.uniform(ref, 'u_span', w.span);
            [0, 1, 2, 3, 4].forEach((i) => c.uniform(ref, 'u_c' + i, rgb(R.stops[i])));
            c.uniform(ref, 'u_at', R.at);
            c.uniform(ref, 'u_track', rgba(t.track));
            c.uniform(ref, 'u_dot', rgb(t.dim));
            c.uniform(ref, 'u_red', rgb(t.hot));
            c.uniform(ref, 'u_wire', rgb(t.wire || t.dim));
            c.uniform(ref, 'u_n', [this._barMax() / 1000]);
            c.uniform(ref, 'u_bulbs', [t.bulbs ? 1 : 0]);
            c.uniform(ref, 'u_value', [0]);
            c.uniform(ref, 'u_flash', [0]);
        } else if (w.type === 'deco') {
            const D = t.decoColors || [t.accent, t.fg, t.dim], keep = (w.keep || []).slice(0, 4);
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_mode', [t.deco || 0]);
            c.uniform(ref, 'u_bg', rgba(color(t, w.color || 'bg')));
            c.uniform(ref, 'u_a', rgb(D[0]));
            c.uniform(ref, 'u_b', rgb(D[1]));
            c.uniform(ref, 'u_c', rgb(D[2]));
            c.uniform(ref, 'u_pill', w.pill ? [w.pill[0] - w.x, w.pill[1] - w.y, w.pill[2], w.pill[3]] : [0, 0, 0, 0]);
            c.uniform(ref, 'u_pc', rgb(color(t, 'accent')));
            [0, 1, 2, 3].forEach((i) => {
                const k = keep[i];
                c.uniform(ref, 'u_k' + i, k ? [k[0] - w.x, k[1] - w.y, k[2] - w.x, k[3] - w.y] : [0, 0, 0, 0]);
            });
        } else if (w.type === 'fill') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_color', rgba(color(t, w.color || 'bg')));
            c.uniform(ref, 'u_hole', this._hole(w));
            c.uniform(ref, 'u_holeR', [this._holeRadius(w)]);
        } else if (w.type === 'box') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_fill', rgba(color(t, w.fill || 'panel')));
            c.uniform(ref, 'u_line', rgba(color(t, w.line || 'line')));
            c.uniform(ref, 'u_head', rgba(color(t, w.headColor || 'head')));
            c.uniform(ref, 'u_headH', [w.head || 0]);
            c.uniform(ref, 'u_border', [w.border === undefined ? 2 : w.border]);
            c.uniform(ref, 'u_radius', [w.radius || 0]);
        } else if (w.type === 'swatch') {
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_n', [w.steps || 11]);
        } else if (w.type === 'swatchimg') this._blit(x, null, calibration.swatchImage(w.w, w.h, w.steps || 11));
        else if (w.type === 'boxes') {
            // the box list goes up as two vec4 arrays (x, y, w, h and headH, border, radius, headKind), 12 slots
            const list = (Array.isArray(w.boxes) ? w.boxes : []).filter((b) => b && isNum(b.x) && isNum(b.y) && isNum(b.w) && isNum(b.h)
                && !(b.toggle && !this._toggleOn(b.toggle))).slice(0, 12);
            const rects = [], styles = [];
            for (let i = 0; i < 12; i++) {
                const b = list[i];
                rects.push(b ? b.x - w.x : 0, b ? b.y - w.y : 0, b ? b.w : 0, b ? b.h : 0);
                styles.push(b ? b.head || 0 : 0, b ? (b.border === undefined ? 2 : b.border) : 0, b ? b.radius || 0 : 0, b && b.headColor === 'accent' ? 1 : 0);
            }
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_bg', rgba(color(t, w.color || 'bg')));
            c.uniform(ref, 'u_hole', this._hole(w));
            c.uniform(ref, 'u_holeR', [this._holeRadius(w)]);
            c.uniform(ref, 'u_n', [list.length]);
            c.uniform(ref, 'u_box', rects, { type: 'vec4' });
            c.uniform(ref, 'u_boxStyle', styles, { type: 'vec4' });
            c.uniform(ref, 'u_fill', rgba(color(t, w.fill || 'panel')));
            c.uniform(ref, 'u_line', rgba(color(t, w.line || 'line')));
            c.uniform(ref, 'u_head', rgba(color(t, w.head || 'head')));
            c.uniform(ref, 'u_accent', rgba(color(t, w.accent || 'accent')));
        } else if (w.type === 'tiles') {
            const list = this._tiles(w), rects = [];
            for (let i = 0; i < TILE_MAX; i++) {
                const b = list[i];
                rects.push(b ? b.x - w.x : 0, b ? b.y - w.y : 0, b ? b.w : 0, b ? b.h : 0);
            }
            const zc = w.colors || ['bar1', 'bar2', 'hot'];
            c.uniform(ref, 'u_size', [w.w, w.h]);
            c.uniform(ref, 'u_bg', rgba(color(t, w.color || 'bg')));
            c.uniform(ref, 'u_n', [list.length]);
            c.uniform(ref, 'u_tile', rects, { type: 'vec4' });
            c.uniform(ref, 'u_geo', [isNum(w.radius) ? w.radius : 8, isNum(w.border) ? w.border : 1.5, isNum(w.strip) ? w.strip : 3, w.barH || 6]);
            c.uniform(ref, 'u_fill', rgba(color(t, w.fill || 'panel')));
            c.uniform(ref, 'u_warn', rgba(color(t, w.warn || 'warn')));
            c.uniform(ref, 'u_line', rgba(color(t, w.line || 'line')));
            c.uniform(ref, 'u_track', rgba(color(t, w.trackColor || 'track')));
            c.uniform(ref, 'u_accent', rgb(color(t, w.accent || 'accent')));
            c.uniform(ref, 'u_c1', rgb(color(t, zc[0])));
            c.uniform(ref, 'u_c2', rgb(color(t, zc[1] || zc[0])));
            c.uniform(ref, 'u_c3', rgb(color(t, zc[2] || zc[1] || zc[0])));
            c.uniform(ref, 'u_at', w.at || [0.6, 0.85]);
        }
        this._update(x, Date.now(), true);
    }

    /** A tiles widget's tiles in use: [{ x, y, w, h, slot, bar }], the ones with a valid rect, toggles on, TILE_MAX at most. */
    _tiles(w) {
        return (Array.isArray(w.tiles) ? w.tiles : []).filter((b) => b && isNum(b.x) && isNum(b.y) && isNum(b.w) && isNum(b.h)
            && !(b.toggle && !this._toggleOn(b.toggle))).slice(0, TILE_MAX);
    }

    /** A widget's map hole in layer px, inset by "holeInset" (6) a side, while "holeWhen" is on; else no hole. */
    _hole(w) {
        const on = w.holeWhen === true || (w.holeWhen && this.setting(w.holeWhen) === true);   // true: always cut
        const h = w.hole && on ? w.hole : null;
        if (!h) return [0, 0, 0, 0];
        const inset = isNum(w.holeInset) ? w.holeInset : 6;
        return [h[0] + inset - w.x, h[1] + inset - w.y, Math.max(0, h[2] - 2 * inset), Math.max(0, h[3] - 2 * inset)];
    }

    _holeRadius(w) { return isNum(w.holeRadius) ? w.holeRadius : 28; }

    /**
     * Now playing from HmiMediaState: playerMetadata (two lines, each tagged TITLE / ARTIST / ALBUM, or three rows)
     * and trackProgress (elapsed, total). Only the front screen's (sink FRONT). The first few values are logged, so a
     * car's log shows what it really sends (the time unit, which source fills it).
     */
    _mediaFeed(kind, v) {
        if (!v || typeof v !== 'object') return;
        if (v.sink !== undefined && v.sink !== 0 && v.sink !== 'FRONT') return;
        const m = this.media || (this.media = { title: '', artist: '', elapsed: 0, total: 0, at: 0, moved: 0 });
        this.mediaLogged = (this.mediaLogged || 0) + 1;
        if (this.mediaLogged <= 6) this.log.info('media ' + kind + ': ' + JSON.stringify(v).slice(0, 300));
        if (kind === 'meta') {
            const type = (t) => MEDIA_TYPES[t] || String(t || '').toUpperCase();
            const lines = [[mediaText(v.firstLineText), type(v.firstLineType)], [mediaText(v.secondLineText), type(v.secondLineType)]];
            let title = '', artist = '';
            lines.forEach(([t, k]) => { if (!t) return; if (k === 'TITLE' && !title) title = t; else if (k === 'ARTIST' && !artist) artist = t; });
            if (!title) title = (lines.find(([t, k]) => t && k !== 'ARTIST' && t !== artist) || [''])[0];
            if (!artist) artist = (lines.find(([t]) => t && t !== title) || [''])[0];
            if (!title && v.threeRowText) {
                const rows = String(v.threeRowText).split(/[\r\n]+/).map(mediaText).filter(Boolean);
                title = rows[0] || ''; artist = rows[1] || '';
            }
            if (title !== m.title || artist !== m.artist) { m.elapsed = 0; m.total = 0; m.moved = 0; }
            m.title = title; m.artist = artist;
        } else {
            const e = Number(v.elapsed), t = Number(v.total);
            if (!isFinite(e) || !isFinite(t) || v.hasProgress === false) { m.total = 0; return; }
            // milliseconds or seconds: a track over ~3 hours in seconds is unlikely, so a big total is ms
            const k = t > 10800 ? 1000 : 1;
            if (e / k !== m.elapsed) m.moved = Date.now();
            m.elapsed = e / k; m.total = t / k; m.at = Date.now();
        }
    }

    /** Something is playing that has a title (the music panel shows it; "showWhen": "media"). */
    _mediaOn() { return !!(this.media && this.media.title); }

    /** The track's elapsed seconds now: carried on from the last value while it was still moving (playing). */
    _mediaElapsed() {
        const m = this.media;
        if (!m || !m.total) return null;
        const run = Date.now() - m.moved < 2500 ? (Date.now() - m.at) / 1000 : 0;
        return Math.min(m.total, m.elapsed + run);
    }

    /** "showWhen": "media" / "!media" (the music panel or what shows instead), "mapUp" / "!mapUp": empty otherwise. */
    _shownNow(w) {
        const sw = w.showWhen;
        if (sw === 'media') return this._mediaOn();
        if (sw === '!media') return !this._mediaOn();
        if (sw === 'mapUp') return this.setting('mapUp') === true;
        if (sw === '!mapUp') return this.setting('mapUp') !== true;
        return true;
    }

    /**
     * A "mapLive" layout's map window, opened or closed as the Waze map comes or goes: only its own layers' u_hole changes
     * (no widget of it toggles on mapUp), so the theme stays up instead of being built again (seconds on the car).
     */
    _mapLive() {
        this.mapShown = this.setting('mapUp');
        this.widgets.forEach((x) => { if (!x.sheet && x.c && x.w.holeWhen === 'mapUp') x.c.uniform(x.ref, 'u_hole', this._hole(x.w)); });
        this._status();
    }

    _tick() {
        const now = Date.now();
        this._smoothRpm(now);
        this._cueTick(now);
        if (now - (this.bumpAt || 0) >= 1000) { this.bumpAt = now; smartTemps.bumpTick(this); }
        // the 0-60 timer only on the car's own data (the demo drive would set a best time)
        if (!this.car.data().demo) this.runs.update(this.car.data().speed, now, this.setting('units') === 'us' ? 'us' : 'metric');
        this._trip(now);
        this._gTick(now);
        const b = this._boost();
        if (isNum(b) && (!isNum(this.boostPeak) || b > this.boostPeak)) this.boostPeak = b;
        if (!this.client.ready) return;
        // shift light: blink the whole bar at 8 Hz once the rpm reaches the redline
        const rpm = this._raw('rpm');
        const flashing = isNum(rpm) && rpm >= this.setting('redline') - 150;
        this.flash = flashing ? Math.floor(now / 62.5) % 2 === 0 : false;
        // the count-in's latched flash: the shift bars and arcs flash with it at 5 Hz (shift_cue.js)
        if (!flashing && this._countIn() && this.cue.now.shift) this.flash = this.cue.blink(now);
        this.widgets.forEach((x) => this._guard('widget ' + x.w.id, () => this._update(x, now, false)));
    }

    /** This drive's distance and moving time (the car's own data only; standing still doesn't count). */
    _trip(now) {
        const d = this.car.data(), dt = this.tripT ? Math.min(1000, now - this.tripT) : 0;
        this.tripT = now;
        if (d.demo || !isNum(d.speed) || d.speed < 2) return;
        this.tripKm += d.speed * dt / 3600000;
        this.tripMs += dt;
    }

    /** km/h: the average moving speed this drive, from the first minute on (null before it, 54 on the demo). */
    _avgSpeed() {
        if (this.car.data().demo) return 54;
        return this.tripMs >= 60000 ? this.tripKm / (this.tripMs / 3600000) : null;
    }

    /** BMW-like tach: a 120 ms filter, and a readout that moves in 50 rpm steps, only by 40 rpm or more. */
    _smoothRpm(now) {
        const test = this._testRpm(now);
        const raw = isNum(test) ? test : this.car.data().rpm;
        const dt = this.lastTickT ? Math.min(500, now - this.lastTickT) : 0;
        this.lastTickT = now;
        if (!isNum(raw)) { this.rpmF = null; this.rpmShown = null; return; }
        this.rpmF = isNum(this.rpmF) ? this.rpmF + (raw - this.rpmF) * (1 - Math.exp(-dt / 120)) : raw;
        if (!isNum(this.rpmShown) || Math.abs(this.rpmF - this.rpmShown) >= 40) this.rpmShown = Math.max(0, Math.round(this.rpmF / 50) * 50);
    }

    _update(x, now, force) {
        const w = x.w;
        if (w.type === 'atext') {
            if (!force && now - x.lastPaint < (w.rate || TEXT_MS)) return;
            const s = this._resolve(w.text);
            if (!force && s === x.last) return;
            x.last = s; x.lastPaint = now;
            x.c.uniform(x.ref, 'u_text', this._atlasCodes(x, s), { type: 'vec4' });
        } else if (w.type === 'nav') this._navUpdate(x, now, force);
        else if (w.type === 'garland') this._garlandTick(x, now);
        else if (w.type === 'text') {
            if (!force && now - x.lastPaint < (w.rate || TEXT_MS)) return;
            let s = (w.navHide && this.navShown) || smartTemps.hidden(this, w) || !this._shownNow(w) ? '' : this._resolve(w.text);   // nav turn showing / "showWhen"
            let role = w.color || 'fg';
            if (w.colorBy === 'verdict' && this.score.last) role = VERDICT[this.score.last.verdict] || role;
            if (w.near && this._nearMark(w.near[0]) === w.near[1]) role = w.nearColor || 'fg';
            // a readout slot goes red / blue at the shift point only while it shows engine speed or the shift point
            const shiftish = !w.slot || ['rpm', 'shiftAt'].indexOf((this.slotSensor(this.activeName, w.slot, this.layoutSlots) || {}).id) >= 0;
            if ((w.hotWhen || w.coldWhen) && shiftish) {
                const sp = this._shift();
                if (w.coldWhen && sp[w.coldWhen]) role = VERDICT.COLD;
                if (w.hotWhen && sp[w.hotWhen]) role = 'hot';
            }
            role = smartTemps.role(this, w, role);       // temperature bands (cold, warming, hot), outside ice
            // over its warning limit: the value flashes in the shift red
            // ("warnFlash": false: not on a tile that turns red itself, the Dyno theme's)
            if (w.warnFlash !== false && this._warning(w) && Math.floor(now / WARN_FLASH_MS) % 2 === 0) role = 'hot';
            const key = s + '|' + role;
            if (!force && key === x.last) return;
            x.last = key; x.lastPaint = now;
            // "fit": smaller fonts to fall back on when the text is wider than the box (a readout slot showing a
            // longer value than its default) or has a character the font lacks (Retro's seven-segment digits have no
            // letters, + or °), on the same baseline
            let font = w.font, offsetY = 0;
            // "ellipsis": a longer text (a song title) is cut to fit, ending in ...
            if (w.ellipsis && textRaster.measure(s, font, w.spacing) > w.w) {
                let t = s;
                while (t.length > 1 && textRaster.measure(t.replace(/\s+$/, '') + '...', font, w.spacing) > w.w) t = t.slice(0, -1);
                s = t.replace(/\s+$/, '') + '...';
            }
            const has = (n) => { const g = textRaster.loadFont(n).metrics.glyphs; return s.split('').every((ch) => ch === ' ' || g[ch]); };
            if (w.fit && (textRaster.measure(s, font, w.spacing) > w.w || !has(font))) {
                const f = w.fit.find((n) => has(n) && textRaster.measure(s, n, w.spacing) <= w.w) || w.fit[w.fit.length - 1];
                offsetY = textRaster.loadFont(w.font).metrics.baseline - textRaster.loadFont(f).metrics.baseline;
                font = f;
            }
            const buf = textRaster.drawText(w.w, w.h, s, {
                font, offsetY, color: color(this.theme, role), align: w.align, spacing: w.spacing,
                color2: w.color2 && role !== 'hot' ? color(this.theme, w.color2) : null,
                glow: w.glow ? this.theme.glow : 0,
            });
            this._blitDiff(x, buf);
        } else if (w.type === 'badge') {
            if (!force && now - x.lastPaint < TEXT_MS) return;
            const s = (w.navHide && this.navShown) || (w.tone === 'demo' && !(this.demo && this.demo.playing())) ? '' : this._resolve(w.text);
            let tone = VERDICT.COLD, fresh = false;
            if (w.tone === 'demo') { tone = DEMO_AMBER; fresh = true; }  // the demo show's DEMO tag
            if (w.tone === 'verdict' && this.score.last) {
                tone = VERDICT[this.score.last.verdict] || this.theme.fg;
                fresh = now - this.score.last.at < 2500;
            }
            const key = s + '|' + tone + '|' + fresh;
            if (!force && key === x.last) return;
            x.last = key; x.lastPaint = now;
            this._blitDiff(x, this._paintBadge(w, s, tone, fresh));
        } else if (w.type === 'tiles') {
            // per tile: its bar (the slot's sensor, TILE_BAR) and whether that reading is over its warning limit
            const list = this._tiles(w), vals = [];
            let key = '';
            for (let i = 0; i < TILE_MAX; i++) {
                const b = list[i];
                let v = -1, warn = 0, z = 0;
                if (b) {
                    const sn = b.slot ? this.slotSensor(this.activeName, b.slot, this.layoutSlots) : null;
                    const bar = sn && b.bar !== false ? TILE_BAR[sn.id] : null;
                    if (bar) {
                        let raw = this._raw(bar.raw);
                        if (bar.abs && isNum(raw)) raw = Math.abs(raw);
                        const max = bar.max === 'rpm' ? this._barMax() : bar.max;
                        v = isNum(raw) ? Math.round(Math.min(1, Math.max(0, (raw - bar.min) / (max - bar.min))) * 200) / 200 : 0;
                        z = bar.z ? 1 : 0;
                    }
                    warn = sn && this._overLimit(sn.id) ? 1 : 0;
                }
                vals.push(v, warn, z, 0);
                key += v + ',' + warn + ',' + z + ';';
            }
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_tileV', vals, { type: 'vec4' });
        } else if (w.type === 'gmeter') {
            // the car's lateral g is + turning left, longitudinal + speeding up (G-Force's labels). Drawn as G-Force
            // draws it: the dot moves the way the car accelerates, into the turn and up when speeding up (the shader
            // draws + x right, + y down). The settings "gFlipLat" / "gFlipLong" swap left / right and accel / brake;
            // a layout's "flipX" / "flipY" swap again on top
            // range and envelope go only when they change; the trail with every move of the dot (its first point)
            const S = this._gSigns(w), gx = this._raw('gLat'), gy = this._raw('gLong');
            const q = (v) => Math.round(v * 50) / 50;
            const qx = isNum(gx) ? q(S[0] * gx) : 0, qy = isNum(gy) ? q(S[1] * gy) : 0;
            const max = this._gRange(w), step = max > 1.2 ? 0.5 : 0.25;
            const envKey = this.gEnvAt + '|' + S.join(',') + '|' + max;
            const tr = this.gTrail, trKey = tr.length ? qx + ',' + qy + '|' + tr[0][0] + '|' + tr.length + '|' + S.join(',') : 'none';
            const key = qx + '|' + qy + '|' + max + '|' + envKey + '|' + trKey;
            if (!force && key === x.last) return;
            x.last = key;
            const n = tr.length ? tr.length + 1 : 0;
            x.c.uniform(x.ref, 'u_dot', [qx, qy, n, x.w.envelope === false ? 0 : 1]);
            if (force || x.gMax !== max) { x.gMax = max; x.c.uniform(x.ref, 'u_geo', [x.w.w, x.w.h, max, step]); }
            if ((force || x.gEnvKey !== envKey) && x.gEnv) {
                // one byte a sector: its radius capped at the range, / the range (under 0.2 px off on a 210 px meter)
                x.gEnvKey = envKey;
                const env = this._gEnvDrawn(S), px = Buffer.alloc(G_ENV_TEX, 0);
                for (let m = 0; m < G_SECTORS; m++) px[m] = Math.round(Math.min(1, Math.max(0, (env[m] || 0) / max)) * 255);
                x.c.pixels(x.gEnv, null, px);
            }
            if (force || x.gTrKey !== trKey) {
                // point 0 is the dot itself, so the trail joins it; then the samples, newest first
                x.gTrKey = trKey;
                const pts = [qx, qy];
                tr.forEach((p) => pts.push(q(S[0] * p[1]), q(S[1] * p[2])));
                while (pts.length < 32) pts.push(0);
                x.c.uniform(x.ref, 'u_trail', pts, { type: 'vec4' });
            }
        } else if (w.type === 'ribbon') {
            const rpm = this._raw('rpm');
            const v = isNum(rpm) ? Math.min(1, Math.max(0, rpm / this._barMax())) : 0;
            const q = Math.round(v * 400) / 400;                    // 400 steps along the line: smooth, few messages
            const key = q + (this.flash ? 'f' : '');
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_value', [q]);
            x.c.uniform(x.ref, 'u_flash', [this.flash ? 1 : 0]);
        } else if (w.type === 'shiftbar' || w.type === 'revarc') {
            const rpm = this._raw('rpm');
            const segs = w.segments || (w.type === 'revarc' ? 30 : 40);
            const v = isNum(rpm) ? Math.min(1, Math.max(0, rpm / this._barMax())) : 0;
            const q = Math.round(v * segs * 2) / (segs * 2);        // only resend on half-segment steps
            const key = q + (this.flash ? 'f' : '');
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_value', [q]);
            x.c.uniform(x.ref, 'u_flash', [this.flash ? 1 : 0]);
        } else if (w.type === 'arc' || w.type === 'meter') {
            // a meter with a "slot" (Dyno) shows the bar of whatever sensor that readout slot shows (TILE_BAR)
            let sig = w.signal, mn = w.min, mx = w.max, ab = false;
            if (w.slot) {
                const sn = this.slotSensor(this.activeName, w.slot, this.layoutSlots);
                const bar = sn ? TILE_BAR[sn.id] : null;
                sig = bar ? bar.raw : null; mn = bar ? bar.min : 0; mx = bar ? (bar.max === 'rpm' ? this._barMax() : bar.max) : 1; ab = !!(bar && bar.abs);
            }
            let raw = sig ? this._raw(sig) : null;
            if (ab && isNum(raw)) raw = Math.abs(raw);
            const v = isNum(raw) && mx !== mn ? Math.min(1, Math.max(0, (raw - mn) / (mx - mn))) : 0;
            const q = Math.round(v * 200) / 200;
            const pk = w.peak ? this._peakHold(x, q, now, w.peak) : -1;
            const key = q + '|' + pk;
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_value', [q]);
            if (w.peak) x.c.uniform(x.ref, 'u_peak', [pk > q ? pk : -1]);
        } else if (w.type === 'sdash') {
            const us = this.setting('units') === 'us';
            const sp = this._raw('speed'), rpm = this._raw('rpm'), fuel = this._raw('fuel'), oil = this._raw('oil');
            const q = (v) => Math.round(Math.min(1, Math.max(0, v)) * 500) / 500;
            const vals = [
                q(isNum(sp) ? scaleFrac(us ? sp * 0.621371 : sp, SPEED_SCALE[us ? 'us' : 'metric']) : 0),
                q(isNum(rpm) ? rpm / (w.rpmMax || 8000) : 0),
                q(isNum(fuel) ? fuel : 0),
                q(isNum(oil) ? (oil - 50) / 100 : 0),
            ];
            // the road's dashes: one dash and gap per ROAD_DASH_M metres driven, 1/64 steps (so standing still writes nothing)
            if (w.road) {
                const now = Date.now(), dt = x.roadT ? Math.min(1, (now - x.roadT) / 1000) : 0;
                x.roadT = now;
                x.roadPhase = ((x.roadPhase || 0) + (isNum(sp) ? Math.max(0, sp) / 3.6 : 0) * dt / ROAD_DASH_M) % 1;
                vals.push(Math.round(x.roadPhase * 64) / 64);
            }
            const key = vals.join('|');
            if (!force && key === x.last) return;
            x.last = key;
            if (w.road) x.c.uniform(x.ref, 'u_road', [w.road[0], w.road[1], vals[4], 1]);
            x.c.uniform(x.ref, 'u_speed', [vals[0]]);
            x.c.uniform(x.ref, 'u_rpm', [vals[1]]);
            x.c.uniform(x.ref, 'u_fuel', [vals[2]]);
            x.c.uniform(x.ref, 'u_oil', [vals[3]]);
        } else if (w.type === 'vdash') {
            const T = w.tach, q = (v) => Math.round(Math.min(1, Math.max(0, v)) * 400) / 400;
            const frac = (g) => { const v = g && g.signal ? this._raw(g.signal) : null; return isNum(v) ? q((v - g.min) / (g.max - g.min)) : 0; };
            const rpm = this._raw('rpm');
            const rings = [0, 1, 2, 3].map((i) => (w.rings || [])[i]), bars = [0, 1, 2].map((i) => (w.bars || [])[i]);
            const rv = rings.map(frac), bv = bars.map(frac);
            const on = this._mediaOn() ? 1 : 0, e = this._mediaElapsed();
            const pv = on && e !== null && this.media.total > 0 ? q(e / this.media.total) : 0;
            const key = [isNum(rpm) ? q(rpm / VDASH_RPM) : 0].concat(rv, bv, [on, pv, this.setting('mapUp') ? 1 : 0]).join('|');
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_tachA', [T[4], T[5], T[6], isNum(rpm) ? q(rpm / VDASH_RPM) : 0]);
            const ru = [], bu = [];
            rings.forEach((g, i) => ru.push(g ? g.cx - w.x : 0, g ? g.cy - w.y : 0, g ? g.r : 0, rv[i]));
            // the bars sit under the map window: gone while the map shows
            const mapUp = this.setting('mapUp') === true;
            bars.forEach((b, i) => bu.push(b ? b.x - w.x : 0, b ? b.y - w.y : 0, b && !mapUp ? b.w : 0, bv[i]));
            x.c.uniform(x.ref, 'u_ring', ru, { type: 'vec4' });
            x.c.uniform(x.ref, 'u_bar', bu, { type: 'vec4' });
            x.c.uniform(x.ref, 'u_vinyl', x.vinyl.concat([on]));
            x.c.uniform(x.ref, 'u_prog', x.prog.concat([pv]));
        } else if (w.type === 'mview') {
            const us = this.setting('units') === 'us';
            const sp = this._raw('speed'), rpm = this._raw('rpm'), fuel = this._raw('fuel'), oil = this._raw('oil');
            const q = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
            const vals = [q(isNum(sp) ? (us ? sp * 0.621371 : sp) / MVIEW_SPEED[us ? 'us' : 'metric'] : 0),
                q(isNum(rpm) ? rpm / MVIEW_RPM : 0), q(isNum(fuel) ? fuel : 0), q(isNum(oil) ? (oil - 50) / 100 : 0)];
            const key = vals.join('|');
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_speed', [vals[0]]);
            x.c.uniform(x.ref, 'u_rpm', [vals[1]]);
            x.c.uniform(x.ref, 'u_fuel', [vals[2]]);
            x.c.uniform(x.ref, 'u_oil', [vals[3]]);
        } else if (w.type === 'mdash') {
            const vals = x.gauges.map(([u, G]) => {
                const v = G.signal ? this._raw(G.signal) : null;
                return [u, G, isNum(v) ? Math.round(Math.min(1, Math.max(0, (v - G.min) / (G.max - G.min))) * 200) / 200 : 0];
            });
            // the setup level bars: the segment at round(signal) is lit (1-based; 0 = none)
            const lit = [0, 1, 2, 3].map((i) => {
                const s = x.bars[i], v = s && s.signal ? this._raw(s.signal) : null;
                return s && isNum(v) ? Math.max(0, Math.min(s.max || 1, Math.round(v))) : 0;
            });
            const key = vals.map((v) => v[2]).join('|') + '|' + lit.join('|');
            if (!force && key === x.last) return;
            x.last = key;
            vals.forEach(([u, G, v]) => x.c.uniform(x.ref, u, [G.cx || 0, G.cy || 0, G.r || 0, v]));
            x.c.uniform(x.ref, 'u_segLit', lit);
        } else if (w.type === 'mtach') {
            const rpm = this._raw('rpm'), sp = this._shift();
            const v = isNum(rpm) ? Math.min(1, Math.max(0, rpm / (w.max || 8000))) : 0;
            const key = Math.round(v * 600) + '|' + sp.now;
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_value', [v]);
            x.c.uniform(x.ref, 'u_shiftNow', [sp.now ? 1 : 0]);
        } else if (w.type === 'segbar') {
            const v = this._raw(w.signal);
            const lit = isNum(v) ? Math.max(0, Math.min(w.max, Math.round(v))) : 0;
            if (!force && lit === x.last) return;
            x.last = lit;
            x.c.uniform(x.ref, 'u_lit', [lit]);
        } else if (w.type === 'revbar') {
            const rpm = this._raw('rpm'), sp = this._shift();
            const v = isNum(rpm) ? Math.round(Math.max(0, rpm) / 10) * 10 : 0;
            const peak = Math.round(this.score.peak / 10) * 10;
            const key = v + '|' + sp.rpm + '|' + peak + '|' + sp.now;
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_value', [v]);
            x.c.uniform(x.ref, 'u_shift', [sp.rpm]);
            x.c.uniform(x.ref, 'u_peak', [peak]);
            x.c.uniform(x.ref, 'u_shiftNow', [sp.now ? 1 : 0]);
        } else if (w.type === 'lights') {
            const rpm = this._raw('rpm'), sp = this._shift(), n = this._wings(w) ? Math.ceil((w.count || 12) / 2) : w.count || 12;
            let lit, strobe;
            if (this._countIn()) {
                // the count-in: lit over the cue's span up to its flash point, then all red at 5 Hz while it is latched
                lit = Math.floor(this.cue.fraction(rpm) * n);
                strobe = this.cue.now.shift ? (this.cue.blink(now) ? 1 : 0) : 0;
                if (this.cue.now.shift && !strobe) lit = 0;
            } else {
                // the lights fill from "from" rpm (3000) up to the shift point; a "from" at or past it means the last 500 rpm
                const from = Math.min(isNum(w.from) ? w.from : 3000, sp.rpm - 500);
                lit = isNum(rpm) ? Math.floor(Math.min(1, Math.max(0, (rpm - from) / (sp.rpm - from))) * n) : 0;
                strobe = sp.now ? 1 : 0;
            }
            const key = lit + '|' + strobe;
            if (!force && key === x.last) return;
            x.last = key;
            x.c.uniform(x.ref, 'u_lit', [lit]);
            x.c.uniform(x.ref, 'u_strobe', [strobe]);
        }
    }

    /* ---------------- directions: the "nav" widget (nav.js, hud_nav.js: Redline's, MIT) ---------------- */

    /** The directions' modules, loaded on the first nav widget (an app without one never loads them). */
    _navMods() {
        if (!this.navMods) this.navMods = { Nav: require('./nav'), Pic: require('./hud_nav'), Canvas: require('./kit/canvas').Canvas };
        return this.navMods;
    }
    /** The directions' source (subscriptions, the event list), started with the first nav widget, kept until stop(). */
    _navSource() {
        if (!this.directions) {
            const shown = () => { let on = false; this.widgets.forEach((x) => { if (x.w.type === 'nav') on = true; }); return on; };
            this.directions = this._navMods().Nav.start(this.ctx, this.log, { wanted: () => this._navMode() !== 'off' && shown() });
        }
        return this.directions;
    }
    /** "navDirections": 'route' (the default), 'near' or 'off'. */
    _navMode() { const m = this.setting('navDirections'); return m === 'off' || m === 'near' ? m : 'route'; }
    /** The nav widget's image: the picture's own size, scaled into the widget's box when that is another size. */
    _navImage(w) {
        const P = this._navMods().Pic;
        return { iw: P.NW, ih: P.NH, sampling: w.w === P.NW && w.h === P.NH ? 'nearest' : 'bilinear' };
    }
    _navCreate(x) {
        const M = this._navMods();
        x.cv = new M.Canvas(M.Pic.NW, M.Pic.NH);
        this._navSource();
    }
    /** At most every TEXT_MS: what to show now; the picture redrawn only when that changed, only the changed rect sent. */
    _navUpdate(x, now, force) {
        if (!force && now - x.lastPaint < TEXT_MS) return;
        x.lastPaint = now;
        const M = this._navMods(), v = this._navSource().view(this._navMode()), m = v && v.show;
        const opts = { color: color(this.theme, x.w.color || 'fg'), align: x.w.align === 'left' ? 'left' : 'right' };
        this.navShown = !!m;
        const key = m ? M.Pic.navKey(m, opts) : '';
        if (!force && key === x.last) return;
        x.last = key;
        M.Pic.drawNav(x.cv, m || null, opts);
        const buf = Buffer.from(x.cv.d), was = x.px;
        x.px = buf;
        if (!was) { x.c.pixels(x.ref, null, buf); return; }
        const c = changes(was, buf, M.Pic.NW, M.Pic.NH);
        if (c) x.c.pixels(x.ref, [c.rect], c.px);
    }

    /** A rounded tag: fill in the tone colour (bright for a fresh grade), text centred on it. Empty text: nothing. */
    _paintBadge(w, s, tone, fresh) {
        const W = w.w, H = w.h, buf = Buffer.alloc(W * H * 4, 0);
        if (!s) return buf;
        const r = Math.min(6, H / 2), fillA = fresh ? 0.45 : 0.2;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                // rounded-rect coverage, 1 px soft edge
                const qx = Math.max(Math.abs(x + 0.5 - W / 2) - (W / 2 - r), 0), qy = Math.max(Math.abs(y + 0.5 - H / 2) - (H / 2 - r), 0);
                const cov = Math.min(1, Math.max(0, r + 0.5 - Math.sqrt(qx * qx + qy * qy)));
                if (cov <= 0) continue;
                const o = (y * W + x) * 4;
                buf[o] = tone[0]; buf[o + 1] = tone[1]; buf[o + 2] = tone[2]; buf[o + 3] = Math.round(255 * fillA * cov);
            }
        }
        const font = textRaster.loadFont(w.font);
        const ty = Math.round((H - font.metrics.cellHeight) / 2);
        const m = textRaster.mask(W, H, s, { font: w.font, align: 'center', spacing: w.spacing, offsetY: ty });
        const tc = fresh ? this.theme.fg : tone;
        for (let i = 0; i < m.length; i++) {
            if (!m[i]) continue;
            const a = m[i] / 255, o = i * 4, ba = buf[o + 3] / 255;
            const outA = a + ba * (1 - a);
            for (let c = 0; c < 3; c++) buf[o + c] = Math.round((tc[c] * a + buf[o + c] * ba * (1 - a)) / outA);
            buf[o + 3] = Math.round(outA * 255);
        }
        return buf;
    }

    /** "x/y" at every step, uploaded as small rects (not the whole, mostly empty, image). */
    _paintGridLabels(x) {
        const w = x.w, W = w.w, H = w.h, step = w.step || 100, font = w.font;
        const cell = textRaster.loadFont(font).metrics.cellHeight;
        const rects = [], parts = [];
        for (let gy = 0; gy < H; gy += step) {
            for (let gx = 0; gx < W; gx += step) {
                const label = (w.x + gx) + '/' + (w.y + gy);
                const lw = Math.min(W - gx - 2, textRaster.measure(label, font, 0) + 2);
                const lh = Math.min(H - gy - 2, cell);
                if (lw <= 0 || lh <= 0) continue;
                const buf = textRaster.drawText(lw, lh, label, { font, color: [255, 230, 0, 255] });
                rects.push({ x: gx + 2, y: gy + 2, w: lw, h: lh });
                parts.push(buf);
            }
        }
        this._blit(x, rects, Buffer.concat(parts));
    }

    _paintStripe(x) {
        const w = x.w, buf = Buffer.alloc(w.w * w.h * 4, 0);
        for (let px = 0; px < w.w; px++) {
            const c = (this.theme.stripeColors || M_STRIPE)[Math.min(2, Math.floor(px * 3 / w.w))];
            for (let py = 0; py < w.h; py++) c.forEach((v, i) => { buf[(py * w.w + px) * 4 + i] = v; });
        }
        this._blit(x, null, buf);
    }

    _paintScale(x) {
        const w = x.w, n = this._barMax(w) / 1000 + 1, red = this.setting('redline');
        const m = Buffer.alloc(w.w * w.h, 0), hot = Buffer.alloc(w.w * w.h, 0);
        // the rev bar right above this scale (same x and width) in driver camera wings: no numbers (they'd only fit one wing)
        const bar = (this.shown || []).filter((b) => b.type === 'shiftbar' && b.x === w.x && b.w === w.w && b.y < w.y)
            .sort((a, b) => b.y - a.y)[0];
        if (bar && this._wings(bar)) { this._blit(x, null, Buffer.alloc(w.w * w.h * 4, 0)); return; }
        for (let i = 0; i < n; i++) {
            const label = String(i);
            const lw = textRaster.measure(label, w.font, 0);
            const cx = i / (n - 1) * w.w;
            const left = Math.round(Math.max(0, Math.min(w.w - lw, cx - lw / 2)));
            const one = textRaster.mask(w.w, w.h, label, { font: w.font, x: left });
            const into = w.redFrom && i * 1000 >= red ? hot : m;
            for (let k = 0; k < m.length; k++) if (one[k] > into[k]) into[k] = one[k];
        }
        const buf = textRaster.tint(m, w.w, w.h, { color: color(this.theme, w.color || 'dim'), font: w.font });
        if (w.redFrom) {
            const hb = textRaster.tint(hot, w.w, w.h, { color: this.theme.hot, font: w.font });
            for (let k = 0; k < hot.length; k++) if (hot[k]) hb.copy(buf, k * 4, k * 4, k * 4 + 4);
        }
        this._blit(x, null, buf);
    }
}

/** A theme with its whites and greys (any colour with little tint) at k brightness; colours keep theirs. */
function dimTheme(theme, k) {
    const out = {};
    Object.keys(theme).forEach((key) => {
        const c = theme[key];
        const grey = Array.isArray(c) && c.length >= 3 && Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < 40;
        out[key] = grey ? [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)].concat(c.length > 3 ? [c[3]] : []) : c;
    });
    out.name = theme.name;
    return out;
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function mib(bytes) { return (bytes / 1048576).toFixed(1) + ' MiB'; }

module.exports = HudApp;
