# trail-render

Turn a GPX track into a cinematic 1080p flyover video. A headless browser
renders satellite + 3D terrain on a MapLibre map, walks the camera along the
smoothed route with per-segment easing and rate-capped rotation, and ffmpeg
packs the frames into an H.264 MP4.

[中文版 README](README.zh.md) · [architecture](docs/architecture.md) · [residual-jumps investigation](docs/residual-jumps-investigation.md) · [diagnostic tooling](docs/tooling.md)

## What it looks like

- **Intro** — 9s zoom from globe view into the start point, country border
  highlighted.
- **Trail** — camera tracks the GPX at a constant pace (0.5 s/km by default)
  with overnight-stop dwells, smoothstep easing at every segment boundary, and
  a 1.8°/frame cap on turn rate so hairpins don't flick.
- **Finish** — 4s hold on the end label.

## Requirements

- Node.js ≥ 20 (uses native `fetch`, `AbortSignal.timeout`, top-level `await`).
- `ffmpeg` on PATH. `brew install ffmpeg` on macOS, `apt install ffmpeg` on
  Debian/Ubuntu.
- A MapTiler API key (free tier works). Create one at
  <https://www.maptiler.com/> and export it:
  ```sh
  cp .env.example .env     # or just export the var directly
  export MAPTILER_KEY=...
  ```
- Playwright's chromium build, installed once:
  ```sh
  npm install
  npx playwright install chromium
  ```

## Quick start

```sh
# render the demo GPX committed at the repo root
MAPTILER_KEY=... npm start activity_580930440.gpx

# preview in a real browser (no capture, just serves the map)
MAPTILER_KEY=... npm run preview activity_580930440.gpx
# then open http://localhost:3456

# render your own track
MAPTILER_KEY=... npm start path/to/my-hike.gpx --output output/my-hike.mp4
```

Common flags:

| flag | default | meaning |
|---|---|---|
| `--fps N` | 30 | output frame rate |
| `--width N` / `--height N` | 1920 / 1080 | output resolution |
| `--output PATH` | `output/trail.mp4` | final MP4 path |
| `--duration SECS` | auto | override total length (auto = intro 9s + 0.5 s/km trail + 2 s/stop + 4 s finish) |
| `--title NAME` | (reverse geocoded) | start-point label |
| `--end NAME` | (reverse geocoded) | end-point label |
| `--name TRAIL_NAME` | (none) | big trail title shown during intro |
| `--preview` | off | serve the map without capturing |

On first run for a new GPX, the script fetches DEM elevation, reverse geocodes
the start/stops/end, pulls nearby POIs (peaks/passes/lakes) and country border
from Overpass + Nominatim, then writes a `<gpx>.cache.json` next to the GPX so
subsequent renders skip all network calls.

## Testing

Two tiers, both green on a fresh checkout:

```sh
npm test         # 33 unit tests, ~2 s, no credentials needed
npm run test:e2e # full pipeline: render demo GPX → MP4 → scene_score regression, ~3:30
```

The unit suite exercises the duration math (`src/render-config.js`), the GPX
parser against the committed `activity_580930440.gpx`, the tile-diff helpers in
`src/lod-analysis.js`, and the `bucket()` in `scripts/regress.js`. It imports
the pure modules directly via `node:test` (zero dev dependencies).

The e2e test (`test/e2e/render.test.js`) spawns the real `src/index.js`
pipeline against the committed GPX, asserts the MP4 is produced at a sane
size, then runs `scripts/regress.js` against it and fails if the scene_score
baseline in `docs/regress-baseline.json` regresses. It lives in a subdirectory
so the default `npm test` glob (`test/*.test.js`) ignores it, and it
**skips automatically when `MAPTILER_KEY` is unset** — CI / cold clones
won't fail on it.

## Regression check

Camera and LOD changes are validated against an ffmpeg `scene_score` baseline
(the metric built in [`docs/residual-jumps-investigation.md`](docs/residual-jumps-investigation.md)).
After any render, run:

```sh
npm run regress output/my-render.mp4
```

This fails if `peaks≥0.08` regress at all, `peaks≥0.05` regress by more than 2,
`peaks≥0.025` regress by more than 5, or the max `scene_score` increases by
more than 20% vs. `docs/regress-baseline.json`. To lock in a new baseline (only
after confirming the video is acceptable):

```sh
npm run regress output/my-render.mp4 -- --update-baseline
```

`npm run test:e2e` wraps exactly this check around a full render, so it is
the one-shot way to verify that a change did not break the pipeline end-to-end.

## Repository layout

```
src/
  index.js            main renderer entry point (CLI + pipeline)
  render-config.js    shared duration/pacing constants
  parse-gpx.js        GPX → downsampled point list + bounds + stops
  server.js           tiny express server that hands trackData + config to the page
  capture.js          Playwright capture loop + ffmpeg encode
  lod-analysis.js     pure tile-diff helpers (used by detect-lod-jumps + tests)
  detect-lod-jumps.js instrumented Playwright scan that records per-frame tile state
  camera-sweep.js     offline camera-parameter sweep (no browser)
  jitter-metric.js    quantitative camera smoothness benchmark
  benchmark.js        capture-pipeline microbenchmark

public/
  index.html          MapLibre page: layers, phases, prewarm, setFrame API
  camera/
    smooth-constant.js current camera strategy (MA smoothing + constant speed)

scripts/
  regress.js          scene_score regression check (used by `npm run regress`)

test/
  render-config.test.js parse-gpx.test.js lod-analysis.test.js regress.test.js
  e2e/
    render.test.js    full pipeline e2e against the committed GPX

docs/
  architecture.md                   pipeline, phases, LOD staging, camera interface
  tooling.md                        diagnostic scripts — when to use each
  residual-jumps-investigation.md   how the metric + fixes were built
  regress-baseline.json             committed scene_score baseline
```

## License

[MIT](LICENSE)
