import { QqApiError } from './client'
import type { QqClient } from './client'
import type { Quality } from './tracks'

export const QUALITY_MAP: Record<Quality, { prefix: string; ext: string }> = {
  flac: { prefix: 'F000', ext: 'flac' },
  ape: { prefix: 'A000', ext: 'ape' },
  '320': { prefix: 'M800', ext: 'mp3' },
  '128': { prefix: 'M500', ext: 'mp3' },
  m4a: { prefix: 'C400', ext: 'm4a' },
}

// 降级顺序：无损 → 320 → 128 → m4a
export const QUALITY_LADDER: Quality[] = ['flac', 'ape', '320', '128', 'm4a']

export interface AudioUrlResult {
  url: string
  quality: Quality
  downgraded: boolean
}

interface VkeyRow { songmid?: string; filename?: string; purl?: string }

/** 从「文件名前缀」反查实际质量档（yt-dlp 同款做法）。C200=48k m4a 归 m4a。未知前缀返回 undefined。 */
export function qualityFromPrefix(prefix: string): Quality | undefined {
  switch (prefix) {
    case 'F000': return 'flac'
    case 'A000': return 'ape'
    case 'M800': return '320'
    case 'M500': return '128'
    case 'C400':
    case 'C200': return 'm4a'
    default: return undefined
  }
}

/** 构造从 preferred 档起向下（含降级档）的全部候选 filename。每档两种形式：mediaMid 单写 + 双 mid 写，去重。 */
export function buildCandidates(
  songmid: string,
  mediaMid: string | undefined,
  preferred: Quality,
): Array<{ quality: Quality; filename: string }> {
  const startIdx = QUALITY_LADDER.indexOf(preferred)
  const out: Array<{ quality: Quality; filename: string }> = []
  const seen = new Set<string>()
  const singleMid = mediaMid && mediaMid !== songmid ? mediaMid : songmid
  for (let i = startIdx; i < QUALITY_LADDER.length; i++) {
    const q = QUALITY_LADDER[i]
    const { prefix, ext } = QUALITY_MAP[q]
    for (const form of [singleMid, `${songmid}${songmid}`]) {
      const fn = `${prefix}${form}.${ext}`
      if (seen.has(fn)) continue
      seen.add(fn)
      out.push({ quality: q, filename: fn })
    }
  }
  return out
}

/** 取直链：一次批量请求全部候选，按响应行挑选有 purl 的最高档候选；实际质量以返回的文件名前缀为准。 */
export async function getAudioUrl(
  client: QqClient,
  songmid: string,
  mediaMid: string | undefined,
  preferred: Quality,
): Promise<AudioUrlResult> {
  const startIdx = QUALITY_LADDER.indexOf(preferred)
  const candidates = buildCandidates(songmid, mediaMid, preferred)
  const byFilename = new Map(candidates.map((c) => [c.filename, c.quality]))

  const data = (await client.postMusicu({
    req_1: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        filename: candidates.map((c) => c.filename),
        guid: String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000),
        songmid: [songmid],
        songtype: [0],
        uin: '0',
        loginflag: 1,
        platform: '20',
      },
    },
  }, { path: ['req_1', 'data'] })) as { sip?: string[]; midurlinfo?: VkeyRow[] }

  const sip = data?.sip?.[0] ?? ''
  for (const row of data?.midurlinfo ?? []) {
    if (!row?.purl) continue
    const requested = byFilename.get(row.filename ?? '')
    const legacyOk = !requested && !row.filename && (!row.songmid || row.songmid === songmid)
    if (!sip || (!requested && !legacyOk)) continue
    const purlPrefix = (row.purl.split('/')[0] ?? '').slice(0, 4)
    const actual = qualityFromPrefix(purlPrefix) ?? qualityFromPrefix((row.filename ?? '').slice(0, 4)) ?? requested
    if (!actual) continue
    return {
      url: sip + row.purl,
      quality: actual,
      downgraded: QUALITY_LADDER.indexOf(actual) > startIdx,
    }
  }

  throw new QqApiError('未拿到可播放 URL（可能需要登录，或账号权益不足，无损需绿钻权益）', 'no-playable-url')
}