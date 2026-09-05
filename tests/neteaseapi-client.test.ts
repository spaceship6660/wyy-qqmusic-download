import { describe, it, expect, vi } from 'vitest'
import { createNeClient } from '../src/main/neteaseapi/client'
import { QqApiError } from '../src/main/qqapi/client'

function jsonFetch(body: unknown): typeof fetch {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
}

describe('createNeClient', () => {
  it('GET 带 Referer/UA/cookie 并解析 JSON', async () => {
    const fetchMock = jsonFetch({ code: 200, playlist: [{ id: 1 }] })
    const client = createNeClient(fetchMock)
    client.setCookie('MUSIC_U=abc')
    const out = await client.getJson('https://music.163.com/api/user/playlist?uid=1')
    expect(out).toEqual({ code: 200, playlist: [{ id: 1 }] })
    const [url, init] = (fetchMock as any).mock.calls[0]
    expect(String(url)).toContain('api/user/playlist')
    expect(init.headers.referer).toBe('https://music.163.com/')
    expect(init.headers.cookie).toBe('MUSIC_U=abc')
    expect(init.headers['user-agent']).toContain('Firefox')
  })

  it('空响应（风控特征）抛 QqApiError(rate-limited)', async () => {
    const fetchMock = jsonFetch('')
    const client = createNeClient(fetchMock)
    await expect(client.getJson('https://music.163.com/api/x')).rejects.toThrow(/rate/i)
  })

  it('非 JSON 响应抛 QqApiError', async () => {
    const fetchMock = jsonFetch('<html>error</html>')
    const client = createNeClient(fetchMock)
    await expect(client.getJson('https://music.163.com/api/x')).rejects.toThrow(QqApiError)
  })

  it('网络错误重试后成功', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('{"ok":true}'))
    const client = createNeClient(fetchMock as any)
    expect(await client.getJson('https://music.163.com/api/x')).toEqual({ ok: true })
    expect((fetchMock as any).mock.calls.length).toBe(2)
  })
})