// Camera target = where the camera *wants* to be at time t. The rAF loop
// passes this through springs to get the camera position actually rendered.
//
// Two follow strategies, selectable via opts.cursorFollowMode:
//
//   • 'dead-zone' (default, FocuSee / Screen Studio feel):
//       The camera locks to the zoom anchor (cx, cy). The cursor moves
//       freely inside a "safe zone" — a normalized rectangle of half-width
//       safeZone/(2*zoom) in source coordinates around the anchor. When the
//       cursor leaves that rectangle the camera target shifts JUST FAR
//       ENOUGH to push the cursor back to the band edge. The cursor never
//       drags the camera around inside the middle of the frame, which is
//       the artifact users called "sticky cursor".
//
//   • 'soft' (legacy):
//       Camera target = anchor + (cursor - anchor) * k. The whole frame
//       chases the cursor at k of its motion, so the cursor appears to move
//       at (1-k) speed in the viewport. Kept for users who prefer it.
//
// The export mirror lives in src/main/cameraBake.js — any change here MUST be
// reflected there so preview and exported MP4 agree.

import { sampleZoomFromZooms, activeZoomAt } from './zoomTimeline.js'
import { sampleMouseAt } from './zoomTimeline.js'

const DEFAULT_FOLLOW_MODE = 'dead-zone'
const DEFAULT_SAFE_ZONE = 0.6   // 60% of viewport is "free space"
const DEFAULT_FOLLOW_AMOUNT = 0.7 // soft-mode strength

// Returns target { zoom, cx, cy } at time tMs.
//   zooms      – timeline zoom regions
//   moves      – decimated cursor moves (output of decimateMoves)
//   tMs        – current time
//   opts.cursorFollowMode    – 'dead-zone' | 'soft' | 'none'
//   opts.cursorFollowSafeZone – 0..1 (dead-zone mode)
//   opts.cursorFollowAmount  – 0..1 (soft mode)
export function sampleCameraTarget(zooms, moves, tMs, opts = {}) {
  const mode = opts.cursorFollowMode ?? DEFAULT_FOLLOW_MODE
  const base = sampleZoomFromZooms(zooms, tMs)
  if (base.zoom <= 1.0001 || mode === 'none') return base

  const active = activeZoomAt(zooms, tMs)
  if (!active) return base

  // Hold-progress tapers the follow influence during ease-in / ease-out so
  // the camera doesn't lurch toward the cursor mid-easing.
  let holdProgress
  if (tMs < active.peakStart) {
    const p = (tMs - active.start) / Math.max(1, active.peakStart - active.start)
    holdProgress = Math.max(0, Math.min(1, p))
  } else if (tMs > active.peakEnd) {
    const p = (active.end - tMs) / Math.max(1, active.end - active.peakEnd)
    holdProgress = Math.max(0, Math.min(1, p))
  } else {
    holdProgress = 1
  }

  const m = sampleMouseAt(moves, tMs, { x: base.cx, y: base.cy })

  if (mode === 'soft') {
    const follow = (opts.cursorFollowAmount ?? DEFAULT_FOLLOW_AMOUNT) * holdProgress
    return {
      zoom: base.zoom,
      cx: base.cx + (m.x - base.cx) * follow,
      cy: base.cy + (m.y - base.cy) * follow
    }
  }

  // ── dead-zone mode ──
  //
  // The visible window in source-space is centered on the camera's cx,cy
  // and has half-extent 1/(2*zoom). The "safe band" is a centered rect with
  // half-extent (safeZone/2)/zoom inside that. Outside the band, the camera
  // shifts by (excess) so the cursor lands ON the band edge — that's the
  // minimum pan that satisfies the visibility constraint.
  const safe = Math.max(0, Math.min(0.95, opts.cursorFollowSafeZone ?? DEFAULT_SAFE_ZONE))
  const halfBand = (safe / 2) / base.zoom

  let cx = base.cx
  let cy = base.cy
  const dx = m.x - base.cx
  const dy = m.y - base.cy
  if (Math.abs(dx) > halfBand) {
    const excess = (Math.abs(dx) - halfBand) * Math.sign(dx)
    cx += excess * holdProgress
  }
  if (Math.abs(dy) > halfBand) {
    const excess = (Math.abs(dy) - halfBand) * Math.sign(dy)
    cy += excess * holdProgress
  }
  // Don't pan so far that we'd reveal "outside the source frame" — clamp the
  // camera so the viewport stays within [0,1] in source-normalized coords.
  const halfWin = 1 / (2 * base.zoom)
  cx = Math.max(halfWin, Math.min(1 - halfWin, cx))
  cy = Math.max(halfWin, Math.min(1 - halfWin, cy))
  return { zoom: base.zoom, cx, cy }
}
