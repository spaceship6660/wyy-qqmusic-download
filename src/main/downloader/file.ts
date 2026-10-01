import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { PassThrough, Readable } from 'node:stream'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface DownloadResult { size: number; path: string; cdnSwitched: boolean }

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
  /** 403（CDN 节点级拒收）时的同 URL 备用候选——换 host，路径与签名参数不变。
   *  仅在首个 URL 抛 403 时调用一次；每个候选只试一次（不重试），全部失败则抛回原始 403，
   *  让上层兜底判据（`/HTTP 403/`）保持不变。详见 neteaseapi/cdn.ts 的实测记录。 */
  altUrls?: (url: string) => string[]
}

export async function downloadFile(
  url: string,
  dest: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  try {
    return await downloadOnce(url, dest, opts, opts.retries ?? 2)
  } catch (err) {
    // 403 是确定性错误，且实测为「特定 CDN 节点拒收该签名直链」——同一串 URL 换节点即可 206。
    // 先换节点，比「重取直链」（仍是同一节点）或「改走匿名」（丢无损）都更对症。
    if (!(err instanceof DownloadHttpError) || err.status !== 403) throw err
    const alts = opts.altUrls?.(url) ?? []
    for (const alt of alts) {
      if (opts.signal?.aborted) throw err
      try {
        const r = await downloadOnce(alt, dest, opts, 0)
        return { ...r, cdnSwitched: true }
      } catch {
        // 该备用节点也不可用：继续下一个；全部失败后抛原始 403（不吞原始错误语义）
      }
    }
    throw err
  }
}

/** 单 URL 下载（含瞬态错误重试）。403/404 为确定性错误，立即抛出交给 downloadFile 处置。 */
async function downloadOnce(
  url: string,
  dest: string,
  opts: DownloadOptions,
  retries: number,
): Promise<DownloadResult> {
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
      return { size, path: dest, cdnSwitched: false }
    } catch (err) {
      // 404/403 等确定性 HTTP 错误重试无意义（直链过期/节点拒收），立即抛出，
      // 避免 3 次 × 30s 白等；403 由 downloadFile 换节点重试，仍失败再由上层 runner 处置
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