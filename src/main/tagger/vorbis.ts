import fs from 'node:fs'
import type { TagMeta } from './types'

/** Vorbis comment 块编码（vendor + 计数 + 条目，全部 UTF-8；键大写） */
export function encodeVorbisComment(fields: Record<string, string>): Buffer {
  const vendor = Buffer.from('QQ Music Downloader', 'utf-8')
  const entries = Object.entries(fields).map(([k, v]) => {
    const key = Buffer.from(k.toUpperCase(), 'ascii')
    const val = Buffer.from(v, 'utf-8')
    const head = Buffer.alloc(4)
    head.writeUInt32LE(key.length + 1 + val.length, 0)
    return Buffer.concat([head, key, Buffer.from('=', 'ascii'), val])
  })
  const count = Buffer.alloc(4)
  count.writeUInt32LE(entries.length, 0)
  const vlen = Buffer.alloc(4)
  vlen.writeUInt32LE(vendor.length, 0)
  return Buffer.concat([vlen, vendor, count, ...entries])
}

/** 解析 VORBIS_COMMENT 块（块数据，不含 FLAC 块头）→ 键值（键原样大写保留） */
export function parseVorbisCommentBlock(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let off = 0
  const vlen = buf.readUInt32LE(off); off += 4 + vlen
  const count = buf.readUInt32LE(off); off += 4
  for (let i = 0; i < count; i++) {
    const len = buf.readUInt32LE(off); off += 4
    const entry = buf.subarray(off, off + len).toString('utf-8'); off += len
    const eq = entry.indexOf('=')
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return out
}

/**
 * FLAC METADATA_BLOCK_PICTURE（type 3 封面；宽高为 0 由播放器自适应）。
 * 布局（全部大端，严格顺序、无预分配头）：
 * type + mimeLen + mime + descLen + desc + width + height + depth + colors + dataLen + data
 * 总长 == 4+4+mimeLen+4+0+16+4+dataLen，无尾零计入
 */
export function encodePictureBlock(cover: Buffer, mime: string): Buffer {
  const mimeB = Buffer.from(mime, 'ascii')
  const desc = Buffer.alloc(0)
  const parts: Buffer[] = []
  const pushU32BE = (v: number): void => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(v, 0)
    parts.push(b)
  }
  pushU32BE(3)                    // picture type: cover (front)
  pushU32BE(mimeB.length)
  parts.push(mimeB)
  pushU32BE(desc.length)
  parts.push(desc)
  pushU32BE(0)                    // width
  pushU32BE(0)                    // height
  pushU32BE(0)                    // color depth
  pushU32BE(0)                    // colors used
  pushU32BE(cover.length)
  parts.push(cover)
  return Buffer.concat(parts)
}

const FLAC_MAGIC = 'fLaC'

/** FLAC：重写元数据块（STREAMINFO 保留首位，VORBIS_COMMENT(4)/PICTURE(6) 追加其后，其余块保留；last-block 标志正确落在最后一块） */
export async function tagFlac(path: string, meta: TagMeta): Promise<void> {
  const buf = await fs.promises.readFile(path)
  if (buf.toString('latin1', 0, 4) !== FLAC_MAGIC) throw new Error('不是 FLAC 文件')

  // 解析既有块
  const blocks: Array<{ type: number; data: Buffer }> = []
  let offset = 4
  let last = false
  while (!last && offset + 4 <= buf.length) {
    const header = buf.readUInt32BE(offset)
    const type = (header >>> 24) & 0x7f
    last = (header & 0x80000000) !== 0
    const len = header & 0x00ffffff
    offset += 4
    blocks.push({ type, data: buf.subarray(offset, offset + len) })
    offset += len
  }
  const audioStart = offset  // 音频帧从这里开始，原样保留

  // 组新字段
  const fields: Record<string, string> = {}
  if (meta.title) fields.TITLE = meta.title
  if (meta.artist) fields.ARTIST = meta.artist
  if (meta.album) fields.ALBUM = meta.album
  if (meta.date) fields.DATE = meta.date
  if (meta.copyright) fields.COPYRIGHT = meta.copyright
  if (meta.genre) fields.GENRE = meta.genre
  if (meta.lyrics) {
    fields.LYRICS = meta.lyrics
    fields.UNSYNCEDLYRICS = meta.lyrics
  }

  const comment = encodeVorbisComment(fields)
  const picture = meta.cover ? encodePictureBlock(meta.cover, meta.coverMime ?? 'image/jpeg') : null

  // 重组：fLaC + 既有块（STREAMINFO 必须首位）+ [VORBIS_COMMENT, PICTURE?]，last 在最后一块
  const out: Buffer[] = [buf.subarray(0, 4)]
  const appendBlock = (type: number, data: Buffer, isLast: boolean): void => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE((((type & 0x7f) << 24) | (isLast ? 0x80000000 : 0) | (data.length & 0x00ffffff)) >>> 0, 0)
    out.push(head, data)
  }
  let streamInfoSeen = false
  const rest = blocks.filter((b) => b.type !== 4 && b.type !== 6)
  for (const b of rest) {
    if (b.type === 0) { streamInfoSeen = true }
    appendBlock(b.type, b.data, false)
  }
  if (!streamInfoSeen) throw new Error('FLAC 缺少 STREAMINFO 块')
  appendBlock(4, comment, !picture)
  if (picture) appendBlock(6, picture, true)

  out.push(buf.subarray(audioStart))
  await fs.promises.writeFile(path, Buffer.concat(out))
}