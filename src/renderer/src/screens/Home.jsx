import React, { useEffect, useState, useCallback } from 'react'
import { useSession } from '../store/useSession.js'

export default function Home() {
  const [sources, setSources] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('screen')
  const [mics, setMics] = useState([])
  const [micPermission, setMicPermission] = useState('unknown') // unknown | granted | denied
  const setSource = useSession((s) => s.setSource)
  const setMicEnabled = useSession((s) => s.setMicEnabled)
  const setMicDeviceId = useSession((s) => s.setMicDeviceId)
  const micEnabled = useSession((s) => s.micEnabled)
  const micDeviceId = useSession((s) => s.micDeviceId)
  const cameraEnabled = useSession((s) => s.cameraEnabled)
  const setCameraEnabled = useSession((s) => s.setCameraEnabled)
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
    // refresh on focus — handles Space switches & permission changes
    const onFocus = () => loadSources()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadSources])

  // Enumerate audio inputs. Labels are populated only after permission, so
  // probe with a quick getUserMedia first (release immediately), then list.
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
    // Move "default" entry to the top, drop "communications" duplicate
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

  const screens = sources.filter((s) => s.id.startsWith('screen:'))
  const windows = sources.filter((s) => s.id.startsWith('window:'))
  const visible = tab === 'screen' ? screens : windows

  return (
    <div className="h-full flex flex-col">
      <header className="px-8 pt-6 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pick a source</h1>
          <p className="text-muted text-sm mt-1">
            FocuClone records the screen and auto-zooms on every click.
          </p>
        </div>
        <button
          onClick={() => {
            setLoading(true)
            loadSources()
          }}
          className="text-sm px-3 py-1.5 rounded-md border border-panel2 hover:bg-panel2 flex items-center gap-1.5"
          title="Reload list"
        >
          <span className="text-xs">↻</span> Refresh
        </button>
      </header>

      <div className="px-8 mt-2">
        <div className="inline-flex rounded-lg bg-panel p-1 text-sm">
          <TabButton active={tab === 'screen'} onClick={() => setTab('screen')}>
            Screens · {screens.length}
          </TabButton>
          <TabButton active={tab === 'window'} onClick={() => setTab('window')}>
            Windows · {windows.length}
          </TabButton>
        </div>
        {tab === 'window' && (
          <p className="text-[11px] text-muted/80 mt-2">
            macOS limits this list to windows on the current Space — switch to a Space and click Refresh to see windows there.
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {loading ? (
          <div className="text-muted">Loading sources…</div>
        ) : visible.length === 0 ? (
          <div className="text-muted text-sm">
            No sources here. Make sure FocuClone has Screen Recording permission.
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
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

      <footer className="px-8 py-4 border-t border-panel2 bg-panel">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={micEnabled}
                onChange={(e) => setMicEnabled(e.target.checked)}
                className="accent-accent"
              />
              Record microphone
            </label>
            {micEnabled && (
              <MicSelector
                mics={mics}
                value={micDeviceId}
                onChange={setMicDeviceId}
                permission={micPermission}
                onRequest={loadMics}
              />
            )}
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={cameraEnabled}
                onChange={(e) => setCameraEnabled(e.target.checked)}
                className="accent-accent"
              />
              Record camera
            </label>
          </div>
          <button
            disabled={!selectedId}
            onClick={() => goto('record')}
            className="px-6 py-2 bg-accent text-black font-medium rounded-md disabled:bg-panel2 disabled:text-muted disabled:cursor-not-allowed"
          >
            Continue →
          </button>
        </div>
      </footer>
    </div>
  )
}

function MicSelector({ mics, value, onChange, permission, onRequest }) {
  if (permission === 'denied') {
    return (
      <span className="text-xs text-yellow-400">
        Mic permission needed.{' '}
        <button onClick={onRequest} className="underline">
          Retry
        </button>
      </span>
    )
  }
  if (!mics.length) {
    return <span className="text-xs text-muted">Detecting…</span>
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-panel2 text-sm rounded-md px-2 py-1.5 border border-panel2 focus:outline-none focus:border-accent max-w-[280px]"
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

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md transition ${
        active ? 'bg-panel2 text-white' : 'text-muted hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

function SourceTile({ source, selected, onPick }) {
  return (
    <button
      onClick={() => onPick(source)}
      className={`text-left bg-panel rounded-lg overflow-hidden border-2 transition group ${
        selected ? 'border-accent' : 'border-transparent hover:border-panel2'
      }`}
    >
      <div className="aspect-video bg-black flex items-center justify-center relative">
        {source.thumbnail && (
          <img
            src={source.thumbnail}
            alt={source.name}
            className="w-full h-full object-contain"
          />
        )}
      </div>
      <div className="p-2.5 flex items-center gap-2">
        {source.appIcon && (
          <img src={source.appIcon} className="w-4 h-4 flex-shrink-0" alt="" />
        )}
        <span className="text-sm truncate">{source.name}</span>
      </div>
    </button>
  )
}
