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

export function computeRenderConfig(trackData, fps) {
  const distKm = trackData.totalDistance / 1000;
  const autoTrailSec = Math.max(MIN_TRAIL_SEC, distKm * TRAIL_PACE);
  const autoDwellSec = trackData.stops.length * DWELL_SEC;
  const duration = Math.ceil(INTRO_SEC + autoTrailSec + autoDwellSec + FINISH_SEC);
  const totalFrames = duration * fps;
  const introFrames = INTRO_SEC * fps;
  return { duration, totalFrames, introFrames, autoTrailSec, autoDwellSec };
}
