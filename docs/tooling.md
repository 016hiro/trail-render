# Diagnostic tooling

Four scripts sit alongside the renderer. Each answers a different question,
and they live in `src/` (not `scripts/`) because they share the renderer's
camera / parse code.

## `src/detect-lod-jumps.js` — "what the camera actually saw"

Reuses `src/index.js`'s exact setFrame loop under Playwright, but instead of
capturing screenshots it records per-frame state: tile ids per source
(`satellite`, `satellite-trail`, `terrain-src`), canvas luma + laplacian
metrics, and full camera pose. Writes `output/lod_report.json`.

Use when:
- A scene_score peak fires and you need to know *why* — LOD tile swap? dwell
  boundary? phase transition? bearing spike?
- You want to cross-reference ffmpeg peaks against tile upgrades/downgrades.

Run:
```sh
MAPTILER_KEY=... npm run detect:lod activity_580930440.gpx
# optional: scan only a window
MAPTILER_KEY=... npm run detect:lod activity_580930440.gpx --start-frame 720 --end-frame 780
```

Output is large (15+ MB for a full track). Read `events`, `suspiciousFrames`,
and individual `frames[i].sources[sourceId].renderableTiles` to attribute
causes. See `docs/residual-jumps-investigation.md` for worked examples.

## `src/jitter-metric.js` — "how smooth is the camera motion, quantitatively"

Drives the full frame loop in Playwright but only reads `map.getCenter()` and
`map.getBearing()` per frame — no screenshots, no tile state. Computes
position / bearing / velocity derivatives and reports:

- `posAccelRMS` / `posAccelMax` — m/frame², position jerk
- `bearAccelRMS` / `bearAccelMax` — °/frame², turn jerk
- `posVelCV` — coefficient of variation of speed (0 = perfectly constant)
- `freezeFrames` — count of sub-0.1m stutters
- `composite` — weighted overall score

Use when:
- You changed `SMOOTH_WINDOW`, `BEARING_WINDOW`, `EASE_FRAMES`, or `MAX_BEARING_RATE`
  in `public/camera/smooth-constant.js` and want a numeric before/after.
- A render *looks* janky but scene_score isn't flagging it — jitter can live
  below the ffmpeg delta threshold.

Run:
```sh
MAPTILER_KEY=... node src/jitter-metric.js activity_580930440.gpx
```

Writes `output/jitter_report.json`. Lower is better on every metric.

## `src/camera-sweep.js` — "which camera parameters would be best"

Pure math, no browser. Reimplements the moving-average smoothing + constant-
speed frame distribution from `public/camera/smooth-constant.js` and sweeps a
grid of `(SMOOTH_WINDOW, SMOOTH_PASSES, BEARING_WINDOW)` combos in seconds,
printing a table sorted by each smoothness metric.

Use when:
- You want to retune the camera after changing the track profile (very hilly
  vs. flat, long vs. short), without rendering a video per combo.

Run:
```sh
node src/camera-sweep.js activity_580930440.gpx
```

Writes `output/sweep_results.json`. The *result* of this tool is a set of
proposed constants to paste into `smooth-constant.js` — it does not modify
the code. Always validate a proposal with `jitter-metric.js` (browser math)
and then a full render + `npm run regress`.

## `src/benchmark.js` — "how fast is the capture pipeline"

Microbenchmark that captures 60 frames with two pipeline variants (PNG + 40ms
settle delay vs. JPEG quality-92 with no delay) and reports ms/frame. This is
the tool that justified switching to JPEG q92 in `capture.js`.

Use when:
- Someone proposes changing screenshot format, delay, quality, or
  viewport/page config and you want a speed delta.

Run:
```sh
MAPTILER_KEY=... node src/benchmark.js activity_580930440.gpx
```

No report file — output is printed directly. Not part of any CI path.

## Relationship to the regression check

`scripts/regress.js` (invoked by `npm run regress`) is the *end-to-end*
guardrail — it runs on the final MP4 and has a committed baseline. The four
tools above are *investigation* aids: you reach for them when regress.js
fires, or when you are making an intentional change and want to understand
the shape of the effect before re-rendering.
