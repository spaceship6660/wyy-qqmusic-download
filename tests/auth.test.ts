import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// 注入式 fetch：与 client.ts 同风格，auth.ts 用注入的 fetchImpl，测试替换为路由 mock
import { createAuth } from '../src/main/auth'
import { createQqClient } from '../src/main/qqapi/client'

// 独立的参考实现（不 import auth.ts 的 hash33，避免实现自我背书）
function h33(text: string, seed = 0): number {
  let v = seed
  for (const ch of text) v += (v << 5) + ch.charCodeAt(0)
  return 2147483647 & v
}

interface MockSeq {
  png?: Uint8Array
  /** ptqrlogin 响应文本序列；下标超出时重复最后一个 */
  login: (idx: number) => string
  checkSigLocation?: string
  authorizeLocation?: string
  /** musicu.fcg 的 QQConnectLogin.LoginServer 响应 JSON */
  qqLogin?: unknown
  requestLog?: { url: string; init?: RequestInit }[]
}

/** 单 fetchMock 按 URL/请求体路由：ptqrshow/ptqrlogin/check_sig/authorize 裸 GET + musicu POST 按 module */
function routerFetch(seq: MockSeq): typeof fetch {
  let loginIdx = 0
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    seq.requestLog?.push({ url, init })
    let u: URL
    try {
      u = new URL(url)
    } catch {
      u = new URL('https://mock.invalid/')
    }
    const pathname = u.pathname
    if (pathname === '/ptqrshow') {
      // TS 5.8 下 Uint8Array<ArrayBufferLike> 不能直接赋给 BodyInit，显式断言
      return new Response((seq.png ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47])) as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'image/png', 'set-cookie': 'qrsig=abc123; Path=/' },
      })
    }
    if (pathname === '/ptqrlogin') {
      return new Response(seq.login(loginIdx++), { status: 200 })
    }
    if (pathname === '/check_sig') {
      // QQ 真实响应为 302，同时 Set-Cookie 下 p_skey
      return new Response('', {
        status: 302,
        headers: {
          location: seq.checkSigLocation ?? 'https://graph.qq.com/oauth2.0/login_jump',
          'set-cookie': 'p_skey=PSKEY123; Path=/',
        },
      })
    }
    if (pathname === '/oauth2.0/authorize') {
      return new Response('', { status: 302, headers: { location: seq.authorizeLocation ?? '' } })
    }
    if (pathname.includes('musicu.fcg')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        req?: { module?: string; method?: string; param?: { code?: string } }
      }
      if (body.req?.module === 'QQConnectLogin.LoginServer') {
        return new Response(JSON.stringify(seq.qqLogin ?? {}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`auth 测试 mock 未覆盖的请求: ${url}`)
  }) as unknown as typeof fetch
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createAuth', () => {
  it('完整扫码成功流：出码→66→67→0→check_sig→authorize→QQLogin→落盘+setAuth', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-ok-'))
    const log: { url: string; init?: RequestInit }[] = []
    const loginMsgs = [
      "ptuiCB('66','二维码未失效。','')",
      "ptuiCB('67','二维码认证中。','')",
      "ptuiCB('0','登录成功！','https://ssl.ptlogin2.qq.com/check_sig?ptqrtoken=K&skey=XYZ&uin=9876&ptsigx=SIGAB')",
    ]
    const fetchMock = routerFetch({
      png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      login: (i) => loginMsgs[Math.min(i, loginMsgs.length - 1)],
      authorizeLocation:
        'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F&code=AUTHCODE123&state=state',
      qqLogin: { req: { code: 0, data: { musicid: 9876, musickey: 'KEY123' } } },
      requestLog: log,
    })
    const client = createQqClient(fetchMock, { uin: '0' })
    const auth = createAuth({ qqClient: client, fetchImpl: fetchMock, cookiePath: path.join(dir, 'cookie.json') })

    // 出码：PNG base64 data URL + 进入 waiting
    const qr = await auth.startQr()
    expect(qr.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(auth.getStatus()).toEqual({ state: 'waiting' })

    // 轮询状态语义：66→waiting、67→scanned
    expect(await auth.poll()).toBe('waiting')
    expect(await auth.poll()).toBe('scanned')

    const result = await auth.waitForResult(5000)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expect ok')
    expect(result.cookie.uin).toBe('o9876')
    expect(result.cookie.cookie).toContain('qqmusic_key=KEY123')
    expect(auth.getStatus()).toEqual({ state: 'loggedIn', uin: 'o9876' })

    // 落盘格式 {"uin":"o9876","cookie":"完整 Cookie 头"}（参考 Spica save_login）
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'cookie.json'), 'utf-8'))
    expect(saved.uin).toBe('o9876')
    expect(saved.cookie).toBe('uin=o9876; qqmusic_uin=o9876; qm_keyst=KEY123; qqmusic_key=KEY123')

    // check_sig 请求带 ptlogin2 提取的 uin/ptsigx（参考 Spica:390-396 => 398-420）
    const checkSigCall = log.find((c) => {
      try { return new URL(c.url).pathname === '/check_sig' } catch { return false }
    })
    expect(String(checkSigCall?.url)).toContain('uin=9876')
    expect(String(checkSigCall?.url)).toContain('ptsigx=SIGAB')
    expect(String(checkSigCall?.url)).toContain('service=ptqrlogin')

    // authorize：client_id + g_tk=hash33(p_skey, 5381)（参考 Spica:436-452）
    const authCall = log.find((c) => {
      try { return new URL(c.url).pathname === '/oauth2.0/authorize' } catch { return false }
    })
    const authBody = String(authCall?.init?.body)
    expect(authCall?.init?.method).toBe('POST')
    expect(authBody).toContain('client_id=100497308')
    expect(authBody).toContain('response_type=code')
    expect(authBody).toContain('g_tk=' + h33('PSKEY123', 5381))

    // QQLogin 走 client.postMusicu：module/method/code（参考 Spica:491-495）
    const qqLoginCall = log.find((c) => {
      try { return new URL(c.url).pathname.includes('musicu.fcg') } catch { return false }
    })
    const musicuBody = JSON.parse(String(qqLoginCall?.init?.body))
    expect(musicuBody.req.module).toBe('QQConnectLogin.LoginServer')
    expect(musicuBody.req.method).toBe('QQLogin')
    expect(musicuBody.req.param.code).toBe('AUTHCODE123')

    // setAuth 生效：同一 client 再 postMusicu 的请求头已带上登录 cookie
    await client.postMusicu({ req: { module: 'x', method: 'y', param: {} } }, { path: [] })
    const post = log[log.length - 1]
    expect((post.init?.headers as Record<string, string>)['cookie']).toContain('qqmusic_key=KEY123')

    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('手动导入成功：→ true、loggedIn、落盘', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-imp-'))
    const cookiePath = path.join(dir, 'cookie.json')
    // 不会发起任何网络请求（login mock 永远 66 兜底）
    const fetchMock = routerFetch({ login: () => "ptuiCB('66','二维码未失效。','')" })
    const client = createQqClient(fetchMock, { uin: '0' })
    const auth = createAuth({ qqClient: client, fetchImpl: fetchMock, cookiePath })

    expect(auth.importCookie('uin=o123; qqmusic_uin=o123; qm_keyst=q; qqmusic_key=k')).toBe(true)
    expect(auth.getStatus()).toEqual({ state: 'loggedIn', uin: 'o123' })
    const saved = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'))
    expect(saved.uin).toBe('o123')
    expect(saved.cookie).toContain('qqmusic_key=k')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('o 前缀归一化：裸 QQ 号导入后 uin/qqmusic_uin 同步加 o', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-norm-'))
    const cookiePath = path.join(dir, 'cookie.json')
    const fetchMock = routerFetch({ login: () => "ptuiCB('66','x','')" })
    const client = createQqClient(fetchMock, { uin: '0' })
    const auth = createAuth({ qqClient: client, fetchImpl: fetchMock, cookiePath })

    expect(auth.importCookie('uin=123456; qqmusic_uin=123456; qm_keyst=q; qqmusic_key=k')).toBe(true)
    expect(auth.getStatus().uin).toBe('o123456')
    const saved = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'))
    expect(saved.uin).toBe('o123456')
    expect(saved.cookie).toContain('uin=o123456; qqmusic_uin=o123456')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('导入格式错误：→ false、anonymous、不落盘', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-bad-'))
    const cookiePath = path.join(dir, 'cookie.json')
    const fetchMock = routerFetch({ login: () => "ptuiCB('66','x','')" })
    const client = createQqClient(fetchMock, { uin: '0' })
    const auth = createAuth({ qqClient: client, fetchImpl: fetchMock, cookiePath })

    expect(auth.importCookie('foo=bar')).toBe(false)                    // 缺 uin/qqmusic_key
    expect(auth.importCookie('uin=o123; qm_keyst=q')).toBe(false)      // 缺 qqmusic_key
    expect(auth.importCookie('uin=oabc; qqmusic_key=k')).toBe(false)   // uin 非数字
    expect(auth.getStatus()).toEqual({ state: 'anonymous' })
    expect(fs.existsSync(cookiePath)).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('轮询超时：一直 66，waitForResult(1500) → ok:false 含超时、状态 failed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-tmo-'))
    const fetchMock = routerFetch({ login: () => "ptuiCB('66','二维码未失效。','')" })
    const client = createQqClient(fetchMock, { uin: '0' })
    const auth = createAuth({ qqClient: client, fetchImpl: fetchMock, cookiePath: path.join(dir, 'cookie.json') })

    await auth.startQr()
    const result = await auth.waitForResult(1500)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/超时/)
    expect(auth.getStatus()).toMatchObject({ state: 'failed' })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('二维码失效：65 → ok:false 含失效、状态 failed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-exp-'))
    const fetchMock = routerFetch({ login: () => "ptuiCB('65','二维码已失效。','')" })
    const client = createQqClient(fetchMock, { uin: '0' })
    const auth = createAuth({ qqClient: client, fetchImpl: fetchMock, cookiePath: path.join(dir, 'cookie.json') })

    await auth.startQr()
    expect(await auth.poll()).toBe('expired')
    expect(auth.getStatus().state).toBe('failed')
    const result = await auth.waitForResult(5000)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/失效/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('损坏的 cookie 文件容错：→ anonymous，不抛', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-crp-'))
    const cookiePath = path.join(dir, 'cookie.json')
    fs.writeFileSync(cookiePath, '{{{ 不是 JSON')
    const fetchMock = routerFetch({ login: () => "ptuiCB('66','x','')" })
    const client = createQqClient(fetchMock, { uin: '0' })
    const auth = createAuth({ qqClient: client, fetchImpl: fetchMock, cookiePath })

    expect(() => auth.getStatus()).not.toThrow()
    expect(auth.getStatus()).toEqual({ state: 'anonymous' })

    // 字段缺失/为空的 JSON 同样按匿名
    fs.writeFileSync(cookiePath, '{"uin":""}')
    expect(auth.getStatus()).toEqual({ state: 'anonymous' })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('clear()：删文件并回到匿名，client 不再携带 cookie', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-clr-'))
    const cookiePath = path.join(dir, 'cookie.json')
    const fetchMock = routerFetch({ login: () => "ptuiCB('66','x','')" })
    const client = createQqClient(fetchMock, { uin: '0' })
    const auth = createAuth({ qqClient: client, fetchImpl: fetchMock, cookiePath })

    expect(auth.importCookie('uin=o123; qqmusic_uin=o123; qm_keyst=q; qqmusic_key=k')).toBe(true)
    expect(fs.existsSync(cookiePath)).toBe(true)

    auth.clear()
    expect(fs.existsSync(cookiePath)).toBe(false)
    expect(auth.getStatus()).toEqual({ state: 'anonymous' })

    await client.postMusicu({ req: { module: 'x', method: 'y', param: {} } }, { path: [] })
    // 本测试唯一的 fetch 调用就是这次 postMusicu：登录态清除后请求头不再带 cookie
    // （as any 与 qqapi-client.test.ts 同风格：routerFetch 返回类型被收窄为 typeof fetch）
    const [url, init] = (fetchMock as any).mock.calls[0]
    expect(String(url)).toContain('musicu.fcg')
    expect(((init as RequestInit).headers as Record<string, string>)['cookie']).toBeUndefined()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})