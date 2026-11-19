# Third-party notices

This repository is MIT licensed (see `LICENSE`). Parts of it come from other projects, under
their own terms, listed here. Nothing GPL licensed is in the packages installed on the car.

## MGU App Kit (idrive7-apps)

`kit/runtime`, `kit/tools`, `kit/platform`, `kit/localization`, `kit/emu`, the RHMI layout
that `kit/tools/build.py` generates, and the translation catalogs in `kit/runtime/locales` are
taken from [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
(upstream commit `6a269e7`, through the fork
[alexpereap/pereaperformance-idrive7-apps-fork](https://github.com/alexpereap/pereaperformance-idrive7-apps-fork)
at `e56ff0e`), reduced to what the apps here use and modified as described in the git history.

```
MIT License

Copyright (c) 2026 cauliflowermossgrape
Copyright (c) 2026 小白151 (GitHub: JackieZ123430), Chinese translation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Translations

- **Chinese (zh-CN)**: `kit/runtime/locales/zh-CN.*`, `kit/runtime/fonts/cjk.json`,
  `kit/localization/credit.zh-CN.json`. Copyright (c) 2026 小白151 (抖音 小白科技杂物社 /
  BiliBili 小白151 / GitHub [JackieZ123430](https://github.com/JackieZ123430/idrive7-apps-cn)),
  MIT. The attribution terms in `NOTICE.zh-CN.md` apply; Chinese builds carry the credit on
  screen and in the entry file, as upstream does.
- **Russian (ru)**: `kit/runtime/locales/ru.*`, `kit/localization/credit.ru.json`,
  `kit/localization/fonts/cyrillic-ru.json`. Translation by Иван (GitHub
  [Fieldistor](https://github.com/Fieldistor/idrive7-apps)), MIT as part of upstream. Russian
  builds carry the credit on screen and in the entry file.
- **Korean (ko)**: `kit/runtime/locales/ko.*`, `kit/localization/fonts/korean.json`. Part of
  upstream, MIT.

The catalogs here hold only the rows the apps in this repository show (`kit/tools/prune_locales.py`).

## Fonts

The kit draws text from glyph atlases (JSON files of rasterised glyphs). Each atlas is a
"Modified Version" of its source font under that font's licence, and is distributed under the
same licence, not under MIT:

| Atlas | Source font | Licence |
|---|---|---|
| `kit/runtime/fonts/bold.json`, `label.json`, `num.json` | Ubuntu font family, Copyright 2010-2011 Canonical Ltd | Ubuntu Font Licence 1.0, `kit/runtime/fonts/UFL-Ubuntu.txt` |
| `kit/localization/fonts/cyrillic-ru.json` | Ubuntu font family | Ubuntu Font Licence 1.0, `kit/runtime/fonts/UFL-Ubuntu.txt` |
| `kit/runtime/fonts/cjk.json` | Noto Sans SC | SIL Open Font License 1.1, `kit/runtime/fonts/OFL-NotoSansSC.txt` |
| `kit/localization/fonts/korean.json` | Noto Sans CJK KR | SIL Open Font License 1.1, `kit/localization/fonts/OFL-NotoSansKR.txt` |

The atlases do not use the fonts' Reserved Font Names as their own names. The licence files are
copied into every package next to the atlases.

## Cluster Themes (bimmer-lab/apps)

`apps/perea_cluster_themes` (the app, its layouts, baked fonts and theme pictures), `shared/` (the
drawing engine on cluster-render), `bench/`, `tools/`, `scripts/deploy.sh`, `docs/cluster-themes.md`
and `docs/images/` are taken from [bimmer-lab/apps](https://github.com/bimmer-lab/apps) at commit
`ab81cee` (Cluster Themes 0.19.0): **MIT, Copyright (c) 2026 bimmer-lab**. Changed here: the app's
id (`perea_cluster_themes`) and logging id, the bench staging the app without an SDK, and the tools'
paths. `kit/runtime/car.js` and `readonly-diag.js` are that repository's versions of the kit's
modules; `sim.js`, `dids.js`, `hud_claim.js` and `pack.js` are upstream idrive7-apps' (above).

The app's own `NOTICE` (`apps/perea_cluster_themes/NOTICE`, copied into every package) is the full
list and carries the licence texts. In short:

| Part | From | Licence |
|---|---|---|
| The app, `shared/`, `bench/`, `tools/`, `scripts/` | bimmer-lab/apps | MIT, Copyright (c) 2026 bimmer-lab |
| `shared/cluster_render_client.js` (unmodified), the atlas-text shader in `shared/shaders.js` | [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps), `native/cluster-render` | Mozilla Public License 2.0, Copyright (C) 2026 Robert Nisipeanu |
| Shift point, cold-engine guard, shift scoring and lights (`shift_score.js`, `shift_cue.js`, `vehicle_state.js`, `shaders.js`) | idrive7-apps' Redline app | MIT, Copyright (c) 2026 cauliflowermossgrape |
| The pixel-diff text update in `shared/hud.js` | [PenguinDukeYDAuto/idrive7-EVAHUD](https://github.com/PenguinDukeYDAuto/idrive7-EVAHUD) | MIT, Copyright (c) 2026 DukeAPenguin |
| The M view theme | [Asksket/apps](https://github.com/Asksket/apps) (f90 branch) | MIT |
| `tools/shader_budget.js` | ported from james10424's idrive7-custom | MIT |
| `apps/perea_cluster_themes/hud/fonts/*.json` (in the package: `hud.pack`), `tools/fonts-src/*.ttf` | Barlow, Michroma, Orbitron, DSEG7 Classic, Outfit | SIL Open Font License 1.1 (`tools/fonts-src/*OFL*.txt`, and the app's `NOTICE`) |

The baked atlases are Modified Versions of those fonts under the OFL, not under MIT, and do not
use the fonts' Reserved Font Names ("Orbitron", "DSEG") as their own names.

## Emulator draw engine (mgu-render)

`kit/emu/web/gfx/mgu-gfx-wasm.js` and `mgu-gfx-wasm.wasm` are the draw engine of
[mgu-render](https://github.com/robertnisipeanu/mgu-store) by Robert Nisipeanu and IterioDev,
compiled to WebAssembly for the browser emulator (`kit/tools/emu.js`), a development tool only.
It is licensed **GPL-3.0-or-later** (`kit/renderd/LICENSE`), with parts under MIT
(`kit/renderd/LICENSE.mgu-renderd`, Copyright (c) 2026 cauliflowermossgrape). Its complete
corresponding source is in this repository: `kit/renderd/src` and `kit/emu/wasm`
(`kit/emu/wasm/build.sh` rebuilds it). The engine is not part of any package built for the car;
on the head unit the apps draw through whichever renderer the MGU Store installed.

## BMW oap-sdk

The BMW SDK the apps run on is not in this repository and must never be committed. The MGU
Store takes it from the head unit it installs on; for local builds, extract it from your own
unit with `kit/tools/extract_sdk.js` (see the README).
