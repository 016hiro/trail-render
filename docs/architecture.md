# Architecture

## Pipeline

```
 ┌──────────┐   ┌─────────────┐   ┌───────────────┐   ┌──────────────┐   ┌────────┐
 │  GPX +   │ → │  parseGPX + │ → │ express server │ → │  headless    │ → │ ffmpeg │
 │ caches + │   │ enrichment  │   │ (public/*)     │   │  chromium    │   │ libx264│
 │   env    │   │ (src/*.js)  │   │                │   │  (Playwright)│   │  → MP4 │
 └──────────┘   └─────────────┘   └───────────────┘   └──────────────┘   └────────┘
```

1. **`src/index.js`** parses the GPX, downsamples to ~3000 points, then in
   parallel reverse-geocodes start/stops/end (Nominatim), pulls nearby POIs
   (Overpass), fetches country border (Nominatim) and DEM elevations
   (Open-Meteo). Results are written to `<gpx>.cache.json` so repeat renders
   skip the network entirely.
2. **`src/server.js`** starts a tiny express app that serves `public/` plus
   one dynamic endpoint: `GET /api/config` hands the page the track data,
   the MapTiler key, and the computed `introFrames`.
3. **`public/index.html`** creates a MapLibre map, registers layers for
   satellite + 3D terrain + the trail polyline, exposes `window.setFrame` and
   `window.__prewarmTrail`, and signals `window.mapReady` / `window.frameReady`
   so the capture loop can drive it deterministically.
4. **`src/capture.js`** launches Playwright chromium, prewarms every tile
   along the trail path (the only reliable way to eliminate mid-recording
   color jumps), then walks frames 0..N calling `setFrame(i, total)` and
   screenshotting each to `output/frames/frame_NNNNN.jpg`.
5. **ffmpeg** encodes the frame sequence to H.264 MP4 (CRF 18, medium preset,
   faststart). The frame directory is deleted on success.

## Phase model

Duration is computed once in `src/render-config.js` from track distance and
overnight-stop count: `intro(9s) + trail(0.5 s/km, floor 20s) + dwell(2s × stops) + finish(4s)`.
Each frame's phase is determined by its frame index:

| phase | frame range | camera | what's on screen |
|---|---|---|---|
| **intro** | `0 .. introFrames-1` | globe → trail zoom, eased `0→TRAIL_ZOOM`, pitch `0→TRAIL_PITCH` | country border, big title, fading route label |
| **trail** | `introFrames .. end-FINISH` | constant-speed along smoothed path + rate-capped bearing EMA | day counter, segment `A → B` label, stop pins |
| **dwell** | (inside trail phase, at each stop) | camera frozen at stop, night overlay `sin(πt)` | day label, stop name |
| **finish** | last `FINISH_SEC × fps` frames | frozen at endpoint | finish label |

The trail→dwell→trail transitions are built up front as a single `frameMap`
in `buildTrailSchedule()` (`public/index.html`): a per-frame `(pointIndex,
dwellT)` lookup where `dwellT==0` means "moving" and `dwellT∈(0,1]` means
"night progress". The camera module consumes this through its own
`segFrames + breakIdxs` schedule so motion and dwell stay in lock-step.

## Dual-satellite LOD staging

`public/index.html` registers **two** satellite sources from the same MapTiler
endpoint:

```
satellite        minzoom 0  maxzoom 11   — full pyramid, used during intro globe zoom
satellite-trail  minzoom 11 maxzoom 11   — locked single LOD, used during trail phase
```

Both render layers are always present in the style; only their `visibility`
layout property is toggled, by `window.__setMapPhase(phase)`.

The swap happens 30 frames *before* the intro→trail boundary (frame
`introFrames - 30`), so the trail-phase tiles have time to finish loading
under the moving camera before they become the exclusive visible layer. The
intro layer is kept for the zoom-out because its low-zoom tiles are what make
the globe look like a globe — forcing the intro to run on `satellite-trail`
would show gray background at z1.5.

**Why this exists**: when rendering under pitch 50° with a full
`minzoom=0..maxzoom=11` satellite source, MapLibre progressively upgrades
horizon tiles from z9 → z10 → z11 as they come into view, and each upgrade is
a single-frame visual "seam" as one mosaic row gets sharper. Locking the
trail phase to a single LOD eliminates the progressive refinement —
everything is z11 or nothing. The investigation (see
`residual-jumps-investigation.md`) reclassified 12 of the 27 original
scene_score peaks as mosaic seams of this shape; the dual-source approach
eliminated them.

The terrain (DEM) source was **not** given the same treatment: a trial with
`minzoom=11` DEM resulted in flat terrain because MapLibre won't build the
far-horizon 3D mesh without lower-zoom DEM tiles. The residual mid-segment
peaks from DEM LOD refinement are accepted as the price of keeping the 3D
relief intact.

## Camera strategy interface

Each camera strategy is an ES module under `public/camera/` that exports:

```js
export const name = 'smooth-constant';
export function initIntro(pts) { /* called once, before intro */ }
export function initTrail(pts, stops, cfg) { /* called once, before trail */ }
export function getIntro(frameIndex, introFrames) { /* → {lon, lat, zoom, pitch, bearing, t} */ }
export function getTrail(trailFrame)              { /* → {lon, lat, zoom, pitch, bearing} */ }
```

`cfg` carries `{ trailFrames, dwellFrames, labelShowFrames, schedule }` where
`schedule` is the `{ breakIdxs, segFrames }` pair from `buildTrailSchedule`.
Strategies precompute a `camFrames[]` lookup in `initTrail` and read from it
in `getTrail`, so the per-frame hot path is a single array lookup + one
bearing EMA step.

The only strategy currently shipped is `smooth-constant`:
- **Position**: 2-pass box filter (window 100) approximating Gaussian σ≈41,
  anchored to raw coords via 60-frame linear ramps at start/end, then
  distributed along the smoothed path's own cumulative distance so camera
  speed is constant regardless of GPX sample density.
- **Segment ease**: `buildEasedPositions(N)` applies a 60-frame smoothstep
  at segment start/end, linear in the middle. This is the dwell-boundary
  velocity discontinuity fix — full-segment easing was tried and introduced
  new mid-segment peaks.
- **Bearing**: tangent of the smoothed path → circular moving average
  (window 160) → per-frame EMA with factor 0.03 → 1.8°/frame rate cap. The
  rate cap handles the 43s hairpin turn where the raw bearing derivative
  spikes to 4.8°/frame.
- **Zoom / pitch**: constant at `TRAIL_ZOOM=11.5` / `TRAIL_PITCH=50` during
  trail phase; eased from `(1.5, 0)` during intro.

All tunables are at the top of `public/camera/smooth-constant.js`. Changing
them should be validated with `src/jitter-metric.js` (for numeric smoothness)
and `npm run regress` (for the downstream scene_score baseline).

## Where each concern lives

| concern | file |
|---|---|
| GPX ingest, downsample, distance, stops | `src/parse-gpx.js` |
| Pacing constants + duration math | `src/render-config.js` |
| External enrichment (geocode, DEM, POIs, border) | `src/index.js` |
| HTTP config endpoint + static serving | `src/server.js` |
| Map style, layers, phase switch, prewarm, setFrame | `public/index.html` |
| Camera strategy (motion, bearing, easing) | `public/camera/smooth-constant.js` |
| Capture loop + ffmpeg encode | `src/capture.js` |
| Regression check (ffmpeg scene_score) | `scripts/regress.js` + `docs/regress-baseline.json` |
| Investigation history | `docs/residual-jumps-investigation.md` |
| Diagnostic tools guide | `docs/tooling.md` |
