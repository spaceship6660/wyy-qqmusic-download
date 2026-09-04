import { describe, it, expect, vi, afterEach } from 'vitest'

// 注入式 fetch：client.ts 导出工厂 createQqClient(fetchImpl, opts)，测试替换 fetchImpl
import { createQqClient, QqApiError } from '../src/main/qqapi/client'

function jsonFetch(status: number, body: unknown): typeof fetch {
  // body === '' 表示模拟空响应体（风控特征）：JSON.stringify('') 会得到 '""'，
  // 并非空文本，故直接透传空串；JSON.stringify 可能返回 undefined（严格 TS 下
  // BodyInit 不接受），用 ?? '' 兜底。
  const payload = body === '' ? '' : (JSON.stringify(body) ?? '')
  return vi.fn(async () => new Response(payload, {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers() // 重试用例用 fake timers 控制退避，避免泄漏到其他用例
})

// 这些用例不关心请求体内容，但 strict TS 下 MusicuReq 的 module/method/param 必填
const dummyReq = { module: 'x', method: 'y', param: {} }

describe('postMusicu', () => {
  it('发送正确的端点/头/体并解析嵌套路径', async () => {
    const fetchMock = jsonFetch(200, { req: { data: { body: { song: { list: [{ mid: 'M1' }] } } } } })
    const client = createQqClient(fetchMock, { uin: '0' })
    const out = await client.postMusicu({ req: { module: 'x', method: 'y', param: {} } }, {
      path: ['req', 'data', 'body', 'song', 'list'],
    })
    // 请求形状
    const [url, init] = (fetchMock as any).mock.calls[0]
    expect(String(url)).toBe('https://u.y.qq.com/cgi-bin/musicu.fcg')
    expect(init.method).toBe('POST')
    expect(init.headers['referer']).toBe('https://y.qq.com/')
    expect(init.headers['content-type']).toContain('application/json')
    expect(init.headers['user-agent']).toContain('Firefox/115')
    const sent = JSON.parse(init.body)
    expect(sent.comm.uin).toBe('0')
    // 解析结果
    expect(out).toEqual([{ mid: 'M1' }])
  })

  it('带 cookie 时附加 Cookie 头', async () => {
    const fetchMock = jsonFetch(200, {})
    const client = createQqClient(fetchMock, { uin: 'o123', cookie: 'uin=o123; qqmusic_key=k' })
    await client.postMusicu({ req: dummyReq }, { path: [] })
    const [, init] = (fetchMock as any).mock.calls[0]
    expect(init.headers['cookie']).toBe('uin=o123; qqmusic_key=k')
  })

  it('路径缺失抛 QqApiError 并携带原始数据', async () => {
    const fetchMock = jsonFetch(200, { req: { data: {} } })
    const client = createQqClient(fetchMock, { uin: '0' })
    const err = await client
      .postMusicu({ req: dummyReq }, { path: ['a', 'b'] })
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(QqApiError)
    // 原始响应随错误带出，便于调用方诊断
    expect((err as QqApiError).raw).toEqual({ req: { data: {} } })
    expect((err as QqApiError).code).toBe('path-missing')
  })

  it('空响应（风控特征）抛 QqApiError(rate-limited)', async () => {
    const client = createQqClient(jsonFetch(200, ''), { uin: '0' })
    await expect(client.postMusicu({ req: dummyReq }, { path: [] })).rejects.toThrow(/rate/i)
  })

  it('网络层错误才重试：第一次失败第二次成功（maxRetries: 1）', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(
          new Response('{"req":{"data":{"body":{"song":{"list":[{"mid":"M1"}]}}}}}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      const client = createQqClient(fetchMock, { uin: '0' })
      const pending = client.postMusicu({ req: dummyReq }, {
        path: ['req', 'data', 'body', 'song', 'list'],
        maxRetries: 1,
      })
      // 第一次 fetch 立即 rejected → 进入退避 sleep(1000)，用 fake timers 跳过
      await vi.advanceTimersByTimeAsync(1000)
      await expect(pending).resolves.toEqual([{ mid: 'M1' }])
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('QqApiError（风控）不重试：只请求一次', async () => {
    const fetchMock = jsonFetch(200, '')
    const client = createQqClient(fetchMock, { uin: '0' })
    await expect(client.postMusicu({ req: dummyReq }, { path: [] })).rejects.toThrow(/rate/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})