import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * JSON 净化：IPC 边界只允许可结构化克隆的值（纯 JSON）。
 * 2026-09-06 实机弹窗「An object could not be cloned.」——参数或返回值里一旦混入
 * Set/函数/类实例等（历史遗留如 Set 选中集），ipcRenderer.invoke 直接抛 DataCloneError，
 * 用户侧表现为「点了下载没反应 + 弹窗」。统一净化后此类错误归零；undefined 字段按
 * JSON 语义丢弃（下游均按可选处理）。
 */
function clean(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return undefined
  }
}

// 通道白名单：window.api 是渲染侧唯一的特权面，泛化 invoke 会让任何渲染脚本
// 触达任意主进程 handler（settings:set 任意目录、unlock:run 任意文件等）。只放行已知通道。
const HANDLER_CHANNELS = new Set<string>([
  'qq:search', 'qq:userPlaylists', 'qq:favPlaylists', 'qq:dissTracks',
  'qq:albumSearch', 'qq:albumSongs', 'qq:linkTracks',
  'ne:search', 'ne:albumSearch', 'ne:albumSongs', 'ne:playlistPage',
  'ne:account', 'ne:playlists', 'ne:playlist',
  'ne:auth:importCookie', 'ne:auth:status', 'ne:auth:clear', 'ne:auth:open',
  'dl:enqueue', 'dl:retry', 'dl:cancel',
  'settings:get', 'settings:set',
  'auth:startQr', 'auth:poll', 'auth:waitResult', 'auth:importCookie', 'auth:clear', 'auth:status',
  'fs:openDir', 'unlock:run',
])
const EVENT_CHANNELS = new Set<string>([
  'dl:queued', 'dl:jobStart', 'dl:progress', 'dl:done', 'dl:failed', 'dl:cancelled', 'ne:authChanged',
])

const api = {
  invoke: async (channel: string, ...args: unknown[]): Promise<any> => {
    if (!HANDLER_CHANNELS.has(channel)) throw new Error(`未授权的 IPC 通道: ${channel}`)
    const res = await ipcRenderer.invoke(channel, ...args.map((a) => clean(a)))
    return clean(res)
  },
  on: (channel: string, cb: (payload: any) => void): (() => void) => {
    if (!EVENT_CHANNELS.has(channel)) throw new Error(`未授权的事件通道: ${channel}`)
    const handler = (_e: unknown, payload: unknown): void => cb(clean(payload))
    ipcRenderer.on(channel, handler as any)
    return () => ipcRenderer.removeListener(channel, handler as any)
  },
  /** Electron 36+：目录选择器的 File 只能经 webUtils.getPathForFile 取绝对路径 */
  getPathForFile: (f: any): string => webUtils.getPathForFile(f),
}
contextBridge.exposeInMainWorld('api', api)