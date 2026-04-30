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

      // Open the webcam stream now (before kicking off the screen recorder)
      // so both pipelines start within a few ms of each other.
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

      // Webcam recorder runs in parallel with the screen recorder. We pick a
      // lower bitrate since the PiP target is small.
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
      try {
        recorderRef.current.stop()
      } catch {}
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
    goto('home')
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 flex items-center justify-center p-6 bg-black/40 relative">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="max-w-full max-h-full rounded-lg shadow-2xl"
        />
        {phase === 'countdown' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <div className="text-9xl font-bold text-white">{countdown}</div>
          </div>
        )}
        {phase === 'recording' && (
          <div className="absolute top-6 left-6 flex items-center gap-2 bg-black/70 px-3 py-1.5 rounded-full">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-sm font-mono">{formatTime(elapsedMs)}</span>
          </div>
        )}
      </div>

      <footer className="border-t border-panel2 bg-panel p-4">
        {error && (
          <div className="mb-3 text-red-400 text-sm bg-red-500/10 px-3 py-2 rounded">
            {error}
          </div>
        )}
        {!hookAvailable && phase === 'recording' && (
          <div className="mb-3 text-yellow-400 text-sm bg-yellow-500/10 px-3 py-2 rounded">
            Mouse tracker hook unavailable — recording will work but auto-zoom will have no clicks to follow.
          </div>
        )}
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted">
            Source: <span className="text-white">{source?.name || '—'}</span>
            {micEnabled && <span className="ml-3 text-accent">● mic</span>}
          </div>
          <div className="flex gap-2">
            {phase === 'idle' && (
              <>
                <button
                  onClick={() => goto('home')}
                  className="px-4 py-2 rounded-md text-sm border border-panel2 hover:bg-panel2"
                >
                  Back
                </button>
                <button
                  onClick={beginCountdown}
                  className="px-5 py-2 rounded-md bg-accent text-black font-medium text-sm"
                >
                  Start Recording
                </button>
              </>
            )}
            {phase === 'countdown' && (
              <button
                onClick={() => setPhase('idle')}
                className="px-4 py-2 rounded-md text-sm border border-panel2"
              >
                Cancel
              </button>
            )}
            {phase === 'recording' && (
              <>
                <button
                  onClick={cancelRecording}
                  className="px-4 py-2 rounded-md text-sm border border-panel2 hover:bg-panel2"
                >
                  Discard
                </button>
                <button
                  onClick={stopRecording}
                  className="px-5 py-2 rounded-md bg-red-500 text-white font-medium text-sm"
                >
                  Stop
                </button>
              </>
            )}
            {phase === 'stopping' && (
              <span className="text-sm text-muted">Finalising…</span>
            )}
          </div>
        </div>
      </footer>
    </div>
  )
}

function formatTime(ms) {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
