import { test, expect } from 'bun:test';
import { bucket } from '../../scripts/regress.js';

const scored = (...scores) => scores.map((score, frame) => ({ frame, score }));

test('bucket: empty input yields zeros', () => {
  const b = bucket([]);
  expect(b.frames).toBe(0);
  expect(b.sum).toBe(0);
  expect(b.max).toBe(0);
  expect(b.peaks[0.025]).toBe(0);
  expect(b.peaks[0.05]).toBe(0);
  expect(b.peaks[0.08]).toBe(0);
});

test('bucket: peaks count inclusively at each threshold', () => {
  const b = bucket(scored(0.001, 0.025, 0.05, 0.08));
  expect(b.frames).toBe(4);
  expect(b.peaks[0.025]).toBe(3);
  expect(b.peaks[0.05]).toBe(2);
  expect(b.peaks[0.08]).toBe(1);
});

test('bucket: max and sum aggregate correctly', () => {
  const b = bucket(scored(0.01, 0.05, 0.1, 0.02));
  expect(b.max).toBe(0.1);
  expect(Math.abs(b.sum - 0.18)).toBeLessThan(1e-9);
});

test('bucket: higher-tier peaks are subsets of lower tiers', () => {
  const values = [0.0, 0.01, 0.025, 0.026, 0.04, 0.05, 0.06, 0.08, 0.09];
  const b = bucket(scored(...values));
  expect(b.peaks[0.08]).toBeLessThanOrEqual(b.peaks[0.05]);
  expect(b.peaks[0.05]).toBeLessThanOrEqual(b.peaks[0.025]);
});

test('bucket: reproduces trail_v_final baseline shape on a synthetic run', () => {
  // Regression-of-the-regression: give it the committed baseline numbers
  // shaped into synthetic scores and confirm the bucketing math matches.
  // baseline: peaks>=0.025=26, >=0.05=2, >=0.08=0
  const scores = [
    ...Array(24).fill(0.03),  // ≥0.025 only
    ...Array(2).fill(0.06),   // ≥0.05 (and ≥0.025)
    ...Array(10).fill(0.005), // below all thresholds
  ];
  const b = bucket(scored(...scores));
  expect(b.peaks[0.025]).toBe(26);
  expect(b.peaks[0.05]).toBe(2);
  expect(b.peaks[0.08]).toBe(0);
  expect(b.max).toBe(0.06);
});
