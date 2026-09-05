import { app, ipcMain, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { createApp } from './app'

const appInstance = createApp({
  userDataDir: app.getPath('userData'),
  emitEvent: (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send(channel, payload)
      } catch {
        // 窗口未就绪/已销毁时忽略
      }
    }
  },
})

ipcMain.handle('qq:search', (_e, q: string) => appInstance.search(q))
ipcMain.handle('qq:linkTracks', (_e, url: string) => appInstance.fetchTracksByLink(url))
ipcMain.handle('dl:enqueue', (_e, tracks: unknown[], quality: string) => appInstance.enqueue(tracks as any, quality as any))
ipcMain.handle('settings:get', () => appInstance.settingsGet())
ipcMain.handle('settings:set', (_e, patch: unknown) => appInstance.settingsSet(patch as any))
ipcMain.handle('auth:startQr', () => appInstance.authStartQr())
ipcMain.handle('auth:poll', () => appInstance.authPoll())
ipcMain.handle('auth:waitResult', (_e, ms: number) => appInstance.authWaitResult(ms))
ipcMain.handle('auth:importCookie', (_e, c: string) => appInstance.authImportCookie(c))
ipcMain.handle('auth:status', () => appInstance.authStatus())

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1080,
    height: 820,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})