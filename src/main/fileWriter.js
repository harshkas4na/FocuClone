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

export async function startNewSession() {
  const id = uuidv4()
  const dir = join(appRoot(), id)
  await fs.mkdir(dir, { recursive: true })
  const videoPath = join(dir, 'raw.webm')
  const writer = createWriteStream(videoPath)
  activeSession = { id, dir, videoPath, writer, bytes: 0 }
  return { id, dir, videoPath }
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

export async function finalizeSession(meta) {
  if (!activeSession) throw new Error('No active session')
  const { id, dir, videoPath, writer } = activeSession
  await new Promise((resolve) => writer.end(resolve))

  const sessionJson = {
    id,
    videoPath,
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
  const { dir, writer } = activeSession
  await new Promise((resolve) => writer.end(resolve))
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  activeSession = null
}
