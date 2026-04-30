import { createRequire } from 'module'
const require = createRequire(import.meta.url)

let uIOhook = null
let UiohookMouseButton = null
let loadError = null

try {
  const mod = require('uiohook-napi')
  uIOhook = mod.uIOhook
  UiohookMouseButton = mod.UiohookMouseButton
} catch (err) {
  loadError = err
  console.warn('[mouseTracker] uiohook-napi not available:', err.message)
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
