import { describe, it, expect } from 'vitest'
import { RateLimiter } from '../src/main/downloader/ratelimit'

describe('RateLimiter', () => {
  it('间隔内第二次调用被节流', async () => {
    const rl = new RateLimiter(200)
    const t0 = Date.now()
    await rl.wait(); await rl.wait(); await rl.wait()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(390)  // 2 个间隔
  })
})