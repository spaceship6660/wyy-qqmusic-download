import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createQqClient } from '../src/main/qqapi/client'
import { QUALITY_MAP, getAudioUrl } from '../src/main/qqapi/urls'

const fx = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'qqapi', 'vkey.json'), 'utf-8')

describe('质量映射', () => {
  it('四种质量映射到正确前缀/扩展名', () => {
    expect(QUALITY_MAP.flac).toEqual({ prefix: 'F000', ext: 'flac' })
    expect(QUALITY_MAP.ape).toEqual({ prefix: 'A000', ext: 'ape' })
    expect(QUALITY_MAP['320']).toEqual({ prefix: 'M800', ext: 'mp3' })
    expect(QUALITY_MAP['128']).toEqual({ prefix: 'M500', ext: 'mp3' })
    expect(QUALITY_MAP.m4a).toEqual({ prefix: 'C400', ext: 'm4a' })
  })
})

describe('getAudioUrl', () => {
  it('请求形状正确：filename 用 mediaMid', async () => {
    const fetchMock = vi.fn(async () => new Response(fx())) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: '0' })
    await getAudioUrl(client, 'M001', 'MED001', '320')
    const body = JSON.parse(((fetchMock as any).mock.calls[0][1] as any).body as string)
    expect(body.req_1.param.filename).toEqual(['M800MED001.mp3'])
    expect(body.req_1.param.songmid).toEqual(['M001'])
    expect(body.req_1.param.guid).toMatch(/^\d{5,}$/)
  })

  it('purl 空且 mediaMid≠songmid 时用双 mid 重试一次', async () => {
    const fetchMock = vi.fn(async () => new Response(fx())) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: '0' })
    const got = await getAudioUrl(client, 'M001', 'MED001', '320')
    expect(got.url).toContain('dl.stream.qqmusic.qq.com')
    const bodies = (fetchMock as any).mock.calls.map((c: any) => JSON.parse((c[1] as any).body as string))
    expect(bodies[0].req_1.param.filename).toEqual(['M800MED001.mp3'])
    expect(bodies[1].req_1.param.filename).toEqual(['M800M001M001.mp3'])
  })

  it('登录态 cookie 被携带；flac 拿不到时降级 320 并标记', async () => {
    const fetchMock = vi.fn(async () => new Response(fx())) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: 'o123', cookie: 'uin=o123; qqmusic_key=k' })
    const got = await getAudioUrl(client, 'M001', 'MED001', 'flac')
    expect(got.downgraded).toBe(true)
    expect(got.quality).toBe('320')
    const [, init] = (fetchMock as any).mock.calls[0]
    expect(init.headers.cookie).toContain('qqmusic_key')
  })

  it('全部质量拿不到时抛错并带原因', async () => {
    const empty = '{"req_1":{"code":0,"data":{"sip":["https://dl.stream.qqmusic.qq.com/"],"midurlinfo":[{"songmid":"M001","purl":""}]}}}'
    const fetchMock = vi.fn(async () => new Response(empty)) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: '0' })
    await expect(getAudioUrl(client, 'M001', 'MED001', 'flac')).rejects.toThrow(/登录|权益/)
  })
})