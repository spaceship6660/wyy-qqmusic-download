import { EventEmitter } from 'node:events'
import { TrackDTO, Quality } from '../qqapi/tracks'

export type JobState = 'queued' | 'running' | 'done' | 'failed'

export interface DownloadJob {
  id: string
  source: 'qq' | 'netease'      // T10 runner 按它选直链层（P2 网易云复用）
  track: TrackDTO
  quality: Quality
  state: JobState
  progress: number          // 0-100
  error?: string
  outputPath?: string
  downgraded?: boolean      // 请求无损但实际降级（渲染器展示黄条）
}

export interface QueueDeps {
  concurrency: number
  rateLimiter: { wait(): Promise<void> }
  runner: (job: DownloadJob, report: (pct: number) => void) => Promise<{ outputPath?: string } | void>
}

export class DownloadQueue extends EventEmitter {
  private queue: DownloadJob[] = []
  private running = 0
  private idleResolvers: Array<() => void> = []

  constructor(private deps: QueueDeps) { super() }

  /** 运行时调整并发（settingsSet 生效；下限 1） */
  setConcurrency(n: number): void {
    this.deps.concurrency = Math.max(1, n)
  }

  enqueue(jobs: DownloadJob[]): void {
    this.queue.push(...jobs)
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
    try {
      job.state = 'running'
      this.emit('jobStart', job)
      await this.deps.rateLimiter.wait()
      const { outputPath } = (await this.deps.runner(job, (pct) => {
        if (finished) return
        if (pct !== job.progress) {
          job.progress = pct
          this.emit('jobProgress', job)
        }
      })) ?? {}
      finished = true
      job.state = 'done'
      job.progress = 100
      job.outputPath = outputPath
      this.emit('jobDone', job)
    } catch (err) {
      finished = true
      job.state = 'failed'
      job.error = err instanceof Error ? err.message : String(err)
      this.emit('jobFailed', job)
    }
  }

  waitIdle(ms: number): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      this.idleResolvers.push(() => { clearTimeout(t); resolve() })
    })
  }
}