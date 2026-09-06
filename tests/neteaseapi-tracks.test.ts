import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createNeClient } from '../src/main/neteaseapi/client'
import { neSearch, neUserPlaylist, nePlaylistDetail, neGetTrackDetail, neteaseTrackToDto, neAccount, nePlaylistPage } from '../src/main/neteaseapi/tracks'

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
    if (url.includes('/api/nuser/account/get')) return new Response(fx('account.json'))
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
  it('兼容 song/detail 形状（artists/album/duration）：歌单分页不再未知歌手/无封面', () => {
    // 2026-09-06 真实接口实锤：/api/song/detail 返回 artists + album，无 ar/al
    const dto = neteaseTrackToDto({
      id: 186016, name: '晴天', fee: 0, duration: 269000,
      artists: [{ id: 6452, name: '周杰伦' }],
      album: { id: 18905, name: '叶惠美', picUrl: 'https://p2.music.126.net/cover.jpg' },
    })
    expect(dto.id).toBe('186016')
    expect(dto.artist).toBe('周杰伦')
    expect(dto.album).toBe('叶惠美')
    expect(dto.cover).toBe('https://p2.music.126.net/cover.jpg')
    expect(dto.duration).toBe(269)
    expect(dto.vip).toBe(false)
  })
})

describe('nePlaylistPage', () => {
  it('trackIds + song/detail 分批：artists/album 形状正确映射且 nextOffset 推进', async () => {
    const fetchImpl = (async (input: any) => {
      const url = String(input)
      if (url.includes('/api/v6/playlist/detail')) {
        return new Response(JSON.stringify({
          playlist: { trackCount: 3, trackIds: [{ id: 1 }, { id: 2 }, { id: 3 }] },
        }), { status: 200 })
      }
      if (url.includes('/api/song/detail')) {
        return new Response(JSON.stringify({
          songs: [
            { id: 1, name: 'A', fee: 0, artists: [{ name: 'SA' }], album: { name: 'AA', picUrl: 'http://c/1.jpg' } },
            { id: 2, name: 'B', fee: 1, artists: [{ name: 'SB' }], album: { name: 'AB', picUrl: 'http://c/2.jpg' } },
          ],
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    const client = createNeClient(fetchImpl)
    const r = await nePlaylistPage(client, '999', 0, 2)
    expect(r?.tracks.length).toBe(2)
    expect(r?.tracks[0].artist).toBe('SA')
    expect(r?.tracks[0].cover).toBe('http://c/1.jpg')
    expect(r?.tracks[1].vip).toBe(true)
    expect(r?.more).toBe(true)
    expect(r?.nextOffset).toBe(2) // 按请求 batch 推进（非返回条数）
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
    // 歌单卡片封面：coverImgUrl 接线（此前缺失致歌单页全占位图）
    expect(pls[0].cover).toBe('http://p1.music.126.net/liked.jpg')
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

describe('neAccount', () => {
  it('登录态取 uid/昵称；无 profile 返回 null', async () => {
    const client = createNeClient(routedFetch())
    const acc = await neAccount(client)
    expect(acc?.uid).toBe(1597610302)
    expect(acc?.nickname).toBeTruthy()
  })
  it('无 profile（未登录/风控）返回 null', async () => {
    const client = createNeClient(routedFetch())
    const plain = createNeClient((async (input: any) => {
      const url = String(input)
      return new Response(url.includes('/api/nuser/account/get') ? '{"code":301}' : '{}', { status: 200 })
    }) as unknown as typeof fetch)
    expect(await neAccount(client)).not.toBeNull()
    expect(await neAccount(plain)).toBeNull()
    // 接口异常（非 JSON/网络错误）也按未登录容错
    const broken = createNeClient((async () => { throw new Error('net') }) as unknown as typeof fetch)
    expect(await neAccount(broken)).toBeNull()
  })
})