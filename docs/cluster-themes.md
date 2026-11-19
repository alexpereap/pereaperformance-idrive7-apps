# Cluster Themes: developing

Cluster Themes (`apps/perea_cluster_themes`) is a copy of [bimmer-lab/apps](https://github.com/bimmer-lab/apps)' app (0.19.0, commit `ab81cee`). This page is that repository's `docs/DEVELOPING.md`, adjusted to this one. It mentions HUD Widgets, bimmer-lab's second app on the same engine, which is not here; `design/` and `research/` are folders next to bimmer-lab's repository, not part of either.

## Repo layout

```
apps/perea_cluster_themes/   app.json, main.js (entry), NOTICE, README
                  subfolders (hud/: fonts, layouts, previews) are packed into <folder>.pack by the build
shared/           the cluster-render drawing engine; an app lists the files it needs in app.json "shared"
                  and kit/tools/build.py copies them in
kit/              the MGU App Kit this repository's apps share: runtime/ ships inside each app, tools/ builds it
bench/            PC test bench (fake cluster-render + the kit's stub head unit), see bench/README.md
tools/            bake_fonts.py re-bakes the app's fonts from tools/fonts-src (needs Pillow); previews.py
                  shoots the theme pictures; shader_budget.js checks the effect shaders
scripts/          deploy.sh pushes layout files to the car over SSH
docs/images/      the screenshots and GIFs in the app's README, taken from the bench
mgu-repo.json     tells the Store how to build the apps (Cluster Themes has its own entry: iDrive 7 only)
```

## Build

`python3 kit/tools/build.py perea_cluster_themes` builds the app into `dist/`. It needs an `oap-sdk/` folder: on the car the Store makes the real one from a BMW app. Without one, `--preview-only` stages the app in `dist/perea_cluster_themes/` (nothing installable), which is what the bench and the tests run.

## Signals and the unit's catalog

BMW's app manager installs an app against the head unit's interface catalog (`/etc/oap/someip/someip-interfaces.json`) and refuses the whole app for one field, method, access or instance of `app.json` `"signals"` that the catalog lacks. The Store shows only the first line of that refusal: `generateSomeipInterfaces::generateSomeipInterfaces({ userId: ...`.

- An interface is asked for by instance `1` unless its entry names one (`"_instances": "HMI_CID"`); `kit/runtime/car.js` opens `1` too unless the engine passes `$instance` with the same name (`shared/hud.js`, `MEDIA_INSTANCE`).
- `kit/tools/build.py` `fit_to_unit()` (from upstream idrive7-apps) takes out of the manifest what the catalog of the unit it builds on lacks, prints it, and writes `kit/missing-interfaces.json`, which the app logs at each start. On a PC there is no catalog and nothing is taken out.
- To check an app against a catalog copied from a car (`scp root@<unit>:/etc/oap/someip/someip-interfaces.json captures/`, gitignored):

```sh
MGU_SOMEIP_CATALOG=captures/someip-interfaces.json python3 kit/tools/build.py --preview-only perea_cluster_themes
```

  A line `this unit has no ... - built without it: ...` names each thing that unit lacks; no such line means the manifest fits.

## Test on the PC

```sh
node bench/server.js                   # then open http://localhost:8078
node kit/tools/test_cluster_themes.js  # the same start without a browser: the default theme's layers reach the bench
```

The page has buttons for the drive mode (COMFORT, SPORT, SPORT+, ECO PRO), fed in as the car's FES signal. It stages the app with the kit and runs it in the kit's stub head unit against a fake cluster-render (`BENCH_NODE` names a Node 8.16.2, the car's version, to run it on). The page shows the HUD or the cluster with the app's real pixels and shaders, the center-screen status and settings, and signal sliders. Details in `bench/README.md`.

## Layouts

Each app's layouts are `apps/<id>/hud/layouts/<name>.json` (`schemaVersion: 2`). Widget types, tokens and options are documented in the header of `shared/hud.js`. `shared/layouts.js` checks every layout and refuses a bad one with the reason, which also shows on the app's status row.

- **HUD (800x480):** `text`, `scale`, `stripe`, `shiftbar`, `arc`, `revbar`, `lights`, `badge`. Colours are theme roles (`fg`, `dim`, `arc`), so a layout works in every theme.
- **`atext` (both):** text drawn by the GPU: an effect layer that reads a glyph atlas of the font, uploaded once per connection as an R8 asset (one byte a pixel, not a layer, shared by every `atext` on that font). A value change is one uniform message of glyph codes, no pixels. Equal cells across the widget (`cells`, up to 32; the glyphs keep their shape at `w` = cells x the font's widest advance + 2 and `h` = its cell height, which the log states), `align` left, right or center, only the characters the font has. The calibration grids carry one as a probe (0.7.3 / 0.5.3), and the car drew it on both the cluster and the HUD (Nov 6 2026), so the plan is to move every readout onto this path (see `research/findings.md`, "Cost levers").
- **Cluster (1920x720):** the same types, plus `fill` (a solid colour with a see-through `hole` cut while a setting is on) and `box` (a framed readout with a header strip). A cluster layout names its own `"theme"`.
- **Sport theme:** `sdash` draws the whole theme (brackets, fills, the map cut-out or a black middle, fuel and oil bars, bottom strip) in one shader. Text `near: ["speed" | "rpm", i]` lights up the scale label nearest the value.
- **GT3 theme:** `boxes` draws the background, the map cut-out and every framed box in one shader (array uniforms, up to 12 boxes); the labels are text widgets on top.
- **M theme pieces:** `mdash` (the whole backdrop: cards, the tyre block's car glyph, side gauges and the four setup bars in one shader, nothing uploaded), `mtach` (the bowed glass rev blade with its red marker), `icon` (line icons drawn in `shared/icons.js`), and text `color2` (a chrome fade).
- **Layout generators:** the GT3, Sport and M layouts are written by `design/gen_gt3.py`, `gen_sport.py` and `gen_m.py` (next to the repo, `python3 design/gen_m.py apps/cluster_themes/hud/layouts/m.json`); edit the generator, not the JSON.
- **Calibration:** `grid` (lines every `step` px, brighter every `major` steps) and `gridlabels` (x/y labels every `step` px). Each app ships a `grid.json` layout.
- **Off:** the layout name `off` draws nothing and releases the screen. With `byMode` on, the `inComfort` / `inSport` / `inEco` settings pick the layout from the car's drive mode (FES `statusFESVehicleDynamicSwitchHMI`).
- **Effect shaders:** cluster-render's `v_uv` has (0,0) at the top-left. The bench draws the same way.
- **Layer packing:** cluster-render allows 8 layers per client connection (32 across all clients, `CompositorLimits` in its source; confirmed on the car: Nov 5 2026 one connection drew 8, Nov 6 2026 the grid's L1..L16 probe drew all sixteen over three connections on both the cluster and the HUD), so the engine packs every image widget (text, scale, icon, ...) into a few image "sheets" (one layer each, grouped by class and z, split where widgets overlap or a sheet would grow past a quarter of the target) and keeps effects one layer each; it aims for 8 layers per layout and warns in the log when a layout needs more. Put effect widgets first in a layout's file order and text after, so the text lands in as few sheets as possible. `"own": true` keeps an image widget on its own layer (the calibration probes). The limit is per connection, so `"conn": 1..3` on a widget puts its layer (or its sheet) on a second, third or fourth connection to cluster-render, each with its own 8 layers (32 service-wide); DukeAPenguin's idrive7-EVAHUD saw 28 layers shown over four sockets on his car, and the calibration grids probe it here. The service also has 16 MiB of pixel memory for every app's images together and counts each image twice, so an image layer costs w*h*8 bytes and the layout is refused past that ("the service's pixel memory is full"). The status row shows the layer count, the connections and the pixel memory; the rebuild log line says how many sheets, how many bytes the whole-sheet writes cost and the pixel memory. Text and badge widgets send only the rectangle around the pixels that changed since their last paint.
- **Any widget:** `toggle: "setting"` shows it only while that setting is on, and `"!setting"` only while it's off. `"setting=value"` shows it only while a choice setting has that value. `themes: [...]` limits it to certain themes.

**Visibility check.** Not every pixel of a target reaches the driver's eye: on the cluster the hood hides the top corners (down to y 273 at the left edge and y 240 at the right, nothing at the center), BMW paints a solid black gear box over us at x 1406-1597 y 342-419 and its seat-belt light at x 587-626 y 663-700; on the HUD only x 120, y 100, 485x278 of the 800x480 target shows through the windshield (it moves with eye position). These numbers were measured from car photos on Nov 5 2026 (`design/photos/calibration-2026-11-05.json`, pictures next to it) and live in `shared/visible.js`. `layouts.js` runs its `check()` after validating a layout and logs one warning per widget that is under the hood, under the box or light, or outside the HUD window; it never refuses a layout for this. The bench draws the same geometry as its "car view" and flags the layers (see `bench/README.md`).

To try an edited layout on the car without reinstalling:

```sh
./scripts/deploy.sh root@<car-ip-or-hostname> gt3.json
```

The file lands in the app's `data/layouts/` on the car, overrides the built-in layout of the same name, and the running app reloads it by itself.

## Fonts

Barlow, pre-baked into alpha atlases by `tools/bake_fonts.py` (the car never rasterizes fonts). Re-bake after changing sizes or characters:

```sh
python3 tools/bake_fonts.py
```

## Adding an app

1. Make `apps/<id>/` with an `app.json` (id, title, version, signals, screens, settings) and a `main.js` that calls `mgu.run`. An app that draws through cluster-render lists the engine files in `"shared"` and sets `config.target` (`hud` or `panel`).
2. Build it once by hand to check it.
3. The Store picks it up from `apps/*` on its next refresh, as an app for iDrive 7 and 8 that needs a renderer (`mgu-repo.json`). An app for iDrive 7 only, like this one, is left out of that pattern (`exclude`) and gets its own entry under `components`.

## Crash safety

The kit turns an uncaught exception into an app exit, and on the car a second unexpected exit uninstalls the app. Every timer, event and widget in the engine runs inside a guard that logs the error and carries on.
