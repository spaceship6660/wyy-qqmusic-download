import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import NodeID3 from 'node-id3'
import { parseFile } from 'music-metadata'
import { parseLrcToSylt, tagMp3 } from '../src/main/tagger/mp3'

describe('parseLrcToSylt', () => {
  it.each([
    { name: '空输入返回 []', lrc: '', expected: [] },
    { name: '纯文本（无时间戳）返回 []', lrc: '第一行\n第二行', expected: [] },
    {
      name: '元数据行 [ar:xx]/[ti:xx]/[offset:500] 跳过',
      lrc: '[ar:歌手]\n[ti:歌名]\n[offset:500]\n[00:01.00]第一行',
      expected: [{ timeStamp: 1000, text: '第一行' }],
    },
    {
      name: '多时间戳行展开为多条',
      lrc: '[00:01.00][00:03.00]重复句',
      expected: [
        { timeStamp: 1000, text: '重复句' },
        { timeStamp: 3000, text: '重复句' },
      ],
    },
    { name: '小数毫秒 .5 → 500ms', lrc: '[00:00.5]半秒', expected: [{ timeStamp: 500, text: '半秒' }] },
    { name: '三位数分钟（长曲）', lrc: '[100:01.00]长曲', expected: [{ timeStamp: (100 * 60 + 1) * 1000, text: '长曲' }] },
    {
      name: '空文本行跳过',
      lrc: '[00:01.00]第一行\n[00:02.00]\n[00:03.00]第三行',
      expected: [
        { timeStamp: 1000, text: '第一行' },
        { timeStamp: 3000, text: '第三行' },
      ],
    },
    {
      name: 'CRLF 兼容',
      lrc: '[00:01.00]第一行\r\n[00:03.00]第二行',
      expected: [
        { timeStamp: 1000, text: '第一行' },
        { timeStamp: 3000, text: '第二行' },
      ],
    },
  ])('$name', ({ lrc, expected }) => {
    expect(parseLrcToSylt(lrc)).toEqual(expected)
  })
})

describe('tagMp3', () => {
  it('写 USLT/SYLT/APIC/文本帧并读回', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'mini.mp3'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-'))
    const dest = path.join(dir, 'out.mp3')
    fs.writeFileSync(dest, src)

    await tagMp3(dest, {
      title: '测试歌曲', artist: '歌手A / 歌手B', album: '专辑X',
      date: '2020-05-01', copyright: '', genre: '流行',
      lyrics: '[00:01.00]第一行\n[00:03.00]第二行',
      cover: Buffer.from('FAKEPNG', 'utf-8'), coverMime: 'image/png',
    })

    const tags = NodeID3.read(dest)
    expect(tags.title).toBe('测试歌曲')
    expect(tags.artist).toBe('歌手A / 歌手B')
    expect(tags.recordingTime).toBe('2020-05-01')
    const uslt = tags.unsynchronisedLyrics as any
    const usltText = Array.isArray(uslt) ? uslt.map((u: any) => u.text).join('\n') : uslt?.text ?? String(uslt ?? '')
    expect(usltText).toContain('第一行')
    expect((tags.image as any)?.imageBuffer).toBeTruthy()

    const sylt = (tags.raw as any).SYLT as Array<{
      language: string
      synchronisedText: Array<{ text: string; timeStamp: number }>
    }>
    expect(sylt).toHaveLength(1)
    expect(sylt[0].synchronisedText).toHaveLength(2)
    expect(sylt[0].synchronisedText[0]).toEqual({ text: '第一行', timeStamp: 1000 })
    expect(sylt[0].synchronisedText[1]).toEqual({ text: '第二行', timeStamp: 3000 })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('无歌词/无封面时只写文本帧', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'mini.mp3'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag2-'))
    const dest = path.join(dir, 'out.mp3')
    fs.writeFileSync(dest, src)
    await tagMp3(dest, { title: 'T', artist: 'A', album: 'AL', date: '', copyright: '', genre: '', lyrics: '', cover: undefined })
    const tags = NodeID3.read(dest)
    expect(tags.title).toBe('T')
    expect(tags.unsynchronisedLyrics).toBeFalsy()
    expect(tags.image).toBeFalsy()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// 0.7.0 专辑封装：track/disc 只在「整张下载」时传入。平铺下载不传 → TRCK/TPOS 一帧都不许出现，
// 否则现有产物不再与 0.6.1 逐字节一致（spec §5.6）。
describe('tagMp3 track/disc（TRCK / TPOS）', () => {
  const flat: Parameters<typeof tagMp3>[1] = {
    title: 'T', artist: 'A', album: 'AL', date: '', copyright: '', genre: '', lyrics: '', cover: undefined,
  }

  const onFixture = async (meta: Parameters<typeof tagMp3>[1], check: (file: string) => Promise<void>): Promise<void> => {
    const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'mini.mp3'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-track-'))
    const dest = path.join(dir, 'out.mp3')
    fs.writeFileSync(dest, src)
    try {
      await tagMp3(dest, meta)
      await check(dest)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // 帧表（按帧 id 取原始值）：TRCK/TPOS 在不在只能看这里
  const rawFrames = (file: string): Record<string, unknown> => (NodeID3.read(file).raw ?? {}) as Record<string, unknown>

  it('track/disc 写入后读回 3/13 与 1/2（TRCK / TPOS）', async () => {
    await onFixture({ ...flat, track: 3, trackTotal: 13, disc: 1, discTotal: 2 }, async (dest) => {
      const md = await parseFile(dest)
      expect(md.common.track?.no).toBe(3)
      expect(md.common.track?.of).toBe(13)
      expect(md.common.disk?.no).toBe(1)
      expect(md.common.disk?.of).toBe(2)
      // 帧内容断言成「序号/总数」串：node-id3 0.2.9 的 trackNumber/partOfSet 只接受字符串，
      // 传 { position, total } 这类对象会被 convertValue 静默丢帧（2026-10-07 探针：写完 raw.TRCK 直接不存在，
      // 而 write() 仍返回 true），所以这里断言落到文件里的字节而不是传进去的形参。
      expect(rawFrames(dest).TRCK).toBe('3/13')
      expect(rawFrames(dest).TPOS).toBe('1/2')
    })
  })

  it('总数缺省 → TRCK 只写「3」，不写尾随斜杠「3/」', async () => {
    // ID3 规范允许 TRCK 只有序号；「3/」的空总数段是半截值，播放器按串显示就露出「3/」。
    // 缺总数不值得为此产出一个畸形帧。
    await onFixture({ ...flat, track: 3, disc: 1 }, async (dest) => {
      expect(rawFrames(dest).TRCK).toBe('3')
      expect(rawFrames(dest).TPOS).toBe('1')
      const md = await parseFile(dest)
      expect(md.common.track?.no).toBe(3)
      expect(md.common.track?.of).toBeNull()
      expect(md.common.disk?.no).toBe(1)
      expect(md.common.disk?.of).toBeNull()
    })
  })

  it('反锚：不传 track/disc 时 TRCK/TPOS 帧完全不出现（平铺下载行为不变）', async () => {
    await onFixture(flat, async (dest) => {
      expect(rawFrames(dest).TRCK).toBeUndefined()
      expect(rawFrames(dest).TPOS).toBeUndefined()
      const md = await parseFile(dest)
      const ids = Object.values(md.native).reduce<string[]>((acc, list) => acc.concat(list.map((f) => f.id)), [])
      // 不能用 common.track 判存在与否：music-metadata 没有 TRCK 帧时也给 {no: null, of: null}
      //（2026-10-07 实测），断言它 undefined 会把「读回接口形状」误当成「帧存在」。
      expect(ids).not.toContain('TRCK')
      expect(ids).not.toContain('TPOS')
    })
  })

  it('反锚：只给 disc 不凭空造 TRCK，只给 track 不凭空造 TPOS', async () => {
    await onFixture({ ...flat, disc: 2, discTotal: 2 }, async (dest) => {
      expect(rawFrames(dest).TRCK).toBeUndefined()
      expect(rawFrames(dest).TPOS).toBe('2/2')
    })
    await onFixture({ ...flat, track: 5 }, async (dest) => {
      expect(rawFrames(dest).TRCK).toBe('5')
      expect(rawFrames(dest).TPOS).toBeUndefined()
    })
  })

  it('track/disc 与歌词/封面/日期共存，互不覆盖', async () => {
    await onFixture({
      ...flat,
      date: '2019-05-20', genre: '流行',
      lyrics: '[00:01.00]第一行\n[00:03.00]第二行',
      cover: Buffer.from('FAKEPNG', 'utf-8'), coverMime: 'image/png',
      track: 4, trackTotal: 12, disc: 1, discTotal: 1,
    }, async (dest) => {
      const tags = NodeID3.read(dest)
      expect(tags.recordingTime).toBe('2019-05-20')
      expect((tags.image as any)?.imageBuffer).toBeTruthy()
      const uslt = tags.unsynchronisedLyrics as any
      const text = Array.isArray(uslt) ? uslt.map((u: any) => u.text).join('\n') : uslt?.text ?? ''
      expect(text).toContain('第一行')
      expect(rawFrames(dest).TRCK).toBe('4/12')
      expect(rawFrames(dest).TPOS).toBe('1/1')
    })
  })
})