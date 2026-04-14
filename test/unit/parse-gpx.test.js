import { test, expect } from 'bun:test';
import path from 'node:path';
import { parseGPX } from '../../src/parse-gpx.js';

const DEMO_GPX = path.join(import.meta.dir, '..', '..', 'activity_580930440.gpx');

test('parses the committed demo GPX into a structured track', () => {
  const data = parseGPX(DEMO_GPX);

  expect(Array.isArray(data.points)).toBe(true);
  expect(data.points.length).toBeGreaterThan(100);
  expect(data.totalPoints).toBeGreaterThanOrEqual(data.points.length);
  expect(data.totalDistance).toBeGreaterThan(0);
  expect(data.bounds.minLat).toBeLessThan(data.bounds.maxLat);
  expect(data.bounds.minLon).toBeLessThan(data.bounds.maxLon);
});

test('every downsampled point has lat/lon/ele/bearing/dist', () => {
  const data = parseGPX(DEMO_GPX);
  for (const p of data.points) {
    expect(typeof p.lat).toBe('number');
    expect(typeof p.lon).toBe('number');
    expect(typeof p.ele).toBe('number');
    expect(typeof p.bearing).toBe('number');
    expect(typeof p.dist).toBe('number');
    expect(p.bearing).toBeGreaterThanOrEqual(0);
    expect(p.bearing).toBeLessThan(360);
  }
});

test('distances are monotonic non-decreasing', () => {
  const data = parseGPX(DEMO_GPX);
  for (let i = 1; i < data.points.length; i++) {
    expect(data.points[i].dist).toBeGreaterThanOrEqual(data.points[i - 1].dist);
  }
  expect(data.points[data.points.length - 1].dist).toBe(data.totalDistance);
});

test('downsampling respects targetPoints budget', () => {
  const data = parseGPX(DEMO_GPX, 500);
  expect(data.points.length).toBeLessThanOrEqual(600);
  expect(data.points.length).toBeGreaterThanOrEqual(400);
});

test('detected stops reference valid point indices', () => {
  const data = parseGPX(DEMO_GPX);
  for (const stop of data.stops) {
    expect(Number.isInteger(stop.index)).toBe(true);
    expect(stop.index).toBeGreaterThanOrEqual(0);
    expect(stop.index).toBeLessThan(data.points.length);
    expect(stop.lat).toBe(data.points[stop.index].lat);
    expect(stop.lon).toBe(data.points[stop.index].lon);
    expect(stop.hours).toBeGreaterThanOrEqual(2);
  }
});

test('bounds encapsulate every downsampled point', () => {
  const data = parseGPX(DEMO_GPX);
  for (const p of data.points) {
    expect(p.lat).toBeGreaterThanOrEqual(data.bounds.minLat);
    expect(p.lat).toBeLessThanOrEqual(data.bounds.maxLat);
    expect(p.lon).toBeGreaterThanOrEqual(data.bounds.minLon);
    expect(p.lon).toBeLessThanOrEqual(data.bounds.maxLon);
    expect(p.ele).toBeGreaterThanOrEqual(data.bounds.minEle);
    expect(p.ele).toBeLessThanOrEqual(data.bounds.maxEle);
  }
});
