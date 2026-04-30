import React, { useEffect, useRef, useState } from 'react'

// Editable timeline:
//   - Selectable, draggable, edge-resizable zoom bands
//   - Two trim handles (in / out) with dimmed regions outside
// Props:
//   durationMs, currentMs, zooms, selectedZoomId, clicks, trim {inMs,outMs}
//   onSeek(ms), onSelectZoom(id|null), onMoveZoom(id,newStart),
//   onResizeZoom(id, patch), onDeleteZoom(id), onTrimChange({inMs?,outMs?})
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
  const trackRef = useRef(null)
  const dragRef = useRef(null)
  const [hoverId, setHoverId] = useState(null)

  const dur = Math.max(durationMs || 1, 1)
  const trimIn = Math.max(0, Math.min(dur, trim.inMs || 0))
  const trimOut = Math.max(trimIn + 100, Math.min(dur, trim.outMs ?? dur))
  const pct = (ms) => `${Math.min(100, Math.max(0, (ms / dur) * 100))}%`

  function pxToMs(clientX) {
    if (!trackRef.current) return 0
    const rect = trackRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left))
    return (x / rect.width) * dur
  }

  function handleTrackMouseDown(e) {
    if (e.target !== trackRef.current) return
    const ms = pxToMs(e.clientX)
    onSeek?.(ms)
    onSelectZoom?.(null)
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
    }
  }

  function onDragEnd() {
    dragRef.current = null
    document.removeEventListener('mousemove', onDragMove)
    document.removeEventListener('mouseup', onDragEnd)
  }

  useEffect(() => () => onDragEnd(), [])

  const trimmedDur = trimOut - trimIn

  return (
    <div className="select-none">
      <div className="flex items-center justify-between text-[11px] text-muted mb-1.5 font-mono">
        <span>{formatTime(currentMs)}</span>
        <span>
          {clicks.length} clicks · {zooms.length} zooms · {formatTime(trimmedDur)} export
        </span>
        <span>{formatTime(dur)}</span>
      </div>

      <div
        ref={trackRef}
        onMouseDown={handleTrackMouseDown}
        className="relative h-14 bg-panel2 rounded cursor-pointer overflow-hidden"
      >
        {/* trimmed-out regions */}
        {trimIn > 0 && (
          <div
            className="absolute top-0 bottom-0 bg-black/55 pointer-events-none"
            style={{ left: 0, width: pct(trimIn) }}
          />
        )}
        {trimOut < dur && (
          <div
            className="absolute top-0 bottom-0 bg-black/55 pointer-events-none"
            style={{ left: pct(trimOut), right: 0 }}
          />
        )}

        {/* zoom bands */}
        {zooms.map((z) => {
          const sel = z.id === selectedZoomId
          const hover = z.id === hoverId
          return (
            <div
              key={z.id}
              className={`absolute top-1 bottom-1 rounded-sm transition-shadow ${
                sel
                  ? 'bg-accent/30 ring-2 ring-accent shadow-md'
                  : hover
                  ? 'bg-accent/20 ring-1 ring-accent/60'
                  : 'bg-accent/15 ring-1 ring-accent/40'
              }`}
              style={{ left: pct(z.start), width: pct(z.end - z.start) }}
              onMouseEnter={() => setHoverId(z.id)}
              onMouseLeave={() => setHoverId(null)}
              onMouseDown={(e) => startDrag('move', { zoom: z }, e)}
              onDoubleClick={(e) => {
                e.stopPropagation()
                onDeleteZoom?.(z.id)
              }}
              title={`Zoom @ ${formatTime(z.start)}–${formatTime(z.end)}`}
            >
              <div
                onMouseDown={(e) => startDrag('left-edge', { zoom: z }, e)}
                className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-accent/80"
              />
              <div
                onMouseDown={(e) => startDrag('right-edge', { zoom: z }, e)}
                className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-accent/80"
              />
              <div
                className="absolute top-1.5 bottom-1.5 bg-accent/40 rounded-sm pointer-events-none"
                style={{
                  left: `${((z.peakStart - z.start) / Math.max(1, z.end - z.start)) * 100}%`,
                  right: `${((z.end - z.peakEnd) / Math.max(1, z.end - z.start)) * 100}%`
                }}
              />
              {sel && (
                <button
                  className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-accent text-black text-[10px] font-bold flex items-center justify-center hover:scale-110"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteZoom?.(z.id)
                  }}
                  title="Delete zoom"
                >
                  ×
                </button>
              )}
            </div>
          )
        })}

        {/* click markers */}
        {clicks.map((c, i) => (
          <div
            key={`c-${i}`}
            className="absolute top-0 w-px h-2 bg-white/40 pointer-events-none"
            style={{ left: pct(c.timestamp) }}
          />
        ))}

        {/* trim handles */}
        <TrimHandle side="in" pos={pct(trimIn)} onDown={(e) => startDrag('trim-in', null, e)} />
        <TrimHandle side="out" pos={pct(trimOut)} onDown={(e) => startDrag('trim-out', null, e)} />

        {/* playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white pointer-events-none"
          style={{ left: pct(currentMs) }}
        >
          <div className="absolute -top-1 -left-1 w-2.5 h-2.5 bg-white rounded-full" />
        </div>
      </div>
    </div>
  )
}

function TrimHandle({ side, pos, onDown }) {
  return (
    <div
      onMouseDown={onDown}
      className="absolute top-0 bottom-0 w-1.5 cursor-ew-resize z-10 group"
      style={{ left: pos, transform: 'translateX(-3px)' }}
      title={`Trim ${side}`}
    >
      <div className="absolute inset-0 bg-yellow-300 rounded-full" />
      <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-yellow-300 rounded-sm" />
      <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-yellow-300 rounded-sm" />
    </div>
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
