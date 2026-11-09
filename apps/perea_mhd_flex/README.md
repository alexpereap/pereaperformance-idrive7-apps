# Flex Fuel

The ethanol content an **MHD-flashed DME** runs on, read over the head unit's own diagnostic
link (InternalTasu, DME `0x12`) and shown as two dials: **Ethanol Content (Active)**, the value
the tune uses, and **Ethanol Content (CAN)**, what the flex fuel sensor reports through MHD's
CAN ethanol analyser. Under them a note says **Flex fuel active** (green) while the tune uses
the ethanol, and **Flex fuel disabled** when Active reads 0 (a map without flex fuel): in amber,
with the sensor's reading, when CAN still sees ethanol. When Active and CAN are 10 points or more
apart (the tune still blending after a fill-up, or a map that does not follow the sensor) the
header says **MISMATCH**. A third dial shows the **fuel in the tank** (US gallons, the litres
under it), and under the dials the **blend calculator** says how much ethanol to add, at the
purity set in Settings, to take the tank from the sensor's reading to a target blend. The app
only reads; nothing is written to the car.

![Flex Fuel](../../docs/screens/perea_mhd_flex.png)

> **Experimental.** The addresses were captured on one car (G-series MG1, MHD 5.41, PRGID
> `00005D55503C05`). On any other ROM the app says *ROM not supported* and sends no read: see
> [Your ROM](#your-rom) to add it.

## What leaves the head unit

| Step | Request | Reply |
|---|---|---|
| Is MHD there? (ROM independent) | `2F 04 4D 48 44` ("MHD") | `6F 04 4D 48 44 32 ...` ("MHD2" + version); a stock DME refuses |
| Which ROM? | `22 F1 01`, `22 F1 02` | the SVK entries; MHD keys its addresses by the program (`08 00 00 ...`, "PRGID") and calibration (`0D 00 00 ...`, "CALID") ones |
| Define the identifier | `2C 03 F3 03` (clear), `2C 02 F3 03 14 B0 00 60 C2 01 B0 00 60 D2 01` | `6C 02 F3 03` |
| Read, twice a second | `22 F3 03` | `62 F3 03 <active> <can>`: one byte each, percent |

This is how MHD's own app logs those two channels (captured with PCAPdroid on the phone while
logging *Ethanol Content (Active)* and *(CAN)*, cross-checked against the exported CSV). Two
things to know:

- **`0x23` ReadMemoryByAddress is refused** on this DME (`7F 23 10`), although it worked on an
  S58 in another capture. The dynamic identifier (`2C` by memory address, format `14`: 1-byte
  size, 4-byte address) is what works everywhere MHD does.
- **The DME has four dynamic identifiers, `F300`..`F303`, and no more:** `2C 02 F304` is refused
  with `7F 2C 31` (request out of range), as the first test on the car showed. MHD's app defines
  `F300` (by identifier) and `F302` (by address) for a short channel list and clears all four when
  it connects, so this app takes `F303`, and `F301` when `F303` is refused (config `dynamicDids`).
  The DME forgets the definition at an ignition cycle (then `22 F3 03` answers `7F 22 31`): the
  app defines it again, at most 3 times in a row before it waits (5 s, 10 s, 20 s, 30 s) and
  starts over. The identifier is the DME's volatile table; nothing persists.

No diagnostic session change, no security access, no writes (`2E` / `3D`), no routines.

## Fuel level and the blend calculator

The cluster's own figure (the SOME/IP field `de.bmw.infotainment.KombiIF` /
`statusRangeTankStatus` / `fluidLevelFuelTank`, as the Live Data app's *Fuel in the tank* shows
it) comes in **whole litres**, so the app reads several sources at once and lets you pick the
finest one that answers on your car (**Fuel source** in Settings):

| Source | How | Resolution | Notes |
|---|---|---|---|
| **DME tank halves** | `22 59 49` and `22 59 4A` to the DME, between the MHD reads | **0.5 L** each, added | the raw sensors (the cluster filters them); the dial shows the median of the last three reads of each half |
| **Cluster (Kombi)** | the SOME/IP field, read again every 10 s | 1 L | what the driver sees; `255` and up means no data |
| DME whole tank | `22 58 3B` | 1 L | shown on the sources line only |

**Auto** (the default) takes the DME's halves when they answer, else the cluster. (1.2.0 also read the
OBD fuel level, `01 2F`: on the car it follows the range rather than the fuel, so it was dropped.) A
source the DME refuses, or
that does not answer three times in a row, is left alone for five minutes. A reading older than
60 s counts as gone (the dial shows `--`). The identifiers come from Live Data's `DME8FF_R` catalog
(B58 / B48 engines) and are read in the default session; nothing is written. The cluster's
interface is `_optional` in `app.json`: a unit without it installs the app without that source.

Turn on **Show fuel sources** to see them all along the bottom of the screen, `Kombi 24 L (L 12
R 12) · DME 12.0 + 12.5 = 24.5 L (583B 24 L)` (the cluster's two halves
as sent, their scale unknown), and compare them with the gauge in the cluster; the log has the
raw bytes of every source once a minute (`fuel dmeL=...`) and the cluster's raw values
(`fluidLevelFuelTank raw=...`). `7F 22 31` in the log means the DME has no such identifier.

The dial is in **US gallons** (one decimal, `1 gal = 3.785 L`) over the **Tank capacity** set in
Settings, with the litres and the source under it: `6.5 gal (24.5 L · DME)`.

**The calculator.** With `V` litres in the tank at `C` % ethanol (the *CAN* reading: what the
sensor measures), the ethanol to add at purity `P` % to reach the target `T` % comes from the
ethanol balance `(V·C + x·P) / (V + x) = T`, so

```
x = V · (T − C) / (P − T)
```

Volumes are taken as additive (mixing ethanol and petrol shrinks the volume by under 1 %). The
example 6.5 L at 12 % to E65 with ethanol at 99 % gives 10.1 L (2.7 gal). The result row says
**Ethanol to add 2.7 gal (10.1 L)**, with the purity and the tank afterwards (`16.6 / 60 L`)
under it, or **Exceeds tank capacity (+N L)** in amber when the blend would not fit. Instead of a
number it says *No fuel reading*, *No ethanol reading*, *Target reached* (the target is at or
under the sensor's reading: this version only adds ethanol) or *Purity below target* (the ethanol
is not purer than the target, so no amount reaches it). A later version will offer pump petrol +
ethanol as two amounts (`calc.js` is laid out for a second output).

| Setting | Values | Default | |
|---|---|---|---|
| **Target ethanol** | 10..100 %, in steps of 1 | 85 % | the blend to reach; also moved by the **−5 / +5** buttons on the page |
| **Ethanol purity** | 10..100 %, in steps of 1 | 99 % | the ethanol you pour in (E85 from the pump: 85 or less) |
| **Tank capacity** | 40..100 L | 60 L | the fuel dial's scale and the overflow warning |
| **Fuel source** | Auto, DME tank halves, Cluster (Kombi) | Auto | where the fuel in the tank comes from (above) |
| **Show fuel sources** | on / off | off | the comparison line along the bottom |

The values are lists, so only those can be chosen (in the kit's Settings sheet and in the HMI's
own settings screen alike). The −5 / +5 buttons are drawn only where the kit runs the screen (the
Store's renderer with touch routing); they keep the target within 10..100. Without them the
target is changed in Settings.

## Screen and states

Three `G.radial` dials across the top (ethanol 0-100 %, the fuel over the tank's capacity) with
the number in the middle; under them the calculator on the left (target row, result, detail) and
the link's note and detail on the right, and the Perea Performance logo bottom right. The
header badge says what is going on when the ethanol dials show `--`:

| Badge | Note | Meaning |
|---|---|---|
| `DEMO` | | made-up values (setting *Demo data*: Always, or Auto without a diagnostic transport, as in the emulator); nothing is sent |
| `NO LINK` | No diagnostic link / Diagnostic link down | the transport is not there yet (apps start before it at boot) or the car is asleep |
| `NO MHD` | MHD not found on the DME | the DME refused `2F 04` "MHD"; probed again every 30 s |
| `OTHER ROM` | ROM not supported, with the ids seen | MHD is there but no profile has this ROM's addresses; checked again every 60 s |
| `LINK STALE` | | three reads in a row without an answer; polling slows to 1 Hz, after ten it starts over |
| `MISMATCH` | Flex fuel active, *Active and CAN differ* | Active and CAN are 10 points or more apart (`GAP` in `ui.js`): the tune is still blending in the new fuel, or the map does not follow the sensor |
| | Flex fuel disabled (amber), *Sensor reads N %* | Active is 0 while the sensor reads ethanol: a map without flex fuel, or one that ignores the sensor |
| `DME ERROR` | Waiting for the DME | a refusal or a definition that will not hold; backoff, then start over |

Code: `protocol.js` (bytes in and out, pure), `poller.js` (the states, one request in flight),
`calc.js` (the blend arithmetic and the fuel source choice, pure), `ui.js` (the screen),
`main.js` (wiring, the cluster's signal, demo), `logo.js` (generated, see below).

## Your ROM

The two addresses are RAM locations in MHD's part of the DME software, so they move with the
ROM. `PROFILES` in `protocol.js` lists the ROMs they are known for:

```js
{ name: 'MHD on MG1 (PRGID 00005D55503C05)', prgid: '00005D55503C05', calid: '00008417503C1D',
  sgbd: '0F26B4', active: 'B00060C2', can: 'B00060D2' }
```

To add yours:

1. Find your PRGID and CALID: MHD prints them at the top of every exported log (`#Ecu PRGID`,
   `#Ecu CALID`), and the app logs the ids it saw (`perea_mhd_flex: identifying -> unsupported-rom (ids ...)`).
2. Find the addresses: log only *Ethanol Content (Active)* and *(CAN)* in MHD while capturing
   the phone's traffic (PCAPdroid, target app MHD). The `2C 02 F3 0x 14 <addr> 01 ...` request in
   the capture lists the addresses in the order MHD logs them; the CSV tells which is which.
3. Add the profile and a test case in `kit/tools/test_mhd_flex.js`, and please open a PR.

A capture holds your VIN (`22 F1 90`): keep it to yourself. `captures/` is in `.gitignore`.

## Living with MHD's app

Both can be connected: every reply is filtered by its identifier, so MHD's `62 F3 00` answers
never count as ours. A session of MHD's app that clears the dynamic identifiers costs this app
one re-definition. The four identifiers are shared, though: while MHD's app logs a long channel
list it may define `F303` (or `F301`) itself, and then the two take the identifier from each
other in turn (this app sees a reply of the wrong length and defines again, up to 3 times, then
waits). Close this app's screen while logging with MHD, or log with MHD while this app's screen
is not shown: hidden, it sends nothing. While both poll, the head unit's transport is shared and
may answer busy now and then (`LINK STALE` for a moment).

## Logo

The kit has no image decoder and the build ships no image files, so the logo is a JavaScript
module of horizontal runs, drawn once into a cached GPU layer:

```sh
python3 kit/tools/make_logo.py docs/media/perea_logo.png --width 180 --out apps/perea_mhd_flex/logo.js
```

The converter is generic: any transparent PNG / WebP, `--width`, `--opacity` (baked in: the logo
is meant to be subtle), `--ink` (pixels this dark take the theme's text colour, so a black logo
shows on the dark themes). It needs Pillow (`pip install pillow`).

## Build and test

```sh
node kit/tools/test_mhd_flex.js                 # protocol, poller states, filters, calculator, screen, main (no car, no SDK)
python3 kit/tools/build.py --preview-only perea_mhd_flex
node kit/tools/preview.js dist/perea_mhd_flex out/    # frames as PNG (demo data)
node kit/tools/emu.js perea_mhd_flex            # the app in the browser (demo data: nothing answers UDS there)
```

## Install

The app needs a renderer on the head unit (`needs: ["renderer"]` in `mgu-repo.json`): the
[MGU Store](https://github.com/robertnisipeanu/mgu-store)'s own Renderer, or `idrive7-renderd`
if you already have it. The Store says so and offers one when none is installed.

**From the Store, over the network.** In the Store: Settings → **Add source** →
`alexpereap/pereaperformance-idrive7-apps`, following the **main** branch. Flex Fuel appears in
the Store's list; the head unit builds it from this repository (no BMW SDK leaves the car).

**From a USB stick, offline.** The Store's `mgu-install.js` writes the stick; it needs Node 18 or
newer on your computer (or the standalone executable from the Store's `installer` release).

**A. Without BMW's SDK on your computer (the head unit builds the app).** The stick carries a
copy of this repository and the unit builds it from `mgu-repo.json`:

```sh
git clone https://github.com/robertnisipeanu/mgu-store.git
```

```sh
node mgu-store/deploy/mgu-install.js usb-repo /media/<your-stick> /path/to/pereaperformance-idrive7-apps
```

It copies the repository's tracked files to `<stick>/mgu-repo/<name>/`. Plug the stick into the
car, open the Store, go to its **USB** page and install **Flex Fuel**.

**B. With the SDK (a ready package on the stick).** Extract `oap-sdk/` once from your own unit
(`node kit/tools/extract_sdk.js x_call/javascript/app.js`, "Develop" in the main README), then:

```sh
python3 kit/tools/build.py perea_mhd_flex
```

```sh
node mgu-store/deploy/mgu-install.js usb-repo /media/<your-stick> dist/perea_mhd_flex@1.2.1.tgz
```

The package lands in `<stick>/mgu-repo/local/` with a generated catalog; install it from the
Store's **USB** page as above.

**A car without the Store yet:** `node mgu-store/deploy/mgu-install.js first-install --from
<stick>/mgu-repo/mgu-store --identity <root ssh key>` installs the Store itself from the stick
(the key is the unit's root SSH key, see the Store's README). Car parked, ignition on, ideally a
charger connected.

The `.mgu` files `build.py` makes contain BMW's SDK: keep them for your own car.
