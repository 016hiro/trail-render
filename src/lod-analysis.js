// Pure helpers for analysing MapLibre tile-set diffs and per-frame metric
// streams. Extracted from detect-lod-jumps.js so the math can be unit-tested
// and reused without spawning a browser.

export function tileLevel(tile) {
  return tile.overscaledZ ?? tile.z ?? -1;
}

export function tileSignature(source) {
  return (source?.renderableTiles || [])
    .map((tile) => `${tile.key}@${tileLevel(tile)}`)
    .sort();
}

export function mapBySignature(tiles) {
  return new Map(tiles.map((tile) => [`${tile.key}@${tileLevel(tile)}`, tile]));
}

export function sameTileLists(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function diffTiles(prevTiles, currTiles) {
  const prevMap = mapBySignature(prevTiles);
  const currMap = mapBySignature(currTiles);
  const added = [];
  const removed = [];

  for (const [sig, tile] of currMap) {
    if (!prevMap.has(sig)) added.push(tile);
  }
  for (const [sig, tile] of prevMap) {
    if (!currMap.has(sig)) removed.push(tile);
  }

  return { added, removed };
}

export function canonicalContains(parent, child) {
  if (parent.z == null || child.z == null || parent.x == null || child.x == null || parent.y == null || child.y == null) return false;
  if (child.z < parent.z) return false;
  const scale = 1 << (child.z - parent.z);
  return Math.floor(child.x / scale) === parent.x && Math.floor(child.y / scale) === parent.y;
}

export function inferTileTransitions(removed, added) {
  const upgrades = [];
  const downgrades = [];

  for (const fromTile of removed) {
    for (const toTile of added) {
      const fromLevel = tileLevel(fromTile);
      const toLevel = tileLevel(toTile);

      if (canonicalContains(fromTile, toTile) && toLevel > fromLevel) {
        upgrades.push({
          from: `${fromTile.key}@${fromLevel}`,
          to: `${toTile.key}@${toLevel}`,
        });
      } else if (canonicalContains(toTile, fromTile) && fromLevel > toLevel) {
        downgrades.push({
          from: `${fromTile.key}@${fromLevel}`,
          to: `${toTile.key}@${toLevel}`,
        });
      }
    }
  }

  const dedupe = (items) => {
    const seen = new Set();
    return items.filter((item) => {
      const key = `${item.from}->${item.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  return {
    upgrades: dedupe(upgrades),
    downgrades: dedupe(downgrades),
  };
}

export function computeStats(values) {
  if (values.length === 0) return { mean: 0, stddev: 0, p95: 0, p99: 0, max: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (pct) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct))];
  return {
    mean,
    stddev: Math.sqrt(variance),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted[sorted.length - 1],
  };
}
