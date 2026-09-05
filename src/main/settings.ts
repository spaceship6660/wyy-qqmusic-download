import fs from 'node:fs'
import path from 'node:path'
import type { Quality } from './qqapi/tracks'

export interface Settings {
  quality: Quality
  concurrency: number       // 1-4（999 表示不限由 Renderer 转成 8）
  downloadDir: string
  lyricMode: 'both' | 'embed' | 'lrc' | 'none'
  decryptOutDir: string     // P2 解密用，先留默认
  ffmpegPath: string        // '' 表示未配置
}

export const DEFAULT_SETTINGS: Settings = {
  quality: '320',
  concurrency: 2,
  downloadDir: 'downloads',
  lyricMode: 'both',
  decryptOutDir: 'decrypted',
  ffmpegPath: '',
}

export function loadSettings(file: string): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return { ...DEFAULT_SETTINGS, ...raw }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(file: string, s: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(s, null, 2), 'utf-8')
}