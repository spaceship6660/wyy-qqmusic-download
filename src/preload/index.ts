import { contextBridge, ipcRenderer } from 'electron'

const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke(channel, ...args),
}
contextBridge.exposeInMainWorld('api', api)