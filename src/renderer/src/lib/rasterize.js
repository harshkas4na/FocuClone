// Renderer-side rasterizers. We turn the cursor SVG and the rounded-corner
// mask into PNGs at export time, ship them to main via IPC, and let FFmpeg
// reference the files in its filtergraph. Keeps the export visually in sync
// with whatever the user picked in the editor without requiring native
// raster libraries in the main process.

import { findCursorStyle } from './cursors.js'

/**
 * Draws an SVG path-string into a 2D canvas. Honours the same fill / stroke /
 * gradient conventions as the live `<CursorSvg />` component so the exported
 * MP4 matches the preview.
 */
function drawCursor(ctx, style, scale) {
  ctx.save()
  ctx.scale(scale, scale)
  // The SVG path is authored in a 40×48 viewBox.
  const path = new Path2D(style.path)
  // Fill: gradient or flat colour.
  if (style.fill && style.fill.startsWith('gradient:') && style.gradient) {
    const grad = ctx.createLinearGradient(0, 0, 40, 48)
    grad.addColorStop(0, style.gradient.from)
    grad.addColorStop(1, style.gradient.to)
    ctx.fillStyle = grad
  } else {
    ctx.fillStyle = style.fill || '#ffffff'
  }
  ctx.strokeStyle = style.stroke || '#000000'
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.fill(path)
  ctx.stroke(path)
  ctx.restore()
}

/**
 * Rasterizes the chosen cursor style at a given total scale (combining
 * cursor-size slider × dpi) and returns a PNG ArrayBuffer.
 *
 * `scale=4` ≈ 160×192 px which gives crisp edges when FFmpeg overlays it on
 * a 4K canvas; the processor scales to the final cursor width afterwards.
 */
export async function rasterizeCursor(styleId, scale = 4) {
  const style = findCursorStyle(styleId)
  const w = Math.round(40 * scale)
  const h = Math.round(48 * scale)
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, w, h)
  drawCursor(ctx, style, scale)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await blob.arrayBuffer()
}

/**
 * Builds a rounded-rectangle alpha mask: opaque white inside the rounded
 * rect, transparent outside. FFmpeg `alphamerge` strips the colour channels
 * and uses the luma as the alpha, so we just paint a solid white rectangle.
 */
export async function rasterizeRoundedMask(width, height, radius) {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#ffffff'
  // OffscreenCanvas gained roundRect in Chromium 99+; Electron 29 ships way
  // past that, so we can rely on it directly.
  ctx.beginPath()
  ctx.roundRect(0, 0, width, height, radius)
  ctx.fill()
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await blob.arrayBuffer()
}

// ----- Annotation rasterizer (text + shapes) -----
//
// Each text style and each shape gets drawn into a transparent canvas at a
// requested pixel size that mirrors the editor's CSS rendering as closely
// as we can. The processor then overlays this PNG on the inner clip stream.
//
// `mask` annotations (spotlight/blur) are NOT rasterized — FFmpeg handles
// those directly with boxblur / drawbox.

const TEXT_STYLE_DEFS = {
  plain:   { bg: 'transparent', color: '#ffffff', radius: 0,    border: null,                 padX: 0,  padY: 0  },
  pill:    { bg: '#000000',     color: '#ffffff', radius: 9999, border: null,                 padX: 14, padY: 6  },
  bubble:  { bg: '#8b5cf6',     color: '#ffffff', radius: 8,    border: null,                 padX: 14, padY: 6  },
  glass:   { bg: 'rgba(255,255,255,0.18)', color: '#ffffff', radius: 8, border: 'rgba(255,255,255,0.35)', padX: 14, padY: 6 },
  outline: { bg: 'transparent', color: '#ffffff', radius: 8,    border: '#ec4899',            padX: 14, padY: 6  },
  badge:   { bg: '#bef264',     color: '#000000', radius: 9999, border: null,                 padX: 0,  padY: 0  }
}

function drawTextChip(ctx, text, w, h, def, fontSize) {
  ctx.clearRect(0, 0, w, h)
  ctx.font = `${def === TEXT_STYLE_DEFS.badge ? '700' : '600'} ${fontSize}px Inter, -apple-system, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // Background pill
  if (def.bg && def.bg !== 'transparent') {
    ctx.fillStyle = def.bg
    ctx.beginPath()
    ctx.roundRect(0, 0, w, h, Math.min(def.radius, h / 2))
    ctx.fill()
  }
  if (def.border) {
    ctx.strokeStyle = def.border
    ctx.lineWidth = Math.max(2, fontSize * 0.12)
    ctx.beginPath()
    ctx.roundRect(
      ctx.lineWidth / 2,
      ctx.lineWidth / 2,
      w - ctx.lineWidth,
      h - ctx.lineWidth,
      Math.min(def.radius, h / 2)
    )
    ctx.stroke()
  }
  ctx.fillStyle = def.color
  ctx.fillText(text, w / 2, h / 2 + fontSize * 0.05)
}

export async function rasterizeAnnotation(ann, innerW, innerH) {
  const w = Math.max(2, Math.round(ann.w * innerW))
  const h = Math.max(2, Math.round(ann.h * innerH))

  if (ann.kind === 'text') {
    const def = TEXT_STYLE_DEFS[ann.styleId] || TEXT_STYLE_DEFS.plain
    // Auto-pick font size from height; clamp to reasonable bounds.
    const fontSize = Math.max(14, Math.round(h * 0.55))
    // For pill/badge styles we honour requested size; for plain text size
    // by font (no padding), so we measure-and-fit.
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    drawTextChip(ctx, ann.text || ann.styleId, w, h, def, fontSize)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return { buffer: await blob.arrayBuffer(), w, h }
  }

  if (ann.kind === 'shape') {
    const canvas = new OffscreenCanvas(Math.max(w, 16), Math.max(h, 16))
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const cw = canvas.width
    const ch = canvas.height
    if (ann.shapeId === 'box') {
      ctx.strokeStyle = '#ec4899'
      ctx.lineWidth = Math.max(3, Math.min(cw, ch) * 0.025)
      ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, cw - ctx.lineWidth, ch - ctx.lineWidth)
    } else if (ann.shapeId === 'box-rounded') {
      ctx.strokeStyle = '#facc15'
      const lw = Math.max(3, Math.min(cw, ch) * 0.025)
      ctx.lineWidth = lw
      ctx.beginPath()
      ctx.roundRect(lw / 2, lw / 2, cw - lw, ch - lw, Math.min(cw, ch) * 0.18)
      ctx.stroke()
    } else if (ann.shapeId === 'circle') {
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = Math.max(4, Math.min(cw, ch) * 0.04)
      ctx.beginPath()
      ctx.ellipse(cw / 2, ch / 2, (cw - ctx.lineWidth) / 2, (ch - ctx.lineWidth) / 2, 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (ann.shapeId === 'line' || ann.shapeId === 'arrow') {
      const color = ann.shapeId === 'arrow' ? '#ec4899' : '#34d399'
      const lw = Math.max(4, ch * 0.25)
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = lw
      ctx.lineCap = 'round'
      const arrowH = ann.shapeId === 'arrow' ? lw * 1.6 : 0
      ctx.beginPath()
      ctx.moveTo(lw, ch / 2)
      ctx.lineTo(cw - arrowH - lw / 2, ch / 2)
      ctx.stroke()
      if (ann.shapeId === 'arrow') {
        ctx.beginPath()
        ctx.moveTo(cw - arrowH, ch / 2 - lw)
        ctx.lineTo(cw - 2, ch / 2)
        ctx.lineTo(cw - arrowH, ch / 2 + lw)
        ctx.closePath()
        ctx.fill()
      }
    } else if (ann.shapeId === 'arrow-down') {
      const color = '#ef4444'
      const lw = Math.max(4, cw * 0.25)
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = lw
      ctx.lineCap = 'round'
      const arrowH = lw * 1.6
      ctx.beginPath()
      ctx.moveTo(cw / 2, lw)
      ctx.lineTo(cw / 2, ch - arrowH - lw / 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cw / 2 - lw, ch - arrowH)
      ctx.lineTo(cw / 2, ch - 2)
      ctx.lineTo(cw / 2 + lw, ch - arrowH)
      ctx.closePath()
      ctx.fill()
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return { buffer: await blob.arrayBuffer(), w: canvas.width, h: canvas.height }
  }

  if (ann.kind === 'mask' && ann.maskId === 'spotlight') {
    // Full-frame dark overlay with an elliptical "hole" at the annotation
    // position. We return innerW×innerH; processor overlays at (0,0).
    const canvas = new OffscreenCanvas(innerW, innerH)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, innerW, innerH)
    ctx.globalCompositeOperation = 'destination-out'
    const cx = ann.x * innerW
    const cy = ann.y * innerH
    const rx = (ann.w * innerW) / 2
    const ry = (ann.h * innerH) / 2
    ctx.beginPath()
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return { buffer: await blob.arrayBuffer(), w: innerW, h: innerH, fullFrame: true }
  }

  return null
}
