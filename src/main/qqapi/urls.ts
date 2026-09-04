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

interface VkeyRow { songmid?: string; purl?: string; filename?: string }

function pickPurl(rows: VkeyRow[], songmid: string): string {
  const row = rows.find((r) => r?.purl && (!r.songmid || r.songmid === songmid))
  return (row?.purl ?? '') as string
}

async function requestVkey(
  client: QqClient,
  songmid: string,
  filename: string,
): Promise<{ sip: string; rows: VkeyRow[] }> {
  const data = (await client.postMusicu({
    req_1: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        filename: [filename],
        guid: String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000),
        songmid: [songmid],
        songtype: [0],
        uin: '0',
        loginflag: 1,
        platform: '20',
      },
    },
  }, { path: ['req_1', 'data'] })) as { sip?: string[]; midurlinfo?: VkeyRow[] }
  // midurlinfo 行与本次请求的 filename 一一对应（部分行不带 filename 字段时保留，
  // 交由 pickPurl 按 songmid 兜底匹配）
  const rows = (data?.midurlinfo ?? []).filter((r) => !r?.filename || r.filename === filename)
  return { sip: data?.sip?.[0] ?? '', rows }
}

/** 取直链。按质量档位请求；空 purl 降级。mediaMid 与 songmid 不同时先试 mediaMid 再试双 mid。 */
export async function getAudioUrl(
  client: QqClient,
  songmid: string,
  mediaMid: string | undefined,
  preferred: Quality,
): Promise<AudioUrlResult> {
  const startIdx = QUALITY_LADDER.indexOf(preferred)  // flac→0, 320→2 …
  const filenames = new Set<string>()
  if (mediaMid && mediaMid !== songmid) filenames.add(`${QUALITY_MAP[preferred].prefix}${mediaMid}.${QUALITY_MAP[preferred].ext}`)
  filenames.add(`${QUALITY_MAP[preferred].prefix}${songmid}${songmid}.${QUALITY_MAP[preferred].ext}`)

  for (const fn of filenames) {
    const { sip, rows } = await requestVkey(client, songmid, fn)
    const purl = pickPurl(rows, songmid)
    if (sip && purl) return { url: sip + purl, quality: preferred, downgraded: false }
  }

  // 降级链：从 preferred 的下一个档位开始往下找
  for (let i = startIdx + 1; i < QUALITY_LADDER.length; i++) {
    const q = QUALITY_LADDER[i]
    const f1 = `${QUALITY_MAP[q].prefix}${mediaMid ?? songmid}.${QUALITY_MAP[q].ext}`
    const f2 = `${QUALITY_MAP[q].prefix}${songmid}${songmid}.${QUALITY_MAP[q].ext}`
    for (const fn of new Set([f1, f2])) {
      const { sip, rows } = await requestVkey(client, songmid, fn)
      const purl = pickPurl(rows, songmid)
      if (sip && purl) return { url: sip + purl, quality: q, downgraded: true }
    }
  }

  throw new Error('未拿到可播放 URL：登录过期或账号权益不足（无损需绿钻权益）')
}