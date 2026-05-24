// Damped harmonic oscillator spring solver.
//
// F = -kx - cv  with mass m → solution depends on damping ratio ζ = c/(2√km).
//   ζ < 1   underdamped     (oscillates, settles)
//   ζ = 1   critically damped (fastest non-oscillating convergence)
//   ζ > 1   overdamped       (exponential decay, no oscillation)
//
// Used to smooth zoom level + camera center in the live editor preview so
// that target changes (overlapping zooms, cursor follow, scrubs) interpolate
// instead of snapping. Pure math — same physics any spring lib uses.

export function createSpring(initialValue = 0) {
  return { value: initialValue, velocity: 0, initialized: false }
}

export function resetSpring(state, value) {
  if (typeof value === 'number') state.value = value
  state.velocity = 0
  state.initialized = false
}

// Clamp dt to [1ms, 80ms]. <1ms is meaningless; >80ms (browser tab unfocus
// or scrub jump) makes the solver explode — caller should reset on jumps.
function clampDt(dtMs) {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return 1000 / 60
  return Math.min(80, Math.max(1, dtMs))
}

// Closed-form position at time t given initial offset δ₀ and velocity v₀.
function springPos(t, target, delta0, v0, zeta, w0) {
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    const env = Math.exp(-zeta * w0 * t)
    return (
      target -
      env *
        (((v0 + zeta * w0 * delta0) / wd) * Math.sin(wd * t) +
          delta0 * Math.cos(wd * t))
    )
  }
  if (zeta === 1) {
    return target - Math.exp(-w0 * t) * (delta0 + (v0 + w0 * delta0) * t)
  }
  const wd = w0 * Math.sqrt(zeta * zeta - 1)
  const env = Math.exp(-zeta * w0 * t)
  // Cap argument so sinh/cosh don't overflow on very long settles.
  const wt = Math.min(wd * t, 300)
  return (
    target -
    (env * ((v0 + zeta * w0 * delta0) * Math.sinh(wt) + wd * delta0 * Math.cosh(wt))) / wd
  )
}

// Advance the spring one tick toward `target`. Returns the new value.
export function stepSpring(state, target, dtMs, config) {
  const dt = clampDt(dtMs)
  if (!state.initialized || !Number.isFinite(state.value)) {
    state.value = target
    state.velocity = 0
    state.initialized = true
    return state.value
  }
  const restDelta = config.restDelta ?? 0.0005
  const restSpeed = config.restSpeed ?? 0.02
  if (Math.abs(target - state.value) <= restDelta && Math.abs(state.velocity) <= restSpeed) {
    state.value = target
    state.velocity = 0
    return state.value
  }

  const { stiffness, damping, mass } = config
  const w0 = Math.sqrt(stiffness / mass)
  const zeta = damping / (2 * Math.sqrt(stiffness * mass))
  const delta0 = target - state.value
  const v0 = -state.velocity
  const tSec = dt / 1000

  const cur = springPos(tSec, target, delta0, v0, zeta, w0)

  // Overshoot guard: with a moving target, a critically/overdamped spring
  // can still overshoot because it carries velocity from a previous target.
  // Snapping prevents jelly wobble on direction reversal.
  if (zeta >= 1) {
    const crossed =
      (state.value <= target && cur > target) || (state.value >= target && cur < target)
    if (crossed) {
      state.value = target
      state.velocity = 0
      return state.value
    }
  }

  // Forward-difference for velocity (analytical derivative is ugly in 3 cases).
  const eps = 0.0001
  const ahead = springPos(tSec + eps, target, delta0, v0, zeta, w0)
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

// Defaults tuned to match Screen Studio's "spring physics" feel:
//   • ZOOM_SPRING:   ζ ≈ 1.0 (critically damped) — snaps cleanly to target,
//                    no overshoot, no jelly.
//   • CENTER_SPRING: ζ ≈ 0.97 (very slightly under) — a hair of natural
//                    follow-through without visible wobble. Previously 0.93
//                    which would visibly oscillate on direction reversals.
//
// Stiffness picked so settle time (~95% to target) is ~250-350ms, matching
// FocuSee's reviewer-described "smooth, cinematic" pan.
//
// Damping ratio ζ = damping / (2 * sqrt(stiffness * mass)).
//   ZOOM:   28/(2*√180)   ≈ 1.043  (overdamped — never overshoots zoom level)
//   CENTER: 26/(2*√180)   ≈ 0.969  (just under critical for organic motion)
export const ZOOM_SPRING = {
  stiffness: 180,
  damping: 28,
  mass: 1,
  restDelta: 0.0005,
  restSpeed: 0.01
}

export const CENTER_SPRING = {
  stiffness: 180,
  damping: 26,
  mass: 1,
  restDelta: 0.0003,
  restSpeed: 0.008
}

// Stiffer spring for the on-screen cursor's viewport position. Just enough
// smoothing to denoise the 30 Hz sample grid without lagging real motion —
// settle in well under one frame (response ≈ 60 ms). Critically damped so
// fast cursor flicks don't overshoot.
export const CURSOR_SPRING = {
  stiffness: 420,
  damping: 42,
  mass: 1,
  restDelta: 0.0002,
  restSpeed: 0.005
}
