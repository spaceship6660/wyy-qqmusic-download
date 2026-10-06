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
