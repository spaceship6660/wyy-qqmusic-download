import { describe, it, expect, vi, afterEach } from 'vitest'
import { RateLimiter } from '../src/main/downloader/ratelimit'

afterEach(() => vi.useRealTimers())

describe('RateLimiter', () => {
  it('并发调用保持间隔（槽位预留）', async () => {
    // now: 0 —— vitest 默认把假时钟初始化为真实时间戳，会导致第一次 wait() 因
    // last=0 而无需等待；固定为 0 才能精确验证槽位预留的时序
    vi.useFakeTimers({ now: 0 })
    const rl = new RateLimiter(200)
    const order: string[] = []
    const p1 = rl.wait().then(() => order.push('a'))
    const p2 = rl.wait().then(() => order.push('b'))
    await vi.advanceTimersByTimeAsync(199)
    expect(order).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(order).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(199)
    expect(order).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(1)
    expect(order).toEqual(['a', 'b'])
  })

  it('无竞争时立即放行（间隔已过）', async () => {
    vi.useFakeTimers({ now: 0 })
    const rl = new RateLimiter(200)
    const p1 = rl.wait()
    await vi.advanceTimersByTimeAsync(200)  // 第一次调用完成，last=200
    await p1
    await vi.advanceTimersByTimeAsync(300)  // 间隔已过 → now=500 > last+200
    const before = vi.getTimerCount()
    const p2 = rl.wait()
    expect(vi.getTimerCount()).toBe(before)  // 无新增 sleep
    await p2
  })
})