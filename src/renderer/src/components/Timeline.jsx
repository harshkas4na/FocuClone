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
  videoSrc,
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

  // Snap a candidate time to nearby "interesting" timestamps if within
  // `snapTolMs`. Snap targets: 0, duration, other zoom edges, click marks,
  // and the playhead position. Returns the snapped value.
  function snapMs(candidateMs, ignoreZoomId = null, snapTolMs = 8 / Math.max(0.001, pxPerMs)) {
    const targets = [0, dur, currentMs, trimIn, trimOut]
    for (const z of zooms) {
      if (z.id === ignoreZoomId) continue
      targets.push(z.start, z.peakStart, z.peakEnd, z.end)
    }
    for (const c of clicks) targets.push(c.timestamp)
    let best = candidateMs
    let bestDist = snapTolMs
    for (const t of targets) {
      const d = Math.abs(t - candidateMs)
      if (d < bestDist) { bestDist = d; best = t }
    }
    return best
  }

  function onDragMove(e) {
    const d = dragRef.current
    if (!d) return
    const rawMs = pxToMs(e.clientX)
    const dMs = rawMs - d.startMs

    if (d.kind === 'move' && d.origZoom) {
      const z = d.origZoom
      const len = z.end - z.start
      let start = Math.max(0, z.start + dMs)
      if (start + len > dur) start = Math.max(0, dur - len)
      // Snap the leading edge to nearby anchors.
      const snapped = snapMs(start, z.id)
      onMoveZoom?.(z.id, snapped)
    } else if (d.kind === 'left-edge' && d.origZoom) {
      const z = d.origZoom
      const easeIn = z.peakStart - z.start
      let newStart = Math.max(0, Math.min(z.peakStart - 100, z.start + dMs))
      newStart = snapMs(newStart, z.id)
      onResizeZoom?.(z.id, { start: newStart, peakStart: newStart + easeIn })
    } else if (d.kind === 'right-edge' && d.origZoom) {
      const z = d.origZoom
      const easeOut = z.end - z.peakEnd
      let newEnd = Math.min(dur, Math.max(z.peakEnd + 100, z.end + dMs))
      newEnd = snapMs(newEnd, z.id)
      onResizeZoom?.(z.id, { end: newEnd, peakEnd: newEnd - easeOut })
    } else if (d.kind === 'trim-in') {
      let newIn = Math.max(0, Math.min(d.origTrim.outMs - 200, d.origTrim.inMs + dMs))
      newIn = snapMs(newIn)
      onTrimChange?.({ inMs: newIn })
    } else if (d.kind === 'trim-out') {
      let newOut = Math.min(dur, Math.max(d.origTrim.inMs + 200, d.origTrim.outMs + dMs))
      newOut = snapMs(newOut)
      onTrimChange?.({ outMs: newOut })
    } else if (d.kind === 'scrub') {
      onSeek?.(rawMs)
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
              <ThumbnailStrip width={contentW} videoSrc={videoSrc} durationMs={dur} />
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
              const anchors = Array.isArray(z.anchors) ? z.anchors : []
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
                  title={
                    anchors.length > 1
                      ? `Zoom · ${anchors.length} clicks · ${formatTime(z.start)}–${formatTime(z.end)}`
                      : `Zoom ${formatTime(z.start)}–${formatTime(z.end)}`
                  }
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
                  {anchors.length > 1 && (
                    <span
                      className="tl-auto-tag"
                      style={{ background: 'rgba(255,210,63,0.18)', color: '#FFD23F' }}
                    >
                      {anchors.length} clicks
                    </span>
                  )}
                  {auto && anchors.length <= 1 && <span className="tl-auto-tag">auto</span>}
                  {/* Anchor pips — small dots inside the zoom block at each
                      click position. Lets the user see at a glance why this
                      one block spans so much timeline (it has retargets). */}
                  {anchors.map((a, idx) => {
                    const rel = (a.t - z.start) / Math.max(1, z.end - z.start)
                    if (rel < 0 || rel > 1) return null
                    return (
                      <span
                        key={idx}
                        className="tl-zoom-anchor"
                        style={{
                          position: 'absolute',
                          left: `${rel * 100}%`,
                          top: '50%',
                          width: 5,
                          height: 5,
                          marginLeft: -2.5,
                          marginTop: -2.5,
                          borderRadius: '50%',
                          background: '#1A1A1A',
                          boxShadow: '0 0 0 1.5px rgba(255,210,63,0.9)',
                          pointerEvents: 'none'
                        }}
                      />
                    )
                  })}
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
              <Waveform width={contentW} videoSrc={videoSrc} durationMs={dur} />
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

// Extracts real frames from the source video at evenly-spaced times. Uses a
// hidden HTMLVideoElement + canvas — runs in the renderer, no IPC, no ffmpeg
// subprocess. Decodes lazily as the strip mounts, one frame at a time so the
// browser doesn't choke on a parallel-seek storm.
function ThumbnailStrip({ width, videoSrc, durationMs }) {
  const cellW = 60
  const cellH = 36
  const count = Math.max(1, Math.floor(width / cellW))
  const [thumbs, setThumbs] = useState([]) // dataURLs indexed by cell

  useEffect(() => {
    if (!videoSrc || !durationMs || durationMs <= 0) return
    let cancelled = false
    const video = document.createElement('video')
    video.muted = true
    video.crossOrigin = 'anonymous'
    video.preload = 'auto'
    video.src = videoSrc
    const canvas = document.createElement('canvas')
    canvas.width = cellW * 2 // 2x for retina
    canvas.height = cellH * 2
    const ctx = canvas.getContext('2d')

    const collected = []
    async function run() {
      // Wait for the metadata so seek lands cleanly.
      await new Promise((res, rej) => {
        video.addEventListener('loadedmetadata', res, { once: true })
        video.addEventListener('error', () => rej(new Error('video load')), { once: true })
      })
      const vw = video.videoWidth || 16
      const vh = video.videoHeight || 9
      const vAspect = vw / vh
      const cAspect = cellW / cellH
      // Fit (contain) the source into the cell box, letterboxing if needed.
      let dw, dh
      if (vAspect > cAspect) { dw = cellW * 2; dh = (cellW * 2) / vAspect }
      else { dh = cellH * 2; dw = cellH * 2 * vAspect }
      const dx = (cellW * 2 - dw) / 2
      const dy = (cellH * 2 - dh) / 2

      for (let i = 0; i < count; i++) {
        if (cancelled) return
        // Sample at the midpoint of each cell. Subtract 50ms from the last
        // one to avoid landing past the duration.
        const tMs = Math.max(0, Math.min(durationMs - 50, ((i + 0.5) / count) * durationMs))
        await new Promise((res) => {
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked)
            res()
          }
          video.addEventListener('seeked', onSeeked)
          video.currentTime = tMs / 1000
        })
        ctx.fillStyle = '#0a0a0a'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(video, dx, dy, dw, dh)
        const url = canvas.toDataURL('image/jpeg', 0.7)
        collected.push(url)
        if (!cancelled) setThumbs([...collected])
      }
    }
    run().catch(() => {/* network-style failures are non-fatal; we just don't show thumbs */})
    return () => {
      cancelled = true
      video.removeAttribute('src')
      video.load()
    }
  }, [videoSrc, durationMs, count])

  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className="tl-thumb"
          style={{
            left: i * cellW + 2,
            width: cellW - 4,
            background: thumbs[i]
              ? `#000 center/cover no-repeat url(${thumbs[i]})`
              : `hsl(${(i * 22) % 360}, 18%, 18%)`
          }}
        />
      ))}
    </>
  )
}

// Real-audio waveform. Pulls the source file, decodes the audio track, and
// reduces it to one peak per output column. Skipped silently if the source
// has no audio or decode fails (most users don't need this to ship).
function Waveform({ width, videoSrc, durationMs }) {
  const stepPx = 4
  const count = Math.max(1, Math.floor(width / stepPx))
  const [peaks, setPeaks] = useState(null) // Float32Array of length `count`

  useEffect(() => {
    if (!videoSrc || !durationMs) return
    let cancelled = false
    async function run() {
      try {
        const buf = await (await fetch(videoSrc)).arrayBuffer()
        if (cancelled) return
        // OfflineAudioContext would be cleaner but isn't needed here; the
        // realtime AC can decode without playback.
        const AC = window.AudioContext || window.webkitAudioContext
        const ac = new AC()
        const audio = await ac.decodeAudioData(buf)
        if (cancelled) { ac.close(); return }
        const ch = audio.getChannelData(0) // mono / first channel is enough
        const samplesPerBin = Math.max(1, Math.floor(ch.length / count))
        const out = new Float32Array(count)
        for (let i = 0; i < count; i++) {
          const a = i * samplesPerBin
          const b = Math.min(ch.length, a + samplesPerBin)
          let peak = 0
          for (let j = a; j < b; j++) {
            const v = Math.abs(ch[j])
            if (v > peak) peak = v
          }
          out[i] = peak
        }
        // Normalize to [0..1] for stable visual scale.
        let max = 0
        for (let i = 0; i < count; i++) if (out[i] > max) max = out[i]
        if (max > 0) for (let i = 0; i < count; i++) out[i] /= max
        if (!cancelled) setPeaks(out)
        ac.close()
      } catch {
        // No audio track / decode failed — fall through to synthetic look.
      }
    }
    run()
    return () => { cancelled = true }
  }, [videoSrc, durationMs, count])

  return (
    <>
      {Array.from({ length: count }).map((_, i) => {
        const h = peaks
          ? Math.max(6, peaks[i] * 100)
          : 20 + Math.abs(Math.sin(i * 0.4) * 60 + Math.cos(i * 0.13) * 20)
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
