import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNeAuth, buildCookieHeader, cookieHeaderHasMusicU } from '../src/main/neteaseAuth'

describe('buildCookieHeader', () => {
  it('cookies 数组拼成 Cookie 头', () => {
    const h = buildCookieHeader([
      { name: 'MUSIC_U', value: 'abc' },
      { name: '__csrf', value: 'c' },
    ])
    expect(h).toBe('MUSIC_U=abc; __csrf=c')
  })
})

describe('cookieHeaderHasMusicU', () => {
  it('含 MUSIC_U 判定登录态', () => {
    expect(cookieHeaderHasMusicU('MUSIC_U=abc; x=1')).toBe(true)
    expect(cookieHeaderHasMusicU('__csrf=1')).toBe(false)
  })
})

describe('createNeAuth', () => {
  it('importCookie 需含 MUSIC_U；成功落盘且状态 loggedIn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nea-'))
    const file = path.join(dir, 'net_cookie.json')
    const auth = createNeAuth({ cookiePath: file })
    expect(auth.importCookie('__csrf=z')).toBe(false)
    expect(auth.getStatus().loggedIn).toBe(false)
    expect(auth.importCookie('MUSIC_U=abc; __csrf=z')).toBe(true)
    expect(auth.getStatus().loggedIn).toBe(true)
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(saved.cookie).toContain('MUSIC_U=abc')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('损坏文件容错按未登录；clear 删除文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nea2-'))
    const file = path.join(dir, 'net_cookie.json')
    fs.writeFileSync(file, 'broken{{{')
    const auth = createNeAuth({ cookiePath: file })
    expect(auth.getStatus().loggedIn).toBe(false)
    auth.importCookie('MUSIC_U=1')
    expect(fs.existsSync(file)).toBe(true)
    auth.clear()
    expect(auth.getStatus().loggedIn).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})