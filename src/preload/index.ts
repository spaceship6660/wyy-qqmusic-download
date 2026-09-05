import { contextBridge, ipcRenderer } from 'electron'

const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, cb: (payload: any) => void): void => {
    ipcRenderer.on(channel, (_e, payload) => cb(payload))
  },
}
contextBridge.exposeInMainWorld('api', api)