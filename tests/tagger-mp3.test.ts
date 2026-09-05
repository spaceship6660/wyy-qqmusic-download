import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import NodeID3 from 'node-id3'
import { tagMp3 } from '../src/main/tagger/mp3'

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
    expect((tags.raw as any).SYLT).toBeTruthy()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('无歌词时只写封面与文本帧', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'mini.mp3'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag2-'))
    const dest = path.join(dir, 'out.mp3')
    fs.writeFileSync(dest, src)
    await tagMp3(dest, { title: 'T', artist: 'A', album: 'AL', date: '', copyright: '', genre: '', lyrics: '', cover: undefined })
    const tags = NodeID3.read(dest)
    expect(tags.title).toBe('T')
    expect(tags.unsynchronisedLyrics).toBeFalsy()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})