const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class RateLimiter {
  private last = 0
  constructor(private minIntervalMs = 1000) {}
  async wait(): Promise<void> {
    const now = Date.now()
    const target = Math.max(this.last + this.minIntervalMs, now)
    this.last = target
    const d = target - now
    if (d > 0) await sleep(d)
  }
}