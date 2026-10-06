import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AlbumPackager, renderCue, type CueEntry } from '../src/main/albumPackaging'
import type { AlbumBundle } from '../src/main/albumBundle'

const B: AlbumBundle = {
  source: 'netease', id: '7', name: '奇爱人生 LOVE ELEGIA', artist: '阿良良木健',
  date: '2019-05-20', company: '', coverUrl: '', totalTracks: 2, discs: [1], discTotals: { 1: 2 },
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

// ---------- Task 12：AlbumPackager 完成度跟踪 ----------
// cue 的前提是「这一碟真的全落盘了」，而这个事实只有记账方知道：落盘名可能被 uniquePath 改成
// '01 t1(1).mp3'、容器可能被降级换成 mp3。所以这里断言的是「记账结果」，
// 而不是「文件名能不能拼出来」——后者拼得出来恰恰是错的（指向了不存在的文件）。
describe('AlbumPackager 完成度', () => {
  const B1: AlbumBundle = { ...B, totalTracks: 2, discs: [1], discTotals: { 1: 2 } }
  const B2: AlbumBundle = { ...B, totalTracks: 2, discs: [1, 2], discTotals: { 1: 1, 2: 1 } }
  // 一张 10 首的单碟专辑：懒加载页只会入队其中一部分，完成度必须按这里的 10 判
  const B10: AlbumBundle = { ...B, totalTracks: 10, discs: [1], discTotals: { 1: 10 } }
  const done = (trackNo: number, fileName: string, title: string, ext = 'flac') =>
    ({ trackNo, outputPath: fileName, ext, title })

  it('专辑 10 首、只入队 2 首且都成功 → 不算下齐、不出 cue（0.7.0 评审的核心用例）', () => {
    // 判据若取入队曲目数（旧行为），这两首就是「整碟」，盘上会留下一份 2 FILE 的 cue，
    // foobar2000 把这张 10 首专辑呈现成 2 首——比没有 cue 更糟（spec §5.5）。
    const p = new AlbumPackager()
    p.plan(B10, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    expect(p.record(B10, done(1, '01 a.flac', 'a'))).toEqual([])
    expect(p.record(B10, done(2, '02 b.flac', 'b'))).toEqual([])
    expect(p.cueEntries(B10, 1)).toEqual([])
  })

  it('补齐剩下的 8 首（第二次 plan 合并期望）→ cue 出现且含 10 个 FILE', () => {
    // 用户滚到底再点「下载整张」是同一 session 的第二次入队：期望表必须合并而不是重建，
    // 否则前两首被后面八首顶掉，永远配不齐。
    const p = new AlbumPackager()
    p.plan(B10, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    p.record(B10, done(1, '01 a.flac', 'a'))
    p.record(B10, done(2, '02 b.flac', 'b'))
    p.plan(B10, Array.from({ length: 8 }, (_, i) => ({ trackNo: i + 3, disc: 1 })))
    for (let no = 3; no < 10; no++) expect(p.record(B10, done(no, `0${no} x.flac`, 'x'))).toEqual([])
    expect(p.record(B10, done(10, '10 z.flac', 'z'))).toEqual([1])
    const entries = p.cueEntries(B10, 1)
    expect(entries).toHaveLength(10)
    expect(entries.map((e) => e.trackNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // 前两首仍是第一次入队那两笔账（旧落盘名不能因为第二次没提交它们就丢）
    expect(entries.map((e) => e.fileName)).toEqual([
      '01 a.flac', '02 b.flac', '03 x.flac', '04 x.flac', '05 x.flac',
      '06 x.flac', '07 x.flac', '08 x.flac', '09 x.flac', '10 z.flac',
    ])
    expect(renderCue(B10, entries)).not.toBeNull()
  })

  it('多碟：每碟各自按 discTotals 判齐，CD01 下齐不等 CD02', () => {
    // 专辑共 4 首、两碟各 2 首。只把 CD01 的两首下完就该有 CD01 的 cue（旧实现同样成立，
    // 这里锁的是「判据换成 discTotals 后各碟互不拖累」）。
    const B4: AlbumBundle = { ...B, totalTracks: 4, discs: [1, 2], discTotals: { 1: 2, 2: 2 } }
    const p = new AlbumPackager()
    p.plan(B4, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    expect(p.record(B4, done(1, '01 a.flac', 'a'))).toEqual([])
    expect(p.record(B4, done(2, '02 b.flac', 'b'))).toEqual([1])
    expect(p.cueEntries(B4, 2)).toEqual([])
  })

  it('disc 不在 discTotals 里（入队了不属于这张专辑这一碟的曲）→ 不抛、永不判齐', () => {
    // 真实数据走不到这条（bundle 与 tracks 同一次解析产出）；走到了说明两处对不上，
    // 此时凭猜测决定这张专辑有几首比不出 cue 更糟。
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 3 }, { trackNo: 2, disc: 1 }])
    expect(p.record(B1, done(1, '03 a.flac', 'a'))).toEqual([])
    expect(p.cueEntries(B1, 3)).toEqual([])
    expect(() => p.cueEntries(B1, 99)).not.toThrow()
  })

  it('单碟：未下齐不出 cue，下齐返回该碟', () => {
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    expect(p.record(B1, done(1, '01 a.flac', 'a'))).toEqual([])
    expect(p.cueEntries(B1, 1)).toEqual([])   // 半张时连条目都不给：cue 指向缺文件比没有 cue 更糟
    expect(p.record(B1, done(2, '02 b.flac', 'b'))).toEqual([1])
    expect(p.cueEntries(B1, 1).map((e) => e.fileName)).toEqual(['01 a.flac', '02 b.flac'])
  })

  it('多碟：CD01 齐了先出 CD01，不等 CD02', () => {
    const p = new AlbumPackager()
    p.plan(B2, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 2 }])
    expect(p.record(B2, done(1, '01 a.flac', 'a'))).toEqual([1])
    // 各碟只收自己的条目：CD01 的 cue 里出现 CD02 的文件，播放器就会去隔壁目录找不存在的相对路径
    expect(p.cueEntries(B2, 1).map((e) => e.trackNo)).toEqual([1])
    expect(p.cueEntries(B2, 2)).toEqual([])
    expect(p.record(B2, done(2, '02 b.flac', 'b'))).toEqual([2])
    expect(p.cueEntries(B2, 2).map((e) => e.trackNo)).toEqual([2])
    // 一次记账只报自己那一碟：CD01 早已写过 cue，被 CD02 的完成连带重写等于白写一遍（也会把
    // 「哪一碟变了」这件事说得像两碟一起变）
    expect(p.record(B2, done(1, '01 a(1).flac', 'a'))).toEqual([1])
  })

  it('已齐碟里的曲被重试覆写 → 该碟再报一次，cue 跟着新落盘名重写', () => {
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    expect(p.record(B1, done(1, '01 a.flac', 'a'))).toEqual([])
    expect(p.record(B1, done(2, '02 b.flac', 'b'))).toEqual([1])
    // 第二次整张下载：t2 撞名落盘成 '02 b(1).flac'。若这里不报该碟，盘上的 cue 就一直写着上一轮的文件名
    expect(p.record(B1, done(2, '02 b(1).flac', 'b'))).toEqual([1])
    expect(p.cueEntries(B1, 1).map((e) => e.fileName)).toEqual(['01 a.flac', '02 b(1).flac'])
  })

  it('同一曲重复完成（重试）按后到者覆盖，不重复触发', () => {
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    p.record(B1, done(1, '01 a.flac', 'a'))
    expect(p.record(B1, done(1, '01 a(1).flac', 'a'))).toEqual([])
    p.record(B1, done(2, '02 b.flac', 'b'))
    expect(p.cueEntries(B1, 1).map((e) => e.fileName)).toEqual(['01 a(1).flac', '02 b.flac'])
  })

  it('cue 条目的 title 用原曲名，不从文件名反推（safeName 会换掉 / : * 等字符并截断）', () => {
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    p.record(B1, done(1, '01 A-B.flac', 'A/B'))
    p.record(B1, done(2, '02 b.flac', 'b'))
    expect(p.cueEntries(B1, 1)[0].title).toBe('A/B')
  })

  it('fileName 取实际落盘全路径的 basename，容器跟落盘扩展名（降级换档后 cue 才不会指错类型）', () => {
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    // 第 1 曲请求无损但该直链 404 → 重取拿到 320k，落盘是 mp3：record 拿的是 job.outputPath
    p.record(B1, { trackNo: 1, outputPath: 'C:\\dl\\S - A (2019)\\01 a.mp3', ext: 'mp3', title: 'a' })
    p.record(B1, done(2, 'C:/dl/S - A (2019)/02 b.flac', 'b'))
    expect(p.cueEntries(B1, 1)).toEqual([
      { trackNo: 1, title: 'a', fileName: '01 a.mp3', container: 'MP3' },
      { trackNo: 2, title: 'b', fileName: '02 b.flac', container: 'FLAC' },
    ])
  })

  it('ape/m4a 容器 → cueEntries 返回空（该碟不出 cue，宁缺不错）', () => {
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    p.record(B1, done(1, '01 a.ape', 'a', 'ape'))
    expect(p.record(B1, done(2, '02 b.ape', 'b', 'ape'))).toEqual([1])  // 碟是「齐」的，只是容器索引不了
    expect(p.cueEntries(B1, 1)).toEqual([])
    // 混进一个不可索引的容器就整碟撤回（与 renderCue 的「一碟要么整碟可索引」同口径）
    p.record(B1, done(2, '02 b.mp3', 'b', 'mp3'))
    expect(p.cueEntries(B1, 1)).toEqual([])
    // 换成两个可索引容器才出条目，且容器取落盘 ext 而非请求档位
    p.record(B1, done(1, '01 a.flac', 'a', 'flac'))
    expect(p.cueEntries(B1, 1).map((e) => e.container)).toEqual(['FLAC', 'MP3'])
  })

  it('取消/失败不入账（半张不会被算成整张）', () => {
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    p.record(B1, done(1, '01 a.flac', 'a'))
    expect(p.record(B1, done(2, '', 'b'))).toEqual([])   // outputPath 空 = 未产出，不记账
    expect(p.cueEntries(B1, 1)).toHaveLength(0)
  })

  it('两张专辑各自记账（键含 source:id，同 trackNo 不串台）', () => {
    const p = new AlbumPackager()
    const other: AlbumBundle = { ...B1, id: '8' }
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    p.plan(other, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    p.record(B1, done(1, '01 a.flac', 'a'))
    expect(p.record(other, done(1, '01 other.flac', 'o'))).toEqual([])
    expect(p.cueEntries(B1, 1)).toEqual([])
    p.record(B1, done(2, '02 b.flac', 'b'))
    expect(p.cueEntries(B1, 1).map((e) => e.fileName)).toEqual(['01 a.flac', '02 b.flac'])
    expect(p.cueEntries(other, 1)).toEqual([])
  })

  it('未 plan 过的批次：record 不抛、返回空碟，cueEntries 也为空（没有期望就谈不上「齐」）', () => {
    const p = new AlbumPackager()
    expect(p.record(B1, done(1, '01 a.flac', 'a'))).toEqual([])
    expect(p.cueEntries(B1, 1)).toEqual([])
  })

  it('条目按 trackNo 升序（入账顺序是完成顺序，与曲目顺序无关）', () => {
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    p.record(B1, done(2, '02 b.flac', 'b'))
    p.record(B1, done(1, '01 a.flac', 'a'))
    expect(p.cueEntries(B1, 1).map((e) => e.trackNo)).toEqual([1, 2])
  })

  it('trackNo 缺失：登记按下标、记账按 1 → 该碟永远配不齐，只出不了 cue（不出缺段 cue）', () => {
    // 两处口径不一致是有意的：凭空把两首都算成「第 1 首」会配平一张只有一段 FILE 的 cue，
    // 播放器看到的是一张 2 首的专辑里第 2 首凭空消失——少一份 cue 比给一份错的强。
    const p = new AlbumPackager()
    p.plan(B1, [{ disc: 1 }, { disc: 1 }])
    p.record(B1, done(1, '01 a.flac', 'a'))
    expect(p.record(B1, done(1, '01 a(1).flac', 'a'))).toEqual([])
    expect(p.cueEntries(B1, 1)).toEqual([])
  })

  it('AlbumPackager 出的条目直接喂 renderCue 能出文本（两个模块的口径必须咬合）', () => {
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    p.record(B1, done(1, '01 a.flac', 'a'))
    expect(renderCue(B1, p.cueEntries(B1, 1))).toBeNull()
    p.record(B1, done(2, '02 b.mp3', 'b', 'mp3'))
    const entries = p.cueEntries(B1, 1)
    const s = renderCue(B1, entries) as string
    expect(s).toContain('FILE "01 a.flac" FLAC')
    expect(s).toContain('FILE "02 b.mp3" MP3')
    expect(s).not.toContain('FILE "02 b.mp3" FLAC')   // 容器来自落盘 ext，不是请求档位
  })
})
