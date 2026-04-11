import { test, expect } from 'bun:test';
import {
  tileLevel,
  tileSignature,
  mapBySignature,
  sameTileLists,
  diffTiles,
  canonicalContains,
  inferTileTransitions,
  computeStats,
} from '../../src/lod-analysis.js';

test('tileLevel prefers overscaledZ, falls back to z, then -1', () => {
  expect(tileLevel({ overscaledZ: 12, z: 11 })).toBe(12);
  expect(tileLevel({ z: 11 })).toBe(11);
  expect(tileLevel({})).toBe(-1);
  expect(tileLevel({ overscaledZ: 0 })).toBe(0);
});

test('tileSignature sorts and includes level', () => {
  const source = {
    renderableTiles: [
      { key: 'b', z: 10 },
      { key: 'a', z: 11 },
      { key: 'c', overscaledZ: 9, z: 8 },
    ],
  };
  expect(tileSignature(source)).toEqual(['a@11', 'b@10', 'c@9']);
});

test('tileSignature returns [] for missing source or missing renderableTiles', () => {
  expect(tileSignature(null)).toEqual([]);
  expect(tileSignature({})).toEqual([]);
  expect(tileSignature({ renderableTiles: [] })).toEqual([]);
});

test('sameTileLists compares ordered string arrays', () => {
  expect(sameTileLists(['a', 'b'], ['a', 'b'])).toBe(true);
  expect(sameTileLists(['a', 'b'], ['b', 'a'])).toBe(false);
  expect(sameTileLists(['a'], ['a', 'b'])).toBe(false);
  expect(sameTileLists([], [])).toBe(true);
});

test('mapBySignature keys by signature', () => {
  const tiles = [
    { key: 'a', z: 11 },
    { key: 'b', overscaledZ: 10, z: 9 },
  ];
  const m = mapBySignature(tiles);
  expect(m.size).toBe(2);
  expect(m.get('a@11')).toBe(tiles[0]);
  expect(m.get('b@10')).toBe(tiles[1]);
});

test('diffTiles reports added and removed sets', () => {
  const prev = [{ key: 'a', z: 10 }, { key: 'b', z: 10 }];
  const curr = [{ key: 'b', z: 10 }, { key: 'c', z: 11 }];
  const { added, removed } = diffTiles(prev, curr);
  expect(added.length).toBe(1);
  expect(added[0].key).toBe('c');
  expect(removed.length).toBe(1);
  expect(removed[0].key).toBe('a');
});

test('diffTiles returns empty sets when lists match', () => {
  const tiles = [{ key: 'a', z: 10 }];
  const { added, removed } = diffTiles(tiles, tiles);
  expect(added.length).toBe(0);
  expect(removed.length).toBe(0);
});

test('canonicalContains — parent quadkey contains child', () => {
  const parent = { z: 10, x: 2, y: 3 };
  expect(canonicalContains(parent, { z: 11, x: 4, y: 6 })).toBe(true);
  expect(canonicalContains(parent, { z: 11, x: 5, y: 7 })).toBe(true);
  expect(canonicalContains(parent, { z: 11, x: 6, y: 6 })).toBe(false);
  expect(canonicalContains(parent, { z: 11, x: 4, y: 8 })).toBe(false);
});

test('canonicalContains handles same level and missing coords', () => {
  expect(canonicalContains({ z: 10, x: 2, y: 3 }, { z: 10, x: 2, y: 3 })).toBe(true);
  expect(canonicalContains({ z: 10, x: 2, y: 3 }, { z: 9, x: 1, y: 1 })).toBe(false);
  expect(canonicalContains({}, { z: 11, x: 4, y: 6 })).toBe(false);
  expect(canonicalContains({ z: 10, x: 2, y: 3 }, { z: 11 })).toBe(false);
});

test('inferTileTransitions — upgrade: coarse parent removed, fine child added', () => {
  const removed = [{ key: 'p', z: 10, x: 2, y: 3 }];
  const added = [{ key: 'c', z: 11, x: 4, y: 6 }];
  const { upgrades, downgrades } = inferTileTransitions(removed, added);
  expect(upgrades.length).toBe(1);
  expect(upgrades[0].from).toBe('p@10');
  expect(upgrades[0].to).toBe('c@11');
  expect(downgrades.length).toBe(0);
});

test('inferTileTransitions — downgrade: fine removed, coarse added', () => {
  const removed = [{ key: 'c', z: 11, x: 4, y: 6 }];
  const added = [{ key: 'p', z: 10, x: 2, y: 3 }];
  const { upgrades, downgrades } = inferTileTransitions(removed, added);
  expect(upgrades.length).toBe(0);
  expect(downgrades.length).toBe(1);
  expect(downgrades[0].from).toBe('c@11');
  expect(downgrades[0].to).toBe('p@10');
});

test('inferTileTransitions dedupes repeated transitions', () => {
  const removed = [
    { key: 'p', z: 10, x: 2, y: 3 },
    { key: 'p', z: 10, x: 2, y: 3 },
  ];
  const added = [
    { key: 'c', z: 11, x: 4, y: 6 },
    { key: 'c', z: 11, x: 4, y: 6 },
  ];
  const { upgrades } = inferTileTransitions(removed, added);
  expect(upgrades.length).toBe(1);
});

test('inferTileTransitions — unrelated tiles produce no transitions', () => {
  const removed = [{ key: 'a', z: 10, x: 0, y: 0 }];
  const added = [{ key: 'b', z: 10, x: 5, y: 5 }];
  const { upgrades, downgrades } = inferTileTransitions(removed, added);
  expect(upgrades.length).toBe(0);
  expect(downgrades.length).toBe(0);
});

test('computeStats: empty input returns zeros', () => {
  expect(computeStats([])).toEqual({ mean: 0, stddev: 0, p95: 0, p99: 0, max: 0 });
});

test('computeStats: simple sequence', () => {
  const stats = computeStats([1, 2, 3, 4, 5]);
  expect(stats.mean).toBe(3);
  expect(stats.stddev).toBe(Math.sqrt(2));
  expect(stats.max).toBe(5);
  expect(stats.p95).toBe(5);
});

test('computeStats: p95 at 100 samples picks near the tail', () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  const stats = computeStats(values);
  expect(stats.p95).toBe(96);
  expect(stats.p99).toBe(100);
  expect(stats.max).toBe(100);
  expect(stats.mean).toBe(50.5);
});
