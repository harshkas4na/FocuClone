import { createRequire } from 'module'
const require = createRequire(import.meta.url)

let uIOhook = null
let UiohookMouseButton = null
let UiohookKey = null
let loadError = null

try {
  const mod = require('uiohook-napi')
  uIOhook = mod.uIOhook
  UiohookMouseButton = mod.UiohookMouseButton
  UiohookKey = mod.UiohookKey
} catch (err) {
  loadError = err
  console.warn('[mouseTracker] uiohook-napi not available:', err.message)
}

// Maps a uiohook keycode to a short display label. Printable characters use
// the unicode keychar from the event when available; everything else falls
// back to a curated lookup of common modifier/navigation keys.
const KEY_LABELS = {
  // Modifiers
  29: 'Ctrl', 3613: 'Ctrl',
  56: 'Alt',  3640: 'Alt',
  42: 'Shift', 54: 'Shift',
  3675: '⌘',  3676: '⌘',
  // Navigation
  14: '⌫',    // Backspace
  15: '⇥',    // Tab
  28: '⏎',    // Enter
  57: 'Space',
  1: 'Esc',
  3675: '⌘',
  // Arrows
  57416: '↑', 57424: '↓', 57419: '←', 57421: '→',
  // Function row
  59: 'F1', 60: 'F2', 61: 'F3', 62: 'F4', 63: 'F5', 64: 'F6',
  65: 'F7', 66: 'F8', 67: 'F9', 68: 'F10', 87: 'F11', 88: 'F12'
}

function labelFromKeyEvent(e) {
  if (e.keychar && e.keychar > 31 && e.keychar < 127) {
    return String.fromCharCode(e.keychar)
  }
  return KEY_LABELS[e.keycode] || null
}

let events = []
let recordStart = 0
let tracking = false
let screenSize = { w: 1920, h: 1080 }
let listenersAttached = false
let throttleLastMove = 0

function onMouseMove(e) {
  if (!tracking) return
  const now = Date.now()
  if (now - throttleLastMove < 16) return
  throttleLastMove = now
  events.push({
    type: 'move',
    x: e.x,
    y: e.y,
    timestamp: now - recordStart,
    button: null,
    screenW: screenSize.w,
    screenH: screenSize.h
  })
}

function onMouseClick(e) {
  if (!tracking) return
  let button = 'left'
  if (UiohookMouseButton && e.button === UiohookMouseButton.RIGHT) button = 'right'
  else if (e.button === 2) button = 'right'
  events.push({
    type: 'click',
    x: e.x,
    y: e.y,
    timestamp: Date.now() - recordStart,
    button,
    screenW: screenSize.w,
    screenH: screenSize.h
  })
}

function onKeyDown(e) {
  if (!tracking) return
  const label = labelFromKeyEvent(e)
  if (!label) return
  events.push({
    type: 'key',
    label,
    timestamp: Date.now() - recordStart,
    shift: !!e.shiftKey,
    meta: !!e.metaKey,
    ctrl: !!e.ctrlKey,
    alt: !!e.altKey
  })
}

export function isAvailable() {
  return uIOhook != null
}

export function getLoadError() {
  return loadError
}

export function startTracking(startMs, sw, sh) {
  if (!uIOhook) {
    console.warn('[mouseTracker] hook unavailable; recording without click tracking')
    events = []
    recordStart = startMs
    screenSize = { w: sw, h: sh }
    tracking = true
    return
  }
  events = []
  recordStart = startMs
  screenSize = { w: sw, h: sh }
  tracking = true

  if (!listenersAttached) {
    uIOhook.on('mousemove', onMouseMove)
    uIOhook.on('mousedown', onMouseClick)
    uIOhook.on('keydown', onKeyDown)
    listenersAttached = true
  }

  try {
    uIOhook.start()
  } catch (err) {
    console.error('[mouseTracker] failed to start:', err)
  }
}

export function stopTracking() {
  tracking = false
  if (uIOhook) {
    try {
      uIOhook.stop()
    } catch (err) {
      console.error('[mouseTracker] failed to stop:', err)
    }
  }
  return events.slice()
}
