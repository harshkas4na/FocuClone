// Headless export driver. Loads the latest recorded session and runs
// processor.js end-to-end with a fake `electron.app` so we can see the
// actual ffmpeg invocation + filter graph + exit code without bringing
// up the UI.
//
// Usage:
//   node scripts/debug-export.mjs              -> uses freshest session.json under userData/sessions
//   node scripts/debug-export.mjs <session.json>

import { promises as fs } from 'fs'
import { join } from 'path'
import os from 'os'

// `electron` is mapped to ./scripts/electron-stub-impl.mjs by the loader hook
// in package.json scripts. Just import normally.
const { processVideo } = await import('../src/main/processor.js')

function pickArg() {
  return process.argv[2]
}

async function findFreshestSession() {
  const root = join(os.homedir(), 'Library', 'Application Support', 'focuclone', 'sessions')
  const dirs = await fs.readdir(root)
  let best = null
  let bestMtime = 0
  for (const d of dirs) {
    const p = join(root, d, 'session.json')
    try {
      const st = await fs.stat(p)
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs
        best = p
      }
    } catch {}
  }
  return best
}

const sessionPath = pickArg() || (await findFreshestSession())
if (!sessionPath) {
  console.error('no session found')
  process.exit(1)
}
console.log('[debug-export] session:', sessionPath)
const session = JSON.parse(await fs.readFile(sessionPath, 'utf8'))
console.log('[debug-export] events:', (session.events || []).length,
  'clicks:', (session.events || []).filter(e => e.type === 'click').length,
  'screen:', session.screenW + 'x' + session.screenH,
  'dur:', session.duration)

// Minimal opts roughly matching exportSettings defaults + auto-derived
// zooms via processor's own fallback.
const outPath = join(os.tmpdir(), `focuclone-debug-${Date.now()}.mp4`)
const opts = {
  outputPath: outPath,
  showCursor: true,
  cursorFollowsMouse: true,
  cursorSize: 1.0,
  cursorStyle: 'arrow-white',
  bgFfmpeg: { type: 'gradient', c0: '0x0e1230', c1: '0x2a1149' },
  padding: 5,
  roundness: 0,
  canvasAspectRatio: undefined,
  background: 'none',
  quality: 23,
  useVideoToolbox: true,
  watermarkEnabled: false,
  showKeystrokes: false,
  showCamera: false,
  audioMuted: false,
  micVolume: 1.0,
  trim: process.env.TRIM
    ? { inMs: parseInt(process.env.TRIM.split(',')[0], 10),
        outMs: parseInt(process.env.TRIM.split(',')[1], 10) }
    : { inMs: 0, outMs: null },
  zooms: undefined,            // force processor to derive from events
  // Synthetic annotations exercise blur, spotlight, magnifier branches if
  // EFFECTS=1 in env.
  annotations: process.env.EFFECTS
    ? [
        { kind: 'mask', maskId: 'blur', x: 0.7, y: 0.5, w: 0.25, h: 0.18,
          blurRadius: 20, start: 1000, end: 5000, fadeInMs: 200, fadeOutMs: 200 },
        { kind: 'mask', maskId: 'spotlight', x: 0.35, y: 0.3, w: 0.3, h: 0.3,
          spotlightDarkness: 0.6, start: 6000, end: 9000, fadeInMs: 200, fadeOutMs: 200 },
        { kind: 'mask', maskId: 'magnifier', x: 0.35, y: 0.35, w: 0.2, h: 0.2,
          magnifierZoom: 2.4, start: 10000, end: 14000, fadeInMs: 200, fadeOutMs: 200 }
      ]
    : [],
  // Click effects exercise the export-side overlay branch. We reuse the
  // bundled cursor.png as a stand-in image so the filtergraph wires up.
  clickEffects: process.env.EFFECTS
    ? {
        kind: 'ripple',
        pngPath: `${process.cwd()}/resources/cursor.png`,
        pngW: 40, pngH: 48,
        durMs: 700, sizeFrac: 0.18,
        clicks: (session.events || [])
          .filter((e) => e.type === 'click')
          .slice(0, 5)
          .map((e) => ({
            t: e.timestamp,
            x: session.screenW ? e.x / session.screenW : 0.5,
            y: session.screenH ? e.y / session.screenH : 0.5
          }))
      }
    : null
}

try {
  const out = await processVideo(session, opts,
    (pct) => process.stdout.write(`\rprogress ${pct.toFixed(1)}%   `),
    (msg) => process.stderr.write(msg))
  console.log('\n[debug-export] OK -> ' + out)
} catch (err) {
  console.error('\n[debug-export] FAIL:', err.message)
  process.exitCode = 1
}
