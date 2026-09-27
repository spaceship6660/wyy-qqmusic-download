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

/** 构造从 preferred 档起向下（含降级档）的全部候选 filename。每档两种形式：mediaMid 单写 + 双 mid 写，去重。
 * available：该曲实际登记的档位（见 getTrackDetail().sizes）。传入且非空时**只保留交集**——
 * 见 getAudioUrl 的注释：服务端只认候选首位，混入该曲不存在的档位会导致整批拿不到直链。 */
export function buildCandidates(
  songmid: string,
  mediaMid: string | undefined,
  preferred: Quality,
  available?: Quality[],
): Array<{ quality: Quality; filename: string }> {
  const startIdx = QUALITY_LADDER.indexOf(preferred)
  const allow = available && available.length > 0 ? new Set(available) : null
  const out: Array<{ quality: Quality; filename: string }> = []
  const seen = new Set<string>()
  const singleMid = mediaMid && mediaMid !== songmid ? mediaMid : songmid
  for (let i = startIdx; i < QUALITY_LADDER.length; i++) {
    const q = QUALITY_LADDER[i]
    if (allow && !allow.has(q)) continue
    const { prefix, ext } = QUALITY_MAP[q]
    for (const form of [singleMid, `${songmid}${songmid}`]) {
      const fn = `${prefix}${form}.${ext}`
      if (seen.has(fn)) continue
      seen.add(fn)
      out.push({ quality: q, filename: fn })
    }
  }
  // 收窄后为空（如 preferred 比该曲登记的档位还低、交集为空）→ 退回不收窄，别因 sizes 不可信反而下不了
  if (out.length === 0 && allow) return buildCandidates(songmid, mediaMid, preferred)
  return out
}

/** 取直链：一次批量请求全部候选，按响应行挑选有 purl 的最高档候选；实际质量以返回的文件名前缀为准。
 *
 * **候选必须收窄到该曲实际登记的档位（available）**：2026-09-27 实测服务端**只按候选首位核发直链**，
 * 首位档位不存在就整批回空 purl，不逐条回退——
 *   [M500(有), F000(无)] → 拿到 M500；[M800(无), M500(有)] → 全空。
 * 故「无损起 + 混入不存在的档位」的批量问法对没有无损的曲子 100% 失败（用户报的「没自动降级」）。
 * available 由 getTrackDetail().sizes 得出；取不到时传 undefined，退回旧的全量行为。
 *
 * debug：可选诊断回调。全档失败时记录现场（sip 有无/行数/每行 filename+有无 purl，不记 purl/vkey 值），
 * 用于区分“服务端无下载版权（行在但全空）”与“请求/匹配姿势不对（行缺/文件名对不上）”。 */
export async function getAudioUrl(
  client: QqClient,
  songmid: string,
  mediaMid: string | undefined,
  preferred: Quality,
  debug?: (line: string) => void,
  available?: Quality[],
): Promise<AudioUrlResult> {
  const startIdx = QUALITY_LADDER.indexOf(preferred)
  const candidates = buildCandidates(songmid, mediaMid, preferred, available)
  const byFilename = new Map(candidates.map((c) => [c.filename, c.quality]))
  // uin 必须回传登录账号（此前硬编码 '0'）：VIP/绿钻的直链权益按账号核发，
  // 客户端 comm.uin 是登录号而 param.uin=0 会被服务端当匿名处理 → 全档空 purl。
  const uin = client.getUin().replace(/^o/i, '') || '0'

  const data = (await client.postMusicu({
    req_1: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        filename: candidates.map((c) => c.filename),
        guid: String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000),
        songmid: [songmid],
        songtype: [0],
        uin,
        loginflag: 1,
        platform: '20',
      },
    },
  }, { path: ['req_1', 'data'] })) as { sip?: string[]; midurlinfo?: VkeyRow[] }

  const sip = data?.sip?.[0] ?? ''
  const rows = data?.midurlinfo ?? []
  debug?.(
    `vkey ${songmid} 起点 ${preferred}${available?.length ? ` 收窄至[${available.join('/')}]` : ''}：` +
    `sip=${sip ? '有' : '无'} rows=${rows.length} 有purl=${rows.filter((r) => r?.purl).length}`,
  )
  for (const row of rows) {
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

  debug?.(
    `vkey ${songmid} 全档空：candidates=[${candidates.map((c) => c.filename).join(',')}] ` +
    `rows=[${rows.map((r) => `${r?.filename ?? '(无文件名)'}=${r?.purl ? '有' : '空'}`).join(',')}]`,
  )
  throw new QqApiError('未拿到可播放 URL（可能需要登录，或账号权益不足，无损需绿钻权益）', 'no-playable-url')
}