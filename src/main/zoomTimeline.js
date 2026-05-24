// Mirror of src/renderer/src/lib/zoomTimeline.js — kept in sync so processor.js
// uses the exact same math as the live preview. Only the FFmpeg expression
// builder + zoomsFromEvents/clickWindowsFromZooms are needed by main.

// Mirror of the renderer's DEFAULT_TIMELINE_OPTS — keep in sync. See
// renderer/src/lib/zoomTimeline.js for design notes.
export const DEFAULT_TIMELINE_OPTS = {
  zoomLevel: 1.5,
  easeInDuration: 150,
  holdDuration: 700,
  easeOutDuration: 200,
  clusterMergeGapMs: 2500,
  clusterPadMs: 60
}

let _idSeq = 0
function makeId() {
  _idSeq += 1
  return `z${Date.now().toString(36)}${_idSeq}`
}

// Cluster nearby clicks into a single zoom region (see renderer copy for
// full doc). Kept in lock-step with src/renderer/src/lib/zoomTimeline.js.
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

  const clusters = []
  let cur = [clicks[0]]
  for (let i = 1; i < clicks.length; i++) {
    const c = clicks[i]
    const prev = cur[cur.length - 1]
    if (c.timestamp - prev.timestamp <= o.clusterMergeGapMs) cur.push(c)
    else {
      clusters.push(cur)
      cur = [c]
    }
  }
  clusters.push(cur)

  return clusters.map((cluster) => {
    const first = cluster[0]
    const last = cluster[cluster.length - 1]
    const anchors = cluster.map((c) => {
      const n = normClick(c)
      return { t: c.timestamp, cx: n.nx, cy: n.ny }
    })
    const lastN = normClick(last)
    const start = Math.max(0, first.timestamp - o.clusterPadMs)
    const peakStart = start + o.easeInDuration
    const peakEnd = Math.max(peakStart + 50, last.timestamp + o.holdDuration)
    const end = peakEnd + o.easeOutDuration
    return {
      id: makeId(),
      source: 'click',
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

// Resolve camera (cx, cy) target for a zoom region at the given time.
// Mirror of renderer/lib/zoomTimeline.js#anchorAt.
export function anchorAt(zoom, tMs) {
  if (!zoom.anchors || zoom.anchors.length === 0) {
    return { cx: zoom.cx, cy: zoom.cy }
  }
  if (tMs <= zoom.anchors[0].t) return { cx: zoom.anchors[0].cx, cy: zoom.anchors[0].cy }
  const lastIdx = zoom.anchors.length - 1
  if (tMs >= zoom.anchors[lastIdx].t) {
    return { cx: zoom.anchors[lastIdx].cx, cy: zoom.anchors[lastIdx].cy }
  }
  let lo = 0
  let hi = lastIdx
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (zoom.anchors[mid].t <= tMs) lo = mid
    else hi = mid
  }
  return { cx: zoom.anchors[lo].cx, cy: zoom.anchors[lo].cy }
}

// Decimate raw move events to a coarse polyline — one point per ~50ms
// or whenever the cursor jumps more than `minDelta` normalized units.
export function decimateMoves(events, opts = {}) {
  const stepMs = 1000 / Math.max(1, opts.cursorMoveSampleHz || 30)
  const minDeltaNorm = (opts.cursorMoveMinDeltaPx || 4) / 1920
  const moves = (events || []).filter((e) => e.type === 'move')
  if (!moves.length) return []
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

// Linear-interp cursor position at time t over decimated moves
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

// Sample (zoom, cx, cy) at time t — same logic as the renderer.
function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3) }
function easeInCubic(p) { return p * p * p }

export function activeZoomAt(zooms, tMs) {
  let best = null
  let bestEase = 0
  for (const w of zooms || []) {
    if (tMs < w.start || tMs > w.end) continue
    let ease
    if (tMs <= w.peakStart) ease = easeOutCubic((tMs - w.start) / Math.max(1, w.peakStart - w.start))
    else if (tMs >= w.peakEnd) ease = easeInCubic((w.end - tMs) / Math.max(1, w.end - w.peakEnd))
    else ease = 1
    if (ease >= bestEase) { bestEase = ease; best = w }
  }
  return best
}

// Renderer-side mirror is named `sampleZoomFromZooms`; keep both names so
// either side imports cleanly.
export const sampleZoomFromZooms = sampleZoomAt

export function sampleZoomAt(zooms, tMs) {
  let bestZ = 1
  let cxAccum = 0
  let cyAccum = 0
  let weightAccum = 0
  for (const w of zooms || []) {
    if (tMs < w.start || tMs > w.end) continue
    let ease
    if (tMs <= w.peakStart) ease = easeOutCubic((tMs - w.start) / Math.max(1, w.peakStart - w.start))
    else if (tMs >= w.peakEnd) ease = easeInCubic((w.end - tMs) / Math.max(1, w.end - w.peakEnd))
    else ease = 1
    const z = 1 + (w.zoomLevel - 1) * ease
    if (z > bestZ) bestZ = z
    const a = anchorAt(w, tMs)
    cxAccum += a.cx * ease
    cyAccum += a.cy * ease
    weightAccum += ease
  }
  if (weightAccum <= 0) return { zoom: 1, cx: 0.5, cy: 0.5 }
  return { zoom: bestZ, cx: cxAccum / weightAccum, cy: cyAccum / weightAccum }
}

// Shift all zooms by -trimInMs and drop those entirely outside [0, durMs].
// Clamp partially-overlapping ones to the trim range. Per-click anchors get
// the same shift so the camera continues to retarget correctly after trim.
export function applyTrimToZooms(zooms, trimInMs, durMs) {
  const shifted = []
  for (const z of zooms || []) {
    const start = z.start - trimInMs
    const end = z.end - trimInMs
    if (end <= 0 || start >= durMs) continue
    const peakStart = Math.max(start, z.peakStart - trimInMs)
    const peakEnd = Math.min(end, z.peakEnd - trimInMs)
    const anchors = Array.isArray(z.anchors)
      ? z.anchors
          .map((a) => ({ ...a, t: a.t - trimInMs }))
          .filter((a) => a.t >= 0 && a.t <= durMs)
      : undefined
    shifted.push({
      ...z,
      start: Math.max(0, start),
      peakStart: Math.max(0, peakStart),
      peakEnd: Math.min(durMs, peakEnd),
      end: Math.min(durMs, end),
      anchors: anchors && anchors.length > 1 ? anchors : undefined
    })
  }
  return shifted
}

export function applyTrimToMoves(moves, trimInMs, durMs) {
  const out = []
  for (const m of moves || []) {
    const t = m.t - trimInMs
    if (t < 0 || t > durMs) continue
    out.push({ ...m, t })
  }
  return out
}

// Build sendcmd-format commands that drive overlay@ov x/y per frame so the
// cursor follows the actual mouse path through the zoom transform.
export function buildCursorSendcmd({
  zooms,
  decimatedMoves,
  W,
  H,
  cursorW,
  cursorH,
  fps,
  durSec
}) {
  const lines = []
  const totalFrames = Math.ceil(durSec * fps)
  let lastX = Number.NaN
  let lastY = Number.NaN
  for (let f = 0; f <= totalFrames; f++) {
    const tMs = (f / fps) * 1000
    const { zoom, cx, cy } = sampleZoomAt(zooms, tMs)
    const m = sampleMouseAt(decimatedMoves, tMs, { x: cx, y: cy })
    const z = Math.max(zoom, 1)
    // Output coords (matches the math in processor.js): center of cursor at
    // ((mouse - zoomCenter) * z + 0.5) * <output dim>.
    let ox = Math.round(W * ((m.x - cx) * z + 0.5) - cursorW / 2)
    let oy = Math.round(H * ((m.y - cy) * z + 0.5) - cursorH / 2)
    // Clamp to a small overflow margin so cursor near edges stays drawn
    ox = Math.max(-cursorW, Math.min(W, ox))
    oy = Math.max(-cursorH, Math.min(H, oy))
    if (ox === lastX && oy === lastY) continue
    lastX = ox
    lastY = oy
    const t = (f / fps).toFixed(3)
    lines.push(`${t} overlay@ov x ${ox}, overlay@ov y ${oy};`)
  }
  return lines.join('\n')
}

export function clickWindowsFromZooms(zooms) {
  return (zooms || []).map((z) => ({
    cx: z.cx,
    cy: z.cy,
    start: z.start,
    peakStart: z.peakStart,
    peakEnd: z.peakEnd,
    end: z.end
  }))
}

function escNum(n) {
  return Number.isFinite(n) ? (+n.toFixed(6)).toString() : '0'
}

export function buildZoomExpressionsFromZooms(zooms, timeVar = 'time') {
  if (!zooms || !zooms.length) {
    return { zExpr: '1', cxExpr: '0.5', cyExpr: '0.5' }
  }
  let cxExpr = '0.5'
  let cyExpr = '0.5'
  let zLevelAccum = '1'

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
    const winZ = `(1 + (${Z} - 1) * (${winEase}))`
    zLevelAccum = `max(${zLevelAccum},${winZ})`

    const inWin = `between(${timeVar},${t0},${t3})`
    cxExpr = `if(${inWin},${cx},${cxExpr})`
    cyExpr = `if(${inWin},${cy},${cyExpr})`
  }

  return { zExpr: zLevelAccum, cxExpr, cyExpr }
}
