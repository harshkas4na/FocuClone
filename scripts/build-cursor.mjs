#!/usr/bin/env node
// Procedurally generates a tightly-cropped 40×48 RGBA cursor PNG with proper
// alpha. Run once: `node scripts/build-cursor.mjs`. Writes resources/cursor.png.
import { promises as fs } from 'fs'
import zlib from 'zlib'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const W = 40
const H = 48

// Cursor outline polygon (roughly the macOS pointer)
const polygon = [
  [4, 2],
  [4, 42],
  [14, 32],
  [20, 46],
  [26, 43],
  [20, 30],
  [34, 30]
]

function pointInPoly(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function distToOutline(px, py, poly) {
  let min = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const d = distToSegment(px + 0.5, py + 0.5, a[0], a[1], b[0], b[1])
    if (d < min) min = d
  }
  return min
}

const pixels = Buffer.alloc(W * H * 4)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const idx = (y * W + x) * 4
    const inside = pointInPoly(x + 0.5, y + 0.5, polygon)
    const d = distToOutline(x, y, polygon)
    let r = 255, g = 255, b = 255, a = 0
    if (inside) {
      a = 255
    }
    // Draw black outline ~1.4 px thick on the inside-edge
    if (d < 1.5) {
      const t = Math.max(0, 1 - d / 1.5)
      const outlineA = Math.round(255 * t)
      // Mix toward black
      r = Math.round(r * (1 - t))
      g = Math.round(g * (1 - t))
      b = Math.round(b * (1 - t))
      a = Math.max(a, outlineA)
    }
    pixels[idx] = r
    pixels[idx + 1] = g
    pixels[idx + 2] = b
    pixels[idx + 3] = a
  }
}

// Minimal PNG encoder (RGBA, filter byte 0 per row)
function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

// Construct raw scanlines with filter byte 0
const raw = Buffer.alloc(H * (1 + W * 4))
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0
  pixels.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4)
}
const idat = zlib.deflateSync(raw)

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
])

const out = resolve(__dirname, '../resources/cursor.png')
await fs.writeFile(out, png)
console.log(`wrote ${png.length} bytes to ${out}`)
