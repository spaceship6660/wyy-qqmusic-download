import type { UiAlbumBundle, UiTrack } from './stores/download'

/** 普通歌单（自建/收藏/我喜欢的音乐）的批次上下文：复用专辑的「固定目录 + NN 曲名」落盘通道，
 *  kind=playlist 表示不写 cover.jpg / album.cue / TRCK/TPOS；与日推的区别是 numberTracks=true
 *  （日推文件名只留曲名，歌单按歌单内位置编号）。 */
export function buildPlaylistBundle(
  source: 'qq' | 'netease',
  id: string,
  name: string,
  totalTracks: number,
): UiAlbumBundle {
  const title = name || '未知歌单'
  return {
    source,
    kind: 'playlist',
    numberTracks: true,
    dirName: title,
    id,
    name: title,
    artist: '',
    date: '',
    company: '',
    coverUrl: '',
    totalTracks,
    discs: [1],
    discTotals: { 1: totalTracks },
  }
}

/** 入队前按歌单内位置补 trackNo（主进程拿它拼 NN 前缀）。
 *  必须传整份当前列表：只勾选第 5、7 首时编号是 05/07 而不是 01/02，跨批次也不打架。 */
export function withPlaylistPositions(tracks: UiTrack[], all: UiTrack[]): UiTrack[] {
  const pos = new Map(all.map((t, i) => [t.id, i + 1]))
  return tracks.map((t) => ({ ...t, trackNo: pos.get(t.id) ?? t.trackNo, disc: 1 }))
}
