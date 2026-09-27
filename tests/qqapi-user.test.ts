import { describe, it, expect, vi } from 'vitest'
import { createQqClient, QqApiError } from '../src/main/qqapi/client'
import { getLoginUserInfo, isQqLoginExpired, QQ_LOGIN_EXPIRED_CODES } from '../src/main/qqapi/user'

// 凭证校验（music.UserInfo.userInfoServer / GetLoginUserInfo）：
// 这是「会话是否失效」的权威判据 —— 业务接口（GetPlaylistByUin 等）走 EncryptUin，
// 密钥失效后仍能通，不能用来判过期（2026-09-27 实机故障根因）。

/** 按 body.req.method 路由；返回指定 payload，并记录请求体与 cookie 头 */
function mockFetch(payload: unknown, status = 200) {
  const bodies: any[] = []
  const cookies: string[] = []
  const f = vi.fn(async (_input: any, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    cookies.push((init?.headers as Record<string, string>)?.['cookie'] ?? '')
    return new Response(JSON.stringify(payload), { status })
  }) as unknown as typeof fetch
  return { f, bodies, cookies }
}

describe('getLoginUserInfo（凭证校验）', () => {
  it('code=0 → 返回 data，且请求带上 module/method 与登录 cookie', async () => {
    const { f, bodies, cookies } = mockFetch({ code: 0, req: { code: 0, data: { nickname: 'n' } } })
    const client = createQqClient(f, { uin: 'o123', cookie: 'qqmusic_key=k' })
    const data = await getLoginUserInfo(client)
    expect(data).toEqual({ nickname: 'n' })
    expect(bodies[0].req.module).toBe('music.UserInfo.userInfoServer')
    expect(bodies[0].req.method).toBe('GetLoginUserInfo')
    expect(bodies[0].comm.uin).toBe('o123')
    expect(cookies[0]).toContain('qqmusic_key=k')
  })

  it.each([1000, 104400, 104401])('业务码 %i → 抛 QqApiError 且判定为「登录已过期」', async (code) => {
    const { f } = mockFetch({ code: 0, req: { code } })
    const client = createQqClient(f, { uin: '123', cookie: 'qqmusic_key=k' })
    await expect(getLoginUserInfo(client)).rejects.toBeInstanceOf(QqApiError)
    try {
      await getLoginUserInfo(client)
    } catch (e) {
      expect((e as QqApiError).code).toBe(code)
      expect(isQqLoginExpired(e)).toBe(true)
    }
  })

  it('其它业务码（非过期）→ 抛错但不判过期', async () => {
    const { f } = mockFetch({ code: 0, req: { code: 20277 } }) // 账号受限，非凭证过期
    const client = createQqClient(f, { uin: '123', cookie: 'qqmusic_key=k' })
    try {
      await getLoginUserInfo(client)
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as QqApiError).code).toBe(20277)
      expect(isQqLoginExpired(e)).toBe(false)
    }
  })

  it('响应缺 req 节点 → path-missing，且不判过期（判不了就不误报）', async () => {
    const { f } = mockFetch({ code: 0 })
    const client = createQqClient(f, { uin: '123', cookie: 'qqmusic_key=k' })
    try {
      await getLoginUserInfo(client)
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(QqApiError)
      expect((e as QqApiError).code).toBe('path-missing')
      expect(isQqLoginExpired(e)).toBe(false)
    }
  })
})

describe('isQqLoginExpired', () => {
  it('非 QqApiError / 无 code / code 为字符串等边界一律 false', () => {
    expect(isQqLoginExpired(new Error('x'))).toBe(false)
    expect(isQqLoginExpired(new QqApiError('x'))).toBe(false)
    expect(isQqLoginExpired(new QqApiError('x', '1000'))).toBe(false)
    expect(isQqLoginExpired(undefined)).toBe(false)
    expect(isQqLoginExpired(new QqApiError('x', 1000))).toBe(true)
  })

  it('过期码集合即参考实现的 LoginAuthExpiredError 三码', () => {
    expect([...QQ_LOGIN_EXPIRED_CODES]).toEqual([1000, 104400, 104401])
  })
})
