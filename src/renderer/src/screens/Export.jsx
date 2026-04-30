import React, { useEffect, useRef, useState } from 'react'
import { useSession } from '../store/useSession.js'
import { findBackground, aspectRatioOf } from '../lib/backgrounds.js'

const QUALITY_PRESETS = {
  high: { label: 'High (CRF 18)', crf: 18 },
  medium: { label: 'Medium (CRF 23)', crf: 23 },
  small: { label: 'Small file (CRF 28)', crf: 28 }
}

export default function Export() {
  const session = useSession((s) => s.session)
  const exportSettings = useSession((s) => s.exportSettings)
  const updateExportSettings = useSession((s) => s.updateExportSettings)
  const zooms = useSession((s) => s.zooms)
  const trim = useSession((s) => s.trim)
  const goto = useSession((s) => s.goto)
  const exportResult = useSession((s) => s.exportResult)
  const setExportResult = useSession((s) => s.setExportResult)
  const reset = useSession((s) => s.reset)

  const [phase, setPhase] = useState('idle') // idle | running | done | error
  const [progress, setProgress] = useState(0)
  const [logTail, setLogTail] = useState('')
  const [qualityKey, setQualityKey] = useState('medium')
  const [encoder, setEncoder] = useState('videotoolbox')

  const offProgressRef = useRef(null)
  const offLogRef = useRef(null)

  useEffect(() => {
    if (!session) {
      goto('home')
      return
    }
    offProgressRef.current = window.electronAPI.onExportProgress((pct) => setProgress(pct))
    offLogRef.current = window.electronAPI.onExportLog((msg) => {
      setLogTail((prev) => (prev + msg).slice(-2000))
    })
    return () => {
      offProgressRef.current?.()
      offLogRef.current?.()
    }
  }, [session])

  if (!session) return null

  async function startExport() {
    setPhase('running')
    setProgress(0)
    setLogTail('')
    const bg = findBackground(exportSettings.backgroundValue)
    const opts = {
      ...exportSettings,
      quality: QUALITY_PRESETS[qualityKey].crf,
      useVideoToolbox: encoder === 'videotoolbox',
      // Pre-resolved background descriptor so the main process doesn't need
      // to duplicate the catalogue.
      bgFfmpeg: bg.ffmpeg,
      canvasAspectRatio: aspectRatioOf(
        exportSettings.canvasAspect,
        session.screenW && session.screenH ? session.screenW / session.screenH : 16 / 9
      ),
      zooms,
      trim // { inMs, outMs } — null/undefined means no trim
    }
    const res = await window.electronAPI.processVideo(session, opts)
    if (res.ok) {
      setExportResult({ outputPath: res.outputPath })
      setPhase('done')
    } else {
      setExportResult({ error: res.error })
      setPhase('error')
    }
  }

  return (
    <div className="h-full flex flex-col p-8 max-w-3xl mx-auto w-full">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Export</h1>
        <p className="text-muted text-sm mt-1">
          FFmpeg will apply zoom-on-click and render to MP4.
        </p>
      </header>

      <section className="bg-panel rounded-lg border border-panel2 p-5 space-y-5">
        <div>
          <div className="text-sm mb-2">Quality</div>
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(QUALITY_PRESETS).map(([key, p]) => (
              <button
                key={key}
                onClick={() => setQualityKey(key)}
                disabled={phase === 'running'}
                className={`py-2 rounded text-sm border ${
                  qualityKey === key
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-panel2 text-muted hover:text-white'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-sm mb-2">Encoder</div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setEncoder('videotoolbox')}
              disabled={phase === 'running'}
              className={`py-2 rounded text-sm border ${
                encoder === 'videotoolbox'
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-panel2 text-muted hover:text-white'
              }`}
            >
              VideoToolbox (fast)
            </button>
            <button
              onClick={() => setEncoder('libx264')}
              disabled={phase === 'running'}
              className={`py-2 rounded text-sm border ${
                encoder === 'libx264'
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-panel2 text-muted hover:text-white'
              }`}
            >
              libx264 (precise)
            </button>
          </div>
        </div>

        <div>
          <div className="text-sm mb-1">Output</div>
          <div className="text-xs text-muted font-mono break-all">~/Movies/FocuClone/</div>
        </div>
      </section>

      <section className="mt-6 bg-panel rounded-lg border border-panel2 p-5">
        {phase === 'idle' && (
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted">Ready to export.</div>
            <div className="flex gap-2">
              <button
                onClick={() => goto('editor')}
                className="px-4 py-2 rounded-md text-sm border border-panel2 hover:bg-panel2"
              >
                Back
              </button>
              <button
                onClick={startExport}
                className="px-5 py-2 rounded-md bg-accent text-black font-medium text-sm"
              >
                Start Export
              </button>
            </div>
          </div>
        )}

        {phase === 'running' && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm">Encoding…</span>
              <span className="text-sm font-mono">{progress.toFixed(0)}%</span>
            </div>
            <div className="h-2 bg-panel2 rounded overflow-hidden">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${Math.min(100, progress)}%` }}
              />
            </div>
            <p className="text-xs text-muted mt-3">
              FFmpeg with zoompan is slow — expect ~2× realtime. VideoToolbox helps a lot.
            </p>
          </div>
        )}

        {phase === 'done' && (
          <div>
            <div className="text-green-400 mb-3">✓ Export complete</div>
            <div className="text-xs text-muted font-mono break-all mb-4">
              {exportResult?.outputPath}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => window.electronAPI.openInFinder(exportResult.outputPath)}
                className="px-4 py-2 rounded-md text-sm border border-panel2 hover:bg-panel2"
              >
                Open in Finder
              </button>
              <button
                onClick={() => {
                  reset()
                  goto('home')
                }}
                className="px-5 py-2 rounded-md bg-accent text-black font-medium text-sm"
              >
                Record again
              </button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div>
            <div className="text-red-400 mb-2">Export failed</div>
            <div className="text-xs text-red-300/80 font-mono whitespace-pre-wrap break-all mb-3">
              {exportResult?.error}
            </div>
            <button
              onClick={() => setPhase('idle')}
              className="px-4 py-2 rounded-md text-sm border border-panel2"
            >
              Try again
            </button>
          </div>
        )}
      </section>

      {logTail && (phase === 'running' || phase === 'error') && (
        <details className="mt-4 text-xs">
          <summary className="text-muted cursor-pointer">FFmpeg output</summary>
          <pre className="mt-2 p-3 bg-black rounded text-muted/70 max-h-40 overflow-auto whitespace-pre-wrap">
            {logTail}
          </pre>
        </details>
      )}
    </div>
  )
}
