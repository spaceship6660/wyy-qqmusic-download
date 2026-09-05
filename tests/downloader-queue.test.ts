import { describe, it, expect, vi } from 'vitest'
import { DownloadQueue, DownloadJob } from '../src/main/downloader/queue'

const job = (id: string, source: 'qq' | 'netease' = 'qq'): DownloadJob => ({
  id, source, track: { id, name: `歌曲${id}`, artist: '测试', album: '', cover: '' }, quality: '320',
  state: 'queued', progress: 0,
})

describe('DownloadQueue', () => {
  it('按并发数执行并依次完成', async () => {
    const order: string[] = []
    const q = new DownloadQueue({
      concurrency: 2,
      rateLimiter: { wait: async () => {} } as any,
      runner: async (j) => {
        order.push(j.track.id)
        await new Promise((r) => setTimeout(r, 20))
      },
    })
    const done = vi.fn()
    q.on('jobDone', done)
    q.enqueue([job('a'), job('b'), job('c'), job('d')])
    await q.waitIdle(5000)
    expect(order.length).toBe(4)
    expect(done).toHaveBeenCalledTimes(4)
  })

  it('失败任务标 failed 带原因，其余继续', async () => {
    const q = new DownloadQueue({
      concurrency: 1,
      rateLimiter: { wait: async () => {} } as any,
      runner: async (j) => { if (j.track.id === 'bad') throw new Error('炸了') },
    })
    const failed = vi.fn()
    q.on('jobFailed', failed)
    q.enqueue([job('bad'), job('ok')])
    await q.waitIdle(5000)
    expect(failed).toHaveBeenCalledTimes(1)
    expect((failed.mock.calls[0][0] as DownloadJob).error).toBe('炸了')
  })

  it('runner 前先过限速器', async () => {
    const waits: number[] = []
    const q = new DownloadQueue({
      concurrency: 3,
      rateLimiter: { wait: async () => { waits.push(Date.now()) } } as any,
      runner: async () => {},
    })
    q.enqueue([job('x1'), job('x2')])
    await q.waitIdle(3000)
    expect(waits.length).toBe(2)
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