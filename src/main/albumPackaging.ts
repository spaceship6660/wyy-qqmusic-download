import path from 'node:path'
import type { AlbumBundle } from './albumBundle'

/** cue 的一个 FILE 段条目，来自「实际落盘的那一笔」而非请求参数。
 *  container 是落盘扩展名的大写形式：降级换容器后一张专辑里会 flac/mp3 混着出，
 *  cue 的 FILE 关键字必须跟着真实文件走，写请求档位会让播放器索引失败。 */
export interface CueEntry {
  trackNo: number
  title: string
  fileName: string          // 实际落盘 basename，含 uniquePath 加过的 (1) 后缀。原样使用不重新推导——
                            // 在这里按 trackNo/safeName 再拼一遍，同名冲突时就指向了不存在的文件
  container: string
}

/** 播放器能按 FILE 段索引的容器关键字。ape/m4a/ogg 没有对应关键字（且本版本无标签写入器），
 *  宁缺不错：整碟不出 cue，也不出一份指向播放器读不了的文件的 cue。 */
const CUE_CONTAINERS = new Set(['FLAC', 'MP3'])

// BOM 用码点构造：它是不可见字符，写成字面量没人看得出这行到底有没有它（typecheck 也看不出来）
const BOM = String.fromCharCode(0xfeff)

/** 字段值加引号。值里的 `"` 换成 `'`：CUE 语法没有标准转义，留个裸引号会把后面所有行的引号配对一起带偏。 */
const q = (s: string): string => `"${s.replace(/"/g, "'")}"`

/** 整碟的 album.cue 文本（UTF-8 with BOM + CRLF）；返回 null 表示这一碟不该有 cue，写盘方直接跳过。
 *
 *  形态：每曲一文件 → 每个 FILE 段一个 TRACK，INDEX 00 指向该文件起点（不是整轨 image 的分轨偏移）。
 *  碟号不进文本：多碟时同一张专辑每碟各一份 cue、各写在自己的目录里，目录才是碟号的载体（Task 12），
 *  写进 cue 反而会让播放器去找不存在的段。
 *  头部只写有依据的行：AlbumBundle 没有 genre 就不写 REM GENRE，没有 gain 数据就不写 REM REPLAYGAIN_*。
 *  BOM/CRLF 都是为中文 Windows 的播放器服务的：无 BOM 时 foobar2000 会按 GBK 猜编码，中文曲名乱码。 */
export function renderCue(b: AlbumBundle, entries: CueEntry[]): string | null {
  if (entries.length === 0) return null   // 只有头部、一个 FILE 都没有 → 指不到任何文件，等于噪声
  // 一碟要么整碟可索引，要么没有：混进一个读不了的容器就全部撤回
  if (entries.some((e) => !CUE_CONTAINERS.has(e.container.toUpperCase()))) return null

  const sorted = [...entries].sort((x, y) => x.trackNo - y.trackNo)  // 副本排序，不改调用方传入的数组
  const lines: string[] = []
  // date 已由 normalizeDate 收口成 'YYYY-MM-DD' 或空串；这里仍只认带年份前缀的形态，脏值宁可少一行
  if (/^\d{4}-/.test(b.date)) lines.push(`REM DATE ${b.date.slice(0, 4)}`)
  lines.push(`PERFORMER ${q(b.artist)}`, `TITLE ${q(b.name)}`)
  for (const e of sorted) {
    const no = String(e.trackNo).padStart(2, '0')
    lines.push(`FILE ${q(e.fileName)} ${e.container.toUpperCase()}`)
    lines.push(`  TRACK ${no} AUDIO`)
    lines.push(`    TITLE ${q(e.title)}`)
    lines.push(`    PERFORMER ${q(b.artist)}`)
    lines.push('    INDEX 00 00:00:00')
  }
  return BOM + lines.join('\r\n') + '\r\n'
}

/** 批次键：完成度表与「cover 是否已写过」都用它。两处各拼一遍就会漂成「同 id 的两个源互相顶包」
 *  （QQ 与网易云的 id 命名空间不同：'m1' 与 '1' 都会出现），所以只留这一份算式。 */
export function albumKey(b: AlbumBundle): string {
  return `${b.source}:${b.id}`
}

/** 一笔完成记录：outputPath 必须是**实际落盘全路径**（含 uniquePath 加过的 (1) 后缀），
 *  ext 必须是**落盘**扩展名（降级换档后它与请求档位不同），
 *  title 必须是**原曲名**——文件名经 safeName 会换掉 / : * 等字符并截断，反推会失真。 */
export interface AlbumCompletion {
  trackNo: number
  outputPath: string
  ext: string
  title: string
}

type DoneRec = { fileName: string; ext: string; title: string }

/** 整张专辑的批次完成度：plan() 登记期望，record() 记账，某碟下齐才允许出该碟 cue。
 *  session 内有效（与 app.ts 的 jobSpecs 同生命周期）；重启后需重新整张入队。
 *  「下齐」的**数量**判据来自 bundle.discTotals（专辑真实曲目数），不是入队曲目数——见 AlbumBundle 的字段注释。 */
export class AlbumPackager {
  private expected = new Map<string, Map<number, number>>()  // key → (trackNo → disc)
  private done = new Map<string, Map<number, DoneRec>>()

  /** 登记「这批曲目属于这张专辑的哪一碟」。trackNo 缺失按下标+1：期望表按入队顺序就是整批，
   *  而 record 那边缺 trackNo 只能按 1 —— 两处口径不一致时该碟永远配不齐、只出不了 cue，
   *  这比把两首都算成「第 1 首」、出一张缺了第 2 段的 cue 安全。
   *  入队列表在这里只贡献 trackNo → 碟号 的对应关系（解析层才知道的分配信息），
   *  **该碟该有几首**由 b.discTotals 决定：专辑页懒加载、入队往往只是子集，按子集判齐就是
   *  给一张 10 首的专辑写 2 FILE 的 cue。同一个批次多次 plan（先下 2 首、滚完再下 8 首）合并进
   *  同一张期望表——这是「残缺批次之后补齐」这条恢复路径成立的前提。 */
  plan(b: AlbumBundle, tracks: Array<{ trackNo?: number; disc?: number }>): void {
    const k = albumKey(b)
    const exp = this.expected.get(k) ?? new Map<number, number>()
    tracks.forEach((t, i) => {
      // disc 回落 discs[0]（与 runDownloadJob 的落盘目录同一个算式）：两处不一致时
      // cue 会写到音频不在的那个目录。
      exp.set(t.trackNo ?? i + 1, t.disc ?? b.discs[0] ?? 1)
    })
    this.expected.set(k, exp)
    if (!this.done.has(k)) this.done.set(k, new Map())
  }

  /** 记一笔完成；outputPath 为空视为未产出（取消/失败）不入账——半张永远不该被算成整张。
   *  返回这次记账**所属且已下齐**的碟（0 或 1 个）：一次记账只可能改动一碟的完整度
   *  （别的碟一条账都没变），所以不去重报别的碟。已齐碟里的曲被重试覆写时同样报一次——
   *  cue 是整碟全量重写，覆写后的新落盘名（'01 a(1).flac'）必须跟着进 cue，
   *  否则 FILE 还指着上一轮的旧文件（spec §5.5「此后任一重试成功都会重写该碟 cue」）。
   *  「齐」只看曲目数，不看容器可否索引：ape 碟照样算齐（record 照报），只是 cueEntries 不给条目。 */
  record(b: AlbumBundle, c: AlbumCompletion): number[] {
    if (!c.outputPath) return []
    const k = albumKey(b)
    const d = this.done.get(k) ?? new Map<number, DoneRec>()
    d.set(c.trackNo, { fileName: path.basename(c.outputPath), ext: c.ext, title: c.title })
    this.done.set(k, d)
    const exp = this.expected.get(k)
    // 没登记过这首（plan 之外的批次）→ 谈不上「这次把它配齐了」
    const disc = exp?.get(c.trackNo)
    if (exp === undefined || disc === undefined) return []
    return this.discFull(b, exp, d, disc) ? [disc] : []
  }

  /** 该碟的 cue 条目；碟内任一曲未落盘、落盘数没到 discTotals 声明的真实数、
   *  或含播放器索引不了的容器（ape/m4a/ogg）→ 返回空，不出 cue。
   *  容器判据复用 renderCue 那份 CUE_CONTAINERS：两处各列一遍会漂成「这里放行的容器在 renderCue 被撤回」，
   *  于是 cue 写不出来、却没有任何一处说为什么。 */
  cueEntries(b: AlbumBundle, disc: number): CueEntry[] {
    const k = albumKey(b)
    const exp = this.expected.get(k)
    const d = this.done.get(k)
    if (!exp || !d) return []
    if (!this.discFull(b, exp, d, disc)) return []
    const out: CueEntry[] = []
    for (const [no, dd] of exp) {
      if (dd !== disc) continue
      const rec = d.get(no)
      if (!rec) return []   // discFull 已保证走不到这里；留着是让「槽位不在账上」两种判据永远同源
      const container = rec.ext.toUpperCase()
      if (!CUE_CONTAINERS.has(container)) return []
      out.push({ trackNo: no, title: rec.title, fileName: rec.fileName, container })
    }
    return out.sort((x, y) => x.trackNo - y.trackNo)
  }

  /** 该碟是否整碟下齐：期望槽位全部落盘，且槽位数达到 bundle 声明的**该碟真实曲目数**。
   *  两个条件各挡一种残缺：槽位没落全 = 这批入队里有失败/取消的；槽位数 < discTotals = 整张只提交了
   *  一部分（懒加载页没滚到底）。后者正是 2026-10-07 评审指出的那条洞——只看前者会给 10 首的专辑
   *  写 2 FILE 的 cue。
   *  disc 不在 discTotals 里（入队了一首不属于这张专辑这一碟的曲）→ 永不判齐：不抛、不写 cue，
   *  音频照下。真实数据走不到这条（bundle 与 tracks 出自同一次解析），走到就说明两处对不上，
   *  此时出 cue 等于凭猜测决定这张专辑有几首——宁缺不错。 */
  private discFull(b: AlbumBundle, exp: Map<number, number>, d: Map<number, DoneRec>, disc: number): boolean {
    const required = b.discTotals?.[disc]
    if (typeof required !== 'number') return false
    let inDisc = 0
    for (const [no, dd] of exp) {
      if (dd !== disc) continue
      inDisc++
      if (!d.has(no)) return false
    }
    return inDisc > 0 && inDisc >= required
  }
}
