// End-to-end test: drives the full render pipeline against the committed
// demo GPX, then runs the scene_score regression check on the resulting MP4
// to prove the baseline still holds.
//
// Skipped automatically when MAPTILER_KEY is not set so CI / cold clones do
// not fail. To run locally:
//
//   MAPTILER_KEY=... npm run test:e2e
//
// First run on a fresh clone does network enrichment (DEM, geocoding,
// POIs) — subsequent runs reuse activity_580930440.cache.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');
const DEMO_GPX = path.join(REPO, 'activity_580930440.gpx');
const OUT_MP4 = path.join(REPO, 'output', 'e2e_test.mp4');

// node:test treats any value (including `null`) in the `skip` option as a
// request to skip, so only attach it when we actually want to skip.
const testOpts = { timeout: 30 * 60 * 1000 };
if (!process.env.MAPTILER_KEY) {
  testOpts.skip = 'MAPTILER_KEY not set — export one to run the e2e pipeline';
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: REPO });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

test(
  'e2e: render demo GPX and pass scene_score regression against committed baseline',
  testOpts,
  async () => {
    assert.ok(fs.existsSync(DEMO_GPX), 'demo GPX missing from repo root');

    // Clean prior artifact so we cannot pass by accident on a stale file.
    if (fs.existsSync(OUT_MP4)) fs.unlinkSync(OUT_MP4);

    await run('node', ['src/index.js', DEMO_GPX, '--output', OUT_MP4]);

    assert.ok(fs.existsSync(OUT_MP4), `expected MP4 at ${OUT_MP4}`);
    const { size } = fs.statSync(OUT_MP4);
    assert.ok(size > 50 * 1024 * 1024, `MP4 is suspiciously small (${size} bytes)`);

    // This will exit non-zero if the render has regressed against
    // docs/regress-baseline.json — our guard rail for camera / LOD changes.
    await run('node', ['scripts/regress.js', OUT_MP4]);
  },
);
