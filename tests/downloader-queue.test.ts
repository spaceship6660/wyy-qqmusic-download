import { describe, it, expect, vi } from 'vitest'
import { DownloadQueue, DownloadJob } from '../src/main/downloader/queue'

const job = (id: string, source: 'qq' | 'netease' = 'qq'): DownloadJob => ({
  id, source, track: { id, name: `歌曲${id}`, artist: '测试', album: '', cover: '' }, quality: '320',
  state: 'queued', progress: 0,
})

describe('DownloadQueue', () => {
  it('按并发数执行并依次完成', async () => {
    let active = 0
    let peak = 0
    const order: string[] = []
    const q = new DownloadQueue({
      concurrency: 2,
      rateLimiter: { wait: async () => {} } as any,
      runner: async (j) => {
        active++
        peak = Math.max(peak, active)
        order.push(j.track.id)
        await new Promise((r) => setTimeout(r, 20))
        active--
      },
    })
    const done = vi.fn()
    q.on('jobDone', done)
    q.enqueue([job('a'), job('b'), job('c'), job('d')])
    await q.waitIdle(1000)
    expect(order.length).toBe(4)
    expect(peak).toBe(2)
    expect(done).toHaveBeenCalledTimes(4)
  })

  it('失败任务标 failed 带原因，其余继续', async () => {
    const q = new DownloadQueue({
      concurrency: 1,
      rateLimiter: { wait: async () => {} } as any,
      runner: async (j) => { if (j.track.id === 'bad') throw new Error('炸了') },
    })
    const failed = vi.fn()
    const done = vi.fn()
    q.on('jobFailed', failed)
    q.on('jobDone', done)
    q.enqueue([job('bad'), job('ok')])
    await q.waitIdle(5000)
    expect(failed).toHaveBeenCalledTimes(1)
    expect((failed.mock.calls[0][0] as DownloadJob).error).toBe('炸了')
    expect(done).toHaveBeenCalledTimes(1)
    expect((done.mock.calls[0][0] as DownloadJob).id).toBe('ok')
    expect((done.mock.calls[0][0] as DownloadJob).state).toBe('done')
  })

  it('runner 前先过限速器', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const runCount = vi.fn()
    const q = new DownloadQueue({
      concurrency: 3,
      rateLimiter: { wait: async () => { await gate } } as any,
      runner: async () => { runCount() },
    })
    q.enqueue([job('x1'), job('x2')])
    await new Promise((r) => setTimeout(r, 10))
    expect(runCount).toHaveBeenCalledTimes(0)
    release()
    await q.waitIdle(1000)
    expect(runCount).toHaveBeenCalledTimes(2)
  })

  it('source 透传给 runner', async () => {
    const seen: string[] = []
    const q = new DownloadQueue({
      concurrency: 2,
      rateLimiter: { wait: async () => {} } as any,
      runner: async (j) => { seen.push(j.source) },
    })
    q.enqueue([job('qq1', 'qq'), job('ne1', 'netease')])
    await q.waitIdle(3000)
    expect(seen.sort()).toEqual(['netease', 'qq'])
  })

  it('入队即广播 jobQueued：并发已满时排队中的任务也能被渲染侧看到', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const q = new DownloadQueue({
      concurrency: 1,
      rateLimiter: { wait: async () => { await gate } } as any,
      runner: async () => { await new Promise((r) => setTimeout(r, 5)) },
    })
    const queued: string[] = []
    q.on('jobQueued', (j: DownloadJob) => queued.push(j.id))
    q.enqueue([job('a'), job('b'), job('c')])
    expect(queued).toEqual(['a', 'b', 'c']) // 三个都在排队事件里，而不是只有被调度的 a
    release()
    await q.waitIdle(3000)
  })
})