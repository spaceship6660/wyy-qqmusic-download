import fs from 'node:fs'
import path from 'node:path'
import type { Quality } from './qqapi/tracks'

export type DlIdentity = 'account' | 'anon'

export interface Settings {
  quality: Quality
  concurrency: number       // 界面提供 1-4；载入/设置统一收敛到 1-8
  downloadDir: string
  lyricMode: 'both' | 'embed' | 'lrc' | 'none'
  decryptOutDir: string     // P2 解密用，先留默认
  ffmpegPath: string        // '' 表示未配置
  /** 下载身份（仅下载直链用哪套凭证；歌单浏览仍用登录态）。
   * 背景：个别账号登录态反而拿不到直链（权益/风控），匿名却可以——两边都可单独切换。 */
  qqIdentity: DlIdentity
  neIdentity: DlIdentity
}

const QUALITIES: readonly Quality[] = ['flac', 'ape', '320', '128', 'm4a']
const LYRIC_MODES: readonly Settings['lyricMode'][] = ['both', 'embed', 'lrc', 'none']
const IDENTITIES: readonly DlIdentity[] = ['account', 'anon']

/** 单字段校验工具（供 loadSettings / settingsSet 共用，防越界枚举让下游 QUALITY_MAP[q] 崩） */
export function isValidQuality(q: unknown): q is Quality {
  return typeof q === 'string' && (QUALITIES as readonly string[]).includes(q)
}
export function isValidLyricMode(m: unknown): m is Settings['lyricMode'] {
  return typeof m === 'string' && (LYRIC_MODES as readonly string[]).includes(m)
}
export function isValidIdentity(v: unknown): v is DlIdentity {
  return typeof v === 'string' && (IDENTITIES as readonly string[]).includes(v)
}
export function clampConcurrency(n: unknown, fallback: number): number {
  const v = Math.floor(Number(n))
  return Number.isFinite(v) ? Math.min(8, Math.max(1, v)) : fallback
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
    const merged = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) } as Settings
    // 校验/收敛：concurrency 为 0/负数/非数会让队列永不调度；目录非字符串/空串会让 path.join/mkdir 抛错；
    // quality 等枚举越界会让 QUALITY_MAP[q] 取到 undefined 直接崩 runner。损坏字段一律回退默认。
    return {
      ...merged,
      concurrency: clampConcurrency(merged.concurrency, DEFAULT_SETTINGS.concurrency),
      quality: isValidQuality(merged.quality) ? merged.quality : DEFAULT_SETTINGS.quality,
      lyricMode: isValidLyricMode(merged.lyricMode) ? merged.lyricMode : DEFAULT_SETTINGS.lyricMode,
      qqIdentity: isValidIdentity(merged.qqIdentity) ? merged.qqIdentity : DEFAULT_SETTINGS.qqIdentity,
      neIdentity: isValidIdentity(merged.neIdentity) ? merged.neIdentity : DEFAULT_SETTINGS.neIdentity,
      downloadDir: typeof merged.downloadDir === 'string' && merged.downloadDir.trim() ? merged.downloadDir : DEFAULT_SETTINGS.downloadDir,
      decryptOutDir: typeof merged.decryptOutDir === 'string' && merged.decryptOutDir.trim() ? merged.decryptOutDir : DEFAULT_SETTINGS.decryptOutDir,
      ffmpegPath: typeof merged.ffmpegPath === 'string' ? merged.ffmpegPath : DEFAULT_SETTINGS.ffmpegPath,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(file: string, s: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 原子写：临时文件 + rename，崩溃时不留半截 JSON（否则读回静默回退默认值、丢配置）
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}