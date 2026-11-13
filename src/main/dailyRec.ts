import { safeName } from './fsUtils'
import type { TrackDTO } from './qqapi/tracks'
import type { AlbumBundle } from './albumBundle'

export type DailySource = 'qq' | 'netease'

/** Unix 秒 → 上海日期 YYYY-MM-DD（日推卡片 time 的跨日判据） */
export function shanghaiDayKey(unixSec: number): string {
  return new Date((unixSec + 8 * 3600) * 1000).toISOString().slice(0, 10)
}

/** 当前上海日期；可注入 now 便于测试跨日 */
export function todayShanghai(nowMs = Date.now()): string {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 日推落盘目录：Q音26-10-31日推30首 / 网易云26-10-31风格推荐。
 *  日期用**打开当天**的上海日期，同一天重复下载复用同一目录。 */
export function dailyDirName(source: DailySource, dayKey: string, label: string): string {
  const prefix = source === 'qq' ? 'Q音' : '网易云'
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayKey) ? dayKey.slice(2) : dayKey
  return safeName(`${prefix}${day}${label}`)
}

/** 日推批次上下文：复用专辑的「一个目录」落盘机制（文件名只留曲名、不加序号），但 kind=playlist
 *  表示这不是专辑——不写 cover.jpg / album.cue，也不写 TRCK/TPOS 标签。 */
export function buildDailyBundle(
  source: DailySource,
  mode: string,
  label: string,
  dayKey: string,
  tracks: TrackDTO[],
  coverUrl: string,
): AlbumBundle {
  if (tracks.length === 0) throw new Error('日推列表为空，无法建立下载批次')
  return {
    source,
    kind: 'playlist',
    dirName: dailyDirName(source, dayKey, label),
    id: `rec:${source}:${mode}:${dayKey}`,
    name: label,
    artist: '',
    date: dayKey,
    company: '',
    coverUrl,
    totalTracks: tracks.length,
    discs: [1],
    discTotals: { 1: tracks.length },
  }
}
