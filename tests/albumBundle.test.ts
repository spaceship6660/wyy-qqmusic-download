import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  mkBundle, normalizeDate, discOf, qqAlbumCoverUrl, albumDirName, discSegments, trackBaseName, trackFileName, trackPad,
  albumRootDir, albumTrackDir,
} from '../src/main/albumBundle'
import type { TrackDTO } from '../src/main/qqapi/tracks'

const t = (id: string, name: string, trackNo?: number, disc?: number): TrackDTO =>
  ({ id, name, artist: 'A', album: 'B', cover: '', trackNo, disc }) as TrackDTO

describe('normalizeDate', () => {
  it('13 位毫秒时间戳 → YYYY-MM-DD', () => {
    expect(normalizeDate(1558310400000)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('10 位秒时间戳 → YYYY-MM-DD', () => {
    expect(normalizeDate(1558310400)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('数字型字符串也认', () => {
    expect(normalizeDate('1558310400000')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(normalizeDate('1558310400')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('已是 YYYY-MM-DD 字符串 → 取前 10 位', () => {
    expect(normalizeDate('2019-05-20')).toBe('2019-05-20')
    expect(normalizeDate('2019-05-20 12:00')).toBe('2019-05-20')
  })
  it('脏值/空 → 空串（不得污染目录名与 cue）', () => {
    expect(normalizeDate('')).toBe('')
    expect(normalizeDate(null)).toBe('')
    expect(normalizeDate(undefined)).toBe('')
    expect(normalizeDate('未确定')).toBe('')
    // '2019/05/20' 是分隔符不同的另一种日期写法：形状没验过就不猜，一律空串
    expect(normalizeDate('2019/05/20')).toBe('')
    expect(normalizeDate('2019-5-20')).toBe('')
    expect(normalizeDate(0)).toBe('')
    expect(normalizeDate(-1)).toBe('')
    expect(normalizeDate(9e15)).toBe('')   // 超出 Date 上限的时间戳
    expect(normalizeDate(Number.NaN)).toBe('')
    expect(discOf('')).toBe(1)
  })
})

describe('discOf（碟号采信）', () => {
  it('≥1 的整数才采信；字符串数字也认', () => {
    expect(discOf(2)).toBe(2)
    expect(discOf('01')).toBe(1)
    expect(discOf('2')).toBe(2)
  })
  it('0 / 缺失 / 非整数 / 负数 → 1（单碟是安全默认）', () => {
    expect(discOf(0)).toBe(1)
    expect(discOf(undefined)).toBe(1)
    expect(discOf(null)).toBe(1)
    expect(discOf('x')).toBe(1)
    expect(discOf(1.5)).toBe(1)
    expect(discOf(-2)).toBe(1)
  })
})

describe('qqAlbumCoverUrl', () => {
  it('albummid → R500 大图 URL（响应里没有封面字段，只能拼）', () => {
    expect(qqAlbumCoverUrl('001LVtAD0sEPKu'))
      .toBe('https://y.gtimg.cn/music/photo_new/T002R500x500M000001LVtAD0sEPKu.jpg')
  })
  it('mid 缺失 → 空串（下游据此跳过 cover.jpg，不写坏 URL）', () => {
    expect(qqAlbumCoverUrl('')).toBe('')
  })
})

describe('mkBundle', () => {
  it('空名回退「未知专辑/未知歌手」，discs 去重升序，totalTracks 取实长', () => {
    const b = mkBundle('qq', 'm1', '', '', '', '', '', [t('a', 'x', 1, 2), t('b', 'y', 2, 1)])
    expect(b.name).toBe('未知专辑')
    expect(b.artist).toBe('未知歌手')
    expect(b.discs).toEqual([1, 2])
    expect(b.totalTracks).toBe(2)
    expect(b.source).toBe('qq')
    expect(b.id).toBe('m1')
  })
  it('无曲目 → discs 仍是 [1]（不能让下游拿到空数组）', () => {
    expect(mkBundle('netease', '7', 'A', 'S', '', '', '', []).discs).toEqual([1])
  })
  it('曲目没带 disc（非专辑来源误传）→ 按单碟收，discs 不得出现 undefined', () => {
    const b = mkBundle('qq', 'm2', 'A', 'S', '', '', '', [t('a', 'x'), t('b', 'y', 2)])
    expect(b.discs).toEqual([1])
    expect(b.totalTracks).toBe(2)
  })

  it('discTotals：单碟 = { 1: totalTracks }（整张下载是常见情形，这条断了 cue 就永远出不来）', () => {
    const b = mkBundle('qq', 'm3', 'A', 'S', '', '', '', [t('a', 'x', 1, 1), t('b', 'y', 2, 1), t('c', 'z', 3)])
    expect(b.discTotals).toEqual({ 1: 3 })
    expect(b.discTotals[1]).toBe(b.totalTracks)
  })

  it('discTotals：多碟按碟计数，键集与 discs 同集（完成度按碟查，查不到就永不判齐）', () => {
    // 数组顺序故意打乱：曲目序与碟号无关，计数得按碟号归堆
    const b = mkBundle('qq', 'm4', 'A', 'S', '', '', '',
      [t('a', 'x', 1, 2), t('b', 'y', 2, 1), t('c', 'z', 3, 1), t('d', 'w', 4, 3)])
    expect(b.discs).toEqual([1, 2, 3])
    expect(b.discTotals).toEqual({ 1: 2, 2: 1, 3: 1 })
    expect(Object.keys(b.discTotals).sort()).toEqual([...b.discs].map(String).sort())
    expect(Object.values(b.discTotals).reduce((x, y) => x + y, 0)).toBe(b.totalTracks)
  })

  it('discTotals 是普通对象而不是 Map（要过 IPC 的 JSON 净化，Map 会静默变 undefined）', () => {
    const b = mkBundle('qq', 'm5', 'A', 'S', '', '', '', [t('a', 'x', 1, 1), t('b', 'y', 2, 1)])
    expect(JSON.parse(JSON.stringify(b)).discTotals).toEqual({ 1: 2 })
    // 数字键往返后是字符串，按 number 下标取仍命中（AlbumPackager 就是这么查的）
    expect(JSON.parse(JSON.stringify(b)).discTotals[1]).toBe(2)
  })

  it('空专辑 → discTotals 为 {}（没有曲目就没有任何一碟的期望数，不能让下游拿到 undefined）', () => {
    expect(mkBundle('netease', '7', 'A', 'S', '', '', '', []).discTotals).toEqual({})
  })
})

describe('命名', () => {
  const b = mkBundle('qq', 'x', '奇爱人生 LOVE ELEGIA', '阿良良木健', '2019-05-20', '', '', [t('a', 'x', 1, 1)])

  it('目录名 = 歌手 - 专辑 (年)', () => {
    expect(albumDirName(b)).toBe('阿良良木健 - 奇爱人生 LOVE ELEGIA (2019)')
  })
  it('无日期 → 不带括号段', () => {
    expect(albumDirName({ ...b, date: '' })).toBe('阿良良木健 - 奇爱人生 LOVE ELEGIA')
  })
  it('非法字符进 safeName（目录名不得含 \\ / : * ? " < > |）', () => {
    // safeName 的字符类见 src/main/fsUtils.ts:5，每个非法字符换成 '-'
    expect(albumDirName({ ...b, name: 'A/B:C*D' })).toBe('阿良良木健 - A-B-C-D (2019)')
  })
  it('单碟不追加 CD 段，多碟按碟追加', () => {
    expect(discSegments(b, 1)).toEqual([])
    expect(discSegments({ ...b, discs: [1, 2] }, 2)).toEqual(['CD02'])
  })
  it('序号位数：≥100 首用三位', () => {
    expect(trackPad({ ...b, totalTracks: 13 })).toBe(2)
    expect(trackPad({ ...b, totalTracks: 120 })).toBe(3)
  })
  it('trackBaseName = NN 曲名；trackFileName = 基础名 + .ext', () => {
    expect(trackBaseName(t('a', '告别曲（Love Elegia Ver.）', 1), 2)).toBe('01 告别曲（Love Elegia Ver.）')
    expect(trackFileName(t('a', '告别曲（Love Elegia Ver.）', 1), 2, 'flac')).toBe('01 告别曲（Love Elegia Ver.）.flac')
    expect(trackFileName(t('a', 'x', 7), 3, 'mp3')).toBe('007 x.mp3')
  })
  it('曲名过 safeName：非法字符换 -，序号前缀不受影响', () => {
    expect(trackFileName(t('a', 'A/B:C', 10), 2, 'flac')).toBe('10 A-B-C.flac')
  })
  it('trackNo 缺失 → 按 1（不得出现 NaN 前缀）', () => {
    expect(trackBaseName(t('a', 'x'), 2)).toBe('01 x')
  })
  it('albumRootDir / albumTrackDir：单碟同目录，多碟在专辑根下嵌 CDnn', () => {
    const root = path.join('D', '阿良良木健 - 奇爱人生 LOVE ELEGIA (2019)')
    expect(albumRootDir('D', b)).toBe(root)
    expect(albumTrackDir('D', b, 1)).toBe(root)
    const multi = mkBundle('qq', 'x', '奇爱人生 LOVE ELEGIA', '阿良良木健', '2019-05-20', '', '',
      [t('a', 'x', 1, 1), t('c', 'y', 1, 2)])
    expect(albumRootDir('D', multi)).toBe(root)
    expect(albumTrackDir('D', multi, 2)).toBe(path.join(root, 'CD02'))
  })
})
