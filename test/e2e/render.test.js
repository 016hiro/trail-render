// End-to-end test: drives the full render pipeline against the committed
// demo GPX, then runs the scene_score regression check on the resulting MP4
// to prove the baseline still holds.
//
// Skipped automatically when MAPTILER_KEY is not set so CI / cold clones do
// not fail. To run locally:
//
//   MAPTILER_KEY=... bun run test:e2e
//
// First run on a fresh clone does network enrichment (DEM, geocoding,
// POIs) — subsequent runs reuse activity_580930440.cache.json.

import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.join(import.meta.dir, '..', '..');
const DEMO_GPX = path.join(REPO, 'activity_580930440.gpx');
const OUT_MP4 = path.join(REPO, 'output', 'e2e_test.mp4');

const E2E_TIMEOUT = 30 * 60 * 1000; // 30 minutes — generous for first-run network enrichment

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

test.skipIf(!process.env.MAPTILER_KEY)(
  'e2e: render demo GPX and pass scene_score regression against committed baseline',
  async () => {
    expect(fs.existsSync(DEMO_GPX)).toBe(true);

    // Clean prior artifact so we cannot pass by accident on a stale file.
    if (fs.existsSync(OUT_MP4)) fs.unlinkSync(OUT_MP4);

    await run('bun', ['src/index.js', DEMO_GPX, '--output', OUT_MP4]);

    expect(fs.existsSync(OUT_MP4)).toBe(true);
    const { size } = fs.statSync(OUT_MP4);
    expect(size).toBeGreaterThan(50 * 1024 * 1024);

    // This will exit non-zero if the render has regressed against
    // docs/regress-baseline.json — our guard rail for camera / LOD changes.
    await run('bun', ['scripts/regress.js', OUT_MP4]);
  },
  E2E_TIMEOUT,
);
