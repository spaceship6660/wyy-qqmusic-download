// 中外文歌词合并：原文行下插入译文行（同时间戳），foobar2000 / Musicolet 均按行显示。
// 配对依据时间戳（实测网易云 tlyric 与原文演唱行时间戳逐行一致；作词/作曲等头行无译文，自动跳过），
// 而非按行号 zip（头行数量不定，zip 会整体错位）。
export interface LrcLine {
  ms: number
  text: string
}

const TS_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{2,3}))?\]/
const ANY_TS_RE = /\[\d{1,3}:\d{2}/
const LEADING_TAGS_RE = /^(\s*\[[^\]\r\n]*\])+/

/** 译文占位行判定：QQ 译文流用 // 表示该行无翻译（须丢弃，否则以孤儿行追加到末尾污染歌词） */
function isPlaceholder(text: string): boolean {
  return text.replace(/\//g, '').trim() === ''
}

/** 解析首个时间戳 + 去行首标签后的文本；无时间戳返回 null（[ti:]/[ar:] 等保留原样透传） */
export function parseLrcLine(line: string): LrcLine | null {
  const m = line.match(TS_RE)
  if (!m) return null
  const frac = m[3] ?? ''
  const ms = (Number(m[1]) * 60 + Number(m[2])) * 1000 + (frac.length === 2 ? Number(frac) * 10 : Number(frac || 0))
  const text = line.replace(LEADING_TAGS_RE, '').trim()
  return { ms, text }
}

/** 毫秒 → [mm:ss.xx]（毫秒有零头保留三位，否则两位，与源格式一致、零精度损失） */
export function formatLrcTime(ms: number): string {
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const rest = Math.round(ms % 1000)
  const head = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  if (rest % 10 !== 0) return `${head}.${String(rest).padStart(3, '0')}`
  return `${head}.${String(rest / 10).padStart(2, '0')}`
}

/** 合并译文：原文每行下插入同时间戳译文行。
 * - 译文无时间戳/为空 → 原样返回原文；
 * - 配对优先精确到毫秒，退化为 600ms 内最近未用行；
 * - 配不上原文的译文行按自身时间戳追加末尾（几乎不发生，丢了更可惜）。 */
export function mergeLyricTranslation(orig: string, trans: string): string {
  if (!orig) return ''
  if (!trans || !trans.trim() || !ANY_TS_RE.test(trans)) return orig
  const tLines = trans
    .split('\n')
    .map((raw) => ({ raw, p: parseLrcLine(raw) }))
    .filter((x): x is { raw: string; p: LrcLine } => !!x.p && !!x.p.text && !isPlaceholder(x.p.text))
  if (tLines.length === 0) return orig
  const used = new Array<boolean>(tLines.length).fill(false)
  const out: string[] = []
  for (const rawLine of orig.split('\n')) {
    out.push(rawLine)
    const p = parseLrcLine(rawLine)
    if (!p || !p.text) continue
    // 译文行复用原文的时间戳原文（格式零损失，如 [00:06.650] 不会变成 [00:06.65]）
    const tsText = rawLine.match(/^\s*(\[[^\]\r\n]*\])/)?.[1] ?? `[${formatLrcTime(p.ms)}]`
    let idx = tLines.findIndex((t, i) => !used[i] && t.p.ms === p.ms)
    if (idx < 0) {
      let best = -1
      let bestDiff = 600
      tLines.forEach((t, i) => {
        if (used[i]) return
        const d = Math.abs(t.p.ms - p.ms)
        if (d < bestDiff) {
          bestDiff = d
          best = i
        }
      })
      idx = best
    }
    if (idx >= 0) {
      used[idx] = true
      out.push(`${tsText}${tLines[idx].p.text}`)
    }
  }
  const leftovers = tLines
    .filter((_, i) => !used[i])
    .map((t) => t.p)
    .sort((a, b) => a.ms - b.ms)
  for (const l of leftovers) out.push(`[${formatLrcTime(l.ms)}]${l.text}`)
  return out.join('\n')
}
