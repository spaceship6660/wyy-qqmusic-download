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

const api = {
  invoke: async (channel: string, ...args: unknown[]): Promise<any> => {
    const res = await ipcRenderer.invoke(channel, ...args.map((a) => clean(a)))
    return clean(res)
  },
  on: (channel: string, cb: (payload: any) => void): void => {
    ipcRenderer.on(channel, (_e, payload) => cb(clean(payload)))
  },
  /** Electron 36+：目录选择器的 File 只能经 webUtils.getPathForFile 取绝对路径 */
  getPathForFile: (f: any): string => webUtils.getPathForFile(f),
}
contextBridge.exposeInMainWorld('api', api)