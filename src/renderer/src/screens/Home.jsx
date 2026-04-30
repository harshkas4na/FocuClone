import React, { useEffect, useState } from 'react'
import { useSession } from '../store/useSession.js'

export default function Home() {
  const [sources, setSources] = useState([])
  const [loading, setLoading] = useState(true)
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
    return () => {
      cancelled = true
    }
  }, [])

  const screens = sources.filter((s) => s.id.startsWith('screen:'))
  const windows = sources.filter((s) => s.id.startsWith('window:'))

  return (
    <div className="h-full overflow-y-auto p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Pick a source</h1>
        <p className="text-muted text-sm mt-1">
          Choose a screen or window to record. FocuClone will auto-zoom on every click.
        </p>
      </header>

      {loading ? (
        <div className="text-muted">Loading sources…</div>
      ) : (
        <>
          <SourceGrid
            title="Screens"
            sources={screens}
            selectedId={selectedId}
            onPick={setSource}
          />
          <SourceGrid
            title="Windows"
            sources={windows}
            selectedId={selectedId}
            onPick={setSource}
          />
        </>
      )}

      <div className="mt-8 flex items-center justify-between bg-panel rounded-lg p-4 border border-panel2">
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
          className="px-5 py-2 bg-accent text-black font-medium rounded-md disabled:bg-panel2 disabled:text-muted"
        >
          Continue
        </button>
      </div>
    </div>
  )
}

function SourceGrid({ title, sources, selectedId, onPick }) {
  if (!sources.length) return null
  return (
    <section className="mb-8">
      <h2 className="text-sm uppercase tracking-wider text-muted mb-3">{title}</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {sources.map((s) => (
          <button
            key={s.id}
            onClick={() => onPick(s)}
            className={`text-left bg-panel rounded-lg overflow-hidden border-2 transition ${
              selectedId === s.id
                ? 'border-accent'
                : 'border-transparent hover:border-panel2'
            }`}
          >
            <div className="aspect-video bg-black flex items-center justify-center">
              {s.thumbnail && (
                <img src={s.thumbnail} alt={s.name} className="w-full h-full object-cover" />
              )}
            </div>
            <div className="p-3 flex items-center gap-2">
              {s.appIcon && <img src={s.appIcon} className="w-4 h-4" alt="" />}
              <span className="text-sm truncate">{s.name}</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}
