import { describe, it, expect, vi } from 'vitest'
import { getNeDailyPage, getNeDailyCards } from '../src/main/neteaseapi/recommend'
import type { NeClient } from '../src/main/neteaseapi/client'

const neSong = (id: number, name = `歌${id}`) => ({
  id, name, fee: 8, duration: 200000,
  artists: [{ name: '歌手' }], album: { name: '专辑', picUrl: `http://cover/${id}.jpg` },
})

const styleSong = (id: number, name = `风${id}`) => ({
  id, name, fee: 0, dt: 200000,
  ar: [{ name: '歌手' }], al: { name: '专辑', picUrl: `http://cover/s${id}.jpg` },
})

function mockNe(routes: Record<string, (url: string) => any>): NeClient {
  return {
    getJson: vi.fn(async (url: string) => {
      const hit = Object.entries(routes).find(([key]) => url.includes(key))
      if (!hit) throw new Error(`unexpected url ${url}`)
      return hit[1](url)
    }),
  } as unknown as NeClient
}

const dailyJson = {
  code: 200,
  data: { dailySongs: Array.from({ length: 34 }, (_, i) => neSong(1000 + i)), orderSongs: [] },
}
const styleJson = {
  code: 200,
  data: {
    tags: { categoryId: 1000, categoryName: '曲风', tagVOList: [{ categoryId: 1000, tagId: 10015, tagName: '二次元' }] },
    dailySongs: Array.from({ length: 30 }, (_, i) => styleSong(2000 + i)),
  },
}
const radarIds = Array.from({ length: 35 }, (_, i) => ({ id: 3000 + i }))
const radarMeta = {
  code: 200,
  playlist: {
    id: 3136952023,
    name: '今天《别把夏天关掉》爱不释耳|私人雷达',
    coverImgUrl: 'http://cover/radar.jpg',
    trackCount: 35,
    trackIds: radarIds,
    tracks: [],
  },
}
const radarSongs = { songs: Array.from({ length: 35 }, (_, i) => neSong(3000 + i)) }

describe('getNeDailyPage', () => {
  it('日推：接口给多少就显示多少（34 首不截断到 30），目录名带网易云前缀', async () => {
    const client = mockNe({ '/api/v1/discovery/recommend/songs': () => dailyJson })
    const r = await getNeDailyPage(client, 'daily30', '2026-10-31')
    expect(r.tracks.length).toBe(34)
    expect(r.meta).toMatchObject({ title: '日推30首', count: 34, dayKey: '2026-10-31' })
    expect(r.bundle).toMatchObject({ source: 'netease', kind: 'playlist', dirName: '网易云26-10-31日推30首', totalTracks: 34 })
    expect(r.bundle.coverUrl).toBe('http://cover/1000.jpg')
  })

  it('日推为空 → 明确报错（登录/风控/未生成三种原因都归到这一句）', async () => {
    const client = mockNe({ '/api/v1/discovery/recommend/songs': () => ({ code: 200, data: { dailySongs: [] } }) })
    await expect(getNeDailyPage(client, 'daily30', '2026-10-31')).rejects.toThrow(/日推为空|登录/)
  })

  it('风格推荐：读取当前曲风标签与 30 首，目录名不带曲风后缀', async () => {
    const client = mockNe({ '/api/homepage/category/daily/song/list': () => styleJson })
    const r = await getNeDailyPage(client, 'style', '2026-10-31')
    expect(r.tracks.length).toBe(30)
    expect(r.meta).toMatchObject({ title: '风格推荐', count: 30, tag: '二次元' })
    expect(r.bundle.dirName).toBe('网易云26-10-31风格推荐')
    expect(r.meta.cover).toBe('http://cover/s2000.jpg')
  })

  it('私人雷达：固定歌单 3136952023，35 首全取，封面用歌单封面', async () => {
    const client = mockNe({
      '/api/v6/playlist/detail/': () => radarMeta,
      '/api/song/detail': () => radarSongs,
    })
    const r = await getNeDailyPage(client, 'radar', '2026-10-31')
    expect(r.tracks.length).toBe(35)
    expect(r.meta).toMatchObject({ title: '私人雷达', count: 35, cover: 'http://cover/radar.jpg' })
    expect(r.bundle.dirName).toBe('网易云26-10-31私人雷达')
  })
})

describe('getNeDailyCards', () => {
  it('3 张卡：日推/风格/雷达的数量与封面；单卡失败不拖垮整页', async () => {
    const client = mockNe({
      '/api/v1/discovery/recommend/songs': () => dailyJson,
      '/api/homepage/category/daily/song/list': () => styleJson,
      '/api/v6/playlist/detail/': () => radarMeta,
    })
    const cards = await getNeDailyCards(client)
    expect(cards.map((c) => c.mode)).toEqual(['daily30', 'style', 'radar'])
    expect(cards[0]).toMatchObject({ title: '日推30首', count: 34 })
    expect(cards[1]).toMatchObject({ title: '风格推荐', count: 30, tag: '二次元' })
    expect(cards[2]).toMatchObject({ title: '私人雷达', count: 35, cover: 'http://cover/radar.jpg' })
  })

  it('单卡失败只标该卡，其他卡照常返回', async () => {
    const client = mockNe({
      '/api/v1/discovery/recommend/songs': () => { throw new Error('风控空响应') },
      '/api/homepage/category/daily/song/list': () => styleJson,
      '/api/v6/playlist/detail/': () => radarMeta,
    })
    const cards = await getNeDailyCards(client)
    expect(cards[0].error).toMatch(/风控/)
    expect(cards[1].count).toBe(30)
    expect(cards[2].count).toBe(35)
  })
})
