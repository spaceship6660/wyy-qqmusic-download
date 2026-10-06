import NodeID3 from 'node-id3'
import type { TagMeta } from './types'

interface SyncLine { timeStamp: number; text: string }

/** 解析 LRC 行 → SYLT 条目（时间戳 ms）。非 LRC 行（无时间戳）忽略。 */
export function parseLrcToSylt(lrc: string): SyncLine[] {
  const out: SyncLine[] = []
  const re = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
  for (const line of lrc.split('\n')) {
    const timestamps = [...line.matchAll(re)]
    if (timestamps.length === 0) continue
    const text = line.replace(re, '').trim()
    if (text === '') continue
    for (const m of timestamps) {
      const mm = Number(m[1]), ss = Number(m[2])
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0
      out.push({ timeStamp: (mm * 60 + ss) * 1000 + frac, text })
    }
  }
  return out
}

export async function tagMp3(path: string, meta: TagMeta): Promise<void> {
  const frames: any = {
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    genre: meta.genre,
  }
  if (meta.date) frames.recordingTime = meta.date        // ID3v2.4 TDRC 录制时间（node-id3 原生映射）
  if (meta.copyright) frames.copyright = meta.copyright
  // TRCK / TPOS 与 recordingTime 同理，node-id3 的文本帧只收字符串「序号/总数」。
  // 传 { position, total } / { numberOfParts, totalNumberOfParts } 对象会被 convertValue 判成非字符串
  // 而静默丢帧，write() 却仍返回 true（2026-10-07 探针：写完 raw.TRCK 不存在）——等于整张专辑白打序号。
  // 总数缺省时只写序号本身（"3"）而不写 "3/"：空的总数段是畸形帧，比少一个总数更糟。
  if (meta.track !== undefined) {
    frames.trackNumber = meta.trackTotal !== undefined ? `${meta.track}/${meta.trackTotal}` : `${meta.track}`
  }
  if (meta.disc !== undefined) {
    frames.partOfSet = meta.discTotal !== undefined ? `${meta.disc}/${meta.discTotal}` : `${meta.disc}`
  }
  if (meta.cover && meta.coverMime) {
    frames.image = {
      mime: meta.coverMime,
      type: { id: 3, name: 'cover (front)' },
      description: '',
      imageBuffer: meta.cover,
    }
  }
  if (meta.lyrics) {
    frames.unsynchronisedLyrics = { language: 'XXX', text: meta.lyrics }
    const sylt = parseLrcToSylt(meta.lyrics)
    if (sylt.length > 0) {
      frames.synchronisedLyrics = {
        language: 'XXX',
        timeStampFormat: 2,
        contentType: 0,
        synchronisedText: sylt.map((s) => ({ timeStamp: s.timeStamp, text: s.text })),
      }
    }
  }
  const ok = NodeID3.write(frames, path)
  // node-id3 0.2.9 write 失败时返回 Error 对象（不是 false），须按 !== true 判定
  if (ok !== true) throw ok instanceof Error ? ok : new Error('MP3 标签写入失败')
}