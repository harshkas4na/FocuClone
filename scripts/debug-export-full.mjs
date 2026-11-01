// One-off smoke test for the new export features: inset border, frame
// shadow overlay, click sound mixing, pre-framing watermark/keystrokes,
// masks, and camera-tracked click effects. Uses stand-in PNGs where the
// real ones are rasterized in the renderer.
import { promises as fs } from 'fs'
import { join } from 'path'
import os from 'os'

const { processVideo } = await import('../src/main/processor.js')

const root = join(os.homedir(), 'Library', 'Application Support', 'focuclone', 'sessions')
const dirs = await fs.readdir(root)
let best = null
let bestM = 0
for (const d of dirs) {
  const p = join(root, d, 'session.json')
  try {
    const st = await fs.stat(p)
    if (st.mtimeMs > bestM) { bestM = st.mtimeMs; best = p }
  } catch {}
}
const session = JSON.parse(await fs.readFile(best, 'utf8'))
const clicks = (session.events || []).filter((e) => e.type === 'click')
console.log('[full-test] session', best, 'clicks', clicks.length)

const standIn = `${process.cwd()}/resources/cursor.png`
const outPath = join(os.tmpdir(), `focuclone-fulltest-${Date.now()}.mp4`)

const opts = {
  outputPath: outPath,
  showCursor: true,
  cursorFollowsMouse: true,
  hideCursorWhenIdle: true,
  cursorSize: 1.2,
  bgFfmpeg: { type: 'gradient', c0: '0x1c2541', c1: '0xc2548c' },
  padding: 6,
  inset: 2,
  insetColor: '#112233',
  roundness: 0,
  canvasAspectRatio: 16 / 9,
  quality: 23,
  useVideoToolbox: true,
  watermarkEnabled: true,
  watermarkText: 'FocuClone Test',
  watermarkPosition: 'bottom-right',
  watermarkOpacity: 0.7,
  watermarkSize: 16,
  showKeystrokes: true,
  keystrokePosition: 'bottom',
  keystrokeWindowMs: 1500,
  showCamera: false,
  audioMuted: false,
  micVolume: 1.0,
  cursorClickSound: true,
  clickTimesMs: clicks.map((e) => e.timestamp),
  frameShadowPngPath: standIn,
  frameShadowPad: 10,
  frameShadowRefW: 1000,
  trim: { inMs: 0, outMs: null },
  zooms: undefined,
  annotations: [
    { kind: 'mask', maskId: 'blur', x: 0.7, y: 0.5, w: 0.25, h: 0.18,
      blurRadius: 20, start: 1000, end: 5000, fadeInMs: 200, fadeOutMs: 200 }
  ],
  clickEffects: {
    kind: 'ripple',
    pngPath: standIn,
    pngW: 40, pngH: 48,
    durMs: 700, sizeFrac: 0.18,
    clicks: clicks.slice(0, 5).map((e) => ({
      t: e.timestamp,
      x: e.screenW > 0 ? e.x / e.screenW : 0.5,
      y: e.screenH > 0 ? e.y / e.screenH : 0.5
    }))
  }
}

try {
  const out = await processVideo(session, opts,
    (pct) => process.stdout.write(`\rprogress ${pct.toFixed(1)}%   `),
    (msg) => process.stderr.write(msg))
  console.log('\n[full-test] OK -> ' + out)
} catch (err) {
  console.error('\n[full-test] FAIL:', err.message)
  process.exitCode = 1
}
