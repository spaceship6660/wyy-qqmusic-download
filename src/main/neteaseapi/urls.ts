import { QqApiError } from '../qqapi/client'
import type { Quality } from '../qqapi/tracks'
import type { NeClient } from './client'

// 网易云 br 档位：0=无损(flac)、320000、128000。ape/m4a 无对应档位。
// 端点与 Creamplayer utils/api.ts 同款（参考 docs/netease-download-research-2026-09-04.md §2 实测）。
export const NE_QUALITY_BR: Partial<Record<Quality, number>> = { flac: 0, '320': 320000, '128': 128000 }
export const NE_LADDER: Quality[] = ['flac', '320', '128']

export interface NeAudioUrlResult { url: string; quality: Quality; downgraded: boolean }

export async function neGetAudioUrl(
  client: NeClient,
  id: number,
  preferred: Quality,
): Promise<NeAudioUrlResult> {
  // ape/m4a 无对应 br 档 → 从 320 起，且命中即视为降级
  const supported = NE_QUALITY_BR[preferred] !== undefined
  const startIdx = supported ? NE_LADDER.indexOf(preferred) : 1
  for (let i = Math.max(0, startIdx); i < NE_LADDER.length; i++) {
    const q = NE_LADDER[i]
    const br = NE_QUALITY_BR[q]!
    const json = await client.getJson<{ code?: number; data?: Array<{ url?: string | null; br?: number }> }>(
      `https://music.163.com/api/song/enhance/player/url?ids=[${id}]&br=${br}`,
    )
    const url = json?.data?.[0]?.url
    if (url) return { url, quality: q, downgraded: !supported || i > startIdx }
  }
  throw new QqApiError('未拿到可播放 URL（可能无版权/未上架，VIP 歌需登录，无损需会员权益）', 'no-playable-url')
}