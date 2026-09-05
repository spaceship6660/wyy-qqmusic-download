import { describe, it, expect, vi } from 'vitest'
import { createNeClient } from '../src/main/neteaseapi/client'
import { neFetchLyric } from '../src/main/neteaseapi/lyric'

describe('neFetchLyric', () => {
  it('lrc.lyric 解出文本', async () => {
    const body = JSON.stringify({ lrc: { lyric: '[00:01.00]第一行\n[ti:测试]' }, tlyric: { lyric: '' } })
    const fetchMock = vi.fn(async () => new Response(body)) as unknown as typeof fetch
    const client = createNeClient(fetchMock)
    expect(await neFetchLyric(client, 103027)).toContain('[00:01.00]第一行')
  })
  it('无歌词/异常 → 空串', async () => {
    const fetchMock = vi.fn(async () => new Response('{}')) as unknown as typeof fetch
    const client = createNeClient(fetchMock)
    expect(await neFetchLyric(client, 103027)).toBe('')
  })
})