import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createQqClient } from '../src/main/qqapi/client'
import { QUALITY_MAP, qualityFromPrefix, buildCandidates, getAudioUrl } from '../src/main/qqapi/urls'

const fx = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'qqapi', 'vkey.json'), 'utf-8')

describe('质量映射与反查', () => {
  it('QUALITY_MAP 五档正确', () => {
    expect(QUALITY_MAP.flac).toEqual({ prefix: 'F000', ext: 'flac' })
    expect(QUALITY_MAP.ape).toEqual({ prefix: 'A000', ext: 'ape' })
    expect(QUALITY_MAP['320']).toEqual({ prefix: 'M800', ext: 'mp3' })
    expect(QUALITY_MAP['128']).toEqual({ prefix: 'M500', ext: 'mp3' })
    expect(QUALITY_MAP.m4a).toEqual({ prefix: 'C400', ext: 'm4a' })
  })
  it('qualityFromPrefix 反查（含 C200）', () => {
    expect(qualityFromPrefix('F000')).toBe('flac')
    expect(qualityFromPrefix('A000')).toBe('ape')
    expect(qualityFromPrefix('M800')).toBe('320')
    expect(qualityFromPrefix('M500')).toBe('128')
    expect(qualityFromPrefix('C400')).toBe('m4a')
    expect(qualityFromPrefix('C200')).toBe('m4a')
    expect(qualityFromPrefix('XXXX')).toBeUndefined()
  })
})

describe('buildCandidates', () => {
  it('从 preferred 起向下，每档 mediaMid 单写+双写，去重后共 6 个', () => {
    const cs = buildCandidates('M001', 'MED001', '320')
    expect(cs.length).toBe(6)
    expect(cs[0]).toEqual({ quality: '320', filename: 'M800MED001.mp3' })
    expect(cs[1]).toEqual({ quality: '320', filename: 'M800M001M001.mp3' })
    expect(cs[5]).toEqual({ quality: 'm4a', filename: 'C400M001M001.m4a' })
  })
  it('mediaMid 缺失时单写用 songmid', () => {
    const cs = buildCandidates('M001', undefined, 'flac')
    expect(cs[0]).toEqual({ quality: 'flac', filename: 'F000M001.flac' })
    expect(cs[1]).toEqual({ quality: 'flac', filename: 'F000M001M001.flac' })
  })
})

describe('getAudioUrl', () => {
  it('一次批量请求：filename 数组含全部候选', async () => {
    const fetchMock = vi.fn(async () => new Response(fx())) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: '0' })
    await getAudioUrl(client, 'M001', 'MED001', '320')
    const body = JSON.parse((fetchMock as any).mock.calls[0][1].body as string)
    expect(body.req_1.param.filename).toEqual([
      'M800MED001.mp3', 'M800M001M001.mp3',
      'M500MED001.mp3', 'M500M001M001.mp3',
      'C400MED001.m4a', 'C400M001M001.m4a',
    ])
    expect(body.req_1.param.songmid).toEqual(['M001'])
    expect(body.req_1.param.guid).toMatch(/^\d{5,}$/)
    expect((fetchMock as any).mock.calls.length).toBe(1)
  })

  it('按 purl 实际前缀校正质量：M800 请求拿到 C400 流 → m4a+downgraded', async () => {
    const fetchMock = vi.fn(async () => new Response(fx())) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: 'o123', cookie: 'uin=o123; qqmusic_key=k' })
    const got = await getAudioUrl(client, 'M001', 'MED001', '320')
    expect(got.url).toBe('https://dl.stream.qqmusic.qq.com/C400MED001.m4a?guid=1&vkey=abc')
    expect(got.quality).toBe('m4a')
    expect(got.downgraded).toBe(true)
    const [, init] = (fetchMock as any).mock.calls[0]
    expect(init.headers.cookie).toContain('qqmusic_key')
  })

  it('全部质量拿不到时抛 QqApiError(code=no-playable-url)', async () => {
    const empty = '{"req_1":{"code":0,"data":{"sip":["https://dl.stream.qqmusic.qq.com/"],"midurlinfo":[{"songmid":"M001","purl":""}]}}}'
    const fetchMock = vi.fn(async () => new Response(empty)) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: '0' })
    const err = await getAudioUrl(client, 'M001', 'MED001', 'flac').catch((e) => e)
    expect(err.code).toBe('no-playable-url')
    expect(String(err.message)).toMatch(/登录|权益/)
  })

  it('全档失败时诊断回调记录现场（行数/每档有无，不含 purl 值）', async () => {
    const empty = '{"req_1":{"code":0,"data":{"sip":["https://dl.stream.qqmusic.qq.com/"],"midurlinfo":[{"songmid":"M001","filename":"F000MED001.flac","purl":""},{"songmid":"M001","filename":"M500MED001.mp3","purl":""}]}}}'
    const fetchMock = vi.fn(async () => new Response(empty)) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: '0' })
    const lines: string[] = []
    await getAudioUrl(client, 'M001', 'MED001', 'flac', (l) => lines.push(l)).catch(() => {})
    const all = lines.join('\n')
    expect(all).toContain('rows=2 有purl=0')
    expect(all).toContain('F000MED001.flac=空')
    expect(all).toContain('M500MED001.mp3=空')
  })
})