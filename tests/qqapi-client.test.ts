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

afterEach(() => vi.restoreAllMocks())

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
    const client = createQqClient(jsonFetch(200, { req: { data: {} } }), { uin: '0' })
    await expect(client.postMusicu({ req: dummyReq }, { path: ['a', 'b'] }))
      .rejects.toThrow(QqApiError)
  })

  it('非 200 / 空响应（风控特征）抛 QqApiError(rate-limited)', async () => {
    const client = createQqClient(jsonFetch(200, ''), { uin: '0' })
    await expect(client.postMusicu({ req: dummyReq }, { path: [] })).rejects.toThrow(/rate/i)
  })
})