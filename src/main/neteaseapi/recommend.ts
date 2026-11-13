import type { NeClient } from './client'
import { nePlaylistPage, neteaseTrackToDto } from './tracks'
import type { TrackDTO } from '../qqapi/tracks'
import type { AlbumBundle } from '../albumBundle'
import { buildDailyBundle, todayShanghai } from '../dailyRec'

export type NeDailyMode = 'daily30' | 'style' | 'radar'

export interface NeDailyCard {
  source: 'netease'
  mode: NeDailyMode
  title: string
  desc: string
  cover: string
  count: number | null
  tag?: string
  error?: string
}

export interface NeDailyPage {
  tracks: TrackDTO[]
  bundle: AlbumBundle
  meta: { title: string; count: number; dayKey: string; cover: string; tag?: string }
}

const RADAR_PLAYLIST_ID = '3136952023'
const LABEL: Record<NeDailyMode, string> = {
  daily30: '日推30首',
  style: '风格推荐',
  radar: '私人雷达',
}

function coverOf(s: any): string {
  return s?.al?.picUrl ?? s?.album?.picUrl ?? ''
}

async function getDailyTracks(client: NeClient): Promise<{ tracks: TrackDTO[]; cover: string }> {
  const json = await client.getJson<any>('https://music.163.com/api/v1/discovery/recommend/songs')
  const raw: any[] = json?.data?.dailySongs ?? json?.recommend ?? []
  const tracks = raw.filter((s) => s?.id).map(neteaseTrackToDto)
  if (tracks.length === 0) {
    throw new Error('网易云日推为空（可能需要重新登录，或今日日推尚未生成）')
  }
  return { tracks, cover: coverOf(raw[0]) }
}

async function getStyleTracks(client: NeClient): Promise<{ tracks: TrackDTO[]; cover: string; tag: string }> {
  const json = await client.getJson<any>('https://music.163.com/api/homepage/category/daily/song/list')
  const raw: any[] = json?.data?.dailySongs ?? []
  const tracks = raw.filter((s) => s?.id).map(neteaseTrackToDto)
  if (tracks.length === 0) {
    throw new Error('网易云风格推荐为空（可能需要重新登录，或今日风格推荐尚未生成）')
  }
  const tags: any[] = json?.data?.tags?.tagVOList ?? []
  const tag = tags.map((t) => t?.tagName ?? '').filter(Boolean).join(' / ')
  return { tracks, cover: coverOf(raw[0]), tag }
}

async function getRadarMeta(client: NeClient): Promise<{ cover: string; count: number; name: string }> {
  const json = await client.getJson<any>(`https://music.163.com/api/v6/playlist/detail/?id=${RADAR_PLAYLIST_ID}`)
  const p = json?.playlist
  if (!p) throw new Error('网易云私人雷达歌单读取失败（可能需要重新登录）')
  return {
    cover: typeof p.coverImgUrl === 'string' ? p.coverImgUrl : '',
    count: typeof p.trackCount === 'number' ? p.trackCount : 0,
    name: typeof p.name === 'string' ? p.name : '私人雷达',
  }
}

async function getRadarTracks(client: NeClient): Promise<{ tracks: TrackDTO[]; cover: string }> {
  const meta = await getRadarMeta(client)
  const page = await nePlaylistPage(client, RADAR_PLAYLIST_ID, 0, 200)
  if (!page?.tracks?.length) {
    throw new Error('网易云私人雷达为空（可能需要重新登录，或歌单尚未更新）')
  }
  return { tracks: page.tracks, cover: meta.cover }
}

export async function getNeDailyPage(
  client: NeClient,
  mode: NeDailyMode,
  dayKey = todayShanghai(),
): Promise<NeDailyPage> {
  let tracks: TrackDTO[]
  let cover = ''
  let tag: string | undefined
  if (mode === 'daily30') {
    const r = await getDailyTracks(client)
    tracks = r.tracks
    cover = r.cover
  } else if (mode === 'style') {
    const r = await getStyleTracks(client)
    tracks = r.tracks
    cover = r.cover
    tag = r.tag
  } else {
    const r = await getRadarTracks(client)
    tracks = r.tracks
    cover = r.cover
  }
  const title = LABEL[mode]
  return {
    tracks,
    bundle: buildDailyBundle('netease', mode, title, dayKey, tracks, cover),
    meta: { title, count: tracks.length, dayKey, cover, ...(tag ? { tag } : {}) },
  }
}

export async function getNeDailyCards(client: NeClient): Promise<NeDailyCard[]> {
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  const dailyTask = (async (): Promise<NeDailyCard> => {
    const r = await getDailyTracks(client)
    return {
      source: 'netease', mode: 'daily30', title: LABEL.daily30,
      desc: '根据你的音乐口味生成，每日 6:00 更新',
      cover: r.cover, count: r.tracks.length,
    }
  })()

  const styleTask = (async (): Promise<NeDailyCard> => {
    const r = await getStyleTracks(client)
    return {
      source: 'netease', mode: 'style', title: LABEL.style,
      desc: r.tag ? `当前曲风：${r.tag}` : '按你设置的曲风每日推荐',
      cover: r.cover, count: r.tracks.length, tag: r.tag,
    }
  })()

  const radarTask = (async (): Promise<NeDailyCard> => {
    const meta = await getRadarMeta(client)
    return {
      source: 'netease', mode: 'radar', title: LABEL.radar,
      desc: '云音乐私人雷达，每日更新',
      cover: meta.cover, count: meta.count,
    }
  })()

  const modes: NeDailyMode[] = ['daily30', 'style', 'radar']
  const tasks = [dailyTask, styleTask, radarTask]
  const settled = await Promise.allSettled(tasks)
  return settled.map((r, i) => {
    const mode = modes[i]
    if (r.status === 'fulfilled') return r.value
    return {
      source: 'netease', mode, title: LABEL[mode],
      desc: mode === 'daily30' ? '根据你的音乐口味生成，每日 6:00 更新'
        : mode === 'style' ? '按你设置的曲风每日推荐' : '云音乐私人雷达，每日更新',
      cover: '', count: null, error: errText(r.reason),
    }
  })
}
