import type { NeClient } from './client'
import { mergeLyricTranslation } from '../lyricMerge'

/** 歌词（lrc.lyric + tlyric 中文译文合并）；失败/缺失返回空串，不阻塞下载 */
export async function neFetchLyric(client: NeClient, id: number): Promise<string> {
  try {
    const json = await client.getJson<{ lrc?: { lyric?: string }; tlyric?: { lyric?: string } }>(
      `https://music.163.com/api/song/lyric?os=pc&id=${id}&lv=-1&tv=1`,
    )
    const orig = json?.lrc?.lyric ?? ''
    if (!orig) return ''
    return mergeLyricTranslation(orig, json?.tlyric?.lyric ?? '')
  } catch {
    return ''
  }
}