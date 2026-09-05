import fs from 'node:fs'
import path from 'node:path'
import { tagMp3 } from './mp3'
import { tagFlac } from './vorbis'
import type { TagMeta } from './types'

export interface TagOptions { saveLrc: boolean }

/** 按扩展名分发；.lrc 与音频同目录同名（UTF-8） */
export async function tagFile(filePath: string, meta: TagMeta, opts: TagOptions = { saveLrc: false }): Promise<void> {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.mp3') await tagMp3(filePath, meta)
  else if (ext === '.flac') await tagFlac(filePath, meta)
  else throw new Error(`暂不支持标签写入的容器：${ext}`)

  if (opts.saveLrc && meta.lyrics) {
    const lrcPath = filePath.slice(0, -ext.length) + '.lrc'
    await fs.promises.writeFile(lrcPath, meta.lyrics, 'utf-8')
  }
}