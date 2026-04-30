import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getSources: () => ipcRenderer.invoke('get-sources'),
  getScreenSize: () => ipcRenderer.invoke('get-screen-size'),

  startRecording: (sourceId, screenSize, withCamera) =>
    ipcRenderer.invoke('start-recording', { sourceId, screenSize, withCamera }),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  cancelRecording: () => ipcRenderer.invoke('cancel-recording'),
  writeChunk: (buffer) => ipcRenderer.invoke('write-chunk', buffer),
  writeWebcamChunk: (buffer) => ipcRenderer.invoke('write-webcam-chunk', buffer),

  processVideo: (session, opts) => ipcRenderer.invoke('process-video', { session, opts }),
  openInFinder: (filePath) => ipcRenderer.invoke('open-in-finder', filePath),
  showSaveDialog: (defaultPath) => ipcRenderer.invoke('show-save-dialog', defaultPath),

  onExportProgress: (cb) => {
    const listener = (_e, pct) => cb(pct)
    ipcRenderer.on('export-progress', listener)
    return () => ipcRenderer.removeListener('export-progress', listener)
  },
  onExportLog: (cb) => {
    const listener = (_e, msg) => cb(msg)
    ipcRenderer.on('export-log', listener)
    return () => ipcRenderer.removeListener('export-log', listener)
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
