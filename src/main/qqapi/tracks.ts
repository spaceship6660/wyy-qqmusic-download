import type { QqClient, MusicuReq } from './client'
import { mergeLyricTranslation } from '../lyricMerge'

export type Quality = 'flac' | 'ape' | '320' | '128' | 'm4a'

export interface TrackDTO {
  id: string
  name: string
  artist: string
  album: string
  cover: string
  mediaMid?: string
  duration?: number
  trackNo?: number      // 专辑内曲目序号（1 起）；仅专辑来源填充
  disc?: number         // 碟号（1 起）；仅专辑来源填充
  vip?: boolean
}

export interface TrackDetail {
  mediaMid: string
  date: string          // 'YYYY-MM-DD'，可能为空串
  vip: boolean
  sizes: Partial<Record<'flac' | 'ape' | 'mp3_320' | 'mp3_128' | 'm4a', number>>
}

export type LinkKind = { kind: 'song'; id: string } | { kind: 'playlist'; id: string } | { kind: 'album'; id: string }

function searchReq(query: string, limit: number): Record<string, MusicuReq> {
  return {
    req: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { grp: 1, num_per_page: Math.max(1, limit), page_num: 1, query, search_type: 0 },
    },
  }
}

function artistOf(s: any): string {
  const arr: any[] = s?.singer ?? []
  return arr.map((x: any) => x?.name ?? '').filter(Boolean).join(' / ') || '未知歌手'
}

/** VIP/付费曲判定：
 * - 主依据 `pay.pay_down` > 0（下载需付费/会员）。歌单、我喜欢（CgiGetDiss）、搜索条目都带完整
 *   pay 对象，2026-09-27 实测确认；
 * - 次依据仅取 song detail 的 `flags.try_begin`（与改动前一致）。
 *
 * **不要用 `file.try_begin`**：免费曲也会带它（实测《我无法用我的语言》pay 全 0、只登记 128k/m4a，
 * 却有 file.try_begin=95604），拿它判 VIP 会把免费曲误报成会员歌。
 *
 * 此前仅 getTrackDetail/getSingleTrack 映射 vip 且只认 flags.try_begin —— 歌单/搜索来源的条目
 * vip 恒缺，既漏掉 VIP 角标，也让「下载失败点名会员」在歌单来源下永远触发不了。 */
export function isVipEntry(e: any): boolean {
  const payDown = Number(e?.pay?.pay_down ?? 0)
  if (Number.isFinite(payDown) && payDown > 0) return true
  const flagsTry = Number(e?.flags?.try_begin ?? 0)
  return Number.isFinite(flagsTry) && flagsTry > 0
}

/** 该曲实际登记的可下载档位（体积 > 0），按降级链顺序（高→低）。
 * 用于给 vkey 候选收窄：QQ 服务端只按候选**首位**核发直链，首位档位不存在就整批回空
 * （2026-09-27 实测，见 qqapi/urls.ts），所以候选只能含该曲真实存在的档位。
 * 注意不含 ogg（O400/O600，无标签写入器，不在 QUALITY_LADDER 内）。 */
export function availableTiers(sizes: TrackDetail['sizes'] | undefined): Quality[] {
  const map: Array<[keyof TrackDetail['sizes'], Quality]> = [
    ['flac', 'flac'], ['ape', 'ape'], ['mp3_320', '320'], ['mp3_128', '128'], ['m4a', 'm4a'],
  ]
  return map.filter(([k]) => Number(sizes?.[k] ?? 0) > 0).map(([, q]) => q)
}

/** 该曲在服务端登记了哪几档（体积 > 0 视为存在），按高→低拼中文档位名。
 * 失败报错时回显，用来回答「是不是没自动降级」——多数时候是这首曲子本身就没登记无损/320，
 * 连通用的低档位服务端也不放行（2026-09-27 实机场景）。 */
export function describeTierSizes(sizes: TrackDetail['sizes'] | undefined): string {
  const order: Array<[keyof TrackDetail['sizes'], string]> = [
    ['flac', '无损 FLAC'], ['ape', 'APE'], ['mp3_320', '320k'], ['mp3_128', '128k'], ['m4a', 'm4a'],
  ]
  return order.filter(([k]) => Number(sizes?.[k] ?? 0) > 0).map(([, label]) => label).join(' / ')
}

export async function searchTracks(client: QqClient, query: string, opts: { limit?: number } = {}): Promise<TrackDTO[]> {
  const list = (await client.postMusicu(searchReq(query, opts.limit ?? 20), {
    path: ['req', 'data', 'body', 'song', 'list'],
  })) as any[]
  return list.filter((s) => s?.mid).map((s) => ({
    id: s.mid,
    name: s.name ?? '',
    artist: artistOf(s),
    album: s?.album?.name ?? '',
    // 2026-09-06 实测：搜索响应 album 只有 pmid（picUrl/pic 均缺）——用 pmid 拼标准封面 URL
    cover: qqCoverUrl(s),
    mediaMid: s?.file?.media_mid,
    duration: typeof s?.interval === 'number' ? s.interval : undefined,
    vip: isVipEntry(s),
  }))
}

export interface AlbumDTO {
  mid: string
  name: string
  singer: string
  cover: string
  songCount: number
}

/** 专辑搜索（2026-09-06 实测定型）：经典 client_search_cp?t=8（DoSearchForQQMusicDesktop
 * 的 search_type=8 实测返回空 list），字段 albumMID/albumName/albumPic/singer_list/song_count */
export async function searchAlbums(client: QqClient, query: string, opts: { limit?: number } = {}): Promise<AlbumDTO[]> {
  const text = await client.get(
    `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=${opts.limit ?? 20}&w=${encodeURIComponent(query)}&t=8&format=json`,
  )
  const json = JSON.parse(stripJsonp(text))
  const list = (json?.data?.album?.list ?? []) as any[]
  return list.filter((a) => a?.albumMID).map((a) => ({
    mid: a.albumMID,
    name: a.albumName ?? '',
    singer: (a.singer_list ?? []).map((x: any) => x?.name ?? '').filter(Boolean).join(' / ') || (a.singerName ?? ''),
    // 2026-09-06 真实接口实测：albumPic 本身就是完整封面 URL
    // （http://y.gtimg.cn/music/photo_new/T002R180x180M000....jpg），不是 pmid——
    // 此前按 pmid 拼 URL 得到双重前缀的垃圾地址，专辑卡片封面全裂
    cover: typeof a.albumPic === 'string' && /^https?:\/\//.test(a.albumPic)
      ? a.albumPic
      : qqCoverUrl({ album: { pmid: a.albumPic ?? '' } }),
    songCount: a.song_count ?? 0,
  }))
}

/** QQ 音乐封面 URL：picUrl 直取；否则按 pmid 拼 T002R300x300M000 规格 */
export function qqCoverUrl(s: any): string {
  const picUrl = s?.album?.picUrl ?? s?.pic ?? s?.picUrl
  if (typeof picUrl === 'string' && picUrl) return picUrl
  const pmid = s?.album?.pmid
  if (typeof pmid === 'string' && pmid) return `https://y.gtimg.cn/music/photo_new/T002R300x300M000${pmid}.jpg`
  return ''
}

export async function getTrackDetail(client: QqClient, mid: string): Promise<TrackDetail> {
  const info = (await client.postMusicu({
    info: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_mid: mid, song_type: 0 },
    },
  }, { path: ['info', 'data', 'track_info'] })) as any
  const file = info?.file ?? {}
  const t = info?.time_public ?? ''
  return {
    mediaMid: file.media_mid ?? mid,
    date: typeof t === 'string' ? t : '',
    vip: isVipEntry(info),
    sizes: {
      flac: file.size_flac, ape: file.size_ape,
      mp3_320: file.size_320mp3, mp3_128: file.size_128mp3,
      m4a: file.size_96aac,
    },
  }
}

// 用 URL 解析校验 hostname，而非在整串文本里 find：避免 `evily.qq.com` 或
// `https://evil.example/?u=https://y.qq.com/n/ryqq/songDetail/...` 之类被误判为 QQ 链接
const SONG_PATH_RE = /^\/n\/ryqq\/songDetail\/([0-9A-Za-z]+)/
const PL_PATH_RE = /^\/n\/ryqq\/playlist\/(\d+)/
const AL_PATH_RE = /^\/n\/ryqq\/albumDetail\/([0-9A-Za-z]+)/

export function parseLink(url: string): LinkKind | null {
  const raw = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  // 精确域或子域（c./i.y.qq.com）；`evily.qq.com` 不匹配 `.y.qq.com` 后缀
  if (u.hostname !== 'y.qq.com' && !u.hostname.endsWith('.y.qq.com')) return null
  const s = u.pathname.match(SONG_PATH_RE)
  if (s) return { kind: 'song', id: s[1] }
  const p = u.pathname.match(PL_PATH_RE)
  if (p) return { kind: 'playlist', id: p[1] }
  const a = u.pathname.match(AL_PATH_RE)
  if (a) return { kind: 'album', id: a[1] }
  return null
}

/** 单曲链接 → TrackDTO（走 get_song_detail_yqq，track_info 含 title/singer/album/albummid 与 media_mid） */
export async function getSingleTrack(client: QqClient, mid: string): Promise<TrackDTO> {
  const info = (await client.postMusicu({
    info: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_mid: mid, song_type: 0 },
    },
  }, { path: ['info', 'data', 'track_info'] })) as any
  if (!info?.mid) throw new Error('单曲详情无效')
  const albummid = info?.album?.mid ?? ''
  return {
    id: info.mid,
    name: info.title ?? '',
    artist: artistOf(info),
    album: info?.album?.name ?? '',
    cover: albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albummid}.jpg` : '',
    mediaMid: (info?.file?.media_mid ?? info.mid) as string,
    duration: typeof info?.interval === 'number' ? info.interval : undefined,
    vip: isVipEntry(info),
  }
}

/** 去掉 JSONP 包裹（形如 MusicJsonCallback({...}) 或 callback({...})） */
export function stripJsonp(text: string): string {
  // [\s\S]：JSONP 回调体可能跨行（`.` 不匹配换行），否则无法剥离导致 JSON.parse 抛错
  const m = text.match(/^[\w$.]+\(([\s\S]*)\)\s*;?\s*$/)
  return m ? m[1] : text
}

function trackFromEntry(e: any, albumDefault = ''): TrackDTO {
  return {
    id: e?.songmid ?? e?.mid ?? '',
    name: e?.songname ?? e?.name ?? '',
    artist: artistOf(e),
    album: e?.albumname ?? albumDefault ?? '',
    cover: e?.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${e.albummid}.jpg` : '',
    mediaMid: e?.media_mid ?? e?.file?.media_mid,
    vip: isVipEntry(e),
  }
}

export async function fetchPlaylist(client: QqClient, id: string): Promise<TrackDTO[]> {
  const text = await client.get(`https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid=${id}`)
  const json = JSON.parse(stripJsonp(text))
  const list = (json?.cdlist?.[0]?.songlist ?? []) as any[]
  return list.map((e) => trackFromEntry(e))
}

export async function fetchAlbum(client: QqClient, mid: string): Promise<TrackDTO[]> {
  const text = await client.get(`https://i.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?albummid=${mid}&format=json`)
  const json = JSON.parse(stripJsonp(text))
  const data = json?.data ?? {}
  const list = (data?.list ?? []) as any[]
  return list.map((e) => trackFromEntry(e, data?.name ?? ''))
}

/** 歌词：PlayLyricInfo 返回 base64 的 LRC。param 必须带 trans:1 才会返回译文
 * （2026-09-06 实测：只传 songMID 时 trans 恒空；加 trans:1 即得明文 base64 LRC，
 *  不加 crypt 则不走 QRC 加密，无需 DES 解密）；译文与原文按时间戳合并。失败/缺失一律返回空串（不阻塞下载） */
export async function fetchLyric(client: QqClient, mid: string): Promise<string> {
  try {
    const data = (await client.postMusicu({
      req_2: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param: { songMID: mid, trans: 1 },
      },
    }, { path: ['req_2', 'data'] })) as { lyric?: string; trans?: string }
    if (!data?.lyric) return ''
    const orig = Buffer.from(data.lyric, 'base64').toString('utf-8')
    let trans = ''
    if (data?.trans) {
      try {
        trans = Buffer.from(data.trans, 'base64').toString('utf-8')
      } catch {
        trans = ''
      }
    }
    return mergeLyricTranslation(orig, trans)
  } catch {
    return ''
  }
}