import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { PassThrough, Readable } from 'node:stream'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface DownloadResult { size: number; path: string }

/** 非 2xx 响应。status 供上层区分「直链过期/404」与「其他错误」。 */
export class DownloadHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
  }
}

export interface DownloadOptions {
  retries?: number           // 默认 2，退避 1s/2s
  timeoutMs?: number         // 「无数据」间隔超时，默认 30000（持续有数据不超时；总时长不限）
  signal?: AbortSignal       // 调用方取消/超时信号
  onProgress?: (got: number, total: number) => void
}

export async function downloadFile(
  url: string,
  dest: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const retries = opts.retries ?? 2
  const timeoutMs = opts.timeoutMs ?? 30000
  const part = dest + '.part'
  // 注意：.part 路径为单次调用私有，本函数不防并发写同一 dest；队列层必须自行保证 dest 唯一
  //（uniquePath 是 check-then-write，并发同名任务可能撞同一个 .part —— T10 编排时按 track.id 去重/预留）
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    // 取消短路：abort 后不再睡退避、不再发请求，直接抛给队列标 cancelled
    if (opts.signal?.aborted) {
      const reason = (opts.signal as { reason?: unknown }).reason
      throw reason instanceof Error ? reason : new Error('已取消')
    }
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1))
    // 无数据间隔超时：每收到一块数据就重新计时，避免大文件/慢链路被「总时长 30s」误杀
    const ctrl = new AbortController()
    const onOuterAbort = (): void => ctrl.abort((opts.signal as { reason?: unknown } | undefined)?.reason)
    if (opts.signal) opts.signal.addEventListener('abort', onOuterAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => ctrl.abort(new Error('下载超时：长时间无数据')), timeoutMs)
    }
    try {
      arm()
      const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal })
      if (!res.ok) throw new DownloadHttpError(`HTTP ${res.status}`, res.status)
      const total = Number(res.headers.get('content-length') ?? 0)
      const body = res.body
      if (!body) throw new Error('空响应体')
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const out = fs.createWriteStream(part)
      let got = 0
      const counter = new PassThrough()
      counter.on('data', (chunk: Buffer) => {
        got += chunk.length
        arm()
        opts.onProgress?.(got, total)
      })
      // pipeline 自带背压，流错误（写盘失败/中断）会 reject 并走重试
      await pipeline(Readable.fromWeb(body as any), counter, out)
      const size = fs.statSync(part).size
      if (size === 0) throw new Error('文件为空')
      fs.renameSync(part, dest)
      return { size, path: dest }
    } catch (err) {
      // 404/403 等确定性 HTTP 错误重试无意义（直链过期/风控），立即抛出，
      // 避免 3 次 × 30s 白等；由上层 runner 重取直链后重下
      if (err instanceof DownloadHttpError && (err.status === 404 || err.status === 403)) throw err
      lastErr = err
      // 清理 .part：unlink 自身失败（句柄未释放等）不能顶替真实错误、也不能中断重试
      try {
        if (fs.existsSync(part)) fs.unlinkSync(part)
      } catch { /* 留给下次覆盖写 */ }
    } finally {
      if (timer) clearTimeout(timer)
      if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}