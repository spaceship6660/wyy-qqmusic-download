import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createNeClient } from '../src/main/neteaseapi/client'
import { neSearch, neUserPlaylist, nePlaylistDetail, neGetTrackDetail, neteaseTrackToDto, neAccountChecked, nePlaylistPage, neAlbumSongs, neAlbumInfo } from '../src/main/neteaseapi/tracks'

const fx = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'netease', n), 'utf-8')

// mock client（0.7.0 专辑用例用）：URL → Response，逐例自带响应体
function mockNeClient(handler: (url: string) => Response) {
  return createNeClient((async (input: any) => handler(String(input))) as unknown as typeof fetch)
}

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

describe('nePlaylistPage', () => {
  it('trackIds 少于 trackCount 时 more 仍按 total（不提前判到底丢歌）', async () => {
    const fetchImpl = (async (input: any) => {
      const url = String(input)
      if (url.includes('/api/v6/playlist/detail')) {
        return new Response(JSON.stringify({ playlist: { trackCount: 5, trackIds: [{ id: 1 }, { id: 2 }] } }), { status: 200 })
      }
      if (url.includes('/api/song/detail')) {
        return new Response(JSON.stringify({ songs: [{ id: 1, name: 'A', fee: 0, artists: [{ name: 'X' }], album: { name: 'Y' } }] }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    const client = createNeClient(fetchImpl)
    const r = await nePlaylistPage(client, 'trunc-1', 0, 2)
    expect(r?.total).toBe(5)
    expect(r?.more).toBe(true) // nextOffset=2 < total=5
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

describe('neAccountChecked', () => {
  it('登录态取 uid/昵称；无 profile 返回 null（服务端确认不认＝权威否定结论）', async () => {
    const client = createNeClient(routedFetch())
    const acc = await neAccountChecked(client)
    expect(acc?.uid).toBe(1597610302)
    expect(acc?.nickname).toBeTruthy()
    const plain = createNeClient((async (input: any) => {
      const url = String(input)
      return new Response(url.includes('/api/nuser/account/get') ? '{"code":301}' : '{}', { status: 200 })
    }) as unknown as typeof fetch)
    expect(await neAccountChecked(plain)).toBeNull()
  })
  it('传输异常上抛，不得塌缩成 null（吞异常壳 2026-10-07 已删：调用方靠它区分「过期」与「断网」）', async () => {
    const broken = createNeClient((async () => { throw new Error('net') }) as unknown as typeof fetch)
    await expect(neAccountChecked(broken)).rejects.toThrow(/net/)
  })
})
// --- 0.7.0 专辑封装（Task 7）---

function neAlbumResponse(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    code: 200,
    album: {
      id: 74829483, name: '奇爱人生 LOVE ELEGIA', artist: { name: '阿良良木健' },
      publishTime: 1558310400000, company: null, picUrl: 'https://p/1.jpg', size: 13,
    },
    songs: [{
      id: 1356370987, name: '告别曲', no: 1, cd: '01',
      ar: [{ name: '阿良良木健' }], al: { name: '奇爱人生 LOVE ELEGIA', picUrl: 'https://p/1.jpg' },
      dt: 300000, fee: 1,
    }],
    ...over,
  })
}

describe('neAlbumInfo（0.7.0 专辑封装）', () => {
  it('一次请求同时拿到专辑元数据与带序号的曲目', async () => {
    const urls: string[] = []
    const client = mockNeClient((u: string) => {
      urls.push(u)
      return new Response(neAlbumResponse(), { status: 200 })
    })
    const r = await neAlbumInfo(client, 74829483)
    expect(urls.length).toBe(1) // 零额外请求：album 与 songs 同响应
    expect(urls[0]).toContain('https://music.163.com/api/v1/album/74829483')
    expect(r.bundle).toMatchObject({ source: 'netease', id: '74829483', name: '奇爱人生 LOVE ELEGIA', artist: '阿良良木健', totalTracks: 1 })
    expect(r.bundle.company).toBe('')
    expect(r.tracks[0]).toMatchObject({ trackNo: 1, disc: 1 })
  })

  it('专辑对象在 album 键（不是 info）：认错了就等于什么都没接到（2026-10-06 探针实锤）', async () => {
    const r = await neAlbumInfo(mockNeClient(() => new Response(neAlbumResponse({ album: undefined, info: { name: '奇爱人生' } }), { status: 200 })), 74829483)
    expect(r.bundle.name).toBe('未知专辑')
    expect(r.bundle.artist).toBe('未知歌手')
    expect(r.bundle.coverUrl).toBe('')
    expect(r.bundle.date).toBe('')
    expect(r.bundle.id).toBe('74829483') // album.id 缺失时退回请求的 id
    expect(r.tracks.length).toBe(1)     // 曲目仍接得出，不能整页空
  })

  it('publishTime 毫秒时间戳 → YYYY-MM-DD；company 可为 null → 空串', async () => {
    const r = await neAlbumInfo(mockNeClient(() => new Response(neAlbumResponse({ album: { id: 1, name: 'A', publishTime: 1558310400000, company: null } }), { status: 200 })), 1)
    expect(r.bundle.date).toMatch(/^2019-\d{2}-\d{2}$/)
    expect(r.bundle.company).toBe('')
    const r2 = await neAlbumInfo(mockNeClient(() => new Response(neAlbumResponse({ album: { id: 1, name: 'A', publishTime: '2019-05-20', company: '某某唱片' } }), { status: 200 })), 1)
    expect(r2.bundle.date).toBe('2019-05-20')
    expect(r2.bundle.company).toBe('某某唱片')
    const r3 = await neAlbumInfo(mockNeClient(() => new Response(neAlbumResponse({ album: { id: 1, name: 'A' } }), { status: 200 })), 1)
    expect(r3.bundle.date).toBe('')
  })

  it('no 缺失/非法 → 数组下标 +1；cd 缺失或 "00" → 碟 1（实测 no=1、cd="01"）', async () => {
    const songs = [
      { id: 1, name: 'A' },
      { id: 2, name: 'B', cd: '00' },
      { id: 3, name: 'C', no: 0 },
      { id: 4, name: 'D', no: 7, cd: '02' },
    ]
    const r = await neAlbumInfo(mockNeClient(() => new Response(neAlbumResponse({ songs }), { status: 200 })), 1)
    expect(r.tracks.map((x) => x.trackNo)).toEqual([1, 2, 3, 7])
    expect(r.tracks.map((x) => x.disc)).toEqual([1, 1, 1, 2])
    expect(r.bundle.discs).toEqual([1, 2])
  })

  it('曲目映射逐字段仍是 neteaseTrackToDto 的产物（spread 只加 trackNo/disc）', async () => {
    const songs = [{
      id: 5, name: 'A', no: 3, cd: '02', ar: [{ name: 'X' }, { name: 'Y' }],
      al: { name: 'AL', picUrl: 'http://c/1.jpg' }, dt: 269400, fee: 0,
    }]
    const r = await neAlbumInfo(mockNeClient(() => new Response(neAlbumResponse({ songs }), { status: 200 })), 1)
    expect(r.tracks[0]).toEqual({
      id: '5', name: 'A', artist: 'X / Y', album: 'AL', cover: 'http://c/1.jpg',
      duration: 269, vip: false, trackNo: 3, disc: 2,
    })
  })

  it('songs 缺失/非数组/为空 → tracks: [] 且 totalTracks: 0（空专辑要让调用方认得出来）', async () => {
    for (const body of ['{}', '{"code":200}', '{"album":{}}', neAlbumResponse({ songs: [] }), neAlbumResponse({ songs: null })]) {
      const r = await neAlbumInfo(mockNeClient(() => new Response(body, { status: 200 })), 1)
      expect(r.tracks).toEqual([])
      expect(r.bundle.totalTracks).toBe(0)
      expect(r.bundle.discs).toEqual([1])
    }
  })

  it('totalTracks 用 songs 实长，不信 album.size（QQ 侧实测过口径不一致）', async () => {
    const songs = [{ id: 1 }, { id: 2 }, { id: 3 }].map((s) => ({ ...s, name: 'n' }))
    const r = await neAlbumInfo(mockNeClient(() => new Response(neAlbumResponse({ songs, album: { id: 9, name: 'A', size: 13 } }), { status: 200 })), 9)
    expect(r.bundle.totalTracks).toBe(3)
  })

  it('neAlbumSongs 兼容壳：仍回数组、仍丢弃无 id 条目，序号按过滤前的原始下标', async () => {
    const songs = [{ id: 1, name: 'A' }, { name: '脏条目' }, { id: 3, name: 'C' }]
    const tracks = await neAlbumSongs(mockNeClient(() => new Response(neAlbumResponse({ songs }), { status: 200 })), 1)
    expect(tracks.map((x) => x.id)).toEqual(['1', '3'])
    expect(tracks.map((x) => x.trackNo)).toEqual([1, 3])
  })
})
