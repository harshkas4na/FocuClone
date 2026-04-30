import React, { useEffect, useRef, useState } from 'react'
import { useSession } from '../store/useSession.js'

export default function Recorder() {
  const source = useSession((s) => s.source)
  const micEnabled = useSession((s) => s.micEnabled)
  const micDeviceId = useSession((s) => s.micDeviceId)
  const cameraEnabled = useSession((s) => s.cameraEnabled)
  const cameraDeviceId = useSession((s) => s.cameraDeviceId)
  const goto = useSession((s) => s.goto)
  const setSession = useSession((s) => s.setSession)

  const videoRef = useRef(null)
  const recorderRef = useRef(null)
  const previewStreamRef = useRef(null)
  const webcamRecorderRef = useRef(null)
  const webcamStreamRef = useRef(null)

  const [phase, setPhase] = useState('idle') // idle | countdown | recording | stopping
  const [elapsedMs, setElapsedMs] = useState(0)
  const [countdown, setCountdown] = useState(3)
  const [error, setError] = useState(null)
  const [hookAvailable, setHookAvailable] = useState(true)
  const [showDiscardModal, setShowDiscardModal] = useState(false)
  const startedAtRef = useRef(0)
  const elapsedTimerRef = useRef(null)

  useEffect(() => {
    if (!source) {
      goto('home')
      return
    }
    let cancelled = false
    async function preview() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: source.id,
              minWidth: 640,
              maxWidth: 1920,
              minHeight: 360,
              maxHeight: 1080
            }
          }
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        previewStreamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().catch(() => {})
        }
      } catch (err) {
        console.error('preview error', err)
        setError(err.message || 'Failed to access source')
      }
    }
    preview()
    return () => {
      cancelled = true
      if (previewStreamRef.current) {
        previewStreamRef.current.getTracks().forEach((t) => t.stop())
        previewStreamRef.current = null
      }
    }
  }, [source])

  useEffect(() => {
    if (phase !== 'recording') return
    elapsedTimerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current)
    }, 100)
    return () => clearInterval(elapsedTimerRef.current)
  }, [phase])

  async function beginCountdown() {
    setPhase('countdown')
    setCountdown(3)
    for (let i = 3; i >= 1; i--) {
      setCountdown(i)
      await new Promise((r) => setTimeout(r, 800))
    }
    await startRecording()
  }

  async function startRecording() {
    setError(null)
    try {
      const screenInfo = await window.electronAPI.getScreenSize()
      const screenW = screenInfo.width * (screenInfo.scaleFactor || 1)
      const screenH = screenInfo.height * (screenInfo.scaleFactor || 1)

      const captureStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
            minWidth: 1280,
            maxWidth: 3840,
            minHeight: 720,
            maxHeight: 2160,
            maxFrameRate: 60
          }
        }
      })

      let micStream = null
      if (micEnabled) {
        try {
          const audioConstraint =
            micDeviceId && micDeviceId !== 'default'
              ? { deviceId: { exact: micDeviceId } }
              : true
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraint,
            video: false
          })
        } catch (err) {
          console.warn('mic failed', err)
        }
      }

      const tracks = [...captureStream.getVideoTracks()]
      if (micStream) tracks.push(...micStream.getAudioTracks())
      const combined = new MediaStream(tracks)

      if (videoRef.current) {
        videoRef.current.srcObject = combined
      }

      let webcamStream = null
      if (cameraEnabled) {
        try {
          const camConstraint =
            cameraDeviceId && cameraDeviceId !== 'default'
              ? { deviceId: { exact: cameraDeviceId } }
              : true
          webcamStream = await navigator.mediaDevices.getUserMedia({
            video: camConstraint,
            audio: false
          })
          webcamStreamRef.current = webcamStream
        } catch (err) {
          console.warn('webcam failed', err)
          setError(`Camera failed: ${err.message || err}`)
        }
      }

      const init = await window.electronAPI.startRecording(
        source.id,
        { w: screenW, h: screenH },
        !!webcamStream
      )
      setHookAvailable(init.mouseTrackerAvailable)
      startedAtRef.current = init.recordStart

      const mimeCandidates = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm'
      ]
      let mimeType = ''
      for (const m of mimeCandidates) {
        if (MediaRecorder.isTypeSupported(m)) {
          mimeType = m
          break
        }
      }

      const recorder = new MediaRecorder(combined, {
        mimeType,
        videoBitsPerSecond: 8_000_000
      })
      recorder.ondataavailable = async (e) => {
        if (!e.data || e.data.size === 0) return
        const buf = await e.data.arrayBuffer()
        try {
          await window.electronAPI.writeChunk(buf)
        } catch (err) {
          console.error('writeChunk failed', err)
        }
      }
      recorder.onstop = async () => {
        const result = await window.electronAPI.stopRecording()
        setSession({
          ...result,
          screenW,
          screenH,
          duration: result.duration
        })
        setPhase('idle')
        goto('editor')
      }
      recorder.start(250)
      recorderRef.current = recorder

      if (webcamStream) {
        const camRecorder = new MediaRecorder(webcamStream, {
          mimeType,
          videoBitsPerSecond: 2_000_000
        })
        camRecorder.ondataavailable = async (e) => {
          if (!e.data || e.data.size === 0) return
          const buf = await e.data.arrayBuffer()
          try {
            await window.electronAPI.writeWebcamChunk(buf)
          } catch (err) {
            console.error('writeWebcamChunk failed', err)
          }
        }
        camRecorder.start(250)
        webcamRecorderRef.current = camRecorder
      }

      setPhase('recording')
    } catch (err) {
      console.error('startRecording', err)
      setError(err.message || 'Failed to start recording')
      setPhase('idle')
    }
  }

  async function stopRecording() {
    if (!recorderRef.current) return
    setPhase('stopping')
    recorderRef.current.stop()
    if (webcamRecorderRef.current && webcamRecorderRef.current.state !== 'inactive') {
      try { webcamRecorderRef.current.stop() } catch {}
    }
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach((t) => t.stop())
      webcamStreamRef.current = null
    }
    if (videoRef.current?.srcObject) {
      videoRef.current.srcObject.getTracks().forEach((t) => t.stop())
    }
  }

  async function cancelRecording() {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop() } catch {}
    }
    if (webcamRecorderRef.current && webcamRecorderRef.current.state !== 'inactive') {
      try { webcamRecorderRef.current.stop() } catch {}
    }
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach((t) => t.stop())
      webcamStreamRef.current = null
    }
    if (videoRef.current?.srcObject) {
      videoRef.current.srcObject.getTracks().forEach((t) => t.stop())
    }
    await window.electronAPI.cancelRecording()
    setPhase('idle')
    setShowDiscardModal(false)
    goto('home')
  }

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ background: 'var(--bg-1)' }}>
      {/* Top bar */}
      <div
        className="flex items-center gap-4 flex-shrink-0"
        style={{
          height: 44, padding: '0 20px',
          borderBottom: '1px solid var(--line-1)'
        }}
      >
        <div
          className="flex items-center gap-2"
          style={{
            padding: '5px 10px', background: 'var(--bg-2)',
            border: '1px solid var(--line-2)', borderRadius: 999, fontSize: 12
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--fg-2)' }}>
            <rect x="3" y="5" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          <span className="font-medium" style={{ color: 'var(--fg-1)' }}>
            {source?.name || '—'}
          </span>
        </div>
        {micEnabled && <span className="pill pill-acc"><span className="dot" />MIC</span>}
        {cameraEnabled && <span className="pill pill-acc"><span className="dot" />CAM</span>}
        <div className="ml-auto flex gap-1.5">
          {phase === 'idle' && (
            <button className="btn btn-quiet btn-sm" onClick={() => goto('home')}>
              ← Back
            </button>
          )}
        </div>
      </div>

      {/* State bar (errors / warnings) */}
      {(error || (!hookAvailable && phase === 'recording')) && (
        <div
          className="flex flex-col gap-2"
          style={{
            padding: '10px 20px',
            borderBottom: '1px solid var(--line-1)',
            background: 'var(--bg-1)'
          }}
        >
          {error && (
            <div className="alert alert-err">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                <path d="M12 8v5M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <div>
                <div className="alert-title">Recording error</div>
                <div className="alert-sub">{error}</div>
              </div>
            </div>
          )}
          {!hookAvailable && phase === 'recording' && (
            <div className="alert alert-warn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 3l9 16H3l9-16z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                <path d="M12 10v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <div>
                <div className="alert-title">Mouse tracker hook unavailable</div>
                <div className="alert-sub">
                  Recording will work but auto-zoom will have no clicks to follow.
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stage */}
      <div
        className="flex-1 flex flex-col min-h-0"
        style={{ padding: 24, gap: 20 }}
      >
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="rec-preview">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="absolute inset-0 w-full h-full object-contain"
            />
            {phase === 'countdown' && (
              <div className="rec-countdown">
                <div className="cd-num" key={countdown}>{countdown}</div>
                <div className="cd-sub">Get ready</div>
              </div>
            )}
            {phase === 'recording' && (
              <>
                <div className="rec-border" />
                <div
                  className="absolute top-4 left-4 flex items-center gap-2"
                  style={{
                    padding: '5px 10px', background: 'rgba(0,0,0,0.6)',
                    borderRadius: 999, backdropFilter: 'blur(8px)'
                  }}
                >
                  <span className="pill pill-rec" style={{ height: 'auto', padding: 0, background: 'transparent', border: 0 }}>
                    <span className="dot" />REC
                  </span>
                  <span className="font-mono text-[12px]" style={{ color: '#fff' }}>
                    {formatTime(elapsedMs)}
                  </span>
                </div>
              </>
            )}
            {phase === 'stopping' && (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center gap-3.5 text-white font-medium"
                style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(10px)', zIndex: 4 }}
              >
                <div className="spinner" />
                <div>Finalizing recording…</div>
              </div>
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="flex-shrink-0 flex flex-col items-center gap-3" style={{ minHeight: 80 }}>
          {phase === 'idle' && (
            <>
              <button className="rec-cta" onClick={beginCountdown}>
                <span className="rec-cta-ring">
                  <span className="rec-cta-dot" />
                </span>
                <span className="rec-cta-label">Start Recording</span>
                <span
                  className="font-mono"
                  style={{
                    fontSize: 11, padding: '3px 8px',
                    background: 'var(--bg-3)', borderRadius: 6,
                    color: 'var(--fg-3)', border: '1px solid var(--line-2)'
                  }}
                >⇧⌘R</span>
              </button>
              <div className="text-[12px]" style={{ color: 'var(--fg-3)' }}>
                A 3-second countdown will give you time to focus.
              </div>
            </>
          )}
          {phase === 'countdown' && (
            <button className="btn btn-ghost" onClick={() => setPhase('idle')}>
              Cancel countdown
            </button>
          )}
          {phase === 'recording' && (
            <div className="flex items-center gap-3.5">
              <button className="rec-stop-cta" onClick={stopRecording}>
                <span className="rec-stop-ico">
                  <span style={{ width: 14, height: 14, background: '#fff', borderRadius: 2 }} />
                </span>
                Stop Recording
              </button>
              <button
                className="btn btn-danger"
                onClick={() => setShowDiscardModal(true)}
              >
                Discard
              </button>
              <div className="rec-elapsed">
                <div className="rec-elapsed-num">{formatTime(elapsedMs)}</div>
                <div className="rec-elapsed-lbl">Elapsed</div>
              </div>
            </div>
          )}
          {phase === 'stopping' && (
            <div className="text-[13px]" style={{ color: 'var(--fg-2)' }}>Finalising…</div>
          )}
        </div>
      </div>

      {showDiscardModal && (
        <div className="modal-scrim" onClick={() => setShowDiscardModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-icon danger">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6"
                      stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <div className="modal-title">Discard recording?</div>
            <p className="modal-body">
              This will stop and delete the current recording. You can't undo this.
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowDiscardModal(false)}>
                Keep recording
              </button>
              <button className="btn btn-danger" onClick={cancelRecording}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function formatTime(ms) {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
