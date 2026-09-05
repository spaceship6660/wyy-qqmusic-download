import { QqApiError } from '../qqapi/client'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0'
const REFERER = 'https://music.163.com/'
const TIMEOUT_MS = 15000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface NeClient {
  /** 设置登录 cookie（完整 Cookie 头，含 MUSIC_U） */
  setCookie(cookie: string): void
  getCookie(): string
  /** GET JSON；QqApiError（风控等确定性错误）不重试，网络错误重试 2 次退避 1s/2s */
  getJson<T = unknown>(url: string): Promise<T>
}

export function createNeClient(fetchImpl: typeof fetch = fetch): NeClient {
  let cookie = ''

  function headers(): Record<string, string> {
    const h: Record<string, string> = { 'user-agent': UA, referer: REFERER, accept: 'application/json' }
    if (cookie) h['cookie'] = cookie
    return h
  }

  async function getJson<T = unknown>(url: string): Promise<T> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1))
      try {
        const res = await fetchImpl(url, { headers: headers(), redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
        const text = await res.text()
        if (!text || text.trim() === '') throw new QqApiError('rate-limited: 空响应（风控）', 'rate-limited')
        try {
          return JSON.parse(text) as T
        } catch {
          throw new QqApiError(`非 JSON 响应: ${text.slice(0, 80)}`, res.status)
        }
      } catch (err) {
        if (err instanceof QqApiError) throw err
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new QqApiError(String(lastErr))
  }

  return {
    setCookie(c) { cookie = c },
    getCookie() { return cookie },
    getJson,
  }
}