// Shared timeline math used by both the live preview (renderer) and the
// FFmpeg expression builder (main).
//
// Two stages:
//   1. Click events → initial Zoom[] (one per click, debounced)
//   2. Editable Zoom[] is the source of truth for the editor + export
//
// A Zoom owns its own timing/center/level, so per-zoom edits don't bleed
// into other zooms.

export const DEFAULT_TIMELINE_OPTS = {
  zoomLevel: 2.0,
  easeInDuration: 280,
  holdDuration: 1200,
  easeOutDuration: 360,
  minTimeBetweenZooms: 800
}

let _idSeq = 0
function makeId() {
  _idSeq += 1
  return `z${Date.now().toString(36)}${_idSeq}`
}

// ─── Build Zooms from click events ─────────────────────────────────────────
export function zoomsFromEvents(events, opts = {}) {
  const o = { ...DEFAULT_TIMELINE_OPTS, ...opts }
  const clicks = (events || []).filter((e) => e.type === 'click')
  const debounced = []
  for (const c of clicks) {
    const last = debounced[debounced.length - 1]
    if (!last || c.timestamp - last.timestamp >= o.minTimeBetweenZooms) debounced.push(c)
  }
  return debounced.map((c) => ({
    id: makeId(),
    source: 'click',
    cx: c.screenW > 0 ? c.x / c.screenW : 0.5,
    cy: c.screenH > 0 ? c.y / c.screenH : 0.5,
    start: c.timestamp,
    peakStart: c.timestamp + o.easeInDuration,
    peakEnd: c.timestamp + o.easeInDuration + o.holdDuration,
    end: c.timestamp + o.easeInDuration + o.holdDuration + o.easeOutDuration,
    zoomLevel: o.zoomLevel
  }))
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
export function sampleZoomFromZooms(zooms, tMs) {
  let bestZ = 1
  let bestCx = 0.5
  let bestCy = 0.5
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
    if (z > bestZ) {
      bestZ = z
      bestCx = w.cx
      bestCy = w.cy
    }
  }
  return { zoom: bestZ, cx: bestCx, cy: bestCy }
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
