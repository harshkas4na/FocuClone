import { create } from 'zustand'

const HISTORY_LIMIT = 50

function snapshot(state) {
  return {
    zooms: state.zooms,
    trim: state.trim,
    annotations: state.annotations
  }
}

// Continuous gestures (dragging a zoom block, scrubbing a slider) emit one
// update per mousemove. Pushing a history entry for each flooded the undo
// stack — one drag ate all 50 slots and made ⌘Z useless. Coalesce: repeated
// edits with the same key inside COALESCE_MS collapse into a single undo
// step (the snapshot taken at the start of the burst).
const COALESCE_MS = 800
let lastHistKey = null
let lastHistTime = 0

function pushHistory(state, key = null) {
  const now = Date.now()
  if (key && key === lastHistKey && now - lastHistTime < COALESCE_MS) {
    lastHistTime = now
    return { future: [] }
  }
  lastHistKey = key
  lastHistTime = now
  const next = [...state.past, snapshot(state)]
  if (next.length > HISTORY_LIMIT) next.shift()
  return { past: next, future: [] }
}

export const useSession = create((set, get) => ({
  screen: 'home',
  source: null,
  micEnabled: false,
  micDeviceId: 'default',
  systemAudioEnabled: false,
  cameraEnabled: false,
  cameraDeviceId: 'default',
  session: null,
  zooms: [],
  // Which session the current zooms array was derived for. Editor only
  // re-derives zooms from click events when this doesn't match session.id —
  // otherwise remounting the Editor (e.g. Editor → Export → back) would
  // clobber every manual zoom edit.
  zoomsSessionId: null,
  selectedZoomId: null,
  trim: { inMs: 0, outMs: null }, // outMs=null → full duration
  annotations: [],
  selectedAnnotationId: null,
  activePanel: 'background', // background | cursor | annotations
  past: [],
  future: [],
  exportSettings: {
    // Defaults match DEFAULT_TIMELINE_OPTS in lib/zoomTimeline.js — continuous
    // zoom model with click retargeting (FocuSee / Screen Studio feel).
    zoomLevel: 1.5,
    easeInDuration: 150,
    holdDuration: 700,
    easeOutDuration: 200,
    clusterMergeGapMs: 2500,
    clusterPadMs: 60,
    // Camera-follow strategy during a held zoom. 'dead-zone' = anchor at the
    // click; pan only when the cursor leaves the safe band. 'soft' = legacy
    // constant-k follow.
    cursorFollowMode: 'dead-zone',
    cursorFollowSafeZone: 0.6, // fraction of viewport that's "free" for the cursor
    cursorFollowAmount: 0.7,   // soft-follow strength when mode='soft'
    // Cursor
    showCursor: true,
    cursorFollowsMouse: true,
    cursorSize: 1.0, // multiplier, 0.5–3.0
    cursorStyle: 'arrow-white', // see CURSOR_STYLES in Editor
    clickEffect: 'ripple', // none | ripple | ring | spotlight | sparkle
    hideCursorWhenIdle: false,
    cursorClickSound: false,
    // Canvas / background
    canvasAspect: 'original', // original | 16:9 | 1:1 | 4:3 | 9:16
    padding: 5, // 0–20 (% of shorter canvas side)
    inset: 0, // 0–10 (% of shorter side, inner border)
    insetColor: '#000000',
    roundness: 4, // 0–30 (% of inset short side; matches preview AND export)
    shadow: 80, // 0–200 (shadow blur radius factor)
    backgroundKind: 'wallpaper', // solid | gradient | wallpaper
    backgroundValue: 'wallpaper-1',
    // Keyboard overlay
    showKeystrokes: false,
    keystrokePosition: 'bottom', // bottom | top
    keystrokeStyle: 'pill', // pill | mac
    keystrokeWindowMs: 1500, // recent keys to display
    // Camera (PiP). Live preview only for now — capture-while-recording is
    // deferred. The schema is still useful so the layout chooser persists.
    showCamera: false,
    cameraLayout: 'br', // br | bl | tr | tl | full | bottom-strip
    cameraShape: 'circle', // circle | rect
    cameraSize: 22, // % of canvas shorter side
    cameraFlip: false,
    cameraBackground: 'original', // original | blur | (future: remove, image)
    // Audio
    micVolume: 1.0, // 0–2
    audioFadeInMs: 0,
    audioFadeOutMs: 0,
    audioMuted: false,
    // Watermark
    watermarkEnabled: false,
    watermarkText: 'FocuClone',
    watermarkPosition: 'bottom-right', // top-left | top-right | bottom-left | bottom-right
    watermarkOpacity: 0.7,
    watermarkSize: 14,
    // Export
    quality: 23,
    fps: 30,
    useVideoToolbox: true
  },
  exportResult: null,

  // True while a capture is in flight (countdown / recording / stopping).
  // The Stepper locks navigation so the user can't abandon a live recorder.
  recordingActive: false,
  setRecordingActive: (recordingActive) => set({ recordingActive }),

  goto: (screen) => set({ screen }),
  setSource: (source) => set({ source }),
  setMicEnabled: (micEnabled) => set({ micEnabled }),
  setMicDeviceId: (micDeviceId) => set({ micDeviceId }),
  setSystemAudioEnabled: (systemAudioEnabled) => set({ systemAudioEnabled }),
  setCameraEnabled: (cameraEnabled) => set({ cameraEnabled }),
  setCameraDeviceId: (cameraDeviceId) => set({ cameraDeviceId }),
  setSession: (session) => set({ session }),

  // Initial zoom population from events should NOT push to history (it's the
  // "starting state" the user can return to via reset).
  setZooms: (zooms, sessionId) =>
    set((s) => ({
      zooms,
      past: [],
      future: [],
      zoomsSessionId: sessionId !== undefined ? sessionId : s.zoomsSessionId
    })),
  selectZoom: (selectedZoomId) => set({ selectedZoomId }),

  addZoom: (zoom) =>
    set((s) => ({
      ...pushHistory(s),
      zooms: [...s.zooms, zoom].sort((a, b) => a.start - b.start),
      selectedZoomId: zoom.id
    })),
  removeZoom: (id) =>
    set((s) => ({
      ...pushHistory(s),
      zooms: s.zooms.filter((z) => z.id !== id),
      selectedZoomId: s.selectedZoomId === id ? null : s.selectedZoomId
    })),
  updateZoom: (id, patch) =>
    set((s) => ({
      ...pushHistory(s, `zoom:${id}`),
      zooms: s.zooms
        .map((z) => (z.id === id ? { ...z, ...patch } : z))
        .sort((a, b) => a.start - b.start)
    })),

  setTrim: (trim) =>
    set((s) => ({
      ...pushHistory(s, 'trim'),
      trim: { ...s.trim, ...trim }
    })),

  setActivePanel: (activePanel) => set({ activePanel, selectedZoomId: null }),

  addAnnotation: (annotation) =>
    set((s) => ({
      ...pushHistory(s),
      annotations: [...s.annotations, annotation],
      selectedAnnotationId: annotation.id
    })),
  removeAnnotation: (id) =>
    set((s) => ({
      ...pushHistory(s),
      annotations: s.annotations.filter((a) => a.id !== id),
      selectedAnnotationId: s.selectedAnnotationId === id ? null : s.selectedAnnotationId
    })),
  updateAnnotation: (id, patch) =>
    set((s) => ({
      ...pushHistory(s, `ann:${id}`),
      annotations: s.annotations.map((a) => (a.id === id ? { ...a, ...patch } : a))
    })),
  selectAnnotation: (selectedAnnotationId) => set({ selectedAnnotationId }),

  undo: () =>
    set((s) => {
      if (s.past.length === 0) return {}
      const prev = s.past[s.past.length - 1]
      const past = s.past.slice(0, -1)
      const future = [...s.future, snapshot(s)]
      return { ...prev, past, future }
    }),
  redo: () =>
    set((s) => {
      if (s.future.length === 0) return {}
      const next = s.future[s.future.length - 1]
      const future = s.future.slice(0, -1)
      const past = [...s.past, snapshot(s)]
      return { ...next, past, future }
    }),

  updateExportSettings: (patch) =>
    set((s) => ({ exportSettings: { ...s.exportSettings, ...patch } })),
  setExportResult: (exportResult) => set({ exportResult }),
  reset: () =>
    set({
      screen: 'home',
      source: null,
      session: null,
      zooms: [],
      zoomsSessionId: null,
      selectedZoomId: null,
      annotations: [],
      selectedAnnotationId: null,
      activePanel: 'background',
      trim: { inMs: 0, outMs: null },
      past: [],
      future: [],
      exportResult: null
    })
}))
