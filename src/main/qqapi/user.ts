// QQ 音乐登录凭证校验（会话是否失效的权威判据）
//
// module/method：music.UserInfo.userInfoServer / GetLoginUserInfo
// 参考实现 luren-dc/QQMusicApi 的 LoginApi.check_expired 就是用它判过期的，
// 会话失效时返回业务码 1000 / 104400 / 104401（其错误体系里的 LoginAuthExpiredError）。
//
// 为什么不能用业务接口（GetPlaylistByUin / CgiGetDiss / 我喜欢的音乐）判过期：
// 那些接口靠 EncryptUin（账号标识，长期有效）鉴权，**会话密钥 qqmusic_key 失效后依然能通**，
// 于是会把「已过期」误判成「存活」——见 2026-09-27 实机故障：
// 绿钻账号下所有曲目（含免费曲）全档空 purl，界面却一直显示「已登录」、不给「重新登录」，
// 因为旧探活走的正是 GetPlaylistByUin。
import { QqApiError } from './client'
import type { QqClient } from './client'

/** 登录态失效错误码（LoginAuthExpiredError）：1000 / 104400 / 104401
 * （与 luren-dc/QQMusicApi `LoginApi._validate_result` 的 `case 1000 | 104401 | 104400` 一致；
 *  2026-09-27 用真实过期凭证实测本接口返回 req.code=1000，路径已验证。） */
export const QQ_LOGIN_EXPIRED_CODES: ReadonlyArray<number | string> = [1000, 104400, 104401]

/** 该错误是否表示「登录凭证已失效（需重新登录）」 */
export function isQqLoginExpired(e: unknown): boolean {
  if (!(e instanceof QqApiError)) return false
  const code = e.code
  if (code === undefined || code === null) return false
  return QQ_LOGIN_EXPIRED_CODES.some((c) => c === code)
}

/**
 * 取当前登录用户信息。凭证有效返回数据对象；失效抛 QqApiError（code 为服务端业务码，
 * 用 isQqLoginExpired 判定）。风控空响应等瞬时错误照常抛出，由调用方决定是否重试。
 *
 * 策略取舍：只有 1000/104400/104401 判「已过期」。其余非零业务码（账号受限 20277/20278、
 * 限频 104604 等）不判过期 —— 参考实现把「任何非零码」都当过期（check_expired 返回
 * code != 0），但那会把「账号受限」误导成「去重扫码」，故本实现保守处理，仅记诊断日志。
 */
export async function getLoginUserInfo(client: QqClient): Promise<unknown> {
  const res = (await client.postMusicu(
    {
      req: {
        module: 'music.UserInfo.userInfoServer',
        method: 'GetLoginUserInfo',
        param: {},
      },
    },
    { path: ['req'] },
  )) as { code?: number | string; data?: unknown } | undefined
  const code = res?.code
  if (code) throw new QqApiError(`GetLoginUserInfo 失败（code=${code}）`, code)
  return res?.data
}
