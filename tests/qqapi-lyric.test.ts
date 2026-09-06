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

  it('trans 译文合并：原文行下插入同时间戳译文', async () => {
    const body = JSON.stringify({
      req_2: {
        code: 0,
        data: {
          lyric: Buffer.from('[00:01.00]原文行').toString('base64'),
          trans: Buffer.from('[00:01.00]译文行').toString('base64'),
        },
      },
    })
    const fetchMock = vi.fn(async () => new Response(body)) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: '0' })
    const lrc = await fetchLyric(client, 'M001')
    expect(lrc.split('\n')).toEqual(['[00:01.00]原文行', '[00:01.00]译文行'])
  })

  it('真实形状：kana 标签忽略、// 占位丢弃、译文按时间戳配对', async () => {
    const lyric = [
      '[ti:Lemon]',
      '[00:01.54]夢ならば',
      '[00:02.88]どれほどよかったでしょう',
    ].join('\n')
    const trans = [
      '[ti:Lemon]',
      '[kana:1ゆめ]',
      '[00:00.00]//',
      '[00:01.54]如果只是一场梦',
      '[00:02.88]那该有多好',
    ].join('\n')
    const body = JSON.stringify({
      req_2: {
        code: 0,
        data: {
          lyric: Buffer.from(lyric).toString('base64'),
          trans: Buffer.from(trans).toString('base64'),
        },
      },
    })
    const fetchMock = vi.fn(async () => new Response(body)) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: '0' })
    const lrc = await fetchLyric(client, 'M001')
    expect(lrc.split('\n')).toEqual([
      '[ti:Lemon]',
      '[00:01.54]夢ならば',
      '[00:01.54]如果只是一场梦',
      '[00:02.88]どれほどよかったでしょう',
      '[00:02.88]那该有多好',
    ])
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