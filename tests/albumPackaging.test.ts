import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderCue, type CueEntry } from '../src/main/albumPackaging'
import type { AlbumBundle } from '../src/main/albumBundle'

const B: AlbumBundle = {
  source: 'netease', id: '7', name: '奇爱人生 LOVE ELEGIA', artist: '阿良良木健',
  date: '2019-05-20', company: '', coverUrl: '', totalTracks: 2, discs: [1],
}
const E: CueEntry[] = [
  { trackNo: 1, title: '告别曲（Love Elegia Ver.）', fileName: '01 告别曲（Love Elegia Ver.）.flac', container: 'FLAC' },
  { trackNo: 2, title: '遗忘山丘', fileName: '02 遗忘山丘.mp3', container: 'MP3' },
]

// 用码点构造而不是字面量：BOM 是不可见字符，写进源码里谁都看不出这行到底有没有它
const BOM = String.fromCharCode(0xfeff)

// renderCue 返回 null = 这一碟不出 cue（写盘由调用方跳过）；断言「本应出 cue」的用例走这个取文本
const cue = (b: AlbumBundle, entries: CueEntry[]): string => {
  const s = renderCue(b, entries)
  expect(s, '该用例期望产出 cue 文本').not.toBeNull()
  return s as string
}
// 去掉开头 BOM 的正文：头部行序按它判断（BOM 也占一个字符，不去掉 lines[0] 就成了 'REM DATE…'）
const body = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

describe('renderCue', () => {
  it('UTF-8 BOM 开头（无 BOM 时 foobar 在中文 Windows 按 GBK 猜 → 中文曲名乱码）', () => {
    expect(cue(B, E).charCodeAt(0)).toBe(0xfeff)
    expect(cue(B, E).startsWith(BOM)).toBe(true)
    // 只允许开头这一个 BOM：正文里再出现就等于曲名首字多了个不可见字符
    expect(cue(B, E).slice(1)).not.toContain(BOM)
  })

  it('CRLF 换行（含末行），且没有裸 LF', () => {
    const s = cue(B, E)
    expect(s).toContain('\r\n')
    expect(s.endsWith('\r\n')).toBe(true)
    // 裸 LF（Unix 换行）会让部分播放器把整张 cue 当一行解析
    expect(/(?<!\r)\n/.test(s)).toBe(false)
    expect(s.split('\r\n').length).toBeGreaterThan(2)
  })

  it('头部只有 REM DATE / PERFORMER / TITLE 三行', () => {
    const lines = body(cue(B, E)).split('\r\n')
    expect(lines[0]).toBe('REM DATE 2019')
    expect(lines[1]).toBe('PERFORMER "阿良良木健"')
    expect(lines[2]).toBe('TITLE "奇爱人生 LOVE ELEGIA"')
    // 没有的数据不许编：AlbumBundle 无 genre 字段、也没有 gain 数据
    expect(cue(B, E)).not.toContain('REM GENRE')
    expect(cue(B, E)).not.toContain('REPLAYGAIN')
  })

  it('每 FILE 一段 TRACK + INDEX 00，容器按实际 ext，顺序按 trackNo', () => {
    const s = cue(B, [...E].reverse())
    expect(s).toContain('FILE "01 告别曲（Love Elegia Ver.）.flac" FLAC')
    expect(s).toContain('FILE "02 遗忘山丘.mp3" MP3')
    expect(s.indexOf('TRACK 01 AUDIO')).toBeLessThan(s.indexOf('TRACK 02 AUDIO'))
    expect(s).toContain('  TRACK 01 AUDIO')
    expect(s).toContain('    TITLE "告别曲（Love Elegia Ver.）"')
    expect(s).toContain('    PERFORMER "阿良良木健"')
    expect(s).toContain('    INDEX 00 00:00:00')
    // 每曲一段：两曲 = 两个 FILE + 两个 TRACK + 两个 INDEX
    expect(body(s).split('FILE ').length - 1).toBe(2)
    expect(body(s).split('  TRACK ').length - 1).toBe(2)
    expect(body(s).split('INDEX 00 00:00:00').length - 1).toBe(2)
  })

  it('无日期 → 省略 REM DATE 整行（不是写个空 REM DATE）', () => {
    const lines = body(cue({ ...B, date: '' }, E)).split('\r\n')
    expect(lines[0]).toBe('PERFORMER "阿良良木健"')
    expect(lines[1]).toBe('TITLE "奇爱人生 LOVE ELEGIA"')
    expect(cue({ ...B, date: '' }, E)).not.toContain('REM DATE')
  })

  it('脏日期（非 YYYY-MM-DD 前缀）也不写 REM DATE', () => {
    expect(cue({ ...B, date: '未知' }, E)).not.toContain('REM DATE')
  })

  it('曲名含双引号 → 换成单引号（cue 语法无标准转义，破坏引号配对更糟）', () => {
    const s = cue(B, [{ trackNo: 1, title: 'A"B', fileName: 'x.flac', container: 'FLAC' }])
    expect(s).toContain('TITLE "A\'B"')
    // 专辑名/歌手名同样过一遍转义
    expect(cue({ ...B, name: 'X"Y' }, E)).toContain('TITLE "X\'Y"')
    expect(cue({ ...B, artist: 'P"Q' }, E)).toContain('PERFORMER "P\'Q"')
  })

  it('fileName 原样使用（含 uniquePath 加过的 (1) 后缀），TITLE 用原曲名不从文件名反推', () => {
    // safeName 会把 / : * ? 换掉并截断，反推会让 cue 的 TITLE 失真；
    // 而 FILE 名必须是实际落盘的那一个，抹掉 (1) 就指向了不存在的文件。
    const s = cue(B, [{ trackNo: 1, title: 'A/B', fileName: '01 A-B (1).flac', container: 'FLAC' }])
    expect(s).toContain('FILE "01 A-B (1).flac" FLAC')
    expect(s).toContain('    TITLE "A/B"')
  })

  it('条目含 FLAC/MP3 以外的容器 → 该碟不出 cue（返回 null）', () => {
    expect(renderCue(B, [{ trackNo: 1, title: 'a', fileName: '01 a.ape', container: 'APE' }])).toBeNull()
    expect(renderCue(B, [{ trackNo: 1, title: 'a', fileName: '01 a.m4a', container: 'M4A' }])).toBeNull()
    // 混在一碟里也不行：一碟要么整碟可索引，要么干脆没有
    expect(renderCue(B, [...E, { trackNo: 3, title: 'c', fileName: '03 c.ape', container: 'APE' }])).toBeNull()
    // flac + mp3 混合是允许的（降级换容器后的真实形态）
    expect(renderCue(B, E)).not.toBeNull()
  })

  it('容器关键字一律大写（调用方传的是落盘 ext 小写形式，也要出 FILE … FLAC）', () => {
    const s = cue(B, [{ trackNo: 1, title: 'a', fileName: '01 a.flac', container: 'flac' }])
    expect(s).toContain('FILE "01 a.flac" FLAC')
  })

  it('按 utf-8 落盘后前 3 字节是 EF BB BF、行尾是 0D 0A（BOM 的意义就在字节上）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-'))
    const dest = path.join(dir, 'album.cue')
    try {
      await fs.promises.writeFile(dest, cue(B, E), 'utf-8')
      const buf = await fs.promises.readFile(dest)
      expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
      expect(buf.subarray(3, 13).toString('utf-8')).toBe('REM DATE 2')
      expect(buf.includes(Buffer.from('\r\n', 'utf-8'))).toBe(true)
      // 每个 LF 前面都是 CR（字节级 CRLF，没有混进裸 LF）
      const lf = [...buf].filter((x) => x === 0x0a).length
      expect(buf.toString('latin1').split('\r\n').length - 1).toBe(lf)
      expect(buf.toString('utf-8')).toContain('告别曲（Love Elegia Ver.）')   // 中文没被转码转坏
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('空条目 → 不出 cue（只有头部、一个 FILE 都没有的 cue 指向不了任何文件）', () => {
    expect(renderCue(B, [])).toBeNull()
  })

  it('不改动调用方传入的数组（排序在副本上做）', () => {
    const input = [...E].reverse()
    cue(B, input)
    expect(input.map((e) => e.trackNo)).toEqual([2, 1])
  })

  it('碟号不进 cue 文本（多碟时也只靠各自的 cue 文件区分）', () => {
    // 碟号只决定 cue 写到哪个目录（Task 12 的活），文本里出现 DISC/CD 字样反而会让播放器去找不存在的段
    const s = cue({ ...B, discs: [1, 2] }, E)
    expect(s).not.toMatch(/DISC/i)
    expect(s).not.toContain('CD01')
  })
})
