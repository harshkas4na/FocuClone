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
import {
  bakeCameraTrajectory,
  buildBakedZoomExpressions,
  buildCursorSendcmdFromBaked
} from './cameraBake.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function resolveFfmpegPath() {
  if (!ffmpegPath) return null
  return app.isPackaged ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : ffmpegPath
}

function resolveCursorPath(cursorPngPath) {
  // Renderer-rasterized skin wins. Otherwise fall back to the bundled default.
  if (cursorPngPath) return cursorPngPath
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
      const audioStreams = stderr.match(/Stream\s*#\d+:\d+(?:\(\w+\))?:\s*Audio:/gi) || []
      const hasAudio = audioStreams.length > 0
      const audioStreamCount = audioStreams.length
      resolve({ duration: dur, dims, fps, hasAudio, audioStreamCount, raw: stderr })
    })
  })
}

// Fallback duration probe for inputs whose container has no Duration header
// (chunked WebM from MediaRecorder is the common one). Reads the last
// packet's PTS via `ffmpeg -i input -map 0:v -f null -` — slower than a header
// peek but always accurate.
async function probeDurationByDecode(ffmpegBin, inputPath) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegBin, [
      '-hide_banner', '-nostats', '-i', inputPath,
      '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'
    ])
    let stderr = ''
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('close', () => {
      // FFmpeg reports the final mux time on the last `time=HH:MM:SS.ms` line.
      const matches = stderr.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g) || []
      if (!matches.length) return resolve(0)
      const last = matches[matches.length - 1]
      const m = last.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
      if (!m) return resolve(0)
      resolve(+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]))
    })
    proc.on('error', () => resolve(0))
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
    audioMuted = false,
    cursorSize = 1.0,
    cursorPngPath = null,
    cursorFollowMode = 'dead-zone',
    cursorFollowSafeZone = 0.6,
    cursorFollowAmount = 0.7,
    roundedMaskPngPath = null,
    roundedMaskW = 0,
    roundedMaskH = 0,
    showKeystrokes = false,
    keystrokePosition = 'bottom',
    keystrokeWindowMs = 1500,
    annotations: annotationOverlays = [],
    clickEffects = null
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

  // Duration handling. Chunked MediaRecorder WebM has no container Duration
  // header, so `probe.duration` is 0 — that previously collapsed every
  // downstream calculation (trim → 0, zooms dropped, cursor cmds empty,
  // annotations skipped) and produced an effect-free re-encode. Falls back
  // in order: probe header → renderer-supplied session.duration → decode the
  // whole file and read the last packet's PTS.
  let probeDurSec = probe.duration
  if (!(probeDurSec > 0) && session?.duration > 0) {
    probeDurSec = session.duration / 1000
    onLog && onLog(`[processor] probe duration empty, using session.duration=${probeDurSec.toFixed(2)}s\n`)
  }
  if (!(probeDurSec > 0)) {
    probeDurSec = await probeDurationByDecode(ffmpegBin, rawVideoPath)
    onLog && onLog(`[processor] fell back to decode-probe duration=${probeDurSec.toFixed(2)}s\n`)
  }
  if (!(probeDurSec > 0)) {
    throw new Error('Could not determine input video duration')
  }

  // Trim handling — input-side seek so the output timeline starts at 0
  const fullDurMs = probeDurSec * 1000
  const trimInMs = Math.max(0, Math.min(trim?.inMs || 0, fullDurMs))
  const trimOutMs = Math.min(
    fullDurMs,
    Math.max(trimInMs + 100, (trim?.outMs ?? null) ? trim.outMs : fullDurMs)
  )
  const outDurMs = trimOutMs - trimInMs
  const outDurSec = outDurMs / 1000

  // Renderer is the source of truth — Editor.jsx auto-populates zooms from
  // click events on mount. Only fall back to deriving them here if the
  // renderer didn't pass an array at all (e.g. older callers / scripted use).
  // The previous `length >= 0` guard was always true and caused empty arrays
  // to silently bypass the fallback, killing zoom + cursor effects.
  const baseZooms = Array.isArray(providedZooms)
    ? providedZooms
    : zoomsFromEvents(session.events || [], opts)

  const zooms = applyTrimToZooms(baseZooms, trimInMs, outDurMs)
  // Match the renderer's decimation so the cursor sample grid is identical.
  // 60 Hz / 2 px threshold — denser than before so slow drags stay smooth.
  const decimated = applyTrimToMoves(
    decimateMoves(session.events || [], { cursorMoveSampleHz: 60, cursorMoveMinDeltaPx: 2 }),
    trimInMs,
    outDurMs
  )

  onLog && onLog(
    `[processor] input ${inW}x${inH} ${probe.fps}fps, dur ${probeDurSec.toFixed(2)}s; ` +
    `trim ${(trimInMs/1000).toFixed(2)}–${(trimOutMs/1000).toFixed(2)}s; ` +
    `${zooms.length} zooms, ${decimated.length} mouse samples\n`
  )

  // Bake the spring-smoothed, cursor-following camera into piecewise-linear
  // FFmpeg expressions so the export matches the live preview. Falls back to
  // the legacy cubic expressions when there are no zooms (keyframes empty)
  // — same `1` zoom expression either way, costs nothing.
  const cameraKeyframes =
    zooms.length > 0
      ? bakeCameraTrajectory({
          zooms,
          moves: decimated,
          durSec: outDurSec,
          cursorFollowMode,
          cursorFollowSafeZone,
          cursorFollowAmount
        })
      : []
  const zoomExpr =
    cameraKeyframes.length > 0
      ? buildBakedZoomExpressions(cameraKeyframes, 'time')
      : buildZoomExpressionsFromZooms(zooms, 'time')
  const zSafe = `max(${zoomExpr.zExpr},1)`
  if (zooms.length === 0) {
    onLog && onLog('[processor] WARNING: zooms array is empty — exported video will have no zoom effects\n')
  } else {
    onLog && onLog(
      `[processor] baked camera: ${cameraKeyframes.length} keyframes from ${zooms.length} zoom regions; ` +
      `first peak ${zooms[0]?.zoomLevel}× at ${(zooms[0]?.peakStart/1000).toFixed(2)}s\n`
    )
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
  if (showCursor) {
    const cursorPath = resolveCursorPath(cursorPngPath)
    try {
      await fs.access(cursorPath)
      cursorAvailable = true
      extraInputs.push('-i', cursorPath)
      onLog && onLog(`[processor] cursor: ${cursorPath}\n`)
    } catch {
      onLog && onLog(`[processor] cursor PNG missing (${cursorPath}), skipping cursor overlay\n`)
    }
  }

  // Fixed-position cursor (centered) only makes sense around clicks; if we
  // have no clicks and the cursor isn't following the mouse, there's nothing
  // useful to draw. Skip the overlay in that case.
  if (cursorAvailable && !cursorFollowsMouse && cursorWindows.length === 0) {
    cursorAvailable = false
    onLog && onLog('[processor] fixed cursor with no click windows — skipping cursor overlay\n')
  }

  let cmdsFilePath = null
  if (cursorAvailable) {
    const cursorIdx = nextInputIdx++
    // Follows-mouse cursor is drawn for the full output (matches the preview).
    // Fixed cursor is gated to click windows since it has no per-frame
    // position and centering it for the whole video would look broken.
    const enableExpr = cursorFollowsMouse
      ? '1'
      : cursorWindows
          .map((w) => `between(t,${(w.start / 1000).toFixed(3)},${(w.end / 1000).toFixed(3)})`)
          .join('+')

    if (cursorFollowsMouse) {
      // Pre-compute per-frame cursor x,y as sendcmd commands. The size slider
      // (cursorSize) multiplies the base 44×52 footprint.
      const cursorW = Math.max(8, Math.round(44 * cursorSize))
      const cursorH = Math.max(8, Math.round(52 * cursorSize)) // ~1.2 ratio
      // Use the baked trajectory if available so cursor placement stays
      // locked to the camera (otherwise the cursor lags the spring-smoothed
      // pan/zoom). Falls back to the cubic-curve cursor builder for the
      // no-keyframes path.
      const cmds =
        cameraKeyframes.length > 0
          ? buildCursorSendcmdFromBaked({
              keyframes: cameraKeyframes,
              decimatedMoves: decimated,
              W,
              H,
              cursorW,
              cursorH,
              fps,
              durSec: outDurSec
            })
          : buildCursorSendcmd({
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
      const fixedCursorW = Math.max(8, Math.round(44 * cursorSize))
      filterChain.push(`[${cursorIdx}:v]scale=${fixedCursorW}:-1[cur]`)
      filterChain.push(
        `${currentLabel}[cur]overlay=x=(W-w)/2:y=(H-h)/2:enable='${enableExpr}':format=auto[withcur]`
      )
    }
    currentLabel = '[withcur]'
  }

  // Annotation overlays + blur masks. Each entry is either a PNG to overlay
  // (text, shapes, spotlight) or one of the FFmpeg-side masks:
  //   • blur     → boxblur on a crop of the underlying stream, overlaid back
  //   • magnifier→ crop + scale-up + alpha-mask circle + overlay
  // Time windows use trim-relative seconds via FFmpeg's
  // `enable=between(t, ...)`. Fade-in / fade-out apply to PNG overlays by
  // wrapping the scaled input in a `fade=t=in/out` filter — boxblur
  // already pops in cleanly, fading it would require splits we don't need.
  for (let i = 0; i < (annotationOverlays || []).length; i++) {
    const ann = annotationOverlays[i]
    const startSec = Math.max(0, (ann.start - trimInMs) / 1000)
    const endSec = Math.max(startSec, (ann.end - trimInMs) / 1000)
    if (endSec <= 0 || startSec >= outDurSec) continue
    const enableExpr = `between(t,${startSec.toFixed(3)},${endSec.toFixed(3)})`

    if (ann.kind === 'mask' && ann.maskId === 'blur') {
      const cw = Math.max(2, Math.round(ann.w * W))
      const ch = Math.max(2, Math.round(ann.h * H))
      const cx = Math.round(ann.x * W - cw / 2)
      const cy = Math.round(ann.y * H - ch / 2)
      const splitA = `s${i}a`
      const splitB = `s${i}b`
      const blurredLabel = `bl${i}`
      const outLabel = `am${i}`
      // Map the per-annotation blur radius (preview CSS px on a 1920-wide
      // canvas) into FFmpeg's boxblur radius. boxblur is in actual source
      // pixels, so scale by W/1920. Iterations=2 for a softer kernel.
      const fbRadius = Math.max(1, Math.round((ann.blurRadius || 16) * (W / 1920)))
      filterChain.push(`${currentLabel}split=2[${splitA}][${splitB}]`)
      filterChain.push(
        `[${splitB}]crop=${cw}:${ch}:${Math.max(0, cx)}:${Math.max(0, cy)},boxblur=${fbRadius}:2[${blurredLabel}]`
      )
      filterChain.push(
        `[${splitA}][${blurredLabel}]overlay=x=${Math.max(0, cx)}:y=${Math.max(0, cy)}:enable='${enableExpr}'[${outLabel}]`
      )
      currentLabel = `[${outLabel}]`
      continue
    }

    if (ann.kind === 'mask' && ann.maskId === 'magnifier') {
      // Crop the region, scale up by `magnifierZoom`, soft-mask to a circle,
      // overlay back at the same position. The mask uses `geq` for a smooth
      // alpha falloff so the magnifier has soft edges instead of a hard
      // circle stamp. Cost is roughly the same as a small overlay.
      const zoomMag = Math.max(1.2, Math.min(5, ann.magnifierZoom || 2.2))
      // Output (visible) size on the canvas.
      const outW = Math.max(8, Math.round(ann.w * W))
      const outH = Math.max(8, Math.round(ann.h * H))
      // Source crop size = output / zoom; this is what gets magnified.
      const srcW = Math.max(4, Math.round(outW / zoomMag))
      const srcH = Math.max(4, Math.round(outH / zoomMag))
      const cx = Math.round(ann.x * W - srcW / 2)
      const cy = Math.round(ann.y * H - srcH / 2)
      const posX = Math.round(ann.x * W - outW / 2)
      const posY = Math.round(ann.y * H - outH / 2)
      const splitA = `mgA${i}`
      const splitB = `mgB${i}`
      const magnified = `mg${i}`
      const ringLabel = `mgr${i}`
      const outLabel = `am${i}`
      // Build a feathered elliptical alpha mask the same size as the
      // magnified output, drawn via geq. White inside the inner ellipse,
      // smooth fade through `feather` px, transparent outside.
      const feather = Math.max(2, Math.round(Math.min(outW, outH) * 0.05))
      const rx = outW / 2
      const ry = outH / 2
      const innerRx = Math.max(1, rx - feather)
      const innerRy = Math.max(1, ry - feather)
      filterChain.push(`${currentLabel}split=2[${splitA}][${splitB}]`)
      filterChain.push(
        `[${splitB}]crop=${srcW}:${srcH}:${Math.max(0, cx)}:${Math.max(0, cy)},` +
        `scale=${outW}:${outH}:flags=lanczos,format=yuva420p,` +
        // d = normalized ellipse distance: 1 inside inner band, 0 outside outer.
        `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':` +
        `a='255*clip( ( 1 - ( max(0, ( (X-${rx})*(X-${rx})/( ${rx}*${rx} ) + (Y-${ry})*(Y-${ry})/( ${ry}*${ry} ) ) - ( ${innerRx}*${innerRx}/( ${rx}*${rx} ) ) ) / ( 1 - ${innerRx}*${innerRx}/( ${rx}*${rx} ) ) ) ), 0, 1)'` +
        `[${magnified}]`
      )
      // Optional thin white rim ring so the magnifier reads as a "lens".
      const ringStroke = Math.max(2, Math.round(Math.min(outW, outH) * 0.025))
      filterChain.push(
        `[${magnified}]drawbox=x=0:y=0:w=${outW}:h=${outH}:` +
        `color=white@0.0:thickness=fill[${ringLabel}]`
      )
      filterChain.push(
        `[${splitA}][${ringLabel}]overlay=x=${posX}:y=${posY}:enable='${enableExpr}'[${outLabel}]`
      )
      currentLabel = `[${outLabel}]`
      // Unused refs to silence linters in case future readers wonder.
      void ringStroke
      continue
    }

    // PNG overlay (text / shape / spotlight).
    if (ann.pngPath) {
      let available = false
      try {
        await fs.access(ann.pngPath)
        available = true
      } catch {
        onLog && onLog(`[processor] annotation PNG missing: ${ann.pngPath}\n`)
      }
      if (!available) continue
      extraInputs.push('-i', ann.pngPath)
      const idx = nextInputIdx++

      // Non-fullframe overlays carry a shadow-pad margin around the visible
      // shape. The export needs to render the FULL PNG (so the shadow shows
      // up) but offset it so the shape sits where the user placed it.
      const pad = ann.pad || 0
      let scaleW, scaleH, posX, posY
      if (ann.fullFrame) {
        scaleW = W
        scaleH = H
        posX = 0
        posY = 0
      } else {
        const innerW = Math.max(2, Math.round(ann.w * W))
        const innerH = Math.max(2, Math.round(ann.h * H))
        // Match the rasterizer's padded canvas size: total = inner + 2*pad,
        // scaled proportionally to the on-canvas size.
        const totalCanvasW = (ann.pngW || (innerW + 2 * pad))
        const totalCanvasH = (ann.pngH || (innerH + 2 * pad))
        const ratio = innerW / Math.max(1, totalCanvasW - 2 * pad)
        scaleW = Math.round(totalCanvasW * ratio)
        scaleH = Math.round(totalCanvasH * ratio)
        // Center the *inner shape* on (ann.x, ann.y) — shift the full PNG
        // left/up by the scaled pad so the visible shape lands on the dot.
        const scaledPad = Math.round(pad * ratio)
        posX = Math.round(ann.x * W - innerW / 2) - scaledPad
        posY = Math.round(ann.y * H - innerH / 2) - scaledPad
      }
      const scaledLabel = `as${i}`
      const fadedLabel = `af${i}`
      const outLabel = `ao${i}`
      filterChain.push(`[${idx}:v]scale=${scaleW}:${scaleH}[${scaledLabel}]`)

      // Fade in/out — applied to the alpha channel of the overlay PNG so the
      // shape gently appears/disappears instead of popping. FFmpeg's
      // `fade=alpha=1` operates on time relative to the overlay's own input
      // stream; combined with `enable`, the result is bracketed correctly.
      const fadeInS = Math.max(0, (ann.fadeInMs || 0) / 1000)
      const fadeOutS = Math.max(0, (ann.fadeOutMs || 0) / 1000)
      const winS = Math.max(0.001, endSec - startSec)
      let overlaySrc = `[${scaledLabel}]`
      if (fadeInS > 0.01 || fadeOutS > 0.01) {
        const parts = []
        if (fadeInS > 0.01) parts.push(`fade=t=in:st=0:d=${fadeInS.toFixed(3)}:alpha=1`)
        if (fadeOutS > 0.01) {
          const outStart = Math.max(0, winS - fadeOutS)
          parts.push(`fade=t=out:st=${outStart.toFixed(3)}:d=${fadeOutS.toFixed(3)}:alpha=1`)
        }
        // PTS shift = the overlay PNG is a still image; we need its time-
        // base to start at 0 when the enable window opens. `setpts=PTS-STARTPTS`
        // and the offset trick below let the fade filter see relative time.
        filterChain.push(`${overlaySrc}format=yuva420p,${parts.join(',')}[${fadedLabel}]`)
        overlaySrc = `[${fadedLabel}]`
      }

      filterChain.push(
        `${currentLabel}${overlaySrc}overlay=x=${posX}:y=${posY}:enable='${enableExpr}':format=auto[${outLabel}]`
      )
      currentLabel = `[${outLabel}]`
    }
  }
  if (annotationOverlays && annotationOverlays.length) {
    onLog && onLog(`[processor] applied ${annotationOverlays.length} annotations\n`)
  }

  // Click effects — one PNG, fanned out over every click timestamp. Each
  // click gets a short fade-in/fade-out window of ~700 ms. We use a SINGLE
  // input stream and `enable='between(t,a,b) + between(t,c,d) + …'` so a
  // single overlay node services all clicks (no N-extra-inputs explosion).
  if (clickEffects && clickEffects.pngPath && Array.isArray(clickEffects.clicks) && clickEffects.clicks.length) {
    let available = false
    try { await fs.access(clickEffects.pngPath); available = true } catch {}
    if (available) {
      extraInputs.push('-i', clickEffects.pngPath)
      const idx = nextInputIdx++
      const shortSide = Math.min(W, H)
      const effW = Math.max(16, Math.round(shortSide * (clickEffects.sizeFrac || 0.18)))
      const effH = effW
      const durSec = (clickEffects.durMs || 700) / 1000
      // Build the combined enable expression. We trim-shift each click time
      // and clip to outDurSec.
      const windows = []
      for (const c of clickEffects.clicks) {
        const tStart = Math.max(0, (c.t - trimInMs) / 1000)
        const tEnd = tStart + durSec
        if (tEnd <= 0 || tStart >= outDurSec) continue
        windows.push({ tStart, tEnd, x: c.x, y: c.y })
      }
      if (windows.length > 0) {
        // FFmpeg overlay x/y expressions can reference `t`. We compute the
        // (x,y) as a chain of `if(between(t,a,b), X, …)` so a single overlay
        // node serves every click — much cheaper than N overlay chains.
        let xExpr = `${Math.round(W / 2)}`
        let yExpr = `${Math.round(H / 2)}`
        for (const w of windows) {
          const px = Math.round(w.x * W - effW / 2)
          const py = Math.round(w.y * H - effH / 2)
          const cond = `between(t,${w.tStart.toFixed(3)},${w.tEnd.toFixed(3)})`
          xExpr = `if(${cond},${px},${xExpr})`
          yExpr = `if(${cond},${py},${yExpr})`
        }
        const enableExpr = windows
          .map((w) => `between(t,${w.tStart.toFixed(3)},${w.tEnd.toFixed(3)})`)
          .join('+')
        const scaledLabel = `ce_s`
        const fadedLabel = `ce_f`
        const outLabel = `ce_o`
        filterChain.push(`[${idx}:v]scale=${effW}:${effH}[${scaledLabel}]`)
        // Looped fade so each click gets a fresh pulse. We use `setpts` to
        // reset the timeline on every enable window — but FFmpeg's fade
        // filter doesn't natively loop. Workaround: just use a soft static
        // alpha mask, and let the per-click fade fall out of the `enable`
        // boundary. The pulse animation lives in the radial-gradient PNG.
        filterChain.push(`[${scaledLabel}]format=yuva420p[${fadedLabel}]`)
        filterChain.push(
          `${currentLabel}[${fadedLabel}]overlay=x='${xExpr}':y='${yExpr}':eval=frame:enable='${enableExpr}':format=auto[${outLabel}]`
        )
        currentLabel = `[${outLabel}]`
        onLog && onLog(`[processor] click effect "${clickEffects.kind}": ${windows.length} click pulses\n`)
      }
    }
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

    // Optional rounded-corner mask. Renderer rasterized a white-on-transparent
    // PNG of the rounded rect; we scale it to the inset size and alphamerge it
    // onto the inner content so the corners go transparent, then overlay onto
    // the bg as before. Without this the export shows hard rectangular edges
    // even when the preview shows rounded ones.
    let roundedMaskAvailable = false
    let roundedMaskIdx = -1
    if (roundedMaskPngPath) {
      try {
        await fs.access(roundedMaskPngPath)
        extraInputs.push('-i', roundedMaskPngPath)
        roundedMaskIdx = nextInputIdx++
        roundedMaskAvailable = true
      } catch {
        onLog && onLog(`[processor] rounded mask PNG missing, falling back to hard corners\n`)
      }
    }

    if (roundedMaskAvailable) {
      filterChain.push(
        `${currentLabel}scale=${innerW}:${innerH},format=yuva420p[insetRgba]`
      )
      filterChain.push(
        `[${roundedMaskIdx}:v]scale=${innerW}:${innerH},format=gray[maskScaled]`
      )
      filterChain.push(`[insetRgba][maskScaled]alphamerge[insetRound]`)
      filterChain.push(
        `[${bgIdx}:v]trim=duration=${(outDurSec + 1).toFixed(2)},setpts=PTS-STARTPTS[bg]`
      )
      filterChain.push(`[bg][insetRound]overlay=x=${offX}:y=${offY}:format=auto[composed]`)
    } else {
      filterChain.push(`${currentLabel}scale=${innerW}:${innerH}[inset]`)
      filterChain.push(
        `[${bgIdx}:v]trim=duration=${(outDurSec + 1).toFixed(2)},setpts=PTS-STARTPTS[bg]`
      )
      filterChain.push(`[bg][inset]overlay=x=${offX}:y=${offY}:format=auto[composed]`)
    }
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

  // Watermark — applied on the inner stream (after cursor + camera, before
  // bg framing) so it lives inside the inner clip exactly like the preview.
  // Doing it after letterboxing made it sit on the wallpaper instead.
  if (watermarkEnabled && watermarkText) {
    const safeText = watermarkText
      .replace(/\\/g, '\\\\')
      .replace(/:/g, '\\:')
      .replace(/'/g, "\\'")
    const margin = Math.round(Math.min(W, H) * 0.04)
    const xy = (() => {
      switch (watermarkPosition) {
        case 'top-left': return `x=${margin}:y=${margin}`
        case 'top-right': return `x=w-tw-${margin}:y=${margin}`
        case 'bottom-left': return `x=${margin}:y=h-th-${margin}`
        default: return `x=w-tw-${margin}:y=h-th-${margin}`
      }
    })()
    // Editor watermark size is in CSS px on a typical ~600-tall inner clip;
    // scale to actual export height so it stays proportional.
    const fontSize = Math.max(10, Math.round((watermarkSize / 600) * H))
    const alpha = Math.max(0, Math.min(1, watermarkOpacity)).toFixed(2)
    filterChain.push(
      `${currentLabel}drawtext=text='${safeText}':fontcolor=white@${alpha}:fontsize=${fontSize}:${xy}:shadowcolor=black@0.5:shadowx=1:shadowy=1[wm]`
    )
    currentLabel = '[wm]'
  }

  // Keystroke overlay. We draw one drawtext per captured keydown event with
  // an `enable` window matching the linger; multiple simultaneous keys are
  // staggered horizontally via a slot allocator so they don't sit on top of
  // each other.
  if (showKeystrokes) {
    const keys = (session.events || []).filter((e) => e.type === 'key')
    // Translate event timestamps into output-timeline seconds, dropping any
    // outside the trim window.
    const trimmed = keys
      .filter((k) => k.timestamp >= trimInMs && k.timestamp <= trimOutMs)
      .map((k) => ({ ...k, tSec: (k.timestamp - trimInMs) / 1000 }))
      .sort((a, b) => a.tSec - b.tSec)

    if (trimmed.length > 0) {
      const windowS = Math.max(0.1, keystrokeWindowMs / 1000)
      // slotFreeAt[i] = earliest tSec at which slot i becomes available
      const slotFreeAt = []
      const SLOT_W = 90 // px between key chips
      const fontSize = Math.max(20, Math.round(canvasH * 0.04))
      const yExpr =
        keystrokePosition === 'top'
          ? `${Math.round(canvasH * 0.08)}`
          : `h-th-${Math.round(canvasH * 0.08)}`

      for (let kIdx = 0; kIdx < trimmed.length; kIdx++) {
        const k = trimmed[kIdx]
        // Find the lowest-indexed free slot; otherwise add a new one.
        let slot = 0
        while (slot < slotFreeAt.length && slotFreeAt[slot] > k.tSec) slot++
        if (slot >= slotFreeAt.length) slotFreeAt.push(0)
        slotFreeAt[slot] = k.tSec + windowS

        // Symmetric layout: slots 0,1,2,3,4 → offsets 0, +SLOT_W, -SLOT_W, +2W, -2W
        const half = Math.floor((slot + 1) / 2)
        const sign = slot === 0 ? 0 : slot % 2 === 1 ? 1 : -1
        const xOffset = sign * half * SLOT_W

        // Render label with modifier glyphs prefixed.
        const parts = []
        if (k.meta) parts.push('CMD')
        if (k.ctrl) parts.push('CTRL')
        if (k.alt) parts.push('ALT')
        if (k.shift && k.label.length > 1) parts.push('SHIFT')
        parts.push(k.label.length === 1 ? k.label.toUpperCase() : k.label)
        const text = parts.join(' ')
          .replace(/\\/g, '\\\\')
          .replace(/:/g, '\\:')
          .replace(/'/g, "\\'")

        const enableExpr = `between(t,${k.tSec.toFixed(3)},${(k.tSec + windowS).toFixed(3)})`
        const xExpr = xOffset === 0
          ? `(w-tw)/2`
          : `(w-tw)/2${xOffset > 0 ? '+' : ''}${xOffset}`

        // Include kIdx in the label so two simultaneous keys at the exact
        // same `tSec.toFixed(3)` in the same slot don't collide on a label.
        const kLabel = `k${kIdx}_${slot}_${k.tSec.toFixed(3).replace('.', '_')}`
        filterChain.push(
          `${currentLabel}drawtext=text='${text}':fontcolor=white:fontsize=${fontSize}:` +
            `box=1:boxcolor=black@0.7:boxborderw=10:` +
            `x='${xExpr}':y='${yExpr}':` +
            `enable='${enableExpr}'[${kLabel}]`
        )
        currentLabel = `[${kLabel}]`
      }
      onLog && onLog(`[processor] keystroke overlay: ${trimmed.length} key chips\n`)
    }
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
    // Multi-track inputs (native recorder with both system + mic) get amixed
    // with equal gain. Single-track inputs branch off [0:a] as before.
    let head
    if ((probe.audioStreamCount || 0) >= 2) {
      const inputs = []
      for (let i = 0; i < probe.audioStreamCount; i++) inputs.push(`[0:a:${i}]`)
      filterChain.push(
        `${inputs.join('')}amix=inputs=${probe.audioStreamCount}:duration=longest:dropout_transition=0[amix]`
      )
      head = '[amix]'
      onLog && onLog(`[processor] amixing ${probe.audioStreamCount} audio tracks\n`)
    } else {
      head = '[0:a]'
    }
    const parts = [`${head}volume=${(micVolume || 0).toFixed(3)}`]
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
