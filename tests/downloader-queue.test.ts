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
})