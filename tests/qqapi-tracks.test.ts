import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createQqClient } from '../src/main/qqapi/client'
import { searchTracks, getTrackDetail, getSingleTrack, parseLink, fetchPlaylist, fetchAlbum, stripJsonp } from '../src/main/qqapi/tracks'

const fx = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'qqapi', name), 'utf-8')

// fetch mock：按 URL/请求体路由到 fixture 文件。
// client.postMusicu 调用 fetchImpl(API_URL, { method, headers, body, ... })，
// 即第一个参数是 URL 字符串、请求体在第二个参数 init.body 中。
function routedFetch(): typeof fetch {
  return vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('musicu.fcg')) {
      const body = JSON.parse(String(init?.body))
      if (body.req?.method === 'DoSearchForQQMusicDesktop') return new Response(fx('search.json'))
      if (body.info?.method === 'get_song_detail_yqq') return new Response(fx('detail.json'))
    }
    if (url.includes('fcg_ucc_getcdinfo_byids_cp')) return new Response(fx('playlist.json'))
    if (url.includes('fcg_v8_album_info_cp')) return new Response(fx('album.json'))
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
}

describe('搜索', () => {
  it('解析成 TrackDTO（多歌手合并/封面/VIP 字段缺省）', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const tracks = await searchTracks(client, '天空之城', { limit: 10 })
    expect(tracks.length).toBeGreaterThan(0)
    const t = tracks[0]
    expect(t.id).toBeTruthy()
    expect(t.artist).toBeTypeOf('string')
    expect(t.cover).toContain('http')
    expect(tracks[1].artist).toBe('南征北战NZBZ / 白勺啊白')
    expect(tracks[0].vip).toBeUndefined()
    expect(tracks[0].duration).toBeTypeOf('number')
    expect(tracks[3].artist).toBe('未知歌手')
  })
})

describe('单曲详情', () => {
  it('拿 mediaMid/发行时间/VIP 判定', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const d = await getTrackDetail(client, '000TEST')
    expect(d.mediaMid).toBeTruthy()
    expect(typeof d.date).toBe('string')
    expect(typeof d.vip).toBe('boolean')
    expect(d.sizes.flac).toBe(123)
    expect(d.vip).toBe(true)
    expect(d.date).toBe('2020-05-01')
  })
})

describe('单曲链接', () => {
  it('getSingleTrack 组装 TrackDTO', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const t = await getSingleTrack(client, '004Ti8rT003TaZ')
    expect(t.id).toBe('004Ti8rT003TaZ')
    expect(t.name).toBeTruthy()
    expect(t.mediaMid).toBeTruthy()
    expect(t.vip).toBe(true)
  })
})

describe('链接解析', () => {
  it('识别 songDetail/playlist/album 三种链接', () => {
    expect(parseLink('https://y.qq.com/n/ryqq/songDetail/004Ti8rT003TaZ')).toEqual({ kind: 'song', id: '004Ti8rT003TaZ' })
    expect(parseLink('https://y.qq.com/n/ryqq/playlist/1374105607')).toEqual({ kind: 'playlist', id: '1374105607' })
    expect(parseLink('https://y.qq.com/n/ryqq/albumDetail/000gXCTb2AhRR1')).toEqual({ kind: 'album', id: '000gXCTb2AhRR1' })
    expect(parseLink('随便一句话')).toBeNull()
  })
})

describe('stripJsonp', () => {
  it('剥离 JSONP 包裹，普通 JSON 原样返回', () => {
    expect(stripJsonp('MusicJsonCallback({});')).toBe('{}')
    expect(stripJsonp('{"a":1}')).toBe('{"a":1}')
  })
})

describe('歌单/专辑', () => {
  it('歌单去 JSONP 包裹并取 songlist', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const entries = await fetchPlaylist(client, '1374105607')
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0].id).toBeTruthy()
  })
  it('专辑取 list', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const entries = await fetchAlbum(client, '000gXCTb2AhRR1')
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0].album).toBeTruthy()
  })
})