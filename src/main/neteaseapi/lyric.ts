import type { NeClient } from './client'

/** 歌词（lrc.lyric）；失败/缺失返回空串，不阻塞下载 */
export async function neFetchLyric(client: NeClient, id: number): Promise<string> {
  try {
    const json = await client.getJson<{ lrc?: { lyric?: string } }>(
      `https://music.163.com/api/song/lyric?os=pc&id=${id}&lv=-1&tv=1`,
    )
    return json?.lrc?.lyric ?? ''
  } catch {
    return ''
  }
}