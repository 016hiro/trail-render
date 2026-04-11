/**
 * Camera strategy: "smooth-constant"
 *
 * Multi-pass moving-average smoothing + constant-speed frame distribution.
 * - 3-pass box filter (≈ Gaussian σ≈30) on position
 * - Start/end anchored to raw coords with linear ramp
 * - Bearing derived from smoothed path tangent + circular MA
 * - Constant speed along smooth path's own cumulative distance
 * - Light EMA on bearing for cinematic turn smoothness
 *
 * Interface (all strategies must export):
 *   name        — human-readable name
 *   init(pts, stops, config) — precompute; called once
 *   getIntro(frameIndex, introFrames) — returns {lon,lat,zoom,pitch,bearing}
 *   getTrail(trailFrame)              — returns {lon,lat,zoom,pitch,bearing}
 */

export const name = 'smooth-constant';

// === Tunable parameters (optimized via camera-sweep.js) ===
const SMOOTH_WINDOW   = 100;  // box filter width (points) — wider = smoother position
const SMOOTH_PASSES   = 2;    // number of MA passes — 2×100 ≈ Gaussian σ≈41
const BEARING_WINDOW  = 160;  // circular MA window for bearing — wider = less turn jitter
const MAX_BEARING_RATE = 1.8; // degrees/frame cap to gentle hairpin turns
const BEARING_EMA     = 0.03; // EMA factor on bearing — lower = smoother rotation
const ANCHOR_RAMP     = 60;   // frames to blend from raw→smooth at start/end
const TRAIL_ZOOM      = 11.5;
const TRAIL_PITCH     = 50;

// === Internal state ===
let smoothPath = null;  // {lat, lon, bearing, dist} Float64Arrays
let camFrames  = null;  // {lon, lat, bearing} Float64Arrays, one per trail frame
let camBearing = 0;
let inited     = false;
let introBearing = 0;
let dwellFrames, labelShowFrames;

/** Called once at startup — just enough for intro phase. */
export function initIntro(pts) {
  smoothPath = buildSmoothPath(pts);
  introBearing = stableBearing(pts, 0, 80);
  camBearing = 0;
  inited = false;
}

/** Called once when trail phase starts (needs trailFrames count). */
export function initTrail(pts, stops, cfg) {
  dwellFrames = cfg.dwellFrames;
  labelShowFrames = cfg.labelShowFrames;
  if (!smoothPath) smoothPath = buildSmoothPath(pts);
  camFrames = buildCameraFrames(smoothPath, stops, cfg.trailFrames, pts.length, cfg.schedule);
}

export function getIntro(frameIndex, introFrames) {
  const t = easeInOutCubic(frameIndex / (introFrames - 1));
  return {
    lon:     smoothPath.lon[0],
    lat:     smoothPath.lat[0],
    zoom:    1.5 + (TRAIL_ZOOM - 1.5) * t,
    pitch:   TRAIL_PITCH * t,
    bearing: lerpAngle(0, introBearing, t),
    t,  // eased progress 0→1 (for overlay fade scheduling)
  };
}

export function getTrail(trailFrame) {
  if (!inited) {
    camBearing = introBearing;
    inited = true;
  }
  // EMA toward target, but cap absolute angular velocity so sharp GPX
  // hairpins (the 43.23s peak) don't rotate the view faster than the
  // scene_score detector can tolerate. The camera lags through the turn
  // and catches up once the target slows.
  const emaStep = lerpAngle(camBearing, camFrames.bearing[trailFrame], BEARING_EMA);
  let step = ((emaStep - camBearing + 540) % 360) - 180;
  if (step >  MAX_BEARING_RATE) step =  MAX_BEARING_RATE;
  if (step < -MAX_BEARING_RATE) step = -MAX_BEARING_RATE;
  camBearing = (camBearing + step + 360) % 360;
  return {
    lon:     camFrames.lon[trailFrame],
    lat:     camFrames.lat[trailFrame],
    zoom:    TRAIL_ZOOM,
    pitch:   TRAIL_PITCH,
    bearing: camBearing,
  };
}

// === Internal helpers ===

function lerpAngle(a, b, t) {
  return a + (((b - a + 540) % 360) - 180) * t;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function stableBearing(pts, from, count) {
  let s = 0, c = 0;
  const end = Math.min(from + count, pts.length);
  for (let i = from; i < end; i++) {
    const r = pts[i].bearing * Math.PI / 180;
    s += Math.sin(r);
    c += Math.cos(r);
  }
  return (Math.atan2(s, c) * 180 / Math.PI + 360) % 360;
}

function buildSmoothPath(pts) {
  const n = pts.length;
  const half = Math.floor(SMOOTH_WINDOW / 2);
  let lat = new Float64Array(n);
  let lon = new Float64Array(n);
  for (let i = 0; i < n; i++) { lat[i] = pts[i].lat; lon[i] = pts[i].lon; }

  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const nLat = new Float64Array(n);
    const nLon = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let latS = 0, lonS = 0, count = 0;
      const lo = Math.max(0, i - half);
      const hi = Math.min(n - 1, i + half);
      for (let j = lo; j <= hi; j++) { latS += lat[j]; lonS += lon[j]; count++; }
      nLat[i] = latS / count;
      nLon[i] = lonS / count;
    }
    lat = nLat;
    lon = nLon;
  }

  // Anchor start/end
  const ramp = Math.min(ANCHOR_RAMP, Math.floor(n * 0.02));
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

  // Bearing from tangent
  const bearing = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) {
    const dLat = lat[i + 1] - lat[i];
    const dLon = (lon[i + 1] - lon[i]) * Math.cos(lat[i] * Math.PI / 180);
    bearing[i] = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
  }
  bearing[n - 1] = bearing[n - 2];

  // Smooth bearing (circular MA)
  const bHalf = Math.floor(BEARING_WINDOW / 2);
  const sBearing = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sinS = 0, cosS = 0;
    const lo = Math.max(0, i - bHalf);
    const hi = Math.min(n - 1, i + bHalf);
    for (let j = lo; j <= hi; j++) {
      const r = bearing[j] * Math.PI / 180;
      sinS += Math.sin(r);
      cosS += Math.cos(r);
    }
    sBearing[i] = (Math.atan2(sinS, cosS) * 180 / Math.PI + 360) % 360;
  }

  // Cumulative distance along smooth path
  const dist = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dLat = (lat[i] - lat[i - 1]) * 111320;
    const dLon = (lon[i] - lon[i - 1]) * 111320 * Math.cos(lat[i] * Math.PI / 180);
    dist[i] = dist[i - 1] + Math.sqrt(dLat * dLat + dLon * dLon);
  }

  return { lat, lon, bearing: sBearing, dist };
}

// Localized ease: the first/last EASE_FRAMES of each motion segment
// smoothstep-accelerate from 0 to cruise speed, the middle is linear.
// This eats the dwell-boundary velocity discontinuity without speeding
// up cruise motion (full-segment ease introduced new mid-segment peaks).
const EASE_FRAMES = 60;

function buildEasedPositions(segFrames) {
  const N = segFrames;
  const K = Math.min(EASE_FRAMES, Math.max(0, Math.floor((N - 1) / 3)));
  const pos = new Float64Array(N);
  if (N <= 1) { pos[0] = 0; return pos; }

  // Per-frame velocity: smoothstep ease-in, linear middle, smoothstep ease-out.
  // Integral of smoothstep(x) dx from 0..1 = 0.5, so K ease frames cover K*0.5
  // linear-frame-distance units.  Total distance = K*0.5 + (N-2K) + K*0.5 = N-K,
  // which we normalize to 1.
  const totalDist = Math.max(1, N - K);
  let d = 0;
  for (let sf = 0; sf < N; sf++) {
    let v;
    if (K > 1 && sf < K) {
      const x = sf / K;
      v = x * x * (3 - 2 * x);                    // smoothstep(x), 0→1
    } else if (K > 1 && sf >= N - K) {
      const x = (N - sf) / K;                     // (N-sf)/K gives 1..0 as sf→N-1
      v = x * x * (3 - 2 * x);                    // smoothstep flipped, 1→0
    } else {
      v = 1;
    }
    d += v;
    pos[sf] = d / totalDist;
  }
  return pos;
}

function buildCameraFrames(sp, stops, trailFrames, nPts, schedule) {
  const breakIdxs = schedule?.breakIdxs;
  const segFramesList = schedule?.segFrames;

  const lon = new Float64Array(trailFrames);
  const lat = new Float64Array(trailFrames);
  const bearing = new Float64Array(trailFrames);
  let f = 0;

  for (let seg = 0; seg < breakIdxs.length - 1; seg++) {
    const segFrames = segFramesList?.[seg] ?? 0;
    const startD = sp.dist[breakIdxs[seg]];
    const endD   = sp.dist[breakIdxs[seg + 1]];
    const eased = buildEasedPositions(segFrames);

    for (let sf = 0; sf < segFrames && f < trailFrames; sf++, f++) {
      const t = eased[sf];
      const targetD = startD + (endD - startD) * t;
      let lo = 0, hi = nPts - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (sp.dist[mid] <= targetD) lo = mid; else hi = mid;
      }
      const segLen = sp.dist[hi] - sp.dist[lo];
      const frac = segLen > 0 ? (targetD - sp.dist[lo]) / segLen : 0;
      lon[f] = sp.lon[lo] + (sp.lon[hi] - sp.lon[lo]) * frac;
      lat[f] = sp.lat[lo] + (sp.lat[hi] - sp.lat[lo]) * frac;
      const bDiff = ((sp.bearing[hi] - sp.bearing[lo] + 540) % 360) - 180;
      bearing[f] = (sp.bearing[lo] + bDiff * frac + 360) % 360;
    }

    if (seg < breakIdxs.length - 2) {
      const si = breakIdxs[seg + 1];
      for (let d = 0; d < dwellFrames && f < trailFrames; d++, f++) {
        lon[f] = sp.lon[si]; lat[f] = sp.lat[si]; bearing[f] = sp.bearing[si];
      }
    }
  }

  const ei = nPts - 1;
  while (f < trailFrames) {
    lon[f] = sp.lon[ei]; lat[f] = sp.lat[ei]; bearing[f] = sp.bearing[ei]; f++;
  }

  return { lon, lat, bearing };
}
