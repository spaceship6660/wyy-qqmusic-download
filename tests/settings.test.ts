import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSettings, saveSettings, DEFAULT_SETTINGS, Settings } from '../src/main/settings'

describe('settings', () => {
  it('缺文件时给默认值；保存后可读回', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'))
    const file = path.join(dir, 'settings.json')
    const s1 = loadSettings(file)
    expect(s1.quality).toBe(DEFAULT_SETTINGS.quality)
    s1.quality = 'flac'
    saveSettings(file, s1)
    const s2 = loadSettings(file)
    expect(s2.quality).toBe('flac')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('损坏文件回退默认值', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st2-'))
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, 'not-json{{{')
    const s = loadSettings(file)
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('下载身份默认账户；旧文件缺字段时补默认；保存后可读回', async () => {
    expect(DEFAULT_SETTINGS.qqIdentity).toBe('account')
    expect(DEFAULT_SETTINGS.neIdentity).toBe('account')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st3-'))
    const file = path.join(dir, 'settings.json')
    // 旧版文件（无身份字段）→ 读出补默认
    fs.writeFileSync(file, JSON.stringify({ quality: 'flac' }), 'utf-8')
    expect(loadSettings(file).neIdentity).toBe('account')
    // 改匿名 → 落盘 → 读回
    const s = loadSettings(file)
    s.neIdentity = 'anon'
    s.qqIdentity = 'anon'
    saveSettings(file, s)
    const s2 = loadSettings(file)
    expect(s2.neIdentity).toBe('anon')
    expect(s2.qqIdentity).toBe('anon')
    expect(s2.quality).toBe('flac')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})