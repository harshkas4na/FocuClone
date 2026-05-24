import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../store/useSession.js'
import Timeline from '../components/Timeline.jsx'
import {
  zoomsFromEvents,
  makeManualZoom,
  shiftZoom,
  recomputeZoomTimings,
  sampleZoomFromZooms,
  activeZoomAt,
  decimateMoves,
  sampleMouseAt
} from '../lib/zoomTimeline.js'
import { sampleCameraTarget } from '../lib/cameraTrack.js'
import {
  createSpring,
  resetSpring,
  stepSpring,
  ZOOM_SPRING,
  CENTER_SPRING,
  CURSOR_SPRING
} from '../lib/motionSmoothing.js'
import { BACKGROUNDS, BACKGROUND_CATEGORIES, findBackground, CANVAS_ASPECTS, aspectRatioOf } from '../lib/backgrounds.js'
import { CURSOR_STYLES, CURSOR_FAMILIES, findCursorStyle, CLICK_EFFECTS } from '../lib/cursors.js'
import {
  defaultGeometryFor,
  defaultColorFor,
  defaultDurationMsFor,
  DEFAULT_FADE_MS,
  DEFAULT_BLUR_RADIUS,
  DEFAULT_SPOTLIGHT_DARKNESS,
  DEFAULT_MAGNIFIER_ZOOM,
  TEXT_STYLE_DEFS as TEXT_DEFS_DATA,
  SHAPE_DEFS as SHAPE_DEFS_DATA
} from '../lib/annotations.js'

const PANELS = [
  { id: 'background', label: 'Background', icon: 'bg' },
  { id: 'cursor', label: 'Cursor', icon: 'cursor' },
  { id: 'annotations', label: 'Annotations', icon: 'pen' },
  { id: 'camera', label: 'Camera', icon: 'cam' },
  { id: 'audio', label: 'Audio', icon: 'audio' },
  { id: 'keyboard', label: 'Keyboard', icon: 'kbd' },
  { id: 'watermark', label: 'Watermark', icon: 'wm' }
]

const ANNOTATION_TEXT_STYLES = [
  { id: 'plain', label: 'Plain', preview: 'Text', cls: 'text-white' },
  { id: 'pill', label: 'Pill', preview: 'Text', cls: 'bg-black text-white px-3 py-1 rounded-full' },
  { id: 'bubble', label: 'Bubble', preview: 'Text', cls: 'bg-violet-500 text-white px-3 py-1 rounded-md shadow-lg' },
  { id: 'glass', label: 'Glass', preview: 'Text', cls: 'bg-white/15 backdrop-blur-md text-white px-3 py-1 rounded-md border border-white/20' },
  { id: 'outline', label: 'Outline', preview: 'Text', cls: 'border-2 border-pink-500 text-white px-3 py-1 rounded-md' },
  { id: 'badge', label: 'Badge', preview: '1', cls: 'bg-lime-300 text-black w-8 h-8 rounded-full flex items-center justify-center font-bold' },
  { id: 'counter', label: 'Counter', preview: '1', cls: 'bg-yellow-300 text-black w-8 h-8 rounded-full flex items-center justify-center font-bold' }
]

const ANNOTATION_SHAPES = [
  { id: 'line', label: 'Line' },
  { id: 'arrow', label: 'Arrow' },
  { id: 'box', label: 'Box' },
  { id: 'box-rounded', label: 'Rounded box' },
  { id: 'circle', label: 'Circle' },
  { id: 'arrow-down', label: 'Down arrow' }
]

const ANNOTATION_MASKS = [
  { id: 'spotlight', label: 'Spotlight' },
  { id: 'blur', label: 'Blur' },
  { id: 'magnifier', label: 'Magnifier' }
]

export default function Editor() {
  const session = useSession((s) => s.session)
  const goto = useSession((s) => s.goto)
  const reset = useSession((s) => s.reset)
  const exportSettings = useSession((s) => s.exportSettings)
  const updateExportSettings = useSession((s) => s.updateExportSettings)
  const zooms = useSession((s) => s.zooms)
  const setZooms = useSession((s) => s.setZooms)
  const selectedZoomId = useSession((s) => s.selectedZoomId)
  const selectZoom = useSession((s) => s.selectZoom)
  const addZoomAction = useSession((s) => s.addZoom)
  const removeZoom = useSession((s) => s.removeZoom)
  const updateZoom = useSession((s) => s.updateZoom)
  const trim = useSession((s) => s.trim)
  const setTrim = useSession((s) => s.setTrim)
  const undo = useSession((s) => s.undo)
  const redo = useSession((s) => s.redo)
  const canUndo = useSession((s) => s.past.length > 0)
  const canRedo = useSession((s) => s.future.length > 0)
  const annotations = useSession((s) => s.annotations)
  const addAnnotation = useSession((s) => s.addAnnotation)
  const removeAnnotation = useSession((s) => s.removeAnnotation)
  const updateAnnotation = useSession((s) => s.updateAnnotation)
  const selectedAnnotationId = useSession((s) => s.selectedAnnotationId)
  const selectAnnotation = useSession((s) => s.selectAnnotation)
  const activePanel = useSession((s) => s.activePanel)
  const setActivePanel = useSession((s) => s.setActivePanel)

  const videoRef = useRef(null)
  const wrapperRef = useRef(null)
  const innerRef = useRef(null)
  const cursorOverlayRef = useRef(null)
  const rafRef = useRef(0)
  const currentMsRef = useRef(0)
  const lastClickIdxRef = useRef(-1)
  // Idle-frame counter — once the springs have settled and the video is
  // paused, we stop scheduling rAF until the user plays / scrubs / changes
  // anything. Prevents constant 60Hz spinning while the editor is idle.
  const idleFramesRef = useRef(0)
  // Stable refs so the rAF tick can pull the latest props without forcing the
  // effect that owns rAF to re-bind on every render. Re-binding was throwing
  // away spring velocity and chewing CPU during settings tweaks.
  const propsRef = useRef({
    session: null,
    zooms: [],
    decimated: [],
    clicks: [],
    exportSettings: null,
    previewEnabled: true
  })

  // Spring state for the live preview camera. Persisted across rAF ticks.
  // Reset on big time jumps (scrubs) so the camera snaps instead of dragging.
  const zoomSpringRef = useRef(createSpring(1))
  const cxSpringRef = useRef(createSpring(0.5))
  const cySpringRef = useRef(createSpring(0.5))
  // Cursor position spring — smooths the displayed pointer in viewport space
  // so it doesn't pixel-stair through the linear-interpolated sample grid.
  // Separate from the camera springs because the cursor and the camera
  // settle at different rates.
  const curXSpringRef = useRef(createSpring(0.5))
  const curYSpringRef = useRef(createSpring(0.5))
  const lastTickTimeRef = useRef(0)
  const lastTickMsRef = useRef(0)

  const [currentMs, setCurrentMs] = useState(0)
  const [durationMs, setDurationMs] = useState(session?.duration || 0)
  const [previewEnabled, setPreviewEnabled] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [centerPicking, setCenterPicking] = useState(false)
  const [pendingAnnotation, setPendingAnnotation] = useState(null) // { kind, ...spec }
  const [clickPulses, setClickPulses] = useState([]) // {id, xPct, yPct, kind, born}

  // Re-derive zooms whenever the session itself changes (id flips on every
  // new recording). Without keying on id, leftover zooms from a previous
  // session would persist for the next one, since `zooms.length` is non-zero
  // and the old logic short-circuited. That manifested as "I recorded again
  // and the auto-zooms from my last clip are still showing."
  useEffect(() => {
    if (!session) {
      goto('home')
      return
    }
    const initial = zoomsFromEvents(session.events || [], exportSettings)
    setZooms(initial)
    // We deliberately depend on session.id, not the whole session object —
    // re-running on every settings tweak would clobber user edits.
  }, [session?.id])

  const selectedZoom = useMemo(
    () => zooms.find((z) => z.id === selectedZoomId) || null,
    [zooms, selectedZoomId]
  )

  const decimated = useMemo(() => {
    if (!session) return []
    // Sample at 60 Hz with a 2 px threshold so slow drags don't get dropped.
    // The cursor spring downstream takes care of denoising any residual jitter;
    // a denser source path is much better than an over-decimated one with
    // visible polygonal corners.
    return decimateMoves(session.events || [], { cursorMoveSampleHz: 60, cursorMoveMinDeltaPx: 2 })
  }, [session])

  const events = session?.events || []
  const clicks = useMemo(() => events.filter((e) => e.type === 'click'), [events])
  const keyEvents = useMemo(() => events.filter((e) => e.type === 'key'), [events])
  const sourceAspect =
    session?.screenW && session?.screenH ? session.screenW / session.screenH : 16 / 9
  const canvasAspect = aspectRatioOf(exportSettings.canvasAspect, sourceAspect)
  const bg = findBackground(exportSettings.backgroundValue)

  // Keep the latest props in a ref so the rAF loop can read them without
  // re-binding on every change. Re-binding was costing 5-10ms per settings
  // tweak and destroying spring velocity state.
  propsRef.current = { session, zooms, decimated, clicks, exportSettings, previewEnabled }

  // rAF loop: zoom transform, cursor positioning, idle hide, and click-effect spawning.
  //
  // Camera = target curve (zoomTimeline) → spring smoother → CSS transform.
  // The cursor's viewport position runs through its own small spring so it
  // doesn't pixel-stair through the 30Hz cursor sample grid.
  //
  // When the video is paused AND the springs have settled, the loop stops
  // scheduling frames until something changes — saves ~5% CPU when idle.
  // Play / scrub / spring-disrupting events tick `idleFramesRef.current` back
  // up so the loop resumes for the settle window, then re-idles.
  function ensureLoop() {
    if (rafRef.current) return
    function tick() {
      rafRef.current = 0
      const {
        session: s,
        zooms: zs,
        decimated: dec,
        clicks: cls,
        exportSettings: es,
        previewEnabled: pe
      } = propsRef.current
      const v = videoRef.current
      const wrap = innerRef.current
      const curEl = cursorOverlayRef.current
      if (!v || !wrap || !s) {
        // Nothing to do; idle.
        return
      }
      const tMs = v.currentTime * 1000
      const now = performance.now()
      const dt = lastTickTimeRef.current ? now - lastTickTimeRef.current : 16.67
      lastTickTimeRef.current = now

      // Detect scrubs / pause-resume gaps and snap springs to target instead
      // of letting them drag through the whole jump.
      const tJump = Math.abs(tMs - lastTickMsRef.current) > 250
      lastTickMsRef.current = tMs
      const playing = !v.paused

      if (pe) {
        const target = sampleCameraTarget(zs, dec, tMs, {
          cursorFollowMode: es.cursorFollowMode,
          cursorFollowSafeZone: es.cursorFollowSafeZone,
          cursorFollowAmount: es.cursorFollowAmount
        })
        if (tJump) {
          resetSpring(zoomSpringRef.current, target.zoom)
          resetSpring(cxSpringRef.current, target.cx)
          resetSpring(cySpringRef.current, target.cy)
        }
        const zoom = stepSpring(zoomSpringRef.current, target.zoom, dt, ZOOM_SPRING)
        const cx = stepSpring(cxSpringRef.current, target.cx, dt, CENTER_SPRING)
        const cy = stepSpring(cySpringRef.current, target.cy, dt, CENTER_SPRING)

        v.style.transformOrigin = `${(cx * 100).toFixed(2)}% ${(cy * 100).toFixed(2)}%`
        v.style.transform = `scale(${zoom.toFixed(3)})`

        if (curEl) {
          const inZoom = activeZoomAt(zs, tMs) != null
          const showByZoom = es.hideCursorWhenIdle ? inZoom : true
          if (showByZoom && es.showCursor) {
            const useFollow = es.cursorFollowsMouse
            const { x: mx, y: my } = useFollow
              ? sampleMouseAt(dec, tMs, { x: cx, y: cy })
              : { x: cx, y: cy }
            // Viewport-space target: where the cursor sits inside the
            // zoomed frame [0..1]. Outside a zoom, this is just (mx, my).
            const oxTarget = inZoom ? (mx - cx) * zoom + 0.5 : mx
            const oyTarget = inZoom ? (my - cy) * zoom + 0.5 : my
            if (tJump) {
              resetSpring(curXSpringRef.current, oxTarget)
              resetSpring(curYSpringRef.current, oyTarget)
            }
            // A lighter spring for the cursor (fast snap, no wobble) — the
            // camera already smooths big motions, this just denoises the
            // 30Hz sample stairs.
            const ox = stepSpring(curXSpringRef.current, oxTarget, dt, CURSOR_SPRING)
            const oy = stepSpring(curYSpringRef.current, oyTarget, dt, CURSOR_SPRING)
            curEl.style.left = `${ox * 100}%`
            curEl.style.top = `${oy * 100}%`
            curEl.style.opacity = '1'
          } else {
            curEl.style.opacity = '0'
          }
        }
      } else {
        v.style.transform = 'none'
        if (curEl) curEl.style.opacity = '0'
        resetSpring(zoomSpringRef.current, 1)
        resetSpring(cxSpringRef.current, 0.5)
        resetSpring(cySpringRef.current, 0.5)
      }

      // Spawn click-effect pulses when the playhead crosses click events.
      if (es.clickEffect !== 'none' && cls.length) {
        const lastIdx = lastClickIdxRef.current
        for (let i = 0; i < cls.length; i++) {
          const cMs = cls[i].timestamp
          if (cMs <= tMs && cMs > tMs - 80 && i !== lastIdx) {
            lastClickIdxRef.current = i
            const xNorm = cls[i].x / (s.screenW || 1)
            const yNorm = cls[i].y / (s.screenH || 1)
            spawnClickPulse(xNorm, yNorm, es.clickEffect, tMs)
            break
          }
        }
        if (lastIdx >= 0 && cls[lastIdx] && cls[lastIdx].timestamp > tMs + 200) {
          lastClickIdxRef.current = -1
        }
      }

      if (Math.abs(tMs - currentMsRef.current) > 30) {
        setCurrentMs(tMs)
        currentMsRef.current = tMs
      }

      // Decide whether to schedule another frame. Always loop while playing.
      // While paused, keep ticking for a short settle window so springs have
      // a chance to converge on the new target — then go idle. `wakeLoop()`
      // resets idleFrames so any external change (scrub, edit, settings)
      // brings us back to life.
      if (playing) {
        idleFramesRef.current = 0
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      idleFramesRef.current += 1
      // ~0.6s @ 60Hz settle budget; springs at our stiffness/damping converge
      // well inside that.
      if (idleFramesRef.current < 36) {
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  // Kick the rAF loop awake from external events (effect re-runs, click,
  // user input). Called via wakeLoopRef so we don't add it to every dep array.
  function wakeLoop() {
    idleFramesRef.current = 0
    ensureLoop()
  }
  // Stable ref alias for callbacks below.
  const wakeLoopRef = useRef(wakeLoop)
  wakeLoopRef.current = wakeLoop

  // Bind rAF once on mount. Cleanup cancels any pending frame.
  useEffect(() => {
    wakeLoopRef.current()
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [])

  // Wake the loop on edits / state changes that should re-render the preview.
  useEffect(() => { wakeLoopRef.current() },
    [zooms, decimated, clicks, exportSettings, previewEnabled, session?.id])

  function spawnClickPulse(xNorm, yNorm, kind, tMs) {
    const id = `${tMs}-${Math.random().toString(36).slice(2, 6)}`
    setClickPulses((prev) => [
      ...prev.slice(-12),
      { id, xPct: xNorm * 100, yPct: yNorm * 100, kind, born: performance.now() }
    ])
    setTimeout(() => {
      setClickPulses((prev) => prev.filter((p) => p.id !== id))
    }, 900)
  }

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onMeta = () => {
      if (isFinite(v.duration) && v.duration > 0) setDurationMs(v.duration * 1000)
    }
    const onPlay = () => { setIsPlaying(true); wakeLoopRef.current() }
    const onPause = () => { setIsPlaying(false); wakeLoopRef.current() }
    const onSeeking = () => wakeLoopRef.current()
    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('durationchange', onMeta)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('seeking', onSeeking)
    return () => {
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('durationchange', onMeta)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('seeking', onSeeking)
    }
  }, [])

  useEffect(() => {
    function onKey(e) {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const meta = e.metaKey || e.ctrlKey
      if (e.code === 'Space') {
        e.preventDefault()
        const v = videoRef.current
        if (!v) return
        if (v.paused) v.play()
        else v.pause()
      } else if (meta && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if (meta && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        redo()
      } else if ((e.key === 'Delete' || e.key === 'Backspace')) {
        if (selectedAnnotationId) {
          e.preventDefault()
          removeAnnotation(selectedAnnotationId)
        } else if (selectedZoomId) {
          e.preventDefault()
          removeZoom(selectedZoomId)
        }
      } else if (e.key === 'Escape') {
        selectZoom(null)
        selectAnnotation(null)
        setCenterPicking(false)
        setPendingAnnotation(null)
      } else if ((e.key === 'z' || e.key === 'Z') && !meta) {
        // Z = add a zoom region centered on the playhead. Same as the +Zoom
        // button. (Lowercase z without modifiers; uppercase still works.)
        e.preventDefault()
        addZoomAtPlayhead()
      } else if (e.key === 'ArrowLeft' && selectedZoomId) {
        // Nudge selected zoom left. Shift = 5x (500ms).
        e.preventDefault()
        const step = e.shiftKey ? 500 : 100
        const z = zooms.find((zz) => zz.id === selectedZoomId)
        if (z) {
          const moved = shiftZoom(z, -step, durationMs)
          updateZoom(z.id, moved)
        }
      } else if (e.key === 'ArrowRight' && selectedZoomId) {
        e.preventDefault()
        const step = e.shiftKey ? 500 : 100
        const z = zooms.find((zz) => zz.id === selectedZoomId)
        if (z) {
          const moved = shiftZoom(z, step, durationMs)
          updateZoom(z.id, moved)
        }
      } else if (meta && e.key === 'd' && selectedZoomId) {
        // Duplicate selected zoom 50ms to the right.
        e.preventDefault()
        const z = zooms.find((zz) => zz.id === selectedZoomId)
        if (z) {
          const len = z.end - z.start
          const offset = Math.max(50, Math.min(durationMs - z.end, len + 200))
          addZoomAction({
            ...z,
            id: `z${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
            start: z.start + offset,
            peakStart: z.peakStart + offset,
            peakEnd: z.peakEnd + offset,
            end: z.end + offset
          })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedZoomId, selectedAnnotationId, undo, redo, zooms, durationMs])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = () => {
      const tMs = v.currentTime * 1000
      const inMs = trim.inMs || 0
      const outMs = trim.outMs ?? durationMs ?? Infinity
      if (tMs < inMs) v.currentTime = inMs / 1000
      else if (outMs && tMs > outMs) {
        v.currentTime = inMs / 1000
        v.pause()
      }
    }
    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [trim, durationMs])

  // Mirror audio settings into the preview video element. The exported MP4
  // applies the same values via FFmpeg afade/volume.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.muted = !!exportSettings.audioMuted
    v.volume = Math.max(0, Math.min(1, exportSettings.micVolume || 0))
  }, [exportSettings.audioMuted, exportSettings.micVolume])

  if (!session) return null

  const videoSrc = `file://${session.videoPath}`

  function seek(ms) {
    const v = videoRef.current
    if (!v) return
    v.currentTime = ms / 1000
    setCurrentMs(ms)
    currentMsRef.current = ms
    lastClickIdxRef.current = -1
  }

  function togglePlay() {
    const v = videoRef.current
    if (!v) return
    if (v.paused) v.play()
    else v.pause()
  }

  function addZoomAtPlayhead() {
    const z = makeManualZoom(currentMs, exportSettings)
    if (z.end > durationMs) {
      const shift = durationMs - z.end - 50
      const moved = shiftZoom(z, shift, durationMs)
      addZoomAction(moved)
    } else {
      addZoomAction(z)
    }
  }

  // Click-and-drag annotation placement. mousedown sets the anchor; drag
  // sizes the geometry; mouseup commits. If the user just clicks (no drag),
  // we fall back to the per-kind default size from annotations.js so they
  // don't end up with a 1-pixel arrow.
  function onWrapperMouseDown(e) {
    if (!innerRef.current) return
    if (e.button !== 0) return
    const rect = innerRef.current.getBoundingClientRect()
    const cx0 = (e.clientX - rect.left) / rect.width
    const cy0 = (e.clientY - rect.top) / rect.height

    if (centerPicking && selectedZoom) {
      updateZoom(selectedZoom.id, {
        cx: Math.max(0.02, Math.min(0.98, cx0)),
        cy: Math.max(0.02, Math.min(0.98, cy0))
      })
      setCenterPicking(false)
      return
    }
    if (!pendingAnnotation) return
    if (cx0 < 0 || cx0 > 1 || cy0 < 0 || cy0 > 1) return
    e.preventDefault()

    const id = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const start = currentMs
    const dur = defaultDurationMsFor(pendingAnnotation)
    const end = Math.min(durationMs || start + dur, start + dur)
    // Optimistic insert at the click point with the per-kind default size.
    // Drag will widen it; if user only clicks, this is the final size.
    const def = defaultGeometryFor(pendingAnnotation)
    // Counter annotations auto-number: text = (count of existing counters + 1).
    const isCounter = pendingAnnotation.kind === 'text' && pendingAnnotation.styleId === 'counter'
    const counterIdx = isCounter
      ? annotations.filter((x) => x.styleId === 'counter').length + 1
      : null
    const baseAnn = {
      id,
      ...pendingAnnotation,
      ...(isCounter ? { text: String(counterIdx) } : {}),
      x: cx0,
      y: cy0,
      w: def.w,
      h: def.h,
      color: defaultColorFor(pendingAnnotation),
      fadeInMs: DEFAULT_FADE_MS,
      fadeOutMs: DEFAULT_FADE_MS,
      ...(pendingAnnotation.kind === 'mask' && pendingAnnotation.maskId === 'blur'
        ? { blurRadius: DEFAULT_BLUR_RADIUS }
        : {}),
      ...(pendingAnnotation.kind === 'mask' && pendingAnnotation.maskId === 'spotlight'
        ? { spotlightDarkness: DEFAULT_SPOTLIGHT_DARKNESS }
        : {}),
      ...(pendingAnnotation.kind === 'mask' && pendingAnnotation.maskId === 'magnifier'
        ? { magnifierZoom: DEFAULT_MAGNIFIER_ZOOM }
        : {}),
      start,
      end
    }
    addAnnotation(baseAnn)
    setPendingAnnotation(null)

    // Live drag-to-resize: if the user drags >6 px before releasing, switch
    // to a "drag" geometry where (cx0,cy0) is one corner and the cursor is
    // the opposite corner. Single-click users land with the default size.
    let dragged = false
    function onMove(ev) {
      const cx1 = (ev.clientX - rect.left) / rect.width
      const cy1 = (ev.clientY - rect.top) / rect.height
      const dxPx = Math.abs(ev.clientX - e.clientX)
      const dyPx = Math.abs(ev.clientY - e.clientY)
      if (!dragged && Math.hypot(dxPx, dyPx) < 6) return
      dragged = true
      const x = (cx0 + cx1) / 2
      const y = (cy0 + cy1) / 2
      const w = Math.max(0.02, Math.abs(cx1 - cx0))
      const h = Math.max(0.02, Math.abs(cy1 - cy0))
      updateAnnotation(id, { x, y, w, h })
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function moveSelectedZoom(id, newStart) {
    const z = zooms.find((zz) => zz.id === id)
    if (!z) return
    const moved = shiftZoom(z, newStart - z.start, durationMs)
    updateZoom(id, moved)
  }

  function resizeSelectedZoom(id, patch) {
    const z = zooms.find((zz) => zz.id === id)
    if (!z) return
    const next = recomputeZoomTimings(z, patch)
    updateZoom(id, next)
  }

  // ----- Layout math for the framed canvas (preview parity) -----
  // padding (% of shorter side) is the gap between the inner inset rect and
  // the framed background. inset is a coloured border *inside* that rect.
  const padPct = exportSettings.padding
  const insetPct = exportSettings.inset
  const roundnessPx = exportSettings.roundness
  const shadowAmt = exportSettings.shadow

  const cursorStyle = findCursorStyle(exportSettings.cursorStyle)
  const cursorBaseW = 28
  const cursorBaseH = 32
  const cursorW = cursorBaseW * exportSettings.cursorSize
  const cursorH = cursorBaseH * exportSettings.cursorSize

  // Include the active window AND the inbound/outbound fade margins so the
  // preview shows the fade animation, not a hard pop.
  const activeAnnotations = annotations.filter((a) => {
    const inMs = a.fadeInMs ?? DEFAULT_FADE_MS
    const outMs = a.fadeOutMs ?? DEFAULT_FADE_MS
    return currentMs >= a.start - inMs && currentMs <= a.end + outMs
  })
  const activeKeys = exportSettings.showKeystrokes
    ? keyEvents.filter(
        (k) =>
          k.timestamp <= currentMs && k.timestamp > currentMs - exportSettings.keystrokeWindowMs
      )
    : []

  const showZoomPanel = !!selectedZoom
  const panelTitle = showZoomPanel
    ? 'Zoom details'
    : PANELS.find((p) => p.id === activePanel)?.label || 'Settings'

  return (
    <div className="h-full flex">
      {/* Left tool rail */}
      <div className="w-14 border-r border-panel2 bg-panel flex flex-col items-center py-3 gap-2 flex-shrink-0">
        {PANELS.map((p) => (
          <ToolRailButton
            key={p.id}
            icon={p.icon}
            active={!showZoomPanel && activePanel === p.id}
            label={p.label}
            onClick={() => {
              setActivePanel(p.id)
              selectAnnotation(null)
            }}
          />
        ))}
      </div>

      {/* Canvas + timeline */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Banner when this recording captured no clicks — auto-zoom needs
            them, so users know upfront that the editor will look "empty"
            until they add zooms manually. */}
        {session.events && clicks.length === 0 && (
          <div
            className="flex items-center gap-2 text-[12px]"
            style={{
              padding: '8px 16px',
              background: 'rgba(252, 211, 77, 0.08)',
              borderBottom: '1px solid rgba(252, 211, 77, 0.2)',
              color: '#FCD34D'
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
              <path d="M12 3l9 16H3l9-16z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              <path d="M12 10v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>
              No clicks were captured in this recording — auto-zoom has nothing to follow.
              Press <kbd style={{ padding: '0 4px', borderRadius: 3, background: 'rgba(255,255,255,0.08)', fontFamily: 'monospace' }}>Z</kbd> to add zoom regions manually,
              or re-record with Accessibility permission granted.
            </span>
          </div>
        )}
        <div
          ref={wrapperRef}
          className="flex-1 flex items-center justify-center p-8 bg-[#0a0a0d] overflow-hidden"
        >
          <div
            className="relative flex items-center justify-center"
            style={{
              width: '100%',
              height: '100%',
              maxWidth: '100%',
              maxHeight: '100%'
            }}
          >
            <FramedCanvas
              aspect={canvasAspect}
              bgCss={bg.css}
              padPct={padPct}
              insetPct={insetPct}
              insetColor={exportSettings.insetColor}
              roundnessPx={roundnessPx}
              shadowAmt={shadowAmt}
              centerPicking={centerPicking}
              hasPendingAnnotation={!!pendingAnnotation}
              innerRef={innerRef}
              onMouseDown={onWrapperMouseDown}
            >
              <video
                ref={videoRef}
                src={videoSrc}
                className="block"
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  transformOrigin: 'center',
                  willChange: 'transform',
                  pointerEvents: centerPicking || pendingAnnotation ? 'none' : 'auto'
                }}
              />

              {/* Cursor overlay */}
              <div
                ref={cursorOverlayRef}
                className="absolute pointer-events-none"
                style={{
                  opacity: 0,
                  left: '50%',
                  top: '50%',
                  width: cursorW,
                  height: cursorH,
                  marginLeft: -cursorW * 0.1,
                  marginTop: -cursorH * 0.1,
                  transition: 'opacity 120ms linear',
                  filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))'
                }}
              >
                <CursorSvg style={cursorStyle} />
              </div>

              {/* Click-effect pulses */}
              <ClickPulseLayer pulses={clickPulses} />

              {/* Annotations */}
              <AnnotationsLayer
                annotations={activeAnnotations}
                selectedId={selectedAnnotationId}
                onSelect={selectAnnotation}
                onUpdate={updateAnnotation}
                innerRef={innerRef}
                currentMs={currentMs}
                videoRef={videoRef}
              />

              {/* Camera PiP — uses the recorded webcam.webm if one was
                  captured during recording, otherwise falls back to a live
                  getUserMedia preview (so the layout chooser still works
                  on older sessions). */}
              {exportSettings.showCamera && (
                <CameraOverlay
                  layout={exportSettings.cameraLayout}
                  shape={exportSettings.cameraShape}
                  size={exportSettings.cameraSize}
                  flip={exportSettings.cameraFlip}
                  background={exportSettings.cameraBackground}
                  webcamPath={session.webcamPath}
                  mainVideoRef={videoRef}
                />
              )}

              {/* Keyboard overlay */}
              {exportSettings.showKeystrokes && activeKeys.length > 0 && (
                <KeyboardOverlay
                  keys={activeKeys}
                  position={exportSettings.keystrokePosition}
                  style={exportSettings.keystrokeStyle}
                />
              )}

              {/* Watermark */}
              {exportSettings.watermarkEnabled && (
                <Watermark
                  text={exportSettings.watermarkText}
                  position={exportSettings.watermarkPosition}
                  opacity={exportSettings.watermarkOpacity}
                  size={exportSettings.watermarkSize}
                />
              )}

              {/* Zoom-center marker */}
              {selectedZoom && !centerPicking && (
                <div
                  className="absolute pointer-events-none"
                  style={{
                    left: `${selectedZoom.cx * 100}%`,
                    top: `${selectedZoom.cy * 100}%`,
                    transform: 'translate(-50%,-50%)'
                  }}
                >
                  <div className="w-6 h-6 rounded-full ring-2 ring-accent bg-accent/20 animate-pulse" />
                </div>
              )}

              {/* Picker hints */}
              {centerPicking && selectedZoom && (
                <PickerHint text="Click anywhere to set zoom center" />
              )}
              {pendingAnnotation && (
                <PickerHint
                  text={`Click on canvas to place ${pendingAnnotation.kind}`}
                />
              )}
            </FramedCanvas>
          </div>
        </div>

        <div className="border-t border-panel2 bg-panel px-5 py-4">
          <div className="flex items-center gap-3 mb-3">
            <button
              onClick={togglePlay}
              className="w-9 h-9 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 transition flex-shrink-0"
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
            <div className="flex-1 min-w-0">
              <Timeline
                durationMs={durationMs}
                currentMs={currentMs}
                zooms={zooms}
                selectedZoomId={selectedZoomId}
                clicks={clicks}
                videoSrc={videoSrc}
                trim={trim}
                onSeek={seek}
                onSelectZoom={selectZoom}
                onMoveZoom={moveSelectedZoom}
                onResizeZoom={resizeSelectedZoom}
                onDeleteZoom={removeZoom}
                onTrimChange={(patch) => setTrim(patch)}
              />
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={undo}
                disabled={!canUndo}
                title="Undo (⌘Z)"
                className="w-9 h-9 rounded-md bg-panel2 hover:bg-panel2/70 text-sm disabled:opacity-30 disabled:cursor-not-allowed"
              >
                ↶
              </button>
              <button
                onClick={redo}
                disabled={!canRedo}
                title="Redo (⌘⇧Z)"
                className="w-9 h-9 rounded-md bg-panel2 hover:bg-panel2/70 text-sm disabled:opacity-30 disabled:cursor-not-allowed"
              >
                ↷
              </button>
              <button
                onClick={addZoomAtPlayhead}
                className="px-3 h-9 rounded-md bg-panel2 hover:bg-panel2/70 text-sm flex items-center gap-1.5"
                title="Add zoom at playhead (Z)"
              >
                <span className="text-base leading-none">+</span> Zoom
              </button>
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
              Space play · Z add zoom · ←/→ nudge · ⌘D duplicate · ⌘Z undo · Del remove
            </span>
          </div>
        </div>
      </div>

      <aside className="w-[340px] border-l border-panel2 bg-panel flex flex-col flex-shrink-0">
        <div className="px-5 py-4 border-b border-panel2">
          <h2 className="font-semibold mb-0.5">{panelTitle}</h2>
          <p className="text-xs text-muted">
            {showZoomPanel
              ? `${selectedZoom.source === 'manual' ? 'Manual' : 'From click'} · ${formatTime(selectedZoom.start)}–${formatTime(selectedZoom.end)}`
              : activePanel === 'background'
                ? 'Frame, padding, and wallpaper'
                : activePanel === 'cursor'
                  ? 'Style, size, click effects'
                  : activePanel === 'keyboard'
                    ? 'Keystroke overlay'
                    : activePanel === 'watermark'
                      ? 'Branding and overlays'
                      : activePanel === 'camera'
                        ? 'Webcam preview (live)'
                        : activePanel === 'audio'
                          ? 'Microphone level and fades'
                          : 'Text, shapes, and masks'}
          </p>
        </div>
        <div className="px-5 py-5 space-y-5 overflow-y-auto flex-1">
          {showZoomPanel ? (
            <SelectedZoomPanel
              zoom={selectedZoom}
              durationMs={durationMs}
              onChange={(patch) => updateZoom(selectedZoom.id, patch)}
              onDelete={() => removeZoom(selectedZoom.id)}
              onPickCenter={() => setCenterPicking(true)}
              centerPicking={centerPicking}
            />
          ) : activePanel === 'background' ? (
            <BackgroundPanel settings={exportSettings} update={updateExportSettings} />
          ) : activePanel === 'cursor' ? (
            <CursorPanel settings={exportSettings} update={updateExportSettings} />
          ) : activePanel === 'camera' ? (
            <CameraPanel settings={exportSettings} update={updateExportSettings} />
          ) : activePanel === 'audio' ? (
            <AudioPanel settings={exportSettings} update={updateExportSettings} />
          ) : activePanel === 'keyboard' ? (
            <KeyboardPanel
              settings={exportSettings}
              update={updateExportSettings}
              hasKeyEvents={keyEvents.length > 0}
            />
          ) : activePanel === 'watermark' ? (
            <WatermarkPanel settings={exportSettings} update={updateExportSettings} />
          ) : (
            <AnnotationsPanel
              pendingAnnotation={pendingAnnotation}
              setPendingAnnotation={setPendingAnnotation}
              annotations={annotations}
              selectedId={selectedAnnotationId}
              onSelect={selectAnnotation}
              onRemove={removeAnnotation}
              onUpdate={updateAnnotation}
            />
          )}

          {!showZoomPanel && (
            <DefaultsPanel
              exportSettings={exportSettings}
              updateExportSettings={updateExportSettings}
              onResetZooms={() => {
                const initial = zoomsFromEvents(events, exportSettings)
                setZooms(initial)
              }}
            />
          )}
        </div>
        <div className="p-4 border-t border-panel2 bg-panel">
          <div className="flex gap-2">
            <button
              onClick={() => { reset(); goto('home') }}
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

function FramedCanvas({
  aspect,
  bgCss,
  padPct,
  insetPct,
  insetColor,
  roundnessPx,
  shadowAmt,
  centerPicking,
  hasPendingAnnotation,
  innerRef,
  onClick,
  onMouseDown,
  children
}) {
  const shadowCss =
    shadowAmt > 0
      ? `0 ${Math.round(shadowAmt / 6)}px ${Math.round(shadowAmt)}px rgba(0,0,0,${Math.min(0.6, shadowAmt / 200)})`
      : 'none'

  const cursorClass = centerPicking
    ? 'cursor-crosshair'
    : hasPendingAnnotation
      ? 'cursor-copy'
      : ''

  // CSS aspect-ratio + width/height:100% is overconstrained — the engine drops
  // one constraint, so the frame either overflows or doesn't fit. We compute
  // the fit-inside dimensions from the parent's box on every resize.
  const parentRef = useRef(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    if (!parentRef.current) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const cr = e.contentRect
        let w = cr.width
        let h = cr.height
        if (w / h > aspect) w = h * aspect
        else h = w / aspect
        setBox({ w: Math.floor(w), h: Math.floor(h) })
      }
    })
    ro.observe(parentRef.current)
    return () => ro.disconnect()
  }, [aspect])

  // Convert the roundness % into a uniform pixel radius based on the inset
  // box's short side. This mirrors the export pipeline exactly so what you
  // see is what gets rendered into the MP4.
  const insetSize = (() => {
    const padFrac = padPct / 100
    const insetFrac = insetPct / 100
    const w = Math.max(0, box.w * (1 - 2 * padFrac) * (1 - 2 * insetFrac))
    const h = Math.max(0, box.h * (1 - 2 * padFrac) * (1 - 2 * insetFrac))
    return Math.min(w, h)
  })()
  const roundnessPxComputed = (roundnessPx / 100) * insetSize

  return (
    <div
      ref={parentRef}
      className="w-full h-full flex items-center justify-center"
    >
    <div
      onClick={onClick}
      onMouseDown={onMouseDown}
      className={`relative ${cursorClass}`}
      style={{
        width: box.w || '100%',
        height: box.h || '100%',
        // Avoid mixing shorthand `background` with longhand siblings — React
        // warns and the longhands can get blown away on rerender.
        backgroundImage: bgCss.includes('gradient') ? bgCss : 'none',
        backgroundColor: bgCss.includes('gradient') ? 'transparent' : bgCss,
        backgroundSize: 'cover',
        backgroundPosition: 'center'
      }}
    >
      {/* padding box */}
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ padding: `${padPct}%` }}
      >
        {/* inset (coloured border) box */}
        <div
          className="relative overflow-hidden"
          style={{
            width: '100%',
            height: '100%',
            background: insetPct > 0 ? insetColor : 'transparent',
            padding: `${insetPct}%`,
            // Roundness is a % of the inset short side. Computing it in px from
            // the measured box keeps a true-uniform corner (CSS `border-radius:
            // X%` would yield an ellipse on non-square boxes).
            borderRadius: roundnessPxComputed,
            boxShadow: shadowCss
          }}
        >
          {/* inner video clip */}
          <div
            ref={innerRef}
            className="relative overflow-hidden bg-black"
            style={{
              width: '100%',
              height: '100%',
              borderRadius: Math.max(0, roundnessPxComputed - 1)
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
    </div>
  )
}

function ToolRailButton({ icon, active, label, onClick }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`w-10 h-10 rounded-md flex items-center justify-center transition ${
        active
          ? 'bg-accent/15 text-accent border border-accent/40'
          : 'bg-panel2/40 text-white/70 hover:bg-panel2 border border-transparent'
      }`}
    >
      <ToolIcon name={icon} />
    </button>
  )
}

function ToolIcon({ name }) {
  if (name === 'bg')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M3 14 L8 9 L13 14 L17 10 L21 14" />
      </svg>
    )
  if (name === 'cursor')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
        <path d="M5 3 L5 19 L9 15 L12 22 L15 21 L12 14 L19 14 Z" />
      </svg>
    )
  if (name === 'pen')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M14 4 L20 10 L8 22 L2 22 L2 16 Z" />
        <path d="M13 5 L19 11" />
      </svg>
    )
  if (name === 'kbd')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="6" width="20" height="13" rx="2" />
        <path d="M6 11 h.01 M10 11 h.01 M14 11 h.01 M18 11 h.01 M7 15 h10" strokeLinecap="round" />
      </svg>
    )
  if (name === 'audio')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M3 12 v0 M7 8 v8 M11 5 v14 M15 9 v6 M19 11 v2" />
      </svg>
    )
  if (name === 'cam')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="4" />
      </svg>
    )
  if (name === 'wm')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M9 12 l3 3 l5 -6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  return null
}

function CursorSvg({ style }) {
  const gradId = `cursorGrad-${style.id}`
  return (
    <svg viewBox="0 0 40 48" className="w-full h-full">
      {style.gradient && (
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={style.gradient.from} />
            <stop offset="100%" stopColor={style.gradient.to} />
          </linearGradient>
        </defs>
      )}
      <path
        d={style.path}
        fill={style.fill.startsWith('gradient:') ? `url(#${gradId})` : style.fill}
        stroke={style.stroke}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ClickPulseLayer({ pulses }) {
  return (
    <div className="absolute inset-0 pointer-events-none">
      {pulses.map((p) => (
        <ClickPulse key={p.id} pulse={p} />
      ))}
    </div>
  )
}

function ClickPulse({ pulse }) {
  const baseStyle = {
    position: 'absolute',
    left: `${pulse.xPct}%`,
    top: `${pulse.yPct}%`,
    transform: 'translate(-50%,-50%)',
    pointerEvents: 'none'
  }
  if (pulse.kind === 'ripple') {
    return (
      <div style={baseStyle}>
        <span className="block rounded-full bg-white/30 animate-[ripple_700ms_ease-out_forwards]" style={{ width: 16, height: 16 }} />
      </div>
    )
  }
  if (pulse.kind === 'ring') {
    return (
      <div style={baseStyle}>
        <span className="block rounded-full border-2 border-white animate-[ring_700ms_ease-out_forwards]" style={{ width: 16, height: 16 }} />
      </div>
    )
  }
  if (pulse.kind === 'spotlight') {
    return (
      <div
        style={{
          ...baseStyle,
          width: 200,
          height: 200,
          borderRadius: '50%',
          background:
            'radial-gradient(circle, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0) 60%)',
          animation: 'spotlight 700ms ease-out forwards'
        }}
      />
    )
  }
  if (pulse.kind === 'sparkle') {
    return (
      <div style={baseStyle}>
        <svg
          width="48"
          height="48"
          viewBox="-24 -24 48 48"
          className="animate-[sparkle_700ms_ease-out_forwards]"
        >
          {[0, 60, 120, 180, 240, 300].map((deg) => (
            <line
              key={deg}
              x1="0"
              y1="0"
              x2="0"
              y2="-14"
              stroke="#fde047"
              strokeWidth="2"
              strokeLinecap="round"
              transform={`rotate(${deg})`}
            />
          ))}
        </svg>
      </div>
    )
  }
  return null
}

function AnnotationsLayer({ annotations, selectedId, onSelect, onUpdate, innerRef, currentMs, videoRef }) {
  return (
    <div className="absolute inset-0 pointer-events-none">
      {annotations.map((a) => (
        <AnnotationView
          key={a.id}
          annotation={a}
          selected={a.id === selectedId}
          onSelect={onSelect}
          onUpdate={onUpdate}
          innerRef={innerRef}
          currentMs={currentMs}
          videoRef={videoRef}
        />
      ))}
    </div>
  )
}

// Fade opacity based on currentMs vs annotation [start, end] window.
function fadeOpacity(a, t) {
  const inMs = a.fadeInMs ?? 180
  const outMs = a.fadeOutMs ?? 180
  if (t < a.start || t > a.end) return 0
  const p = Math.min(1, (t - a.start) / Math.max(1, inMs))
  const q = Math.min(1, (a.end - t) / Math.max(1, outMs))
  return Math.max(0, Math.min(1, Math.min(p, q)))
}

function AnnotationView({ annotation, selected, onSelect, onUpdate, innerRef, currentMs, videoRef }) {
  const a = annotation
  const opacity = fadeOpacity(a, currentMs)
  const dropShadow = 'drop-shadow(0 4px 16px rgba(0,0,0,0.45))'

  function startDrag(e) {
    e.stopPropagation()
    onSelect(a.id)
    const wrap = innerRef.current
    if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    const baseX = a.x
    const baseY = a.y
    function onMove(ev) {
      const dx = (ev.clientX - startX) / rect.width
      const dy = (ev.clientY - startY) / rect.height
      onUpdate(a.id, {
        x: Math.max(0, Math.min(1, baseX + dx)),
        y: Math.max(0, Math.min(1, baseY + dy))
      })
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Resize from a corner. `corner` ∈ {tl, tr, bl, br}. Drags that corner
  // while keeping the opposite corner pinned. Updates x/y (center) + w/h.
  function startResize(corner) {
    return (e) => {
      e.stopPropagation()
      onSelect(a.id)
      const wrap = innerRef.current
      if (!wrap) return
      const rect = wrap.getBoundingClientRect()
      // Compute the OPPOSITE corner in normalized coords; it stays fixed.
      const halfW = a.w / 2
      const halfH = a.h / 2
      const fixedX = corner.includes('l') ? a.x + halfW : a.x - halfW
      const fixedY = corner.includes('t') ? a.y + halfH : a.y - halfH
      function onMove(ev) {
        const mx = (ev.clientX - rect.left) / rect.width
        const my = (ev.clientY - rect.top) / rect.height
        const nx = (fixedX + mx) / 2
        const ny = (fixedY + my) / 2
        const nw = Math.max(0.02, Math.abs(mx - fixedX))
        const nh = Math.max(0.02, Math.abs(my - fixedY))
        onUpdate(a.id, { x: nx, y: ny, w: nw, h: nh })
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }
  }

  const baseStyle = {
    position: 'absolute',
    left: `${a.x * 100}%`,
    top: `${a.y * 100}%`,
    transform: 'translate(-50%,-50%)',
    pointerEvents: 'auto',
    cursor: 'grab',
    opacity,
    transition: opacity > 0 && opacity < 1 ? 'opacity 80ms linear' : undefined
  }

  // Selection ring + resize handles overlay. Sits on top of every kind so
  // we don't need to inline it into each render branch.
  const SelectionChrome = selected ? (
    <>
      <div
        className="absolute inset-0 ring-2 ring-accent rounded pointer-events-none"
        style={{ zIndex: 1 }}
      />
      {['tl', 'tr', 'bl', 'br'].map((c) => (
        <div
          key={c}
          onMouseDown={startResize(c)}
          className="absolute bg-accent border border-black/30"
          style={{
            width: 10,
            height: 10,
            borderRadius: 2,
            left: c.includes('l') ? -5 : undefined,
            right: c.includes('r') ? -5 : undefined,
            top: c.includes('t') ? -5 : undefined,
            bottom: c.includes('b') ? -5 : undefined,
            cursor:
              c === 'tl' || c === 'br' ? 'nwse-resize' : 'nesw-resize',
            zIndex: 2
          }}
        />
      ))}
    </>
  ) : null

  if (a.kind === 'text') {
    const def = TEXT_DEFS_DATA[a.styleId] || TEXT_DEFS_DATA.plain
    const text = a.text || def.label
    const fontSize = Math.max(12, Math.round((a.h || 0.06) * 600 * 0.55)) // matches rasterizer ratio
    const isTransparent = def.bg === 'transparent'
    return (
      <div style={baseStyle} onMouseDown={startDrag}>
        <div
          style={{
            position: 'relative',
            background: a.bgColor || def.bg,
            color: a.color && isTransparent ? a.color : def.fg,
            padding: def.bg === 'transparent' ? 0 : `${def.padY}px ${def.padX}px`,
            borderRadius: def.radius,
            border: def.border ? `2px solid ${def.border}` : 'none',
            font: `${def === TEXT_DEFS_DATA.badge ? 700 : 600} ${fontSize}px Inter, -apple-system, sans-serif`,
            whiteSpace: 'nowrap',
            filter: dropShadow,
            minWidth: def === TEXT_DEFS_DATA.badge ? fontSize * 1.4 : undefined,
            minHeight: def === TEXT_DEFS_DATA.badge ? fontSize * 1.4 : undefined,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          {text}
        </div>
        {SelectionChrome}
      </div>
    )
  }

  if (a.kind === 'shape') {
    const color = a.color || SHAPE_DEFS_DATA[a.shapeId]?.stroke || '#ffffff'
    const sizeW = `${a.w * 100}%`
    const sizeH = `${a.h * 100}%`
    if (a.shapeId === 'box') {
      return (
        <div
          style={{ ...baseStyle, width: sizeW, height: sizeH, border: `3px solid ${color}`, filter: dropShadow }}
          onMouseDown={startDrag}
        >
          {SelectionChrome}
        </div>
      )
    }
    if (a.shapeId === 'box-rounded') {
      return (
        <div
          style={{ ...baseStyle, width: sizeW, height: sizeH, border: `3px solid ${color}`, borderRadius: 14, filter: dropShadow }}
          onMouseDown={startDrag}
        >
          {SelectionChrome}
        </div>
      )
    }
    if (a.shapeId === 'circle') {
      return (
        <div
          style={{ ...baseStyle, width: sizeW, height: sizeH, border: `4px solid ${color}`, borderRadius: '50%', filter: dropShadow }}
          onMouseDown={startDrag}
        >
          {SelectionChrome}
        </div>
      )
    }
    if (a.shapeId === 'line' || a.shapeId === 'arrow') {
      // Render as an SVG that fills the bounding box (matches the rasterizer).
      const isArrow = a.shapeId === 'arrow'
      return (
        <div style={{ ...baseStyle, width: sizeW, height: sizeH, filter: dropShadow }} onMouseDown={startDrag}>
          <svg viewBox="0 0 100 30" preserveAspectRatio="none" width="100%" height="100%">
            <line x1="4" y1="15" x2={isArrow ? 80 : 96} y2="15" stroke={color} strokeWidth="6" strokeLinecap="round" />
            {isArrow && <polygon points="80,4 96,15 80,26" fill={color} />}
          </svg>
          {SelectionChrome}
        </div>
      )
    }
    if (a.shapeId === 'arrow-down') {
      return (
        <div style={{ ...baseStyle, width: sizeW, height: sizeH, filter: dropShadow }} onMouseDown={startDrag}>
          <svg viewBox="0 0 30 100" preserveAspectRatio="none" width="100%" height="100%">
            <line x1="15" y1="4" x2="15" y2="80" stroke={color} strokeWidth="6" strokeLinecap="round" />
            <polygon points="4,80 26,80 15,96" fill={color} />
          </svg>
          {SelectionChrome}
        </div>
      )
    }
  }

  if (a.kind === 'mask') {
    if (a.maskId === 'spotlight') {
      // Match the export's rasterized PNG: full-frame dim with a feathered
      // elliptical hole. Implemented with two radial-gradient overlays so
      // the preview is pixel-accurate to the MP4 within ~1%.
      const darkness = a.spotlightDarkness ?? 0.55
      const dimOpacity = darkness * opacity
      return (
        <>
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                `radial-gradient(ellipse ${a.w * 50}% ${a.h * 50}% at ${a.x * 100}% ${a.y * 100}%,` +
                ` transparent 60%,` +
                ` rgba(0,0,0,${dimOpacity}) 100%)`
            }}
          />
          {/* Invisible hitbox that owns drag + selection chrome */}
          <div
            style={{
              ...baseStyle,
              width: `${a.w * 100}%`,
              height: `${a.h * 100}%`,
              borderRadius: '50%',
              border: selected ? '1px dashed rgba(255,255,255,0.6)' : 'none',
              background: 'transparent'
            }}
            onMouseDown={startDrag}
          >
            {SelectionChrome}
          </div>
        </>
      )
    }
    if (a.maskId === 'blur') {
      // Preview blur matches the export's effective radius. The rasterizer
      // converts annotation.blurRadius (CSS px on a 1920-wide canvas) into
      // FFmpeg's source-pixel radius. Here we show a CSS blur at the same
      // logical radius.
      const radiusPx = a.blurRadius || 16
      return (
        <div
          style={{
            ...baseStyle,
            width: `${a.w * 100}%`,
            height: `${a.h * 100}%`,
            backdropFilter: `blur(${radiusPx}px)`,
            WebkitBackdropFilter: `blur(${radiusPx}px)`,
            background: 'rgba(0,0,0,0.04)',
            borderRadius: 8,
            border: selected ? '1px dashed rgba(255,255,255,0.7)' : '1px solid rgba(255,255,255,0.2)'
          }}
          onMouseDown={startDrag}
        >
          {SelectionChrome}
        </div>
      )
    }
    if (a.maskId === 'magnifier') {
      // Real magnifier preview: shows the underlying video pixels scaled up,
      // clipped to a circle. We mirror the same video stream into a
      // background-image-via-video trick — but that's expensive in CSS, so
      // we use a transformed copy of the live <video> ref instead.
      const zoomMag = a.magnifierZoom || 2.2
      // The visible window covers (a.w, a.h) of the *frame*. We scale up
      // the same frame and offset so the source region centered on (a.x, a.y)
      // appears centered.
      return (
        <div
          style={{
            ...baseStyle,
            width: `${a.w * 100}%`,
            height: `${a.h * 100}%`,
            borderRadius: '50%',
            overflow: 'hidden',
            border: '2px solid rgba(255,255,255,0.85)',
            boxShadow: '0 6px 22px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(0,0,0,0.4)',
            background: '#000'
          }}
          onMouseDown={startDrag}
        >
          <MagnifierContents zoom={zoomMag} opacity={opacity} />
          {SelectionChrome}
        </div>
      )
    }
  }

  return null
}

// Live magnifier preview. The accurate version would mount a second <video>
// synced to the main one, CSS-scaled by `zoom`. That doubles decode cost so
// for now the preview shows a styled lens (no magnification) and marks the
// position correctly — the EXPORT renders true magnification (processor.js
// crop+scale+alpha-mask). Preview parity is "approximate" for this one mask.
function MagnifierContents({ zoom, opacity }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        opacity,
        backdropFilter: `contrast(1.05) brightness(1.08) saturate(1.1)`,
        WebkitBackdropFilter: `contrast(1.05) brightness(1.08) saturate(1.1)`,
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.15)'
      }}
      // Hint text shown at the bottom-right inside the lens so the user
      // knows the real magnification factor without surprise.
      title={`Magnifier · ${zoom.toFixed(1)}× (preview is approximate; export is exact)`}
    />
  )
}

function PickerHint({ text }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="bg-black/70 text-white text-xs px-3 py-1.5 rounded-full">{text}</div>
    </div>
  )
}

// ---------- Right-side panels ----------

function BackgroundPanel({ settings, update }) {
  const [category, setCategory] = useState('Wallpaper')
  return (
    <>
      <Section title="Canvas size">
        <div className="grid grid-cols-5 gap-1.5">
          {CANVAS_ASPECTS.map((a) => (
            <button
              key={a.id}
              onClick={() => update({ canvasAspect: a.id })}
              className={`px-2 py-1.5 rounded-md text-xs border transition ${
                settings.canvasAspect === a.id
                  ? 'bg-accent/15 border-accent text-accent'
                  : 'border-panel2 hover:bg-panel2 text-white/80'
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Frame">
        <Slider label="Padding" value={settings.padding} min={0} max={20} step={0.5}
          format={(v) => `${v.toFixed(1)}%`}
          onChange={(padding) => update({ padding })} />
        <Slider label="Inset" value={settings.inset} min={0} max={6} step={0.1}
          format={(v) => `${v.toFixed(1)}%`}
          onChange={(inset) => update({ inset })} />
        <ColorPicker label="Inset color" value={settings.insetColor}
          onChange={(insetColor) => update({ insetColor })} />
        <Slider label="Roundness" value={settings.roundness} min={0} max={30} step={0.5}
          format={(v) => `${v.toFixed(1)}%`}
          onChange={(roundness) => update({ roundness })} />
        <Slider label="Shadow" value={settings.shadow} min={0} max={200} step={2}
          format={(v) => `${v}`}
          onChange={(shadow) => update({ shadow })} />
      </Section>

      <Section title="Background">
        <div className="flex gap-1 mb-3">
          {BACKGROUND_CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`px-2.5 py-1 text-xs rounded ${
                category === c ? 'bg-panel2 text-white' : 'text-muted hover:text-white/80'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-2">
          {BACKGROUNDS.filter((b) => b.category === category).map((b) => (
            <button
              key={b.id}
              onClick={() => update({ backgroundValue: b.id })}
              title={b.label}
              className={`aspect-square rounded-md border-2 transition ${
                settings.backgroundValue === b.id
                  ? 'border-accent'
                  : 'border-panel2 hover:border-white/30'
              }`}
              style={{ background: b.css }}
            />
          ))}
        </div>
      </Section>
    </>
  )
}

function CursorPanel({ settings, update }) {
  const [family, setFamily] = useState(findCursorStyle(settings.cursorStyle).family)
  return (
    <>
      <Section title="Cursor">
        <label className="flex items-center justify-between text-sm cursor-pointer">
          <span>Show cursor</span>
          <input type="checkbox" checked={settings.showCursor}
            onChange={(e) => update({ showCursor: e.target.checked })} className="accent-accent" />
        </label>
        <Slider label="Cursor size" value={settings.cursorSize} min={0.5} max={3} step={0.05}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(cursorSize) => update({ cursorSize })} />
        <label className="flex items-center justify-between text-sm cursor-pointer">
          <span className={settings.showCursor ? '' : 'text-muted'}>Follow real mouse path</span>
          <input type="checkbox" disabled={!settings.showCursor}
            checked={settings.cursorFollowsMouse}
            onChange={(e) => update({ cursorFollowsMouse: e.target.checked })} className="accent-accent" />
        </label>
        <label className="flex items-center justify-between text-sm cursor-pointer">
          <span>Hide cursor when idle</span>
          <input type="checkbox" checked={settings.hideCursorWhenIdle}
            onChange={(e) => update({ hideCursorWhenIdle: e.target.checked })} className="accent-accent" />
        </label>
        <label className="flex items-center justify-between text-sm cursor-pointer">
          <span>Click sound</span>
          <input type="checkbox" checked={settings.cursorClickSound}
            onChange={(e) => update({ cursorClickSound: e.target.checked })} className="accent-accent" />
        </label>
      </Section>

      <Section title="Cursor style">
        <div className="flex gap-1 mb-2">
          {CURSOR_FAMILIES.map((f) => (
            <button
              key={f.id}
              onClick={() => setFamily(f.id)}
              className={`px-2 py-1 text-xs rounded ${
                family === f.id ? 'bg-panel2 text-white' : 'text-muted hover:text-white/80'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-2">
          {CURSOR_STYLES.filter((c) => c.family === family).map((c) => (
            <button
              key={c.id}
              onClick={() => update({ cursorStyle: c.id })}
              title={c.label}
              className={`aspect-square rounded-md border-2 flex items-center justify-center transition ${
                settings.cursorStyle === c.id
                  ? 'border-accent bg-accent/10'
                  : 'border-panel2 hover:border-white/30'
              }`}
            >
              <div className="w-7 h-9">
                <CursorSvg style={c} />
              </div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Click effect">
        <div className="grid grid-cols-3 gap-2">
          {CLICK_EFFECTS.map((e) => (
            <button
              key={e.id}
              onClick={() => update({ clickEffect: e.id })}
              className={`aspect-square rounded-md border-2 flex flex-col items-center justify-center gap-1 text-[11px] transition ${
                settings.clickEffect === e.id
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-panel2 hover:border-white/30 text-white/80'
              }`}
            >
              <ClickEffectThumb kind={e.id} />
              {e.label}
            </button>
          ))}
        </div>
      </Section>
    </>
  )
}

function ClickEffectThumb({ kind }) {
  if (kind === 'none')
    return (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="9" />
        <line x1="4" y1="4" x2="18" y2="18" />
      </svg>
    )
  if (kind === 'ripple')
    return <span className="w-4 h-4 rounded-full bg-white/60" />
  if (kind === 'ring')
    return <span className="w-4 h-4 rounded-full border-2 border-white" />
  if (kind === 'spotlight')
    return (
      <span
        className="w-5 h-5 rounded-full"
        style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }}
      />
    )
  if (kind === 'sparkle')
    return (
      <svg width="22" height="22" viewBox="-11 -11 22 22">
        {[0, 60, 120, 180, 240, 300].map((d) => (
          <line key={d} x1="0" y1="0" x2="0" y2="-7" stroke="#fde047" strokeWidth="2" strokeLinecap="round" transform={`rotate(${d})`} />
        ))}
      </svg>
    )
  return null
}

function AnnotationsPanel({
  pendingAnnotation,
  setPendingAnnotation,
  annotations,
  selectedId,
  onSelect,
  onRemove,
  onUpdate
}) {
  const selected = annotations.find((a) => a.id === selectedId)
  return (
    <>
      <Section title="Text">
        <div className="grid grid-cols-3 gap-2">
          {ANNOTATION_TEXT_STYLES.map((s) => (
            <button
              key={s.id}
              onClick={() =>
                setPendingAnnotation({
                  kind: 'text',
                  styleId: s.id,
                  text: s.preview
                })
              }
              className={`px-2 h-12 rounded-md border-2 flex items-center justify-center text-xs transition ${
                pendingAnnotation?.styleId === s.id
                  ? 'border-accent'
                  : 'border-panel2 hover:border-white/30'
              }`}
            >
              <span className={s.cls + ' text-[11px]'}>{s.preview}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Shape">
        <div className="grid grid-cols-3 gap-2">
          {ANNOTATION_SHAPES.map((sh) => (
            <button
              key={sh.id}
              onClick={() =>
                setPendingAnnotation({ kind: 'shape', shapeId: sh.id })
              }
              className={`aspect-square rounded-md border-2 flex items-center justify-center transition ${
                pendingAnnotation?.shapeId === sh.id
                  ? 'border-accent'
                  : 'border-panel2 hover:border-white/30'
              }`}
              title={sh.label}
            >
              <ShapeThumb id={sh.id} />
            </button>
          ))}
        </div>
      </Section>

      <Section title="Mask">
        <div className="grid grid-cols-3 gap-2">
          {ANNOTATION_MASKS.map((m) => (
            <button
              key={m.id}
              onClick={() => setPendingAnnotation({ kind: 'mask', maskId: m.id })}
              className={`aspect-square rounded-md border-2 flex flex-col items-center justify-center text-[11px] gap-1 transition ${
                pendingAnnotation?.maskId === m.id
                  ? 'border-accent'
                  : 'border-panel2 hover:border-white/30'
              }`}
            >
              <MaskThumb id={m.id} />
              {m.label}
            </button>
          ))}
        </div>
      </Section>

      {selected && (
        <Section title="Selected annotation">
          <div className="text-xs text-muted">
            {selected.kind} · {formatTime(selected.start)}–{formatTime(selected.end)}
          </div>
          {selected.kind === 'text' && (
            <input
              type="text"
              value={selected.text || ''}
              onChange={(e) => onUpdate(selected.id, { text: e.target.value })}
              placeholder="Text"
              className="w-full bg-panel2 rounded px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent"
            />
          )}
          {(selected.kind === 'shape' || (selected.kind === 'text' && (selected.styleId === 'plain' || selected.styleId === 'outline'))) && (
            <ColorPicker
              label={selected.kind === 'shape' ? 'Stroke color' : 'Text color'}
              value={selected.color || (selected.kind === 'shape'
                ? (SHAPE_DEFS_DATA[selected.shapeId]?.stroke || '#ffffff')
                : '#ffffff')}
              onChange={(color) => onUpdate(selected.id, { color })}
            />
          )}
          {selected.kind === 'mask' && selected.maskId === 'blur' && (
            <Slider label="Blur radius" value={selected.blurRadius ?? 16} min={4} max={48} step={1}
              format={(v) => `${v}px`}
              onChange={(blurRadius) => onUpdate(selected.id, { blurRadius })} />
          )}
          {selected.kind === 'mask' && selected.maskId === 'spotlight' && (
            <Slider label="Darkness" value={selected.spotlightDarkness ?? 0.55} min={0.1} max={0.95} step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(spotlightDarkness) => onUpdate(selected.id, { spotlightDarkness })} />
          )}
          {selected.kind === 'mask' && selected.maskId === 'magnifier' && (
            <Slider label="Zoom" value={selected.magnifierZoom ?? 2.2} min={1.5} max={5} step={0.1}
              format={(v) => `${v.toFixed(1)}×`}
              onChange={(magnifierZoom) => onUpdate(selected.id, { magnifierZoom })} />
          )}
          <Slider label="Width" value={selected.w || 0.18} min={0.02} max={0.95} step={0.01}
            format={(v) => `${(v * 100).toFixed(0)}%`}
            onChange={(w) => onUpdate(selected.id, { w })} />
          <Slider label="Height" value={selected.h || 0.08} min={0.02} max={0.95} step={0.01}
            format={(v) => `${(v * 100).toFixed(0)}%`}
            onChange={(h) => onUpdate(selected.id, { h })} />
          <Slider label="Fade in" value={selected.fadeInMs ?? 180} min={0} max={1500} step={20}
            format={(v) => (v ? `${(v / 1000).toFixed(2)}s` : 'Off')}
            onChange={(fadeInMs) => onUpdate(selected.id, { fadeInMs })} />
          <Slider label="Fade out" value={selected.fadeOutMs ?? 180} min={0} max={1500} step={20}
            format={(v) => (v ? `${(v / 1000).toFixed(2)}s` : 'Off')}
            onChange={(fadeOutMs) => onUpdate(selected.id, { fadeOutMs })} />
          <button
            onClick={() => onRemove(selected.id)}
            className="w-full text-sm px-3 py-2 rounded-md border border-red-500/30 text-red-300 hover:bg-red-500/10"
          >
            Delete annotation
          </button>
        </Section>
      )}

      <div className="text-[11px] text-muted/70">
        {annotations.length === 0
          ? 'Pick a tool above, then click on the canvas to place it.'
          : `${annotations.length} annotation${annotations.length === 1 ? '' : 's'}.`}
      </div>
    </>
  )
}

function ShapeThumb({ id }) {
  if (id === 'line')
    return <svg width="36" height="14"><line x1="2" y1="7" x2="34" y2="7" stroke="#34d399" strokeWidth="3" strokeLinecap="round" /></svg>
  if (id === 'arrow')
    return (
      <svg width="36" height="14">
        <line x1="2" y1="7" x2="28" y2="7" stroke="#ec4899" strokeWidth="3" strokeLinecap="round" />
        <polygon points="28,2 34,7 28,12" fill="#ec4899" />
      </svg>
    )
  if (id === 'box')
    return <svg width="28" height="22"><rect x="2" y="2" width="24" height="18" stroke="#a78bfa" strokeWidth="2.5" fill="none" /></svg>
  if (id === 'box-rounded')
    return <svg width="28" height="22"><rect x="2" y="2" width="24" height="18" rx="5" stroke="#facc15" strokeWidth="2.5" fill="none" /></svg>
  if (id === 'circle')
    return <svg width="22" height="22"><circle cx="11" cy="11" r="9" stroke="#fff" strokeWidth="2.5" fill="none" /></svg>
  if (id === 'arrow-down')
    return (
      <svg width="14" height="28">
        <line x1="7" y1="2" x2="7" y2="20" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />
        <polygon points="2,20 12,20 7,26" fill="#ef4444" />
      </svg>
    )
  return null
}

function MaskThumb({ id }) {
  if (id === 'spotlight')
    return (
      <span
        className="w-5 h-5 rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.7) 0%, rgba(0,0,0,0.7) 70%)' }}
      />
    )
  if (id === 'blur')
    return (
      <span className="w-5 h-5 rounded-md" style={{ background: 'linear-gradient(135deg,#888,#bbb)', filter: 'blur(2px)' }} />
    )
  if (id === 'magnifier')
    return (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="9" cy="9" r="6" />
        <line x1="14" y1="14" x2="20" y2="20" />
      </svg>
    )
  return null
}

function ColorPicker({ label, value, onChange }) {
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-1">
        <span className="text-white/80">{label}</span>
        <span className="text-muted font-mono text-xs">{value}</span>
      </div>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-8 rounded bg-panel2 border-none cursor-pointer"
      />
    </div>
  )
}

function CameraPanel({ settings, update }) {
  const layouts = [
    { id: 'br', label: '↘' },
    { id: 'bl', label: '↙' },
    { id: 'tr', label: '↗' },
    { id: 'tl', label: '↖' },
    { id: 'full', label: 'Full' },
    { id: 'bottom-strip', label: 'Strip' }
  ]
  return (
    <>
      <Section title="Webcam">
        <label className="flex items-center justify-between text-sm cursor-pointer">
          <span>Show camera (preview only)</span>
          <input
            type="checkbox"
            checked={settings.showCamera}
            onChange={(e) => update({ showCamera: e.target.checked })}
            className="accent-accent"
          />
        </label>
        <div className="text-[11px] text-amber-300/80 bg-amber-300/5 border border-amber-300/20 rounded p-2">
          Live preview only — webcam capture during recording isn't wired in
          yet, so the export won't include this overlay.
        </div>
      </Section>

      <Section title="Layout">
        <div className="grid grid-cols-3 gap-2">
          {layouts.map((l) => (
            <button
              key={l.id}
              onClick={() => update({ cameraLayout: l.id })}
              className={`aspect-video rounded-md border-2 flex items-center justify-center text-sm transition ${
                settings.cameraLayout === l.id
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-panel2 hover:border-white/30'
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Style">
        <div className="grid grid-cols-2 gap-2">
          {['circle', 'rect'].map((s) => (
            <button
              key={s}
              onClick={() => update({ cameraShape: s })}
              className={`py-1.5 rounded text-sm border ${
                settings.cameraShape === s
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-panel2 hover:bg-panel2'
              }`}
            >
              {s === 'circle' ? 'Circle' : 'Rectangle'}
            </button>
          ))}
        </div>
        <Slider
          label="Size"
          value={settings.cameraSize}
          min={10}
          max={50}
          step={1}
          format={(v) => `${v}%`}
          onChange={(cameraSize) => update({ cameraSize })}
        />
        <label className="flex items-center justify-between text-sm cursor-pointer">
          <span>Flip horizontal</span>
          <input
            type="checkbox"
            checked={settings.cameraFlip}
            onChange={(e) => update({ cameraFlip: e.target.checked })}
            className="accent-accent"
          />
        </label>
      </Section>

      <Section title="Background">
        <div className="grid grid-cols-3 gap-2">
          {[
            { id: 'original', label: 'Original' },
            { id: 'blur', label: 'Blur' },
            { id: 'remove', label: 'Remove', disabled: true }
          ].map((b) => (
            <button
              key={b.id}
              disabled={b.disabled}
              onClick={() => update({ cameraBackground: b.id })}
              className={`py-2 rounded text-xs border transition ${
                settings.cameraBackground === b.id
                  ? 'border-accent bg-accent/10 text-accent'
                  : b.disabled
                    ? 'border-panel2 text-muted/40 cursor-not-allowed'
                    : 'border-panel2 hover:bg-panel2 text-white/80'
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-muted/70">
          Real AI background removal needs MediaPipe segmentation — coming next.
          Blur uses a CSS filter on the preview only.
        </div>
      </Section>
    </>
  )
}

function AudioPanel({ settings, update }) {
  return (
    <Section title="Microphone">
      <label className="flex items-center justify-between text-sm cursor-pointer">
        <span>Mute audio</span>
        <input
          type="checkbox"
          checked={settings.audioMuted}
          onChange={(e) => update({ audioMuted: e.target.checked })}
          className="accent-accent"
        />
      </label>
      <Slider
        label="Volume"
        value={settings.micVolume}
        min={0}
        max={2}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(micVolume) => update({ micVolume })}
      />
      <Slider
        label="Fade in"
        value={settings.audioFadeInMs}
        min={0}
        max={3000}
        step={50}
        format={(v) => (v ? `${(v / 1000).toFixed(2)}s` : 'Off')}
        onChange={(audioFadeInMs) => update({ audioFadeInMs })}
      />
      <Slider
        label="Fade out"
        value={settings.audioFadeOutMs}
        min={0}
        max={3000}
        step={50}
        format={(v) => (v ? `${(v / 1000).toFixed(2)}s` : 'Off')}
        onChange={(audioFadeOutMs) => update({ audioFadeOutMs })}
      />
    </Section>
  )
}

function CameraOverlay({ layout, shape, size, flip, background, webcamPath, mainVideoRef }) {
  const videoRef = useRef(null)
  const [error, setError] = useState(null)
  const usingRecording = !!webcamPath

  // Recorded webcam: mirror play/pause/seek from the main video.
  useEffect(() => {
    if (!usingRecording) return
    const cam = videoRef.current
    const main = mainVideoRef?.current
    if (!cam || !main) return
    const onPlay = () => cam.play().catch(() => {})
    const onPause = () => cam.pause()
    const onSeeked = () => {
      cam.currentTime = main.currentTime
    }
    const onTime = () => {
      // Re-sync if the cam drifts beyond ~120ms.
      if (Math.abs(cam.currentTime - main.currentTime) > 0.12) {
        cam.currentTime = main.currentTime
      }
    }
    main.addEventListener('play', onPlay)
    main.addEventListener('pause', onPause)
    main.addEventListener('seeked', onSeeked)
    main.addEventListener('timeupdate', onTime)
    // Initial sync.
    cam.currentTime = main.currentTime || 0
    if (!main.paused) cam.play().catch(() => {})
    return () => {
      main.removeEventListener('play', onPlay)
      main.removeEventListener('pause', onPause)
      main.removeEventListener('seeked', onSeeked)
      main.removeEventListener('timeupdate', onTime)
    }
  }, [usingRecording, mainVideoRef])

  // Live fallback: open the webcam directly when no recorded file exists.
  useEffect(() => {
    if (usingRecording) return
    let cancelled = false
    let stream = null
    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
          audio: false
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().catch(() => {})
        }
      } catch (err) {
        setError(err.message || 'Camera unavailable')
      }
    }
    start()
    return () => {
      cancelled = true
      if (stream) stream.getTracks().forEach((t) => t.stop())
    }
  }, [usingRecording])

  const sizePct = `${size}%`
  const margin = '4%'
  const positions = {
    br: { right: margin, bottom: margin },
    bl: { left: margin, bottom: margin },
    tr: { right: margin, top: margin },
    tl: { left: margin, top: margin },
    full: { inset: 0 },
    'bottom-strip': { left: 0, right: 0, bottom: 0 }
  }
  const pos = positions[layout] || positions.br

  let width, height, borderRadius
  if (layout === 'full') {
    width = '100%'
    height = '100%'
    borderRadius = 0
  } else if (layout === 'bottom-strip') {
    width = '100%'
    height = '22%'
    borderRadius = 0
  } else {
    width = sizePct
    height = 'auto'
    if (shape === 'circle') {
      // Force a square via aspect-ratio so the circle renders correctly.
      height = sizePct
      borderRadius = '50%'
    } else {
      borderRadius = 12
    }
  }

  return (
    <div
      className="absolute pointer-events-none overflow-hidden border-2 border-white/40 shadow-xl bg-black/40"
      style={{
        ...pos,
        width,
        height,
        borderRadius,
        aspectRatio: shape === 'circle' && layout !== 'full' && layout !== 'bottom-strip' ? '1 / 1' : undefined
      }}
    >
      {error ? (
        <div className="w-full h-full flex items-center justify-center text-[10px] text-white/70 px-2 text-center">
          {error}
        </div>
      ) : (
        <video
          ref={videoRef}
          src={usingRecording ? `file://${webcamPath}` : undefined}
          muted
          playsInline
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: flip ? 'scaleX(-1)' : 'none',
            filter: background === 'blur' ? 'blur(8px)' : 'none'
          }}
        />
      )}
    </div>
  )
}

function KeyboardPanel({ settings, update, hasKeyEvents }) {
  return (
    <>
      <Section title="Keystroke overlay">
        <label className="flex items-center justify-between text-sm cursor-pointer">
          <span>Show keystrokes</span>
          <input
            type="checkbox"
            checked={settings.showKeystrokes}
            onChange={(e) => update({ showKeystrokes: e.target.checked })}
            className="accent-accent"
          />
        </label>
        {!hasKeyEvents && (
          <div className="text-[11px] text-amber-300/80 bg-amber-300/5 border border-amber-300/20 rounded p-2">
            No keystrokes were captured in this recording. New recordings will
            include them automatically.
          </div>
        )}
        <div>
          <div className="text-sm mb-1">Position</div>
          <div className="grid grid-cols-2 gap-2">
            {['top', 'bottom'].map((p) => (
              <button
                key={p}
                onClick={() => update({ keystrokePosition: p })}
                className={`py-1.5 rounded text-sm border ${
                  settings.keystrokePosition === p
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-panel2 hover:bg-panel2'
                }`}
              >
                {p[0].toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-sm mb-1">Style</div>
          <div className="grid grid-cols-2 gap-2">
            {['pill', 'mac'].map((s) => (
              <button
                key={s}
                onClick={() => update({ keystrokeStyle: s })}
                className={`py-1.5 rounded text-sm border ${
                  settings.keystrokeStyle === s
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-panel2 hover:bg-panel2'
                }`}
              >
                {s === 'pill' ? 'Pill' : 'Mac key'}
              </button>
            ))}
          </div>
        </div>
        <Slider
          label="Linger"
          value={settings.keystrokeWindowMs}
          min={400}
          max={4000}
          step={100}
          format={(v) => `${(v / 1000).toFixed(1)}s`}
          onChange={(keystrokeWindowMs) => update({ keystrokeWindowMs })}
        />
      </Section>
    </>
  )
}

function WatermarkPanel({ settings, update }) {
  return (
    <>
      <Section title="Watermark">
        <label className="flex items-center justify-between text-sm cursor-pointer">
          <span>Enable</span>
          <input
            type="checkbox"
            checked={settings.watermarkEnabled}
            onChange={(e) => update({ watermarkEnabled: e.target.checked })}
            className="accent-accent"
          />
        </label>
        <div>
          <div className="text-sm mb-1">Text</div>
          <input
            type="text"
            value={settings.watermarkText}
            onChange={(e) => update({ watermarkText: e.target.value })}
            placeholder="@yourhandle"
            className="w-full bg-panel2 rounded px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div>
          <div className="text-sm mb-1">Position</div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'top-left', label: '↖ Top L' },
              { id: 'top-right', label: 'Top R ↗' },
              { id: 'bottom-left', label: '↙ Bot L' },
              { id: 'bottom-right', label: 'Bot R ↘' }
            ].map((p) => (
              <button
                key={p.id}
                onClick={() => update({ watermarkPosition: p.id })}
                className={`py-1.5 rounded text-xs border ${
                  settings.watermarkPosition === p.id
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-panel2 hover:bg-panel2'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <Slider
          label="Size"
          value={settings.watermarkSize}
          min={10}
          max={48}
          step={1}
          format={(v) => `${v}px`}
          onChange={(watermarkSize) => update({ watermarkSize })}
        />
        <Slider
          label="Opacity"
          value={settings.watermarkOpacity}
          min={0.1}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(watermarkOpacity) => update({ watermarkOpacity })}
        />
      </Section>
    </>
  )
}

function KeyboardOverlay({ keys, position, style }) {
  const wrapStyle = {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    [position === 'top' ? 'top' : 'bottom']: '6%',
    pointerEvents: 'none',
    display: 'flex',
    gap: 6
  }
  return (
    <div style={wrapStyle}>
      {keys.slice(-8).map((k, idx) => {
        const labelParts = []
        if (k.meta) labelParts.push('⌘')
        if (k.ctrl) labelParts.push('⌃')
        if (k.alt) labelParts.push('⌥')
        if (k.shift && k.label.length > 1) labelParts.push('⇧')
        labelParts.push(k.label.length === 1 ? k.label.toUpperCase() : k.label)
        const text = labelParts.join(' ')
        const isMac = style === 'mac'
        return (
          <span
            key={`${k.timestamp}-${idx}`}
            className={
              isMac
                ? 'bg-white/95 text-black px-2 py-1 rounded-md shadow-md font-mono text-sm border border-black/10'
                : 'bg-black/75 text-white px-2.5 py-1 rounded-full text-sm font-medium backdrop-blur-sm'
            }
          >
            {text}
          </span>
        )
      })}
    </div>
  )
}

function Watermark({ text, position, opacity, size }) {
  const [v, h] = position.split('-')
  const style = {
    position: 'absolute',
    [v]: '4%',
    [h]: '4%',
    color: 'white',
    fontSize: size,
    fontWeight: 600,
    letterSpacing: 0.5,
    opacity,
    pointerEvents: 'none',
    textShadow: '0 1px 3px rgba(0,0,0,0.6)'
  }
  return <div style={style}>{text}</div>
}

function SelectedZoomPanel({ zoom, durationMs, onChange, onDelete, onPickCenter, centerPicking }) {
  return (
    <Section title="Selected zoom">
      <Slider label="Zoom level" value={zoom.zoomLevel} min={1.2} max={3.5} step={0.05}
        format={(v) => `${v.toFixed(2)}×`}
        onChange={(zoomLevel) => onChange({ zoomLevel })} />
      <Slider label="Ease in" value={zoom.peakStart - zoom.start} min={120} max={800} step={20}
        format={(v) => `${Math.round(v)}ms`}
        onChange={(d) => onChange({ peakStart: zoom.start + d })} />
      <Slider label="Hold" value={zoom.peakEnd - zoom.peakStart} min={300} max={4000} step={50}
        format={(v) => `${Math.round(v)}ms`}
        onChange={(d) => onChange({ peakEnd: zoom.peakStart + d })} />
      <Slider label="Ease out" value={zoom.end - zoom.peakEnd} min={120} max={800} step={20}
        format={(v) => `${Math.round(v)}ms`}
        onChange={(d) => onChange({ end: zoom.peakEnd + d })} />
      <div className="pt-1">
        <div className="text-sm mb-2">Zoom center</div>
        <div className="flex gap-2 items-center text-xs text-muted mb-2">
          <span className="font-mono">x: {(zoom.cx * 100).toFixed(0)}%</span>
          <span className="font-mono">y: {(zoom.cy * 100).toFixed(0)}%</span>
        </div>
        <button
          onClick={onPickCenter}
          className={`w-full text-sm px-3 py-2 rounded-md border ${
            centerPicking ? 'border-accent bg-accent/10 text-accent' : 'border-panel2 hover:bg-panel2'
          }`}
        >
          {centerPicking ? 'Click on preview…' : 'Click on preview to set'}
        </button>
      </div>
      <button
        onClick={onDelete}
        className="w-full text-sm px-3 py-2 rounded-md border border-red-500/30 text-red-300 hover:bg-red-500/10"
      >
        Delete zoom
      </button>
    </Section>
  )
}

function DefaultsPanel({ exportSettings, updateExportSettings, onResetZooms }) {
  return (
    <Section title="Zoom defaults">
      <Slider label="Zoom level" value={exportSettings.zoomLevel} min={1.2} max={3.0} step={0.1}
        format={(v) => `${v.toFixed(1)}×`}
        onChange={(zoomLevel) => updateExportSettings({ zoomLevel })} />
      <Slider label="Ease in" value={exportSettings.easeInDuration} min={150} max={600} step={20}
        format={(v) => `${v}ms`}
        onChange={(easeInDuration) => updateExportSettings({ easeInDuration })} />
      <Slider label="Hold" value={exportSettings.holdDuration} min={500} max={2500} step={50}
        format={(v) => `${v}ms`}
        onChange={(holdDuration) => updateExportSettings({ holdDuration })} />
      <Slider label="Ease out" value={exportSettings.easeOutDuration} min={150} max={600} step={20}
        format={(v) => `${v}ms`}
        onChange={(easeOutDuration) => updateExportSettings({ easeOutDuration })} />
      <button
        onClick={onResetZooms}
        className="w-full text-xs px-3 py-2 rounded-md border border-panel2 hover:bg-panel2 text-muted"
      >
        Reset zooms from clicks
      </button>
    </Section>
  )
}

function Section({ title, children }) {
  return (
    <div>
      <h3 className="text-[11px] uppercase tracking-wider text-muted mb-3 font-medium">{title}</h3>
      <div className="space-y-3.5">{children}</div>
    </div>
  )
}

function Slider({ label, value, min, max, step, onChange, format }) {
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-1">
        <span className="text-white/80">{label}</span>
        <span className="text-muted font-mono text-xs">{format ? format(value) : value}</span>
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

function formatTime(ms) {
  if (!isFinite(ms)) ms = 0
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
