// QQ 音乐登录（ptlogin2 扫码五步 + cookie JSON 持久化 + 手动导入 + 状态查询）
// 移植自 Spica: agent_tools/function_tools/song/qqmusic.py（qr_login() 285-511 行，
// hash33 107-112 行，save_login/load_login/clear_login 251-265 行）。
// 凭证文件属敏感数据：不入库、不打印。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { QqClient } from './qqapi/client'

export interface QrSession { qrDataUrl: string } // data:image/png;base64,...
export type QrPollStatus = 'waiting' | 'scanned' | 'success' | 'expired' | 'rejected'
export type AuthState = 'anonymous' | 'waiting' | 'loggedIn' | 'failed'
export interface AuthStatus { state: AuthState; uin?: string; error?: string }
export interface AuthCookie { uin: string; cookie: string }

export interface AuthOptions {
  qqClient: QqClient       // createQqClient 产物；登录成功后调 qqClient.setAuth({uin, cookie})
  fetchImpl?: typeof fetch // 默认全局 fetch；测试注入
  cookiePath: string
}

export type AuthResult = { ok: true; cookie: AuthCookie } | { ok: false; reason: string }

export interface Auth {
  startQr(): Promise<QrSession>
  poll(): Promise<QrPollStatus>
  waitForResult(timeoutMs: number): Promise<AuthResult>
  importCookie(cookieHeader: string): boolean
  getStatus(): AuthStatus
  clear(): void
}

// --- 端点/常量（参考自 Spica qqmusic.py:63-80） ---
const QR_SHOW_URL = 'https://ssl.ptlogin2.qq.com/ptqrshow'
const QR_LOGIN_URL = 'https://ssl.ptlogin2.qq.com/ptqrlogin'
const CHECK_SIG_URL = 'https://ssl.ptlogin2.graph.qq.com/check_sig'
const AUTHORIZE_URL = 'https://graph.qq.com/oauth2.0/authorize'
const LOGIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' // Spica _LOGIN_UA
const XUI_REFERER = 'https://xui.ptlogin2.qq.com/'
const APPID = '716027609' // Spica _APPID
const DAID = '383' // Spica _DAID
const CLIENT_ID = '100497308' // Spica _PT_3RD_AID；authorize client_id 同值
const REDIRECT_URI =
  'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/' // Spica _REDIRECT_URI

const POLL_INTERVAL_MS = 500
// 登录四端点单请求超时（同 client.ts 惯例用 AbortSignal.timeout；30s）。
// waitForResult 的 deadline 只是「轮询假超时」——网络黑洞（请求永不返回）时
// 靠这里的真超时中止 fetch，避免挂起。
const LOGIN_TIMEOUT_MS = 30000
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** hash33（参考自 Spica qqmusic.py:107-112）。两种调用：hash33(text) 与 hash33(text, seed)。 */
export function hash33(text: string, seed = 0): number {
  let value = seed
  for (const ch of text) value += (value << 5) + ch.charCodeAt(0)
  return 2147483647 & value
}

/**
 * 解析 ptuiCB('code','msg','url')（参考自 Spica qqmusic.py:372-379）。
 * 优先引号段解析：msg 含逗号时 split(',') 会让后续参数错位、success URL 被截断
 * （真实登录会失败），引号段按单引号切分则不受逗号影响。
 */
export function parsePtui(text: string): { code: number; msg: string; url: string } | null {
  const wrapped = text.match(/^ptuiCB\((.*)\)\s*;?\s*$/)
  if (wrapped) {
    const segments = wrapped[1].match(/'([^']*)'/g) ?? []
    const args = segments.map((s) => s.slice(1, -1))
    const code = Number(args[0])
    if (Number.isNaN(code)) return null
    return { code, msg: args[1] ?? '', url: args[2] ?? '' }
  }
  // 裸形式兜底（无 ptuiCB 包裹，如 '66,二维码未失效。'）：split(',') 局限——
  // msg 含逗号时仍会错位（args[1] 截断、URL 丢失），仅作兼容层。
  const args = text.split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
  const code = Number(args[0])
  if (Number.isNaN(code)) return null
  return { code, msg: args[1] ?? '', url: args[2] ?? '' }
}

export function createAuth(options: AuthOptions): Auth {
  const { qqClient, cookiePath } = options
  const fetchImpl = options.fetchImpl ?? fetch

  let qrsig = ''
  // 跨请求累积的 Cookie（对应 Spica 的 http.cookiejar：qrsig / skey / p_skey 等）
  let cookieJar = ''
  // ptqrlogin 返回 0 成功时的第三段 URL（参考自 Spica qqmusic.py:390）
  let checkSigUrl = ''
  let sessionState: AuthState = readCookieFile() ? 'loggedIn' : 'anonymous'
  let lastError = ''

  function getCookie(name: string): string {
    for (const part of cookieJar.split(';')) {
      const p = part.trim()
      if (!p) continue
      const eq = p.indexOf('=')
      if (eq > 0 && p.slice(0, eq) === name) return p.slice(eq + 1)
    }
    return ''
  }

  function mergeSetCookies(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(';')[0].trim()
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq)
      const kept = cookieJar
        .split(';')
        .map((p) => p.trim())
        .filter((p) => p && !p.startsWith(name + '='))
      kept.push(pair)
      cookieJar = kept.join('; ')
    }
  }

  async function startQr(): Promise<QrSession> {
    // 1) 出二维码（参考自 Spica qqmusic.py:304-331）：GET ptqrshow，响应体 = PNG 字节，
    //    qrsig 从 Set-Cookie 取；返回 base64 data URL。
    const params = new URLSearchParams({
      appid: APPID,
      e: '2',
      l: 'M',
      s: '3',
      d: '72',
      v: '4',
      t: String(Math.random()),
      daid: DAID,
      pt_3rd_aid: CLIENT_ID,
    })
    const res = await fetchImpl(`${QR_SHOW_URL}?${params.toString()}`, {
      headers: { 'user-agent': LOGIN_UA, referer: XUI_REFERER },
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    })
    const qrsigCookie = res.headers
      .getSetCookie()
      .find((c) => c.split(';')[0].trim().startsWith('qrsig='))
    if (!qrsigCookie) throw new Error('获取 QQ 登录二维码失败（缺少 qrsig）')
    qrsig = qrsigCookie.split(';')[0].trim().slice('qrsig='.length)
    cookieJar = `qrsig=${qrsig}`
    checkSigUrl = ''
    lastError = ''
    sessionState = 'waiting'
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { qrDataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` }
  }

  async function poll(): Promise<QrPollStatus> {
    // 2) 轮询扫码状态（参考自 Spica qqmusic.py:333-388）。状态码语义：
    //    66 等待扫码 / 67 已扫待确认 / 0 成功（第三段 = check_sig URL）/ 65 失效 / 68 拒绝
    // 会话守卫：只有 waiting 才可轮询；loggedIn/failed/anonymous 全部禁止，
    // 防止终态后拿已消费的陈旧 qrsig 再打 ptqrlogin（65/68 会把有效登录态遮成 failed）。
    if (sessionState !== 'waiting') throw new Error('当前无进行中的扫码会话')
    const params = new URLSearchParams({
      u1: 'https://graph.qq.com/oauth2.0/login_jump',
      ptqrtoken: String(hash33(qrsig)),
      ptredirect: '0',
      h: '1',
      t: '1',
      g: '1',
      from_ui: '1',
      ptlang: '2052',
      action: `0-0-${Date.now()}`,
      js_ver: '20102616',
      js_type: '1',
      pt_uistyle: '40',
      aid: APPID,
      daid: DAID,
      pt_3rd_aid: CLIENT_ID,
      has_onekey: '1',
    })
    const res = await fetchImpl(`${QR_LOGIN_URL}?${params.toString()}`, {
      headers: { 'user-agent': LOGIN_UA, referer: XUI_REFERER, cookie: cookieJar },
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    })
    mergeSetCookies(res)
    const parsed = parsePtui(await res.text())
    if (!parsed) throw new Error('无法解析 QQ 登录状态响应。')
    switch (parsed.code) {
      case 66:
        sessionState = 'waiting'
        return 'waiting'
      case 67:
        sessionState = 'waiting'
        return 'scanned'
      case 0:
        // 保持 waiting（终态由 finishLogin 在 check_sig→authorize→QQLogin 完成后设置）
        checkSigUrl = parsed.url
        return 'success'
      case 65:
        sessionState = 'failed'
        lastError = '二维码已失效，请重新扫码'
        qrsig = '' // 终态：qrsig 作废，防再次轮询
        return 'expired'
      case 68:
        sessionState = 'failed'
        lastError = '用户拒绝了扫码登录'
        qrsig = '' // 终态：qrsig 作废，防再次轮询
        return 'rejected'
      default:
        throw new Error(`QQ 扫码登录失败（状态码 ${parsed.code}）。`)
    }
  }

  async function waitForResult(timeoutMs: number): Promise<AuthResult> {
    // 3) 500ms 间隔轮询直到非 waiting/scanned 或超时（参考自 Spica qqmusic.py:357-388）
    // 会话守卫：state 必须 waiting（无会话 / 终态 loggedIn·failed 一律抛错，不空转假超时）
    if (sessionState !== 'waiting') throw new Error('当前无进行中的扫码会话')
    const deadline = Date.now() + Math.max(0, timeoutMs)
    try {
      while (true) {
        const status = await poll()
        if (status === 'success') return finishLogin() // finishLogin 内部收敛到 loggedIn/failed 终态
        if (status === 'expired') return fail('二维码已失效，请重新扫码')
        if (status === 'rejected') return fail('用户拒绝了扫码登录')
        if (Date.now() >= deadline) return fail('扫码登录超时，请重新扫码')
        await sleep(POLL_INTERVAL_MS)
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }

  async function finishLogin(): Promise<AuthResult> {
    // 成/败都收敛到 terminal 态（loggedIn/failed）并作废 qrsig——UI 拿到结果后
    // poll()/waitForResult() 的会话守卫会抛错，不会再拿已消费的 qrsig 打 ptqrlogin
    try {
      // 从 ptqrlogin 成功 URL 提取 uin/ptsigx（参考自 Spica qqmusic.py:390-396）
      const sigx = checkSigUrl.match(/ptsigx=([^&]+)/)
      const uinMatch = checkSigUrl.match(/uin=(\d+)/)
      if (!sigx || !uinMatch) return fail('登录成功但缺少鉴权参数')

      // 4) check_sig 换 p_skey（参考自 Spica qqmusic.py:398-433）；禁跟随重定向，
      //    p_skey 从响应 Set-Cookie 取
      const checkParams = new URLSearchParams({
        uin: uinMatch[1],
        pttype: '1',
        service: 'ptqrlogin',
        nodirect: '0',
        ptsigx: sigx[1],
        s_url: 'https://graph.qq.com/oauth2.0/login_jump',
        ptlang: '2052',
        ptredirect: '100',
        aid: APPID,
        daid: DAID,
        j_later: '0',
        low_login_hour: '0',
        regmaster: '0',
        pt_login_type: '3',
        pt_aid: '0',
        pt_aaid: '16',
        pt_light: '0',
        pt_3rd_aid: CLIENT_ID,
      })
      const checkRes = await fetchImpl(`${CHECK_SIG_URL}?${checkParams.toString()}`, {
        headers: { 'user-agent': LOGIN_UA, referer: XUI_REFERER, cookie: cookieJar },
        redirect: 'manual',
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      })
      await checkRes.arrayBuffer() // 消费响应体
      mergeSetCookies(checkRes)
      const pSkey = getCookie('p_skey')
      if (!pSkey) return fail('QQ 登录获取 p_skey 失败')

      // 5) OAuth authorize 换 code（参考自 Spica qqmusic.py:435-470）；
      //    g_tk = hash33(p_skey, 5381)，client_id 与 pt_3rd_aid 同值
      const authData = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: 'get_user_info,get_app_friends',
        state: 'state',
        switch: '',
        from_ptlogin: '1',
        src: '1',
        update_auth: '1',
        openapi: '1010_1030',
        g_tk: String(hash33(pSkey, 5381)),
        auth_time: String(Date.now()),
        ui: randomUUID(),
      })
      const authRes = await fetchImpl(AUTHORIZE_URL, {
        method: 'POST',
        body: authData.toString(),
        headers: {
          'user-agent': LOGIN_UA,
          'content-type': 'application/x-www-form-urlencoded',
          cookie: cookieJar,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      })
      // code 在重定向 Location 里（Spica 从 resp.geturl()/Location 取）
      const location = authRes.headers.get('location') ?? (checkRes.headers.get('location') ?? '')
      const codeMatch = location.match(/(?:code=)(.+?)(?:&|$)/)
      if (!codeMatch) return fail('QQ 登录换取授权 code 失败')

      // 6) QQLogin 换 musicid/musickey（参考自 Spica qqmusic.py:472-507），走 client.postMusicu；
      //    comm 与 Spica 一致（g_tk 固定 5381），匿名登录
      const req = (await qqClient.postMusicu(
        {
          req: {
            module: 'QQConnectLogin.LoginServer',
            method: 'QQLogin',
            param: { code: codeMatch[1] },
          },
        },
        {
          path: ['req'],
          comm: {
            uin: '0',
            ct: 24,
            cv: 4747474,
            platform: 'yqq.json',
            chid: '0',
            g_tk: 5381,
            g_tk_new_20200303: 5381,
            inCharset: 'utf-8',
            outCharset: 'utf-8',
            notice: 0,
            need_new_code: 1,
            tmeLoginType: 2,
          },
        },
      )) as { code?: unknown; data?: Record<string, unknown> } | undefined
      if (!req || Number(req.code ?? 0) !== 0) {
        return fail(`QQ 登录换取播放凭证失败（code=${String(req?.code ?? 0)}）`)
      }
      const credential = req.data ?? {}
      const musicid = String(credential.musicid ?? '')
      const musickey = String(credential.musickey ?? '')
      if (!musicid || !musickey) return fail('QQ 登录成功但未取到播放凭证')

      // 7) 拼 cookie + 落盘 + setAuth（参考自 Spica qqmusic.py:508-511）
      const cookie =
        `uin=o${musicid}; qqmusic_uin=o${musicid}; qm_keyst=${musickey}; qqmusic_key=${musickey}`
      const authCookie: AuthCookie = { uin: `o${musicid}`, cookie }
      persist(authCookie)
      qqClient.setAuth(authCookie)
      qrsig = '' // 终态：qrsig 作废，防再次轮询
      sessionState = 'loggedIn'
      lastError = ''
      return { ok: true, cookie: authCookie }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }

  function importCookie(cookieHeader: string): boolean {
    // 手动导入浏览器 Cookie 头（参考 Spica 持久化格式：uin=o..; qqmusic_uin=o..; qm_keyst=..; qqmusic_key=..）。
    // 必须含 uin 与 qqmusic_key 才成功；o 前缀归一化（uin/qqmusic_uin 同步）。
    const parts = cookieHeader.split(';').map((p) => p.trim()).filter(Boolean)
    const find = (name: string): string | undefined => {
      const p = parts.find((x) => x.toLowerCase().startsWith(`${name.toLowerCase()}=`))
      return p ? p.slice(name.length + 1).trim() : undefined
    }
    const uinRaw = find('uin')
    const key = find('qqmusic_key')
    const digits = (uinRaw ?? '').replace(/^o/i, '')
    if (!uinRaw || !key || !/^\d+$/.test(digits)) return false
    const uin = `o${digits}`
    const cookie = cookieHeader.replace(
      /(^|;\s*)(qqmusic_uin|uin)=o?\d+/gi,
      (_m, sep: string, name: string) => `${sep}${name.toLowerCase()}=${uin}`,
    )
    const authCookie: AuthCookie = { uin, cookie }
    persist(authCookie)
    qqClient.setAuth(authCookie)
    // 导入成功即进入 loggedIn 终态：清掉扫码会话变量（含 qrsig），防止陈旧 qrsig 翻转状态机
    resetSession()
    sessionState = 'loggedIn'
    return true
  }

  function getStatus(): AuthStatus {
    if (sessionState === 'waiting') return { state: 'waiting' }
    if (sessionState === 'failed') return { state: 'failed', error: lastError }
    const saved = readCookieFile()
    if (saved) return { state: 'loggedIn', uin: saved.uin }
    return { state: 'anonymous' }
  }

  function clear(): void {
    // 参考 Spica clear_login（qqmusic.py:261-265）：删文件（不存在忽略），匿名化
    try {
      fs.rmSync(cookiePath, { force: true })
    } catch {
      // 删除失败忽略，不影响匿名化
    }
    qqClient.setAuth({ uin: '0' })
    // 清掉扫码会话变量（qrsig/cookieJar/checkSigUrl/lastError），state → anonymous
    resetSession()
    sessionState = 'anonymous'
  }

  /** 重置扫码会话变量（登录流中间态）。终态（loggedIn/failed）或新会话（startQr/importCookie）时调用。 */
  function resetSession(): void {
    qrsig = ''
    cookieJar = ''
    checkSigUrl = ''
    lastError = ''
  }

  /** 参考 Spica save_login（qqmusic.py:251-258）：JSON { uin, cookie } 落盘 */
  function persist(c: AuthCookie): void {
    fs.mkdirSync(path.dirname(cookiePath), { recursive: true })
    fs.writeFileSync(cookiePath, JSON.stringify(c), 'utf-8')
  }

  /** 参考 Spica load_login（qqmusic.py:235-248）：损坏/缺字段按匿名，不抛 */
  function readCookieFile(): AuthCookie | null {
    try {
      if (!fs.existsSync(cookiePath)) return null
      const data = JSON.parse(fs.readFileSync(cookiePath, 'utf-8')) as Record<string, unknown>
      const uin = typeof data.uin === 'string' ? data.uin.trim() : ''
      const cookie = typeof data.cookie === 'string' ? data.cookie.trim() : ''
      if (!uin || !cookie) return null
      return { uin, cookie }
    } catch {
      return null
    }
  }

  function fail(reason: string): { ok: false; reason: string } {
    sessionState = 'failed'
    lastError = reason
    qrsig = '' // 终态：qrsig 作废，防再次轮询
    return { ok: false, reason }
  }

  return { startQr, poll, waitForResult, importCookie, getStatus, clear }
}