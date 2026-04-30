import { ipcMain, desktopCapturer, screen, shell, dialog } from 'electron'
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
