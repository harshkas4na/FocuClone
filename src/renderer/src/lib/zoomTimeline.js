// Shared timeline math used by both the live preview (renderer) and the
// FFmpeg expression builder (main).
//
// Two stages:
//   1. Click events → initial Zoom[] (one per click, debounced)
//   2. Editable Zoom[] is the source of truth for the editor + export
//
// A Zoom owns its own timing/center/level, so per-zoom edits don't bleed
// into other zooms.

// Timing + magnification defaults.
//
// The model is "continuous zoom with click retargeting" — exactly how
// FocuSee / Screen Studio feel. A cluster is any run of clicks within
// `clusterMergeGapMs` of each other (no distance gate; far-apart clicks
// inside a session still belong to one continuous zoom — the camera just
// pans between them via the dead-zone follow and anchor list). The whole
// cluster becomes ONE zoom region whose zoom level stays at peak while the
// user is active, and whose cx/cy retargets to each successive click via
// per-anchor points.
//
// Tight ease durations + a long-ish merge gap = one slow zoom-in once, fluid
// pans around as the user clicks, one slow zoom-out when they stop.
export const DEFAULT_TIMELINE_OPTS = {
  zoomLevel: 1.5,
  easeInDuration: 150,
  holdDuration: 700,         // hold time AFTER the last click in a cluster
  easeOutDuration: 200,
  clusterMergeGapMs: 2500,   // up to 2.5s gap between clicks still merges
  clusterPadMs: 60           // tiny lead-in before the first click
}

let _idSeq = 0
function makeId() {
  _idSeq += 1
  return `z${Date.now().toString(36)}${_idSeq}`
}

// ─── Build Zooms from click events ─────────────────────────────────────────
//
// Clusters consecutive clicks that fall within `clusterMergeGapMs` of each
// other into ONE zoom region. The region:
//   • starts at firstClick - clusterPadMs (clamped ≥ 0)
//   • holds through lastClick + holdDuration
//   • eases out over easeOutDuration
//   • focuses on the centroid of the cluster's clicks
// Single-click clusters reduce to the original per-click zoom shape when
// clusterPadMs = 0.
function normClick(c) {
  return {
    nx: c.screenW > 0 ? c.x / c.screenW : 0.5,
    ny: c.screenH > 0 ? c.y / c.screenH : 0.5
  }
}

export function zoomsFromEvents(events, opts = {}) {
  const o = { ...DEFAULT_TIMELINE_OPTS, ...opts }
  const clicks = (events || [])
    .filter((e) => e.type === 'click')
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp)
  if (!clicks.length) return []

  // Time-only clustering. We deliberately don't gate on click distance:
  // distant clicks within a session are MEANT to share one zoom — the
  // camera just pans between them via anchor retargeting during peak hold.
  // Splitting on distance was what produced the "zoom out, zoom in, zoom
  // out, zoom in" chaos when the user clicked around quickly.
  const clusters = []
  let cur = [clicks[0]]
  for (let i = 1; i < clicks.length; i++) {
    const c = clicks[i]
    const prev = cur[cur.length - 1]
    if (c.timestamp - prev.timestamp <= o.clusterMergeGapMs) {
      cur.push(c)
    } else {
      clusters.push(cur)
      cur = [c]
    }
  }
  clusters.push(cur)

  return clusters.map((cluster) => {
    const first = cluster[0]
    const last = cluster[cluster.length - 1]
    // Per-anchor retarget timeline: each click contributes a (t, cx, cy)
    // point. sampleZoomFromZooms picks the most recent anchor for the
    // camera center during peak hold; springs smooth the transitions.
    // Single-click clusters omit the anchor array since there's nothing to
    // retarget to.
    const anchors = cluster.map((c) => {
      const n = normClick(c)
      return { t: c.timestamp, cx: n.nx, cy: n.ny }
    })
    const lastN = normClick(last)
    const start = Math.max(0, first.timestamp - o.clusterPadMs)
    const peakStart = start + o.easeInDuration
    // Hold ends `holdDuration` AFTER the last click — so each new click in
    // the cluster pushes the hold window forward instead of cutting it short.
    const peakEnd = Math.max(peakStart + 50, last.timestamp + o.holdDuration)
    const end = peakEnd + o.easeOutDuration
    return {
      id: makeId(),
      source: 'click',
      // Primary anchor = last click (fallback when anchors absent / for the
      // simple FFmpeg expression path).
      cx: lastN.nx,
      cy: lastN.ny,
      anchors: cluster.length > 1 ? anchors : undefined,
      start,
      peakStart,
      peakEnd,
      end,
      zoomLevel: o.zoomLevel,
      clusterSize: cluster.length
    }
  })
}

// Resolve the camera (cx, cy) target for a zoom region at the given time.
// If the zoom has anchor points (multi-click cluster), pick the most recent
// anchor whose t ≤ tMs. Otherwise fall back to the static cx/cy.
export function anchorAt(zoom, tMs) {
  if (!zoom.anchors || zoom.anchors.length === 0) {
    return { cx: zoom.cx, cy: zoom.cy }
  }
  // anchors are inserted in time order by zoomsFromEvents; binary-search.
  let lo = 0
  let hi = zoom.anchors.length - 1
  if (tMs <= zoom.anchors[0].t) return { cx: zoom.anchors[0].cx, cy: zoom.anchors[0].cy }
  if (tMs >= zoom.anchors[hi].t) return { cx: zoom.anchors[hi].cx, cy: zoom.anchors[hi].cy }
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (zoom.anchors[mid].t <= tMs) lo = mid
    else hi = mid
  }
  return { cx: zoom.anchors[lo].cx, cy: zoom.anchors[lo].cy }
}

export function makeManualZoom(centerMs, opts = {}) {
  const o = { ...DEFAULT_TIMELINE_OPTS, ...opts }
  const halfHold = o.holdDuration / 2
  const start = Math.max(0, centerMs - o.easeInDuration - halfHold)
  return {
    id: makeId(),
    source: 'manual',
    cx: 0.5,
    cy: 0.5,
    start,
    peakStart: start + o.easeInDuration,
    peakEnd: start + o.easeInDuration + o.holdDuration,
    end: start + o.easeInDuration + o.holdDuration + o.easeOutDuration,
    zoomLevel: o.zoomLevel
  }
}

// Re-derive timing fields when start moves or one of the durations changes.
export function recomputeZoomTimings(z, patch) {
  const next = { ...z, ...patch }
  // Allow caller to edit any of: start, peakStart, peakEnd, end directly.
  // Then keep them ordered.
  next.start = Math.max(0, Math.min(next.start, next.peakStart - 50))
  next.peakStart = Math.max(next.start + 50, Math.min(next.peakStart, next.peakEnd - 50))
  next.peakEnd = Math.max(next.peakStart + 50, Math.min(next.peakEnd, next.end - 50))
  next.end = Math.max(next.peakEnd + 50, next.end)
  return next
}

// Move a zoom in time by `dMs`, preserving its shape.
export function shiftZoom(z, dMs, totalDur = Infinity) {
  const len = z.end - z.start
  let start = Math.max(0, z.start + dMs)
  if (start + len > totalDur) start = Math.max(0, totalDur - len)
  const dt = start - z.start
  return {
    ...z,
    start: z.start + dt,
    peakStart: z.peakStart + dt,
    peakEnd: z.peakEnd + dt,
    end: z.end + dt
  }
}

// Easing.
function easeOutCubic(p) {
  const x = 1 - p
  return 1 - x * x * x
}
function easeInCubic(p) {
  return p * p * p
}

// Sample (zoom, cx, cy) at time t (ms) from a zooms array.
//
// When multiple zooms overlap, the zoom LEVEL is `max` across them (you'd
// rather be too-zoomed than too-loose), and the cx/cy is a WEIGHTED BLEND
// by ease — without that blend, the camera center snaps from one anchor to
// another on the single frame where the dominant z changes hands, which
// shows up as a visible flicker. The blend means the camera glides between
// anchors smoothly during the overlap.
export function sampleZoomFromZooms(zooms, tMs) {
  let bestZ = 1
  let cxAccum = 0
  let cyAccum = 0
  let weightAccum = 0
  for (const w of zooms || []) {
    if (tMs < w.start || tMs > w.end) continue
    let ease
    if (tMs <= w.peakStart) {
      const p = (tMs - w.start) / Math.max(1, w.peakStart - w.start)
      ease = easeOutCubic(p)
    } else if (tMs >= w.peakEnd) {
      const p = (w.end - tMs) / Math.max(1, w.end - w.peakEnd)
      ease = easeInCubic(p)
    } else {
      ease = 1
    }
    const z = 1 + (w.zoomLevel - 1) * ease
    if (z > bestZ) bestZ = z
    // Pull the current camera anchor from the zoom's per-click anchor list
    // (or its static cx/cy if it doesn't have anchors). Multi-click clusters
    // smoothly retarget here while the zoom stays at peak — that's what
    // gives the "camera follows me click-to-click" feel instead of
    // zoom-out-zoom-in chaos.
    const a = anchorAt(w, tMs)
    cxAccum += a.cx * ease
    cyAccum += a.cy * ease
    weightAccum += ease
  }
  if (weightAccum <= 0) return { zoom: 1, cx: 0.5, cy: 0.5 }
  return { zoom: bestZ, cx: cxAccum / weightAccum, cy: cyAccum / weightAccum }
}

// Find the zoom currently active at time tMs (if any). When multiple overlap,
// returns the one whose ease is highest.
export function activeZoomAt(zooms, tMs) {
  let best = null
  let bestEase = 0
  for (const w of zooms || []) {
    if (tMs < w.start || tMs > w.end) continue
    let ease
    if (tMs <= w.peakStart) ease = easeOutCubic((tMs - w.start) / Math.max(1, w.peakStart - w.start))
    else if (tMs >= w.peakEnd) ease = easeInCubic((w.end - tMs) / Math.max(1, w.end - w.peakEnd))
    else ease = 1
    if (ease >= bestEase) {
      bestEase = ease
      best = w
    }
  }
  return best
}

// ─── FFmpeg expression builder ─────────────────────────────────────────────
function escNum(n) {
  return Number.isFinite(n) ? (+n.toFixed(6)).toString() : '0'
}

export function buildZoomExpressionsFromZooms(zooms, timeVar = 'time') {
  if (!zooms || !zooms.length) {
    return { zExpr: '1', cxExpr: '0.5', cyExpr: '0.5' }
  }
  let zEase = '0' // accumulated max ease ∈ [0,1]
  let cxExpr = '0.5'
  let cyExpr = '0.5'
  let zLevelAccum = '1' // overall zoom factor accounting for varying levels

  for (const w of zooms) {
    const t0 = escNum(w.start / 1000)
    const t1 = escNum(w.peakStart / 1000)
    const t2 = escNum(w.peakEnd / 1000)
    const t3 = escNum(w.end / 1000)
    const dIn = escNum((w.peakStart - w.start) / 1000)
    const dOut = escNum((w.end - w.peakEnd) / 1000)
    const cx = escNum(w.cx)
    const cy = escNum(w.cy)
    const Z = escNum(w.zoomLevel)

    const pIn = `((${timeVar}-${t0})/${dIn})`
    const pOut = `((${t3}-${timeVar})/${dOut})`
    const easeIn = `(1 - pow(1 - ${pIn}, 3))`
    const easeOut = `pow(${pOut}, 3)`
    const winEase = `if(between(${timeVar},${t0},${t1}),${easeIn},if(between(${timeVar},${t1},${t2}),1,if(between(${timeVar},${t2},${t3}),${easeOut},0)))`
    // Per-zoom z value: 1 + (Z-1)*winEase, blends to 1 outside
    const winZ = `(1 + (${Z} - 1) * (${winEase}))`
    // Compose so that overlapping zooms take the highest current z value.
    zLevelAccum = `max(${zLevelAccum},${winZ})`

    const inWin = `between(${timeVar},${t0},${t3})`
    cxExpr = `if(${inWin},${cx},${cxExpr})`
    cyExpr = `if(${inWin},${cy},${cyExpr})`
    // (zEase kept for any future visualisation; not used in final z output)
    zEase = `max(${zEase},${winEase})`
  }

  return { zExpr: zLevelAccum, cxExpr, cyExpr }
}

// Decimate move events for cursor preview.
export function decimateMoves(events, opts = {}) {
  const stepMs = 1000 / Math.max(1, opts.cursorMoveSampleHz || 30)
  const minDeltaNorm = (opts.cursorMoveMinDeltaPx || 4) / 1920
  const moves = (events || []).filter((e) => e.type === 'move')
  const out = []
  let lastT = -Infinity
  let lastX = -1
  let lastY = -1
  for (const m of moves) {
    const nx = m.screenW > 0 ? m.x / m.screenW : 0.5
    const ny = m.screenH > 0 ? m.y / m.screenH : 0.5
    const dt = m.timestamp - lastT
    const dPos = Math.hypot(nx - lastX, ny - lastY)
    if (dt >= stepMs || dPos >= minDeltaNorm) {
      out.push({ t: m.timestamp, x: nx, y: ny })
      lastT = m.timestamp
      lastX = nx
      lastY = ny
    }
  }
  return out
}

export function sampleMouseAt(decimated, tMs, fallback = { x: 0.5, y: 0.5 }) {
  if (!decimated.length) return fallback
  if (tMs <= decimated[0].t) return { x: decimated[0].x, y: decimated[0].y }
  const last = decimated[decimated.length - 1]
  if (tMs >= last.t) return { x: last.x, y: last.y }
  let lo = 0
  let hi = decimated.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (decimated[mid].t <= tMs) lo = mid
    else hi = mid
  }
  const a = decimated[lo]
  const b = decimated[hi]
  const dt = b.t - a.t
  const p = dt > 0 ? (tMs - a.t) / dt : 0
  return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p }
}

// Click windows used by some UI bits — derived directly from zooms now.
export function clickWindowsFromZooms(zooms) {
  return (zooms || []).map((z) => ({
    click: { x: z.cx, y: z.cy, timestamp: (z.start + z.end) / 2 },
    cx: z.cx,
    cy: z.cy,
    start: z.start,
    peakStart: z.peakStart,
    peakEnd: z.peakEnd,
    end: z.end
  }))
}
