import { parseGPX } from './parse-gpx.js';
import { startServer } from './server.js';
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const API_KEY = process.env.MAPTILER_KEY;
if (!API_KEY) {
  console.error('MAPTILER_KEY env var is required.');
  process.exit(1);
}
const FRAMES = 60;
const TOTAL_FRAMES = 1800;

async function main() {
  const gpxFile = process.argv[2];
  if (!gpxFile) { console.error('Usage: bun src/benchmark.js <path/to/track.gpx>'); process.exit(1); }
  const trackData = parseGPX(gpxFile);
  const server = await startServer(trackData, API_KEY, 3456);

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  await page.goto('http://localhost:3456', { waitUntil: 'networkidle' });
  await page.waitForFunction('window.mapReady === true', { timeout: 60000 });
  await page.waitForTimeout(4000);

  const dir = '/tmp/bench_frames';
  await fs.mkdir(dir, { recursive: true });

  const startFrame = 250;

  // --- OLD pipeline: PNG + 40ms delay ---
  let tOld = 0;
  for (let i = 0; i < FRAMES; i++) {
    const fi = startFrame + i;
    const t = performance.now();
    await page.evaluate(([f, tf]) => window.setFrame(f, tf), [fi, TOTAL_FRAMES]);
    await page.waitForFunction('window.frameReady === true', { timeout: 10000 });
    await page.waitForTimeout(40);
    await page.screenshot({ path: path.join(dir, `old_${i}.png`), type: 'png' });
    tOld += performance.now() - t;
  }

  // --- NEW pipeline: JPEG q92, no delay ---
  let tNew = 0;
  for (let i = 0; i < FRAMES; i++) {
    const fi = startFrame + i;
    const t = performance.now();
    await page.evaluate(([f, tf]) => window.setFrame(f, tf), [fi, TOTAL_FRAMES]);
    await page.waitForFunction('window.frameReady === true', { timeout: 10000 });
    await page.screenshot({ path: path.join(dir, `new_${i}.jpg`), type: 'jpeg', quality: 92 });
    tNew += performance.now() - t;
  }

  const oldAvg = tOld / FRAMES;
  const newAvg = tNew / FRAMES;
  const speedup = oldAvg / newAvg;

  console.log(`\n=== Benchmark: ${FRAMES} frames ===`);
  console.log(`OLD (PNG + 40ms delay):  ${oldAvg.toFixed(1)} ms/frame  → 1800f = ${(oldAvg * 1800 / 1000).toFixed(0)}s`);
  console.log(`NEW (JPEG q92, no delay): ${newAvg.toFixed(1)} ms/frame  → 1800f = ${(newAvg * 1800 / 1000).toFixed(0)}s`);
  console.log(`Speedup: ${speedup.toFixed(1)}x`);

  await fs.rm(dir, { recursive: true });
  await browser.close();
  server.close();
}

main().catch(console.error);
