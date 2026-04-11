import { test, expect } from 'bun:test';
import {
  computeRenderConfig,
  INTRO_SEC,
  TRAIL_PACE,
  DWELL_SEC,
  MIN_TRAIL_SEC,
  FINISH_SEC,
} from '../../src/render-config.js';

const track = (km, stopCount) => ({
  totalDistance: km * 1000,
  stops: Array.from({ length: stopCount }, (_, i) => ({ index: i })),
});

test('long track: pace scaling dominates, no floor', () => {
  // 100 km × 0.5 s/km = 50 s trail > floor 20 s
  const cfg = computeRenderConfig(track(100, 0), 30);
  expect(cfg.autoTrailSec).toBe(50);
  expect(cfg.autoDwellSec).toBe(0);
  // 9 intro + 50 trail + 0 dwell + 4 finish = 63
  expect(cfg.duration).toBe(63);
  expect(cfg.totalFrames).toBe(63 * 30);
  expect(cfg.introFrames).toBe(INTRO_SEC * 30);
});

test('short track: floor kicks in', () => {
  // 10 km × 0.5 = 5 s, floor forces 20 s
  const cfg = computeRenderConfig(track(10, 0), 30);
  expect(cfg.autoTrailSec).toBe(MIN_TRAIL_SEC);
  // 9 + 20 + 0 + 4 = 33
  expect(cfg.duration).toBe(33);
});

test('dwell time scales linearly with stops', () => {
  const a = computeRenderConfig(track(100, 0), 30);
  const b = computeRenderConfig(track(100, 3), 30);
  expect(b.autoDwellSec - a.autoDwellSec).toBe(3 * DWELL_SEC);
  expect(b.duration - a.duration).toBe(3 * DWELL_SEC);
});

test('duration = ceil(intro + trail + dwell + finish)', () => {
  // 45.7 km × 0.5 = 22.85 s → 9 + 22.85 + 0 + 4 = 35.85 → ceil 36
  const cfg = computeRenderConfig(track(45.7, 0), 30);
  expect(cfg.duration).toBe(36);
});

test('introFrames tracks fps', () => {
  const at30 = computeRenderConfig(track(100, 0), 30);
  const at60 = computeRenderConfig(track(100, 0), 60);
  expect(at30.introFrames).toBe(INTRO_SEC * 30);
  expect(at60.introFrames).toBe(INTRO_SEC * 60);
  expect(at60.totalFrames).toBe(2 * at30.totalFrames);
});

test('exported constants match expectations', () => {
  expect(INTRO_SEC).toBe(9);
  expect(TRAIL_PACE).toBe(0.5);
  expect(DWELL_SEC).toBe(2);
  expect(MIN_TRAIL_SEC).toBe(20);
  expect(FINISH_SEC).toBe(4);
});
