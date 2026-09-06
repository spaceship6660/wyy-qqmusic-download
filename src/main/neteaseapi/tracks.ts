import type { TrackDTO } from '../qqapi/tracks'
import type { NeClient } from './client'

export interface PlaylistDTO {
  id: number
  name: string
  liked: boolean          // specialType=5（我喜欢的音乐）
  subscribed?: boolean    // 收藏的歌单
  creatorUid?: number     // 歌单创建者 uid（= 我 → 自建）
  trackCount: number
  cover: string           // coverImgUrl（歌单卡片封面；此前未接线，网易云歌单页全是占位图）
}
export interface NeTrackDetail { date: string }
export interface NePlaylistResult { tracks: TrackDTO[]; requiresLogin: boolean }

export function neteaseTrackToDto(s: any): TrackDTO {
  // 双形状兼容（2026-09-06 真实接口实测）：
  // - cloudsearch/pc、v1/album：ar（数组）/ al（含 picUrl）/ dt（毫秒）
  // - song/detail（歌单分页拉明细用）：artists（数组）/ album（含 picUrl）/ duration（毫秒）
  // 此前只认前者 → 歌单/我喜欢的音乐全部「未知歌手」+ 无封面（歌名/vip 字段两边同名故正常）
  const ar: any[] = s?.ar ?? s?.artists ?? []
  const al = s?.al ?? s?.album ?? {}
  const ms = typeof s?.dt === 'number' ? s.dt : typeof s?.duration === 'number' ? s.duration : undefined
  return {
    id: String(s.id),
    name: s?.name ?? '',
    artist: ar.map((x) => x?.name ?? '').filter(Boolean).join(' / ') || '未知歌手',
    album: al?.name ?? '',
    cover: al?.picUrl ?? '',
    duration: typeof ms === 'number' ? Math.round(ms / 1000) : undefined,
    vip: (s?.fee ?? 0) > 0,
  }
}

export async function neSearch(client: NeClient, q: string, limit = 20): Promise<TrackDTO[]> {
  const json = await client.getJson<{ result?: { songs?: any[] } }>(
    `https://music.163.com/api/cloudsearch/pc?type=1&s=${encodeURIComponent(q)}&limit=${limit}&offset=0`,
  )
  return (json?.result?.songs ?? []).filter((s) => s?.id).map(neteaseTrackToDto)
}

export async function neUserPlaylist(client: NeClient, uid: number): Promise<PlaylistDTO[]> {
  const json = await client.getJson<{ code?: number; playlist?: any[] }>(
    `https://music.163.com/api/user/playlist?uid=${uid}&limit=200&offset=0`,
  )
  const list = (json?.playlist ?? [])
    .filter((p) => p?.id)
    .map((p) => ({
      id: p.id,
      name: p.name ?? '',
      liked: p.specialType === 5,
      subscribed: !!p.subscribed,
      creatorUid: p.creator?.userId ?? 0,
      trackCount: p.trackCount ?? 0,
      cover: p.coverImgUrl ?? '',
    }))
  return list.sort((a, b) => Number(b.liked) - Number(a.liked))
}

export async function nePlaylistDetail(client: NeClient, id: string): Promise<NePlaylistResult> {
  const json = await client.getJson<{ playlist?: { trackCount?: number; tracks?: any[] } }>(
    `https://music.163.com/api/v6/playlist/detail/?id=${id}`,
  )
  const tracks = (json?.playlist?.tracks ?? []).filter((t) => t?.id).map(neteaseTrackToDto)
  const trackCount = json?.playlist?.trackCount ?? 0
  return { tracks, requiresLogin: tracks.length === 0 && trackCount === 0 }
}

export async function neGetTrackDetail(client: NeClient, id: number): Promise<NeTrackDetail> {
  try {
    const json = await client.getJson<{ songs?: any[] }>(
      `https://music.163.com/api/song/detail/?id=${id}&ids=[${id}]`,
    )
    const t = json?.songs?.[0]
    const ms = t?.album?.publishTime
    if (typeof ms === 'number' && ms > 0) {
      // publishTime 为北京时间零点（中国发行日期）；UTC 转换会差一天，故先补偿 +8h
      return { date: new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10) }
    }
    return { date: '' }
  } catch {
    return { date: '' }
  }
}

export type NeAccount = { uid: number; nickname: string } | null
/** 登录态取 uid/昵称（api/nuser/account/get，需 MUSIC_U cookie）；未登录/异常返回 null */
export async function neAccount(client: NeClient): Promise<NeAccount | null> {
  try {
    const json = await client.getJson<{ profile?: { userId?: number; nickname?: string } }>(
      'https://music.163.com/api/nuser/account/get',
    )
    const p = json?.profile
    if (p?.userId) return { uid: p.userId, nickname: p.nickname ?? '' }
    return null
  } catch {
    return null
  }
}

// --- 2026-09-06 新增：专辑搜索/详情 + 歌单全量分页 ---

export interface NeAlbumDTO {
  id: number
  name: string
  artist: string
  cover: string
  songCount?: number
}

/** 专辑搜索（cloudsearch type=10 → result.albums） */
export async function neSearchAlbums(client: NeClient, q: string): Promise<NeAlbumDTO[]> {
  const json = await client.getJson<{ result?: { albums?: any[] } }>(
    `https://music.163.com/api/cloudsearch/pc?type=10&s=${encodeURIComponent(q)}&limit=20&offset=0`,
  )
  return (json?.result?.albums ?? [])
    .filter((a) => a?.id)
    .map((a) => ({
      id: a.id,
      name: a.name ?? '',
      artist: a.artist?.name ?? a.artists?.[0]?.name ?? '',
      cover: a.picUrl ?? '',
      songCount: a.size ?? undefined,
    }))
}

/** 专辑歌曲（api/v1/album/{id} → songs；2026-09-06 实测可用，api/album?id= 已下线） */
export async function neAlbumSongs(client: NeClient, id: number): Promise<TrackDTO[]> {
  const json = await client.getJson<{ songs?: any[] }>(`https://music.163.com/api/v1/album/${id}`)
  return (json?.songs ?? []).filter((t) => t?.id).map(neteaseTrackToDto)
}

export interface NePlaylistPage {
  tracks: TrackDTO[]
  total: number
  more: boolean
  /** 下一页 offset（按请求的 batch 推进；渲染侧翻页必须用它，不能用 tracks.length，
   *  song/detail 可能丢歌——用返回条数推进会造成重叠复拉） */
  nextOffset: number
}

/** 歌单全量分页（2026-09-06 定型）：v6/detail 的 trackIds 匿名即全量（如 200/125/1581），
 * 歌曲明细用 song/detail 批量拉。页大小默认 200（此前 500：首屏 URL 巨大、响应慢、
 * 一次渲染 500 卡片直接卡死，「我喜欢的音乐加载缓慢」根因之一）。 */
export async function nePlaylistPage(client: NeClient, id: string, offset: number, pageSize = 200): Promise<NePlaylistPage | null> {
  const meta = await client.getJson<{ playlist?: { trackCount?: number; trackIds?: Array<{ id: number }> } }>(
    `https://music.163.com/api/v6/playlist/detail/?id=${id}`,
  )
  const ids = (meta?.playlist?.trackIds ?? []).map((t) => t.id).filter((x): x is number => typeof x === 'number')
  const total = meta?.playlist?.trackCount ?? ids.length
  if (ids.length === 0) return null
  const batch = ids.slice(offset, offset + pageSize)
  if (batch.length === 0) return { tracks: [], total, more: false, nextOffset: offset }
  const json = await client.getJson<{ songs?: any[] }>(
    `https://music.163.com/api/song/detail?ids=[${batch.join(',')}]`,
  )
  const tracks = (json?.songs ?? []).filter((t) => t?.id).map(neteaseTrackToDto)
  const nextOffset = offset + batch.length
  return { tracks, total, more: nextOffset < ids.length, nextOffset }
}
