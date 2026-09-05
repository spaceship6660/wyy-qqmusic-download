import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import NodeID3 from 'node-id3'
import { tagFile } from '../src/main/tagger'

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', n))

describe('tagFile 分发', () => {
  it('.mp3 走 mp3 写入', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgi-'))
    const dest = path.join(dir, 'a.mp3')
    fs.writeFileSync(dest, fixture('mini.mp3'))
    await tagFile(dest, { title: 'T', artist: 'A', album: 'AL', date: '', copyright: '', genre: '', lyrics: '[00:01.00]hi', cover: undefined })
    const tags = NodeID3.read(dest)
    expect(tags.title).toBe('T')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('.flac 交给 tagFlac（非 FLAC 内容报错）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgi2-'))
    const dest = path.join(dir, 'b.flac')
    fs.writeFileSync(dest, Buffer.from('fLaC' + '0'.repeat(500)))
    await expect(tagFile(dest, { title: 'T', artist: 'A', album: 'AL', date: '', copyright: '', genre: '', lyrics: '', cover: undefined }))
      .rejects.toThrow()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('未知扩展名报错', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgi3-'))
    const dest = path.join(dir, 'c.wav')
    fs.writeFileSync(dest, Buffer.alloc(10))
    await expect(tagFile(dest, { title: 'T', artist: 'A', album: '', date: '', copyright: '', genre: '', lyrics: '', cover: undefined }))
      .rejects.toThrow(/不支持/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('saveLrc=true 时另存同名 .lrc', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgi4-'))
    const dest = path.join(dir, 'd.mp3')
    fs.writeFileSync(dest, fixture('mini.mp3'))
    await tagFile(dest, { title: 'T', artist: 'A', album: '', date: '', copyright: '', genre: '', lyrics: '[00:01.00]hi' }, { saveLrc: true })
    expect(fs.readFileSync(path.join(dir, 'd.lrc'), 'utf-8')).toContain('[00:01.00]')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})