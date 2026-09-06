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
  it('tlyric 中文译文按时间戳合并到原文行下', async () => {
    const body = JSON.stringify({
      lrc: { lyric: '[00:00.851]夢ならば\n[00:06.650]未だに' },
      tlyric: { lyric: '[00:00.851]如果这一切都是梦境\n[00:06.650]至今仍能' },
    })
    const fetchMock = vi.fn(async () => new Response(body)) as unknown as typeof fetch
    const client = createNeClient(fetchMock)
    const got = await neFetchLyric(client, 536622304)
    const lines = got.split('\n')
    expect(lines).toEqual([
      '[00:00.851]夢ならば',
      '[00:00.851]如果这一切都是梦境',
      '[00:06.650]未だに',
      '[00:06.650]至今仍能',
    ])
  })
  it('无歌词/异常 → 空串', async () => {
    const fetchMock = vi.fn(async () => new Response('{}')) as unknown as typeof fetch
    const client = createNeClient(fetchMock)
    expect(await neFetchLyric(client, 103027)).toBe('')
  })
})