const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class RateLimiter {
  private last = 0
  constructor(private minIntervalMs = 1000) {}
  async wait(): Promise<void> {
    const now = Date.now()
    const waitMs = this.last + this.minIntervalMs - now
    if (waitMs > 0) await sleep(waitMs)
    this.last = Date.now()
  }
}