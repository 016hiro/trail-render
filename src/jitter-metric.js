/**
 * Camera jitter benchmark — captures camera state for every frame
 * and computes quantitative smoothness metrics.
 *
 * Metrics:
 *   posAccelRMS   — RMS of position acceleration (m/frame²), lower = smoother
 *   bearAccelRMS  — RMS of bearing acceleration (°/frame²), lower = smoother
 *   posAccelMax   — worst single-frame position jerk
 *   bearAccelMax  — worst single-frame bearing jerk
 *   posVelCV      — coefficient of variation of speed (0 = perfectly constant)
 *   freezeFrames  — number of frames with <0.1m movement (stutters)
 *   composite     — weighted overall score (lower = better)
 */

import { chromium } from 'playwright';
import { startServer } from './server.js';
import { parseGPX } from './parse-gpx.js';
import fs from 'fs';

const gpxFile = process.argv[2];
if (!gpxFile) { console.error('Usage: node src/jitter-metric.js <path/to/track.gpx>'); process.exit(1); }

async function run() {
  // Parse and enrich
  const data = parseGPX(gpxFile);
  const cacheFile = gpxFile.replace(/\.gpx$/i, '.cache.json');
  if (fs.existsSync(cacheFile)) {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    Object.assign(data, {
      startName: cache.startName, endName: cache.endName,
      country: cache.country, countryBorder: cache.countryBorder,
      pois: cache.pois, segments: cache.segments,
    });
  }

  const apiKey = process.env.MAPTILER_KEY;
  if (!apiKey) { console.error('MAPTILER_KEY env var is required.'); process.exit(1); }
  const introFrames = 270; // 9s @ 30fps
  const server = await startServer(data, apiKey, 3458, introFrames);

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('http://localhost:3458', { timeout: 90000 });
  await page.waitForFunction(() => window.mapReady, { timeout: 90000 });

  // Compute total frames (same logic as index.js)
  const stops = data.stops.length;
  const distKm = data.totalDistance / 1000;
  const introSec = 9, dwellSec = 2, finishSec = 4, fps = 30;
  const trailSec = Math.max(20, distKm * 0.5);
  const totalSec = introSec + trailSec + stops * dwellSec + finishSec;
  const totalFrames = Math.round(totalSec * fps);

  console.log(`Sampling ${totalFrames} frames (trail only: ${totalFrames - introFrames})...`);

  // Only measure trail phase (skip intro)
  const states = [];
  const t0 = Date.now();
  for (let f = 0; f < totalFrames; f++) {
    await page.evaluate(({ fi, tf }) => window.setFrame(fi, tf), { fi: f, tf: totalFrames });
    await page.waitForFunction(() => window.frameReady, { timeout: 10000 });

    if (f >= introFrames) {
      const s = await page.evaluate(() => {
        const c = map.getCenter();
        return { lon: c.lng, lat: c.lat, bear: map.getBearing() };
      });
      states.push(s);
    }

    if (f % 300 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  frame ${f}/${totalFrames}  (${elapsed}s)`);
    }
  }

  await browser.close();
  server.close();

  // === Compute metrics ===
  const n = states.length;

  // Position: convert to meters
  const pos = states.map(s => ({
    x: s.lon * 111320 * Math.cos(s.lat * Math.PI / 180),
    y: s.lat * 111320,
  }));

  // Velocity (m/frame)
  const vel = [];
  for (let i = 1; i < n; i++) {
    const dx = pos[i].x - pos[i - 1].x;
    const dy = pos[i].y - pos[i - 1].y;
    vel.push(Math.sqrt(dx * dx + dy * dy));
  }

  // Classify frames: moving (vel > threshold) vs dwell
  const MOVE_THRESH = 1.0; // m/frame — below this is "dwell"
  const isMoving = vel.map(v => v > MOVE_THRESH);

  // Separate "mid-movement" accel from "transition" accel
  // A transition frame = frame where isMoving changes
  const midAccel = [];     // accel during continuous movement
  const transAccel = [];   // accel at movement↔dwell boundaries
  const midBearAccel = []; // bearing accel during movement

  // Bearing velocity (°/frame) — circular difference
  const bearVel = [];
  for (let i = 1; i < n; i++) {
    bearVel.push(((states[i].bear - states[i - 1].bear + 540) % 360) - 180);
  }

  for (let i = 1; i < vel.length; i++) {
    const accel = Math.abs(vel[i] - vel[i - 1]);
    const bAccel = Math.abs(bearVel[i] - bearVel[i - 1]);
    const isTransition = isMoving[i] !== isMoving[i - 1];

    if (isTransition) {
      transAccel.push(accel);
    } else if (isMoving[i] && isMoving[i - 1]) {
      midAccel.push(accel);
      midBearAccel.push(bAccel);
    }
  }

  // Statistics helpers
  const rms = arr => arr.length ? Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length) : 0;
  const mean = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const std = arr => { const m = mean(arr); return arr.length ? Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length) : 0; };
  const max = arr => arr.length ? arr.reduce((m, v) => v > m ? v : m, 0) : 0;
  const p95 = arr => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * 0.95)]; };
  const p99 = arr => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * 0.99)]; };

  const movingVel = vel.filter(v => v > MOVE_THRESH);
  const posVelCV = movingVel.length > 0 ? std(movingVel) / mean(movingVel) : 0;
  const freezeFrames = vel.filter(v => v < 0.1).length;

  // Moving bearing velocity stats
  const movingBearVel = [];
  for (let i = 0; i < bearVel.length; i++) {
    if (isMoving[i]) movingBearVel.push(Math.abs(bearVel[i]));
  }
  const bearVelCV = movingBearVel.length > 0 ? std(movingBearVel) / (mean(movingBearVel) || 1) : 0;

  console.log('\n' + '='.repeat(60));
  console.log('  CAMERA JITTER METRICS  (trail phase)');
  console.log('='.repeat(60));
  console.log(`  Frames:  ${n} total, ${movingVel.length} moving, ${vel.length - movingVel.length} dwell`);
  console.log('');
  console.log('  ┌─ Position jitter (m/frame²) — lower = smoother ─┐');
  console.log(`  │  Accel RMS:    ${rms(midAccel).toFixed(3).padStart(8)}                        │`);
  console.log(`  │  Accel P95:    ${p95(midAccel).toFixed(3).padStart(8)}                        │`);
  console.log(`  │  Accel P99:    ${p99(midAccel).toFixed(3).padStart(8)}                        │`);
  console.log(`  │  Accel Max:    ${max(midAccel).toFixed(3).padStart(8)}                        │`);
  console.log(`  │  Velocity CV:  ${posVelCV.toFixed(4).padStart(8)}  (0=constant speed)   │`);
  console.log('  └──────────────────────────────────────────────────┘');
  console.log('  ┌─ Rotation jitter (°/frame²) — lower = smoother ──┐');
  console.log(`  │  Accel RMS:    ${rms(midBearAccel).toFixed(4).padStart(8)}                        │`);
  console.log(`  │  Accel P95:    ${p95(midBearAccel).toFixed(4).padStart(8)}                        │`);
  console.log(`  │  Accel P99:    ${p99(midBearAccel).toFixed(4).padStart(8)}                        │`);
  console.log(`  │  Accel Max:    ${max(midBearAccel).toFixed(4).padStart(8)}                        │`);
  console.log(`  │  BearVel CV:   ${bearVelCV.toFixed(4).padStart(8)}  (0=constant turn)    │`);
  console.log('  └──────────────────────────────────────────────────┘');
  console.log('  ┌─ Transitions (movement ↔ dwell) ─────────────────┐');
  console.log(`  │  Count:        ${String(transAccel.length).padStart(8)}                        │`);
  console.log(`  │  Max spike:    ${max(transAccel).toFixed(1).padStart(8)} m/frame²              │`);
  console.log(`  │  Freeze (<0.1m): ${String(freezeFrames).padStart(6)}                        │`);
  console.log('  └──────────────────────────────────────────────────┘');
  console.log('='.repeat(60));

  // Save raw data for comparison
  const report = {
    position: {
      accelRMS: +rms(midAccel).toFixed(3),
      accelP95: +p95(midAccel).toFixed(3),
      accelP99: +p99(midAccel).toFixed(3),
      accelMax: +max(midAccel).toFixed(3),
      velCV: +posVelCV.toFixed(4),
      velMean: +mean(movingVel).toFixed(1),
    },
    rotation: {
      accelRMS: +rms(midBearAccel).toFixed(4),
      accelP95: +p95(midBearAccel).toFixed(4),
      accelP99: +p99(midBearAccel).toFixed(4),
      accelMax: +max(midBearAccel).toFixed(4),
      bearVelCV: +bearVelCV.toFixed(4),
    },
    transition: {
      count: transAccel.length,
      maxSpike: +max(transAccel).toFixed(1),
      freezeFrames,
    },
    meta: { movingFrames: movingVel.length, totalFrames: n },
  };
  fs.writeFileSync('output/jitter_report.json', JSON.stringify(report, null, 2));
  console.log('\nSaved: output/jitter_report.json');
}

run().catch(e => { console.error(e); process.exit(1); });
