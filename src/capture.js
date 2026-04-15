import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

function fmtMMSS(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

class CancelledError extends Error {
  constructor(msg = 'Render cancelled') {
    super(msg);
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}

function checkAborted(signal) {
  if (signal?.aborted) throw new CancelledError();
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
  signal,
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
  // If cancellation arrives at any point, force the browser closed. The
  // capture loop's signal check will see the error and exit.
  const onAbortClose = () => { browser.close().catch(() => {}); };
  signal?.addEventListener('abort', onAbortClose, { once: true });

  try {
    const page = await browser.newPage({ viewport: { width, height } });

    console.log('Loading map...');
    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForFunction('window.mapReady === true', { timeout: 90000 });

    await page.waitForTimeout(2000);
    checkAborted(signal);

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

    try { await prewarmDone; } finally { clearInterval(progressTimer); }
    checkAborted(signal);
    console.log(`Pre-warm complete in ${((Date.now() - prewarmStart) / 1000).toFixed(1)}s.`);

    await page.evaluate(() => {
      const p0 = window.__trackPoints[0];
      map.jumpTo({ center: [p0.lon, p0.lat], zoom: 1.5, pitch: 0, bearing: 0 });
    });
    await page.waitForTimeout(2000);
    checkAborted(signal);

    console.log(`Capturing ${totalFrames} frames at ${width}x${height}...`);
    const t0 = Date.now();
    const trailEnd = totalFrames - finishFrames;
    const isTTY = Boolean(process.stderr.isTTY);
    const progressEvery = isTTY ? 1 : 60;

    for (let i = 0; i < totalFrames; i++) {
      checkAborted(signal);
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
  } finally {
    signal?.removeEventListener('abort', onAbortClose);
    if (browser.isConnected()) await browser.close().catch(() => {});
    console.log('Browser closed.');
  }

  checkAborted(signal);

  // Encode with ffmpeg.
  // The -vf chain is critical: JPEG inputs default to full-range YUV, which
  // ffmpeg then tags as `yuvj420p`. Browsers (especially Chrome/Safari) hate
  // that non-standard tag and stall a second into playback. The scale filter
  // converts full→limited range; format=yuv420p produces the canonical tag.
  // Using spawn (not execSync) so we can SIGTERM ffmpeg if the user cancels.
  onProgress({ type: 'phase', phase: 'encode' });
  console.log('Encoding MP4...');
  await runFfmpeg([
    '-y',
    '-framerate', String(fps),
    '-i', path.join(framesDir, 'frame_%05d.jpg'),
    '-c:v', 'libx264',
    '-vf', 'scale=in_range=full:out_range=tv,format=yuv420p',
    '-color_range', 'tv',
    '-crf', '18',
    '-preset', 'medium',
    '-movflags', '+faststart',
    outputFile,
  ], signal);
  console.log(`Video saved: ${outputFile}`);

  await fs.rm(framesDir, { recursive: true });
  console.log('Frames cleaned up.');
}

function runFfmpeg(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: 'inherit' });
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('exit', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new CancelledError('ffmpeg cancelled'));
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited code=${code} signal=${sig}`));
    });
  });
}
