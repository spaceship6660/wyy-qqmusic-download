export class QqApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number | string,
    public readonly raw?: unknown,
    public readonly retryable: boolean = false,
  ) {
    super(message)
  }
  // retryable：风控（rate-limited）/路径缺失/非 JSON 等确定性错误恒为 false，
  // 重试只会火上浇油或白等；调用方若需判定可读此字段。
}

export interface QqAuthState {
  uin: string        // '0' 表示匿名
  cookie?: string    // 完整 Cookie 头；匿名时缺省
}

export interface MusicuReq {
  module: string
  method: string
  param: unknown
}

interface PostOptions {
  path: string[]              // 响应里要取出的嵌套路径（如 ['req','data','body','song','list']）
  comm?: Record<string, unknown>
  maxRetries?: number         // 默认 2；指数退避 1s/2s；仅对非 QqApiError 的网络层错误生效
  timeoutMs?: number          // 单次请求超时，默认 15000（AbortSignal.timeout）
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0'
const API_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const DEFAULT_TIMEOUT_MS = 15000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export type FetchLike = typeof fetch

export function createQqClient(fetchImpl: FetchLike, auth: QqAuthState) {
  let currentAuth = auth

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      'user-agent': UA,
      referer: 'https://y.qq.com/',
      'content-type': 'application/json;charset=utf-8',
      accept: 'application/json',
    }
    if (currentAuth.cookie) h['cookie'] = currentAuth.cookie
    return h
  }

  async function postMusicu(reqs: Record<string, MusicuReq>, opts: PostOptions): Promise<unknown> {
    const body = JSON.stringify({
      comm: { uin: currentAuth.uin, format: 'json', ct: 24, cv: 0, ...opts.comm },
      ...reqs,
    })
    let lastErr: unknown
    for (let attempt = 0; attempt <= (opts.maxRetries ?? 2); attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1))
      try {
        const res = await fetchImpl(API_URL, {
          method: 'POST',
          headers: headers(),
          body,
          redirect: 'follow',
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        })
        const text = await res.text()
        if (!text || text.trim() === '') throw new QqApiError('rate-limited: 空响应（风控）', 'rate-limited')
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          throw new QqApiError(`非 JSON 响应: ${text.slice(0, 80)}`, res.status)
        }
        let node: unknown = json
        for (const key of opts.path) {
          if (node && typeof node === 'object' && key in (node as Record<string, unknown>)) {
            node = (node as Record<string, unknown>)[key]
          } else {
            throw new QqApiError(`路径缺失: ${opts.path.join('.')}`, 'path-missing', json)
          }
        }
        return node
      } catch (err) {
        lastErr = err
        // QqApiError 是确定性错误（风控/路径缺失/非 JSON），重试无意义，立即止损
        if (err instanceof QqApiError) break
      }
    }
    throw lastErr instanceof Error ? lastErr : new QqApiError(String(lastErr))
  }

  function setAuth(next: QqAuthState): void {
    currentAuth = next
  }

  async function get(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1))
      try {
        const res = await fetchImpl(url, {
          headers: headers(),
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        })
        const text = await res.text()
        if (!text || text.trim() === '') throw new QqApiError('rate-limited: 空响应（风控）', 'rate-limited')
        return text
      } catch (err) {
        lastErr = err
        // QqApiError 是确定性错误（风控），重试无意义，立即止损
        if (err instanceof QqApiError) break
      }
    }
    throw lastErr instanceof Error ? lastErr : new QqApiError(String(lastErr))
  }

  return { postMusicu, setAuth, get }
}

export type QqClient = ReturnType<typeof createQqClient>