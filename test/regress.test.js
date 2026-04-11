import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucket } from '../scripts/regress.js';

const scored = (...scores) => scores.map((score, frame) => ({ frame, score }));

test('bucket: empty input yields zeros', () => {
  const b = bucket([]);
  assert.equal(b.frames, 0);
  assert.equal(b.sum, 0);
  assert.equal(b.max, 0);
  assert.equal(b.peaks[0.025], 0);
  assert.equal(b.peaks[0.05], 0);
  assert.equal(b.peaks[0.08], 0);
});

test('bucket: peaks count inclusively at each threshold', () => {
  // scores hitting the three boundaries exactly should count
  const b = bucket(scored(0.001, 0.025, 0.05, 0.08));
  assert.equal(b.frames, 4);
  assert.equal(b.peaks[0.025], 3, 'three values >= 0.025');
  assert.equal(b.peaks[0.05], 2, 'two values >= 0.05');
  assert.equal(b.peaks[0.08], 1, 'one value >= 0.08');
});

test('bucket: max and sum aggregate correctly', () => {
  const b = bucket(scored(0.01, 0.05, 0.1, 0.02));
  assert.equal(b.max, 0.1);
  assert.ok(Math.abs(b.sum - 0.18) < 1e-9);
});

test('bucket: higher-tier peaks are subsets of lower tiers', () => {
  const values = [0.0, 0.01, 0.025, 0.026, 0.04, 0.05, 0.06, 0.08, 0.09];
  const b = bucket(scored(...values));
  assert.ok(b.peaks[0.08] <= b.peaks[0.05]);
  assert.ok(b.peaks[0.05] <= b.peaks[0.025]);
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
  assert.equal(b.peaks[0.025], 26);
  assert.equal(b.peaks[0.05], 2);
  assert.equal(b.peaks[0.08], 0);
  assert.equal(b.max, 0.06);
});
