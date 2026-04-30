import React, { useEffect, useRef, useState } from 'react'
import { useSession } from '../store/useSession.js'
import Timeline from '../components/Timeline.jsx'

export default function Editor() {
  const session = useSession((s) => s.session)
  const goto = useSession((s) => s.goto)
  const exportSettings = useSession((s) => s.exportSettings)
  const updateExportSettings = useSession((s) => s.updateExportSettings)

  const videoRef = useRef(null)
  const [currentMs, setCurrentMs] = useState(0)
  const [durationMs, setDurationMs] = useState(session?.duration || 0)

  useEffect(() => {
    if (!session) {
      goto('home')
      return
    }
  }, [session])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = () => setCurrentMs(v.currentTime * 1000)
    const onMeta = () => {
      if (isFinite(v.duration) && v.duration > 0) {
        setDurationMs(v.duration * 1000)
      }
    }
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('durationchange', onMeta)
    return () => {
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('durationchange', onMeta)
    }
  }, [])

  if (!session) return null

  const videoSrc = `file://${session.videoPath}`
  const events = session.events || []
  const clickCount = events.filter((e) => e.type === 'click').length

  function seek(ms) {
    const v = videoRef.current
    if (!v) return
    v.currentTime = ms / 1000
    setCurrentMs(ms)
  }

  return (
    <div className="h-full flex">
      <div className="flex-1 flex flex-col">
        <div className="flex-1 flex items-center justify-center bg-black p-4">
          <video
            ref={videoRef}
            src={videoSrc}
            controls
            className="max-w-full max-h-full rounded"
          />
        </div>
        <div className="border-t border-panel2 bg-panel p-4">
          <Timeline
            events={events}
            durationMs={durationMs}
            currentMs={currentMs}
            onSeek={seek}
          />
        </div>
      </div>

      <aside className="w-80 border-l border-panel2 bg-panel overflow-y-auto">
        <div className="p-4 border-b border-panel2">
          <h2 className="font-semibold mb-1">Effect settings</h2>
          <p className="text-xs text-muted">{clickCount} clicks detected</p>
        </div>
        <div className="p-4 space-y-5">
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
            step={25}
            format={(v) => `${v}ms`}
            onChange={(easeInDuration) => updateExportSettings({ easeInDuration })}
          />
          <Slider
            label="Hold duration"
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
            step={25}
            format={(v) => `${v}ms`}
            onChange={(easeOutDuration) => updateExportSettings({ easeOutDuration })}
          />
          <Slider
            label="Min gap between zooms"
            value={exportSettings.minTimeBetweenZooms}
            min={300}
            max={2000}
            step={50}
            format={(v) => `${v}ms`}
            onChange={(minTimeBetweenZooms) => updateExportSettings({ minTimeBetweenZooms })}
          />

          <label className="flex items-center justify-between text-sm cursor-pointer pt-2">
            <span>Show cursor overlay</span>
            <input
              type="checkbox"
              checked={exportSettings.showCursor}
              onChange={(e) => updateExportSettings({ showCursor: e.target.checked })}
              className="accent-accent"
            />
          </label>

          <div>
            <div className="text-sm mb-2">Background</div>
            <div className="grid grid-cols-2 gap-2">
              {['none', 'rounded'].map((bg) => (
                <button
                  key={bg}
                  onClick={() => updateExportSettings({ background: bg })}
                  className={`py-2 rounded text-xs capitalize border ${
                    exportSettings.background === bg
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-panel2 text-muted'
                  }`}
                >
                  {bg}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="p-4 border-t border-panel2 sticky bottom-0 bg-panel">
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

function Slider({ label, value, min, max, step, onChange, format }) {
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-1">
        <span className="text-white/80">{label}</span>
        <span className="text-muted font-mono">{format ? format(value) : value}</span>
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
