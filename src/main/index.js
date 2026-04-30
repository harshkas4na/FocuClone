import { app, BrowserWindow, systemPreferences, dialog, screen } from 'electron'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { registerIpcHandlers } from './ipc.js'
import { ensureAppDirs } from './fileWriter.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0e0e10',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

function checkScreenRecordingPermission() {
  if (process.platform !== 'darwin') return
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status !== 'granted') {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Screen Recording Permission Required',
      message: 'FocuClone needs Screen Recording permission.',
      detail:
        'Open System Settings → Privacy & Security → Screen Recording, enable FocuClone (or your terminal/Electron during dev), then restart the app.'
    })
  }
}

app.whenReady().then(async () => {
  await ensureAppDirs()
  registerIpcHandlers(() => mainWindow)
  createWindow()
  checkScreenRecordingPermission()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

export { mainWindow }
