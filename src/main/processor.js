import ffmpegPath from 'ffmpeg-static'
import { spawn } from 'child_process'
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { buildZoomTimeline, buildClickWindows } from './zoomTimeline.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function resolveFfmpegPath() {
  if (!ffmpegPath) return null
  if (app.isPackaged) {
    return ffmpegPath.replace('app.asar', 'app.asar.unpacked')
  }
  return ffmpegPath
}

function resolveCursorPath() {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources', 'cursor.png')
  }
  return join(__dirname, '../../resources/cursor.png')
}

function buildPiecewiseExpr(keyframes, field, defaultVal) {
  if (!keyframes.length) return String(defaultVal)
  let expr = String(keyframes[keyframes.length - 1][field] ?? defaultVal)
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const k0 = keyframes[i]
    const k1 = keyframes[i + 1]
    const v0 = k0[field] ?? defaultVal
    const v1 = k1[field] ?? defaultVal
    const dt = k1.t - k0.t
    if (dt <= 0) continue
    const lerp = `(${v0}+(${v1}-${v0})*(t-${k0.t})/${dt})`
    expr = `if(between(t,${k0.t},${k1.t}),${lerp},${expr})`
  }
  return expr
}

async function probeDuration(ffmpegBin, inputPath) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegBin, ['-i', inputPath])
    let stderr = ''
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
      if (m) {
        const h = parseInt(m[1], 10)
        const min = parseInt(m[2], 10)
        const s = parseFloat(m[3])
        resolve(h * 3600 + min * 60 + s)
      } else {
        resolve(0)
      }
    })
  })
}

export async function processVideo(session, opts = {}, onProgress, onLog) {
  const ffmpegBin = resolveFfmpegPath()
  if (!ffmpegBin) throw new Error('ffmpeg-static path not resolved')

  const {
    outputPath,
    fps = 30,
    zoomLevel = 2.0,
    easeInDuration = 300,
    holdDuration = 1200,
    easeOutDuration = 300,
    minTimeBetweenZooms = 800,
    showCursor = true,
    quality = 23,
    background = 'none',
    useVideoToolbox = true
  } = opts

  const events = session.events || []
  const rawVideoPath = session.videoPath
  const moviesDir = join(os.homedir(), 'Movies', 'FocuClone')
  await fs.mkdir(moviesDir, { recursive: true })
  const finalOutPath = outputPath || join(moviesDir, `focuclone_${Date.now()}.mp4`)

  const keyframesMs = buildZoomTimeline(events, {
    zoomLevel,
    easeInDuration,
    holdDuration,
    easeOutDuration,
    minTimeBetweenZooms,
    sampleCount: 5
  })
  const kf = keyframesMs.map((k) => ({ ...k, t: k.t / 1000 }))

  const totalDur = await probeDuration(ffmpegBin, rawVideoPath)

  const filterChain = []

  let zExpr = '1'
  let cxExpr = '0.5'
  let cyExpr = '0.5'
  if (kf.length > 0) {
    zExpr = buildPiecewiseExpr(kf, 'zoom', 1)
    cxExpr = buildPiecewiseExpr(kf, 'cx', 0.5)
    cyExpr = buildPiecewiseExpr(kf, 'cy', 0.5)
  }

  // crop=cw:ch:x:y where cw=iw/z, ch=ih/z, centered on (cx*iw, cy*ih)
  const cropW = `iw/(${zExpr})`
  const cropH = `ih/(${zExpr})`
  const cropX = `clip((${cxExpr})*iw - (iw/(${zExpr}))/2, 0, iw - iw/(${zExpr}))`
  const cropY = `clip((${cyExpr})*ih - (ih/(${zExpr}))/2, 0, ih - ih/(${zExpr}))`

  const baseLabel = '[0:v]'
  const zoomedFilter = `${baseLabel}fps=${fps},crop=${cropW}:${cropH}:${cropX}:${cropY},scale=iw*(${zExpr}):ih*(${zExpr}):eval=frame[zoomed]`
  filterChain.push(zoomedFilter)

  // cursor overlay
  let outLabel = '[zoomed]'
  let extraInputs = []
  if (showCursor) {
    const cursorPath = resolveCursorPath()
    try {
      await fs.access(cursorPath)
      extraInputs = ['-i', cursorPath]
      const windows = buildClickWindows(events, {
        easeInDuration,
        holdDuration,
        easeOutDuration,
        minTimeBetweenZooms
      })

      // Build piecewise overlay x/y in OUTPUT pixel space
      // After crop+scale the output is the original video size, but the visible content
      // is the zoomed crop region. The cursor click position in output pixels is:
      //   ox = (click.x_norm - crop_x_norm) * iw * zoom    (but in output we already scaled)
      // Simpler: in zoomed output, the cursor location for a click at normalized (cx,cy)
      // ends up dead-center in the visible frame ⇒ at (W/2, H/2) of output scaled.
      // We compute per-window expressions so cursor follows clicks.

      // Simpler v1: place cursor at output center during each click window
      // since we zoom centered on the click. This looks correct.
      const enableExpr =
        windows.length === 0
          ? '0'
          : windows.map((w) => `between(t,${w.start / 1000},${w.end / 1000})`).join('+')

      const cursorScale = `[1:v]scale=40:40[cur]`
      filterChain.push(cursorScale)
      filterChain.push(
        `${outLabel}[cur]overlay=x=(W-w)/2:y=(H-h)/2:enable='${enableExpr}':eval=frame[withcur]`
      )
      outLabel = '[withcur]'
    } catch (err) {
      onLog && onLog(`[processor] cursor.png not found, skipping overlay: ${err.message}`)
    }
  }

  // background style: rounded — pad + drop shadow not trivial in ffmpeg; do simple pad
  if (background === 'rounded') {
    filterChain.push(
      `${outLabel}pad=iw+80:ih+80:40:40:color=0x101014,format=yuv420p[final]`
    )
    outLabel = '[final]'
  } else {
    filterChain.push(`${outLabel}format=yuv420p[final]`)
    outLabel = '[final]'
  }

  const filterComplex = filterChain.join(';')

  const args = [
    '-y',
    '-i',
    rawVideoPath,
    ...extraInputs,
    '-filter_complex',
    filterComplex,
    '-map',
    outLabel,
    '-map',
    '0:a?',
    '-c:a',
    'aac',
    '-b:a',
    '160k'
  ]

  if (useVideoToolbox) {
    args.push('-c:v', 'h264_videotoolbox', '-b:v', '8M')
  } else {
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', String(quality))
  }

  args.push('-movflags', '+faststart', finalOutPath)

  onLog && onLog(`[processor] running ffmpeg: ${args.join(' ')}`)

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args)
    let stderrBuf = ''

    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString()
      stderrBuf += s
      onLog && onLog(s)
      const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/)
      if (m && totalDur > 0) {
        const cur = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3])
        const pct = Math.min(100, (cur / totalDur) * 100)
        onProgress && onProgress(pct)
      }
    })

    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        onProgress && onProgress(100)
        resolve(finalOutPath)
      } else {
        reject(new Error(`ffmpeg exited ${code}\n${stderrBuf.slice(-2000)}`))
      }
    })
  })
}
