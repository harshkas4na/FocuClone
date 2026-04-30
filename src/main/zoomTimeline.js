// Mirror of src/renderer/src/lib/zoomTimeline.js — kept in sync so processor.js
// uses the exact same math as the live preview. Only the FFmpeg expression
// builder + zoomsFromEvents/clickWindowsFromZooms are needed by main.

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
export function sampleZoomAt(zooms, tMs) {
  let bestZ = 1
  let bestCx = 0.5
  let bestCy = 0.5
  for (const w of zooms || []) {
    if (tMs < w.start || tMs > w.end) continue
    let ease
    if (tMs <= w.peakStart) ease = easeOutCubic((tMs - w.start) / Math.max(1, w.peakStart - w.start))
    else if (tMs >= w.peakEnd) ease = easeInCubic((w.end - tMs) / Math.max(1, w.end - w.peakEnd))
    else ease = 1
    const z = 1 + (w.zoomLevel - 1) * ease
    if (z > bestZ) { bestZ = z; bestCx = w.cx; bestCy = w.cy }
  }
  return { zoom: bestZ, cx: bestCx, cy: bestCy }
}

// Shift all zooms by -trimInMs and drop those entirely outside [0, durMs].
// Clamp partially-overlapping ones to the trim range.
export function applyTrimToZooms(zooms, trimInMs, durMs) {
  const shifted = []
  for (const z of zooms || []) {
    const start = z.start - trimInMs
    const end = z.end - trimInMs
    if (end <= 0 || start >= durMs) continue
    const peakStart = Math.max(start, z.peakStart - trimInMs)
    const peakEnd = Math.min(end, z.peakEnd - trimInMs)
    shifted.push({
      ...z,
      start: Math.max(0, start),
      peakStart: Math.max(0, peakStart),
      peakEnd: Math.min(durMs, peakEnd),
      end: Math.min(durMs, end)
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
