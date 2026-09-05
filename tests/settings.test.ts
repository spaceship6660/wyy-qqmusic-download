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
})