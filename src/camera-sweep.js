/**
 * Offline parameter sweep for camera strategies.
 * Pure math — no browser needed. Tests many parameter combos in seconds.
 */
import { parseGPX } from './parse-gpx.js';
import fs from 'fs';

const gpxFile = process.argv[2] || 'activity_580930440.gpx';
const data = parseGPX(gpxFile);
const pts = data.points;
const stops = data.stops;
const n = pts.length;

// Frame budget (same as index.js auto-compute)
const DWELL_FRAMES = 60;
const LABEL_SHOW_FRAMES = 120;
const distKm = data.totalDistance / 1000;
const introSec = 9, dwellSec = 2, finishSec = 4, fps = 30;
const trailSec = Math.max(20, distKm * 0.5);
const totalSec = introSec + trailSec + stops.length * dwellSec + finishSec;
const totalFrames = Math.round(totalSec * fps);
const trailFrames = totalFrames - Math.round(introSec * fps);

// ==================== Core algorithms ====================

function buildSmoothPath(pts, window, passes) {
  const half = Math.floor(window / 2);
  let lat = new Float64Array(n);
  let lon = new Float64Array(n);
  for (let i = 0; i < n; i++) { lat[i] = pts[i].lat; lon[i] = pts[i].lon; }

  for (let pass = 0; pass < passes; pass++) {
    const nLat = new Float64Array(n);
    const nLon = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let latS = 0, lonS = 0, count = 0;
      const lo = Math.max(0, i - half);
      const hi = Math.min(n - 1, i + half);
      for (let j = lo; j <= hi; j++) { latS += lat[j]; lonS += lon[j]; count++; }
      nLat[i] = latS / count; nLon[i] = lonS / count;
    }
    lat = nLat; lon = nLon;
  }

  const ramp = Math.min(60, Math.floor(n * 0.02));
  for (let i = 0; i < ramp; i++) {
    const t = i / ramp;
    lat[i] = pts[i].lat * (1 - t) + lat[i] * t;
    lon[i] = pts[i].lon * (1 - t) + lon[i] * t;
  }
  for (let i = n - 1; i >= n - ramp; i--) {
    const t = (n - 1 - i) / ramp;
    lat[i] = pts[i].lat * (1 - t) + lat[i] * t;
    lon[i] = pts[i].lon * (1 - t) + lon[i] * t;
  }

  return { lat, lon };
}

function computeBearing(lat, lon, bearWindow) {
  const bearing = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) {
    const dLat = lat[i + 1] - lat[i];
    const dLon = (lon[i + 1] - lon[i]) * Math.cos(lat[i] * Math.PI / 180);
    bearing[i] = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
  }
  bearing[n - 1] = bearing[n - 2];

  const bHalf = Math.floor(bearWindow / 2);
  const sb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sinS = 0, cosS = 0;
    const lo = Math.max(0, i - bHalf);
    const hi = Math.min(n - 1, i + bHalf);
    for (let j = lo; j <= hi; j++) {
      const r = bearing[j] * Math.PI / 180;
      sinS += Math.sin(r); cosS += Math.cos(r);
    }
    sb[i] = (Math.atan2(sinS, cosS) * 180 / Math.PI + 360) % 360;
  }
  return sb;
}

function computeDist(lat, lon) {
  const dist = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dLat = (lat[i] - lat[i - 1]) * 111320;
    const dLon = (lon[i] - lon[i - 1]) * 111320 * Math.cos(lat[i] * Math.PI / 180);
    dist[i] = dist[i - 1] + Math.sqrt(dLat * dLat + dLon * dLon);
  }
  return dist;
}

function buildCameraFrames(sp, bearEma, transRamp) {
  const sorted = [...stops].sort((a, b) => a.index - b.index);
  const FINISH_FRAMES = LABEL_SHOW_FRAMES;
  const dwellTotal = sorted.length * DWELL_FRAMES + FINISH_FRAMES;
  const moveFrames = trailFrames - dwellTotal;
  const breakIdxs = [0, ...sorted.map(s => s.index), n - 1];

  let totalMoveDist = 0;
  const segDists = [];
  for (let seg = 0; seg < breakIdxs.length - 1; seg++) {
    const d = sp.dist[breakIdxs[seg + 1]] - sp.dist[breakIdxs[seg]];
    segDists.push(d); totalMoveDist += d;
  }

  const lon = new Float64Array(trailFrames);
  const lat = new Float64Array(trailFrames);
  const bearing = new Float64Array(trailFrames);
  let f = 0;

  for (let seg = 0; seg < breakIdxs.length - 1; seg++) {
    const segFrames = Math.max(1, Math.round((segDists[seg] / totalMoveDist) * moveFrames));
    const startD = sp.dist[breakIdxs[seg]];
    const endD = sp.dist[breakIdxs[seg + 1]];

    for (let sf = 0; sf < segFrames && f < trailFrames; sf++, f++) {
      const t = sf / Math.max(segFrames - 1, 1);
      const targetD = startD + (endD - startD) * t;
      let lo = 0, hi = n - 1;
      while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (sp.dist[mid] <= targetD) lo = mid; else hi = mid; }
      const segLen = sp.dist[hi] - sp.dist[lo];
      const frac = segLen > 0 ? (targetD - sp.dist[lo]) / segLen : 0;
      lon[f] = sp.lon[lo] + (sp.lon[hi] - sp.lon[lo]) * frac;
      lat[f] = sp.lat[lo] + (sp.lat[hi] - sp.lat[lo]) * frac;
      const bDiff = ((sp.bearing[hi] - sp.bearing[lo] + 540) % 360) - 180;
      bearing[f] = (sp.bearing[lo] + bDiff * frac + 360) % 360;
    }

    if (seg < breakIdxs.length - 2) {
      const si = breakIdxs[seg + 1];
      for (let d = 0; d < DWELL_FRAMES && f < trailFrames; d++, f++) {
        lon[f] = sp.lon[si]; lat[f] = sp.lat[si]; bearing[f] = sp.bearing[si];
      }
    }
  }

  const ei = n - 1;
  while (f < trailFrames) { lon[f] = sp.lon[ei]; lat[f] = sp.lat[ei]; bearing[f] = sp.bearing[ei]; f++; }

  // Apply bearing EMA
  const introBear = (() => {
    let s = 0, c = 0;
    for (let i = 0; i < Math.min(80, n); i++) { const r = pts[i].bearing * Math.PI / 180; s += Math.sin(r); c += Math.cos(r); }
    return (Math.atan2(s, c) * 180 / Math.PI + 360) % 360;
  })();

  const finalBear = new Float64Array(trailFrames);
  let cb = introBear;
  for (let i = 0; i < trailFrames; i++) {
    cb = cb + (((bearing[i] - cb + 540) % 360) - 180) * bearEma;
    finalBear[i] = cb;
  }

  // Apply transition ramp (ease in/out at movement↔dwell boundaries)
  if (transRamp > 0) {
    applyTransitionRamp(lon, lat, finalBear, transRamp);
  }

  return { lon, lat, bearing: finalBear };
}

function applyTransitionRamp(lon, lat, bearing, rampFrames) {
  // Find dwell boundaries and ease velocity in/out
  const vel = [];
  for (let i = 1; i < trailFrames; i++) {
    const dx = (lon[i] - lon[i-1]) * 111320 * Math.cos(lat[i] * Math.PI / 180);
    const dy = (lat[i] - lat[i-1]) * 111320;
    vel.push(Math.sqrt(dx*dx + dy*dy));
  }

  // Detect transition points (moving→dwell or dwell→moving)
  const THRESH = 1.0;
  const isMoving = vel.map(v => v > THRESH);

  // Find start/end of each movement segment
  const segments = [];
  let inSeg = false, segStart = 0;
  for (let i = 0; i < isMoving.length; i++) {
    if (isMoving[i] && !inSeg) { segStart = i; inSeg = true; }
    if (!isMoving[i] && inSeg) { segments.push([segStart, i - 1]); inSeg = false; }
  }
  if (inSeg) segments.push([segStart, isMoving.length - 1]);

  // For each movement segment, blend positions at boundaries
  for (const [start, end] of segments) {
    const len = end - start + 1;
    if (len < rampFrames * 2 + 2) continue;

    // Ease-in: first rampFrames of segment
    for (let i = 0; i < rampFrames; i++) {
      const fi = start + i + 1; // +1 because frame indices are offset by 1 from vel
      const t = (i + 1) / (rampFrames + 1); // 0→1
      const ease = t * t * (3 - 2 * t); // smoothstep
      const anchor = fi === 0 ? 0 : fi - 1;
      // Blend: at t=0 stay at previous pos, at t=1 full movement
      if (fi > 0 && fi < trailFrames) {
        const prevLon = lon[start]; // dwell position before this segment
        const prevLat = lat[start];
        lon[fi] = prevLon + (lon[fi] - prevLon) * ease;
        lat[fi] = prevLat + (lat[fi] - prevLat) * ease;
      }
    }

    // Ease-out: last rampFrames of segment
    for (let i = 0; i < rampFrames; i++) {
      const fi = end - rampFrames + i + 1 + 1;
      if (fi >= trailFrames || fi < 0) continue;
      const t = (rampFrames - i) / (rampFrames + 1);
      const ease = t * t * (3 - 2 * t);
      const nextLon = lon[Math.min(end + 2, trailFrames - 1)]; // dwell position after
      const nextLat = lat[Math.min(end + 2, trailFrames - 1)];
      lon[fi] = nextLon + (lon[fi] - nextLon) * ease;
      lat[fi] = nextLat + (lat[fi] - nextLat) * ease;
    }
  }
}

// ==================== Metrics ====================

function measure(cam) {
  const nf = trailFrames;

  // Position in meters
  const pos = [];
  for (let i = 0; i < nf; i++) {
    pos.push({
      x: cam.lon[i] * 111320 * Math.cos(cam.lat[i] * Math.PI / 180),
      y: cam.lat[i] * 111320,
    });
  }

  const vel = [];
  for (let i = 1; i < nf; i++) {
    const dx = pos[i].x - pos[i-1].x, dy = pos[i].y - pos[i-1].y;
    vel.push(Math.sqrt(dx*dx + dy*dy));
  }

  const THRESH = 1.0;
  const isMoving = vel.map(v => v > THRESH);

  const bearVel = [];
  for (let i = 1; i < nf; i++) {
    bearVel.push(((cam.bearing[i] - cam.bearing[i-1] + 540) % 360) - 180);
  }

  const midAccel = [], midBearAccel = [], transAccel = [];
  for (let i = 1; i < vel.length; i++) {
    const a = Math.abs(vel[i] - vel[i-1]);
    const ba = Math.abs(bearVel[i] - bearVel[i-1]);
    const isTrans = isMoving[i] !== isMoving[i-1];
    if (isTrans) transAccel.push(a);
    else if (isMoving[i]) { midAccel.push(a); midBearAccel.push(ba); }
  }

  const rms = arr => arr.length ? Math.sqrt(arr.reduce((s,v)=>s+v*v,0)/arr.length) : 0;
  const mean = arr => arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0;
  const std = arr => { const m=mean(arr); return arr.length ? Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length) : 0; };
  const max = arr => arr.length ? arr.reduce((m,v)=>v>m?v:m,0) : 0;
  const p = (arr, pct) => { if (!arr.length) return 0; const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length*pct)]; };

  const movingVel = vel.filter(v => v > THRESH);
  const movingBearVel = [];
  for (let i = 0; i < bearVel.length; i++) { if (isMoving[i]) movingBearVel.push(Math.abs(bearVel[i])); }

  return {
    posRMS: rms(midAccel),
    posP95: p(midAccel, 0.95),
    posP99: p(midAccel, 0.99),
    posMax: max(midAccel),
    velCV: movingVel.length ? std(movingVel)/mean(movingVel) : 0,
    bearRMS: rms(midBearAccel),
    bearP95: p(midBearAccel, 0.95),
    bearP99: p(midBearAccel, 0.99),
    bearMax: max(midBearAccel),
    bearVelCV: movingBearVel.length ? std(movingBearVel)/(mean(movingBearVel)||1) : 0,
    transMax: max(transAccel),
    transCount: transAccel.length,
    freeze: vel.filter(v => v < 0.1).length,
  };
}

// ==================== Sweep ====================

const configs = [];

// Vary smoothing intensity
for (const w of [40, 60, 80, 100]) {
  for (const p of [2, 3, 4, 5]) {
    configs.push({ label: `w${w}p${p}`, window: w, passes: p, bearWin: 80, bearEma: 0.08, ramp: 0 });
  }
}

// Vary bearing params (fix position smoothing at best from above → will pick after)
for (const bw of [60, 80, 120, 160]) {
  for (const be of [0.03, 0.05, 0.08, 0.12, 0.15]) {
    configs.push({ label: `bw${bw}e${be}`, window: 60, passes: 3, bearWin: bw, bearEma: be, ramp: 0 });
  }
}

// Transition ramp
for (const r of [0, 10, 20, 30]) {
  configs.push({ label: `ramp${r}`, window: 60, passes: 3, bearWin: 80, bearEma: 0.08, ramp: r });
}

console.log(`Testing ${configs.length} configurations on ${n} points, ${trailFrames} trail frames...\n`);

const results = [];
for (const cfg of configs) {
  const sp = buildSmoothPath(pts, cfg.window, cfg.passes);
  const bearing = computeBearing(sp.lat, sp.lon, cfg.bearWin);
  const dist = computeDist(sp.lat, sp.lon);
  const fullSp = { lat: sp.lat, lon: sp.lon, bearing, dist };
  const cam = buildCameraFrames(fullSp, cfg.bearEma, cfg.ramp);
  const m = measure(cam);
  results.push({ ...cfg, ...m });
}

// Sort by position RMS (primary smoothness metric)
results.sort((a, b) => a.posRMS - b.posRMS);

// Print table
const hdr = 'Label'.padEnd(16) +
  'PosRMS'.padStart(8) + 'PosP95'.padStart(8) + 'PosMax'.padStart(8) + 'VelCV'.padStart(8) +
  'BearRMS'.padStart(9) + 'BearP95'.padStart(9) + 'BearMax'.padStart(9) + 'BVelCV'.padStart(8) +
  'TransMx'.padStart(9) + 'Freeze'.padStart(8);

console.log(hdr);
console.log('-'.repeat(hdr.length));
for (const r of results) {
  console.log(
    r.label.padEnd(16) +
    r.posRMS.toFixed(3).padStart(8) +
    r.posP95.toFixed(3).padStart(8) +
    r.posMax.toFixed(1).padStart(8) +
    r.velCV.toFixed(4).padStart(8) +
    r.bearRMS.toFixed(4).padStart(9) +
    r.bearP95.toFixed(4).padStart(9) +
    r.bearMax.toFixed(2).padStart(9) +
    r.bearVelCV.toFixed(4).padStart(8) +
    r.transMax.toFixed(1).padStart(9) +
    String(r.freeze).padStart(8)
  );
}

// Highlight best per dimension
console.log('\n--- Best per dimension ---');
const best = (key, asc=true) => results.reduce((b,r) => (asc ? r[key] < b[key] : r[key] > b[key]) ? r : b);
console.log('Position Accel RMS:', best('posRMS').label, best('posRMS').posRMS.toFixed(3));
console.log('Position Vel CV:   ', best('velCV').label, best('velCV').velCV.toFixed(4));
console.log('Bearing Accel RMS: ', best('bearRMS').label, best('bearRMS').bearRMS.toFixed(4));
console.log('Bearing Vel CV:    ', best('bearVelCV').label, best('bearVelCV').bearVelCV.toFixed(4));
console.log('Transition Max:    ', best('transMax').label, best('transMax').transMax.toFixed(1));

// Save full results
fs.writeFileSync('output/sweep_results.json', JSON.stringify(results, null, 2));
