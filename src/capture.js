import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

export async function captureFrames({
  port,
  outputDir,
  totalFrames,
  fps,
  width,
  height,
  outputFile,
}) {
  const framesDir = path.join(outputDir, 'frames');
  await fs.mkdir(framesDir, { recursive: true });

  console.log('Launching headless browser...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
    ],
  });

  const page = await browser.newPage({ viewport: { width, height } });

  console.log('Loading map...');
  await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForFunction('window.mapReady === true', { timeout: 90000 });

  // Wait for initial map render
  await page.waitForTimeout(2000);

  // Pre-warm tile cache for the ENTIRE trail before recording.
  // Walks 40 keypoints at the actual recording zoom/pitch and trail-tangent
  // bearing, waiting for all satellite + DEM tiles at each. This is the only
  // reliable way to eliminate mid-recording color jumps caused by terrain DEM
  // tiles arriving and rebuilding the mesh under a fixed camera.
  console.log('Pre-warming all trail tiles (this takes ~20-40s)...');
  const prewarmStart = Date.now();

  // Kick off prewarm in the page (don't await — we'll poll progress).
  // Pass totalFrames so prewarm can mirror the exact camera trajectory.
  const prewarmDone = page.evaluate((tf) => window.__prewarmTrail(tf), totalFrames);

  // Poll progress so the user sees something happening
  let lastPct = -1;
  const progressTimer = setInterval(async () => {
    try {
      const pct = await page.evaluate(() => window.__prewarmProgress || 0);
      const intPct = Math.floor(pct * 100);
      if (intPct !== lastPct && intPct % 10 === 0) {
        console.log(`  prewarm ${intPct}%`);
        lastPct = intPct;
      }
    } catch (_) {}
  }, 500);

  await prewarmDone;
  clearInterval(progressTimer);
  console.log(`Pre-warm complete in ${((Date.now() - prewarmStart) / 1000).toFixed(1)}s.`);

  // Reset to globe view so intro plays correctly
  await page.evaluate(() => {
    const p0 = window.__trackPoints[0];
    map.jumpTo({ center: [p0.lon, p0.lat], zoom: 1.5, pitch: 0, bearing: 0 });
  });
  await page.waitForTimeout(2000); // settle: globe-view tiles need to load too

  console.log(`Capturing ${totalFrames} frames at ${width}x${height}...`);
  const t0 = Date.now();

  for (let i = 0; i < totalFrames; i++) {
    await page.evaluate(
      ([fi, tf]) => window.setFrame(fi, tf),
      [i, totalFrames],
    );
    await page.waitForFunction('window.frameReady === true', { timeout: 10000 });

    await page.screenshot({
      path: path.join(framesDir, `frame_${String(i).padStart(5, '0')}.jpg`),
      type: 'jpeg',
      quality: 92,
    });

    if (i % 60 === 0 || i === totalFrames - 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const pct = ((i / totalFrames) * 100).toFixed(1);
      const perFrame = (Date.now() - t0) / (i + 1);
      const eta = (((totalFrames - i - 1) * perFrame) / 1000).toFixed(0);
      console.log(`  ${pct}%  frame ${i}/${totalFrames}  (${elapsed}s elapsed, ~${eta}s left)`);
    }
  }

  await browser.close();
  console.log('Browser closed.');

  // Encode with ffmpeg
  console.log('Encoding MP4...');
  const cmd = [
    'ffmpeg', '-y',
    '-framerate', String(fps),
    '-i', path.join(framesDir, 'frame_%05d.jpg'),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '18',
    '-preset', 'medium',
    '-movflags', '+faststart',
    outputFile,
  ].join(' ');

  execSync(cmd, { stdio: 'inherit' });
  console.log(`Video saved: ${outputFile}`);

  // Cleanup frames
  await fs.rm(framesDir, { recursive: true });
  console.log('Frames cleaned up.');
}
