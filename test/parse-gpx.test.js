import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGPX } from '../src/parse-gpx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_GPX = path.join(__dirname, '..', 'activity_580930440.gpx');

test('parses the committed demo GPX into a structured track', () => {
  const data = parseGPX(DEMO_GPX);

  assert.ok(Array.isArray(data.points));
  assert.ok(data.points.length > 100, 'expected more than 100 downsampled points');
  assert.ok(data.totalPoints >= data.points.length, 'raw point count >= downsampled');
  assert.ok(data.totalDistance > 0);
  assert.ok(data.bounds.minLat < data.bounds.maxLat);
  assert.ok(data.bounds.minLon < data.bounds.maxLon);
});

test('every downsampled point has lat/lon/ele/bearing/dist', () => {
  const data = parseGPX(DEMO_GPX);
  for (const p of data.points) {
    assert.equal(typeof p.lat, 'number');
    assert.equal(typeof p.lon, 'number');
    assert.equal(typeof p.ele, 'number');
    assert.equal(typeof p.bearing, 'number');
    assert.equal(typeof p.dist, 'number');
    assert.ok(p.bearing >= 0 && p.bearing < 360);
  }
});

test('distances are monotonic non-decreasing', () => {
  const data = parseGPX(DEMO_GPX);
  for (let i = 1; i < data.points.length; i++) {
    assert.ok(
      data.points[i].dist >= data.points[i - 1].dist,
      `dist regressed at index ${i}`,
    );
  }
  assert.equal(data.points[data.points.length - 1].dist, data.totalDistance);
});

test('downsampling respects targetPoints budget', () => {
  // Demo track has ~60k raw points; target 500 should yield roughly 500±1
  const data = parseGPX(DEMO_GPX, 500);
  // nth-step sampling can slightly overshoot; allow a small margin
  assert.ok(data.points.length <= 600, `got ${data.points.length} points, expected ≤600`);
  assert.ok(data.points.length >= 400, `got ${data.points.length} points, expected ≥400`);
});

test('detected stops reference valid point indices', () => {
  const data = parseGPX(DEMO_GPX);
  for (const stop of data.stops) {
    assert.ok(Number.isInteger(stop.index));
    assert.ok(stop.index >= 0 && stop.index < data.points.length);
    assert.equal(stop.lat, data.points[stop.index].lat);
    assert.equal(stop.lon, data.points[stop.index].lon);
    assert.ok(stop.hours >= 2, 'stops must come from ≥2h time gaps');
  }
});

test('bounds encapsulate every downsampled point', () => {
  const data = parseGPX(DEMO_GPX);
  for (const p of data.points) {
    assert.ok(p.lat >= data.bounds.minLat && p.lat <= data.bounds.maxLat);
    assert.ok(p.lon >= data.bounds.minLon && p.lon <= data.bounds.maxLon);
    assert.ok(p.ele >= data.bounds.minEle && p.ele <= data.bounds.maxEle);
  }
});
