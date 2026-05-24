// Renderer-side rasterizers. We turn the cursor SVG, the rounded-corner mask,
// click-effect pulses, and each annotation into PNGs at export time, ship
// them to main via IPC, and let FFmpeg reference the files in its
// filtergraph. Keeps the export visually in sync with whatever the user
// picked in the editor without requiring native raster libraries in main.

import { findCursorStyle } from './cursors.js'
import {
  TEXT_STYLE_DEFS,
  SHAPE_DEFS,
  DEFAULT_BLUR_RADIUS,
  DEFAULT_SPOTLIGHT_DARKNESS,
  DEFAULT_FADE_MS
} from './annotations.js'

/**
 * Draws an SVG path-string into a 2D canvas. Honours the same fill / stroke /
 * gradient conventions as the live `<CursorSvg />` component so the exported
 * MP4 matches the preview.
 */
function drawCursor(ctx, style, scale) {
  ctx.save()
  ctx.scale(scale, scale)
  const path = new Path2D(style.path)
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

export async function rasterizeRoundedMask(width, height, radius) {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.roundRect(0, 0, width, height, radius)
  ctx.fill()
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await blob.arrayBuffer()
}

// ----- Annotation rasterizer -----
//
// Each annotation gets drawn into a transparent canvas sized to its target
// pixel footprint, plus a margin for the drop shadow so the blur isn't clipped.
// The processor then overlays this PNG on the inner clip stream.
//
// `mask` annotations (spotlight / magnifier) ARE rasterized into a full-frame
// PNG; blur is FFmpeg-side (boxblur on the underlying video — overlay PNG
// can't see the underlying pixels).

// Drop shadow that integrates the overlay into the video instead of looking
// pasted on top. Matches `filter: drop-shadow(...)` rendered in the preview.
const SHADOW = { offsetY: 4, blur: 16, color: 'rgba(0,0,0,0.45)' }
const SHADOW_PAD = 28 // extra canvas margin so the shadow blur doesn't clip

function applyShadow(ctx) {
  ctx.shadowColor = SHADOW.color
  ctx.shadowBlur = SHADOW.blur
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = SHADOW.offsetY
}

function clearShadow(ctx) {
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0
}

function drawTextChip(ctx, text, w, h, def, fontSize, color) {
  const fg = color || def.fg || '#ffffff'
  const bg = def.bg
  ctx.font = `${def === TEXT_STYLE_DEFS.badge ? '700' : '600'} ${fontSize}px Inter, -apple-system, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (bg && bg !== 'transparent') {
    applyShadow(ctx)
    ctx.fillStyle = bg
    ctx.beginPath()
    ctx.roundRect(SHADOW_PAD, SHADOW_PAD, w, h, Math.min(def.radius, h / 2))
    ctx.fill()
    clearShadow(ctx)
  }
  if (def.border) {
    ctx.strokeStyle = def.border
    ctx.lineWidth = Math.max(2, fontSize * 0.12)
    ctx.beginPath()
    ctx.roundRect(
      SHADOW_PAD + ctx.lineWidth / 2,
      SHADOW_PAD + ctx.lineWidth / 2,
      w - ctx.lineWidth,
      h - ctx.lineWidth,
      Math.min(def.radius, h / 2)
    )
    ctx.stroke()
  }
  // For plain (transparent bg) text we still want a subtle shadow so the
  // text reads against busy backgrounds.
  if (!bg || bg === 'transparent') {
    ctx.save()
    applyShadow(ctx)
  }
  ctx.fillStyle = fg
  ctx.fillText(text, SHADOW_PAD + w / 2, SHADOW_PAD + h / 2 + fontSize * 0.05)
  if (!bg || bg === 'transparent') ctx.restore()
}

function drawShape(ctx, shapeId, w, h, color) {
  const stroke = color || SHAPE_DEFS[shapeId]?.stroke || '#ffffff'
  ctx.strokeStyle = stroke
  ctx.fillStyle = stroke
  applyShadow(ctx)

  if (shapeId === 'box') {
    const lw = Math.max(3, Math.min(w, h) * 0.025)
    ctx.lineWidth = lw
    ctx.strokeRect(SHADOW_PAD + lw / 2, SHADOW_PAD + lw / 2, w - lw, h - lw)
    return
  }
  if (shapeId === 'box-rounded') {
    const lw = Math.max(3, Math.min(w, h) * 0.025)
    ctx.lineWidth = lw
    ctx.beginPath()
    ctx.roundRect(SHADOW_PAD + lw / 2, SHADOW_PAD + lw / 2, w - lw, h - lw, Math.min(w, h) * 0.18)
    ctx.stroke()
    return
  }
  if (shapeId === 'circle') {
    const lw = Math.max(4, Math.min(w, h) * 0.05)
    ctx.lineWidth = lw
    ctx.beginPath()
    ctx.ellipse(SHADOW_PAD + w / 2, SHADOW_PAD + h / 2, (w - lw) / 2, (h - lw) / 2, 0, 0, Math.PI * 2)
    ctx.stroke()
    return
  }
  if (shapeId === 'line' || shapeId === 'arrow') {
    const lw = Math.max(4, h * 0.4)
    ctx.lineWidth = lw
    ctx.lineCap = 'round'
    const arrowH = shapeId === 'arrow' ? lw * 1.6 : 0
    const midY = SHADOW_PAD + h / 2
    ctx.beginPath()
    ctx.moveTo(SHADOW_PAD + lw, midY)
    ctx.lineTo(SHADOW_PAD + w - arrowH - lw / 2, midY)
    ctx.stroke()
    if (shapeId === 'arrow') {
      ctx.beginPath()
      ctx.moveTo(SHADOW_PAD + w - arrowH, midY - lw)
      ctx.lineTo(SHADOW_PAD + w - 2, midY)
      ctx.lineTo(SHADOW_PAD + w - arrowH, midY + lw)
      ctx.closePath()
      ctx.fill()
    }
    return
  }
  if (shapeId === 'arrow-down') {
    const lw = Math.max(4, w * 0.4)
    ctx.lineWidth = lw
    ctx.lineCap = 'round'
    const arrowH = lw * 1.6
    const midX = SHADOW_PAD + w / 2
    ctx.beginPath()
    ctx.moveTo(midX, SHADOW_PAD + lw)
    ctx.lineTo(midX, SHADOW_PAD + h - arrowH - lw / 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(midX - lw, SHADOW_PAD + h - arrowH)
    ctx.lineTo(midX, SHADOW_PAD + h - 2)
    ctx.lineTo(midX + lw, SHADOW_PAD + h - arrowH)
    ctx.closePath()
    ctx.fill()
    return
  }
}

export async function rasterizeAnnotation(ann, innerW, innerH) {
  const w = Math.max(2, Math.round(ann.w * innerW))
  const h = Math.max(2, Math.round(ann.h * innerH))

  if (ann.kind === 'text') {
    const def = TEXT_STYLE_DEFS[ann.styleId] || TEXT_STYLE_DEFS.plain
    const fontSize = Math.max(14, Math.round(h * 0.55))
    const canvasW = w + SHADOW_PAD * 2
    const canvasH = h + SHADOW_PAD * 2
    const canvas = new OffscreenCanvas(canvasW, canvasH)
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvasW, canvasH)
    drawTextChip(ctx, ann.text || def.label, w, h, def, fontSize, ann.bgColor || (ann.color && ann.styleId === 'plain' ? ann.color : null))
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return { buffer: await blob.arrayBuffer(), w: canvasW, h: canvasH, pad: SHADOW_PAD }
  }

  if (ann.kind === 'shape') {
    const canvasW = w + SHADOW_PAD * 2
    const canvasH = h + SHADOW_PAD * 2
    const canvas = new OffscreenCanvas(canvasW, canvasH)
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvasW, canvasH)
    drawShape(ctx, ann.shapeId, w, h, ann.color)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return { buffer: await blob.arrayBuffer(), w: canvasW, h: canvasH, pad: SHADOW_PAD }
  }

  if (ann.kind === 'mask' && ann.maskId === 'spotlight') {
    // Full-frame dark overlay with an elliptical "hole" at the annotation
    // position. The preview is now a matching ellipse (see Editor.jsx) so
    // what you see is what you get.
    const darkness = ann.spotlightDarkness ?? DEFAULT_SPOTLIGHT_DARKNESS
    const canvas = new OffscreenCanvas(innerW, innerH)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = `rgba(0,0,0,${darkness})`
    ctx.fillRect(0, 0, innerW, innerH)
    // Soften the edge a bit with a radial gradient before punching the hole.
    ctx.globalCompositeOperation = 'destination-out'
    const cx = ann.x * innerW
    const cy = ann.y * innerH
    const rx = (ann.w * innerW) / 2
    const ry = (ann.h * innerH) / 2
    const grad = ctx.createRadialGradient(cx, cy, Math.min(rx, ry) * 0.6, cx, cy, Math.max(rx, ry))
    grad.addColorStop(0, 'rgba(0,0,0,1)')
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return { buffer: await blob.arrayBuffer(), w: innerW, h: innerH, fullFrame: true, pad: 0 }
  }

  return null
}

// ----- Click effect rasterizers -----
//
// These produce a SINGLE PNG for the peak frame of the effect. The processor
// applies a fade-in + fade-out around each click time so the effect pulses
// even though the source is a static image. Keeps the export path simple —
// no per-frame procedural drawing needed.

export async function rasterizeClickEffect(kind, sizePx = 220) {
  const w = sizePx
  const h = sizePx
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, w, h)
  const cx = w / 2
  const cy = h / 2

  if (kind === 'ripple') {
    // Soft filled disc — fades out via FFmpeg's overlay fade.
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, w / 2)
    grad.addColorStop(0, 'rgba(255,255,255,0.55)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
  } else if (kind === 'ring') {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = 6
    ctx.beginPath()
    ctx.arc(cx, cy, w / 2 - 8, 0, Math.PI * 2)
    ctx.stroke()
  } else if (kind === 'spotlight') {
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, w / 2)
    grad.addColorStop(0, 'rgba(255,255,255,0.45)')
    grad.addColorStop(0.6, 'rgba(255,255,255,0.08)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
  } else if (kind === 'sparkle') {
    const spokes = 8
    const inner = w * 0.04
    const outer = w * 0.42
    ctx.strokeStyle = '#fde047'
    ctx.lineWidth = Math.max(2, w * 0.025)
    ctx.lineCap = 'round'
    for (let i = 0; i < spokes; i++) {
      const a = (i * Math.PI * 2) / spokes
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner)
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer)
      ctx.stroke()
    }
  } else {
    return null
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return { buffer: await blob.arrayBuffer(), w, h }
}

export const DEFAULTS = {
  fadeMs: DEFAULT_FADE_MS,
  blurRadius: DEFAULT_BLUR_RADIUS,
  spotlightDarkness: DEFAULT_SPOTLIGHT_DARKNESS
}
