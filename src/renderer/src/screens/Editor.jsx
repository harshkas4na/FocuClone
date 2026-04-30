import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../store/useSession.js'
import Timeline from '../components/Timeline.jsx'
import { buildClickWindows, sampleZoom } from '../lib/zoomTimeline.js'

const BACKGROUND_OPTIONS = [
  { id: 'none', label: 'None', preview: 'bg-black' },
  {
    id: 'rounded',
    label: 'Rounded',
    preview: 'bg-[#101014]'
  },
  {
    id: 'wallpaper',
    label: 'Wallpaper',
    preview: 'bg-gradient-to-br from-[#0e1230] to-[#2a1149]'
  }
]

export default function Editor() {
  const session = useSession((s) => s.session)
  const goto = useSession((s) => s.goto)
  const exportSettings = useSession((s) => s.exportSettings)
  const updateExportSettings = useSession((s) => s.updateExportSettings)

  const videoRef = useRef(null)
  const wrapperRef = useRef(null)
  const cursorOverlayRef = useRef(null)
  const rafRef = useRef(0)
  const currentMsRef = useRef(0)

  const [currentMs, setCurrentMs] = useState(0)
  const [durationMs, setDurationMs] = useState(session?.duration || 0)
  const [previewEnabled, setPreviewEnabled] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)

  useEffect(() => {
    if (!session) goto('home')
  }, [session])

  const clickWindows = useMemo(() => {
    if (!session) return []
    return buildClickWindows(session.events || [], exportSettings)
  }, [session, exportSettings])

  // Drive transform from rAF using formula-based sampler — smooth at any frame rate.
  useEffect(() => {
    function tick() {
      const v = videoRef.current
      const cur = cursorOverlayRef.current
      if (v && session) {
        const tMs = v.currentTime * 1000
        if (previewEnabled) {
          const { zoom, cx, cy } = sampleZoom(session.events || [], tMs, exportSettings)
          v.style.transformOrigin = `${(cx * 100).toFixed(2)}% ${(cy * 100).toFixed(2)}%`
          v.style.transform = `scale(${zoom.toFixed(3)})`
          if (cur) {
            const inWin = clickWindows.find((w) => tMs >= w.start && tMs <= w.end)
            cur.style.opacity = inWin && exportSettings.showCursor ? '1' : '0'
          }
        } else {
          v.style.transform = 'none'
          if (cur) cur.style.opacity = '0'
        }
        if (Math.abs(tMs - currentMsRef.current) > 30) {
          setCurrentMs(tMs)
          currentMsRef.current = tMs
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [session, exportSettings, previewEnabled, clickWindows])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onMeta = () => {
      if (isFinite(v.duration) && v.duration > 0) setDurationMs(v.duration * 1000)
    }
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('durationchange', onMeta)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    return () => {
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('durationchange', onMeta)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
    }
  }, [])

  // Spacebar play/pause
  useEffect(() => {
    function onKey(e) {
      if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
        e.preventDefault()
        const v = videoRef.current
        if (!v) return
        if (v.paused) v.play()
        else v.pause()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!session) return null

  const videoSrc = `file://${session.videoPath}`
  const events = session.events || []
  const clickCount = events.filter((e) => e.type === 'click').length
  const bg = exportSettings.background

  function seek(ms) {
    const v = videoRef.current
    if (!v) return
    v.currentTime = ms / 1000
    setCurrentMs(ms)
    currentMsRef.current = ms
  }

  function togglePlay() {
    const v = videoRef.current
    if (!v) return
    if (v.paused) v.play()
    else v.pause()
  }

  return (
    <div className="h-full flex">
      <div className="flex-1 flex flex-col min-w-0">
        <div
          className={`flex-1 flex items-center justify-center p-8 ${
            bg === 'wallpaper'
              ? 'bg-gradient-to-br from-[#0e1230] to-[#2a1149]'
              : bg === 'rounded'
              ? 'bg-[#101014]'
              : 'bg-black'
          } transition-colors`}
        >
          <div
            ref={wrapperRef}
            className={`relative overflow-hidden bg-black ${
              bg === 'rounded' || bg === 'wallpaper' ? 'rounded-xl shadow-2xl' : 'rounded'
            }`}
            style={{
              maxWidth: bg === 'none' ? '100%' : '92%',
              maxHeight: bg === 'none' ? '100%' : '92%',
              aspectRatio:
                session.screenW && session.screenH
                  ? `${session.screenW} / ${session.screenH}`
                  : '16 / 9',
              width: '100%'
            }}
          >
            <video
              ref={videoRef}
              src={videoSrc}
              className="w-full h-full block"
              style={{
                transformOrigin: 'center',
                willChange: 'transform'
              }}
            />
            <div
              ref={cursorOverlayRef}
              className="absolute pointer-events-none"
              style={{
                opacity: 0,
                left: '50%',
                top: '50%',
                width: 28,
                height: 32,
                marginLeft: -2,
                marginTop: -2,
                transition: 'opacity 120ms linear',
                filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))'
              }}
            >
              <CursorSvg />
            </div>
          </div>
        </div>

        <div className="border-t border-panel2 bg-panel px-5 py-4">
          <div className="flex items-center gap-3 mb-3">
            <button
              onClick={togglePlay}
              className="w-9 h-9 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 transition"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <rect x="2" y="1" width="3.5" height="12" rx="0.5" />
                  <rect x="8.5" y="1" width="3.5" height="12" rx="0.5" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <path d="M2 1 L12 7 L2 13 Z" />
                </svg>
              )}
            </button>
            <div className="flex-1">
              <Timeline
                events={events}
                durationMs={durationMs}
                currentMs={currentMs}
                clickWindows={clickWindows}
                onSeek={seek}
              />
            </div>
          </div>
          <div className="flex items-center justify-between text-xs text-muted">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={previewEnabled}
                onChange={(e) => setPreviewEnabled(e.target.checked)}
                className="accent-accent"
              />
              Live zoom preview
            </label>
            <span className="text-muted/70">
              Space to play · click timeline to seek
            </span>
          </div>
        </div>
      </div>

      <aside className="w-[340px] border-l border-panel2 bg-panel flex flex-col flex-shrink-0">
        <div className="px-5 py-4 border-b border-panel2">
          <h2 className="font-semibold mb-0.5">Effect settings</h2>
          <p className="text-xs text-muted">
            {clickCount} clicks · {clickWindows.length} zoom windows
          </p>
        </div>
        <div className="px-5 py-5 space-y-5 overflow-y-auto flex-1">
          <Section title="Zoom">
            <Slider
              label="Zoom level"
              value={exportSettings.zoomLevel}
              min={1.2}
              max={3.0}
              step={0.1}
              format={(v) => `${v.toFixed(1)}×`}
              onChange={(zoomLevel) => updateExportSettings({ zoomLevel })}
            />
            <Slider
              label="Ease in"
              value={exportSettings.easeInDuration}
              min={150}
              max={600}
              step={20}
              format={(v) => `${v}ms`}
              onChange={(easeInDuration) => updateExportSettings({ easeInDuration })}
            />
            <Slider
              label="Hold"
              value={exportSettings.holdDuration}
              min={500}
              max={2500}
              step={50}
              format={(v) => `${v}ms`}
              onChange={(holdDuration) => updateExportSettings({ holdDuration })}
            />
            <Slider
              label="Ease out"
              value={exportSettings.easeOutDuration}
              min={150}
              max={600}
              step={20}
              format={(v) => `${v}ms`}
              onChange={(easeOutDuration) => updateExportSettings({ easeOutDuration })}
            />
            <Slider
              label="Min gap"
              value={exportSettings.minTimeBetweenZooms}
              min={300}
              max={2000}
              step={50}
              format={(v) => `${v}ms`}
              onChange={(minTimeBetweenZooms) => updateExportSettings({ minTimeBetweenZooms })}
            />
          </Section>

          <Section title="Cursor">
            <label className="flex items-center justify-between text-sm cursor-pointer">
              <span>Show cursor at click</span>
              <input
                type="checkbox"
                checked={exportSettings.showCursor}
                onChange={(e) => updateExportSettings({ showCursor: e.target.checked })}
                className="accent-accent"
              />
            </label>
          </Section>

          <Section title="Background">
            <div className="grid grid-cols-3 gap-2">
              {BACKGROUND_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => updateExportSettings({ background: opt.id })}
                  className={`relative aspect-video rounded-md overflow-hidden border-2 transition ${
                    exportSettings.background === opt.id
                      ? 'border-accent'
                      : 'border-panel2 hover:border-white/20'
                  }`}
                >
                  <div className={`absolute inset-0 ${opt.preview}`} />
                  <div className="absolute inset-1.5 bg-white/15 rounded-sm" />
                  <span className="absolute bottom-1 left-1.5 text-[10px] font-medium text-white/90">
                    {opt.label}
                  </span>
                </button>
              ))}
            </div>
          </Section>
        </div>
        <div className="p-4 border-t border-panel2 bg-panel">
          <div className="flex gap-2">
            <button
              onClick={() => goto('home')}
              className="flex-1 px-4 py-2 rounded-md text-sm border border-panel2 hover:bg-panel2"
            >
              Discard
            </button>
            <button
              onClick={() => goto('export')}
              className="flex-1 px-4 py-2 rounded-md bg-accent text-black font-medium text-sm"
            >
              Export →
            </button>
          </div>
        </div>
      </aside>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div>
      <h3 className="text-[11px] uppercase tracking-wider text-muted mb-3 font-medium">
        {title}
      </h3>
      <div className="space-y-3.5">{children}</div>
    </div>
  )
}

function Slider({ label, value, min, max, step, onChange, format }) {
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-1">
        <span className="text-white/80">{label}</span>
        <span className="text-muted font-mono text-xs">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full"
      />
    </div>
  )
}

function CursorSvg() {
  return (
    <svg viewBox="0 0 40 48" className="w-full h-full">
      <path
        d="M 4 2 L 4 42 L 14 32 L 20 46 L 26 43 L 20 30 L 34 30 Z"
        fill="#ffffff"
        stroke="#000000"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}
