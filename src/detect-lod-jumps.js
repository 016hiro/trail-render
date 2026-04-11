import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

import { parseGPX } from './parse-gpx.js';
import { startServer } from './server.js';
import { computeRenderConfig } from './render-config.js';
import {
  tileLevel,
  tileSignature,
  sameTileLists,
  diffTiles,
  inferTileTransitions,
  computeStats,
} from './lod-analysis.js';

const API_KEY = process.env.MAPTILER_KEY;
if (!API_KEY) {
  console.error('MAPTILER_KEY env var is required.');
  process.exit(1);
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function restoreCachedMeta(trackData, gpxFile) {
  const cacheFile = gpxFile.replace(/\.gpx$/i, '.cache.json');
  if (!fs.existsSync(cacheFile)) return false;

  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
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
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const gpxFile = args.find((arg) => arg.endsWith('.gpx'));
  if (!gpxFile) {
    console.error('Usage: node src/detect-lod-jumps.js <path/to/track.gpx> [--fps 30] [--port 3456] [--output output/lod_report.json] [--start-frame N] [--end-frame N]');
    process.exit(1);
  }
  if (!fs.existsSync(gpxFile)) {
    console.error(`GPX file not found: ${gpxFile}`);
    process.exit(1);
  }
  const fps = parseInt(flag(args, '--fps') || '30', 10);
  const port = parseInt(flag(args, '--port') || '3456', 10);
  const outputFile = path.resolve(flag(args, '--output') || 'output/lod_report.json');
  const startFrameOverride = flag(args, '--start-frame');
  const endFrameOverride = flag(args, '--end-frame');

  const trackData = parseGPX(gpxFile);
  if (!restoreCachedMeta(trackData, gpxFile)) {
    throw new Error(`Missing cache file for ${gpxFile}; run a normal render once before detection.`);
  }

  const { duration, totalFrames, introFrames } = computeRenderConfig(trackData, fps);
  const trailStart = startFrameOverride ? parseInt(startFrameOverride, 10) : introFrames;
  const trailEnd = endFrameOverride ? parseInt(endFrameOverride, 10) : totalFrames - 1;

  await fsp.mkdir(path.dirname(outputFile), { recursive: true });

  const server = await startServer(trackData, API_KEY, port, introFrames);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
    ],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    console.log(`Opening detector page on http://localhost:${port} ...`);
    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForFunction('window.mapReady === true', { timeout: 90000 });
    await page.waitForTimeout(2000);

    console.log('Pre-warming with the same path as render...');
    await page.evaluate((tf) => window.__prewarmTrail(tf), totalFrames);
    await page.evaluate(() => {
      const p0 = window.__trackPoints[0];
      window.__mapInstance.jumpTo({ center: [p0.lon, p0.lat], zoom: 1.5, pitch: 0, bearing: 0 });
    });
    await page.waitForTimeout(1500);

    const frames = [];
    console.log(`Scanning frames ${trailStart}..${trailEnd} (${trailEnd - trailStart + 1} frames)...`);
    const startedAt = Date.now();

    for (let frameIndex = trailStart; frameIndex <= trailEnd; frameIndex++) {
      await page.evaluate(
        ([fi, tf]) => window.setFrame(fi, tf),
        [frameIndex, totalFrames],
      );
      await page.waitForFunction('window.frameReady === true', { timeout: 12000 });

      const sample = await page.evaluate(() => {
        const m = window.__mapInstance;
        const center = m.getCenter();
        return {
          tile: window.__getTileDebugState(),
          canvas: window.__getCanvasDebugMetrics(),
          camera: {
            lon: center.lng,
            lat: center.lat,
            zoom: m.getZoom(),
            pitch: m.getPitch(),
            bearing: m.getBearing(),
          },
          hud: {
            dist: document.getElementById('v-dist')?.textContent || '',
            ele: document.getElementById('v-ele')?.textContent || '',
            day: document.getElementById('v-day')?.textContent || '',
          },
          overlay: {
            night: +(document.getElementById('night-overlay')?.style.opacity || 0),
            route: +(document.getElementById('route-label')?.style.opacity || 0),
            stop: +(document.getElementById('stop-label')?.style.opacity || 0),
          },
        };
      });

      if (!sample.tile) {
        throw new Error(`tile debug unavailable at frame ${frameIndex}`);
      }

      frames.push({
        frameIndex,
        trailFrame: frameIndex - introFrames,
        timeSec: frameIndex / fps,
        camera: sample.camera,
        hud: sample.hud,
        overlay: sample.overlay,
        canvas: sample.canvas,
        sources: Object.fromEntries(
          Object.entries(sample.tile.sources).map(([sourceId, source]) => [
            sourceId,
            {
              renderableTiles: (source.renderableTiles || []).map((tile) => ({
                key: tile.key,
                z: tile.z,
                x: tile.x,
                y: tile.y,
                overscaledZ: tile.overscaledZ,
                state: tile.state,
                rawId: tile.rawId,
              })),
            },
          ]),
        ),
      });

      if ((frameIndex - trailStart) % 60 === 0 || frameIndex === trailEnd) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
        const done = frameIndex - trailStart + 1;
        const total = trailEnd - trailStart + 1;
        console.log(`  ${done}/${total} frames (${elapsed}s elapsed)`);
      }
    }

    const events = [];
    const lapDeltas = [];
    const lumaDeltas = [];

    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1];
      const curr = frames[i];

      for (const sourceId of ['satellite', 'satellite-trail', 'terrain-src']) {
        const prevSource = prev.sources[sourceId] || { renderableTiles: [] };
        const currSource = curr.sources[sourceId] || { renderableTiles: [] };
        const prevSig = tileSignature(prevSource);
        const currSig = tileSignature(currSource);
        if (sameTileLists(prevSig, currSig)) continue;

        const { added, removed } = diffTiles(prevSource.renderableTiles, currSource.renderableTiles);
        const transitions = inferTileTransitions(removed, added);

        events.push({
          type: 'tile_set_changed',
          sourceId,
          frameIndex: curr.frameIndex,
          trailFrame: curr.trailFrame,
          timeSec: curr.timeSec,
          added: added.map((tile) => `${tile.key}@${tileLevel(tile)}`),
          removed: removed.map((tile) => `${tile.key}@${tileLevel(tile)}`),
          upgrades: transitions.upgrades,
          downgrades: transitions.downgrades,
        });
      }

      if (!prev.canvas?.error && !curr.canvas?.error) {
        lapDeltas.push({
          frameIndex: curr.frameIndex,
          timeSec: curr.timeSec,
          delta: curr.canvas.laplacianVariance - prev.canvas.laplacianVariance,
        });
        lumaDeltas.push({
          frameIndex: curr.frameIndex,
          timeSec: curr.timeSec,
          delta: curr.canvas.meanLuma - prev.canvas.meanLuma,
        });
      }
    }

    const lapStats = computeStats(lapDeltas.map((entry) => Math.abs(entry.delta)));
    const lumaStats = computeStats(lumaDeltas.map((entry) => Math.abs(entry.delta)));
    const sharpnessThreshold = Math.max(lapStats.p99, lapStats.mean + lapStats.stddev * 4);
    const lumaThreshold = Math.max(lumaStats.p99, lumaStats.mean + lumaStats.stddev * 4);

    const suspiciousFrames = frames
      .slice(1)
      .map((curr, index) => {
        const prev = frames[index];
        const lapDelta = !prev.canvas?.error && !curr.canvas?.error
          ? curr.canvas.laplacianVariance - prev.canvas.laplacianVariance
          : null;
        const lumaDelta = !prev.canvas?.error && !curr.canvas?.error
          ? curr.canvas.meanLuma - prev.canvas.meanLuma
          : null;
        const frameEvents = events.filter((event) => event.frameIndex === curr.frameIndex);
        const hasUpgrade = frameEvents.some((event) => event.upgrades.length > 0);

        if (
          Math.abs(lapDelta ?? 0) < sharpnessThreshold &&
          Math.abs(lumaDelta ?? 0) < lumaThreshold &&
          !hasUpgrade
        ) {
          return null;
        }

        return {
          frameIndex: curr.frameIndex,
          trailFrame: curr.trailFrame,
          timeSec: curr.timeSec,
          laplacianDelta: lapDelta,
          lumaDelta,
          eventTypes: frameEvents.map((event) => ({
            sourceId: event.sourceId,
            upgrades: event.upgrades.length,
            downgrades: event.downgrades.length,
            added: event.added.length,
            removed: event.removed.length,
          })),
        };
      })
      .filter(Boolean);

    const report = {
      meta: {
        gpxFile,
        fps,
        duration,
        totalFrames,
        introFrames,
        scannedFrameRange: [trailStart, trailEnd],
        generatedAt: new Date().toISOString(),
      },
      thresholds: {
        sharpnessAbsDelta: sharpnessThreshold,
        lumaAbsDelta: lumaThreshold,
      },
      stats: {
        tileEvents: events.length,
        laplacianAbsDelta: lapStats,
        lumaAbsDelta: lumaStats,
      },
      events,
      suspiciousFrames,
      frames,
    };

    await fsp.writeFile(outputFile, JSON.stringify(report, null, 2));
    console.log(`Detector report saved to ${outputFile}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
