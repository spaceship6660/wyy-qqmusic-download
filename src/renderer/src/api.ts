// 渲染侧统一 IPC 入口（2026-09-06 实机「An object could not be cloned.」根因修复）：
// Vue 的 Pinia state / ref 取出的对象是 reactive Proxy——Proxy 无法通过结构化克隆
// （Electron contextBridge 与 IPC 参数传递底层即 structuredClone），直接传入
// window.api.invoke 会在「主世界 → preload 隔离世界」的克隆点抛 DataCloneError，
// preload 内的净化无法拦截（发生在函数被调用时）。
// 本封装在主世界（Proxy 仍存在时）先 JSON.stringify 解引用为纯对象，克隆必然成功。
const clean = <T>(v: T): T => {
  try {
    return JSON.parse(JSON.stringify(v)) as T
  } catch {
    return undefined as unknown as T
  }
}

export const api = {
  invoke: <T = any>(channel: string, ...args: unknown[]): Promise<T> =>
    window.api.invoke(channel, ...args.map((a) => clean(a))) as Promise<T>,
  on: (channel: string, cb: (payload: any) => void): void => {
    window.api.on(channel, (payload) => cb(clean(payload)))
  },
  getPathForFile: (f: any): string => window.api.getPathForFile(f),
}