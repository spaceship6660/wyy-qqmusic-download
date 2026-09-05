export {}
declare global {
  interface Window {
    api: {
      invoke: (channel: string, ...args: unknown[]) => Promise<any>
      on: (channel: string, cb: (payload: any) => void) => void
      getPathForFile: (f: any) => string
    }
  }
}