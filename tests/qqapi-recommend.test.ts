import { describe, it, expect, vi } from 'vitest'
import {
  parseDaily30Card, shanghaiDayKey, todayShanghai, getQqDaily30, getQqOfficialPlaylist, getQqDailyCards,
} from '../src/main/qqapi/recommend'
import type { QqClient } from '../src/main/qqapi/client'

const song = (mid: string, name = `歌${mid}`) => ({
  mid, name, singer: [{ name: '歌手' }], album: { name: '专辑' }, file: { media_mid: mid }, interval: 200,
  pay: { pay_play: 0, pay_down: 0 },
})

function mockClient(routes: Record<string, (param: any) => any>): QqClient {
  return {
    postMusicu: vi.fn(async (reqs: any) => {
      const r = reqs.req
      const key = `${r.module}/${r.method}`
      const fn = routes[key]
      if (!fn) throw new Error(`unexpected ${key}`)
      return fn(r.param)
    }),
  } as unknown as QqClient
}

const FEED = {
  v_shelf: [{
    id: 201,
    v_niche: [{
      v_card: [
        { id: '0_8', subtype: 810, title: '一周听歌排行', time: 0 },
        { id: '6956212819', subtype: 510, title: '每日30首', cover: 'http://cover/daily.jpg', time: 1793376185 },
      ],
    }],
  }],
}

const DISS_30 = {
  dirinfo: { id: 6956212819, title: '的今日私享', songnum: 30, picurl: 'http://cover/daily-dir.jpg', mtime: 1793376185 },
  songlist: Array.from({ length: 30 }, (_, i) => song(`d${i}`)),
  total_song_num: 30,
}
const DISS_50 = {
  dirinfo: { id: 211111, title: '百万收藏', songnum: 50, picurl: 'http://cover/million.jpg', mtime: 1793438518 },
  songlist: Array.from({ length: 50 }, (_, i) => song(`m${i}`)),
  total_song_num: 50,
}

describe('parseDaily30Card', () => {
  it('从 v_shelf → v_niche → v_card 里找 subtype=510，而不是拿错卡片', () => {
    const c = parseDaily30Card(FEED)
    expect(c).toMatchObject({ id: '6956212819', title: '每日30首', cover: 'http://cover/daily.jpg', time: 1793376185 })
  })
  it('没有 subtype 510 → 抛错，不静默回退猜你喜欢', () => {
    expect(() => parseDaily30Card({ v_shelf: [{ v_niche: [{ v_card: [{ id: 'x', subtype: 0 }] }] }] })).toThrow()
  })
})

describe('上海日期', () => {
  it('卡片 Unix 秒按上海时区折算（1793376185 = 2026-10-31）', () => {
    expect(shanghaiDayKey(1793376185)).toBe('2026-10-31')
  })
  it('todayShanghai 可注入时间，便于测试跨日', () => {
    expect(todayShanghai(Date.UTC(2026, 9, 30, 17, 0, 0))).toBe('2026-10-31')
  })
})

describe('getQqDaily30', () => {
  const mk = () => mockClient({
    'music.recommend.RecommendFeed/get_recommend_feed': () => FEED,
    'music.srfDissInfo.DissInfo/CgiGetDiss': () => DISS_30,
  })

  it('当天卡片 → 用动态 ID 读 30 首，并建 playlist bundle', async () => {
    const r = await getQqDaily30(mk(), '2026-10-31')
    expect(r.tracks.length).toBe(30)
    expect(r.bundle).toMatchObject({
      source: 'qq', kind: 'playlist', dirName: 'Q音26-10-31日推30首', totalTracks: 30, discs: [1],
    })
    expect(r.meta).toMatchObject({ title: '日推30首', count: 30, dayKey: '2026-10-31' })
  })

  it('卡片不是今天的 → 拒绝，避免把昨天的日推当今天的', async () => {
    await expect(getQqDaily30(mk(), '2026-11-01')).rejects.toThrow(/尚未生成|不是今天|最后更新/)
  })
})

describe('getQqOfficialPlaylist', () => {
  it('百万收藏：50 首 + 官方封面 + Q音26-10-31百万收藏', async () => {
    const r = await getQqOfficialPlaylist(
      mockClient({ 'music.srfDissInfo.DissInfo/CgiGetDiss': () => DISS_50 }),
      'million',
      '2026-10-31',
    )
    expect(r.tracks.length).toBe(50)
    expect(r.meta).toMatchObject({ title: '百万收藏', count: 50, cover: 'http://cover/million.jpg' })
    expect(r.bundle.dirName).toBe('Q音26-10-31百万收藏')
  })
})

describe('getQqDailyCards', () => {
  it('4 张卡都返回标题/数量/封面；单卡失败只标该卡错误，不拖垮整页', async () => {
    const client = mockClient({
      'music.recommend.RecommendFeed/get_recommend_feed': () => FEED,
      'music.srfDissInfo.DissInfo/CgiGetDiss': (p) => {
        if (p.disstid === 6956212819) return DISS_30
        if (p.disstid === 211111) return DISS_50
        if (p.disstid === 211207) return { dirinfo: { id: 211207, title: '新歌推荐', songnum: 50, picurl: 'http://cover/new.jpg', mtime: 1793438473 }, songlist: [song('n0')], total_song_num: 50 }
        throw new Error('风控空响应')
      },
    })
    const cards = await getQqDailyCards(client, '2026-10-31')
    expect(cards.length).toBe(4)
    expect(cards.map((c) => c.mode)).toEqual(['daily30', 'million', 'newsong', 'heart'])
    expect(cards[0]).toMatchObject({ title: '日推30首', count: 30, cover: 'http://cover/daily.jpg' })
    expect(cards[1]).toMatchObject({ title: '百万收藏', count: 50, cover: 'http://cover/million.jpg' })
    expect(cards[3].error).toMatch(/风控/)
  })
})

  it('官方歌单 ID 被服务端换了标题 → 拒绝，不把别的歌单当「百万收藏」下下来', async () => {
    const wrong = { ...DISS_50, dirinfo: { ...DISS_50.dirinfo, title: '百万收藏（旧）' } }
    await expect(getQqOfficialPlaylist(
      mockClient({ 'music.srfDissInfo.DissInfo/CgiGetDiss': () => wrong }),
      'million',
      '2026-10-31',
    )).rejects.toThrow(/不是|标题/)
  })
