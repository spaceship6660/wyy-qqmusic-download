import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import NodeID3 from 'node-id3'
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