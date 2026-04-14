// Shared timing constants + duration math. Imported by the renderer
// (src/index.js) and the LOD detector (src/detect-lod-jumps.js) so the two
// pipelines cannot drift apart.
//
// These are high-level pacing knobs, not per-frame tunables. Camera smoothing
// parameters stay in public/camera/<strategy>.js because they are strategy-
// owned.

export const INTRO_SEC = 9;       // globe→trail zoom
export const TRAIL_PACE = 0.5;    // seconds per km of trail
export const DWELL_SEC = 2;       // seconds held at each overnight stop
export const MIN_TRAIL_SEC = 20;  // floor for very short tracks
export const FINISH_SEC = 4;      // hold at the end for the finish label

export function computeRenderConfig(trackData, fps, overrides = {}) {
  const introSec    = overrides.introSec    ?? INTRO_SEC;
  const trailPace   = overrides.trailPace   ?? TRAIL_PACE;
  const dwellSec    = overrides.dwellSec    ?? DWELL_SEC;
  const minTrailSec = overrides.minTrailSec ?? MIN_TRAIL_SEC;
  const finishSec   = overrides.finishSec   ?? FINISH_SEC;

  const distKm = trackData.totalDistance / 1000;
  const autoTrailSec = Math.max(minTrailSec, distKm * trailPace);
  const autoDwellSec = trackData.stops.length * dwellSec;
  const duration = Math.ceil(introSec + autoTrailSec + autoDwellSec + finishSec);
  const totalFrames = duration * fps;
  const introFrames = Math.round(introSec * fps);
  const finishFrames = Math.round(finishSec * fps);
  return { duration, totalFrames, introFrames, finishFrames, autoTrailSec, autoDwellSec };
}
