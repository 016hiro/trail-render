#!/usr/bin/env bun
// Regression check for trail-render output videos.
//
// Runs ffmpeg's scene_score filter on a rendered video, buckets the per-frame
// deltas that fall inside the trail phase (after the intro zoom), and fails if
// the metric regresses past the committed baseline. This is the guard rail the
// residual-jumps investigation (docs/residual-jumps-investigation.md) built
// its fixes against — changes to camera smoothing, LOD staging, phase
// transitions, etc. should all be validated by running this against a fresh
// render before merging.
//
// Usage:
//   bun scripts/regress.js <video.mp4>                       # fail if peaks>=0.08 > 0 or >=0.05 > baseline+2
//   bun scripts/regress.js <video.mp4> --update-baseline     # overwrite baseline with current metrics
//   bun scripts/regress.js <video.mp4> --intro-sec 9 --fps 30

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASELINE_FILE = path.join(import.meta.dir, '..', 'docs', 'regress-baseline.json');

function flag(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

async function collectSceneScores(videoPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', videoPath,
      '-vf', "select='gte(scene,0)',metadata=print",
      '-an', '-f', 'null', '-',
    ]);
    let err = '';
    proc.stderr.on('data', (chunk) => { err += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}`));
      const scores = [];
      let currentFrame = -1;
      for (const line of err.split('\n')) {
        const fm = line.match(/frame:(\d+)/);
        if (fm) { currentFrame = parseInt(fm[1], 10); continue; }
        const sm = line.match(/scene_score=([0-9.]+)/);
        if (sm) scores.push({ frame: currentFrame, score: parseFloat(sm[1]) });
      }
      resolve(scores);
    });
  });
}

export function bucket(trailScores) {
  const thresholds = [0.025, 0.05, 0.08];
  const counts = {};
  let sum = 0, max = 0;
  for (const { score } of trailScores) {
    sum += score;
    if (score > max) max = score;
  }
  for (const t of thresholds) {
    counts[t] = trailScores.filter((x) => x.score >= t).length;
  }
  return { frames: trailScores.length, max, sum, peaks: counts };
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return null;
  return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'));
}

function saveBaseline(metrics) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(metrics, null, 2) + '\n');
  console.log(`Baseline written to ${path.relative(process.cwd(), BASELINE_FILE)}`);
}

function format(metrics) {
  return `frames ${metrics.frames}  max ${metrics.max.toFixed(4)}  sum ${metrics.sum.toFixed(3)}  peaks>=0.025 ${metrics.peaks[0.025]}  >=0.05 ${metrics.peaks[0.05]}  >=0.08 ${metrics.peaks[0.08]}`;
}

async function main() {
  const args = process.argv.slice(2);
  const videoPath = args.find((a) => !a.startsWith('--'));
  if (!videoPath) {
    console.error('Usage: bun scripts/regress.js <video.mp4> [--intro-sec 9] [--fps 30] [--update-baseline]');
    process.exit(1);
  }
  if (!fs.existsSync(videoPath)) {
    console.error(`Video not found: ${videoPath}`);
    process.exit(1);
  }
  const introSec = parseFloat(flag(args, '--intro-sec', '9'));
  const fps = parseFloat(flag(args, '--fps', '30'));
  const update = args.includes('--update-baseline');

  console.log(`Analyzing ${videoPath} ...`);
  const scores = await collectSceneScores(videoPath);
  if (scores.length === 0) {
    console.error('No scene_score lines parsed — ffmpeg filter may have failed.');
    process.exit(1);
  }

  const introFrames = Math.round(introSec * fps);
  // Skip the final second too — finish-label fades are not a regression.
  const trailScores = scores.filter((x) => x.frame >= introFrames && x.frame <= scores[scores.length - 1].frame - fps);
  const metrics = bucket(trailScores);

  console.log(`Current:  ${format(metrics)}`);

  if (update) {
    saveBaseline(metrics);
    process.exit(0);
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.log('No baseline committed. Run with --update-baseline after confirming this render is good.');
    process.exit(0);
  }
  console.log(`Baseline: ${format(baseline)}`);

  // Hard rules derived from residual-jumps-investigation.md:
  //   - Never introduce a ≥0.08 peak (investigation reduced these to 0).
  //   - ≥0.05 peaks must not exceed baseline by more than 2 (small noise ok).
  //   - ≥0.025 peaks must not exceed baseline by more than 5.
  //   - max must not exceed baseline's max by more than 20%.
  const fails = [];
  if (metrics.peaks[0.08] > baseline.peaks[0.08]) {
    fails.push(`peaks>=0.08 regressed: ${baseline.peaks[0.08]} → ${metrics.peaks[0.08]}`);
  }
  if (metrics.peaks[0.05] > baseline.peaks[0.05] + 2) {
    fails.push(`peaks>=0.05 regressed by >2: ${baseline.peaks[0.05]} → ${metrics.peaks[0.05]}`);
  }
  if (metrics.peaks[0.025] > baseline.peaks[0.025] + 5) {
    fails.push(`peaks>=0.025 regressed by >5: ${baseline.peaks[0.025]} → ${metrics.peaks[0.025]}`);
  }
  if (metrics.max > baseline.max * 1.2) {
    fails.push(`max scene_score regressed >20%: ${baseline.max.toFixed(4)} → ${metrics.max.toFixed(4)}`);
  }

  if (fails.length > 0) {
    console.error('\nREGRESSION:');
    for (const f of fails) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nNo regression.');
}

if (import.meta.main) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
