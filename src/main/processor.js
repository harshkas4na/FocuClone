import ffmpegPath from 'ffmpeg-static'
import { spawn } from 'child_process'
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import {
  zoomsFromEvents,
  clickWindowsFromZooms,
  buildZoomExpressionsFromZooms,
  decimateMoves,
  applyTrimToZooms,
  applyTrimToMoves,
  buildCursorSendcmd
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
      const hasAudio = /Stream\s*#\d+:\d+(?:\(\w+\))?:\s*Audio:/i.test(stderr)
      resolve({ duration: dur, dims, fps, hasAudio, raw: stderr })
    })
  })
}

export async function processVideo(session, opts = {}, onProgress, onLog) {
  const ffmpegBin = resolveFfmpegPath()
  if (!ffmpegBin) throw new Error('ffmpeg-static path not resolved')

  const {
    outputPath,
    fps: requestedFps,
    showCursor = true,
    cursorFollowsMouse = true,
    quality = 23,
    useVideoToolbox = true,
    zooms: providedZooms,
    trim,
    // New background pipeline (preferred). When `bgFfmpeg` is present we use
    // the continuous padding + arbitrary backdrop path; otherwise fall back to
    // the legacy `background` enum for older callers.
    bgFfmpeg,
    padding = 5, // % of canvas shorter side
    canvasAspectRatio,
    background = 'none',
    watermarkEnabled = false,
    watermarkText = '',
    watermarkPosition = 'bottom-right',
    watermarkOpacity = 0.7,
    watermarkSize = 14,
    showCamera = false,
    cameraLayout = 'br',
    cameraShape = 'circle',
    cameraSize = 22,
    cameraFlip = false,
    micVolume = 1.0,
    audioFadeInMs = 0,
    audioFadeOutMs = 0,
    audioMuted = false
  } = opts

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

  // Trim handling — input-side seek so the output timeline starts at 0
  const fullDurMs = probe.duration * 1000
  const trimInMs = Math.max(0, Math.min(trim?.inMs || 0, fullDurMs))
  const trimOutMs = Math.min(fullDurMs, Math.max(trimInMs + 100, trim?.outMs || fullDurMs))
  const outDurMs = trimOutMs - trimInMs
  const outDurSec = outDurMs / 1000

  const baseZooms =
    providedZooms && providedZooms.length >= 0
      ? providedZooms
      : zoomsFromEvents(session.events || [], opts)

  const zooms = applyTrimToZooms(baseZooms, trimInMs, outDurMs)
  const decimated = applyTrimToMoves(
    decimateMoves(session.events || [], { cursorMoveSampleHz: 30, cursorMoveMinDeltaPx: 4 }),
    trimInMs,
    outDurMs
  )

  onLog && onLog(
    `[processor] input ${inW}x${inH} ${probe.fps}fps, dur ${probe.duration.toFixed(2)}s; ` +
    `trim ${(trimInMs/1000).toFixed(2)}–${(trimOutMs/1000).toFixed(2)}s; ` +
    `${zooms.length} zooms, ${decimated.length} mouse samples\n`
  )

  const zoomExpr = buildZoomExpressionsFromZooms(zooms, 'time')
  const zSafe = `max(${zoomExpr.zExpr},1)`
  if (zooms.length === 0) {
    onLog && onLog('[processor] WARNING: zooms array is empty — exported video will have no zoom effects\n')
  } else {
    onLog && onLog(`[processor] applying ${zooms.length} zoom regions; first peak ${zooms[0]?.zoomLevel}× at ${(zooms[0]?.peakStart/1000).toFixed(2)}s\n`)
  }
  const xExpr = `clip((${zoomExpr.cxExpr})*iw - iw/(2*(${zSafe})), 0, iw - iw/(${zSafe}))`
  const yExpr = `clip((${zoomExpr.cyExpr})*ih - ih/(2*(${zSafe})), 0, ih - ih/(${zSafe}))`

  const filterChain = []
  filterChain.push(
    `[0:v]fps=${fps},zoompan=z='${zSafe}':x='${xExpr}':y='${yExpr}':d=1:s=${W}x${H}:fps=${fps}[zoomed]`
  )
  let currentLabel = '[zoomed]'
  const extraInputs = []
  let nextInputIdx = 1

  const cursorWindows = clickWindowsFromZooms(zooms)
  let cursorAvailable = false
  if (showCursor && cursorWindows.length > 0) {
    const cursorPath = resolveCursorPath()
    try {
      await fs.access(cursorPath)
      cursorAvailable = true
      extraInputs.push('-i', cursorPath)
    } catch {
      onLog && onLog(`[processor] cursor.png missing, skipping cursor overlay\n`)
    }
  }

  let cmdsFilePath = null
  if (cursorAvailable) {
    const cursorIdx = nextInputIdx++
    const enableExpr = cursorWindows
      .map((w) => `between(t,${(w.start / 1000).toFixed(3)},${(w.end / 1000).toFixed(3)})`)
      .join('+')

    if (cursorFollowsMouse) {
      // Pre-compute per-frame cursor x,y as sendcmd commands
      const cursorW = 44
      const cursorH = 52 // 40x48 SVG scaled to 44 wide preserves ~1.2 ratio
      const cmds = buildCursorSendcmd({
        zooms,
        decimatedMoves: decimated,
        W,
        H,
        cursorW,
        cursorH,
        fps,
        durSec: outDurSec
      })
      // Persist cmd file alongside the session
      const sessionDir = dirname(rawVideoPath)
      cmdsFilePath = join(sessionDir, 'cursor_cmds.txt')
      await fs.writeFile(cmdsFilePath, cmds, 'utf8')
      onLog && onLog(`[processor] wrote cursor cmds: ${cmds.split('\n').length} lines\n`)

      // Append `,sendcmd=f='…'` into the zoompan chain so commands are
      // dispatched to the named overlay@ov filter downstream.
      filterChain.pop()
      filterChain.push(
        `[0:v]fps=${fps},zoompan=z='${zSafe}':x='${xExpr}':y='${yExpr}':d=1:s=${W}x${H}:fps=${fps},sendcmd=f='${cmdsFilePath}'[zoomed]`
      )
      filterChain.push(`[${cursorIdx}:v]scale=${cursorW}:-1[cur]`)
      filterChain.push(
        `${currentLabel}[cur]overlay@ov=x=${Math.round(W / 2)}:y=${Math.round(H / 2)}:eval=frame:enable='${enableExpr}':format=auto[withcur]`
      )
    } else {
      filterChain.push(`[${cursorIdx}:v]scale=44:-1[cur]`)
      filterChain.push(
        `${currentLabel}[cur]overlay=x=(W-w)/2:y=(H-h)/2:enable='${enableExpr}':format=auto[withcur]`
      )
    }
    currentLabel = '[withcur]'
  }

  // Resolve final output canvas size. If the user picked a non-source aspect
  // ratio, keep the source height and recompute width (or vice-versa) so the
  // inner video can be letterboxed inside a properly-shaped backdrop.
  const sourceAspect = W / H
  const targetAspect = canvasAspectRatio || sourceAspect
  let canvasW = W
  let canvasH = H
  if (Math.abs(targetAspect - sourceAspect) > 0.005) {
    if (targetAspect > sourceAspect) {
      canvasW = Math.round(H * targetAspect)
    } else {
      canvasH = Math.round(W / targetAspect)
    }
    canvasW -= canvasW % 2
    canvasH -= canvasH % 2
  }

  // Resolve the backdrop descriptor (preferred) or fall back to legacy enum.
  let resolvedBg = bgFfmpeg
  if (!resolvedBg) {
    if (background === 'wallpaper') resolvedBg = { type: 'gradient', c0: '0x0e1230', c1: '0x2a1149' }
    else if (background === 'rounded') resolvedBg = { type: 'solid', color: '0x101014' }
  }

  const hasFrame = !!resolvedBg || canvasW !== W || canvasH !== H
  if (hasFrame) {
    const padPx = Math.max(0, Math.round((Math.min(canvasW, canvasH) * (padding || 0)) / 100))
    const availW = canvasW - 2 * padPx
    const availH = canvasH - 2 * padPx
    // Fit source-aspect rectangle into avail box (contain).
    let innerW, innerH
    if (availW / availH > sourceAspect) {
      innerH = availH
      innerW = Math.round(innerH * sourceAspect)
    } else {
      innerW = availW
      innerH = Math.round(innerW / sourceAspect)
    }
    innerW -= innerW % 2
    innerH -= innerH % 2
    const offX = Math.round((canvasW - innerW) / 2)
    const offY = Math.round((canvasH - innerH) / 2)

    if (resolvedBg) {
      if (resolvedBg.type === 'gradient') {
        extraInputs.push(
          '-f', 'lavfi',
          '-i', `gradients=size=${canvasW}x${canvasH}:c0=${resolvedBg.c0}:c1=${resolvedBg.c1}:type=linear:duration=999:speed=0.00001:rate=${fps}`
        )
      } else {
        extraInputs.push(
          '-f', 'lavfi',
          '-i', `color=size=${canvasW}x${canvasH}:color=${resolvedBg.color}:rate=${fps}`
        )
      }
    } else {
      // Aspect change without explicit backdrop → black letterbox.
      extraInputs.push('-f', 'lavfi', '-i', `color=size=${canvasW}x${canvasH}:color=0x000000:rate=${fps}`)
    }
    const bgIdx = nextInputIdx++
    filterChain.push(`${currentLabel}scale=${innerW}:${innerH}[inset]`)
    filterChain.push(
      `[${bgIdx}:v]trim=duration=${(outDurSec + 1).toFixed(2)},setpts=PTS-STARTPTS[bg]`
    )
    filterChain.push(`[bg][inset]overlay=x=${offX}:y=${offY}:format=auto[composed]`)
    currentLabel = '[composed]'
  }

  // Webcam PiP — only if the recording captured one and the user kept the
  // toggle on in the editor. Sized in pixels relative to the *canvas*, then
  // overlaid at the chosen corner / strip / full layout.
  if (showCamera && session.webcamPath) {
    let webcamAvailable = false
    try {
      await fs.access(session.webcamPath)
      webcamAvailable = true
    } catch {
      onLog && onLog(`[processor] webcam.webm missing, skipping camera overlay\n`)
    }
    if (webcamAvailable) {
      extraInputs.push('-i', session.webcamPath)
      const camIdx = nextInputIdx++
      const shortSide = Math.min(canvasW, canvasH)
      const margin = Math.round(shortSide * 0.04)
      const corner = Math.max(2, Math.round((shortSide * cameraSize) / 100))

      let camW, camH, posX, posY, mask = false
      if (cameraLayout === 'full') {
        camW = canvasW; camH = canvasH; posX = 0; posY = 0
      } else if (cameraLayout === 'bottom-strip') {
        camH = Math.round(canvasH * 0.22)
        camW = canvasW
        posX = 0
        posY = canvasH - camH
      } else {
        // Corner layouts. For circle we render square; for rect we keep 16:9.
        if (cameraShape === 'circle') {
          camW = corner; camH = corner; mask = true
        } else {
          camW = corner
          camH = Math.round(corner * 9 / 16)
        }
        camW -= camW % 2
        camH -= camH % 2
        switch (cameraLayout) {
          case 'tl': posX = margin; posY = margin; break
          case 'tr': posX = canvasW - camW - margin; posY = margin; break
          case 'bl': posX = margin; posY = canvasH - camH - margin; break
          default:   posX = canvasW - camW - margin; posY = canvasH - camH - margin
        }
      }

      // Build the cam preprocessing chain. We supersample 2× before masking
      // so the circular alpha edge gets antialiased by the downscale, then
      // feather the alpha by ~1.5 px for a softer rim. Without this the geq
      // mask aliases hard pixel-stairs along the circle.
      const flipPart = cameraFlip ? 'hflip,' : ''
      const SS = 2 // supersample factor
      const ssW = camW * SS
      const ssH = camH * SS
      const cropToFit = `scale=${ssW}:${ssH}:force_original_aspect_ratio=increase,crop=${ssW}:${ssH}`
      let camChain = `[${camIdx}:v]${flipPart}${cropToFit}`
      if (mask) {
        const rOuter = ssW / 2
        const rInner = rOuter - SS * 1.5 // 1.5-px feather at output scale
        const cx = rOuter
        const cy = rOuter
        // Feathered alpha: 255 inside `rInner`, 0 outside `rOuter`, smooth in
        // between. Implemented with clip(255 * (rOuter - dist) / feather).
        const feather = rOuter - rInner
        camChain +=
          `,format=yuva420p,geq=` +
          `r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':` +
          `a='clip(255*((${rOuter}) - sqrt((X-${cx})*(X-${cx})+(Y-${cy})*(Y-${cy})))/${feather.toFixed(3)}, 0, 255)'`
      }
      // Downsample back to target size with a high-quality kernel.
      camChain += `,scale=${camW}:${camH}:flags=lanczos[cam_pp]`
      filterChain.push(camChain)

      filterChain.push(
        `${currentLabel}[cam_pp]overlay=x=${posX}:y=${posY}:format=auto[withcam]`
      )
      currentLabel = '[withcam]'
      onLog && onLog(`[processor] camera overlay ${camW}×${camH} at (${posX},${posY}) layout=${cameraLayout}\n`)
    }
  }

  // Watermark — drawtext is fontconfig-free when no fontfile is given on
  // macOS but rendering quality varies; using a generic approach.
  if (watermarkEnabled && watermarkText) {
    const safeText = watermarkText
      .replace(/\\/g, '\\\\')
      .replace(/:/g, '\\:')
      .replace(/'/g, "\\'")
    const xy = (() => {
      const margin = 24
      switch (watermarkPosition) {
        case 'top-left': return `x=${margin}:y=${margin}`
        case 'top-right': return `x=w-tw-${margin}:y=${margin}`
        case 'bottom-left': return `x=${margin}:y=h-th-${margin}`
        default: return `x=w-tw-${margin}:y=h-th-${margin}`
      }
    })()
    const alpha = Math.max(0, Math.min(1, watermarkOpacity)).toFixed(2)
    filterChain.push(
      `${currentLabel}drawtext=text='${safeText}':fontcolor=white@${alpha}:fontsize=${Math.round(watermarkSize)}:${xy}:shadowcolor=black@0.5:shadowx=1:shadowy=1[wm]`
    )
    currentLabel = '[wm]'
  }

  filterChain.push(`${currentLabel}format=yuv420p[final]`)

  // Audio chain: only built when audio isn't muted. We branch off the source
  // audio stream (0:a) and apply volume + optional fades; the final filter
  // graph adds an [aud] label that we map below.
  const wantAudio = !audioMuted && probe.hasAudio
  if (!probe.hasAudio) {
    onLog && onLog('[processor] source has no audio stream; skipping audio chain\n')
  }
  if (wantAudio) {
    const fadeInS = Math.max(0, audioFadeInMs / 1000)
    const fadeOutS = Math.max(0, audioFadeOutMs / 1000)
    const parts = [`[0:a]volume=${(micVolume || 0).toFixed(3)}`]
    if (fadeInS > 0.01) parts.push(`afade=t=in:st=0:d=${fadeInS.toFixed(3)}`)
    if (fadeOutS > 0.01) {
      const startOut = Math.max(0, outDurSec - fadeOutS)
      parts.push(`afade=t=out:st=${startOut.toFixed(3)}:d=${fadeOutS.toFixed(3)}`)
    }
    filterChain.push(parts.join(',') + '[aud]')
  }

  const filterComplex = filterChain.join(';')
  onLog && onLog(`[processor] filter_complex (${filterComplex.length} chars)\n`)

  // Input seek for trim — placing -ss BEFORE -i is fast (keyframe seek) and
  // shifts the input timeline so output starts at 0.
  const inputArgs = []
  if (trimInMs > 0) inputArgs.push('-ss', (trimInMs / 1000).toFixed(3))
  if (trimOutMs < fullDurMs) inputArgs.push('-to', (trimOutMs / 1000).toFixed(3))
  inputArgs.push('-i', rawVideoPath)

  const args = [
    '-y',
    '-hide_banner',
    ...inputArgs,
    ...extraInputs,
    '-filter_complex',
    filterComplex,
    '-map',
    '[final]'
  ]
  if (wantAudio) {
    args.push('-map', '[aud]', '-c:a', 'aac', '-b:a', '160k')
  } else {
    args.push('-an')
  }
  if (useVideoToolbox) args.push('-c:v', 'h264_videotoolbox', '-b:v', '8M')
  else args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', String(quality))
  args.push('-movflags', '+faststart', finalOutPath)

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args)
    let stderrBuf = ''
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString()
      stderrBuf += s
      onLog && onLog(s)
      const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/)
      if (m && outDurSec > 0) {
        const cur = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])
        onProgress && onProgress(Math.min(100, (cur / outDurSec) * 100))
      }
    })
    proc.on('error', reject)
    proc.on('close', (code, signal) => {
      // Best-effort cleanup of cmds file
      if (cmdsFilePath) fs.unlink(cmdsFilePath).catch(() => {})
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
