import React, { useEffect, useRef, useState } from 'react'

// Multi-track timeline (Studio Dark design):
//   • Ruler with second ticks (major every 5s)
//   • Video clip with thumbnail strip + edge handles for trim
//   • Zoom track with selectable/resizable zoom blocks (yellow)
//   • Annotations track (placeholder, indigo)
//   • Audio waveform track (green)
//   • Playhead with triangle head + glowing line
//
// Props match the prior contract so the Editor wiring is unchanged:
//   durationMs, currentMs, zooms, selectedZoomId, clicks, trim, onSeek,
//   onSelectZoom, onMoveZoom, onResizeZoom, onDeleteZoom, onTrimChange.
export default function Timeline({
  durationMs,
  currentMs,
  zooms = [],
  selectedZoomId,
  clicks = [],
  trim = { inMs: 0, outMs: null },
  onSeek,
  onSelectZoom,
  onMoveZoom,
  onResizeZoom,
  onDeleteZoom,
  onTrimChange
}) {
  const wrapRef = useRef(null)
  const tracksRef = useRef(null)
  const dragRef = useRef(null)
  const [contentW, setContentW] = useState(800)

  const dur = Math.max(durationMs || 1, 1)
  const trimIn = Math.max(0, Math.min(dur, trim.inMs || 0))
  const trimOut = Math.max(trimIn + 100, Math.min(dur, trim.outMs ?? dur))

  // Fit horizontal extent to the visible track area so short recordings don't
  // require horizontal scrolling but long ones still get useful resolution.
  useEffect(() => {
    function measure() {
      if (!wrapRef.current) return
      const w = wrapRef.current.clientWidth - 90 // label gutter
      const minPxPerSec = 30
      const seconds = dur / 1000
      const baseW = Math.max(w, seconds * minPxPerSec)
      setContentW(baseW)
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [dur])

  const pxPerMs = contentW / dur
  const msToPx = (ms) => Math.max(0, Math.min(contentW, ms * pxPerMs))

  function pxToMs(clientX) {
    if (!tracksRef.current) return 0
    const rect = tracksRef.current.getBoundingClientRect()
    const trackLeft = rect.left + 90 // skip label gutter
    const x = Math.max(0, Math.min(contentW, clientX - trackLeft))
    return x / pxPerMs
  }

  function startDrag(kind, payload, e) {
    e.stopPropagation()
    e.preventDefault()
    dragRef.current = {
      kind,
      payload,
      startMs: pxToMs(e.clientX),
      origZoom: payload?.zoom,
      origTrim: { inMs: trimIn, outMs: trimOut }
    }
    if (payload?.zoom) onSelectZoom?.(payload.zoom.id)
    document.addEventListener('mousemove', onDragMove)
    document.addEventListener('mouseup', onDragEnd)
  }

  function onDragMove(e) {
    const d = dragRef.current
    if (!d) return
    const curMs = pxToMs(e.clientX)
    const dMs = curMs - d.startMs

    if (d.kind === 'move' && d.origZoom) {
      const z = d.origZoom
      const len = z.end - z.start
      let start = Math.max(0, z.start + dMs)
      if (start + len > dur) start = Math.max(0, dur - len)
      onMoveZoom?.(z.id, start)
    } else if (d.kind === 'left-edge' && d.origZoom) {
      const z = d.origZoom
      const easeIn = z.peakStart - z.start
      const newStart = Math.max(0, Math.min(z.peakStart - 100, z.start + dMs))
      onResizeZoom?.(z.id, { start: newStart, peakStart: newStart + easeIn })
    } else if (d.kind === 'right-edge' && d.origZoom) {
      const z = d.origZoom
      const easeOut = z.end - z.peakEnd
      const newEnd = Math.min(dur, Math.max(z.peakEnd + 100, z.end + dMs))
      onResizeZoom?.(z.id, { end: newEnd, peakEnd: newEnd - easeOut })
    } else if (d.kind === 'trim-in') {
      const newIn = Math.max(0, Math.min(d.origTrim.outMs - 200, d.origTrim.inMs + dMs))
      onTrimChange?.({ inMs: newIn })
    } else if (d.kind === 'trim-out') {
      const newOut = Math.min(dur, Math.max(d.origTrim.inMs + 200, d.origTrim.outMs + dMs))
      onTrimChange?.({ outMs: newOut })
    } else if (d.kind === 'scrub') {
      onSeek?.(curMs)
    }
  }

  function onDragEnd() {
    dragRef.current = null
    document.removeEventListener('mousemove', onDragMove)
    document.removeEventListener('mouseup', onDragEnd)
  }

  useEffect(() => () => onDragEnd(), [])

  function onScrubDown(e) {
    onSelectZoom?.(null)
    const ms = pxToMs(e.clientX)
    onSeek?.(ms)
    startDrag('scrub', null, e)
  }

  // Ruler ticks (every second, label every 5s)
  const totalSec = Math.ceil(dur / 1000)
  const secondPx = pxPerMs * 1000

  return (
    <div className="tl-wrap" ref={wrapRef}>
      <div className="tl-scroll">
        <div
          className="tl-tracks"
          ref={tracksRef}
          style={{ width: 90 + contentW }}
        >
          {/* Ruler / scrub strip */}
          <div className="tl-ruler" onMouseDown={onScrubDown}>
            {Array.from({ length: totalSec + 1 }).map((_, s) => {
              const major = s % 5 === 0
              return (
                <span
                  key={s}
                  className={`tl-tick ${major ? 'major' : ''}`}
                  style={{ left: s * secondPx, width: secondPx }}
                >
                  {major && <span className="tl-tick-lbl">{s}s</span>}
                </span>
              )
            })}
          </div>

          {/* Video track */}
          <div className="tl-row tl-row-video">
            <div className="tl-row-label">
              <span className="dot" style={{ background: 'var(--acc)' }} />Video
            </div>
            <div className="tl-clip" style={{ left: 0, width: contentW }}>
              <ThumbnailStrip width={contentW} />
              <div
                className="tl-clip-handle l"
                onMouseDown={(e) => startDrag('trim-in', null, e)}
                title="Trim start"
                style={{ left: msToPx(trimIn) }}
              />
              <div
                className="tl-clip-handle r"
                onMouseDown={(e) => startDrag('trim-out', null, e)}
                title="Trim end"
                style={{ left: msToPx(trimOut) - 4 }}
              />
            </div>
            {/* Trim shaded regions */}
            {trimIn > 0 && (
              <div
                className="tl-trim-mask"
                style={{ left: 0, width: msToPx(trimIn) }}
              />
            )}
            {trimOut < dur && (
              <div
                className="tl-trim-mask"
                style={{ left: msToPx(trimOut), width: contentW - msToPx(trimOut) }}
              />
            )}
            {/* Click markers on the video row */}
            {clicks.map((c, i) => (
              <span
                key={`c-${i}`}
                className="tl-click-marker"
                style={{ left: msToPx(c.timestamp) }}
              />
            ))}
          </div>

          {/* Zooms track */}
          <div className="tl-row tl-row-zoom">
            <div className="tl-row-label">
              <span className="dot" style={{ background: '#FFD23F' }} />Zooms
            </div>
            {zooms.map((z) => {
              const sel = z.id === selectedZoomId
              const auto = !!z.auto
              const left = msToPx(z.start)
              const width = Math.max(20, msToPx(z.end) - left)
              const level =
                z.level ??
                z.zoomLevel ??
                z.zoom ??
                z.peak ??
                ''
              return (
                <div
                  key={z.id}
                  className={`tl-zoom ${sel ? 'sel' : ''} ${auto ? 'auto' : ''}`}
                  style={{ left, width }}
                  onMouseDown={(e) => startDrag('move', { zoom: z }, e)}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    onDeleteZoom?.(z.id)
                  }}
                  title={`Zoom ${formatTime(z.start)}–${formatTime(z.end)}`}
                >
                  <div
                    className="tl-zoom-edge l"
                    onMouseDown={(e) => startDrag('left-edge', { zoom: z }, e)}
                  />
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                    <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
                    <path d="M16 16l5 5M8 11h6M11 8v6" stroke="currentColor"
                          strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <span>{level ? `${Number(level).toFixed(1)}×` : 'Zoom'}</span>
                  {auto && <span className="tl-auto-tag">auto</span>}
                  <div
                    className="tl-zoom-edge r"
                    onMouseDown={(e) => startDrag('right-edge', { zoom: z }, e)}
                  />
                </div>
              )
            })}
          </div>

          {/* Annotations track (decorative until annotation editing UI lands) */}
          <div className="tl-row tl-row-anno">
            <div className="tl-row-label">
              <span className="dot" style={{ background: '#5E6AD2' }} />Annotations
            </div>
          </div>

          {/* Audio waveform */}
          <div className="tl-row tl-row-audio">
            <div className="tl-row-label">
              <span className="dot" style={{ background: '#34D399' }} />Audio
            </div>
            <div className="tl-audio-track">
              <Waveform width={contentW} />
            </div>
          </div>

          {/* Trim handles overlaying everything on the ruler */}
          <div
            className="tl-trim-handle"
            style={{ left: msToPx(trimIn) - 3, top: 0, bottom: 0 }}
            onMouseDown={(e) => startDrag('trim-in', null, e)}
            title="Trim start"
          />
          <div
            className="tl-trim-handle"
            style={{ left: msToPx(trimOut) - 3, top: 0, bottom: 0 }}
            onMouseDown={(e) => startDrag('trim-out', null, e)}
            title="Trim end"
          />

          {/* Playhead */}
          <div className="tl-playhead" style={{ left: msToPx(currentMs) }}>
            <div className="tl-playhead-head" />
            <div className="tl-playhead-line" />
          </div>
        </div>
      </div>
    </div>
  )
}

function ThumbnailStrip({ width }) {
  // Decorative coloured swatches mimicking video thumbnails.
  const cellW = 40
  const count = Math.max(1, Math.floor(width / cellW))
  return (
    <>
      {Array.from({ length: count }).map((_, i) => {
        const hue = (i * 22) % 360
        const lightness = 22 + Math.sin(i) * 4
        return (
          <span
            key={i}
            className="tl-thumb"
            style={{
              left: i * cellW + 2,
              width: cellW - 4,
              background: `hsl(${hue}, 28%, ${lightness}%)`
            }}
          />
        )
      })}
    </>
  )
}

function Waveform({ width }) {
  const stepPx = 4
  const count = Math.max(1, Math.floor(width / stepPx))
  return (
    <>
      {Array.from({ length: count }).map((_, i) => {
        const h = 20 + Math.abs(Math.sin(i * 0.4) * 60 + Math.cos(i * 0.13) * 20)
        return (
          <span
            key={i}
            className="tl-wave"
            style={{ left: i * stepPx, height: `${h}%` }}
          />
        )
      })}
    </>
  )
}

function formatTime(ms) {
  if (!isFinite(ms)) ms = 0
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  const cs = Math.floor((ms % 1000) / 10)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}
