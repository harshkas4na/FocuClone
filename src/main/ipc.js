import { ipcMain, desktopCapturer, screen, shell, dialog, app } from 'electron'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import {
  startNewSession,
  appendChunk,
  appendWebcamChunk,
  finalizeSession,
  discardSession
} from './fileWriter.js'
import {
  startTracking,
  stopTracking,
  isAvailable as mouseTrackerAvailable
} from './mouseTracker.js'
import { processVideo } from './processor.js'
import {
  isAvailable as nativeRecorderAvailable,
  startNative,
  stopNative,
  cancelNative,
  defaultOutputDir as nativeRecorderDir
} from './screenCapture.js'
import { promises as fsp } from 'fs'

let recordStartMs = 0
let activeScreenSize = { w: 1920, h: 1080 }

export function registerIpcHandlers(getWindow) {
  ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 300 },
      fetchWindowIcons: true
    })
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      display_id: s.display_id,
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon ? s.appIcon.toDataURL() : null
    }))
  })

  ipcMain.handle('get-screen-size', async () => {
    const display = screen.getPrimaryDisplay()
    return {
      width: display.size.width,
      height: display.size.height,
      scaleFactor: display.scaleFactor,
      bounds: display.bounds
    }
  })

  ipcMain.handle('start-recording', async (_e, { sourceId, screenSize, withCamera }) => {
    activeScreenSize = screenSize || activeScreenSize
    const session = await startNewSession({ withCamera: !!withCamera })
    recordStartMs = Date.now()
    startTracking(recordStartMs, activeScreenSize.w, activeScreenSize.h)
    return {
      sessionId: session.id,
      videoPath: session.videoPath,
      webcamPath: session.webcamPath,
      recordStart: recordStartMs,
      mouseTrackerAvailable: mouseTrackerAvailable()
    }
  })

  ipcMain.handle('write-chunk', async (_e, buffer) => {
    return appendChunk(buffer)
  })

  ipcMain.handle('write-webcam-chunk', async (_e, buffer) => {
    return appendWebcamChunk(buffer)
  })

  ipcMain.handle('stop-recording', async () => {
    const events = stopTracking()
    const stopAt = Date.now()
    const duration = stopAt - recordStartMs
    const result = await finalizeSession({
      recordStart: recordStartMs,
      duration,
      screenW: activeScreenSize.w,
      screenH: activeScreenSize.h,
      events
    })
    return result
  })

  ipcMain.handle('cancel-recording', async () => {
    stopTracking()
    await discardSession()
    return { ok: true }
  })

  ipcMain.handle('process-video', async (_e, { session, opts }) => {
    const win = getWindow()
    const send = (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }
    try {
      const outputPath = await processVideo(
        session,
        opts,
        (pct) => send('export-progress', pct),
        (msg) => send('export-log', msg)
      )
      return { ok: true, outputPath }
    } catch (err) {
      send('export-log', `ERROR: ${err.message}`)
      return { ok: false, error: err.message }
    }
  })

  // Renderer rasterizes a few PNGs (cursor skin, rounded-corner mask) for the
  // current export and asks main to drop them in a temp folder. We hand back
  // the absolute path so the processor can reference them in the filtergraph.
  ipcMain.handle('save-temp-asset', async (_e, { name, buffer }) => {
    const dir = join(app.getPath('temp'), 'focuclone-export')
    await fs.mkdir(dir, { recursive: true })
    const path = join(dir, name)
    await fs.writeFile(path, Buffer.from(buffer))
    return { path }
  })

  // ── Native ScreenCaptureKit recorder ────────────────────────────────────
  // Lives in parallel with the existing MediaRecorder pipeline so callers
  // can opt in. The mouseTracker still runs (clicks/keys/cursor moves) — it
  // doesn't care which capture path is producing the video.
  let nativeSessionMeta = null

  ipcMain.handle('native-recorder-available', async () => ({
    available: nativeRecorderAvailable(),
    platform: process.platform
  }))

  ipcMain.handle('start-native-recording', async (_e, opts = {}) => {
    if (!nativeRecorderAvailable()) {
      return { ok: false, error: 'native recorder helper missing' }
    }
    const win = getWindow()
    const send = (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }

    activeScreenSize = opts.screenSize || activeScreenSize
    const dir = nativeRecorderDir()
    await fsp.mkdir(dir, { recursive: true })
    const outputPath = join(dir, `focuclone-${Date.now()}.mp4`)

    try {
      const started = await startNative(
        {
          outputPath,
          displayId: opts.displayId || 0,
          width: opts.width || activeScreenSize.w,
          height: opts.height || activeScreenSize.h,
          fps: opts.fps || 60,
          showCursor: opts.showCursor !== false,
          captureSystemAudio: !!opts.captureSystemAudio,
          captureMic: !!opts.captureMic
        },
        (evt) => send('native-recorder-event', evt)
      )
      recordStartMs = Date.now()
      startTracking(recordStartMs, activeScreenSize.w, activeScreenSize.h)
      nativeSessionMeta = { outputPath, started, recordStart: recordStartMs }
      return {
        ok: true,
        outputPath,
        recordStart: recordStartMs,
        mouseTrackerAvailable: mouseTrackerAvailable(),
        ...started
      }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('stop-native-recording', async () => {
    if (!nativeSessionMeta) return { ok: false, error: 'no active native recording' }
    const events = stopTracking()
    const stopAt = Date.now()
    const duration = stopAt - nativeSessionMeta.recordStart
    const result = await stopNative()
    if (!result || result.event !== 'stopped') {
      const meta = nativeSessionMeta
      nativeSessionMeta = null
      return {
        ok: false,
        error: result?.message || 'native recorder did not stop cleanly',
        partialPath: meta.outputPath
      }
    }
    // Mirror the renderer-MediaRecorder session shape so Editor/Export consume
    // it identically. We write a session.json next to the mp4.
    const dir = dirname(result.outputPath)
    const sessionId = `native-${nativeSessionMeta.recordStart}`
    const sessionJson = {
      id: sessionId,
      videoPath: result.outputPath,
      webcamPath: null,
      recordStart: nativeSessionMeta.recordStart,
      duration,
      screenW: activeScreenSize.w,
      screenH: activeScreenSize.h,
      events,
      mouseTrackerAvailable: mouseTrackerAvailable(),
      capture: 'screencapturekit',
      frames: result.frames || 0
    }
    const sessionPath = join(dir, `${sessionId}.session.json`)
    await fsp.writeFile(sessionPath, JSON.stringify(sessionJson, null, 2), 'utf8')
    nativeSessionMeta = null
    return { ok: true, ...sessionJson, sessionPath, dir }
  })

  ipcMain.handle('cancel-native-recording', async () => {
    if (nativeSessionMeta) stopTracking()
    await cancelNative()
    if (nativeSessionMeta) {
      try { await fsp.unlink(nativeSessionMeta.outputPath) } catch {}
      nativeSessionMeta = null
    }
    return { ok: true }
  })

  ipcMain.handle('open-in-finder', async (_e, filePath) => {
    shell.showItemInFolder(filePath)
    return { ok: true }
  })

  ipcMain.handle('show-save-dialog', async (_e, defaultPath) => {
    const result = await dialog.showSaveDialog({
      defaultPath,
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
    })
    return result
  })
}
