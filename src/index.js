import { parseGPX } from './parse-gpx.js';
import { startServer } from './server.js';
import { captureFrames } from './capture.js';
import { computeRenderConfig, INTRO_SEC } from './render-config.js';
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';

const API_KEY = process.env.MAPTILER_KEY;
if (!API_KEY) {
  console.error('MAPTILER_KEY env var is required. Get a key at https://www.maptiler.com/ and export MAPTILER_KEY=... (or put it in .env).');
  process.exit(1);
}
const NOM_HEADERS = { 'User-Agent': 'trail-render/1.0' };

async function fetchRetry(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(15000) });
      return res;
    } catch (e) {
      if (i === retries - 1) throw e;
      console.log(`  Fetch retry ${i + 1}/${retries}: ${e.code || e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  const gpxFile = args.find(a => a.endsWith('.gpx'));
  if (!gpxFile) {
    console.error('Usage: bun start <path/to/track.gpx> [--fps 30] [--width 1920] [--height 1080] [--output output/trail.mp4] [--preview] [--duration SECS] [--title NAME] [--end NAME] [--name TRAIL_NAME]');
    process.exit(1);
  }
  if (!(await fileExists(gpxFile))) {
    console.error(`GPX file not found: ${gpxFile}`);
    process.exit(1);
  }
  const fps      = parseInt(flag(args, '--fps') || '30');
  const width    = parseInt(flag(args, '--width') || '1920');
  const height   = parseInt(flag(args, '--height') || '1080');
  const outFile  = flag(args, '--output') || 'output/trail.mp4';
  const preview  = args.includes('--preview');
  const port     = 3456;

  if (!preview) await preflight();

  await fs.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });

  console.log(`Parsing ${gpxFile}...`);
  const trackData = parseGPX(gpxFile);
  console.log(`  ${trackData.totalPoints} points -> ${trackData.points.length} (downsampled)`);
  console.log(`  Distance: ${(trackData.totalDistance / 1000).toFixed(1)} km`);
  console.log(`  Elevation: ${Math.round(trackData.bounds.minEle)}m - ${Math.round(trackData.bounds.maxEle)}m`);
  console.log(`  Stops: ${trackData.stops.length}`);

  // ---- All network tasks in parallel (different APIs), with disk cache ----
  const titleOverride = flag(args, '--title');
  const endOverride = flag(args, '--end');
  const trailName = flag(args, '--name');
  const cacheFile = gpxFile.replace(/\.gpx$/i, '.cache.json');
  const t0 = Date.now();

  if (await fileExists(cacheFile)) {
    console.log(`Loading cached data from ${cacheFile}...`);
    const cache = JSON.parse(await fs.readFile(cacheFile, 'utf-8'));
    // Restore calibrated elevations
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
  } else {
    console.log('Fetching DEM + geocoding + POIs + border (parallel)...');
    const [, , rawPois] = await Promise.all([
      calibrateElevation(trackData),             // Open-Meteo
      geocodeAndBorder(trackData, titleOverride, endOverride), // Nominatim
      queryRawPOIs(trackData.bounds),             // Overpass
    ]).then(([a, b, pois]) => [a, b, pois]);
    trackData.pois = filterPOIs(rawPois, trackData.points);

    // Save cache
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
    console.log(`  Cached to ${cacheFile}`);
  }

  console.log(`  Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  DEM range: ${Math.round(trackData.bounds.minEle)}m - ${Math.round(trackData.bounds.maxEle)}m`);
  console.log(`  Country: ${trackData.country} | Start: ${trackData.startName}`);
  for (const s of trackData.stops) console.log(`  Stop: ${s.name} (${Math.round(s.ele)}m)`);
  console.log(`  POIs: ${trackData.pois.length} (${trackData.pois.filter(p => p.type === 'peak').length} peaks, ${trackData.pois.filter(p => p.type === 'lake').length} lakes, ${trackData.pois.filter(p => p.type === 'pass').length} passes)`);

  // Auto-compute duration from distance + stops, or use --duration override
  const auto = computeRenderConfig(trackData, fps);
  const duration = parseInt(flag(args, '--duration') || String(auto.duration));
  const totalFrames = duration * fps;
  const introFrames = auto.introFrames;
  console.log(`  Video: ${duration}s @ ${fps}fps = ${totalFrames} frames (auto: ${auto.duration}s = ${INTRO_SEC}s intro + ${auto.autoTrailSec.toFixed(0)}s trail + ${auto.autoDwellSec}s dwell)`);

  // Pass introFrames + optional trail name to frontend via config
  const server = await startServer(trackData, API_KEY, port, introFrames, {
    ...(trailName ? { trailName } : {}),
  });

  if (preview) {
    console.log(`\nPreview: http://localhost:${port}\nCtrl+C to stop.`);
    return;
  }

  try {
    await captureFrames({ port, outputDir: path.dirname(path.resolve(outFile)), totalFrames, fps, width, height, outputFile: path.resolve(outFile) });
  } finally {
    server.close();
  }

  console.log('Done!');
  process.exit(0);
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

async function preflight() {
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); }
  catch { console.error('ffmpeg not found. Install: brew install ffmpeg  (macOS) | apt install ffmpeg  (Debian)'); process.exit(1); }

  try {
    const exe = chromium.executablePath();
    await fs.access(exe);
  } catch {
    console.error('Playwright chromium not installed. Run: bunx playwright install chromium');
    process.exit(1);
  }
}

/* ==================== DEM calibration (sparse + interpolate) ==================== */

async function calibrateElevation(trackData) {
  const pts = trackData.points;
  const SAMPLE_EVERY = 30; // calibrate every 30th point
  const BATCH = 50;

  // Build sample indices
  const indices = [];
  for (let i = 0; i < pts.length; i += SAMPLE_EVERY) indices.push(i);
  if (indices[indices.length - 1] !== pts.length - 1) indices.push(pts.length - 1);

  // Fetch DEM for sample points only (~100 points = 2 batches)
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
        );
        data = await res.json();
        if (data.elevation) break;
        console.log(`  DEM HTTP ${res.status}, retrying...`);
      } catch (e) {
        console.log(`  DEM fetch failed (${e.code || e.name || e.message}), retrying...`);
      }
      console.log('  DEM rate limited, waiting 60s...');
      await new Promise(r => setTimeout(r, 60000));
    }

    if (data?.elevation) {
      for (let j = 0; j < batchIdx.length; j++) {
        demEle[b + j] = data.elevation[j];
      }
    }
    if (b + BATCH < indices.length) await new Promise(r => setTimeout(r, 1500));
  }

  // Interpolate between sample points
  for (let s = 0; s < indices.length - 1; s++) {
    const i0 = indices[s], i1 = indices[s + 1];
    const e0 = demEle[s], e1 = demEle[s + 1];
    if (e0 == null || e1 == null) continue;
    for (let i = i0; i <= i1; i++) {
      const t = (i - i0) / (i1 - i0);
      pts[i].ele = e0 + (e1 - e0) * t;
    }
  }

  // Update stops + bounds
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

async function reverseGeocode(lat, lon) {
  const res = await fetchRetry(
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14&accept-language=en`,
    { headers: NOM_HEADERS },
  );
  const d = await res.json();
  return {
    name: d.address?.village || d.address?.town || d.address?.hamlet || d.address?.city || d.name || 'Unknown',
    country: d.address?.country || 'Unknown',
  };
}

async function fetchCountryBorder(country) {
  try {
    const res = await fetchRetry(
      `https://nominatim.openstreetmap.org/search?country=${encodeURIComponent(country)}&format=geojson&polygon_geojson=1&polygon_threshold=0.01&limit=1`,
      { headers: NOM_HEADERS },
    );
    const data = await res.json();
    if (data.features?.[0]?.geometry) return data.features[0].geometry;
  } catch (e) {
    console.warn(`  Country border lookup failed (${e.code || e.message}); continuing without border.`);
  }
  return null;
}

async function geocodeAndBorder(trackData, titleOverride, endOverride) {
  const p0 = trackData.points[0];

  // Start point + country
  const startGeo = await reverseGeocode(p0.lat, p0.lon);
  trackData.startName = titleOverride || startGeo.name;
  trackData.country = startGeo.country;

  // Country border (share Nominatim rate limit)
  await new Promise(r => setTimeout(r, 1100));
  trackData.countryBorder = await fetchCountryBorder(trackData.country);

  // Stops
  for (const stop of trackData.stops) {
    await new Promise(r => setTimeout(r, 1100));
    const geo = await reverseGeocode(stop.lat, stop.lon);
    stop.name = geo.name;
  }

  // End point
  const pEnd = trackData.points[trackData.points.length - 1];
  if (endOverride) {
    trackData.endName = endOverride;
  } else {
    await new Promise(r => setTimeout(r, 1100));
    const endGeo = await reverseGeocode(pEnd.lat, pEnd.lon);
    trackData.endName = endGeo.name;
  }

  // Build segments: [{from, to, startIdx, endIdx}, ...]
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

async function queryRawPOIs(bounds) {
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
          { signal: AbortSignal.timeout(30000) },
        );
        if (!res.ok) {
          console.log(`  Overpass ${server} HTTP ${res.status}, retrying...`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        const data = await res.json();
        return parseRawPOIs(data.elements);
      } catch (e) {
        console.log(`  Overpass ${server} failed (${e.code || e.name || e.message}), retrying...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  console.warn('  POI query failed on all Overpass mirrors; continuing without POIs.');
  return [];
}

// Generic/insignificant water body names to skip
const LAKE_SKIP = /^(tarn|pond|small|pool|puddle|holy pond)/i;

function parseRawPOIs(elements) {
  const pois = [];
  const seen = new Set(); // deduplicate by name
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

    // Skip generic water names
    if (type === 'lake' && LAKE_SKIP.test(name)) continue;

    // Deduplicate
    const key = `${type}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    pois.push({ name, ele, lat, lon, type });
  }
  return pois;
}

function filterPOIs(rawPois, trackPoints) {
  const MAX_PEAKS = 8;
  const MAX_LAKES = 6;
  const MAX_PASSES = 3;
  const MAX_DIST_PEAK = 15000;
  const MAX_DIST_LAKE = 10000;
  const MAX_DIST_PASS = 5000;

  // Sample track for fast distance calc
  const sample = trackPoints.filter((_, i) => i % 20 === 0);

  // Compute distance + nearby avg elevation for each POI
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

  // --- Peaks: prominence + absolute scoring ---
  const peaks = rawPois.filter(p => p.type === 'peak' && p.ele && p.distToTrack < MAX_DIST_PEAK);

  if (peaks.length > 0) {
    const peakEles = peaks.map(p => p.ele);
    const maxPeakEle = Math.max(...peakEles);
    const minPeakEle = Math.min(...peakEles);
    const eleRange = maxPeakEle - minPeakEle || 1;

    // Max prominence in dataset (for normalization)
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

  // --- Lakes & passes: by proximity ---
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

async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }

main().catch((err) => { console.error(err); process.exit(1); });
