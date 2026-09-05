import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, cb: (payload: any) => void): void => {
    ipcRenderer.on(channel, (_e, payload) => cb(payload))
  },
  /** Electron 36+：目录选择器的 File 只能经 webUtils.getPathForFile 取绝对路径 */
  getPathForFile: (f: any): string => webUtils.getPathForFile(f),
}
contextBridge.exposeInMainWorld('api', api)