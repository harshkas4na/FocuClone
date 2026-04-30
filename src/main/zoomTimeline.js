function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}

export function buildZoomTimeline(events, opts = {}) {
  const {
    zoomLevel = 2.0,
    easeInDuration = 300,
    holdDuration = 1200,
    easeOutDuration = 300,
    minTimeBetweenZooms = 800,
    sampleCount = 10
  } = opts

  const clicks = (events || []).filter((e) => e.type === 'click')
  const moves = (events || []).filter((e) => e.type === 'move')

  const debouncedClicks = []
  for (const click of clicks) {
    const last = debouncedClicks[debouncedClicks.length - 1]
    if (!last || click.timestamp - last.timestamp >= minTimeBetweenZooms) {
      debouncedClicks.push(click)
    }
  }

  const keyframes = []

  for (const click of debouncedClicks) {
    const cx = click.screenW > 0 ? click.x / click.screenW : 0.5
    const cy = click.screenH > 0 ? click.y / click.screenH : 0.5

    const t0 = click.timestamp
    const t1 = t0 + easeInDuration
    const t2 = t1 + holdDuration
    const t3 = t2 + easeOutDuration

    keyframes.push({ t: Math.max(0, t0 - 1), zoom: 1, cx, cy })
    for (let i = 0; i <= sampleCount; i++) {
      const p = i / sampleCount
      const ease = easeInOut(p)
      keyframes.push({
        t: t0 + p * easeInDuration,
        zoom: 1 + (zoomLevel - 1) * ease,
        cx,
        cy
      })
    }

    const holdMoves = moves.filter((m) => m.timestamp >= t1 && m.timestamp <= t2)
    if (holdMoves.length > 0) {
      for (const move of holdMoves) {
        keyframes.push({
          t: move.timestamp,
          zoom: zoomLevel,
          cx: move.screenW > 0 ? move.x / move.screenW : cx,
          cy: move.screenH > 0 ? move.y / move.screenH : cy
        })
      }
    } else {
      keyframes.push({ t: t1 + holdDuration / 2, zoom: zoomLevel, cx, cy })
    }
    keyframes.push({ t: t2, zoom: zoomLevel, cx, cy })

    for (let i = 0; i <= sampleCount; i++) {
      const p = i / sampleCount
      const ease = easeInOut(p)
      keyframes.push({
        t: t2 + p * easeOutDuration,
        zoom: zoomLevel - (zoomLevel - 1) * ease,
        cx,
        cy
      })
    }
    keyframes.push({ t: t3 + 1, zoom: 1, cx, cy })
  }

  keyframes.sort((a, b) => a.t - b.t)
  const dedup = []
  for (const k of keyframes) {
    const last = dedup[dedup.length - 1]
    if (last && Math.abs(last.t - k.t) < 0.5) continue
    dedup.push(k)
  }
  return dedup
}

export function buildClickWindows(events, opts = {}) {
  const {
    easeInDuration = 300,
    holdDuration = 1200,
    easeOutDuration = 300,
    minTimeBetweenZooms = 800
  } = opts
  const clicks = (events || []).filter((e) => e.type === 'click')
  const debounced = []
  for (const click of clicks) {
    const last = debounced[debounced.length - 1]
    if (!last || click.timestamp - last.timestamp >= minTimeBetweenZooms) debounced.push(click)
  }
  return debounced.map((c) => ({
    click: c,
    start: c.timestamp,
    end: c.timestamp + easeInDuration + holdDuration + easeOutDuration
  }))
}
