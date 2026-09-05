import { describe, it, expect, vi } from 'vitest'
import { createNeClient } from '../src/main/neteaseapi/client'
import { NE_QUALITY_BR, NE_LADDER, neGetAudioUrl } from '../src/main/neteaseapi/urls'

function urlFetch(script: Array<{ url: string | null; br: number }>): typeof fetch {
  let i = 0
  return vi.fn(async (input: any) => {
    const u = String(input)
    if (!u.includes('/api/song/enhance/player/url')) return new Response('{}')
    const s = script[Math.min(i++, script.length - 1)] ?? script[script.length - 1]
    const data = s.url
      ? [{ id: 1, url: s.url, br: s.br, code: 200 }]
      : [{ id: 1, url: null, br: s.br, code: 200 }]
    return new Response(JSON.stringify({ code: 200, data }))
  }) as unknown as typeof fetch
}

describe('NE_QUALITY_BR / NE_LADDER', () => {
  it('三档映射与降级顺序', () => {
    expect(NE_QUALITY_BR.flac).toBe(0)
    expect(NE_QUALITY_BR['320']).toBe(320000)
    expect(NE_QUALITY_BR['128']).toBe(128000)
    expect(NE_LADDER).toEqual(['flac', '320', '128'])
  })
})

describe('neGetAudioUrl', () => {
  it('320 直接命中', async () => {
    const client = createNeClient(urlFetch([{ url: 'https://m10.music.126.net/1.mp3?x=1', br: 320000 }]))
    const r = await neGetAudioUrl(client, 103027, '320')
    expect(r.url).toContain('https://m10.music.126.net/1.mp3')
    expect(r.quality).toBe('320')
    expect(r.downgraded).toBe(false)
  })

  it('无损空 → 降 320 → 128（标记 downgraded）', async () => {
    const client = createNeClient(urlFetch([
      { url: null, br: 0 },
      { url: 'https://m10.music.126.net/320.mp3', br: 320000 },
    ]))
    const r = await neGetAudioUrl(client, 103027, 'flac')
    expect(r.quality).toBe('320')
    expect(r.downgraded).toBe(true)
  })

  it('全部空 → 抛 QqApiError（no-playable-url）', async () => {
    const client = createNeClient(urlFetch([{ url: null, br: 0 }]))
    const err = await neGetAudioUrl(client, 103027, 'flac').catch((e) => e)
    expect(err.code).toBe('no-playable-url')
  })

  it('ape/m4a 请求档不在支持表 → 从 320 起试', async () => {
    const client = createNeClient(urlFetch([{ url: 'https://m10.music.126.net/320.mp3', br: 320000 }]))
    const r = await neGetAudioUrl(client, 103027, 'ape')
    expect(r.quality).toBe('320')
    expect(r.downgraded).toBe(true)
  })
})