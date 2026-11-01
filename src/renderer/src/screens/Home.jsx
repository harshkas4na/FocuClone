import React, { useEffect, useState, useCallback } from 'react'
import { useSession } from '../store/useSession.js'

export default function Home() {
  const [sources, setSources] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('screen')
  const [mics, setMics] = useState([])
  const [micPermission, setMicPermission] = useState('unknown')
  const setSource = useSession((s) => s.setSource)
  const setMicEnabled = useSession((s) => s.setMicEnabled)
  const setMicDeviceId = useSession((s) => s.setMicDeviceId)
  const micEnabled = useSession((s) => s.micEnabled)
  const micDeviceId = useSession((s) => s.micDeviceId)
  const cameraEnabled = useSession((s) => s.cameraEnabled)
  const setCameraEnabled = useSession((s) => s.setCameraEnabled)
  const cameraDeviceId = useSession((s) => s.cameraDeviceId)
  const setCameraDeviceId = useSession((s) => s.setCameraDeviceId)
  const [cameras, setCameras] = useState([])
  const goto = useSession((s) => s.goto)
  const selectedId = useSession((s) => s.source?.id)

  const loadSources = useCallback(async () => {
    try {
      const res = await window.electronAPI.getSources()
      setSources(res)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSources()
    const onFocus = () => loadSources()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadSources])

  const loadMics = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      setMicPermission('granted')
    } catch (err) {
      setMicPermission('denied')
      setMics([])
      return
    }
    const devs = await navigator.mediaDevices.enumerateDevices()
    const audioIns = devs
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label || 'Microphone',
        groupId: d.groupId
      }))
    const ordered = [
      ...audioIns.filter((d) => d.deviceId === 'default'),
      ...audioIns.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
    ]
    setMics(ordered)
  }, [])

  useEffect(() => {
    if (!micEnabled) return
    loadMics()
    const onChange = () => loadMics()
    navigator.mediaDevices.addEventListener?.('devicechange', onChange)
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', onChange)
  }, [micEnabled, loadMics])

  // Enumerate cameras once the toggle is on (labels need a granted stream).
  useEffect(() => {
    if (!cameraEnabled) return
    let cancelled = false
    async function loadCams() {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true })
        probe.getTracks().forEach((t) => t.stop())
        const devs = await navigator.mediaDevices.enumerateDevices()
        if (cancelled) return
        setCameras(
          devs
            .filter((d) => d.kind === 'videoinput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Camera' }))
        )
      } catch {
        if (!cancelled) setCameras([])
      }
    }
    loadCams()
    const onChange = () => loadCams()
    navigator.mediaDevices.addEventListener?.('devicechange', onChange)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener?.('devicechange', onChange)
    }
  }, [cameraEnabled])

  const screens = sources.filter((s) => s.id.startsWith('screen:'))
  const windows = sources.filter((s) => s.id.startsWith('window:'))
  const visible = tab === 'screen' ? screens : windows

  return (
    <div className="flex flex-1 min-h-0" style={{ background: 'var(--bg-1)' }}>
      {/* Main panel */}
      <div className="flex-1 overflow-y-auto" style={{ padding: '28px 32px' }}>
        <div className="flex justify-between items-end mb-5 gap-4">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight m-0" style={{ color: 'var(--fg-1)' }}>
              Pick a source
            </h1>
            <p className="m-0 mt-1 text-[13px]" style={{ color: 'var(--fg-2)' }}>
              FocuClone records the screen and auto-zooms on every click.
            </p>
          </div>
          <div className="flex gap-2.5 items-center">
            <div className="seg">
              <button className={tab === 'screen' ? 'on' : ''} onClick={() => setTab('screen')}>
                Screens · {screens.length}
              </button>
              <button className={tab === 'window' ? 'on' : ''} onClick={() => setTab('window')}>
                Windows · {windows.length}
              </button>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setLoading(true); loadSources() }}
              title="Reload list"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Refresh
            </button>
          </div>
        </div>

        {tab === 'window' && (
          <div className="alert alert-info mb-4">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
              <path d="M12 8v5M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <div>
              <div className="alert-title">Showing windows on the current Space</div>
              <div className="alert-sub">
                macOS limits this list to the current Space — switch Spaces and refresh to see others.
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-3 gap-3.5">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="src-card">
                <div className="src-thumb skel" />
                <div className="src-meta">
                  <div className="flex-1">
                    <div className="skel rounded h-2 w-3/5 mb-1.5" />
                    <div className="skel rounded h-2 w-2/5" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div
            className="text-center flex flex-col items-center gap-2.5"
            style={{
              padding: '60px 20px',
              border: '1px dashed var(--line-2)',
              borderRadius: 12
            }}
          >
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--fg-3)' }}>
              <rect x="3" y="5" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 21h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <div className="font-semibold mt-1" style={{ color: 'var(--fg-1)' }}>No sources here</div>
            <div className="text-[12.5px]" style={{ color: 'var(--fg-2)', maxWidth: 360, margin: '0 0 8px' }}>
              Make sure FocuClone has Screen Recording permission in System Settings.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3.5">
            {visible.map((s) => (
              <SourceTile
                key={s.id}
                source={s}
                selected={selectedId === s.id}
                onPick={setSource}
              />
            ))}
          </div>
        )}
      </div>

      {/* Side panel */}
      <aside
        className="flex-shrink-0 flex flex-col overflow-y-auto"
        style={{
          width: 320,
          background: 'var(--bg-2)',
          borderLeft: '1px solid var(--line-1)',
          padding: 24
        }}
      >
        <div className="flex flex-col gap-3 mb-5">
          <div className="label-eyebrow">Inputs</div>

          <div className="row-toggle">
            <span className="row-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.7" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </span>
            <div className="row-text">
              <div className="row-title">Microphone</div>
              <div className="row-sub">{micEnabled ? 'Recording audio' : 'Off'}</div>
            </div>
            <button
              className={`toggle ${micEnabled ? 'on' : ''}`}
              onClick={() => setMicEnabled(!micEnabled)}
              aria-label="Toggle microphone"
            />
          </div>

          {micEnabled && micPermission !== 'denied' && (
            <div className="row-sub-detail">
              <MicSelector
                mics={mics}
                value={micDeviceId}
                onChange={setMicDeviceId}
                permission={micPermission}
                onRequest={loadMics}
              />
              <VuMeter active={mics.length > 0} deviceId={micDeviceId} />
            </div>
          )}
          {micEnabled && micPermission === 'denied' && (
            <div className="alert alert-err">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 3l9 16H3l9-16z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                <path d="M12 10v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <div>
                <div className="alert-title">Microphone permission denied</div>
                <div className="alert-sub">
                  Open System Settings → Privacy & Security → Microphone, allow FocuClone, then retry.
                </div>
                <div className="alert-actions">
                  <button className="btn btn-ghost btn-sm" onClick={loadMics}>Retry</button>
                </div>
              </div>
            </div>
          )}

          <div className="row-toggle">
            <span className="row-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="6" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.7" />
                <path d="M16 10l5-3v10l-5-3" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="row-text">
              <div className="row-title">Camera</div>
              <div className="row-sub">
                {cameraEnabled
                  ? cameras.find((c) => c.deviceId === cameraDeviceId)?.label ||
                    cameras[0]?.label ||
                    'Detecting…'
                  : 'Off'}
              </div>
            </div>
            <button
              className={`toggle ${cameraEnabled ? 'on' : ''}`}
              onClick={() => setCameraEnabled(!cameraEnabled)}
              aria-label="Toggle camera"
            />
          </div>
          {cameraEnabled && (
            <div className="row-sub-detail">
              {cameras.length > 1 && (
                <select
                  value={cameraDeviceId}
                  onChange={(e) => setCameraDeviceId(e.target.value)}
                  className="input"
                  style={{ width: '100%' }}
                >
                  {cameras.map((c) => (
                    <option key={c.deviceId} value={c.deviceId}>{c.label}</option>
                  ))}
                </select>
              )}
              <CameraLivePreview deviceId={cameraDeviceId} />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 mb-5">
          <div className="label-eyebrow">Recording mode</div>
          <div className="seg" style={{ width: '100%' }}>
            <button className="on" style={{ flex: 1 }}>Full screen</button>
            <button style={{ flex: 1 }} title="Coming soon" disabled>Area</button>
          </div>
        </div>

        <div className="mt-auto">
          <button
            className="btn btn-primary btn-lg w-full justify-center"
            disabled={!selectedId}
            onClick={() => goto('record')}
          >
            Continue to Record
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="text-center mt-2 text-[11px]" style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
            ⏎ continue · esc cancel
          </div>
        </div>
      </aside>
    </div>
  )
}

// Real input level meter. Opens the selected mic, runs an AnalyserNode, and
// lights bars from measured RMS — the previous version was a sine-wave
// animation that moved even with the mic unplugged.
function VuMeter({ active, deviceId }) {
  const [level, setLevel] = React.useState(0) // 0..1
  React.useEffect(() => {
    if (!active) return
    let cancelled = false
    let stream = null
    let ac = null
    let raf = 0
    async function start() {
      try {
        const constraint =
          deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraint, video: false })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        ac = new (window.AudioContext || window.webkitAudioContext)()
        const src = ac.createMediaStreamSource(stream)
        const analyser = ac.createAnalyser()
        analyser.fftSize = 512
        src.connect(analyser)
        const buf = new Float32Array(analyser.fftSize)
        const loop = () => {
          analyser.getFloatTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
          const rms = Math.sqrt(sum / buf.length)
          // Perceptual-ish scaling so quiet speech still registers.
          setLevel(Math.min(1, rms * 4))
          raf = requestAnimationFrame(loop)
        }
        raf = requestAnimationFrame(loop)
      } catch {
        // Meter is best-effort; mic errors surface via the selector UI.
      }
    }
    start()
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      if (stream) stream.getTracks().forEach((t) => t.stop())
      if (ac) ac.close().catch(() => {})
    }
  }, [active, deviceId])

  const bars = 18
  const lit = Math.round(level * bars)
  return (
    <div className="vu">
      {Array.from({ length: bars }).map((_, i) => {
        const on = i < lit
        const color = i < 12 ? 'var(--acc)' : i < 15 ? 'var(--warn)' : 'var(--err)'
        return (
          <span
            key={i}
            className="vu-bar"
            style={{
              height: on ? '85%' : '25%',
              background: on ? color : 'var(--bg-4)',
              transition: 'height 60ms linear, background 60ms linear'
            }}
          />
        )
      })}
    </div>
  )
}

// Live camera preview — replaces the old static placeholder card.
function CameraLivePreview({ deviceId }) {
  const videoRef = React.useRef(null)
  const [error, setError] = React.useState(null)
  React.useEffect(() => {
    let cancelled = false
    let stream = null
    async function start() {
      setError(null)
      try {
        const constraint =
          deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true
        stream = await navigator.mediaDevices.getUserMedia({ video: constraint, audio: false })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().catch(() => {})
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Camera unavailable')
      }
    }
    start()
    return () => {
      cancelled = true
      if (stream) stream.getTracks().forEach((t) => t.stop())
    }
  }, [deviceId])
  return (
    <div className="cam-preview" style={{ overflow: 'hidden' }}>
      {error ? (
        <div className="cam-label">{error}</div>
      ) : (
        <video
          ref={videoRef}
          muted
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
        />
      )}
    </div>
  )
}

function RowToggle({ on, onToggle, icon, title, sub }) {
  return (
    <button
      className="flex items-center gap-3 text-left w-full"
      onClick={onToggle}
      style={{
        padding: 12,
        background: 'var(--bg-3)',
        border: '1px solid var(--line-2)',
        borderRadius: 8,
        cursor: 'default'
      }}
    >
      <span
        className="flex items-center justify-center"
        style={{
          width: 32, height: 32, borderRadius: 8,
          background: 'var(--bg-4)', color: 'var(--fg-2)'
        }}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-[13px]" style={{ color: 'var(--fg-1)' }}>{title}</div>
        <div className="text-[11.5px] truncate" style={{ color: 'var(--fg-3)' }}>{sub}</div>
      </div>
      <span className={`toggle ${on ? 'on' : ''}`} />
    </button>
  )
}

function MicSelector({ mics, value, onChange, permission, onRequest }) {
  if (permission === 'denied') {
    return (
      <div className="alert alert-warn">
        <div>
          <div className="alert-title">Mic permission needed</div>
          <div className="alert-sub">
            Grant access in System Settings → Privacy & Security → Microphone.
          </div>
          <div className="alert-actions">
            <button className="btn btn-ghost btn-sm" onClick={onRequest}>Retry</button>
          </div>
        </div>
      </div>
    )
  }
  if (!mics.length) {
    return <div className="text-[11.5px]" style={{ color: 'var(--fg-3)' }}>Detecting…</div>
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="input"
      style={{ width: '100%' }}
    >
      {mics.map((m) => (
        <option key={m.deviceId} value={m.deviceId}>
          {m.deviceId === 'default' ? `Default — ${stripDefault(m.label)}` : m.label}
        </option>
      ))}
    </select>
  )
}

function stripDefault(label) {
  return label.replace(/^Default\s*-\s*/i, '').trim() || 'System default'
}

function SourceTile({ source, selected, onPick }) {
  return (
    <button
      onClick={() => onPick(source)}
      className={`src-card ${selected ? 'sel' : ''}`}
    >
      <div className="src-thumb">
        {source.thumbnail && (
          <img
            src={source.thumbnail}
            alt={source.name}
            className="w-full h-full object-cover"
          />
        )}
        {selected && (
          <span className="src-thumb-sel">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3"
                    strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
      </div>
      <div className="src-meta">
        {source.appIcon && (
          <img src={source.appIcon} className="w-4 h-4 flex-shrink-0" alt="" />
        )}
        <div className="src-meta-text">
          <div className="src-name">{source.name}</div>
          <div className="src-sub">
            {source.id.startsWith('screen:') ? 'Display' : 'Window'}
          </div>
        </div>
      </div>
    </button>
  )
}
