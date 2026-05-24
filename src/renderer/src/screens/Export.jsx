import React, { useEffect, useRef, useState } from 'react'
import { useSession } from '../store/useSession.js'
import { findBackground, aspectRatioOf } from '../lib/backgrounds.js'
import {
  rasterizeCursor,
  rasterizeRoundedMask,
  rasterizeAnnotation,
  rasterizeClickEffect
} from '../lib/rasterize.js'
import { DEFAULT_FADE_MS, DEFAULT_BLUR_RADIUS } from '../lib/annotations.js'

const QUALITY_PRESETS = [
  { key: 'high',   name: 'High',   crf: 18, sub: 'CRF 18',  size: '~ Large',  best: 'Editing master' },
  { key: 'medium', name: 'Medium', crf: 23, sub: 'CRF 23',  size: '~ Balanced', best: 'Sharing online' },
  { key: 'small',  name: 'Small',  crf: 28, sub: 'CRF 28',  size: '~ Small',  best: 'Quick reviews' }
]

export default function Export() {
  const session = useSession((s) => s.session)
  const exportSettings = useSession((s) => s.exportSettings)
  const zooms = useSession((s) => s.zooms)
  const annotations = useSession((s) => s.annotations)
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
  // Default-open so users can see what FFmpeg is doing without hunting for
  // the toggle. They can still hide it manually.
  const [showLogs, setShowLogs] = useState(true)

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
    const preset = QUALITY_PRESETS.find((p) => p.key === qualityKey)

    let cursorPngPath = null
    let roundedMaskPngPath = null
    let roundedMaskW = 0
    let roundedMaskH = 0
    try {
      const cursorBuf = await rasterizeCursor(exportSettings.cursorStyle, 4)
      const cur = await window.electronAPI.saveTempAsset(
        `cursor-${exportSettings.cursorStyle}-${Date.now()}.png`,
        cursorBuf
      )
      cursorPngPath = cur.path
    } catch (err) {
      console.warn('cursor rasterize failed', err)
    }
    if (exportSettings.roundness > 0) {
      try {
        // Mirror the processor's canvas/inset math so the mask we rasterize
        // matches the actual inner-clip rectangle pixel-for-pixel. Using a
        // canonical 1920-wide canvas as the reference; processor scales it
        // down to whatever inner size the export ends up with — proportional
        // scale leaves the radius/short-side ratio intact.
        const sourceAspect =
          session.screenW && session.screenH
            ? session.screenW / session.screenH
            : 16 / 9
        const targetAspect = aspectRatioOf(exportSettings.canvasAspect, sourceAspect)
        const canvasW = 1920
        const canvasH = Math.round(canvasW / targetAspect)
        const padPx =
          (Math.min(canvasW, canvasH) * (exportSettings.padding || 0)) / 100
        const availW = canvasW - 2 * padPx
        const availH = canvasH - 2 * padPx
        let innerW, innerH
        if (availW / availH > sourceAspect) {
          innerH = availH
          innerW = innerH * sourceAspect
        } else {
          innerW = availW
          innerH = innerW / sourceAspect
        }
        innerW = Math.round(innerW)
        innerH = Math.round(innerH)
        const insetShort = Math.min(innerW, innerH)
        const baseR = Math.max(
          0,
          Math.min(insetShort / 2, Math.round((exportSettings.roundness / 100) * insetShort))
        )
        const maskBuf = await rasterizeRoundedMask(innerW, innerH, baseR)
        const m = await window.electronAPI.saveTempAsset(
          `mask-rounded-${innerW}x${innerH}-${baseR}-${Date.now()}.png`,
          maskBuf
        )
        roundedMaskPngPath = m.path
        roundedMaskW = innerW
        roundedMaskH = innerH
      } catch (err) {
        console.warn('rounded mask rasterize failed', err)
      }
    }

    // Rasterize each annotation (text + shape) to a PNG sized to its target
    // pixel footprint inside the inner clip, then ship paths + geometry +
    // time windows to the processor. Mask annotations (blur/spotlight) are
    // sent through unrasterized — FFmpeg handles those directly with
    // boxblur / drawbox so the blur is *of the underlying video*, not a
    // pre-baked picture.
    const sourceAspect =
      session.screenW && session.screenH ? session.screenW / session.screenH : 16 / 9
    const targetAspect = aspectRatioOf(exportSettings.canvasAspect, sourceAspect)
    // Rasterize annotations against a canonical 1920-wide reference rather
    // than session.screenW: on Retina captures the recorded video can be at
    // native pixels (e.g. 2880×1800) while screenW reports the logical CSS
    // size (1440×900). Sizing the PNG to screen px and then asking FFmpeg to
    // scale up to W×H produced soft/blurry text. A fixed 1920 reference keeps
    // PNGs sharp and proportional, and FFmpeg's lanczos downscale handles the
    // size change cleanly in either direction.
    const refW = 1920
    const refH = Math.round(refW / sourceAspect)
    const annotationsForExport = []
    for (const ann of annotations || []) {
      try {
        // Blur + magnifier masks operate on the underlying pixels — overlays
        // can't see those, so processor.js handles both via FFmpeg
        // filter primitives (boxblur + crop+scale, respectively).
        if (ann.kind === 'mask' && ann.maskId === 'blur') {
          annotationsForExport.push({
            kind: 'mask',
            maskId: 'blur',
            x: ann.x, y: ann.y, w: ann.w, h: ann.h,
            blurRadius: ann.blurRadius ?? DEFAULT_BLUR_RADIUS,
            start: ann.start, end: ann.end,
            fadeInMs: ann.fadeInMs ?? DEFAULT_FADE_MS,
            fadeOutMs: ann.fadeOutMs ?? DEFAULT_FADE_MS
          })
          continue
        }
        if (ann.kind === 'mask' && ann.maskId === 'magnifier') {
          annotationsForExport.push({
            kind: 'mask',
            maskId: 'magnifier',
            x: ann.x, y: ann.y, w: ann.w, h: ann.h,
            magnifierZoom: ann.magnifierZoom ?? 2.2,
            start: ann.start, end: ann.end,
            fadeInMs: ann.fadeInMs ?? DEFAULT_FADE_MS,
            fadeOutMs: ann.fadeOutMs ?? DEFAULT_FADE_MS
          })
          continue
        }

        const rast = await rasterizeAnnotation(ann, refW, refH)
        if (!rast) continue
        const saved = await window.electronAPI.saveTempAsset(
          `ann-${ann.id}-${Date.now()}.png`,
          rast.buffer
        )
        annotationsForExport.push({
          kind: ann.kind === 'mask' ? 'overlay' : ann.kind,
          pngPath: saved.path,
          // `fullFrame` overlays cover the whole inner stream (spotlight);
          // others are positioned at the annotation's center. The `pad`
          // value is the drop-shadow margin we baked around the PNG — the
          // processor offsets the overlay by -pad so the shape sits where
          // the user placed it (not the shadow rim).
          fullFrame: !!rast.fullFrame,
          x: ann.x,
          y: ann.y,
          w: ann.w,
          h: ann.h,
          pad: rast.pad || 0,
          pngW: rast.w,
          pngH: rast.h,
          start: ann.start,
          end: ann.end,
          fadeInMs: ann.fadeInMs ?? DEFAULT_FADE_MS,
          fadeOutMs: ann.fadeOutMs ?? DEFAULT_FADE_MS
        })
      } catch (err) {
        console.warn('annotation rasterize failed', ann, err)
      }
    }

    // Click effects: render one PNG per effect kind and ship the click
    // timestamps. The processor expands these into per-click overlays with
    // a short fade-in / scale-up window so the export shows the same pulses
    // the editor's rAF loop draws during preview.
    let clickEffectsForExport = null
    if (exportSettings.clickEffect && exportSettings.clickEffect !== 'none') {
      try {
        const eff = await rasterizeClickEffect(exportSettings.clickEffect, 240)
        if (eff) {
          const saved = await window.electronAPI.saveTempAsset(
            `click-${exportSettings.clickEffect}-${Date.now()}.png`,
            eff.buffer
          )
          // Normalize click positions to [0..1] using the session's
          // screen size so processor.js doesn't need source dims.
          const clickPoints = (session.events || [])
            .filter((e) => e.type === 'click')
            .map((e) => ({
              t: e.timestamp,
              x: session.screenW ? e.x / session.screenW : 0.5,
              y: session.screenH ? e.y / session.screenH : 0.5
            }))
          clickEffectsForExport = {
            kind: exportSettings.clickEffect,
            pngPath: saved.path,
            pngW: eff.w,
            pngH: eff.h,
            // Effect duration in ms. Matches the preview's 700 ms pulse.
            durMs: 700,
            // Visible size as fraction of canvas shorter side.
            sizeFrac: exportSettings.clickEffect === 'spotlight' ? 0.5 : 0.18,
            clicks: clickPoints
          }
        }
      } catch (err) {
        console.warn('click effect rasterize failed', err)
      }
    }

    const opts = {
      ...exportSettings,
      quality: preset.crf,
      useVideoToolbox: encoder === 'videotoolbox',
      bgFfmpeg: bg.ffmpeg,
      canvasAspectRatio: targetAspect,
      cursorPngPath,
      roundedMaskPngPath,
      roundedMaskW,
      roundedMaskH,
      annotations: annotationsForExport,
      clickEffects: clickEffectsForExport,
      zooms,
      trim
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

  const stages = ['Prepare', 'Render', 'Encode', 'Finalize']
  const stageIdx = Math.min(stages.length - 1, Math.floor((progress / 100) * stages.length))

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ background: 'var(--bg-1)' }}>
      <div
        className="flex-1 overflow-y-auto"
        style={{ padding: '32px 40px' }}
      >
        <div className="max-w-3xl mx-auto w-full">
          {phase === 'idle' && (
            <>
              <div className="flex justify-between items-start" style={{ marginBottom: 28 }}>
                <div>
                  <h1 className="text-[22px] font-semibold tracking-tight m-0">Export</h1>
                  <p className="m-0 mt-1 text-[13px]" style={{ color: 'var(--fg-2)' }}>
                    FFmpeg will apply zoom-on-click and render to MP4.
                  </p>
                </div>
                <span className="pill pill-acc">
                  <span className="dot" />Ready
                </span>
              </div>

              {session.mouseTrackerAvailable === false && (
                <div className="alert alert-warn" style={{ marginBottom: 20 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M12 3l9 16H3l9-16z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                    <path d="M12 10v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <div>
                    <div className="alert-title">No clicks or keystrokes were captured</div>
                    <div className="alert-sub">
                      The mouse-tracker hook wasn't available during this recording, so
                      auto-zoom, cursor follow, and keystroke overlays will be missing
                      from the export. Grant Accessibility permission and re-record to
                      enable these effects.
                    </div>
                  </div>
                </div>
              )}

              <section style={{ marginBottom: 24 }}>
                <div className="label-eyebrow" style={{ display: 'block', marginBottom: 10 }}>Quality</div>
                <div className="grid grid-cols-3 gap-3">
                  {QUALITY_PRESETS.map((p) => (
                    <button
                      key={p.key}
                      onClick={() => setQualityKey(p.key)}
                      className={`preset-card ${qualityKey === p.key ? 'on' : ''}`}
                    >
                      <div className="preset-head">
                        <span className="preset-name">{p.name}</span>
                        {qualityKey === p.key && (
                          <span className="preset-check">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                              <path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3"
                                    strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </span>
                        )}
                      </div>
                      <div className="preset-sub">{p.sub}</div>
                      <div className="preset-meta">
                        <span style={{ color: 'var(--fg-1)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                          {p.size}
                        </span>
                        <span style={{ color: 'var(--fg-3)' }}>{p.best}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>

              <section style={{ marginBottom: 24 }}>
                <div className="label-eyebrow" style={{ display: 'block', marginBottom: 10 }}>Encoder</div>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setEncoder('videotoolbox')}
                    className={`preset-card ${encoder === 'videotoolbox' ? 'on' : ''}`}
                  >
                    <div className="preset-head">
                      <span className="preset-name">VideoToolbox</span>
                      {encoder === 'videotoolbox' && (
                        <span className="preset-check">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                            <path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3"
                                  strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                      )}
                    </div>
                    <div className="preset-sub">Hardware · fast</div>
                  </button>
                  <button
                    onClick={() => setEncoder('libx264')}
                    className={`preset-card ${encoder === 'libx264' ? 'on' : ''}`}
                  >
                    <div className="preset-head">
                      <span className="preset-name">libx264</span>
                      {encoder === 'libx264' && (
                        <span className="preset-check">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                            <path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3"
                                  strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                      )}
                    </div>
                    <div className="preset-sub">Software · precise</div>
                  </button>
                </div>
              </section>

              <section style={{ marginBottom: 24 }}>
                <div className="label-eyebrow" style={{ display: 'block', marginBottom: 10 }}>Output</div>
                <div
                  className="flex items-center gap-2.5"
                  style={{
                    padding: '10px 12px',
                    background: 'var(--bg-2)',
                    border: '1px solid var(--line-2)',
                    borderRadius: 8,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    color: 'var(--fg-2)'
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--fg-3)' }}>
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
                          stroke="currentColor" strokeWidth="1.6" />
                  </svg>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    ~/Movies/FocuClone/
                  </span>
                </div>
              </section>

              <div className="flex gap-3" style={{ paddingTop: 12 }}>
                <button className="btn btn-ghost" onClick={() => goto('editor')}>
                  ← Back
                </button>
                <button className="btn btn-primary btn-lg" onClick={startExport}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path d="M12 3v12m0 0l-5-5m5 5l5-5M4 21h16" stroke="currentColor" strokeWidth="2"
                          strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Start Export
                </button>
              </div>
            </>
          )}

          {phase === 'running' && (
            <div className="flex items-center justify-center" style={{ minHeight: 480 }}>
              <div
                className="flex flex-col items-center gap-3.5 text-center"
                style={{
                  width: 540, padding: '36px 32px',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line-2)',
                  borderRadius: 16
                }}
              >
                <div className="spinner" />
                <div style={{ font: '600 10px var(--font-ui)', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--acc)' }}>
                  Exporting
                </div>
                <div style={{ font: '600 20px var(--font-ui)', letterSpacing: '-0.01em' }}>
                  Rendering your masterpiece
                </div>
                <div className="font-mono text-[12px]" style={{ color: 'var(--fg-2)' }}>
                  {progress.toFixed(0)}% · stage {stageIdx + 1} of {stages.length}
                </div>

                <div className="progress-track" style={{ marginTop: 4 }}>
                  <div className="progress-fill" style={{ width: `${Math.min(100, progress)}%` }} />
                </div>

                <div className="flex gap-2 mt-2">
                  {stages.map((s, i) => (
                    <span
                      key={s}
                      className="flex items-center gap-1.5"
                      style={{
                        padding: '5px 10px',
                        borderRadius: 999,
                        background:
                          i < stageIdx ? 'rgba(52,211,153,0.12)'
                          : i === stageIdx ? 'var(--acc-soft)'
                          : 'var(--bg-3)',
                        border: `1px solid ${
                          i < stageIdx ? 'rgba(52,211,153,0.3)'
                          : i === stageIdx ? 'var(--acc)'
                          : 'var(--line-2)'
                        }`,
                        color:
                          i < stageIdx ? 'var(--ok)'
                          : i === stageIdx ? 'var(--acc-hi)'
                          : 'var(--fg-3)',
                        font: '500 11px var(--font-ui)'
                      }}
                    >
                      {i < stageIdx ? '✓' : i + 1} {s}
                    </span>
                  ))}
                </div>

                <button
                  className="btn btn-quiet btn-sm mt-1"
                  onClick={() => setShowLogs((v) => !v)}
                >
                  {showLogs ? 'Hide logs' : 'Show logs'}
                </button>
                {showLogs && logTail && (
                  <pre
                    className="w-full font-mono text-[11px] text-left"
                    style={{
                      maxHeight: 160, overflowY: 'auto',
                      background: '#060709',
                      border: '1px solid var(--line-2)',
                      borderRadius: 8,
                      padding: '12px 14px',
                      color: 'var(--fg-2)',
                      whiteSpace: 'pre',
                      lineHeight: 1.6
                    }}
                  >{logTail}</pre>
                )}
              </div>
            </div>
          )}

          {phase === 'done' && (
            <div className="flex items-center justify-center" style={{ minHeight: 480 }}>
              <div
                className="flex flex-col items-center gap-3.5 text-center"
                style={{
                  width: 540, padding: '36px 32px',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line-2)',
                  borderRadius: 16
                }}
              >
                <span className="success-burst">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.5"
                          strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div style={{ font: '600 10px var(--font-ui)', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ok)' }}>
                  Export complete
                </div>
                <div style={{ font: '600 20px var(--font-ui)', letterSpacing: '-0.01em' }}>
                  Saved to your Movies folder
                </div>
                <div className="font-mono text-[12px] break-all" style={{ color: 'var(--fg-2)' }}>
                  {exportResult?.outputPath}
                </div>
                <div className="flex gap-2.5 mt-2">
                  <button
                    className="btn btn-ghost"
                    onClick={() => window.electronAPI.openInFinder(exportResult.outputPath)}
                  >
                    Open in Finder
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => { reset(); goto('home') }}
                  >
                    Record again
                  </button>
                </div>
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="flex items-center justify-center" style={{ minHeight: 480 }}>
              <div
                className="flex flex-col items-center gap-3.5 text-center"
                style={{
                  width: 540, padding: '36px 32px',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line-2)',
                  borderRadius: 16
                }}
              >
                <span className="error-burst">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5"
                          strokeLinecap="round" />
                  </svg>
                </span>
                <div style={{ font: '600 10px var(--font-ui)', letterSpacing: '0.1em', textTransform: 'uppercase', color: '#FF8484' }}>
                  Export failed
                </div>
                <div style={{ font: '600 20px var(--font-ui)', letterSpacing: '-0.01em' }}>
                  Something went wrong
                </div>
                <pre
                  className="w-full font-mono text-[11px] text-left whitespace-pre-wrap break-all"
                  style={{
                    maxHeight: 160, overflowY: 'auto',
                    background: '#060709',
                    border: '1px solid var(--line-2)',
                    borderRadius: 8,
                    padding: '12px 14px',
                    color: '#FFB4B4',
                    lineHeight: 1.6
                  }}
                >
                  {exportResult?.error}
                </pre>
                <div className="flex gap-2.5 mt-2">
                  <button className="btn btn-ghost" onClick={() => goto('editor')}>← Back to Edit</button>
                  <button className="btn btn-primary" onClick={() => setPhase('idle')}>Try again</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
