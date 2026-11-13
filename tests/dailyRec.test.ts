import { describe, it, expect } from 'vitest'
import { dailyDirName, buildDailyBundle } from '../src/main/dailyRec'
import type { TrackDTO } from '../src/main/qqapi/tracks'

const t = (id: string, name: string): TrackDTO => ({ id, name, artist: 'A', album: 'B', cover: '' })

describe('dailyDirName', () => {
  it('QQ：Q音 + YY-MM-DD + 入口名，阿拉伯数字', () => {
    expect(dailyDirName('qq', '2026-10-31', '日推30首')).toBe('Q音26-10-31日推30首')
    expect(dailyDirName('qq', '2026-10-31', '百万收藏')).toBe('Q音26-10-31百万收藏')
  })
  it('网易云：网易云 + YY-MM-DD + 入口名', () => {
    expect(dailyDirName('netease', '2026-10-31', '风格推荐')).toBe('网易云26-10-31风格推荐')
  })
  it('非法字符经 safeName', () => {
    expect(dailyDirName('qq', '2026-10-31', 'A/B')).toBe('Q音26-10-31A-B')
  })
})

describe('buildDailyBundle', () => {
  it('playlist bundle：kind/dirName/单碟/完成度口径自洽', () => {
    const tracks = [t('a', 'x'), t('b', 'y')]
    const b = buildDailyBundle('qq', 'daily30', '日推30首', '2026-10-31', tracks, 'http://cover/x.jpg')
    expect(b).toMatchObject({
      source: 'qq', kind: 'playlist', dirName: 'Q音26-10-31日推30首',
      name: '日推30首', date: '2026-10-31', coverUrl: 'http://cover/x.jpg',
      totalTracks: 2, discs: [1], discTotals: { 1: 2 },
    })
    expect(b.id).toContain('2026-10-31')
  })
  it('空列表抛错，不生成一个空目录批次', () => {
    expect(() => buildDailyBundle('netease', 'style', '风格推荐', '2026-10-31', [], '')).toThrow()
  })
})
