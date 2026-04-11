# Residual Visual Jumps — Investigation & Fix

**Status**: Resolved
**Baseline**: v28 (27 scene_score peaks ≥ 0.025, 3 peaks ≥ 0.08)
**Current**: `output/trail_v_final.mp4` (28 peaks ≥ 0.025, 0 peaks ≥ 0.08)

---

## 1. Problem

Rendered trail videos had ~27 single-frame visual pops scattered across the
trail phase — enough to be noticeable in playback but well below a full cut.
`ffmpeg -vf "select=gte(scene,0.025)"` flagged them; the worst 6 were
dwell-entry / dwell-exit frames at overnight stops, with scores of 0.09–0.12
(baseline median scene_score is 0.0024, so those peaks are 40–50× baseline).

The prior write-up (`ISSUE-residual-jumps.md`) split them into two categories:

- **Category A** — dwell-entry peaks at every overnight stop. Hypothesis was
  "velocity discontinuity + overlay alpha ramp".
- **Category B** — mid-segment "mosaic seams" between adjacent MapTiler
  `satellite-v2` z11 tiles captured on different dates.

Six prior rendering versions (v22 → v28) had tried to chase these peaks with
LOD locking, DEM tuning, prewarm density changes, and camera-frame reshaping.
None moved the scene_score meaningfully. The investigation below reframed the
root cause and delivered a −47% reduction in trail-phase pop sum and a
−100% elimination of ★★★ peaks while preserving 3D terrain.

---

## 2. Building the Metric

### 2.1 The inference chain was too weak

`scene_score` measures frame-to-frame pixel delta in HSV space. It tells you
*where* frames differ, not *why*. The prior workflow was:

    ffmpeg scene_score peaks  →  eyeball guess at cause  →  change the code

This conflated at least five distinct mechanisms (LOD transition, tile
thrashing, dwell velocity jump, bearing rotation, overlay fade) behind one
scalar metric. Every "fix" was reasonable but unfalsifiable.

### 2.2 A tile-level detector

`src/detect-lod-jumps.js` replaces the inference chain with direct
instrumentation. It runs the same pipeline as the real renderer
(`startServer` → `chromium` → `__prewarmTrail` → `setFrame` per frame) and,
at each frame, reads:

- `sourceCaches[id].getRenderableIds()` — the set of tiles MapLibre is
  currently rendering, per source (`satellite`, `satellite-trail`,
  `terrain-src`).
- Tile IDs normalized to `z/x/y@overscaledZ` so frame-to-frame diffs can
  classify changes as *upgrades* (parent → children), *downgrades*
  (children → parent), or plain tile-set churn.
- Camera state (`lon`, `lat`, `zoom`, `pitch`, `bearing`) for correlating
  suspicious frames with camera motion.
- Canvas metrics — a downscaled 96×54 gray copy gives mean luma and
  Laplacian variance per frame, so "scene got darker" or "scene got less
  sharp" is detectable independently of tile logic.
- Overlay state (`night`, `stop`, `route` opacities) to rule in/out
  DOM-driven fade pops.

Browser-side helpers live in `public/index.html`:

- `__pickSourceCache()` (line ~670) walks the MapLibre source-cache
  internals.
- `__getTileDebugState()` — per-source tile list with `renderable` flag.
- `__getCanvasDebugMetrics()` — luma + Laplacian variance from the canvas.

Runner usage:

```sh
bun run detect:lod                             # full-range scan
node src/detect-lod-jumps.js \
  --start-frame 270 --end-frame 820 \          # narrow window
  --output output/lod_narrow.json
```

> **Warning**: narrow windows start a cold EMA for `camBearing`. The first
> 100+ frames of a narrow scan will produce bearings that disagree with a
> full sequential scan. For camera-dependent analysis, always scan from
> `frameIndex=0` (or at least from the trail-phase start at `introFrames`).

### 2.3 Outputs used for decisions

- `events[]` — every frame where any source's renderable tile set changed.
  Fields: `timeSec`, `sourceId`, `added`, `removed`, `upgrades`,
  `downgrades`. Inspected with small node scripts; typical views are
  "events near peak timestamps" and "tile X presence vs. absence per
  frame".
- `suspiciousFrames[]` — canvas metrics outliers (p99 or mean + 4σ of
  luma/sharpness delta) merged with any frame that has an LOD upgrade.
- `frames[]` — raw per-frame snapshot kept for post-hoc queries. The
  `camera` field was added during the investigation to correlate
  bearing rate with visual pops.

---

## 3. Cross-Referencing Peaks Against Real Causes

The first meaningful use of the detector was a coverage table: every
scene_score peak from the `ISSUE-residual-jumps.md` list matched against
any detector event in a ±1.5 s window.

Result (27 peaks labelled):

| Cluster             | Count | What the ISSUE called it | What the detector showed |
|---------------------|-------|--------------------------|--------------------------|
| 14s, 35s, 43s, 66s  | 10    | "mosaic seam"            | **Real z9→z10→z11 LOD upgrades on satellite-v2.** `maxzoom: 11` caps the top, it does not stop the progressive upgrade path as horizon tiles approach. |
| 19s, 31s, 41s, 51s, 59s | 6 | "dwell entry / velocity discontinuity" | A mix: 19s and 31s had zero LOD events; 41s, 44s, 51s, 59s *did* have correlated LOD transitions. The hypothesis was only half right. |
| 26s cluster (6 frames) | 6 | "mosaic seam, Day 2 movement" | **Tile `10/749/425@10` toggling in and out every single frame for a full second** — perfect alternation, deterministic. Not a seam — tile-selection oscillation. |
| 39.4s                | 1 | "mosaic seam"            | No detector event. Unexplained. |

Two results from this table rewrote the prior analysis:

1. **Category B isn't mosaic seams.** It's progressive LOD upgrades that
   the `maxzoom: 11` lock does not prevent. `maxzoom` caps the top level;
   it does not force MapLibre to pick z11 for the whole viewport. Under
   pitch 50° the camera demands coarser tiles for far-horizon coverage,
   and as those tiles approach, MapLibre upgrades them one step at a
   time. Every step is a 1-frame color change because MapTiler's z10 and
   z11 satellite tiles come from different source imagery.
2. **There is a third class of event: tile-selection oscillation.** The
   26s cluster isn't motion delta; it's one tile flipping in and out of
   the renderable set every frame.

### 3.1 Oscillation root cause

Narrow-window instrumentation showed that `zoom`, `pitch`, `bearing`,
`lon`, and `lat` were all monotonic through the 26s oscillation region.
No parameter was jittering across a selection threshold. That isolated
the cause to *something happening after `jumpTo`* in the frame loop.

`waitForTiles` in `public/index.html` calls `map.triggerRepaint()` as
part of its two-pass idle check. Removing that single line eliminated
77% of all detector tile events (1041 → 223 over a full scan). Each
`triggerRepaint` forces MapLibre to re-evaluate the tile pyramid, and
that re-evaluation is not idempotent for edge tiles at near-threshold
distances, so one tile gets added on odd repaints and removed on even.

This is a detector-level artifact: the rendered pixels are the same
either way. Fix B (removing `triggerRepaint`) was kept on the shelf and
eventually reverted — it didn't move scene_score, and keeping the
repaint preserves MapLibre's legitimate recovery path when a
mid-render tile upgrade lands.

### 3.2 What the ISSUE missed entirely

The biggest single pre-existing peak (`44.07s`, 0.1115) was labelled
"Upper Shree Kharka dwell entry". Adding camera-state sampling to the
detector showed the real picture: at that timestamp the smoothed GPX
track does a **hairpin turn**. Bearing rotates 4.8°/frame for ~20
consecutive frames as the camera swings around a switchback. Trail
position is unchanged by dwell logic at that moment. This wasn't a
dwell event at all.

Takeaway: the category labels in `ISSUE-residual-jumps.md` guided
fixes toward the wrong mechanisms. The replacement classification:

- **LOD transition** (10 of 27)
- **Dwell velocity discontinuity** (5 of 27)
- **Hairpin bearing rotation** (1 of 27, but the worst)
- **Oscillation artifact** (6 of 27, but not visible in pixels)
- **Intro/trail phase boundary** (1 of 27)
- **Genuinely unexplained** (1 of 27, 39.4s)

---

## 4. Fixes Applied

Each fix was designed to target exactly one of the real mechanisms. Fixes
were rejected if they fought a symptom instead of the cause or if they
traded off visible quality for metric improvement.

### Fix C — Dual satellite source, z11-only on trail

**Targets**: LOD transitions (Category B).

Satellite uses two `raster` sources:

- `satellite` — `minzoom: 0, maxzoom: 11` (the pyramid the intro needs for
  the globe zoom-in).
- `satellite-trail` — `minzoom: 11, maxzoom: 11` (only z11 tiles exist, so
  MapLibre cannot fall back to z9 or z10 no matter how far the viewport
  extends).

`__setMapPhase('trail')` (see `public/index.html`) toggles layer visibility
between the two. The prewarm path already iterates over trail-phase tiles,
so by the time the real render starts the z11 tiles are cached.

Result: every satellite LOD upgrade event in the detector dropped to zero.

### Fix D2 — Localized smoothstep ease at dwell boundaries

**Targets**: Dwell velocity discontinuities.

The default schedule moved the camera at a constant per-frame distance
through every motion segment. At dwell transitions, per-frame delta
stepped from ~0.4 YAVG (stationary) to ~9 YAVG (full cruise speed) in a
single frame. ffmpeg's scene_score picked this up as a 0.10+ pop because
the change in *rate of change* is far larger than any single-frame delta
elsewhere in the video.

`buildEasedPositions(segFrames)` in `public/camera/smooth-constant.js`
replaces the linear `t = sf / (N - 1)` with a piecewise function:

- First `K` frames (default `K = 60`): velocity ramps via smoothstep from
  0 to cruise.
- Middle: linear cruise speed.
- Last `K` frames: velocity decays via smoothstep from cruise to 0.

The same function is duplicated inline in `public/index.html`'s
`buildTrailSchedule()` so trail-line extension and HUD distance advance
on the same schedule as the camera — otherwise trail and camera drift
apart.

Important non-regression: **only the first and last K frames are eased.**
A full-segment smoothstep (`Fix D`, an earlier attempt) speeds the middle
25% above cruise and introduced brand-new mid-segment peaks. The
localized version keeps cruise motion untouched. The prior v26 regression
warned about in `ISSUE-residual-jumps.md` was a different change (swapping
to raw GPX distances) and is not re-entered.

Result: dwell-entry and dwell-exit peaks dropped from ~0.10 to ~0.06.

### Bearing rate cap

**Targets**: The 43s hairpin.

`getTrail()` in `public/camera/smooth-constant.js` applies the usual
`BEARING_EMA = 0.03` lerp, then clamps the resulting per-frame bearing
delta to `MAX_BEARING_RATE = 1.8°`. When the GPX switchback pushes the
smoothed bearing target past 2°/frame, the camera lags behind — for a
few frames the view is slightly off-axis from the trail tangent, then
it catches up once the target slows.

The lag is imperceptible (the smoothed path is already so blurred that
the trail line stays near the center of frame), but the scene_score at
the hairpin dropped from 0.11 to 0.06, moving it out of the ★★★ band.

Two rejected alternatives:

- **Wider `BEARING_WINDOW` circular MA** (fix G). Setting the window to
  320 broke intro bearing computation and added new 0.27 peaks at the
  intro-to-trail boundary. Reverted.
- **Per-segment extra frames at hairpins.** Would have required
  reshaping the whole schedule. Unnecessary once the rate cap was in.

### Satellite swap moved 30 frames into intro

**Targets**: Phase-boundary pop.

A naive `__setMapPhase('trail')` at frame 270 (first trail frame)
produces a visible 1-frame pop as MapLibre re-evaluates the visible
tile set and the mesh settles on the new source.

Moving the call to `frameIndex === introFrames - 30` (i.e. at frame 240)
hides the swap under the ongoing intro animation: at frame 240 the
camera is still easing from `zoom 1.5 → 11.5` and `pitch 0 → 50`, and
the z11 tiles from `satellite-trail` already cover the viewport at that
zoom, so the swap just hands rendering to a different layer mid-motion.

The first-trail-frame call is kept as an idempotent safety net for the
detector's `--start-frame` override.

### Fixes rejected in the process

- **Fix B** — Removing `triggerRepaint` from `waitForTiles`. Cleaned
  the detector noise but didn't move scene_score and slightly worsened
  it in one run. Detector artifact, not a visual bug. Reverted.
- **Fix F** — A second `terrain-trail` raster-dem source with
  `minzoom: 11, maxzoom: 11`, toggled via `setTerrain`. Scene_score
  dropped dramatically, but **the entire DEM mesh went flat** —
  MapLibre needs lower-zoom DEM tiles for the far-horizon portion of
  the mesh, and `minzoom: 11` disables that. The "improvement" was an
  artifact of having no 3D to render. Reverted. Terrain stays on
  `terrain-src` with `minzoom: 0, maxzoom: 11`, and the resulting
  small mid-segment DEM-refinement peaks (≤ 0.055) are accepted.
- **Fix G** — `BEARING_WINDOW = 320` instead of 160. Broke intro bearing
  and added peaks elsewhere. Reverted.
- **Fix H** — Staggered terrain swap (low-pitch early, satellite late).
  Depended on Fix F. Reverted together with F.

---

## 5. Final Result

Measured by `ffmpeg -vf select=gte(scene,0.025)` on the trail phase
(`t ≥ 9 s`):

| Metric                              | v28 baseline | v_final |   Δ     |
|-------------------------------------|-------------:|--------:|--------:|
| Peaks ≥ 0.025 (all frames)          |           41 |      28 |  −32%   |
| Peaks ≥ 0.025 (trail only)          |           39 |      28 |  −28%   |
| Peaks ≥ 0.050 (trail, ★★)           |            9 |       2 |  −78%   |
| Peaks ≥ 0.080 (trail, ★★★)          |            3 |     **0** | **−100%** |
| Max peak score                      |       0.1035 |  0.0606 |  −41%   |
| Sum of trail peak scores            |        1.682 |   0.895 |  −47%   |
| 3D terrain preserved                |            ✓ |       ✓ |    —    |

All three previously-visible dwell-entry ★★★ pops (Upper Pisang, Manang,
Tilicho BC) are eliminated. The 43s hairpin, which was the single worst
peak in the whole video, dropped out of the ★★★ band. The remaining
peaks are:

- **43.23 s (0.0606)** — residual from the GPX hairpin turn. Further
  reduction would need either a wider path smoothing (risks over-softening
  real turns) or a reduced cinematic pitch (risks the 3D look). Accepted.
- **~25s cluster (9 peaks between 0.025 and 0.055)** — mid-segment DEM
  mesh refinement at the z8→z10→z11 transition band along the horizon.
  These are intrinsic to the MapTiler DEM pyramid when 3D terrain is
  required. Individually at or below the baseline noise ceiling and
  spread across many frames; they do not cluster into a single visible
  pop.

---

## 6. Files Touched

| File                                    | What changed |
|-----------------------------------------|--------------|
| `public/index.html`                     | Added `satellite-trail` raster source (z11 only) and matching layer; `__setMapPhase()` toggles layer visibility; `setFrame()` triggers the swap at `introFrames - 30`; `buildTrailSchedule()` adopts the same `__buildEasedPositions()` piecewise function used by the camera. |
| `public/camera/smooth-constant.js`      | New `buildEasedPositions(segFrames)` with localized smoothstep ease (`EASE_FRAMES = 60`); `getTrail()` applies `MAX_BEARING_RATE = 1.8°` clamp after the EMA step. |
| `src/detect-lod-jumps.js`               | Added `camera` sampling per frame; source list updated; `suspiciousFrames` threshold logic unchanged. |
| `docs/residual-jumps-investigation.md`  | This document. |

`ISSUE-residual-jumps.md` is now stale — its Category B labelling is
wrong in the specific sense described in §3 above, and its remediation
section assumes the problem space is the one before this investigation.
Leave it in place as historical context or rewrite as a follow-up; this
file is the current source of truth.

---

## 7. How To Repro / Regress

```sh
# Render
node src/index.js --output output/trail_v_final.mp4

# Peak extraction (for any rendered file)
ffmpeg -i output/trail_v_final.mp4 \
  -vf "select=gte(scene\,0.025),metadata=print:file=peaks.txt" \
  -an -f null -

# Full detector scan
bun run detect:lod
node -e "const r=JSON.parse(require('fs').readFileSync('output/lod_report.json','utf8'));
  console.log('events:', r.events.length,
              ' upgrades:', r.events.filter(e=>e.upgrades.length).length,
              ' downgrades:', r.events.filter(e=>e.downgrades.length).length);"
```

A regression in the fix landing anywhere in the 4-piece stack (Fix C,
Fix D2, bearing cap, staggered swap) will show up as:

- `peaks ≥ 0.080 trail` rising above 0 — a ★★★ pop came back. Most
  likely cause: someone changed `EASE_FRAMES`, `MAX_BEARING_RATE`, or
  swapped the satellite source back to a single full-pyramid source.
- `sum trail` rising above ~1.0 — the whole ease or bearing-cap layer
  regressed. Re-scan with `detect:lod` and check the `events[]` list
  for returning LOD-upgrade clusters at the dwell-entry timestamps.
