import type { QqClient, MusicuReq } from './client'

export type Quality = 'flac' | 'ape' | '320' | '128' | 'm4a'

export interface TrackDTO {
  id: string
  name: string
  artist: string
  album: string
  cover: string
  mediaMid?: string
  duration?: number
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

export async function searchTracks(client: QqClient, query: string, opts: { limit?: number } = {}): Promise<TrackDTO[]> {
  const list = (await client.postMusicu(searchReq(query, opts.limit ?? 20), {
    path: ['req', 'data', 'body', 'song', 'list'],
  })) as any[]
  return list.filter((s) => s?.mid).map((s) => ({
    id: s.mid,
    name: s.name ?? '',
    artist: artistOf(s),
    album: s?.album?.name ?? '',
    cover: s?.album?.picUrl ?? s?.pic ?? '',
    mediaMid: s?.file?.media_mid,
    duration: typeof s?.interval === 'number' ? s.interval : undefined,
  }))
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
  const flags = info?.flags ?? {}
  const t = info?.time_public ?? ''
  return {
    mediaMid: file.media_mid ?? mid,
    date: typeof t === 'string' ? t : '',
    vip: flags?.try_begin === undefined ? false : flags.try_begin > 0,
    sizes: {
      flac: file.size_flac, ape: file.size_ape,
      mp3_320: file.size_320mp3, mp3_128: file.size_128mp3,
      m4a: file.size_96aac,
    },
  }
}

const SONG_RE = /y\.qq\.com\/n\/ryqq\/songDetail\/([0-9A-Za-z]+)/
const PL_RE = /y\.qq\.com\/n\/ryqq\/playlist\/(\d+)/
const AL_RE = /y\.qq\.com\/n\/ryqq\/albumDetail\/([0-9A-Za-z]+)/

export function parseLink(url: string): LinkKind | null {
  const s = url.match(SONG_RE)
  if (s) return { kind: 'song', id: s[1] }
  const p = url.match(PL_RE)
  if (p) return { kind: 'playlist', id: p[1] }
  const a = url.match(AL_RE)
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
    vip: (info?.flags?.try_begin ?? 0) > 0,
  }
}

/** 去掉 JSONP 包裹（形如 MusicJsonCallback({...}) 或 callback({...})） */
export function stripJsonp(text: string): string {
  const m = text.match(/^[\w$.]+\((.*)\)\s*;?\s*$/)
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

/** 歌词：PlayLyricInfo 返回 base64 的 LRC；失败/缺失一律返回空串（不阻塞下载） */
export async function fetchLyric(client: QqClient, mid: string): Promise<string> {
  try {
    const data = (await client.postMusicu({
      req_2: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param: { songMID: mid },
      },
    }, { path: ['req_2', 'data'] })) as { lyric?: string }
    if (!data?.lyric) return ''
    return Buffer.from(data.lyric, 'base64').toString('utf-8')
  } catch {
    return ''
  }
}