// Annotation data model + helpers shared by the editor and rasterizer.
//
// Every annotation is a plain object with this shape:
//
//   {
//     id, kind: 'text' | 'shape' | 'mask',
//     // For 'text': styleId in TEXT_STYLE_DEFS.
//     // For 'shape': shapeId in SHAPE_DEFS.
//     // For 'mask': maskId in MASK_DEFS.
//     styleId? | shapeId? | maskId?,
//     text?,                               // text only
//     x, y, w, h,                          // normalized [0..1] center + size
//     start, end,                          // ms timeline window
//     color?,                              // overrides the default tint
//     bgColor?,                            // text bg color override
//     blurRadius?,                         // mask:blur radius in screen px (default 16)
//     spotlightDarkness?,                  // mask:spotlight alpha 0..1 (default 0.55)
//     magnifierZoom?,                      // mask:magnifier zoom 1.5..5 (default 2.2)
//     fadeInMs?, fadeOutMs?,               // animation; default 180/180
//   }

// Tint colors are per-kind defaults; users can override via the color picker.
export const SHAPE_DEFS = {
  box:          { label: 'Box',          stroke: '#ec4899' },
  'box-rounded':{ label: 'Rounded box',  stroke: '#facc15' },
  circle:       { label: 'Circle',       stroke: '#ffffff' },
  line:         { label: 'Line',         stroke: '#34d399' },
  arrow:        { label: 'Arrow',        stroke: '#ec4899' },
  'arrow-down': { label: 'Down arrow',   stroke: '#ef4444' }
}

export const TEXT_STYLE_DEFS = {
  plain:   { label: 'Plain',   bg: 'transparent',         fg: '#ffffff', radius: 0,    border: null,                       padX: 0,  padY: 0  },
  pill:    { label: 'Pill',    bg: '#000000',             fg: '#ffffff', radius: 9999, border: null,                       padX: 14, padY: 6  },
  bubble:  { label: 'Bubble',  bg: '#8b5cf6',             fg: '#ffffff', radius: 8,    border: null,                       padX: 14, padY: 6  },
  glass:   { label: 'Glass',   bg: 'rgba(255,255,255,0.18)', fg: '#ffffff', radius: 8, border: 'rgba(255,255,255,0.35)',    padX: 14, padY: 6  },
  outline: { label: 'Outline', bg: 'transparent',         fg: '#ffffff', radius: 8,    border: '#ec4899',                  padX: 14, padY: 6  },
  badge:   { label: 'Badge',   bg: '#bef264',             fg: '#000000', radius: 9999, border: null,                       padX: 0,  padY: 0  },
  // Counter is a numbered badge; the .text field carries the number string.
  // Default tint is the same vibrant lime as badge but circular and bold.
  counter: { label: 'Counter', bg: '#facc15',             fg: '#0a0a0a', radius: 9999, border: null,                       padX: 0,  padY: 0  }
}

export const MASK_DEFS = {
  spotlight: { label: 'Spotlight' },
  blur:      { label: 'Blur' },
  magnifier: { label: 'Magnifier' }
}

// Per-kind sensible defaults for size + duration when placing without drag.
// All values normalized [0..1]; w/h is the *full* size of the annotation
// (not half-size). Tuned so each shape looks "right" out of the box.
export function defaultGeometryFor({ kind, shapeId, maskId, styleId }) {
  if (kind === 'shape') {
    switch (shapeId) {
      case 'arrow':        return { w: 0.22, h: 0.05 }
      case 'line':         return { w: 0.20, h: 0.03 }
      case 'arrow-down':   return { w: 0.05, h: 0.22 }
      case 'circle':       return { w: 0.16, h: 0.16 }
      case 'box':
      case 'box-rounded':  return { w: 0.24, h: 0.16 }
      default:             return { w: 0.20, h: 0.08 }
    }
  }
  if (kind === 'mask') {
    switch (maskId) {
      case 'spotlight':    return { w: 0.30, h: 0.30 }
      case 'blur':         return { w: 0.30, h: 0.18 }
      case 'magnifier':    return { w: 0.18, h: 0.18 }
      default:             return { w: 0.20, h: 0.20 }
    }
  }
  // text
  if (styleId === 'badge' || styleId === 'counter') return { w: 0.05, h: 0.05 }
  return { w: 0.20, h: 0.06 }
}

// Default tint per annotation. Used as the initial `color` value on creation.
export function defaultColorFor({ kind, shapeId, maskId, styleId }) {
  if (kind === 'shape') return SHAPE_DEFS[shapeId]?.stroke || '#ffffff'
  if (kind === 'mask')  return '#ffffff'
  return TEXT_STYLE_DEFS[styleId]?.bg || '#ffffff'
}

export function defaultDurationMsFor({ kind }) {
  // Keep all kinds the same for now (3 s); the user adjusts via the panel.
  return 3000
}

export const DEFAULT_FADE_MS = 180
export const DEFAULT_BLUR_RADIUS = 16
export const DEFAULT_SPOTLIGHT_DARKNESS = 0.55
export const DEFAULT_MAGNIFIER_ZOOM = 2.2
