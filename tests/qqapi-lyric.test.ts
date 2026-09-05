import { describe, it, expect, vi } from 'vitest'
import { createQqClient } from '../src/main/qqapi/client'
import { fetchLyric } from '../src/main/qqapi/tracks'

describe('fetchLyric', () => {
  it('PlayLyricInfo base64 lrc 解出文本', async () => {
    const body = JSON.stringify({ req_2: { code: 0, data: { lyric: Buffer.from('[00:01.00]测试').toString('base64') } } })
    const fetchMock = vi.fn(async () => new Response(body)) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: '0' })
    const lrc = await fetchLyric(client, 'M001')
    expect(lrc).toContain('[00:01.00]测试')
  })

  it('无歌词（data.lyric 空）返回空串不抛错', async () => {
    const body = JSON.stringify({ req_2: { code: 0, data: { lyric: '' } } })
    const fetchMock = vi.fn(async () => new Response(body)) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: '0' })
    expect(await fetchLyric(client, 'M001')).toBe('')
  })

  it('路径缺失/异常返回空串不抛错', async () => {
    const body = JSON.stringify({ req_2: { code: 0, data: {} } })
    const fetchMock = vi.fn(async () => new Response(body)) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: '0' })
    expect(await fetchLyric(client, 'M001')).toBe('')
  })
})