import { create } from 'zustand'

export const useSession = create((set) => ({
  screen: 'home',
  source: null,
  micEnabled: false,
  session: null,
  exportSettings: {
    zoomLevel: 2.0,
    easeInDuration: 300,
    holdDuration: 1200,
    easeOutDuration: 300,
    minTimeBetweenZooms: 800,
    showCursor: true,
    background: 'none',
    quality: 23,
    fps: 30,
    useVideoToolbox: true
  },
  exportResult: null,

  goto: (screen) => set({ screen }),
  setSource: (source) => set({ source }),
  setMicEnabled: (micEnabled) => set({ micEnabled }),
  setSession: (session) => set({ session }),
  updateExportSettings: (patch) =>
    set((s) => ({ exportSettings: { ...s.exportSettings, ...patch } })),
  setExportResult: (exportResult) => set({ exportResult }),
  reset: () =>
    set({
      screen: 'home',
      source: null,
      session: null,
      exportResult: null
    })
}))
