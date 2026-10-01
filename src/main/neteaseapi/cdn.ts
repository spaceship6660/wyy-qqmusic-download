/** 网易云直链 CDN 节点归一化（2026-10-01 实机故障的固化修复）。
 *
 * 实测事实（同曲同 br，唯一变量是请求是否带 cookie）：
 * - 账号态直链被分配到 `m704/m804.music.126.net` 且查询串带 `authSecret` 时，该节点**恒定 403**：
 *   裸 fetch / 带 UA+Referer / 带 cookie 全 403，http 与 https 相同，**重取直链仍是同一节点**
 *   （所以「下载失败就重取直链」对这类故障完全无效）。
 * - **同一串 URL（路径与查询串一字不改）只把 host 换成 m701/m801/m802，立即 HTTP 206**，
 *   内容正确（无损 magic=`fLaC`、320 档 magic=`ID3\x04`）。
 * ⇒ 403 是**CDN 节点级拒收**，不是签名失效、不是权益问题、更不是会员过期。
 *
 * 后果与对策：匿名直链（无 authSecret）本就落在可用节点，所以旧逻辑「403 就改匿名重下」看起来
 * 总能成功，却把真实原因掩盖成「账号不行」——每首都显示「已切匿名下载」，且因匿名拿不到无损
 * （实测匿名请求 br=999000 也只回 320k）而顺带降级。故下载遇 403 应先做**节点归一化重试**，
 * 保住账号身份与无损档；全部节点失败才走匿名兜底。
 *
 * 节点表可覆盖（`createApp({ neCdnFallbackUrls })`）：网易云会轮换节点，留出不改码的口子。 */

/** 备用 CDN 节点（按实测可用性排序）。2026-10-01 实测三者对 authSecret 直链均返回 206。 */
export const NE_CDN_NODES: readonly string[] = [
  'm701.music.126.net',
  'm801.music.126.net',
  'm802.music.126.net',
]

/** 是否网易云 CDN 节点主机名（`mNNN.music.126.net`）。注意用 host 精确匹配，
 * `m804.music.126.net.evil.com` 之类必须判 false。 */
export function isNeteaseCdnUrl(url: string): boolean {
  try {
    return /^m\d+\.music\.126\.net$/i.test(new URL(url).host)
  } catch {
    return false
  }
}

/** 同 URL 换 host 的候选直链（保留 path 与 query——`authSecret` 等签名参数原样带过去）。
 * 排除当前节点本身；非绝对 URL 或非网易云 CDN 主机名一律回空（不猜、不乱换域）。 */
export function cdnFallbackUrls(url: string, nodes: readonly string[] = NE_CDN_NODES): string[] {
  if (!isNeteaseCdnUrl(url)) return []
  const current = new URL(url)
  const out: string[] = []
  for (const node of nodes) {
    if (node.toLowerCase() === current.host.toLowerCase()) continue
    const alt = new URL(url)
    alt.host = node
    out.push(alt.toString())
  }
  return out
}
