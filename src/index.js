// CLI entry point. Thin wrapper around src/job-runner.js — argv parsing,
// environment checks, and a console-based onProgress sink. The render
// pipeline itself lives in job-runner.js so the web server (src/web-server.js)
// can drive it with a structured progress callback instead of stdout parsing.

import { runJob, prepareTrackData, fileExists } from './job-runner.js';
import { startServer } from './server.js';
import { computeRenderConfig } from './render-config.js';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';

const API_KEY = process.env.MAPTILER_KEY;
if (!API_KEY) {
  console.error('MAPTILER_KEY env var is required. Get a key at https://www.maptiler.com/ and export MAPTILER_KEY=... (or put it in .env).');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);

  const gpxFile = args.find(a => a.endsWith('.gpx'));
  if (!gpxFile) {
    console.error('Usage: bun start <path/to/track.gpx>\n'
      + '  [--fps 30] [--width 1920] [--height 1080] [--output output/trail.mp4] [--preview]\n'
      + '  [--duration SECS] [--title NAME] [--end NAME] [--name TRAIL_NAME]\n'
      + '  [--pace SEC_PER_KM] [--intro SECS]');
    process.exit(1);
  }
  if (!(await fileExists(gpxFile))) {
    console.error(`GPX file not found: ${gpxFile}`);
    process.exit(1);
  }

  const fps     = parseInt(flag(args, '--fps') || '30');
  const width   = parseInt(flag(args, '--width') || '1920');
  const height  = parseInt(flag(args, '--height') || '1080');
  const output  = flag(args, '--output') || 'output/trail.mp4';
  const preview = args.includes('--preview');
  const title   = flag(args, '--title') || undefined;
  const end     = flag(args, '--end') || undefined;
  const name    = flag(args, '--name') || undefined;
  const pace    = parseFloatFlag(args, '--pace');
  const intro   = parseFloatFlag(args, '--intro');
  const duration = flag(args, '--duration') ? parseInt(flag(args, '--duration')) : undefined;
  const port    = 3456;

  if (!preview) await preflight();

  const onProgress = cliProgressSink();

  if (preview) {
    const trackData = await prepareTrackData({ gpxPath: gpxFile, title, end, onProgress });
    const overrides = {};
    if (pace != null) overrides.trailPace = pace;
    if (intro != null) overrides.introSec = intro;
    const auto = computeRenderConfig(trackData, fps, overrides);
    await startServer(trackData, API_KEY, port, auto.introFrames, name ? { trailName: name } : {});
    console.log(`\nPreview: http://localhost:${port}\nCtrl+C to stop.`);
    return; // keep process alive; server listens
  }

  await runJob({
    gpxPath: gpxFile, output, apiKey: API_KEY,
    fps, width, height, duration,
    title, end, name, pace, intro,
    port, onProgress,
  });

  console.log('Done!');
  process.exit(0);
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function parseFloatFlag(args, name) {
  const v = flag(args, name);
  if (v === null) return null;
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`Invalid value for ${name}: ${v}`);
    process.exit(1);
  }
  return n;
}

function cliProgressSink() {
  // The runner's log-level events carry the human-readable lines that the CLI
  // used to emit inline. Capture progress is handled inside capture.js with its
  // own TTY-aware renderer, so we just forward 'log' events to stdout/stderr.
  return (evt) => {
    if (evt.type === 'log') {
      if (evt.level === 'warn') console.warn(evt.message);
      else console.log(evt.message);
    } else if (evt.type === 'track') {
      console.log(`  ${evt.totalPoints} points -> ${evt.downsampled} (downsampled)`);
      console.log(`  Distance: ${evt.distanceKm.toFixed(1)} km`);
      console.log(`  Elevation: ${Math.round(evt.minEle)}m - ${Math.round(evt.maxEle)}m`);
      console.log(`  Stops: ${evt.stops}`);
    }
    // 'plan', 'capture', 'prewarm', 'phase' events are surfaced by capture.js
    // and job-runner.js via console.log/stderr already; nothing extra here.
  };
}

async function preflight() {
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); }
  catch { console.error('ffmpeg not found. Install: brew install ffmpeg  (macOS) | apt install ffmpeg  (Debian)'); process.exit(1); }

  try {
    const exe = chromium.executablePath();
    await fs.access(exe);
  } catch {
    console.error('Playwright chromium not installed. Run: bunx playwright install chromium');
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
