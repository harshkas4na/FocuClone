import { app } from 'electron'
import { promises as fs, createWriteStream } from 'fs'
import { join } from 'path'
import { v4 as uuidv4 } from 'uuid'

function appRoot() {
  return join(app.getPath('userData'), 'sessions')
}

export async function ensureAppDirs() {
  await fs.mkdir(appRoot(), { recursive: true })
}

let activeSession = null

export async function startNewSession({ withCamera = false } = {}) {
  const id = uuidv4()
  const dir = join(appRoot(), id)
  await fs.mkdir(dir, { recursive: true })
  const videoPath = join(dir, 'raw.webm')
  const writer = createWriteStream(videoPath)
  activeSession = { id, dir, videoPath, writer, bytes: 0, webcamPath: null, webcamWriter: null, webcamBytes: 0 }
  if (withCamera) {
    activeSession.webcamPath = join(dir, 'webcam.webm')
    activeSession.webcamWriter = createWriteStream(activeSession.webcamPath)
  }
  return { id, dir, videoPath, webcamPath: activeSession.webcamPath }
}

export function appendChunk(buffer) {
  if (!activeSession) throw new Error('No active session')
  return new Promise((resolve, reject) => {
    activeSession.bytes += buffer.byteLength
    activeSession.writer.write(Buffer.from(buffer), (err) => {
      if (err) reject(err)
      else resolve(activeSession.bytes)
    })
  })
}

export function appendWebcamChunk(buffer) {
  if (!activeSession || !activeSession.webcamWriter) {
    // Nothing to do — webcam wasn't enabled at session start.
    return Promise.resolve(0)
  }
  return new Promise((resolve, reject) => {
    activeSession.webcamBytes += buffer.byteLength
    activeSession.webcamWriter.write(Buffer.from(buffer), (err) => {
      if (err) reject(err)
      else resolve(activeSession.webcamBytes)
    })
  })
}

export async function finalizeSession(meta) {
  if (!activeSession) throw new Error('No active session')
  const { id, dir, videoPath, writer, webcamPath, webcamWriter, webcamBytes } = activeSession
  await new Promise((resolve) => writer.end(resolve))
  if (webcamWriter) {
    await new Promise((resolve) => webcamWriter.end(resolve))
  }

  const sessionJson = {
    id,
    videoPath,
    webcamPath: webcamWriter && webcamBytes > 0 ? webcamPath : null,
    ...meta
  }
  const sessionPath = join(dir, 'session.json')
  await fs.writeFile(sessionPath, JSON.stringify(sessionJson, null, 2), 'utf8')
  const result = { ...sessionJson, sessionPath, dir }
  activeSession = null
  return result
}

export async function discardSession() {
  if (!activeSession) return
  const { dir, writer, webcamWriter } = activeSession
  await new Promise((resolve) => writer.end(resolve))
  if (webcamWriter) await new Promise((resolve) => webcamWriter.end(resolve))
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  activeSession = null
}
