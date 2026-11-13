import type { QqClient } from './client'
import { getDissTracksPage } from './playlists'
import type { TrackDTO } from './tracks'
import type { AlbumBundle } from '../albumBundle'
import { buildDailyBundle, shanghaiDayKey, todayShanghai } from '../dailyRec'

export { shanghaiDayKey, todayShanghai }

export type QqDailyMode = 'daily30' | 'million' | 'newsong' | 'heart'

export interface QqDailyCard {
  source: 'qq'
  mode: QqDailyMode
  title: string
  desc: string
  cover: string
  count: number | null
  updatedAt?: string
  error?: string
}

export interface QqDailyPage {
  tracks: TrackDTO[]
  bundle: AlbumBundle
  meta: { title: string; count: number; dayKey: string; cover: string; updatedAt?: string }
}

interface OfficialEntry {
  id: number
  title: string
  desc: string
}

const OFFICIAL: Record<Exclude<QqDailyMode, 'daily30'>, OfficialEntry> = {
  million: {
    id: 211111,
    title: '百万收藏',
    desc: 'QQ 音乐用户常听的人气好歌，每日更新',
  },
  newsong: {
    id: 211207,
    title: '新歌推荐',
    desc: '为你打造的新歌雷达，每日更新',
  },
  heart: {
    id: 211143,
    title: '红心雷达',
    desc: '根据你的收藏为你打造，每日自动更新',
  },
}

const DAILY_LABEL = '日推30首'

function formatUpdatedAt(unixSec: number | undefined): string | undefined {
  if (!unixSec || !Number.isFinite(unixSec)) return undefined
  const d = new Date((unixSec + 8 * 3600) * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

export function parseDaily30Card(feedData: any): { id: string; title: string; cover: string; time: number } {
  for (const shelf of feedData?.v_shelf ?? []) {
    for (const niche of shelf?.v_niche ?? []) {
      for (const card of niche?.v_card ?? []) {
        if (Number(card?.subtype) === 510 && card?.id) {
          return {
            id: String(card.id),
            title: card.title || '每日30首',
            cover: typeof card.cover === 'string' ? card.cover : '',
            time: Number(card.time) || 0,
          }
        }
      }
    }
  }
  throw new Error('未找到今日「每日30首」卡片（服务端未生成或账号未登录）')
}

async function getDaily30Card(client: QqClient): Promise<{ id: string; title: string; cover: string; time: number }> {
  const data = (await client.postMusicu(
    {
      req: {
        module: 'music.recommend.RecommendFeed',
        method: 'get_recommend_feed',
        param: { direction: 0, page: 1, v_cache: [], v_uniq: [], s_num: 0 },
      },
    },
    { path: ['req', 'data'] },
  )) as any
  return parseDaily30Card(data)
}

async function getDissPage(client: QqClient, disstid: number, songNum: number) {
  const page = await getDissTracksPage(client, { disstid, songBegin: 0, songNum })
  if (!page?.tracks?.length) throw new Error('歌单为空或加载失败（可能需要重新登录）')
  return page
}

/** 官方歌单 ID 是硬编码的：服务端把 ID 换了用途时要报错，不能把别的歌单当「百万收藏」下下来。 */
function assertOfficialTitle(page: { dirinfo?: { title?: string } | null }, cfg: OfficialEntry): void {
  const actual = page.dirinfo?.title
  if (actual && actual !== cfg.title) {
    throw new Error(`官方歌单 ${cfg.id} 已不是「${cfg.title}」（服务端标题：${actual}），请更新版本`)
  }
}

export async function getQqDaily30(client: QqClient, todayKey = todayShanghai()): Promise<QqDailyPage> {
  const card = await getDaily30Card(client)
  const cardDay = card.time ? shanghaiDayKey(card.time) : ''
  if (cardDay !== todayKey) {
    throw new Error(`今日「每日30首」尚未生成（服务端最后更新：${cardDay || '未知'}），请稍后点 ↻ 刷新`)
  }
  const page = await getDissPage(client, Number(card.id), 100)
  const cover = card.cover || page.dirinfo?.picurl || ''
  return {
    tracks: page.tracks,
    bundle: buildDailyBundle('qq', 'daily30', DAILY_LABEL, cardDay, page.tracks, cover),
    meta: {
      title: DAILY_LABEL,
      count: page.tracks.length,
      dayKey: cardDay,
      cover,
      updatedAt: formatUpdatedAt(card.time),
    },
  }
}

export async function getQqOfficialPlaylist(
  client: QqClient,
  mode: Exclude<QqDailyMode, 'daily30'>,
  dayKey = todayShanghai(),
): Promise<QqDailyPage> {
  const cfg = OFFICIAL[mode]
  const page = await getDissPage(client, cfg.id, 100)
  assertOfficialTitle(page, cfg)
  const cover = page.dirinfo?.picurl || page.tracks[0]?.cover || ''
  return {
    tracks: page.tracks,
    bundle: buildDailyBundle('qq', mode, cfg.title, dayKey, page.tracks, cover),
    meta: {
      title: cfg.title,
      count: page.tracks.length,
      dayKey,
      cover,
      updatedAt: formatUpdatedAt(page.dirinfo?.mtime),
    },
  }
}

export async function getQqDailyCards(client: QqClient, todayKey = todayShanghai()): Promise<QqDailyCard[]> {
  const cardError = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  const dailyTask = (async (): Promise<QqDailyCard> => {
    const card = await getDaily30Card(client)
    const cardDay = card.time ? shanghaiDayKey(card.time) : ''
    if (cardDay !== todayKey) {
      throw new Error(`今日日推尚未生成（服务端最后更新：${cardDay || '未知'}）`)
    }
    const page = await getDissPage(client, Number(card.id), 1)
    return {
      source: 'qq',
      mode: 'daily30',
      title: DAILY_LABEL,
      desc: 'QQ 音乐每日 30 首，按你的口味生成',
      cover: card.cover || page.dirinfo?.picurl || '',
      count: page.dirinfo?.songnum ?? page.tracks.length,
      updatedAt: formatUpdatedAt(card.time),
    }
  })()

  const officialTask = (mode: Exclude<QqDailyMode, 'daily30'>): Promise<QqDailyCard> => (async () => {
    const cfg = OFFICIAL[mode]
    const page = await getDissPage(client, cfg.id, 1)
    assertOfficialTitle(page, cfg)
    return {
      source: 'qq',
      mode,
      title: cfg.title,
      desc: cfg.desc,
      cover: page.dirinfo?.picurl || page.tracks[0]?.cover || '',
      count: page.dirinfo?.songnum ?? page.tracks.length,
      updatedAt: formatUpdatedAt(page.dirinfo?.mtime),
    }
  })()

  const modes: QqDailyMode[] = ['daily30', 'million', 'newsong', 'heart']
  const tasks = [dailyTask, officialTask('million'), officialTask('newsong'), officialTask('heart')]
  const settled = await Promise.allSettled(tasks)
  return settled.map((r, i) => {
    const mode = modes[i]
    if (r.status === 'fulfilled') return r.value
    const cfg = mode === 'daily30' ? { title: DAILY_LABEL, desc: 'QQ 音乐每日 30 首，按你的口味生成' } : OFFICIAL[mode]
    return {
      source: 'qq',
      mode,
      title: cfg.title,
      desc: cfg.desc,
      cover: '',
      count: null,
      error: cardError(r.reason),
    }
  })
}
