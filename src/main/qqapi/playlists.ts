// QQ 音乐登录态歌单接口（移植自 luren-dc/QQMusicApi modules/user.py）：
// - 创建的歌单：music.musicasset.PlaylistBaseRead / GetPlaylistByUin（data.v_playlist）
// - 收藏的歌单：music.musicasset.PlaylistFavRead / CgiGetPlaylistFavInfo（data.v_list，uin=加密 UIN）
// - 我喜欢的音乐（dirid=201）/ 歌单歌曲：music.srfDissInfo.DissInfo / CgiGetDiss（data.songlist）
// 均需登录态（client.setAuth 注入 cookie）；euin = 登录响应 EncryptUin（auth 持久化）。
import type { QqClient } from './client'
import { qqCoverUrl, type TrackDTO } from './tracks'

export interface QqPlaylistDTO {
  id: string
  name: string
  cover: string
  trackCount: number
  /** 我喜欢的音乐（dirid 201） */
  liked?: boolean
}

/** 歌单详情/喜欢接口返回的歌曲条目 → TrackDTO（字段与搜索同构：mid/singer/album/file） */
export function dissSongToTrack(s: any) {
  return {
    id: s.mid ?? '',
    name: s.name ?? '',
    artist: (s.singer ?? []).map((x: any) => x?.name ?? '').filter(Boolean).join(' / ') || '未知歌手',
    album: s?.album?.name ?? '',
    cover: qqCoverUrl({ album: s?.album }),
    mediaMid: s?.file?.media_mid,
    duration: typeof s?.interval === 'number' ? s.interval : undefined,
  }
}

function coverOf(p: any): string {
  // 收藏接口（v_list）与自建接口（v_playlist）封面字段名不一致，且收藏此前从未真实调通过——
  // 2026-09-06 用户实机：收藏列表仅首张有图，其余全空。做最大兼容：
  // URL 直链（http 开头直接用，含 diss_cover/cover/logo/pic 等别名）；
  // pmid 短串（pic_mid 等）按 T002 规格拼。
  const direct = p?.picurl ?? p?.picUrl ?? p?.bigpicUrl ?? p?.coverPicUrl ?? p?.albumPicUrl
    ?? p?.diss_cover ?? p?.cover ?? p?.logo ?? p?.pic
  if (typeof direct === 'string' && direct) {
    if (/^https?:\/\//.test(direct)) return direct
  }
  const pmid = p?.pic_mid ?? p?.picmid ?? p?.album_pic_mid ?? p?.cover_mid
    ?? (typeof direct === 'string' && direct ? direct : '')
  if (typeof pmid === 'string' && pmid && !/^https?:\/\//.test(pmid)) {
    return `https://y.gtimg.cn/music/photo_new/T002R300x300M000${pmid}.jpg`
  }
  return ''
}

function summaryOf(p: any): QqPlaylistDTO | null {
  // 真实响应为大写字段（2026-09-06 实测定型）：dirId/dirName/songNum/picUrl；
  // 兼容小写/收藏列表（v_list）两种命名
  const id = p?.tid ?? p?.dirid ?? p?.dirId ?? p?.dissid
  if (!id) return null
  return {
    id: String(id),
    name: p?.title ?? p?.dirName ?? p?.dissname ?? '',
    cover: coverOf(p),
    trackCount: p?.songnum ?? p?.songNum ?? p?.song_cnt ?? p?.songcount ?? 0,
  }
}

/** 登录用户创建的歌单（GetPlaylistByUin → data.v_playlist） */
export async function getUserPlaylists(client: QqClient, uin: string): Promise<QqPlaylistDTO[]> {
  const data = (await client.postMusicu(
    {
      req: { module: 'music.musicasset.PlaylistBaseRead', method: 'GetPlaylistByUin', param: { uin } },
    },
    { path: ['req', 'data'] },
  )) as any
  return (data?.v_playlist ?? []).map(summaryOf).filter((p: QqPlaylistDTO | null): p is QqPlaylistDTO => p !== null)
}

/** 登录用户收藏的歌单（CgiGetPlaylistFavInfo → data.v_list；uin 传加密 UIN）。
 * debug：可选诊断回调，收到首个原始条目时上报其字段名（仅 keys，无隐私数据），
 * 用于 v_list 字段改名时定位（收藏接口历史上从未真实调通过，映射靠兼容兜底）。 */
export async function getFavPlaylists(client: QqClient, euin: string, debug?: (line: string) => void): Promise<QqPlaylistDTO[]> {
  const data = (await client.postMusicu(
    {
      req: { module: 'music.musicasset.PlaylistFavRead', method: 'CgiGetPlaylistFavInfo', param: { uin: euin, offset: 0, size: 60 } },
    },
    { path: ['req', 'data'] },
  )) as any
  const raw = (data?.v_list ?? []) as any[]
  if (debug && raw.length > 0) {
    try {
      debug(`fav v_list[0] keys: ${Object.keys(raw[0] ?? {}).join(',')}`)
    } catch {
      // 诊断失败不影响业务
    }
  }
  return raw.map(summaryOf).filter((p: QqPlaylistDTO | null): p is QqPlaylistDTO => p !== null)
}

export interface QqDissPage {
  tracks: TrackDTO[]
  total: number
  more: boolean
}

/** 我喜欢的音乐（dirid=201）或歌单歌曲（disstid）分页（CgiGetDiss → data.songlist）。
 * 懒加载：song_begin 递增（2026-09-06 用户要求：1500+ 首歌单不一次性加载） */
export async function getDissTracksPage(
  client: QqClient,
  opts: { disstid?: number; dirid?: number; euin?: string; songBegin: number; songNum?: number },
): Promise<QqDissPage | null> {
  const data = (await client.postMusicu(
    {
      req: {
        module: 'music.srfDissInfo.DissInfo',
        method: 'CgiGetDiss',
        param: {
          disstid: opts.disstid ?? 0,
          dirid: opts.dirid ?? 0,
          tag: true,
          song_begin: opts.songBegin,
          song_num: opts.songNum ?? 200,
          userinfo: true,
          orderlist: true,
          ...(opts.euin ? { enc_host_uin: opts.euin } : {}),
        },
      },
    },
    { path: ['req', 'data'] },
  )) as any
  const list = data?.songlist ?? []
  if (!Array.isArray(list)) return null
  const tracks = list.filter((s: any) => s?.mid).map(dissSongToTrack)
  // more 判定（2026-09-06 修复「只加载前 200 首」）：
  // 此前完全依赖 data.total——该字段缺失/改名时 total 回退为 begin+len，more 恒为 false，
  // 首屏之后永远不再分页。现加兜底：无有效 total 时以「是否拿满一页」判断。
  const songNum = opts.songNum ?? 200
  const totalRaw = Number(data?.total)
  const hasTotal = Number.isFinite(totalRaw) && totalRaw >= 0
  const total = hasTotal ? totalRaw : opts.songBegin + tracks.length + (tracks.length >= songNum ? 1 : 0)
  return { tracks, total, more: opts.songBegin + tracks.length < total }
}