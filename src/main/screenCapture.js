// Spawns the native ScreenCaptureKit helper (src/native/ScreenCaptureKitRecorder.swift)
// and drives it over JSON-line stdio. The helper writes mp4 directly via
// AVAssetWriter, so when this path is active we skip the renderer's
// MediaRecorder + appendChunk pipeline entirely.

import { spawn } from 'child_process'
import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import os from 'os'

function helperPath() {
  const arch = process.arch === 'x64' ? 'darwin-x64' : 'darwin-arm64'
  // Packaged: resources/native/<arch>/focuclone-screen-capture
  // Dev: <repo>/resources/native/<arch>/focuclone-screen-capture
  if (app.isPackaged) {
    return join(process.resourcesPath, 'native', arch, 'focuclone-screen-capture')
  }
  return join(app.getAppPath(), 'resources', 'native', arch, 'focuclone-screen-capture')
}

export function isAvailable() {
  if (process.platform !== 'darwin') return false
  return existsSync(helperPath())
}

let proc = null
let buffer = ''
let onEvent = null

function handleStdout(chunk) {
  buffer += chunk.toString('utf8')
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    try {
      const obj = JSON.parse(line)
      if (onEvent) onEvent(obj)
    } catch {
      // Not JSON — log helper's stderr-via-stdout (rare) for diagnostics.
      if (onEvent) onEvent({ event: 'log', message: line })
    }
  }
}

// Spawn helper, wait for {event:"ready"}, then send start. Resolves with the
// `started` event payload or rejects if the helper errors before starting.
export function startNative(
  {
    outputPath,
    displayId = 0,
    width,
    height,
    fps = 60,
    showCursor = true,
    captureSystemAudio = false,
    captureMic = false
  },
  eventCb
) {
  if (proc) throw new Error('native recorder already running')
  const bin = helperPath()
  if (!existsSync(bin)) throw new Error(`native helper missing: ${bin}`)

  return new Promise((resolve, reject) => {
    onEvent = (evt) => {
      eventCb && eventCb(evt)
      if (evt.event === 'ready') {
        proc.stdin.write(
          JSON.stringify({
            cmd: 'start',
            outputPath,
            displayId,
            width,
            height,
            fps,
            showCursor,
            captureSystemAudio,
            captureMic
          }) + '\n'
        )
      } else if (evt.event === 'started') {
        resolve(evt)
      } else if (evt.event === 'error') {
        reject(new Error(evt.message || 'native recorder error'))
      }
    }

    proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    proc.stdout.on('data', handleStdout)
    proc.stderr.on('data', (d) => eventCb && eventCb({ event: 'stderr', message: d.toString('utf8') }))
    proc.on('exit', (code) => {
      if (proc) {
        const _p = proc
        proc = null
        if (code !== 0 && eventCb) eventCb({ event: 'exit', code })
        // If start hadn't resolved yet, surface the failure.
        reject(new Error(`native recorder exited (code ${code}) before start`))
        _p
      }
    })
  })
}

// Send stop, wait for {event:"stopped"} or process exit.
export function stopNative() {
  if (!proc) return Promise.resolve(null)
  return new Promise((resolve) => {
    const prev = onEvent
    let resolved = false
    const finish = (payload) => {
      if (resolved) return
      resolved = true
      onEvent = null
      resolve(payload)
    }
    onEvent = (evt) => {
      prev && prev(evt)
      if (evt.event === 'stopped') finish(evt)
      if (evt.event === 'error') finish({ event: 'error', message: evt.message })
    }
    proc.on('exit', () => finish(null))
    try {
      proc.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n')
    } catch {
      finish(null)
    }
  })
}

// Hard-cancel: ask helper to quit and kill the process if it doesn't exit promptly.
export async function cancelNative() {
  if (!proc) return
  try {
    proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n')
  } catch {}
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try { proc && proc.kill('SIGKILL') } catch {}
      resolve()
    }, 1500)
    proc && proc.on('exit', () => { clearTimeout(t); resolve() })
  })
  proc = null
  onEvent = null
  buffer = ''
}

export function defaultOutputDir() {
  return join(os.tmpdir(), 'focuclone-native')
}
