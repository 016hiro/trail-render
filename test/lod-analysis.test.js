import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tileLevel,
  tileSignature,
  mapBySignature,
  sameTileLists,
  diffTiles,
  canonicalContains,
  inferTileTransitions,
  computeStats,
} from '../src/lod-analysis.js';

test('tileLevel prefers overscaledZ, falls back to z, then -1', () => {
  assert.equal(tileLevel({ overscaledZ: 12, z: 11 }), 12);
  assert.equal(tileLevel({ z: 11 }), 11);
  assert.equal(tileLevel({}), -1);
  assert.equal(tileLevel({ overscaledZ: 0 }), 0, 'zero overscaledZ is a valid level');
});

test('tileSignature sorts and includes level', () => {
  const source = {
    renderableTiles: [
      { key: 'b', z: 10 },
      { key: 'a', z: 11 },
      { key: 'c', overscaledZ: 9, z: 8 },
    ],
  };
  assert.deepEqual(tileSignature(source), ['a@11', 'b@10', 'c@9']);
});

test('tileSignature returns [] for missing source or missing renderableTiles', () => {
  assert.deepEqual(tileSignature(null), []);
  assert.deepEqual(tileSignature({}), []);
  assert.deepEqual(tileSignature({ renderableTiles: [] }), []);
});

test('sameTileLists compares ordered string arrays', () => {
  assert.equal(sameTileLists(['a', 'b'], ['a', 'b']), true);
  assert.equal(sameTileLists(['a', 'b'], ['b', 'a']), false);
  assert.equal(sameTileLists(['a'], ['a', 'b']), false);
  assert.equal(sameTileLists([], []), true);
});

test('mapBySignature keys by signature', () => {
  const tiles = [
    { key: 'a', z: 11 },
    { key: 'b', overscaledZ: 10, z: 9 },
  ];
  const m = mapBySignature(tiles);
  assert.equal(m.size, 2);
  assert.equal(m.get('a@11'), tiles[0]);
  assert.equal(m.get('b@10'), tiles[1]);
});

test('diffTiles reports added and removed sets', () => {
  const prev = [{ key: 'a', z: 10 }, { key: 'b', z: 10 }];
  const curr = [{ key: 'b', z: 10 }, { key: 'c', z: 11 }];
  const { added, removed } = diffTiles(prev, curr);
  assert.equal(added.length, 1);
  assert.equal(added[0].key, 'c');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].key, 'a');
});

test('diffTiles returns empty sets when lists match', () => {
  const tiles = [{ key: 'a', z: 10 }];
  const { added, removed } = diffTiles(tiles, tiles);
  assert.equal(added.length, 0);
  assert.equal(removed.length, 0);
});

test('canonicalContains — parent quadkey contains child', () => {
  // z10 tile (2,3) contains all z11 tiles (4..5, 6..7)
  const parent = { z: 10, x: 2, y: 3 };
  assert.equal(canonicalContains(parent, { z: 11, x: 4, y: 6 }), true);
  assert.equal(canonicalContains(parent, { z: 11, x: 5, y: 7 }), true);
  assert.equal(canonicalContains(parent, { z: 11, x: 6, y: 6 }), false, 'out of range x');
  assert.equal(canonicalContains(parent, { z: 11, x: 4, y: 8 }), false, 'out of range y');
});

test('canonicalContains handles same level and missing coords', () => {
  assert.equal(canonicalContains({ z: 10, x: 2, y: 3 }, { z: 10, x: 2, y: 3 }), true);
  assert.equal(canonicalContains({ z: 10, x: 2, y: 3 }, { z: 9, x: 1, y: 1 }), false, 'child cannot be coarser');
  assert.equal(canonicalContains({}, { z: 11, x: 4, y: 6 }), false);
  assert.equal(canonicalContains({ z: 10, x: 2, y: 3 }, { z: 11 }), false);
});

test('inferTileTransitions — upgrade: coarse parent removed, fine child added', () => {
  const removed = [{ key: 'p', z: 10, x: 2, y: 3 }];
  const added = [{ key: 'c', z: 11, x: 4, y: 6 }];
  const { upgrades, downgrades } = inferTileTransitions(removed, added);
  assert.equal(upgrades.length, 1);
  assert.equal(upgrades[0].from, 'p@10');
  assert.equal(upgrades[0].to, 'c@11');
  assert.equal(downgrades.length, 0);
});

test('inferTileTransitions — downgrade: fine removed, coarse added', () => {
  const removed = [{ key: 'c', z: 11, x: 4, y: 6 }];
  const added = [{ key: 'p', z: 10, x: 2, y: 3 }];
  const { upgrades, downgrades } = inferTileTransitions(removed, added);
  assert.equal(upgrades.length, 0);
  assert.equal(downgrades.length, 1);
  assert.equal(downgrades[0].from, 'c@11');
  assert.equal(downgrades[0].to, 'p@10');
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
  assert.equal(upgrades.length, 1);
});

test('inferTileTransitions — unrelated tiles produce no transitions', () => {
  const removed = [{ key: 'a', z: 10, x: 0, y: 0 }];
  const added = [{ key: 'b', z: 10, x: 5, y: 5 }];
  const { upgrades, downgrades } = inferTileTransitions(removed, added);
  assert.equal(upgrades.length, 0);
  assert.equal(downgrades.length, 0);
});

test('computeStats: empty input returns zeros', () => {
  assert.deepEqual(computeStats([]), { mean: 0, stddev: 0, p95: 0, p99: 0, max: 0 });
});

test('computeStats: simple sequence', () => {
  const stats = computeStats([1, 2, 3, 4, 5]);
  assert.equal(stats.mean, 3);
  // variance = ((1-3)^2 + (2-3)^2 + ... + (5-3)^2) / 5 = (4+1+0+1+4)/5 = 2
  assert.equal(stats.stddev, Math.sqrt(2));
  assert.equal(stats.max, 5);
  // p95 with 5 items: floor(5*0.95)=4 → index 4 = 5
  assert.equal(stats.p95, 5);
});

test('computeStats: p95 at 100 samples picks near the tail', () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  const stats = computeStats(values);
  // floor(100*0.95) = 95, index 95 = 96
  assert.equal(stats.p95, 96);
  // floor(100*0.99) = 99, index 99 = 100
  assert.equal(stats.p99, 100);
  assert.equal(stats.max, 100);
  assert.equal(stats.mean, 50.5);
});
