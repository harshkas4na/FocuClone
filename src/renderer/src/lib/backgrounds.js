// Background catalogue. Each entry produces a CSS background-image string for
// the live preview, plus an FFmpeg lavfi/color/gradients descriptor used by the
// processor on export. Keep these in sync — preview must match the rendered MP4.

export const BACKGROUND_CATEGORIES = ['Wallpaper', 'Gradient', 'Solid']

export const BACKGROUNDS = [
  // Wallpapers — rich multi-stop gradients designed to feel like macOS wallpapers
  {
    id: 'wallpaper-1',
    category: 'Wallpaper',
    label: 'Sequoia',
    css: 'linear-gradient(135deg, #0e1230 0%, #2a1149 100%)',
    ffmpeg: { type: 'gradient', c0: '0x0e1230', c1: '0x2a1149' }
  },
  {
    id: 'wallpaper-2',
    category: 'Wallpaper',
    label: 'Sonoma',
    css: 'linear-gradient(135deg, #1c2541 0%, #5b3a8f 50%, #c2548c 100%)',
    ffmpeg: { type: 'gradient', c0: '0x1c2541', c1: '0xc2548c' }
  },
  {
    id: 'wallpaper-3',
    category: 'Wallpaper',
    label: 'Ventura',
    css: 'linear-gradient(135deg, #ff8a36 0%, #d62976 50%, #4f5bd5 100%)',
    ffmpeg: { type: 'gradient', c0: '0xff8a36', c1: '0x4f5bd5' }
  },
  {
    id: 'wallpaper-4',
    category: 'Wallpaper',
    label: 'Monterey',
    css: 'linear-gradient(135deg, #f4a261 0%, #e76f51 100%)',
    ffmpeg: { type: 'gradient', c0: '0xf4a261', c1: '0xe76f51' }
  },
  {
    id: 'wallpaper-5',
    category: 'Wallpaper',
    label: 'Big Sur',
    css: 'linear-gradient(135deg, #2e3192 0%, #1bffff 100%)',
    ffmpeg: { type: 'gradient', c0: '0x2e3192', c1: '0x1bffff' }
  },
  {
    id: 'wallpaper-6',
    category: 'Wallpaper',
    label: 'Catalina',
    css: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
    ffmpeg: { type: 'gradient', c0: '0x0f2027', c1: '0x2c5364' }
  },
  {
    id: 'wallpaper-7',
    category: 'Wallpaper',
    label: 'Mojave',
    css: 'linear-gradient(135deg, #232526 0%, #414345 100%)',
    ffmpeg: { type: 'gradient', c0: '0x232526', c1: '0x414345' }
  },
  {
    id: 'wallpaper-8',
    category: 'Wallpaper',
    label: 'Aurora',
    css: 'linear-gradient(135deg, #2af598 0%, #009efd 100%)',
    ffmpeg: { type: 'gradient', c0: '0x2af598', c1: '0x009efd' }
  },

  // Gradient swatches
  { id: 'grad-pink', category: 'Gradient', label: 'Pink', css: 'linear-gradient(135deg, #fbc2eb 0%, #a6c1ee 100%)', ffmpeg: { type: 'gradient', c0: '0xfbc2eb', c1: '0xa6c1ee' } },
  { id: 'grad-blue', category: 'Gradient', label: 'Blue', css: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)', ffmpeg: { type: 'gradient', c0: '0x4facfe', c1: '0x00f2fe' } },
  { id: 'grad-mint', category: 'Gradient', label: 'Mint', css: 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)', ffmpeg: { type: 'gradient', c0: '0x43e97b', c1: '0x38f9d7' } },
  { id: 'grad-peach', category: 'Gradient', label: 'Peach', css: 'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)', ffmpeg: { type: 'gradient', c0: '0xffecd2', c1: '0xfcb69f' } },
  { id: 'grad-violet', category: 'Gradient', label: 'Violet', css: 'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)', ffmpeg: { type: 'gradient', c0: '0xa18cd1', c1: '0xfbc2eb' } },
  { id: 'grad-sunset', category: 'Gradient', label: 'Sunset', css: 'linear-gradient(135deg, #ff9a9e 0%, #fad0c4 100%)', ffmpeg: { type: 'gradient', c0: '0xff9a9e', c1: '0xfad0c4' } },
  { id: 'grad-ocean', category: 'Gradient', label: 'Ocean', css: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', ffmpeg: { type: 'gradient', c0: '0x667eea', c1: '0x764ba2' } },
  { id: 'grad-fire', category: 'Gradient', label: 'Fire', css: 'linear-gradient(135deg, #f5576c 0%, #f093fb 100%)', ffmpeg: { type: 'gradient', c0: '0xf5576c', c1: '0xf093fb' } },

  // Solids
  { id: 'solid-black', category: 'Solid', label: 'Black', css: '#000000', ffmpeg: { type: 'solid', color: '0x000000' } },
  { id: 'solid-white', category: 'Solid', label: 'White', css: '#ffffff', ffmpeg: { type: 'solid', color: '0xffffff' } },
  { id: 'solid-graphite', category: 'Solid', label: 'Graphite', css: '#101014', ffmpeg: { type: 'solid', color: '0x101014' } },
  { id: 'solid-slate', category: 'Solid', label: 'Slate', css: '#1e293b', ffmpeg: { type: 'solid', color: '0x1e293b' } },
  { id: 'solid-indigo', category: 'Solid', label: 'Indigo', css: '#312e81', ffmpeg: { type: 'solid', color: '0x312e81' } },
  { id: 'solid-rose', category: 'Solid', label: 'Rose', css: '#e11d48', ffmpeg: { type: 'solid', color: '0xe11d48' } },
  { id: 'solid-emerald', category: 'Solid', label: 'Emerald', css: '#059669', ffmpeg: { type: 'solid', color: '0x059669' } },
  { id: 'solid-amber', category: 'Solid', label: 'Amber', css: '#d97706', ffmpeg: { type: 'solid', color: '0xd97706' } }
]

export function findBackground(id) {
  return BACKGROUNDS.find((b) => b.id === id) || BACKGROUNDS[0]
}

export const CANVAS_ASPECTS = [
  { id: 'original', label: 'Original', ratio: null },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 }
]

export function aspectRatioOf(id, fallback) {
  const found = CANVAS_ASPECTS.find((a) => a.id === id)
  if (!found || found.ratio == null) return fallback
  return found.ratio
}
