import { describe, it, expect } from 'vitest'
import { buildPlaylistBundle, withPlaylistPositions } from '../src/renderer/src/playlistBundle'
import type { UiTrack } from '../src/renderer/src/stores/download'

const t = (id: string, name = id): UiTrack => ({ id, name, artist: 'S', album: 'A', cover: '' })

describe('歌单批次上下文（0.8.x）', () => {
  it('目录名 = 歌单名，kind=playlist，且标记按歌单位置编号', () => {
    const b = buildPlaylistBundle('netease', 'ne:pl:123', 'mimi', 16)
    expect(b).toMatchObject({
      source: 'netease', kind: 'playlist', numberTracks: true,
      dirName: 'mimi', name: 'mimi', totalTracks: 16, discs: [1], discTotals: { 1: 16 },
    })
  })

  it('歌单名为空 → 回退「未知歌单」，不得把文件倒进下载根目录', () => {
    expect(buildPlaylistBundle('qq', 'qq:diss:1', '', 3).dirName).toBe('未知歌单')
  })

  it('序号按歌单内位置补，不按本次勾选顺序；不改入参', () => {
    const all = [t('a'), t('b'), t('c'), t('d'), t('e'), t('f'), t('g')]
    const picked = [all[4], all[6]]   // 歌单里第 5、7 首
    const out = withPlaylistPositions(picked, all)
    expect(out.map((x) => x.trackNo)).toEqual([5, 7])
    expect(picked.map((x) => x.trackNo)).toEqual([undefined, undefined])
  })

  it('全量下载（all 与 tracks 同一列表）→ 位置就是 1..N', () => {
    const all = [t('a'), t('b'), t('c')]
    expect(withPlaylistPositions(all, all).map((x) => x.trackNo)).toEqual([1, 2, 3])
  })
})
