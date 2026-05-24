// Bake the live-preview camera (spring-smoothed, cursor-following) into a
// piecewise-linear FFmpeg expression suitable for the zoompan filter, so the
// exported MP4 matches what the editor preview shows.
//
// Why bake instead of writing the spring inline as a closed-form expression:
// the spring is iterative state and can't be expressed analytically given
// the moving target (cursor) and overlapping zooms. Sampling at 60Hz then
// decimating to keyframes-of-meaningful-change gives a small expression
// (~tens to a few hundred ifs) that FFmpeg evaluates fast.
//
// Math here is duplicated from src/renderer/src/lib/{motionSmoothing,
// cameraTrack}.js — kept in lock-step so preview and export agree.

import { sampleZoomFromZooms, activeZoomAt, sampleMouseAt } from './zoomTimeline.js'

// ─── Spring solver (mirror of renderer motionSmoothing.js) ────────────────
// Keep stiffness / damping in lock-step with the renderer copy — any drift
// here = preview/export mismatch. See motionSmoothing.js for the tuning
// rationale (ζ_zoom ≈ 1.04, ζ_center ≈ 0.97).
const ZOOM_SPRING = { stiffness: 180, damping: 28, mass: 1, restDelta: 0.0005, restSpeed: 0.01 }
const CENTER_SPRING = { stiffness: 180, damping: 26, mass: 1, restDelta: 0.0003, restSpeed: 0.008 }

function createSpring(v) { return { value: v, velocity: 0, initialized: true } }

function springPos(t, target, d0, v0, zeta, w0) {
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    const env = Math.exp(-zeta * w0 * t)
    return target - env * (((v0 + zeta * w0 * d0) / wd) * Math.sin(wd * t) + d0 * Math.cos(wd * t))
  }
  if (zeta === 1) return target - Math.exp(-w0 * t) * (d0 + (v0 + w0 * d0) * t)
  const wd = w0 * Math.sqrt(zeta * zeta - 1)
  const env = Math.exp(-zeta * w0 * t)
  const wt = Math.min(wd * t, 300)
  return target - (env * ((v0 + zeta * w0 * d0) * Math.sinh(wt) + wd * d0 * Math.cosh(wt))) / wd
}

function stepSpring(state, target, dtMs, cfg) {
  const dt = Math.min(80, Math.max(1, dtMs))
  const restDelta = cfg.restDelta ?? 0.0005
  const restSpeed = cfg.restSpeed ?? 0.02
  if (Math.abs(target - state.value) <= restDelta && Math.abs(state.velocity) <= restSpeed) {
    state.value = target
    state.velocity = 0
    return state.value
  }
  const w0 = Math.sqrt(cfg.stiffness / cfg.mass)
  const zeta = cfg.damping / (2 * Math.sqrt(cfg.stiffness * cfg.mass))
  const d0 = target - state.value
  const v0 = -state.velocity
  const tSec = dt / 1000
  const cur = springPos(tSec, target, d0, v0, zeta, w0)
  if (zeta >= 1) {
    const crossed = (state.value <= target && cur > target) || (state.value >= target && cur < target)
    if (crossed) {
      state.value = target
      state.velocity = 0
      return state.value
    }
  }
  const eps = 0.0001
  const ahead = springPos(tSec + eps, target, d0, v0, zeta, w0)
  const v = (ahead - cur) / eps
  if (Math.abs(target - cur) <= restDelta && Math.abs(v) <= restSpeed) {
    state.value = target
    state.velocity = 0
  } else {
    state.value = cur
    state.velocity = v
  }
  return state.value
}

// ─── Camera target (mirror of renderer cameraTrack.js) ────────────────────
// Keep behavior identical to renderer/src/lib/cameraTrack.js — anything that
// drifts here will show up as preview/export mismatch.
const DEFAULT_FOLLOW_MODE = 'dead-zone'
const DEFAULT_SAFE_ZONE = 0.6
const DEFAULT_FOLLOW_AMOUNT = 0.7

function sampleCameraTarget(zooms, moves, tMs, opts = {}) {
  const mode = opts.cursorFollowMode ?? DEFAULT_FOLLOW_MODE
  const base = sampleZoomFromZooms(zooms, tMs)
  if (base.zoom <= 1.0001 || mode === 'none') return base
  const active = activeZoomAt(zooms, tMs)
  if (!active) return base
  let holdProgress
  if (tMs < active.peakStart) {
    holdProgress = Math.max(0, Math.min(1, (tMs - active.start) / Math.max(1, active.peakStart - active.start)))
  } else if (tMs > active.peakEnd) {
    holdProgress = Math.max(0, Math.min(1, (active.end - tMs) / Math.max(1, active.end - active.peakEnd)))
  } else {
    holdProgress = 1
  }
  const m = sampleMouseAt(moves, tMs, { x: base.cx, y: base.cy })

  if (mode === 'soft') {
    const k = (opts.cursorFollowAmount ?? DEFAULT_FOLLOW_AMOUNT) * holdProgress
    return { zoom: base.zoom, cx: base.cx + (m.x - base.cx) * k, cy: base.cy + (m.y - base.cy) * k }
  }

  const safe = Math.max(0, Math.min(0.95, opts.cursorFollowSafeZone ?? DEFAULT_SAFE_ZONE))
  const halfBand = (safe / 2) / base.zoom
  let cx = base.cx
  let cy = base.cy
  const dx = m.x - base.cx
  const dy = m.y - base.cy
  if (Math.abs(dx) > halfBand) cx += (Math.abs(dx) - halfBand) * Math.sign(dx) * holdProgress
  if (Math.abs(dy) > halfBand) cy += (Math.abs(dy) - halfBand) * Math.sign(dy) * holdProgress
  const halfWin = 1 / (2 * base.zoom)
  cx = Math.max(halfWin, Math.min(1 - halfWin, cx))
  cy = Math.max(halfWin, Math.min(1 - halfWin, cy))
  return { zoom: base.zoom, cx, cy }
}

// ─── Bake ──────────────────────────────────────────────────────────────────

// Sample the spring-tracked camera at `simHz` (default 60Hz), then decimate
// to keyframes that linear-interpolation can reproduce within tolerance.
// Returns array of { t, z, cx, cy } in time-ascending order.
export function bakeCameraTrajectory({
  zooms,
  moves,
  durSec,
  simHz = 60,
  cursorFollowMode,
  cursorFollowSafeZone,
  cursorFollowAmount
}) {
  const totalMs = Math.max(0, durSec * 1000)
  if (totalMs <= 0) return []
  const dtMs = 1000 / simHz
  const followOpts = { cursorFollowMode, cursorFollowSafeZone, cursorFollowAmount }

  // Start the springs already settled at t=0's target so we don't waste the
  // first second easing in from value=1 / 0.5 / 0.5.
  const t0 = sampleCameraTarget(zooms, moves, 0, followOpts)
  const zSpring = createSpring(t0.zoom)
  const cxSpring = createSpring(t0.cx)
  const cySpring = createSpring(t0.cy)

  const samples = []
  // +1 sample at end so we capture the final state cleanly.
  for (let tMs = 0; tMs <= totalMs + 1; tMs += dtMs) {
    const target = sampleCameraTarget(zooms, moves, Math.min(tMs, totalMs), followOpts)
    const z = stepSpring(zSpring, target.zoom, dtMs, ZOOM_SPRING)
    const cx = stepSpring(cxSpring, target.cx, dtMs, CENTER_SPRING)
    const cy = stepSpring(cySpring, target.cy, dtMs, CENTER_SPRING)
    samples.push({ t: Math.min(tMs, totalMs), z, cx, cy })
  }
  return decimateToKeyframes(samples)
}

// Drop samples that linear interpolation between neighbours would already
// reproduce within tolerance. Keeps endpoints. Tolerances chosen so visible
// motion is preserved: 0.002 zoom = ~0.2% scale; 0.0015 norm cx/cy = ~3px
// at 1920 width. If the result still exceeds `maxKeyframes`, we double the
// tolerances and try again — FFmpeg's expression evaluator has practical
// limits, so a 200-keyframe expression chokes the parser even when it's
// mathematically valid.
function decimateToKeyframes(samples, zEps = 0.002, cEps = 0.0015, maxKeyframes = 48) {
  function run(zE, cE) {
    if (samples.length <= 2) return samples.slice()
    const out = [samples[0]]
    let lastEmitIdx = 0
    for (let i = 1; i < samples.length - 1; i++) {
      const a = samples[lastEmitIdx]
      const c = samples[i + 1]
      const span = c.t - a.t
      const p = span > 0 ? (samples[i].t - a.t) / span : 0
      const pz = a.z + (c.z - a.z) * p
      const pcx = a.cx + (c.cx - a.cx) * p
      const pcy = a.cy + (c.cy - a.cy) * p
      if (
        Math.abs(samples[i].z - pz) > zE ||
        Math.abs(samples[i].cx - pcx) > cE ||
        Math.abs(samples[i].cy - pcy) > cE
      ) {
        out.push(samples[i])
        lastEmitIdx = i
      }
    }
    out.push(samples[samples.length - 1])
    return out
  }
  let zE = zEps
  let cE = cEps
  let kf = run(zE, cE)
  // Hard cap: long videos with lots of camera motion can otherwise emit
  // hundreds of keyframes which blow the FFmpeg expression parser.
  let safety = 0
  while (kf.length > maxKeyframes && safety++ < 12) {
    zE *= 1.6
    cE *= 1.6
    kf = run(zE, cE)
  }
  return kf
}

// ─── FFmpeg expressions ────────────────────────────────────────────────────

function num(n) { return Number.isFinite(n) ? (+n.toFixed(6)).toString() : '0' }

// Build a piecewise-linear expression as a FLAT sum of `between(time, t0, t1) *
// linearInterp` terms, plus boundary terms for before-first / after-last.
//
// FFmpeg's expression parser uses recursive descent and chokes on deeply
// nested `if(...)` chains (we observed 138-keyframe expressions producing
// "Missing ')' or too many args"). Flat sums-of-products have unlimited
// horizontal length but constant nesting depth, so they evaluate fine.
//
// Mathematically: exactly one `between(t, t_i, t_{i+1})` is 1 at any given
// time, so only one segment's interpolation contributes; the others vanish.
function buildPiecewise(keyframes, key, timeVar) {
  if (!keyframes.length) return key === 'z' ? '1' : '0.5'
  if (keyframes.length === 1) return num(keyframes[0][key])

  const first = keyframes[0]
  const last = keyframes[keyframes.length - 1]
  const t0First = num(first.t / 1000)
  const tNLast = num(last.t / 1000)
  const vFirst = num(first[key])
  const vLast = num(last[key])

  const terms = []
  // Before the first keyframe: hold v0
  terms.push(`(lt(${timeVar},${t0First})*${vFirst})`)
  // Each segment contributes its interpolation, gated by `between`.
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i]
    const b = keyframes[i + 1]
    const t0 = num(a.t / 1000)
    const t1 = num(b.t / 1000)
    const dur = Math.max(0.001, (b.t - a.t) / 1000)
    const dv = b[key] - a[key]
    const v0 = num(a[key])
    if (Math.abs(dv) < 1e-9) {
      // Flat segment — skip the interp expr, save chars.
      terms.push(`(between(${timeVar},${t0},${t1})*${v0})`)
    } else {
      const dvN = num(dv)
      const durN = num(dur)
      terms.push(
        `(between(${timeVar},${t0},${t1})*(${v0}+${dvN}*((${timeVar})-${t0})/${durN}))`
      )
    }
  }
  // After the last keyframe: hold vN. `gt` (not gte) so the last segment's
  // `between` already covers equality.
  terms.push(`(gt(${timeVar},${tNLast})*${vLast})`)
  return terms.join('+')
}

export function buildBakedZoomExpressions(keyframes, timeVar = 'time') {
  if (!keyframes || !keyframes.length) {
    return { zExpr: '1', cxExpr: '0.5', cyExpr: '0.5' }
  }
  return {
    zExpr: buildPiecewise(keyframes, 'z', timeVar),
    cxExpr: buildPiecewise(keyframes, 'cx', timeVar),
    cyExpr: buildPiecewise(keyframes, 'cy', timeVar)
  }
}

// Replacement for buildCursorSendcmd that consumes the baked trajectory
// instead of recomputing zoom math, so cursor placement stays in lock-step
// with the camera. Output format matches the original — `overlay@ov` x/y
// commands, one keyframe whenever the integer pixel position changes.
export function buildCursorSendcmdFromBaked({
  keyframes,
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

  // Sample baked (z, cx, cy) at arbitrary tMs via binary search + lerp.
  function sampleBaked(tMs) {
    if (!keyframes.length) return { z: 1, cx: 0.5, cy: 0.5 }
    if (tMs <= keyframes[0].t) return keyframes[0]
    const last = keyframes[keyframes.length - 1]
    if (tMs >= last.t) return last
    let lo = 0
    let hi = keyframes.length - 1
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1
      if (keyframes[mid].t <= tMs) lo = mid
      else hi = mid
    }
    const a = keyframes[lo]
    const b = keyframes[hi]
    const span = b.t - a.t
    const p = span > 0 ? (tMs - a.t) / span : 0
    return { z: a.z + (b.z - a.z) * p, cx: a.cx + (b.cx - a.cx) * p, cy: a.cy + (b.cy - a.cy) * p }
  }

  for (let f = 0; f <= totalFrames; f++) {
    const tMs = (f / fps) * 1000
    const { z, cx, cy } = sampleBaked(tMs)
    const m = sampleMouseAt(decimatedMoves, tMs, { x: cx, y: cy })
    const zSafe = Math.max(z, 1)
    let ox = Math.round(W * ((m.x - cx) * zSafe + 0.5) - cursorW / 2)
    let oy = Math.round(H * ((m.y - cy) * zSafe + 0.5) - cursorH / 2)
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
