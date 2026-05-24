// Build the ScreenCaptureKit helper binaries.
//
// Usage: node scripts/build-native-helper.mjs            # current arch only
//        node scripts/build-native-helper.mjs --all      # arm64 + x64
//        node scripts/build-native-helper.mjs --check    # exit 0 iff binary already exists
//
// Output: resources/native/darwin-(arm64|x64)/focuclone-screen-capture

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const sourcePath = join(repoRoot, 'src/native/ScreenCaptureKitRecorder.swift')

const TARGETS = {
  'darwin-arm64': 'arm64-apple-macos12.3',
  'darwin-x64': 'x86_64-apple-macos12.3'
}

function out(arch) {
  return join(repoRoot, 'resources/native', arch, 'focuclone-screen-capture')
}

function isFreshBinary(arch) {
  const o = out(arch)
  if (!existsSync(o)) return false
  try {
    const src = statSync(sourcePath).mtimeMs
    const bin = statSync(o).mtimeMs
    return bin >= src
  } catch {
    return false
  }
}

function build(arch) {
  const target = TARGETS[arch]
  if (!target) throw new Error(`unknown arch ${arch}`)
  const dest = out(arch)
  mkdirSync(dirname(dest), { recursive: true })
  console.log(`[native] swiftc -O -target ${target} → ${dest}`)
  execFileSync(
    'swiftc',
    ['-O', '-target', target, sourcePath, '-o', dest],
    { stdio: 'inherit' }
  )
}

const args = new Set(process.argv.slice(2))
const all = args.has('--all')
const check = args.has('--check')

const archs = all
  ? Object.keys(TARGETS)
  : [process.platform === 'darwin' && process.arch === 'x64' ? 'darwin-x64' : 'darwin-arm64']

if (check) {
  const missing = archs.filter((a) => !isFreshBinary(a))
  if (missing.length) {
    console.error(`[native] stale or missing: ${missing.join(', ')}`)
    process.exit(1)
  }
  console.log('[native] all targets fresh')
  process.exit(0)
}

if (process.platform !== 'darwin') {
  console.log('[native] skipped: ScreenCaptureKit helper is macOS-only')
  process.exit(0)
}

for (const arch of archs) {
  if (isFreshBinary(arch)) {
    console.log(`[native] ${arch} up-to-date`)
    continue
  }
  build(arch)
}
