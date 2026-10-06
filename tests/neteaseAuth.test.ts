import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNeAuth, buildCookieHeader, cookieHeaderHasMusicU, neLoggedInFromAccount } from '../src/main/neteaseAuth'

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

describe('neLoggedInFromAccount（登录态语义判据）', () => {
  // 实测：/api/nuser/account/get 在「无 cookie」「无效 cookie」两种情形下都返回
  // code=200 但 profile 为空（无 userId）。因此 profile.userId 的有无即等价于凭证有效性。
  it('回带 uid → 登录有效', () => {
    expect(neLoggedInFromAccount({ uid: 8189022671 })).toBe(true)
  })

  it('profile 为空（无 cookie / 无效 cookie）→ 登录无效', () => {
    expect(neLoggedInFromAccount(null)).toBe(false)
    expect(neLoggedInFromAccount(undefined)).toBe(false)
    expect(neLoggedInFromAccount({})).toBe(false)
    expect(neLoggedInFromAccount({ uid: 0 })).toBe(false)
  })

  it('反锚：cookie 文件在但服务端确认不认 → 文件判据真、语义判据假', () => {
    // 锁本次 bug 根因：getStatus().loggedIn 只看文件存在，旧 cookie 过期后仍返回 true。
    // 语义判据必须拿服务端探测结果（null = 服务端不认）来推翻文件判据。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne3-'))
    const file = path.join(dir, 'net_cookie.json')
    const auth = createNeAuth({ cookiePath: file })
    auth.importCookie('MUSIC_U=EXPIRED_TOKEN; __csrf=z')
    expect(auth.getStatus().loggedIn).toBe(true)      // 文件判据：仍视为已登录（旧行为）
    expect(neLoggedInFromAccount(null)).toBe(false)   // 语义判据：服务端不认 → 必须为假
    fs.rmSync(dir, { recursive: true, force: true })
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