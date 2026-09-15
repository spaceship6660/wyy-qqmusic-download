import { EventEmitter } from 'node:events'
import { TrackDTO, Quality } from '../qqapi/tracks'

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface DownloadJob {
  id: string
  source: 'qq' | 'netease'      // T10 runner 按它选直链层（P2 网易云复用）
  track: TrackDTO
  quality: Quality
  lyricMode?: 'both' | 'embed' | 'lrc' | 'none'   // 本批歌词模式；缺省时 runner 回退 settings.lyricMode
  state: JobState
  progress: number          // 0-100
  error?: string
  outputPath?: string
  downgraded?: boolean      // 请求无损但实际降级（渲染器展示黄条）
  anonFallback?: boolean    // 账户直链被拒（CDN 403）后改走匿名成功的标记（渲染器展示灰条）
  cancelRequested?: boolean // 取消标记（可序列化；AbortController 本体不放 job 上，防 IPC 结构化克隆炸）
}

export interface QueueDeps {
  concurrency: number
  rateLimiter: { wait(): Promise<void> }
  runner: (job: DownloadJob, report: (pct: number) => void, signal: AbortSignal) => Promise<{ outputPath?: string } | void>
}

export class DownloadQueue extends EventEmitter {
  private queue: DownloadJob[] = []
  private running = 0
  private idleResolvers: Array<() => void> = []
  private inflight = new Map<string, { ctrl: AbortController; job: DownloadJob }>()

  constructor(private deps: QueueDeps) { super() }

  /** 运行时调整并发（settingsSet 生效；下限 1）；调高后立刻补调度排队中的任务 */
  setConcurrency(n: number): void {
    // NaN 会让 `running < concurrency` 恒 false → pump 停摆；非有限值一律忽略
    if (Number.isFinite(n)) this.deps.concurrency = Math.max(1, Math.floor(n))
    this.pump()
  }

  /** 该 id 是否仍在排队或下载中（重试去重用：防止同 id 二次入队覆盖 inflight） */
  has(id: string): boolean {
    return this.inflight.has(id) || this.queue.some((j) => j.id === id)
  }

  enqueue(jobs: DownloadJob[]): void {
    for (const j of jobs) {
      this.queue.push(j)
      // 入队即广播（此前的 bug：排队中的任务要等被调度才 emit jobStart，
      // 渲染侧「下载中」列表在并发已满时看不到后面排队的歌）
      this.emit('jobQueued', j)
    }
    this.pump()
  }

  private pump(): void {
    while (this.running < this.deps.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!
      this.running++
      void this.runJob(job).finally(() => {
        this.running--
        this.pump()
        if (this.running === 0 && this.queue.length === 0) {
          for (const r of this.idleResolvers.splice(0)) r()
        }
      })
    }
  }

  private async runJob(job: DownloadJob): Promise<void> {
    let finished = false
    const ctrl = new AbortController()
    this.inflight.set(job.id, { ctrl, job })
    const cancelled = (): boolean => job.cancelRequested === true || ctrl.signal.aborted
    const finishCancelled = (): void => {
      finished = true
      job.state = 'cancelled'
      job.error = undefined
      this.emit('jobCancelled', job)
    }
    try {
      job.state = 'running'
      this.emit('jobStart', job)
      await this.deps.rateLimiter.wait()
      if (cancelled()) {
        finishCancelled()
        return
      }
      const { outputPath } = (await this.deps.runner(job, (pct) => {
        if (finished) return
        if (pct !== job.progress) {
          job.progress = pct
          this.emit('jobProgress', job)
        }
      }, ctrl.signal)) ?? {}
      if (cancelled()) {
        // 取消恰好在收尾前到达：按取消算（产物若已落盘保留，不删用户文件），
        // 仍记录 outputPath，便于 UI/日志定位已产出的文件
        job.outputPath = outputPath
        finishCancelled()
        return
      }
      finished = true
      job.state = 'done'
      job.progress = 100
      job.outputPath = outputPath
      this.emit('jobDone', job)
    } catch (err) {
      finished = true
      if (cancelled() || (err instanceof Error && err.name === 'AbortError')) {
        finishCancelled()
      } else {
        job.state = 'failed'
        job.error = err instanceof Error ? err.message : String(err)
        this.emit('jobFailed', job)
      }
    } finally {
      this.inflight.delete(job.id)
    }
  }

  /** 取消任务：排队中直接移除；下载中中止传输。幂等：找不到（已完成/已取消/不存在）返回 false。 */
  cancel(id: string): boolean {
    const idx = this.queue.findIndex((j) => j.id === id)
    if (idx >= 0) {
      const [j] = this.queue.splice(idx, 1)
      j.state = 'cancelled'
      j.error = undefined
      this.emit('jobCancelled', j)
      return true
    }
    const inf = this.inflight.get(id)
    if (inf) {
      inf.job.cancelRequested = true
      inf.ctrl.abort()
      return true
    }
    return false
  }

  waitIdle(ms: number): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const entry = () => { clearTimeout(t); resolve() }
      const t = setTimeout(() => {
        // 超时后移除已注册的 resolver，避免其残留、下次 idle 时被当 no-op 调用（累积泄漏）
        const i = this.idleResolvers.indexOf(entry)
        if (i >= 0) this.idleResolvers.splice(i, 1)
        resolve()
      }, ms)
      this.idleResolvers.push(entry)
    })
  }
}