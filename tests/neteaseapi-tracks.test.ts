import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createNeClient } from '../src/main/neteaseapi/client'
import { neSearch, neUserPlaylist, nePlaylistDetail, neGetTrackDetail, neteaseTrackToDto } from '../src/main/neteaseapi/tracks'

const fx = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'netease', n), 'utf-8')

function routedFetch(): typeof fetch {
  return vi.fn(async (input: any) => {
    const url = String(input)
    if (url.includes('/api/cloudsearch/pc')) return new Response(fx('search.json'))
    if (url.includes('/api/user/playlist')) return new Response(fx('library.json'))
    if (url.includes('/api/v6/playlist/detail')) {
      return url.includes('id=ANON') ? new Response(fx('playlist-anon.json')) : new Response(fx('playlist-full.json'))
    }
    if (url.includes('/api/song/detail')) return new Response(fx('song-detail.json'))
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
}

const rawSong = {
  id: 103027, name: '天空之城（钢琴版）（Cover 久石让）',
  ar: [{ id: 1, name: 'iw ix' }],
  al: { id: 2, name: '翻唱合集', picUrl: 'https://p1.music.126.net/x.jpg' },
  fee: 0, dt: 180000,
}

describe('neteaseTrackToDto', () => {
  it('映射为 TrackDTO（String(id)、多歌手合并、封面、vip=fee>0）', () => {
    const dto = neteaseTrackToDto({ ...rawSong, ar: [{ name: 'A' }, { name: 'B' }], fee: 1 })
    expect(dto.id).toBe('103027')
    expect(dto.artist).toBe('A / B')
    expect(dto.cover).toBe('https://p1.music.126.net/x.jpg')
    expect(dto.vip).toBe(true)
    expect(dto.name).toContain('天空之城')
  })
})

describe('neSearch', () => {
  it('cloudsearch/pc 解析成 TrackDTO[]', async () => {
    const client = createNeClient(routedFetch())
    const tracks = await neSearch(client, '天空之城')
    expect(tracks.length).toBeGreaterThan(0)
    expect(tracks[0].id).toBe('103027')
  })
})

describe('neUserPlaylist', () => {
  it('解析歌单列表，喜欢的置顶（specialType=5）', async () => {
    const client = createNeClient(routedFetch())
    const pls = await neUserPlaylist(client, 1597610302)
    expect(pls.length).toBeGreaterThan(0)
    expect(pls[0].liked).toBe(true)
    expect(pls[0].name).toBe('我喜欢的音乐')
  })
})

describe('nePlaylistDetail', () => {
  it('匿名歌单（trackCount=0/tracks 空）返回 requiresLogin=true', async () => {
    const client = createNeClient(routedFetch())
    const r = await nePlaylistDetail(client, 'ANON')
    expect(r.tracks).toEqual([])
    expect(r.requiresLogin).toBe(true)
  })
  it('登录态歌单返回全量曲目', async () => {
    const client = createNeClient(routedFetch())
    const r = await nePlaylistDetail(client, '2418667007')
    expect(r.requiresLogin).toBe(false)
    expect(r.tracks.length).toBeGreaterThan(0)
    expect(r.tracks[0].id).toBe('103027')
  })
})

describe('neGetTrackDetail', () => {
  it('song/detail 取 date（YYYY-MM-DD，北京时间）', async () => {
    const client = createNeClient(routedFetch())
    const d = await neGetTrackDetail(client, 103027)
    // publishTime 1588262400000 = 2020-05-01T00:00+08:00（CST 零点，中国发行日期）
    // 回归锚：若退回 UTC 转换（toISOString 不补偿），必得 2020-04-30 而失败
    expect(d.date).toBe('2020-05-01')
  })
})