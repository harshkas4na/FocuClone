// Cursor skins. `path` is the SVG `d` for a 40×48 viewBox; `fill` may be a
// solid color or `gradient:<id>` to reference an inline <linearGradient>.
// The processor still uses the legacy cursor.png on export — these are
// preview-only for now.

export const CURSOR_STYLES = [
  { id: 'arrow-white', label: 'White arrow', family: 'arrow',
    path: 'M 4 2 L 4 42 L 14 32 L 20 46 L 26 43 L 20 30 L 34 30 Z',
    fill: '#ffffff', stroke: '#000000' },
  { id: 'arrow-black', label: 'Black arrow', family: 'arrow',
    path: 'M 4 2 L 4 42 L 14 32 L 20 46 L 26 43 L 20 30 L 34 30 Z',
    fill: '#0a0a0a', stroke: '#ffffff' },
  { id: 'arrow-yellow', label: 'Yellow', family: 'arrow',
    path: 'M 4 2 L 4 42 L 14 32 L 20 46 L 26 43 L 20 30 L 34 30 Z',
    fill: '#facc15', stroke: '#1a1a1a' },
  { id: 'arrow-orange', label: 'Orange', family: 'arrow',
    path: 'M 4 2 L 4 42 L 14 32 L 20 46 L 26 43 L 20 30 L 34 30 Z',
    fill: '#fb923c', stroke: '#1a1a1a' },
  { id: 'arrow-purple', label: 'Purple', family: 'arrow',
    path: 'M 4 2 L 4 42 L 14 32 L 20 46 L 26 43 L 20 30 L 34 30 Z',
    fill: 'gradient:purple', stroke: '#1a1a1a',
    gradient: { from: '#a855f7', to: '#ec4899' } },
  { id: 'arrow-rainbow', label: 'Rainbow', family: 'arrow',
    path: 'M 4 2 L 4 42 L 14 32 L 20 46 L 26 43 L 20 30 L 34 30 Z',
    fill: 'gradient:rainbow', stroke: '#ffffff',
    gradient: { from: '#f59e0b', to: '#3b82f6' } },
  { id: 'triangle-white', label: 'Triangle', family: 'triangle',
    path: 'M 4 2 L 4 38 L 30 30 Z',
    fill: '#ffffff', stroke: '#000000' },
  { id: 'hand', label: 'Hand', family: 'hand',
    path: 'M14 8 v 14 M19 6 v 16 M24 8 v 14 M29 12 v 10 c 0 8 -4 14 -10 14 c -8 0 -12 -6 -12 -14 v -6 c 0 -2 2 -4 4 -2 v 4',
    fill: '#ffffff', stroke: '#000000' }
]

export const CURSOR_FAMILIES = [
  { id: 'arrow', label: 'Arrow' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'hand', label: 'Hand' }
]

export function findCursorStyle(id) {
  return CURSOR_STYLES.find((c) => c.id === id) || CURSOR_STYLES[0]
}

export const CLICK_EFFECTS = [
  { id: 'none', label: 'None' },
  { id: 'ripple', label: 'Ripple' },
  { id: 'ring', label: 'Ring' },
  { id: 'spotlight', label: 'Spotlight' },
  { id: 'sparkle', label: 'Sparkle' }
]
