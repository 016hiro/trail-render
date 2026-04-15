// Core render pipeline, decoupled from the CLI. Both src/index.js (CLI) and
// src/web-server.js (HTTP API) call runJob() with a plain options bag and
// subscribe to progress events via the onProgress callback.
//
// onProgress receives structured events:
//   { type: 'phase', phase: 'parse'|'network'|'plan'|'prewarm'|'capture'|'encode'|'done', message? }
//   { type: 'track', totalPoints, downsampled, distanceKm, stops, minEle, maxEle }
//   { type: 'plan', duration, fps, totalFrames, introFrames, finishFrames, autoTrailSec, autoDwellSec, introSec }
//   { type: 'capture', subphase: 'intro'|'trail'|'finish', frame, totalFrames, elapsedMs }
//   { type: 'prewarm', pct }
//   { type: 'log', level: 'info'|'warn', message }
//
// prepareTrackData() is exported separately so --preview mode can reuse it
// without spinning up captureFrames.

import { parseGPX } from './parse-gpx.js';
import { startServer } from './server.js';
import { captureFrames } from './capture.js';
import { computeRenderConfig, INTRO_SEC } from './render-config.js';
import path from 'node:path';
import fs from 'node:fs/promises';

const NOM_HEADERS = { 'User-Agent': 'trail-render/1.0' };

export async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function fetchRetry(url, opts = {}, retries = 3, onProgress) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(15000) });
      return res;
    } catch (e) {
      if (i === retries - 1) throw e;
      onProgress?.({ type: 'log', level: 'info', message: `  Fetch retry ${i + 1}/${retries}: ${e.code || e.message}` });
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

export async function prepareTrackData({ gpxPath, title, end, onProgress = () => {} }) {
  onProgress({ type: 'phase', phase: 'parse', message: `Parsing ${gpxPath}...` });
  const trackData = parseGPX(gpxPath);
  onProgress({
    type: 'track',
    totalPoints: trackData.totalPoints,
    downsampled: trackData.points.length,
    distanceKm: trackData.totalDistance / 1000,
    stops: trackData.stops.length,
    minEle: trackData.bounds.minEle,
    maxEle: trackData.bounds.maxEle,
  });

  const cacheFile = gpxPath.replace(/\.gpx$/i, '.cache.json');
  onProgress({ type: 'phase', phase: 'network' });
  const t0 = Date.now();

  if (await fileExists(cacheFile)) {
    onProgress({ type: 'log', level: 'info', message: `Loading cached data from ${cacheFile}...` });
    const cache = JSON.parse(await fs.readFile(cacheFile, 'utf-8'));
    for (let i = 0; i < cache.elevations.length; i++) trackData.points[i].ele = cache.elevations[i];
    for (const stop of trackData.stops) stop.ele = trackData.points[stop.index].ele;
    trackData.bounds.minEle = cache.bounds.minEle;
    trackData.bounds.maxEle = cache.bounds.maxEle;
    trackData.startName = cache.startName;
    trackData.country = cache.country;
    trackData.countryBorder = cache.countryBorder;
    for (let i = 0; i < trackData.stops.length; i++) trackData.stops[i].name = cache.stopNames[i];
    trackData.endName = cache.endName;
    trackData.segments = cache.segments;
    trackData.pois = cache.pois;
    if (title) trackData.startName = title;
    if (end) trackData.endName = end;
  } else {
    onProgress({ type: 'log', level: 'info', message: 'Fetching DEM + geocoding + POIs + border (parallel)...' });
    const [, , rawPois] = await Promise.all([
      calibrateElevation(trackData, onProgress),
      geocodeAndBorder(trackData, title, end, onProgress),
      queryRawPOIs(trackData.bounds, onProgress),
    ]);
    trackData.pois = filterPOIs(rawPois, trackData.points);

    await fs.writeFile(cacheFile, JSON.stringify({
      elevations: trackData.points.map(p => p.ele),
      bounds: { minEle: trackData.bounds.minEle, maxEle: trackData.bounds.maxEle },
      startName: trackData.startName,
      country: trackData.country,
      countryBorder: trackData.countryBorder,
      stopNames: trackData.stops.map(s => s.name),
      endName: trackData.endName,
      segments: trackData.segments,
      pois: trackData.pois,
    }));
    onProgress({ type: 'log', level: 'info', message: `  Cached to ${cacheFile}` });
  }

  onProgress({ type: 'log', level: 'info', message: `  Done in ${((Date.now() - t0) / 1000).toFixed(1)}s` });
  onProgress({ type: 'log', level: 'info', message: `  Country: ${trackData.country} | Start: ${trackData.startName} | End: ${trackData.endName}` });
  for (const s of trackData.stops) onProgress({ type: 'log', level: 'info', message: `  Stop: ${s.name} (${Math.round(s.ele)}m)` });
  onProgress({ type: 'log', level: 'info', message: `  POIs: ${trackData.pois.length}` });

  return trackData;
}

export async function runJob({
  gpxPath,
  output,
  apiKey,
  fps = 30,
  width = 1920,
  height = 1080,
  duration: durationOverride,
  title,
  end,
  name,
  pace,
  intro,
  port = 3456,
  onProgress = () => {},
  signal,
}) {
  if (!apiKey) throw new Error('MAPTILER_KEY is required');
  if (!gpxPath) throw new Error('gpxPath is required');
  if (!output) throw new Error('output is required');

  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });

  const trackData = await prepareTrackData({ gpxPath, title, end, onProgress });
  if (signal?.aborted) { const e = new Error('Render cancelled'); e.cancelled = true; throw e; }

  const overrides = {};
  if (pace != null) overrides.trailPace = pace;
  if (intro != null) overrides.introSec = intro;

  const auto = computeRenderConfig(trackData, fps, overrides);
  const duration = durationOverride ?? auto.duration;
  const totalFrames = duration * fps;
  const { introFrames, finishFrames } = auto;
  const introSec = overrides.introSec ?? INTRO_SEC;

  onProgress({
    type: 'plan',
    duration, fps, totalFrames, introFrames, finishFrames,
    autoTrailSec: auto.autoTrailSec, autoDwellSec: auto.autoDwellSec, introSec,
  });
  onProgress({ type: 'log', level: 'info', message: `  Video: ${duration}s @ ${fps}fps = ${totalFrames} frames (auto: ${auto.duration}s = ${introSec}s intro + ${auto.autoTrailSec.toFixed(0)}s trail + ${auto.autoDwellSec}s dwell)` });

  const server = await startServer(trackData, apiKey, port, introFrames, name ? { trailName: name } : {});

  try {
    onProgress({ type: 'phase', phase: 'capture' });
    await captureFrames({
      port,
      outputDir: path.dirname(path.resolve(output)),
      totalFrames, fps, width, height,
      outputFile: path.resolve(output),
      introFrames, finishFrames,
      onProgress,
      signal,
    });
  } finally {
    server.close();
  }

  onProgress({ type: 'phase', phase: 'done', message: 'Done!' });
  return { outputFile: path.resolve(output), trackData };
}

/* ==================== DEM calibration (sparse + interpolate) ==================== */

async function calibrateElevation(trackData, onProgress) {
  const pts = trackData.points;
  const SAMPLE_EVERY = 30;
  const BATCH = 50;

  const indices = [];
  for (let i = 0; i < pts.length; i += SAMPLE_EVERY) indices.push(i);
  if (indices[indices.length - 1] !== pts.length - 1) indices.push(pts.length - 1);

  const demEle = new Array(indices.length).fill(null);

  for (let b = 0; b < indices.length; b += BATCH) {
    const batchIdx = indices.slice(b, b + BATCH);
    const lats = batchIdx.map(i => pts[i].lat).join(',');
    const lons = batchIdx.map(i => pts[i].lon).join(',');

    let data;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const res = await fetchRetry(
          `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`,
          {}, 3, onProgress,
        );
        data = await res.json();
        if (data.elevation) break;
        onProgress({ type: 'log', level: 'info', message: `  DEM HTTP ${res.status}, retrying...` });
      } catch (e) {
        onProgress({ type: 'log', level: 'info', message: `  DEM fetch failed (${e.code || e.name || e.message}), retrying...` });
      }
      onProgress({ type: 'log', level: 'info', message: '  DEM rate limited, waiting 60s...' });
      await new Promise(r => setTimeout(r, 60000));
    }

    if (data?.elevation) {
      for (let j = 0; j < batchIdx.length; j++) demEle[b + j] = data.elevation[j];
    }
    if (b + BATCH < indices.length) await new Promise(r => setTimeout(r, 1500));
  }

  for (let s = 0; s < indices.length - 1; s++) {
    const i0 = indices[s], i1 = indices[s + 1];
    const e0 = demEle[s], e1 = demEle[s + 1];
    if (e0 == null || e1 == null) continue;
    for (let i = i0; i <= i1; i++) {
      const t = (i - i0) / (i1 - i0);
      pts[i].ele = e0 + (e1 - e0) * t;
    }
  }

  for (const stop of trackData.stops) stop.ele = pts[stop.index].ele;
  let minEle = Infinity, maxEle = -Infinity;
  for (const p of pts) {
    if (p.ele < minEle) minEle = p.ele;
    if (p.ele > maxEle) maxEle = p.ele;
  }
  trackData.bounds.minEle = minEle;
  trackData.bounds.maxEle = maxEle;
}

/* ==================== Geocoding + country border (Nominatim) ==================== */

async function reverseGeocode(lat, lon, onProgress) {
  const res = await fetchRetry(
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14&accept-language=en`,
    { headers: NOM_HEADERS }, 3, onProgress,
  );
  const d = await res.json();
  return {
    name: d.address?.village || d.address?.town || d.address?.hamlet || d.address?.city || d.name || 'Unknown',
    country: d.address?.country || 'Unknown',
  };
}

async function fetchCountryBorder(country, onProgress) {
  try {
    const res = await fetchRetry(
      `https://nominatim.openstreetmap.org/search?country=${encodeURIComponent(country)}&format=geojson&polygon_geojson=1&polygon_threshold=0.01&limit=1`,
      { headers: NOM_HEADERS }, 3, onProgress,
    );
    const data = await res.json();
    if (data.features?.[0]?.geometry) return data.features[0].geometry;
  } catch (e) {
    onProgress({ type: 'log', level: 'warn', message: `  Country border lookup failed (${e.code || e.message}); continuing without border.` });
  }
  return null;
}

async function geocodeAndBorder(trackData, titleOverride, endOverride, onProgress) {
  const p0 = trackData.points[0];

  const startGeo = await reverseGeocode(p0.lat, p0.lon, onProgress);
  trackData.startName = titleOverride || startGeo.name;
  trackData.country = startGeo.country;

  await new Promise(r => setTimeout(r, 1100));
  trackData.countryBorder = await fetchCountryBorder(trackData.country, onProgress);

  for (const stop of trackData.stops) {
    await new Promise(r => setTimeout(r, 1100));
    const geo = await reverseGeocode(stop.lat, stop.lon, onProgress);
    stop.name = geo.name;
  }

  const pEnd = trackData.points[trackData.points.length - 1];
  if (endOverride) {
    trackData.endName = endOverride;
  } else {
    await new Promise(r => setTimeout(r, 1100));
    const endGeo = await reverseGeocode(pEnd.lat, pEnd.lon, onProgress);
    trackData.endName = endGeo.name;
  }

  const names = [trackData.startName, ...trackData.stops.map(s => s.name), trackData.endName];
  const indices = [0, ...trackData.stops.map(s => s.index), trackData.points.length - 1];
  trackData.segments = [];
  for (let i = 0; i < names.length - 1; i++) {
    trackData.segments.push({ from: names[i], to: names[i + 1], startIdx: indices[i], endIdx: indices[i + 1] });
  }
}

/* ==================== POI query + prominence filtering ==================== */

const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function queryRawPOIs(bounds, onProgress) {
  const margin = 0.05;
  const bbox = [
    bounds.minLat - margin, bounds.minLon - margin,
    bounds.maxLat + margin, bounds.maxLon + margin,
  ].join(',');

  const query = `[out:json][timeout:60];(`
    + `node["natural"="peak"]["name"]["ele"](${bbox});`
    + `node["mountain_pass"="yes"]["name"](${bbox});`
    + `node["natural"="lake"]["name"](${bbox});`
    + `way["natural"="water"]["name"](${bbox});`
    + `);out center body;`;

  for (const server of OVERPASS_SERVERS) {
    for (let retry = 0; retry < 3; retry++) {
      try {
        const res = await fetchRetry(
          `${server}?data=${encodeURIComponent(query)}`,
          { signal: AbortSignal.timeout(30000) }, 3, onProgress,
        );
        if (!res.ok) {
          onProgress({ type: 'log', level: 'info', message: `  Overpass ${server} HTTP ${res.status}, retrying...` });
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        const data = await res.json();
        return parseRawPOIs(data.elements);
      } catch (e) {
        onProgress({ type: 'log', level: 'info', message: `  Overpass ${server} failed (${e.code || e.name || e.message}), retrying...` });
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  onProgress({ type: 'log', level: 'warn', message: '  POI query failed on all Overpass mirrors; continuing without POIs.' });
  return [];
}

const LAKE_SKIP = /^(tarn|pond|small|pool|puddle|holy pond)/i;

function parseRawPOIs(elements) {
  const pois = [];
  const seen = new Set();
  for (const el of elements) {
    const name = el.tags?.['name:en'] || el.tags?.name;
    if (!name) continue;
    const ele = el.tags?.ele ? parseInt(el.tags.ele) : null;
    const lat = el.lat || el.center?.lat;
    const lon = el.lon || el.center?.lon;
    if (!lat || !lon) continue;

    let type;
    if (el.tags?.mountain_pass === 'yes') type = 'pass';
    else if (el.tags?.natural === 'peak') type = 'peak';
    else type = 'lake';

    if (type === 'lake' && LAKE_SKIP.test(name)) continue;

    const key = `${type}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    pois.push({ name, ele, lat, lon, type });
  }
  return pois;
}

function filterPOIs(rawPois, trackPoints) {
  const MAX_PEAKS = 8, MAX_LAKES = 6, MAX_PASSES = 3;
  const MAX_DIST_PEAK = 15000, MAX_DIST_LAKE = 10000, MAX_DIST_PASS = 5000;

  const sample = trackPoints.filter((_, i) => i % 20 === 0);

  for (const poi of rawPois) {
    let minDist = Infinity;
    let eleSum = 0, eleCnt = 0;
    for (const tp of sample) {
      const d = approxDist(poi.lat, poi.lon, tp.lat, tp.lon);
      if (d < minDist) minDist = d;
      if (d < 10000) { eleSum += tp.ele; eleCnt++; }
    }
    poi.distToTrack = minDist;
    poi.nearbyAvgEle = eleCnt > 0 ? eleSum / eleCnt : 0;
  }

  const peaks = rawPois.filter(p => p.type === 'peak' && p.ele && p.distToTrack < MAX_DIST_PEAK);

  if (peaks.length > 0) {
    const peakEles = peaks.map(p => p.ele);
    const maxPeakEle = Math.max(...peakEles);
    const minPeakEle = Math.min(...peakEles);
    const eleRange = maxPeakEle - minPeakEle || 1;
    let maxProm = 0;
    for (const p of peaks) {
      const prom = p.ele - p.nearbyAvgEle;
      if (prom > maxProm) maxProm = prom;
    }
    maxProm = maxProm || 1;
    for (const p of peaks) {
      const prominence = Math.max(0, p.ele - p.nearbyAvgEle);
      const promScore = prominence / maxProm;
      const absScore = (p.ele - minPeakEle) / eleRange;
      p.score = promScore * 0.6 + absScore * 0.4;
    }
    peaks.sort((a, b) => b.score - a.score);
  }

  const lakes  = rawPois.filter(p => p.type === 'lake' && p.distToTrack < MAX_DIST_LAKE);
  const passes = rawPois.filter(p => p.type === 'pass' && p.distToTrack < MAX_DIST_PASS);
  lakes.sort((a, b) => a.distToTrack - b.distToTrack);
  passes.sort((a, b) => a.distToTrack - b.distToTrack);

  return [
    ...peaks.slice(0, MAX_PEAKS),
    ...lakes.slice(0, MAX_LAKES),
    ...passes.slice(0, MAX_PASSES),
  ];
}

function approxDist(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  return R * Math.sqrt(dLat * dLat + dLon * dLon);
}
