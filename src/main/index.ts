import { app, ipcMain, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createApp } from './app'
import { buildCookieHeader, cookieHeaderHasMusicU } from './neteaseAuth'

// 登录通道对齐参考实现（Spica qqmusic.py _direct_opener 注释：「QQ 登录端点全部是
// 国内服务，不能跟随系统代理」，且 urllib/httpx 均为 HTTP/1.1）：
// 1) no-proxy-server —— Chromium 网络栈默认跟随系统代理，代理出口 IP 会让
//    ptlogin2 风控走另一套响应（不给 p_skey）；登录/下载全直连。
// 2) disable-http2 —— ptlogin 系接口在 HTTP/2 会话上的行为差异是
//    「Python 参考实现成功、Electron 失败」的剩余断层（2026-09-06 实证）。
// 必须在 app ready 前设置。
app.commandLine.appendSwitch('no-proxy-server')
app.commandLine.appendSwitch('disable-http2')

// QQ 登录诊断日志：默认写入 userData/qq-login-diag.log（每次扫码尝试追加，
// 失败时 UI 显示该路径；内容含 QQ 号与会话 token 摘要，仅本机排障用，不入库）。
// QQ_DIAG_LOG 可覆盖路径（测试/临时目录）。
const diagLogFile = process.env['QQ_DIAG_LOG'] || join(app.getPath('userData'), 'qq-login-diag.log')
try {
  // 启动头：区分构建版本（若用户跑的是旧包，日志里不会有这一行）
  appendFileSync(diagLogFile, `[${new Date().toISOString()}] 音乐下载器 v${app.getVersion()} 启动\n`, 'utf-8')
} catch {
  // 诊断文件写失败（只读目录等）不影响使用
}

const appInstance = createApp({
  userDataDir: app.getPath('userData'),
  debugLogFile: diagLogFile,
  emitEvent: (channel, payload) => {
    // webContents.send 同样做结构化克隆：先 JSON 净化，杜绝 DataCloneError
    let safe: unknown
    try {
      safe = JSON.parse(JSON.stringify(payload))
    } catch {
      return
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send(channel, safe)
      } catch {
        // 窗口未就绪/已销毁时忽略
      }
    }
  },
})

// IPC 全 handler 包装（2026-09-06 实机「An object could not be cloned.」排查）：
// 1) handler 异常 → 写盘（含 stack）后原样 reject（渲染层保持原有行为）；
// 2) 返回值统一 JSON 化——DataCloneError 发生在 Electron 内部序列化时，handler
//    本身不抛、常规 catch 抓不到；stringify 失败（BigInt/循环引用/函数等）才是
//    真凶，此时写盘记录并返回 undefined。诊断日志同 userData。
const ipcErrorLog = join(app.getPath('userData'), 'ipc-errors.log')
function safeHandle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_e, ...args: any[]) => {
    try {
      const r = await fn(...args)
      try {
        return JSON.parse(JSON.stringify(r))
      } catch (serr) {
        try {
          appendFileSync(
            ipcErrorLog,
            `[${new Date().toISOString()}] ${channel} 返回值不可序列化: ${serr instanceof Error ? serr.message : String(serr)}
` +
              `类型: ${r === null ? 'null' : typeof r} | ${Object.prototype.toString.call(r)}
`,
            'utf-8',
          )
        } catch {
          // 写失败忽略
        }
        return undefined
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      try {
        appendFileSync(
          ipcErrorLog,
          `[${new Date().toISOString()}] ${channel} 失败: ${msg}
${err instanceof Error ? (err.stack ?? '') : ''}
`,
          'utf-8',
        )
      } catch {
        // 写失败忽略
      }
      throw err
    }
  })
}

safeHandle('qq:search', (q: string) => appInstance.search(q))
safeHandle('qq:linkTracks', (url: string) => appInstance.fetchTracksByLink(url))
safeHandle('dl:enqueue', (payload: unknown) => appInstance.enqueue(payload as any))
safeHandle('settings:get', () => appInstance.settingsGet())
safeHandle('settings:set', (patch: unknown) => appInstance.settingsSet(patch as any))
safeHandle('auth:startQr', () => appInstance.authStartQr())
safeHandle('auth:poll', () => appInstance.authPoll())
safeHandle('auth:waitResult', (ms: number) => appInstance.authWaitResult(ms))
safeHandle('auth:importCookie', (c: string) => appInstance.authImportCookie(c))
safeHandle('auth:status', () => appInstance.authStatus())
safeHandle('fs:openDir', (p: string) => { if (p) shell.showItemInFolder(p) })
safeHandle('unlock:run', (paths: unknown) => appInstance.unlockRun(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []))
safeHandle('ne:search', (q: string) => appInstance.neSearch(q))
safeHandle('ne:account', () => appInstance.neAccount())
safeHandle('ne:playlists', (uid: number) => appInstance.nePlaylists(uid))
safeHandle('ne:playlist', (id: string) => appInstance.nePlaylist(id))
safeHandle('ne:auth:importCookie', (c: string) => appInstance.neAuthImport(c))
safeHandle('ne:auth:status', () => appInstance.neAuthStatus())
safeHandle('ne:auth:clear', () => appInstance.neAuthClear())
ipcMain.handle('ne:auth:open', async () => {
  // 开窗扫码（Creamplayer 模式）：加载 music.163.com/login，窗口关闭即抓 cookie；
  // 窗口生命周期防御：重复打开先关旧窗（按登录页 URL 识别），避免窗口堆积
  const { BrowserWindow: BW, session } = await import('electron')
  for (const w of BW.getAllWindows()) {
    if (w.webContents.getURL().startsWith('https://music.163.com')) w.destroy()
  }
  const win = new BW({ width: 900, height: 700, autoHideMenuBar: true })
  try {
    await win.loadURL('https://music.163.com/login')
  } catch {
    // 用户秒关窗口/页面加载失败等，忽略（closed 回调仍会尝试抓 cookie）
  }
  win.on('closed', () => {
    void (async () => {
      try {
        const cookies = await session.defaultSession.cookies.get({ url: 'https://music.163.com' })
        const header = buildCookieHeader(
          cookies.filter((c) => c.name === 'MUSIC_U' || c.name === '__csrf')
            .map((c) => ({ name: c.name, value: c.value })),
        )
        if (cookieHeaderHasMusicU(header)) {
          appInstance.neAuthSaveFromWindow(header)
          for (const w of BW.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('ne:authChanged', true)
          }
        }
      } catch { /* 窗口关闭时 session 不可用等，忽略 */ }
    })()
  })
  return true
})

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