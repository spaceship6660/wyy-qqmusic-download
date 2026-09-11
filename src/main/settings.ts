import fs from 'node:fs'
import path from 'node:path'
import type { Quality } from './qqapi/tracks'

export type DlIdentity = 'account' | 'anon'

export interface Settings {
  quality: Quality
  concurrency: number       // 1-4（999 表示不限由 Renderer 转成 8）
  downloadDir: string
  lyricMode: 'both' | 'embed' | 'lrc' | 'none'
  decryptOutDir: string     // P2 解密用，先留默认
  ffmpegPath: string        // '' 表示未配置
  /** 下载身份（仅下载直链用哪套凭证；歌单浏览仍用登录态）。
   * 背景：个别账号登录态反而拿不到直链（权益/风控），匿名却可以——两边都可单独切换。 */
  qqIdentity: DlIdentity
  neIdentity: DlIdentity
}

export const DEFAULT_SETTINGS: Settings = {
  quality: '320',
  concurrency: 2,
  downloadDir: 'downloads',
  lyricMode: 'both',
  decryptOutDir: 'decrypted',
  ffmpegPath: '',
  qqIdentity: 'account',
  neIdentity: 'account',
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