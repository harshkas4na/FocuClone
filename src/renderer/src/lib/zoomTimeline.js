// Shared timeline math used by both the live preview (renderer) and the
// FFmpeg expression builder (main). Instead of sampling easing into many
// keyframes, we evaluate the easing formula directly at any time t — this
// gives infinite resolution for the live preview and tight expressions for
// FFmpeg.

export const DEFAULT_TIMELINE_OPTS = {
  zoomLevel: 2.0,
  easeInDuration: 280,
  holdDuration: 1200,
  easeOutDuration: 360,
  minTimeBetweenZooms: 800,
  cursorMoveSampleHz: 20,
  cursorMoveMinDeltaPx: 6
}

// easeOutCubic — fast then settles. Matches the FocuSee feel.
function easeOutCubic(p) {
  const x = 1 - p
  return 1 - x * x * x
}

function easeInCubic(p) {
  return p * p * p
}

// Build click windows from raw events.
export function buildClickWindows(events, opts = {}) {
  const o = { ...DEFAULT_TIMELINE_OPTS, ...opts }
  const clicks = (events || []).filter((e) => e.type === 'click')
  const debounced = []
  for (const c of clicks) {
    const last = debounced[debounced.length - 1]
    if (!last || c.timestamp - last.timestamp >= o.minTimeBetweenZooms) debounced.push(c)
  }
  return debounced.map((c) => {
    const cx = c.screenW > 0 ? c.x / c.screenW : 0.5
    const cy = c.screenH > 0 ? c.y / c.screenH : 0.5
    return {
      click: c,
      cx,
      cy,
      start: c.timestamp,
      peakStart: c.timestamp + o.easeInDuration,
      peakEnd: c.timestamp + o.easeInDuration + o.holdDuration,
      end: c.timestamp + o.easeInDuration + o.holdDuration + o.easeOutDuration
    }
  })
}

// Sample (zoom, cx, cy) at time t (ms) from click windows + opts.
// Returns the strongest active window's effect; multiple overlaps take the max ease.
export function sampleZoom(events, tMs, opts = {}) {
  const o = { ...DEFAULT_TIMELINE_OPTS, ...opts }
  const windows = buildClickWindows(events, o)
  let bestZ = 1
  let bestCx = 0.5
  let bestCy = 0.5
  let mouseFromMoves = null

  for (const w of windows) {
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
    const z = 1 + (o.zoomLevel - 1) * ease
    if (z > bestZ) {
      bestZ = z
      bestCx = w.cx
      bestCy = w.cy
    }
  }

  return { zoom: bestZ, cx: bestCx, cy: bestCy }
}

// Decimate move events to a coarse polyline — keep one event per ~50ms or
// when the cursor jumps more than `minDelta` normalized units.
export function decimateMoves(events, opts = {}) {
  const o = { ...DEFAULT_TIMELINE_OPTS, ...opts }
  const moves = (events || []).filter((e) => e.type === 'move')
  if (!moves.length) return []
  const stepMs = 1000 / Math.max(1, o.cursorMoveSampleHz)
  const minDeltaNorm = o.cursorMoveMinDeltaPx / 1920 // rough screen-norm tolerance
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

// Sample cursor (mouse) position at time t — linearly interpolate between
// adjacent decimated move samples. Falls back to last click position if no
// moves are available.
export function sampleMouse(decimated, tMs, fallback = { x: 0.5, y: 0.5 }) {
  if (!decimated.length) return fallback
  if (tMs <= decimated[0].t) return { x: decimated[0].x, y: decimated[0].y }
  if (tMs >= decimated[decimated.length - 1].t) {
    const last = decimated[decimated.length - 1]
    return { x: last.x, y: last.y }
  }
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

// ─── FFmpeg expression builder ────────────────────────────────────────────
// Produces compact piecewise expressions evaluated by FFmpeg's expression
// engine. Uses formulas (no sampling) so output is mathematically smooth.

function escNum(n) {
  return Number.isFinite(n) ? (+n.toFixed(6)).toString() : '0'
}

// Build z(time), cx(time), cy(time) FFmpeg expressions from click windows.
export function buildZoomExpressions(windows, opts, timeVar = 'time') {
  const o = { ...DEFAULT_TIMELINE_OPTS, ...opts }
  const Z = o.zoomLevel
  if (!windows.length) {
    return { zExpr: '1', cxExpr: '0.5', cyExpr: '0.5' }
  }
  // For each window, encode the zoom factor's ease in/hold/out as a small
  // expression that returns 0 outside the window and an ease ∈ [0, 1] inside.
  // The total zoom = 1 + (Z-1) * max(window_eases)
  // For cx, cy: use the click center weighted by ease, with default 0.5 elsewhere.

  // We approximate "max" of multiple piecewise eases by chaining: when two
  // windows overlap (rare with debounce), the later one wins.

  let zExpr = '0' // accumulated ease ∈ [0, 1]
  let cxExpr = '0.5'
  let cyExpr = '0.5'

  for (const w of windows) {
    const t0 = escNum(w.start / 1000)
    const t1 = escNum(w.peakStart / 1000)
    const t2 = escNum(w.peakEnd / 1000)
    const t3 = escNum(w.end / 1000)
    const dIn = escNum((w.peakStart - w.start) / 1000)
    const dOut = escNum((w.end - w.peakEnd) / 1000)
    const cx = escNum(w.cx)
    const cy = escNum(w.cy)

    // ease for this window:
    //   in:    1 - (1 - p)^3   where p = (t - t0)/dIn
    //   hold:  1
    //   out:   p^3              where p = (t3 - t)/dOut
    //   else:  0
    const pIn = `((${timeVar}-${t0})/${dIn})`
    const pOut = `((${t3}-${timeVar})/${dOut})`
    const easeIn = `(1 - pow(1 - ${pIn}, 3))`
    const easeOut = `pow(${pOut}, 3)`
    const winEase = `if(between(${timeVar},${t0},${t1}),${easeIn},if(between(${timeVar},${t1},${t2}),1,if(between(${timeVar},${t2},${t3}),${easeOut},0)))`
    // accumulate as max(prev, winEase)
    zExpr = `max(${zExpr},${winEase})`
    // cx,cy: when this window's ease > 0, take its center, else previous
    const inWin = `between(${timeVar},${t0},${t3})`
    cxExpr = `if(${inWin},${cx},${cxExpr})`
    cyExpr = `if(${inWin},${cy},${cyExpr})`
  }

  // Final z = 1 + (Z - 1) * ease_accum
  const finalZ = `(1 + (${escNum(Z)} - 1) * (${zExpr}))`
  return { zExpr: finalZ, cxExpr, cyExpr }
}

// Build mx(time), my(time) FFmpeg piecewise expressions for the actual mouse
// path, already decimated.
export function buildMouseExpressions(decimated, timeVar = 'time') {
  if (!decimated.length) return { mxExpr: '0.5', myExpr: '0.5' }
  if (decimated.length === 1) {
    return { mxExpr: escNum(decimated[0].x), myExpr: escNum(decimated[0].y) }
  }
  let mxExpr = escNum(decimated[decimated.length - 1].x)
  let myExpr = escNum(decimated[decimated.length - 1].y)
  for (let i = decimated.length - 2; i >= 0; i--) {
    const a = decimated[i]
    const b = decimated[i + 1]
    const dt = (b.t - a.t) / 1000
    if (dt <= 0) continue
    const t0 = escNum(a.t / 1000)
    const t1 = escNum(b.t / 1000)
    const lerpX = `(${escNum(a.x)} + (${escNum(b.x - a.x)})*((${timeVar}-${t0})/${escNum(dt)}))`
    const lerpY = `(${escNum(a.y)} + (${escNum(b.y - a.y)})*((${timeVar}-${t0})/${escNum(dt)}))`
    mxExpr = `if(between(${timeVar},${t0},${t1}),${lerpX},${mxExpr})`
    myExpr = `if(between(${timeVar},${t0},${t1}),${lerpY},${myExpr})`
  }
  // Default for time before first sample: first sample's value
  mxExpr = `if(lt(${timeVar},${escNum(decimated[0].t / 1000)}),${escNum(decimated[0].x)},${mxExpr})`
  myExpr = `if(lt(${timeVar},${escNum(decimated[0].t / 1000)}),${escNum(decimated[0].y)},${myExpr})`
  return { mxExpr, myExpr }
}
