import { describe, it, expect } from 'vitest'
import { safeName, uniquePath } from '../src/main/fsUtils'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('safeName', () => {
  it('替换非法字符并截断 100 字符', () => {
    expect(safeName('A/B:C*D?E"F<G>H|I')).toBe('A-B-C-D-E-F-G-H-I')
    expect(safeName('x'.repeat(120)).length).toBeLessThanOrEqual(100)
    expect(safeName('   ')).toBe('untitled')
    expect(safeName('')).toBe('untitled')
  })
})

describe('uniquePath', () => {
  it('已存在时加 (n) 后缀', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsu-'))
    const a = path.join(dir, 'a.mp3')
    fs.writeFileSync(a, 'x')
    expect(uniquePath(a)).toBe(path.join(dir, 'a(1).mp3'))
    fs.writeFileSync(path.join(dir, 'a(1).mp3'), 'x')
    expect(uniquePath(a)).toBe(path.join(dir, 'a(2).mp3'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
})