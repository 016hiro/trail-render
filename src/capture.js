import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

function fmtMMSS(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export async function captureFrames({
  port,
  outputDir,
  totalFrames,
  fps,
  width,
  height,
  outputFile,
  introFrames = 0,
  finishFrames = 0,
  onProgress = () => {},
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
  onProgress({ type: 'phase', phase: 'prewarm' });
  const prewarmStart = Date.now();

  const prewarmDone = page.evaluate((tf) => window.__prewarmTrail(tf), totalFrames);

  let lastPct = -1;
  const progressTimer = setInterval(async () => {
    try {
      const pct = await page.evaluate(() => window.__prewarmProgress || 0);
      const intPct = Math.floor(pct * 100);
      onProgress({ type: 'prewarm', pct });
      if (intPct !== lastPct && intPct % 10 === 0) {
        console.log(`  prewarm ${intPct}%`);
        lastPct = intPct;
      }
    } catch {
      // Tight poll races with browser close once prewarm resolves; the awaited
      // prewarmDone promise is the source of truth, so swallow poll errors.
    }
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
  const trailEnd = totalFrames - finishFrames;
  const isTTY = Boolean(process.stderr.isTTY);
  const progressEvery = isTTY ? 1 : 60;

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

    const subphase = i < introFrames ? 'intro' : (i >= trailEnd ? 'finish' : 'trail');
    onProgress({
      type: 'capture',
      subphase,
      frame: i,
      totalFrames,
      elapsedMs: Date.now() - t0,
    });

    if (i % progressEvery === 0 || i === totalFrames - 1) {
      const label = subphase === 'trail' ? 'trail ' : (subphase === 'intro' ? 'intro ' : 'finish');
      const pct = ((i / totalFrames) * 100).toFixed(1).padStart(5);
      const elapsed = fmtMMSS((Date.now() - t0) / 1000);
      const perFrame = (Date.now() - t0) / (i + 1);
      const eta = fmtMMSS(((totalFrames - i - 1) * perFrame) / 1000);
      const line = `  [${label}] ${pct}%  ${String(i).padStart(5)}/${totalFrames}  ${elapsed} elapsed · ETA ${eta}`;
      if (isTTY) process.stderr.write('\r' + line + '\x1b[K');
      else console.log(line);
    }
  }
  if (isTTY) process.stderr.write('\n');

  await browser.close();
  console.log('Browser closed.');

  // Encode with ffmpeg.
  // The -vf chain is critical: JPEG inputs default to full-range YUV, which
  // ffmpeg then tags as `yuvj420p`. Browsers (especially Chrome/Safari) hate
  // that non-standard tag and stall a second into playback. The scale filter
  // converts full→limited range; format=yuv420p produces the canonical tag.
  onProgress({ type: 'phase', phase: 'encode' });
  console.log('Encoding MP4...');
  const cmd = [
    'ffmpeg', '-y',
    '-framerate', String(fps),
    '-i', path.join(framesDir, 'frame_%05d.jpg'),
    '-c:v', 'libx264',
    '-vf', 'scale=in_range=full:out_range=tv,format=yuv420p',
    '-color_range', 'tv',
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
