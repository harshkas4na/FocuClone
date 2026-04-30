import ffmpegPath from 'ffmpeg-static'
import { spawn } from 'child_process'
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import {
  buildClickWindows,
  buildZoomExpressions
} from './zoomTimeline.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function resolveFfmpegPath() {
  if (!ffmpegPath) return null
  return app.isPackaged ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : ffmpegPath
}

function resolveCursorPath() {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'cursor.png')
    : join(__dirname, '../../resources/cursor.png')
}

async function probeStream(ffmpegBin, inputPath) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegBin, ['-hide_banner', '-i', inputPath])
    let stderr = ''
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('close', () => {
      const dur = (() => {
        const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
        if (!m) return 0
        return +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])
      })()
      // Robust dim parser: find first WxH on a Video: line. Pix-fmt parens may
      // contain commas, so we don't try to count fields — just match \d+x\d+.
      const dims = (() => {
        const lines = stderr.split('\n').filter((l) => /Video:/i.test(l))
        for (const line of lines) {
          const m = line.match(/(\d{2,5})x(\d{2,5})/)
          if (m) return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) }
        }
        return null
      })()
      const fps = (() => {
        const m = stderr.match(/(\d+(?:\.\d+)?)\s*fps/)
        return m ? parseFloat(m[1]) : 30
      })()
      resolve({ duration: dur, dims, fps, raw: stderr })
    })
  })
}

export async function processVideo(session, opts = {}, onProgress, onLog) {
  const ffmpegBin = resolveFfmpegPath()
  if (!ffmpegBin) throw new Error('ffmpeg-static path not resolved')

  const {
    outputPath,
    fps: requestedFps,
    zoomLevel = 2.0,
    easeInDuration = 280,
    holdDuration = 1200,
    easeOutDuration = 360,
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

  const probe = await probeStream(ffmpegBin, rawVideoPath)
  if (!probe.dims) {
    onLog && onLog(`[probe failed]\n${probe.raw}\n`)
    throw new Error('Could not probe input video dimensions')
  }
  const inW = probe.dims.w
  const inH = probe.dims.h
  const W = inW - (inW % 2)
  const H = inH - (inH % 2)
  const fps = requestedFps || Math.round(probe.fps) || 30
  onLog && onLog(`[processor] input ${inW}x${inH} ${probe.fps}fps, ${probe.duration.toFixed(2)}s\n`)

  const tlOpts = {
    zoomLevel,
    easeInDuration,
    holdDuration,
    easeOutDuration,
    minTimeBetweenZooms
  }

  const windows = buildClickWindows(events, tlOpts)

  // zoompan uses 'time' as the output time variable
  const zoom = buildZoomExpressions(windows, tlOpts, 'time')

  const zSafe = `max(${zoom.zExpr},1)`
  const xExpr = `clip((${zoom.cxExpr})*iw - iw/(2*(${zSafe})), 0, iw - iw/(${zSafe}))`
  const yExpr = `clip((${zoom.cyExpr})*ih - ih/(2*(${zSafe})), 0, ih - ih/(${zSafe}))`

  const filterChain = []

  filterChain.push(
    `[0:v]fps=${fps},zoompan=z='${zSafe}':x='${xExpr}':y='${yExpr}':d=1:s=${W}x${H}:fps=${fps}[zoomed]`
  )

  let currentLabel = '[zoomed]'
  const extraInputs = []
  let nextInputIdx = 1 // [0:v] is the raw video input

  // ── Cursor overlay ───────────────────────────────────────────────────────
  // The zoom is centered on the click, so during each click window the click
  // point lands at output center. We anchor the cursor PNG there for the
  // duration of each window and fade it in/out via the `enable` mask.
  let cursorAvailable = false
  if (showCursor && windows.length > 0) {
    const cursorPath = resolveCursorPath()
    try {
      await fs.access(cursorPath)
      cursorAvailable = true
      extraInputs.push('-i', cursorPath)
    } catch {
      onLog && onLog(`[processor] cursor.png missing, skipping cursor overlay\n`)
    }
  }

  if (cursorAvailable) {
    const cursorIdx = nextInputIdx++
    const enableExpr = windows
      .map((w) => `between(t,${(w.start / 1000).toFixed(3)},${(w.end / 1000).toFixed(3)})`)
      .join('+')
    filterChain.push(`[${cursorIdx}:v]scale=44:-1[cur]`)
    filterChain.push(
      `${currentLabel}[cur]overlay=x=(W-w)/2:y=(H-h)/2:enable='${enableExpr}':format=auto[withcur]`
    )
    currentLabel = '[withcur]'
  }

  // ── Background style ────────────────────────────────────────────────────
  if (background === 'rounded' || background === 'wallpaper') {
    // Padded inset over a colored/gradient backdrop. Use lavfi `gradients`
    // for wallpaper, solid color for rounded-only.
    const padPct = 0.92 // video occupies 92% of width
    const innerW = Math.round(W * padPct) - (Math.round(W * padPct) % 2)
    const innerH = Math.round(innerW * (H / W)) - (Math.round(innerW * (H / W)) % 2)
    const offX = Math.round((W - innerW) / 2)
    const offY = Math.round((H - innerH) / 2)

    if (background === 'wallpaper') {
      extraInputs.push(
        '-f', 'lavfi',
        '-i', `gradients=size=${W}x${H}:c0=0x0e1230:c1=0x2a1149:type=linear:duration=999:speed=0.00001:rate=${fps}`
      )
    } else {
      extraInputs.push(
        '-f', 'lavfi',
        '-i', `color=size=${W}x${H}:color=0x101014:rate=${fps}`
      )
    }
    const bgIdx = nextInputIdx++
    filterChain.push(`${currentLabel}scale=${innerW}:${innerH}[inset]`)
    filterChain.push(
      `[${bgIdx}:v]trim=duration=${(probe.duration + 1).toFixed(2)},setpts=PTS-STARTPTS[bg]`
    )
    filterChain.push(`[bg][inset]overlay=x=${offX}:y=${offY}:format=auto[composed]`)
    currentLabel = '[composed]'
  }

  filterChain.push(`${currentLabel}format=yuv420p[final]`)

  const filterComplex = filterChain.join(';')
  onLog && onLog(`[processor] filter_complex (${filterComplex.length} chars)\n`)

  const args = [
    '-y',
    '-hide_banner',
    '-i',
    rawVideoPath,
    ...extraInputs,
    '-filter_complex',
    filterComplex,
    '-map',
    '[final]',
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

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args)
    let stderrBuf = ''

    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString()
      stderrBuf += s
      onLog && onLog(s)
      const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/)
      if (m && probe.duration > 0) {
        const cur = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])
        onProgress && onProgress(Math.min(100, (cur / probe.duration) * 100))
      }
    })

    proc.on('error', reject)
    proc.on('close', (code, signal) => {
      if (code === 0) {
        onProgress && onProgress(100)
        resolve(finalOutPath)
      } else {
        const tail = stderrBuf.slice(-3500)
        reject(new Error(`ffmpeg exit code=${code} signal=${signal}\n${tail}`))
      }
    })
  })
}
