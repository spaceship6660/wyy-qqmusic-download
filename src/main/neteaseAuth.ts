import fs from 'node:fs'
import path from 'node:path'

export interface NeAuthCookie { cookie: string }
export interface NeAuthStatus { loggedIn: boolean }
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
    fs.writeFileSync(opts.cookiePath, JSON.stringify({ cookie }, null, 2), 'utf-8')
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