import React, { useRef } from 'react'

export default function Timeline({
  events,
  durationMs,
  currentMs,
  onSeek,
  clickWindows = []
}) {
  const trackRef = useRef(null)
  const clicks = (events || []).filter((e) => e.type === 'click')
  const dur = Math.max(durationMs || 1, 1)
  const percent = (ms) => `${Math.min(100, Math.max(0, (ms / dur) * 100))}%`

  function handleTrackClick(e) {
    if (!trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const ms = (x / rect.width) * dur
    onSeek?.(ms)
  }

  return (
    <div className="select-none">
      <div className="flex items-center justify-between text-xs text-muted mb-2 font-mono">
        <span>{formatTime(currentMs)}</span>
        <span>
          {clicks.length} clicks · {clickWindows.length} zooms
        </span>
        <span>{formatTime(dur)}</span>
      </div>
      <div
        ref={trackRef}
        onClick={handleTrackClick}
        className="relative h-12 bg-panel2 rounded cursor-pointer overflow-hidden"
      >
        {clickWindows.map((w, i) => (
          <div
            key={`zw-${i}`}
            className="absolute top-0 bottom-0 bg-accent/15 border-l border-r border-accent/40"
            style={{
              left: percent(w.start),
              width: `${Math.max(0, ((w.end - w.start) / dur) * 100)}%`
            }}
          />
        ))}
        {clicks.map((c, i) => (
          <button
            key={`c-${i}`}
            onClick={(e) => {
              e.stopPropagation()
              onSeek?.(c.timestamp)
            }}
            title={`Click @ ${formatTime(c.timestamp)} (${c.x},${c.y})`}
            className="absolute top-1 bottom-1 w-2 -ml-1 bg-accent rounded-full hover:scale-125 transition"
            style={{ left: percent(c.timestamp) }}
          />
        ))}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white pointer-events-none"
          style={{ left: percent(currentMs) }}
        >
          <div className="absolute -top-1 -left-1 w-2.5 h-2.5 bg-white rounded-full" />
        </div>
      </div>
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
