// Inline harness mirroring processor.js (no electron `app` import) to validate
// trim + sendcmd cursor + wallpaper end-to-end.
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')

import {
  zoomsFromEvents,
  clickWindowsFromZooms,
  buildZoomExpressionsFromZooms,
  decimateMoves,
  applyTrimToZooms,
  applyTrimToMoves,
  buildCursorSendcmd
} from './src/main/zoomTimeline.js'

const RAW = '/tmp/focuclone-test/raw.webm'
const CURSOR = './resources/cursor.png'
const SCREENW = 1700, SCREENH = 956

async function probe(input) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-i', input])
    let s = ''
    p.stderr.on('data', (d) => (s += d.toString()))
    p.on('close', () => {
      const m = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      const dur = m ? +m[1]*3600 + +m[2]*60 + parseFloat(m[3]) : 0
      let dims = null
      for (const l of s.split('\n').filter((x) => /Video:/i.test(x))) {
        const dm = l.match(/(\d{2,5})x(\d{2,5})/)
        if (dm) { dims = { w:+dm[1], h:+dm[2] }; break }
      }
      const fm = s.match(/(\d+(?:\.\d+)?)\s*fps/)
      resolve({ dur, dims, fps: fm ? parseFloat(fm[1]) : 30 })
    })
  })
}

const events = []
events.push({ type:'click', x: 425, y: 240, timestamp: 1500, screenW:SCREENW, screenH:SCREENH, button:'left' })
events.push({ type:'click', x: 1275, y: 720, timestamp: 5500, screenW:SCREENW, screenH:SCREENH, button:'left' })
// diagonal mouse drift
for (let t = 0; t <= 10000; t += 50) {
  const p = t / 10000
  events.push({ type:'move', x: Math.round(200+1300*p), y: Math.round(150+700*p),
    timestamp: t, screenW:SCREENW, screenH:SCREENH, button:null })
}

async function run(label, opts) {
  const out = `/tmp/focuclone-test/out_${label}.mp4`
  const p = await probe(RAW)
  const W = p.dims.w - p.dims.w%2, H = p.dims.h - p.dims.h%2, fps = Math.round(p.fps)||30
  const fullDurMs = p.dur * 1000
  const trimInMs = opts.trim?.inMs || 0
  const trimOutMs = opts.trim?.outMs || fullDurMs
  const outDurSec = (trimOutMs - trimInMs) / 1000
  const outDurMs = trimOutMs - trimInMs

  const baseZooms = zoomsFromEvents(events, opts)
  const zooms = applyTrimToZooms(baseZooms, trimInMs, outDurMs)
  const decimated = applyTrimToMoves(decimateMoves(events, { cursorMoveSampleHz:30 }), trimInMs, outDurMs)

  const zExpr = buildZoomExpressionsFromZooms(zooms, 'time')
  const zSafe = `max(${zExpr.zExpr},1)`
  const xExpr = `clip((${zExpr.cxExpr})*iw - iw/(2*(${zSafe})), 0, iw - iw/(${zSafe}))`
  const yExpr = `clip((${zExpr.cyExpr})*ih - ih/(2*(${zSafe})), 0, ih - ih/(${zSafe}))`

  const chain = []
  const inputs = []
  if (trimInMs > 0) inputs.push('-ss', (trimInMs/1000).toFixed(3))
  if (trimOutMs < fullDurMs) inputs.push('-to', (trimOutMs/1000).toFixed(3))
  inputs.push('-i', RAW)
  let nextIdx = 1
  let cur = '[zoomed]'

  // build cursor cmds
  const cursorWindows = clickWindowsFromZooms(zooms)
  let cmdsFile = null
  if (opts.showCursor && cursorWindows.length) {
    inputs.push('-i', CURSOR)
    const cursorIdx = nextIdx++
    const enableExpr = cursorWindows
      .map(w => `between(t,${(w.start/1000).toFixed(3)},${(w.end/1000).toFixed(3)})`)
      .join('+')
    if (opts.cursorFollowsMouse) {
      const cursorW = 44, cursorH = 52
      const cmds = buildCursorSendcmd({
        zooms, decimatedMoves: decimated, W, H, cursorW, cursorH, fps, durSec: outDurSec
      })
      cmdsFile = join(dirname(RAW), `cmds_${label}.txt`)
      await fs.writeFile(cmdsFile, cmds, 'utf8')
      console.log(`  ${label}: cmds=${cmds.split('\n').length} lines`)
      chain.push(
        `[0:v]fps=${fps},zoompan=z='${zSafe}':x='${xExpr}':y='${yExpr}':d=1:s=${W}x${H}:fps=${fps},sendcmd=f='${cmdsFile}'[zoomed]`
      )
      chain.push(`[${cursorIdx}:v]scale=${cursorW}:-1[cur]`)
      chain.push(
        `${cur}[cur]overlay@ov=x=${Math.round(W/2)}:y=${Math.round(H/2)}:eval=frame:enable='${enableExpr}':format=auto[withcur]`
      )
    } else {
      chain.push(`[0:v]fps=${fps},zoompan=z='${zSafe}':x='${xExpr}':y='${yExpr}':d=1:s=${W}x${H}:fps=${fps}[zoomed]`)
      chain.push(`[${cursorIdx}:v]scale=44:-1[curp]`)
      chain.push(`${cur}[curp]overlay=x=(W-w)/2:y=(H-h)/2:enable='${enableExpr}':format=auto[withcur]`)
    }
    cur = '[withcur]'
  } else {
    chain.push(`[0:v]fps=${fps},zoompan=z='${zSafe}':x='${xExpr}':y='${yExpr}':d=1:s=${W}x${H}:fps=${fps}[zoomed]`)
  }

  if (opts.background === 'wallpaper' || opts.background === 'rounded') {
    const innerW = Math.round(W*0.92) - (Math.round(W*0.92)%2)
    const innerH = Math.round(innerW*(H/W)) - (Math.round(innerW*(H/W))%2)
    const offX = Math.round((W-innerW)/2), offY = Math.round((H-innerH)/2)
    if (opts.background === 'wallpaper') {
      inputs.push('-f','lavfi','-i', `gradients=size=${W}x${H}:c0=0x0e1230:c1=0x2a1149:type=linear:duration=999:speed=0.00001:rate=${fps}`)
    } else {
      inputs.push('-f','lavfi','-i', `color=size=${W}x${H}:color=0x101014:rate=${fps}`)
    }
    const bgIdx = nextIdx++
    chain.push(`${cur}scale=${innerW}:${innerH}[inset]`)
    chain.push(`[${bgIdx}:v]trim=duration=${(outDurSec+1).toFixed(2)},setpts=PTS-STARTPTS[bg]`)
    chain.push(`[bg][inset]overlay=x=${offX}:y=${offY}:format=auto[composed]`)
    cur = '[composed]'
  }
  chain.push(`${cur}format=yuv420p[final]`)

  const filter = chain.join(';')
  const args = ['-y','-hide_banner', ...inputs, '-filter_complex', filter, '-map','[final]',
    '-c:v', 'h264_videotoolbox', '-b:v', '6M', '-movflags', '+faststart', out]

  console.log(`\n=== ${label} (filter ${filter.length} chars) ===`)
  return new Promise((res, rej) => {
    const pp = spawn(ffmpegPath, args)
    let buf = ''
    pp.stderr.on('data', (d) => buf += d.toString())
    pp.on('close', async (code, sig) => {
      if (cmdsFile) await fs.unlink(cmdsFile).catch(() => {})
      if (code === 0) { console.log(`OK -> ${out}`); res() }
      else { console.log(`FAIL code=${code} sig=${sig}\n${buf.slice(-1500)}`); rej(new Error('fail')) }
    })
  })
}

;(async () => {
  await run('cursor_static',     { showCursor:true, cursorFollowsMouse:false, background:'none', zoomLevel:2 })
  await run('cursor_followmouse', { showCursor:true, cursorFollowsMouse:true,  background:'none', zoomLevel:2 })
  await run('trim_followmouse',   { showCursor:true, cursorFollowsMouse:true,  background:'wallpaper', zoomLevel:2,
                                    trim:{ inMs:1000, outMs:8000 } })
  console.log('\nALL OK')
})().catch(e => { console.error(e); process.exit(1) })
