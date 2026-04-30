import React, { useEffect, useState } from 'react'
import { useSession } from '../store/useSession.js'

export default function Home() {
  const [sources, setSources] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('screen')
  const setSource = useSession((s) => s.setSource)
  const setMicEnabled = useSession((s) => s.setMicEnabled)
  const micEnabled = useSession((s) => s.micEnabled)
  const goto = useSession((s) => s.goto)
  const selectedId = useSession((s) => s.source?.id)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await window.electronAPI.getSources()
        if (!cancelled) setSources(res)
      } catch (err) {
        console.error(err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const t = setInterval(load, 4000) // refresh thumbnails periodically
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  const screens = sources.filter((s) => s.id.startsWith('screen:'))
  const windows = sources.filter((s) => s.id.startsWith('window:'))
  const visible = tab === 'screen' ? screens : windows

  return (
    <div className="h-full flex flex-col">
      <header className="px-8 pt-6 pb-2">
        <h1 className="text-2xl font-semibold tracking-tight">Pick a source</h1>
        <p className="text-muted text-sm mt-1">
          FocuClone records the screen and auto-zooms on every click.
        </p>
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

      <footer className="px-8 py-4 border-t border-panel2 bg-panel flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={micEnabled}
            onChange={(e) => setMicEnabled(e.target.checked)}
            className="accent-accent"
          />
          Record microphone
        </label>
        <button
          disabled={!selectedId}
          onClick={() => goto('record')}
          className="px-6 py-2 bg-accent text-black font-medium rounded-md disabled:bg-panel2 disabled:text-muted disabled:cursor-not-allowed"
        >
          Continue →
        </button>
      </footer>
    </div>
  )
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
