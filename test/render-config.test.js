import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRenderConfig,
  INTRO_SEC,
  TRAIL_PACE,
  DWELL_SEC,
  MIN_TRAIL_SEC,
  FINISH_SEC,
} from '../src/render-config.js';

const track = (km, stopCount) => ({
  totalDistance: km * 1000,
  stops: Array.from({ length: stopCount }, (_, i) => ({ index: i })),
});

test('long track: pace scaling dominates, no floor', () => {
  // 100 km × 0.5 s/km = 50 s trail > floor 20 s
  const cfg = computeRenderConfig(track(100, 0), 30);
  assert.equal(cfg.autoTrailSec, 50);
  assert.equal(cfg.autoDwellSec, 0);
  // 9 intro + 50 trail + 0 dwell + 4 finish = 63
  assert.equal(cfg.duration, 63);
  assert.equal(cfg.totalFrames, 63 * 30);
  assert.equal(cfg.introFrames, INTRO_SEC * 30);
});

test('short track: floor kicks in', () => {
  // 10 km × 0.5 = 5 s, floor forces 20 s
  const cfg = computeRenderConfig(track(10, 0), 30);
  assert.equal(cfg.autoTrailSec, MIN_TRAIL_SEC);
  // 9 + 20 + 0 + 4 = 33
  assert.equal(cfg.duration, 33);
});

test('dwell time scales linearly with stops', () => {
  const a = computeRenderConfig(track(100, 0), 30);
  const b = computeRenderConfig(track(100, 3), 30);
  assert.equal(b.autoDwellSec - a.autoDwellSec, 3 * DWELL_SEC);
  assert.equal(b.duration - a.duration, 3 * DWELL_SEC);
});

test('duration = ceil(intro + trail + dwell + finish)', () => {
  // Pick a km value that makes the sum non-integer: 7.3 km × 0.5 = 3.65 s,
  // floor forces 20 s, so sum = 9 + 20 + 0 + 4 = 33 (already integer).
  // Use a longer track where scaling produces a fractional value:
  // 45.7 km × 0.5 = 22.85 s → 9 + 22.85 + 0 + 4 = 35.85 → ceil 36
  const cfg = computeRenderConfig(track(45.7, 0), 30);
  assert.equal(cfg.duration, 36);
});

test('introFrames tracks fps', () => {
  const at30 = computeRenderConfig(track(100, 0), 30);
  const at60 = computeRenderConfig(track(100, 0), 60);
  assert.equal(at30.introFrames, INTRO_SEC * 30);
  assert.equal(at60.introFrames, INTRO_SEC * 60);
  assert.equal(at60.totalFrames, 2 * at30.totalFrames);
});

test('exported constants match expectations', () => {
  assert.equal(INTRO_SEC, 9);
  assert.equal(TRAIL_PACE, 0.5);
  assert.equal(DWELL_SEC, 2);
  assert.equal(MIN_TRAIL_SEC, 20);
  assert.equal(FINISH_SEC, 4);
});
