import fs from 'node:fs'
import path from 'node:path'

export interface NeAuthCookie { cookie: string }
/** sessionExpired：cookie 文件存在但服务端已不认（会话失效）。
 *  由 app.ts 依据 neAccount 探测结果注入，供渲染侧把「已登录」改显示为「登录已失效」。 */
export interface NeAuthStatus { loggedIn: boolean; sessionExpired?: boolean }
export interface NeAuth {
  /** 持久化 cookie（完整 Cookie 头）；空串表示未登录 */
  getCookie(): string
  getStatus(): NeAuthStatus
  importCookie(header: string): boolean
  saveCookie(header: string): void
  clear(): void
}

export function buildCookieHeader(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

export function cookieHeaderHasMusicU(header: string): boolean {
  return header.split(';').some((p) => p.trim().startsWith('MUSIC_U='))
}

/** 登录态语义判据（对 account 探测结果做判定）。
 *  ⚠️ 不能只看「cookie 文件在不在」：旧 cookie 过期后文件仍在，界面会一直显示「已登录」，
 *  而所有需要鉴权的接口都在静默失败——这正是「登录掉了却显示正常」的根因。
 *  权威判据是 /api/nuser/account/get 是否回带 profile.userId（实测：无 cookie / 无效 cookie
 *  一律 code=200 但 profile 为空，故 profile.userId 的有无即等价于凭证有效性）。 */
export function neLoggedInFromAccount(acc: { uid?: number } | null | undefined): boolean {
  return !!acc?.uid
}

export function createNeAuth(opts: { cookiePath: string }): NeAuth {
  const read = (): NeAuthCookie | null => {
    try {
      const raw = JSON.parse(fs.readFileSync(opts.cookiePath, 'utf-8'))
      if (raw && typeof raw.cookie === 'string' && cookieHeaderHasMusicU(raw.cookie)) return raw
      return null
    } catch {
      return null
    }
  }
  const write = (cookie: string): void => {
    fs.mkdirSync(path.dirname(opts.cookiePath), { recursive: true })
    // 原子写：临时文件 + rename（避免崩溃留下半截 JSON 被当未登录）
    const tmp = `${opts.cookiePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ cookie }, null, 2), 'utf-8')
    fs.renameSync(tmp, opts.cookiePath)
  }

  return {
    getCookie() { return read()?.cookie ?? '' },
    getStatus() { return { loggedIn: read() !== null } },
    importCookie(header) {
      if (!cookieHeaderHasMusicU(header)) return false
      write(header)
      return true
    },
    saveCookie(header) { write(header) },
    clear() { fs.rmSync(opts.cookiePath, { force: true }) },
  }
}