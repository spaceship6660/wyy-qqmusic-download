import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseFile } from 'music-metadata'
import { tagFlac, parseVorbisCommentBlock } from '../src/main/tagger/vorbis'

// 辅助：遍历 FLAC 元数据块头，返回首个指定 type 的块数据（不含 4 字节块头）；找不到返回 undefined
async function readBlockData(file: string, type: number): Promise<Buffer | undefined> {
  const buf = await fs.promises.readFile(file)
  let off = 4
  while (off + 4 <= buf.length) {
    const h = buf.readUInt32BE(off)
    const t = (h >>> 24) & 0x7f
    const len = h & 0x00ffffff
    off += 4
    if (t === type) return buf.subarray(off, off + len)
    off += len
  }
  return undefined
}

// 辅助：直接读 FLAC 的 VORBIS_COMMENT 块解析成键值（不依赖 music-metadata 的字段映射，验证双键原文存在）
async function readVorbisRaw(file: string): Promise<Record<string, string>> {
  const block = await readBlockData(file, 4)
  return block ? parseVorbisCommentBlock(block) : {}
}

describe('tagFlac', () => {
  it('写入 LYRICS+UNSYNCEDLYRICS 双键与封面，可被 music-metadata 解析', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'mini.flac'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flac-'))
    const dest = path.join(dir, 'out.flac')
    fs.writeFileSync(dest, src)

    await tagFlac(dest, {
      title: '测试', artist: '歌手', album: '专辑', date: '2021-01-02', copyright: '', genre: '摇滚',
      lyrics: '第一行歌词', cover: Buffer.from('FAKEIMG', 'utf-8'), coverMime: 'image/png',
    })

    const md = await parseFile(dest)
    const tags = md.common
    expect(tags.title).toBe('测试')
    expect(tags.artist).toBe('歌手')
    expect(tags.album).toBe('专辑')
    expect(tags.date).toBe('2021-01-02')  // 若 music-metadata 读 date 行为不同，按实际读取字段修正断言（意图不变）
    expect(tags.picture?.length).toBe(1)
    const pic = tags.picture![0] as any
    expect(pic.format).toBe('image/png')
    expect(Buffer.from(pic.data).toString('utf-8')).toBe('FAKEIMG')
    // 双键：Vorbis comment 原始键都在
    const raw = await readVorbisRaw(dest)
    expect(raw.LYRICS).toBe('第一行歌词')
    expect(raw.UNSYNCEDLYRICS).toBe('第一行歌词')
    // 二进制结构：PICTURE 块数据严格等于 32 + mimeLen(9) + dataLen(7) = 48 字节，无尾零计入块长
    const picBuf = await readBlockData(dest, 6)
    expect(picBuf).toBeDefined()
    const picBlock = picBuf!
    expect(picBlock.length).toBe(48)                  // 旧实现把 4 个尾 NUL 算进块长（52），此断言杜绝回归
    expect(picBlock.readUInt32BE(0)).toBe(3)          // 数据段首 4 字节 = picture type 3（front cover）
    expect(picBlock.subarray(picBlock.length - 7).toString('utf-8')).toBe('FAKEIMG')  // 数据段末 7 字节 = 封面数据
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('无封面/无歌词时不写对应块', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'mini.flac'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flac2-'))
    const dest = path.join(dir, 'out.flac')
    fs.writeFileSync(dest, src)
    await tagFlac(dest, { title: 'T', artist: 'A', album: 'AL', date: '', copyright: '', genre: '', lyrics: '', cover: undefined })
    const md = await parseFile(dest)
    expect(md.common.title).toBe('T')
    expect(md.common.picture).toBeUndefined()
    // 无歌词：Vorbis comment 原始键不含 LYRICS/UNSYNCEDLYRICS
    const raw = await readVorbisRaw(dest)
    expect(raw.LYRICS).toBeUndefined()
    expect(raw.UNSYNCEDLYRICS).toBeUndefined()
    // 无封面：二进制层面遍历块头确认不存在 type-6（PICTURE）块
    expect(await readBlockData(dest, 6)).toBeUndefined()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})