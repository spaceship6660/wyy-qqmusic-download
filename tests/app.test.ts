import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../src/main/app'
import type { App } from '../src/main/app'
import type { Quality, TrackDTO } from '../src/main/qqapi/tracks'
import type { AlbumBundle } from '../src/main/albumBundle'
import NodeID3 from 'node-id3'
import { parseFile } from 'music-metadata'

// 主进程装配（T10）集成测试：QQ API 全部 mock（按 URL/body 路由），
// 唯一真实网络 = 本地 http server 供 downloadFile 使用（downloadFile 走全局 fetch）。

const PAYLOAD = fs.readFileSync(path.join(__dirname, 'fixtures', 'mini.mp3')) // 合法 mini.mp3（tagMp3 可写）

function track(id: string, name = '同名', artist = '同歌手'): TrackDTO {
  return { id, name, artist, album: '专辑', cover: '', mediaMid: `MED${id}` }
}

/** 本地下载源：/gone* → 404，其余 → 200 + payload；可延迟响应以制造并发/碰撞窗口。
 * failFirst[path]=n：该路径前 n 次请求回 403（模拟账户直链被 CDN 拒收），之后正常。 */
async function startServer(delayMs = 0, failFirst: Record<string, number> = {}) {
  const recorded: string[] = []
  const counts = new Map<string, number>()
  const server = http.createServer((req, res) => {
    const p = (req.url ?? '').split('?')[0]
    recorded.push(req.url ?? '')
    counts.set(p, (counts.get(p) ?? 0) + 1)
    if (p.startsWith('/gone')) {
      res.writeHead(404)
      res.end()
      return
    }
    if ((counts.get(p) ?? 0) <= (failFirst[p] ?? 0)) {
      res.writeHead(403)
      res.end()
      return
    }
    const send = () => {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
      res.end(PAYLOAD)
    }
    if (delayMs > 0) setTimeout(send, delayMs)
    else send()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as any).port as number, recorded }
}

/**
 * QQ API mock：musicu.fcg 按 body.method 路由。
 * - CgiGetVkey：回显请求里的 filename 行（否则 getAudioUrl 会跳过），purl 按
 *   purls 顺序逐次取（第 N 次 vkey 请求用 purls[N]）；默认 purl = filename。
 * - get_song_detail_yqq：默认返回正常 track_info；detailBroken 时返回缺 data 的坏形状
 *   （postMusicu 路径缺失 → QqApiError）。
 * 另外路由网易云直链/歌词/详情接口（按 URL 区分，与 musicu.fcg 互不干扰；NE runner 集成用例用）。
 * 网易云直链按「请求 br + 是否挂 MUSIC_U」核发档位（匿名问无损也只回 320k，与线上实测一致），
 * 这样账户/匿名两次解析能给出不同档，降级与改道的落档回显才测得出来。
 */
function makeFetchImpl(opts: { port: number; purls?: string[]; detailBroken?: boolean; searchHits?: any[]; deadVkey?: boolean; neDeadUrl?: boolean; loginExpired?: boolean; detailSizes?: Record<string, number>; coverBytes?: Buffer }) {
  let vkeyCalls = 0
  // 该 mock「曲目」登记的档位：由 detailSizes 推出；未指定则视为全档存在（不影响既有用例）
  const tierOf = (fn: string): string | undefined =>
    ([['F000', 'flac'], ['A000', 'ape'], ['M800', '320'], ['M500', '128'], ['C400', 'm4a'], ['C200', 'm4a']] as const)
      .find(([p]) => fn.startsWith(p))?.[1]
  const tiersOfSizes = (s: Record<string, number>): string[] =>
    ([['size_flac', 'flac'], ['size_ape', 'ape'], ['size_320mp3', '320'], ['size_128mp3', '128'], ['size_96aac', 'm4a']] as const)
      .filter(([k]) => (s[k] ?? 0) > 0).map(([, t]) => t)
  const mock = vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('musicu.fcg')) {
      // 记录每次 musicu 请求的 cookie 头（下载身份用例：账户态带 cookie，匿名态不带）
      ;(mock as any).musicuCookies.push(
        (init?.headers as Record<string, string> | undefined)?.['cookie'] ?? '',
      )
    }
    if (url.includes('/api/song/enhance/player/url')) {
      // 网易云直链：本地 server 的 /ne.mp3（320 档直接命中，不触发降级）；
      // neDeadUrl 时回空 url（模拟会员/无版权拿不到直链）
      const dead = opts.neDeadUrl
      // 档位按「请求 br + 是否挂 MUSIC_U」核发（见 neteaseapi/cdn.ts 实测：匿名问 br=999000 也只回 320k），
      // 无损还走独立路径 /ne.flac —— 这样 R5 能把「账户那次解析的档」与「匿名改道后实际落档」分开，
      // 否则两次解析同档，finalQuality 断言会被账户那次写顺手满足（测不出「改道后必须覆写」）。
      const musicU = /(^|;)\s*MUSIC_U=/.test((init?.headers as Record<string, string> | undefined)?.['cookie'] ?? '')
      const lossless = !dead && musicU && /br=999000/.test(url)
      return new Response(JSON.stringify({
        code: 200,
        data: [{
          id: 123,
          url: dead ? null : `http://127.0.0.1:${opts.port}${lossless ? '/ne.flac' : '/ne.mp3'}`,
          br: lossless ? 1065126 : 320000,
          code: 200,
        }],
      }), { status: 200 })
    }
    if (url.includes('/api/song/lyric')) {
      return new Response(JSON.stringify({ lrc: { lyric: '[00:01.00]测试歌词' } }), { status: 200 })
    }
    if (url.includes('/api/song/detail')) {
      return new Response(JSON.stringify({ songs: [{ album: { publishTime: 1588262400000 } }] }), { status: 200 })
    }
    if (url.includes('/cover')) {
      // 专辑封面（Task 12 的 cover.jpg 也走同一个 fetchImpl）：给了字节就 200，没给就 404 ——
      // 「抓不到封面」与「没配封面 URL」是两条不同的跳过路径，都要能单独造出来。
      return opts.coverBytes
        ? new Response(new Uint8Array(opts.coverBytes), { status: 200 })
        : new Response('', { status: 404 })
    }
    if (url.includes('musicu.fcg')) {
      const body = JSON.parse(String(init?.body)) as any
      if (body.req_1?.method === 'CgiGetVkey') {
        const purls = opts.purls ?? []
        const purl = purls[Math.min(vkeyCalls, Math.max(0, purls.length - 1))] ?? ''
        vkeyCalls++
        const songmid = body.req_1?.param?.songmid?.[0] ?? 'M'
        const filenames: string[] = body.req_1?.param?.filename ?? ['M800X.mp3']
        // 忠实模拟真实服务端（2026-09-27 实测）：**只按候选首位核发直链**，首位档位不存在则整批回空。
        //   [M500(存在), F000(不存在)] → 命中 M500；[M800(不存在), M500(存在)] → 全空。
        // 旧 mock 给每个 filename 都回 purl，掩盖了「候选混入不存在的档位 → 整批失败」这一真实行为，
        // 导致「QQ 自动降级从未真正生效」长期未被测试发现。
        const trackTiers = opts.detailSizes ? tiersOfSizes(opts.detailSizes) : null
        const firstTier = tierOf(filenames[0] ?? '')
        const firstServable = !trackTiers || (firstTier !== undefined && trackTiers.includes(firstTier))
        return new Response(
          JSON.stringify({
            req_1: {
              code: 0,
              data: {
                sip: [`http://127.0.0.1:${opts.port}/`],
                midurlinfo: filenames.map((filename, i) => ({
                  songmid,
                  filename,
                  purl: (opts.deadVkey || i > 0 || !firstServable) ? '' : (purl || filename),
                })),
              },
            },
          }),
          { status: 200 },
        )
      }
      if (body.req_2?.method === 'GetPlayLyricInfo') {
        return new Response(
          JSON.stringify({ req_2: { data: { lyric: Buffer.from('[00:01.00]LRC行').toString('base64') } } }),
          { status: 200 },
        )
      }
      if (body.info?.method === 'get_song_detail_yqq') {
        if (opts.detailBroken) return new Response(JSON.stringify({ info: { code: 0 } }), { status: 200 })
        return new Response(
          JSON.stringify({
            info: {
              data: {
                track_info: {
                  mid: 'M', title: 'T', time_public: '2020-01-01',
                  singer: [{ name: 'X' }], album: { name: 'A' },
                  file: { media_mid: 'MED', ...(opts.detailSizes ?? {}) }, flags: {},
                },
              },
            },
          }),
          { status: 200 },
        )
      }
      if (body.req?.method === 'GetLoginUserInfo') {
        // 凭证校验探活：loginExpired 时回业务码 1000（等价 luren-dc LoginAuthExpiredError），
        // 否则回 code=0 表示会话有效（此时下载失败属「该曲无下载版权/权益」，不该报过期）
        const payload = opts.loginExpired
          ? { req: { code: 1000 } }
          : { req: { code: 0, data: { nickname: 'tester' } } }
        return new Response(JSON.stringify(payload), { status: 200 })
      }
      if (body.req?.method === 'DoSearchForQQMusicDesktop') {
        // 解密补全用的搜索命中（unlock 用例）
        return new Response(JSON.stringify({ req: { code: 0, data: { body: { song: { list: opts.searchHits ?? [] } } } } }), { status: 200 })
      }
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  ;(mock as any).musicuCookies = [] as string[]
  return mock as unknown as typeof fetch
}

interface Env {
  app: App
  dir: string     // userDataDir
  dl: string      // 下载目录
  server: http.Server
  recorded: string[]   // 下载源实际收到的路径
  debugLog?: string    // 仅当 makeEnv 传了 debugLogFile 时存在（断言诊断日志用）
  events: { start: number; done: number; failed: number; active: number; peak: number; donePaths: string[]; doneAnon: Array<boolean | undefined>; doneDowngraded: Array<boolean | undefined>; doneFinalQuality: Array<Quality | undefined>; failedErrors: string[]; startIds: string[]; failedIds: string[] }
  fetchMock: ReturnType<typeof vi.fn>
}

const envs: Env[] = []

afterEach(() => {
  for (const e of envs.splice(0)) {
    e.server.close()
    fs.rmSync(e.dir, { recursive: true, force: true })
  }
})

async function makeEnv(opts: { concurrency?: number; delayMs?: number; detailBroken?: boolean; purls?: string[]; lyricMode?: string; searchHits?: any[]; deadVkey?: boolean; failFirst?: Record<string, number>; neDeadUrl?: boolean; loginExpired?: boolean; detailSizes?: Record<string, number>; neCdnFallbackUrls?: (url: string) => string[]; coverBytes?: Buffer; debugLogFile?: boolean } = {}): Promise<Env> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-t10-'))
  const dl = path.join(dir, 'dl')
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ concurrency: opts.concurrency ?? 2, downloadDir: dl, lyricMode: opts.lyricMode ?? 'none' }),
  )
  const { server, port, recorded } = await startServer(opts.delayMs ?? 0, opts.failFirst ?? {})
  const fetchImpl = makeFetchImpl({ port, purls: opts.purls, detailBroken: opts.detailBroken, searchHits: opts.searchHits, deadVkey: opts.deadVkey, neDeadUrl: opts.neDeadUrl, loginExpired: opts.loginExpired, detailSizes: opts.detailSizes, coverBytes: opts.coverBytes })
  // 诊断日志：附属文件（cover/cue）写失败只进这里，不进事件流——要断言「失败没被吞掉」只能读文件
  const debugLog = opts.debugLogFile ? path.join(dir, 'dbg.log') : undefined
  const events = { start: 0, done: 0, failed: 0, active: 0, peak: 0, donePaths: [] as string[], doneAnon: [] as Array<boolean | undefined>, doneDowngraded: [] as Array<boolean | undefined>, doneFinalQuality: [] as Array<Quality | undefined>, failedErrors: [] as string[], startIds: [] as string[], failedIds: [] as string[] }
  const app = createApp({
    userDataDir: dir,
    fetchImpl,
    neCdnFallbackUrls: opts.neCdnFallbackUrls,
    debugLogFile: debugLog,
    emitEvent: (ch, payload) => {
      const p = payload as { id?: string; outputPath?: string; anonFallback?: boolean; downgraded?: boolean; finalQuality?: Quality; error?: string }
      if (ch === 'dl:jobStart') {
        events.start++
        events.active++
        events.peak = Math.max(events.peak, events.active)
        if (p.id) events.startIds.push(p.id)
      }
      if (ch === 'dl:done') {
        events.done++
        events.active--
        if (p.outputPath) events.donePaths.push(p.outputPath)
        events.doneAnon.push(p.anonFallback)
        events.doneDowngraded.push(p.downgraded)
        events.doneFinalQuality.push(p.finalQuality)
      }
      if (ch === 'dl:failed') {
        events.failed++
        events.active--
        if (p.error) events.failedErrors.push(p.error)
        if (p.id) events.failedIds.push(p.id)
      }
    },
  })
  const env: Env = { app, dir, dl, server, recorded, debugLog: debugLog, events, fetchMock: fetchImpl as unknown as ReturnType<typeof vi.fn> }
  envs.push(env)
  return env
}

/** 等条件成立。谓词允许异步，且求值过程中的异常按「还没满足」处理（下一轮再试）——
 *  附属文件是 jobDone **之后**异步补写的，轮询到「文件还没出现」那一轮时 readFileSync 必抛，
 *  那不该把用例判死；真正写漏的情况照样在 timeoutMs 后以「waitFor 超时」红给用户看。 */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const t0 = Date.now()
  while (true) {
    let ok = false
    try {
      ok = await cond()
    } catch {
      ok = false
    }
    if (ok) return
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('createApp runner 装配（T10 评审修复）', () => {
  it('C1: 并发同名任务 → dest 互不相同且文件完整，无 .part 残留', async () => {
    // 慢速下载源（~1.2s）：第二个任务启动时（限速器间隔 1s）第一个仍在写 .part，
    // 复现「check-then-write 撞同名 .part」场景；占位文件修复后二者各得其所。
    const env = await makeEnv({ delayMs: 1200 })
    env.app.enqueue({ tracks: [track('a', '歌', '手'), track('b', '歌', '手')], quality: '320', source: 'qq' })
    await waitFor(() => env.events.done >= 2)
    expect(env.events.failed).toBe(0)
    expect(env.events.donePaths.length).toBe(2)
    expect(new Set(env.events.donePaths).size).toBe(2) // dest 互不相同

    const files = fs.readdirSync(env.dl)
    expect(files.filter((f) => f.endsWith('.part'))).toEqual([]) // 无 .part 残留
    const mp3s = files.filter((f) => f.endsWith('.mp3'))
    expect(mp3s.length).toBe(2)
    // 完整性：两份下载+标签互逐字节一致（任一 .part 撞坏/半截都会不等），
    // 且标签已内嵌（下载文件经 tagFile 后附 ID3 帧，长度大于原始 payload）
    const bufs = mp3s.map((f) => fs.readFileSync(path.join(env.dl, f)))
    expect(bufs[0].equals(bufs[1])).toBe(true)
    expect(bufs[0].length).toBeGreaterThan(PAYLOAD.length)
    expect((NodeID3.read(path.join(env.dl, mp3s[0])) as any).title).toBe('歌')
    expect((NodeID3.read(path.join(env.dl, mp3s[1])) as any).title).toBe('歌')
  })

  it('I2: 404 直链 → 重取直链再下成功（404 不白等重试）', async () => {
    // 第一次 vkey 给出的直链 404，第二次 200；断言下载源恰好收到两次请求。
    // 重取那次故意给**更低一档**（purl 前缀 M500=128k）：两次解析不同档，才能证明 finalQuality
    // 记的是「留下文件的那次」，而不是首次解析顺手写上的值。
    const env = await makeEnv({ purls: ['gone.mp3', 'M500ok.mp3'] })
    env.app.enqueue({ tracks: [track('x', '直链歌')], quality: '320', source: 'qq' })
    await waitFor(() => env.events.done >= 1)
    expect(env.events.failed).toBe(0)
    expect(env.recorded).toEqual(['/gone.mp3', '/M500ok.mp3']) // 无 3 次×退避重试
    const files = fs.readdirSync(env.dl).filter((f) => f.endsWith('.mp3'))
    expect(files.length).toBe(1)
    const out = fs.readFileSync(path.join(env.dl, files[0]))
    expect(out.length).toBeGreaterThan(PAYLOAD.length) // 下载成功并经标签内嵌
    expect((NodeID3.read(path.join(env.dl, files[0])) as any).title).toBe('直链歌')
    // 落盘的是重取拿到的 128k，回显就必须是 128：重取那次也得覆写，否则徽标显示首次解析的 320（虚高）
    expect(env.events.doneFinalQuality).toEqual(['128'])
  })

  it('I2b: 重取直链后落回用户所选档 → downgraded 必须覆写为 false（sticky-OR 会显「已降级为 320k」）', async () => {
    // 首解只给到 128k（downgraded=true），该直链 403 → 重取拿到 320k（downgraded=false）。
    // 留下文件的是重取那次，降级标记必须跟着它一起覆写；旧写法 `if (fresh.downgraded) job.downgraded = true`
    // 与 finalQuality 的覆写不同源，徽标会读成「已降级为 320k」——而降到的正是用户要的档。
    const env = await makeEnv({ purls: ['M500low.mp3', 'M800final.mp3'], failFirst: { '/M500low.mp3': 1 } })
    env.app.enqueue({ tracks: [track('rd', '覆写歌')], quality: '320', source: 'qq' })
    await waitFor(() => env.events.done >= 1)
    expect(env.events.failed).toBe(0)
    expect(env.recorded).toEqual(['/M500low.mp3', '/M800final.mp3'])
    expect(env.events.doneFinalQuality).toEqual(['320'])
    expect(env.events.doneDowngraded).toEqual([false])
  })

  it('I8: 该曲只登记 128k（无无损/320）→ 候选收窄为登记档位，自动降级成功', async () => {
    // 回归锚（2026-09-27 用户实测《我无法用我的语言》）：服务端只按候选**首位**核发直链，
    // 旧实现「无损起全量候选」首位是不存在的 flac → 整批回空 → 报错（用户以为是「没做音质回退」）。
    // 收窄候选到该曲登记的档位后，首位变成真实存在的 128k，降级链路才真正生效。
    const env = await makeEnv({ detailSizes: { size_flac: 0, size_ape: 0, size_320mp3: 0, size_128mp3: 4444, size_96aac: 3333 } })
    env.app.enqueue({ tracks: [track('q5', '只有128k')], quality: 'flac', source: 'qq' })
    await waitFor(() => env.events.done >= 1)
    expect(fs.readdirSync(env.dl)).toEqual(['只有128k - 同歌手.mp3']) // 扩展名证明降级到 128k mp3
    expect(env.events.doneDowngraded).toEqual([true]) // 渲染器据此标记「已降级」
    // 徽标回显的是**实际落档**（128），不是用户请求的 flac——主进程没记 finalQuality 就显示不出来
    expect(env.events.doneFinalQuality).toEqual(['128'])
  })

  it('I9: 候选仍混入不存在的档位时整批失败（服务端只认首位）—— 收窄是必需的，不是可选优化', async () => {
    // 反向锚：证明 mock 忠实复刻了服务端规则。若哪天 mock 又变回「每个候选都回 purl」，
    // I8 会在无收窄时也通过，从而失去防回归能力。
    const env = await makeEnv({ detailBroken: true, detailSizes: { size_flac: 0, size_ape: 0, size_320mp3: 0, size_128mp3: 4444, size_96aac: 3333 } }) // 详情拿不到 → 不收窄 → 全量候选（首位 flac，该曲没有）
    // 挂上有效凭证：否则失败路径会把「无凭证」判成会话过期，掩盖本用例要验的「全档空」语义
    expect(env.app.authImportCookie('uin=o123; qqmusic_uin=o123; qm_keyst=q; qqmusic_key=k')).toBe(true)
    env.app.enqueue({ tracks: [track('q4', '全量候选')], quality: 'flac', source: 'qq' })
    await waitFor(() => env.events.failed >= 1)
    expect(env.events.done).toBe(0)
    expect(env.events.failedErrors.some((m) => /未拿到可播放/.test(m))).toBe(true)
  })

  it('I7: 标签失败 → jobFailed 且已下载文件被清理', async () => {
    const env = await makeEnv({ detailBroken: true })
    env.app.enqueue({ tracks: [track('y')], quality: '320', source: 'qq' })
    await waitFor(() => env.events.failed >= 1)
    expect(env.events.done).toBe(0)
    expect(fs.readdirSync(env.dl)).toEqual([]) // 占位/下载文件/.lrc 全部清理
  })

  it('I4: settingsSet 并发生效，新批次按新并发调度', async () => {
    const env = await makeEnv({ concurrency: 1, delayMs: 1500 })
    env.app.enqueue({ tracks: [track('a'), track('b')], quality: '320', source: 'qq' })
    await waitFor(() => env.events.done >= 2)
    expect(env.events.peak).toBe(1) // 并发 1：活跃峰值 1
    env.app.settingsSet({ concurrency: 3 })
    expect(env.app.settingsGet().concurrency).toBe(3)
    env.app.enqueue({ tracks: [track('c'), track('d')], quality: '320', source: 'qq' })
    await waitFor(() => env.events.done >= 4)
    expect(env.events.peak).toBe(2) // 新并发下两任务重叠
  })

  it('enqueue 同次入队同 id 去重（只启一个任务）', async () => {
    const env = await makeEnv()
    const t = track('z')
    env.app.enqueue({ tracks: [t, { ...t, name: '同名副本' }], quality: '320', source: 'qq' })
    await waitFor(() => env.events.done >= 1)
    await new Promise((r) => setTimeout(r, 1600)) // 越过限速窗口，确认无第二个任务启动
    expect(env.events.failed).toBe(0)
    expect(env.events.start).toBe(1)
    expect(env.events.donePaths.length).toBe(1)
  })

  it('settingsSet 忽略非法枚举/空目录与 NaN 并发（防 runner 崩、文件落错目录）', async () => {
    const env = await makeEnv()
    const before = env.app.settingsGet()
    const after = env.app.settingsSet({
      quality: 'bogus' as any,
      lyricMode: 'nope' as any,
      qqIdentity: 'x' as any,
      downloadDir: '   ',
      decryptOutDir: '',
      concurrency: Number.NaN,
    })
    expect(after.quality).toBe(before.quality)
    expect(after.lyricMode).toBe(before.lyricMode)
    expect(after.qqIdentity).toBe(before.qqIdentity)
    expect(after.downloadDir).toBe(before.downloadDir)
    expect(after.decryptOutDir).toBe(before.decryptOutDir)
    expect(after.concurrency).toBe(before.concurrency)
  })

  it('N1: netease 任务走网易云管线（直链→下载→标签→done）', async () => {
    // lyricMode=embed：歌词内嵌 USLT（music-metadata 读回断言）；直链/歌词/详情全部走 mock 路由
    const env = await makeEnv({ lyricMode: 'embed' })
    env.app.enqueue({
      tracks: [{ id: '123', name: '测试歌', artist: '测试手', album: '测试专', cover: '' }],
      quality: '320',
      source: 'netease',
    })
    await waitFor(() => env.events.done >= 1)
    expect(env.events.failed).toBe(0)
    expect(env.recorded).toEqual(['/ne.mp3']) // 命中本地 320 直链，仅一次下载请求

    const files = fs.readdirSync(env.dl).filter((f) => f.endsWith('.mp3'))
    expect(files.length).toBe(1)
    const out = path.join(env.dl, files[0])
    expect(fs.readFileSync(out).length).toBeGreaterThan(PAYLOAD.length) // 下载成功并经标签内嵌

    const mm = await parseFile(out)
    expect(mm.common.title).toBe('测试歌')
    expect(mm.common.artist).toBe('测试手')
    expect(mm.common.album).toBe('测试专')
    expect(mm.common.date).toBe('2020-05-01') // publishTime 1588262400000 = 2020-05-01（北京时间 CST 零点）
    expect(mm.common.lyrics?.[0]?.text).toContain('测试歌词') // USLT 内嵌
  })

  it('N2: netease 非法歌曲 ID → jobFailed 且无下载文件', async () => {
    const env = await makeEnv()
    env.app.enqueue({
      tracks: [{ id: 'not-a-number', name: '坏 ID', artist: '手', album: '', cover: '' }],
      quality: '320',
      source: 'netease',
    })
    await waitFor(() => env.events.failed >= 1)
    expect(env.events.done).toBe(0)
    // ID 校验在创建下载目录之前抛出 → 目录可能不存在；存在则必须为空
    expect(fs.existsSync(env.dl) ? fs.readdirSync(env.dl) : []).toEqual([])
  })

  it('R1: 失败任务 retryFailed 按原参数重跑（连败两次，均有 failed 事件）', async () => {
    const env = await makeEnv()
    env.app.enqueue({
      tracks: [{ id: 'not-a-number', name: '坏 ID', artist: '手', album: '', cover: '' }],
      quality: '320',
      source: 'netease',
    })
    await waitFor(() => env.events.failed >= 1)
    // job id 现为 source:trackId:seq 的唯一形式（跨批次同曲不撞车），按事件里拿到的 id 重试
    const jobId = env.events.failedIds[0]
    expect(jobId).toContain('not-a-number')
    env.app.retryFailed(jobId)
    await waitFor(() => env.events.failed >= 2)
    expect(env.events.done).toBe(0)
  })

  it('H3: 跨批次同曲重复入队 → job id 唯一（不互相覆盖/串台）', async () => {
    const env = await makeEnv({ delayMs: 300 })
    const t = track('dup', '重复歌', '手')
    env.app.enqueue({ tracks: [t], quality: '320', source: 'qq' })
    env.app.enqueue({ tracks: [t], quality: '320', source: 'qq' })
    await waitFor(() => env.events.done >= 2)
    expect(env.events.failed).toBe(0)
    expect(env.events.startIds.length).toBe(2)
    expect(new Set(env.events.startIds).size).toBe(2) // 两个 job id 各不相同
    expect(new Set(env.events.donePaths).size).toBe(2) // 产物也各自独立
  })

  it('L5: lyricMode=lrc 只另存 .lrc 不内嵌；与 embed 档语义分离', async () => {
    const env = await makeEnv({ lyricMode: 'lrc' })
    env.app.enqueue({ tracks: [track('L1', 'lrc歌')], quality: '320', source: 'qq' })
    await waitFor(() => env.events.done >= 1)
    expect(env.events.failed).toBe(0)
    const mp3 = fs.readdirSync(env.dl).find((f) => f.endsWith('.mp3'))
    expect(mp3).toBeTruthy()
    const mm = await parseFile(path.join(env.dl, mp3!))
    expect(mm.common.lyrics).toBeUndefined() // 仅另存：不内嵌 USLT
    const lrc = fs.readFileSync(path.join(env.dl, mp3!.replace(/\.mp3$/, '.lrc')), 'utf-8')
    expect(lrc).toContain('LRC行') // 侧车 .lrc 已写
  })

  it('N2b: 网易云空字符串 ID 视为非法（Number("")===0 陷阱）', async () => {
    const env = await makeEnv()
    env.app.enqueue({
      tracks: [{ id: '   ', name: '空 ID', artist: '手', album: '', cover: '' }],
      quality: '320',
      source: 'netease',
    })
    await waitFor(() => env.events.failed >= 1)
    expect(env.events.done).toBe(0)
  })

  it('retryFailed 重复入队同 id → 第二次拒绝（防 inflight 覆盖/取消串台）', async () => {
    const env = await makeEnv({ delayMs: 800 })
    env.app.enqueue({
      tracks: [{ id: 'not-a-number', name: '坏 ID', artist: '手', album: '', cover: '' }],
      quality: '320',
      source: 'netease',
    })
    await waitFor(() => env.events.failed >= 1)
    const id = env.events.failedIds[0]
    env.app.retryFailed(id)
    expect(() => env.app.retryFailed(id)).toThrow(/已在队列/)
    await waitFor(() => env.events.failed >= 2)
  })

  it('H1: QQ m4a/ape 档无标签写入器 → 仍下载成功（不再被标签步骤删文件）', async () => {
    const env = await makeEnv({ lyricMode: 'none' })
    env.app.enqueue({ tracks: [track('m1', 'm4a歌')], quality: 'm4a', source: 'qq' })
    env.app.enqueue({ tracks: [track('a1', 'ape歌')], quality: 'ape', source: 'qq' })
    await waitFor(() => env.events.done >= 2)
    expect(env.events.failed).toBe(0)
    const files = fs.readdirSync(env.dl)
    expect(files.some((f) => f.endsWith('.m4a'))).toBe(true)
    expect(files.some((f) => f.endsWith('.ape'))).toBe(true)
    for (const p of env.events.donePaths) expect(fs.statSync(p).size).toBeGreaterThan(0)
  })

  it('R2: 未知 jobId 重试抛错（重启后记录清空需重新勾选）', async () => {
    const env = await makeEnv()
    expect(() => env.app.retryFailed('no-such-job')).toThrow(/重新勾选/)
  })

  it('R5: 网易云账户直链 403 → 自动改走匿名成功并标记 anonFallback', async () => {
    // 账户那次问无损、服务端按凭证回 flac（本地源 /ne.flac 前 2 次 403：初下 + 重取直链再下）；
    // 改匿名后同一 br=999000 只回 320k（/ne.mp3），第 3 次请求 200。
    // 两档必须不同：否则「匿名覆写」与「账户那次遗留的值」看不出差别，finalQuality 断言形同虚设。
    const env = await makeEnv({ failFirst: { '/ne.flac': 2 } })
    expect(env.app.neAuthImport('MUSIC_U=test;')).toBe(true)
    env.app.enqueue({
      tracks: [{ id: '123', name: '匿名兜底歌', artist: '手', album: '', cover: '' }],
      quality: 'flac',
      source: 'netease',
    })
    await waitFor(() => env.events.done >= 1)
    expect(env.events.failed).toBe(0)
    expect(env.recorded).toEqual(['/ne.flac', '/ne.flac', '/ne.mp3'])
    expect(env.events.doneAnon).toEqual([true])
    // 留在盘上的是匿名那次的 320k，回显就必须是 320：账户那次写的 flac 要被匿名改道覆写，
    // 且覆写发生在占位/下载之前——「凡是留下文件的运行都记着该文件的档」正是这条链路的要害
    expect(env.events.doneFinalQuality).toEqual(['320'])
    const files = fs.readdirSync(env.dl).filter((f) => f.endsWith('.mp3'))
    expect(files.length).toBe(1)
    expect(fs.readdirSync(env.dl).filter((f) => f.endsWith('.flac'))).toEqual([]) // 账户半成品已清，不留冒充实无损的 0 字节 flac
  })

  it('R6: 网易云持续 403 → 匿名也 403 才失败（账户 2 次 + 匿名 2 次）', async () => {
    const env = await makeEnv({ failFirst: { '/ne.mp3': 99 } })
    env.app.enqueue({
      tracks: [{ id: '123', name: '全拒歌', artist: '手', album: '', cover: '' }],
      quality: '320',
      source: 'netease',
    })
    await waitFor(() => env.events.failed >= 1)
    expect(env.events.done).toBe(0)
    // 账户（初下 + 重取直链再下）+ 匿名（初下 + 重取直链再下）= 4 次
    expect(env.recorded).toEqual(['/ne.mp3', '/ne.mp3', '/ne.mp3', '/ne.mp3'])
  })

  it('R5b: 账户直链 403 先换 CDN 节点成功 → 保住账户身份（不切匿名、不降级）', async () => {
    // 实机故障锚（2026-10-01）：账号态直链常落在 m704/m804 这类恒 403 节点上，
    // 同一串 URL 换节点即可 206。换节点成功就该止步于此——一旦切匿名，就拿不到无损了。
    // env 自带 server 扮演「被拒节点」（failFirst 全拒），另起一个 server 扮演「可用节点」。
    const good = await startServer()
    try {
      const env = await makeEnv({
        failFirst: { '/ne.mp3': 99 },
        neCdnFallbackUrls: () => [`http://127.0.0.1:${good.port}/ne.mp3`],
      })
      env.app.enqueue({
        tracks: [{ id: '123', name: '换节点歌', artist: '手', album: '', cover: '' }],
        quality: '320',
        source: 'netease',
      })
      await waitFor(() => env.events.done >= 1)
      expect(env.events.failed).toBe(0)
      expect(env.events.doneAnon).toEqual([undefined]) // 未走匿名兜底
      expect(env.recorded).toEqual(['/ne.mp3']) // 被拒节点只打一次（403 不重试、也不再兜底重下）
      expect(good.recorded).toEqual(['/ne.mp3']) // 换节点后一次命中
      expect(fs.readdirSync(env.dl).filter((f) => f.endsWith('.mp3')).length).toBe(1)
    } finally {
      good.server.close()
    }
  })

  it('R7: 会员歌曲无直链 → 点名会员/付费（而非通用文案）；普通歌仍走通用文案', async () => {
    const env = await makeEnv({ neDeadUrl: true })
    env.app.enqueue({
      tracks: [
        { id: '201', name: '会员歌', artist: '手', album: '', cover: '', vip: true },
        { id: '202', name: '普通歌', artist: '手', album: '', cover: '' },
      ],
      quality: '320',
      source: 'netease',
    })
    await waitFor(() => env.events.failed >= 2)
    expect(env.events.failedErrors.length).toBe(2)
    expect(env.events.failedErrors.some((m) => /会员|付费/.test(m))).toBe(true)
    expect(env.events.failedErrors.some((m) => /会员|付费/.test(m) === false && /未拿到可播放/.test(m))).toBe(true)
  })

  it('R4: 账户身份全档空 purl + 探活判定过期 → 报「登录已过期」，authStatus.sessionExpired=true', async () => {
    const env = await makeEnv({ deadVkey: true, loginExpired: true })
    expect(env.app.authImportCookie('uin=o123; qqmusic_uin=o123; qm_keyst=q; qqmusic_key=k')).toBe(true)
    env.app.enqueue({ tracks: [track('q9', '绿钻歌')], quality: 'flac', source: 'qq' })
    await waitFor(() => env.events.failed >= 1)
    expect(env.app.authStatus().sessionExpired).toBe(true)
    // 重新导入凭证清标记
    expect(env.app.authImportCookie('uin=o123; qqmusic_uin=o123; qm_keyst=q; qqmusic_key=k')).toBe(true)
    expect(env.app.authStatus().sessionExpired).toBe(false)
  })

  it('R4b: 凭证有效的全档空 purl → 不误报过期（保留「无版权/权益不足」语义）', async () => {
    // 回归锚：探活必须走 GetLoginUserInfo（令牌依赖型）。若改回 GetPlaylistByUin 之类
    // EncryptUin 依赖型业务接口，本用例在真实服务端会变成「密钥已失效却判存活」——
    // 这里用 loginExpired:false 的 mock 固定「有效凭证不报过期」这一半语义。
    const env = await makeEnv({ deadVkey: true })
    expect(env.app.authImportCookie('uin=o123; qqmusic_uin=o123; qm_keyst=q; qqmusic_key=k')).toBe(true)
    env.app.enqueue({ tracks: [track('q8', '无版权歌')], quality: 'flac', source: 'qq' })
    await waitFor(() => env.events.failed >= 1)
    expect(env.app.authStatus().sessionExpired).toBe(false)
    expect(env.events.failedErrors.some((m) => /未拿到可播放/.test(m))).toBe(true)
    expect(env.events.failedErrors.some((m) => /登录已过期/.test(m))).toBe(false)
    // 失败文案回显该曲实际登记档位（说明「不是没降级，是这曲没登记档位/服务端不放行」）
    // mock 详情 file 只有 media_mid、无各档体积 → 显示「无」
    expect(env.events.failedErrors.some((m) => /登记的档位：无/.test(m))).toBe(true)
  })

  it('R8: QQ 会员/付费曲无直链 + 会话有效 → 点名会员/付费；普通歌仍走通用文案', async () => {
    const env = await makeEnv({ deadVkey: true })
    expect(env.app.authImportCookie('uin=o123; qqmusic_uin=o123; qm_keyst=q; qqmusic_key=k')).toBe(true)
    env.app.enqueue({
      tracks: [{ ...track('q7', '会员歌'), vip: true }, track('q6', '普通歌')],
      quality: 'flac',
      source: 'qq',
    })
    await waitFor(() => env.events.failed >= 2)
    expect(env.events.failedErrors.length).toBe(2)
    expect(env.events.failedErrors.some((m) => /会员|付费/.test(m))).toBe(true)
    expect(env.events.failedErrors.some((m) => !/会员|付费/.test(m) && /未拿到可播放/.test(m))).toBe(true)
  })

  it('R3: QQ 下载身份切换——账户态 vkey 带 cookie，匿名态不带', async () => {
    const env = await makeEnv()
    // 模拟扫码登录成功：主 client 挂上凭证
    expect(env.app.authImportCookie('uin=o123; qqmusic_uin=o123; qm_keyst=q; qqmusic_key=k')).toBe(true)
    const cookies = () => (env.fetchMock as any).musicuCookies as string[]
    // 默认 account：vkey 带登录 cookie
    env.app.enqueue({ tracks: [track('q1', '身份歌')], quality: '320', source: 'qq' })
    await waitFor(() => env.events.done >= 1)
    const firstBatch = [...cookies()]
    expect(firstBatch.length).toBeGreaterThan(0)
    expect(firstBatch.every((c) => c.includes('qqmusic_key=k'))).toBe(true)
    // 切匿名：该批所有 musicu 调用（vkey/detail）都不带 cookie（anon client 永不 setAuth）
    env.app.settingsSet({ qqIdentity: 'anon' })
    env.app.enqueue({ tracks: [track('q2', '匿名歌')], quality: '320', source: 'qq' })
    await waitFor(() => env.events.done >= 2)
    const secondBatch = cookies().slice(firstBatch.length)
    expect(secondBatch.length).toBeGreaterThan(0)
    expect(secondBatch.every((c) => !c.includes('qqmusic_key'))).toBe(true)
  })

  it('N1b: per-batch lyricMode 覆盖设置默认（enqueue lyricMode:none → 不内嵌歌词）', async () => {
    // settings 默认 both（会内嵌歌词），但本批显式传 none → 产物无歌词
    const env = await makeEnv({ lyricMode: 'both' })
    env.app.enqueue({
      tracks: [{ id: '123', name: '测试歌', artist: '测试手', album: '测试专', cover: '' }],
      quality: '320',
      lyricMode: 'none',
      source: 'netease',
    })
    await waitFor(() => env.events.done >= 1)
    expect(env.events.failed).toBe(0)
    const files = fs.readdirSync(env.dl).filter((f) => f.endsWith('.mp3'))
    expect(files.length).toBe(1)
    const mm = await parseFile(path.join(env.dl, files[0]))
    expect(mm.common.title).toBe('测试歌')
    expect(mm.common.lyrics).toBeUndefined() // lyricMode=none → 不取歌词也不内嵌
  })
})
describe('unlockRun 解密补全管线', () => {
  // mflac_map 真实验证样本（raw+suffix 拼接 = 完整加密文件）
  const QMC_FIX = path.join(__dirname, 'fixtures', 'qmc')
  function encMflacMap(): Buffer {
    return Buffer.concat([
      fs.readFileSync(path.join(QMC_FIX, 'mflac_map_raw.bin')),
      fs.readFileSync(path.join(QMC_FIX, 'mflac_map_suffix.bin')),
    ])
  }

  async function makeUnlockEnv(searchHits: any[]) {
    const env = await makeEnv({ searchHits })
    // 解密输出目录指向 env.dl（afterEach 统一清理）
    env.app.settingsSet({ decryptOutDir: env.dl })
    return env
  }

  it('搜索命中 → 解密 + 补全（flac 标签含歌名/歌手），输出规范文件名', async () => {
    const env = await makeUnlockEnv([
      { mid: 'M1', name: '歌曲乙', singer: [{ name: '歌手甲' }], album: { name: '专辑丙', picUrl: '' }, file: { media_mid: 'X' } },
    ])
    const enc = path.join(env.dir, '歌手甲 - 歌曲乙.mflac')
    fs.writeFileSync(enc, encMflacMap())

    const results = await env.app.unlockRun([enc])
    expect(results.length).toBe(1)
    expect(results[0].status).toBe('completed')

    const out = results[0].outputPath!
    expect(path.basename(out)).toBe('歌曲乙 - 歌手甲.flac') // 规范「歌名 - 歌手」
    const mm = await parseFile(out)
    expect(mm.common.title).toBe('歌曲乙')
    expect(mm.common.artist).toBe('歌手甲')
    expect(mm.common.album).toBe('专辑丙')
  })

  it('搜索未命中 → 仅解密（保留原名 .flac），reason 说明', async () => {
    const env = await makeUnlockEnv([])
    const enc = path.join(env.dir, '神秘歌 - 神秘人.mflac')
    fs.writeFileSync(enc, encMflacMap())

    const results = await env.app.unlockRun([enc])
    expect(results[0].status).toBe('decrypted')
    expect(results[0].reason).toContain('搜索未命中')
    expect(path.basename(results[0].outputPath!)).toBe('神秘歌 - 神秘人.flac')
    // 解密结果 = 目标明文
    expect(fs.readFileSync(results[0].outputPath!).equals(fs.readFileSync(path.join(QMC_FIX, 'mflac_map_target.bin')))).toBe(true)
  })

  it('不支持的扩展名与 musicex → failed 且不落盘', async () => {
    const env = await makeUnlockEnv([])
    const bad = path.join(env.dir, 'x.mp3')
    fs.writeFileSync(bad, 'fake')
    const musicex = path.join(env.dir, 'y.mflac')
    fs.writeFileSync(musicex, Buffer.concat([encMflacMap(), Buffer.from('cex\0')]))

    const results = await env.app.unlockRun([bad, musicex])
    expect(results.map((r) => r.status)).toEqual(['failed', 'failed'])
    expect(results[0].reason).toContain('不支持的扩展名')
    expect(results[1].reason).toContain('musicex')
    expect(fs.readdirSync(env.dl)).toEqual([]) // 输出目录零文件
  })
})

describe('neAuthStatus 会话判据（0.7.0 审计修复）', () => {
  it('探测抛错（断网/风控）→ 保守沿用文件判据，不得判「登录已失效」', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-auth-'))
    fs.writeFileSync(path.join(dir, 'netease_cookie.json'), JSON.stringify({ cookie: 'MUSIC_U=AAA; __csrf=B' }), 'utf-8')
    const boom = vi.fn(async () => { throw new Error('fetch failed') }) as unknown as typeof fetch
    const app = createApp({ userDataDir: dir, fetchImpl: boom })
    const s = await app.neAuthStatus()
    expect(s).toEqual({ loggedIn: true, sessionExpired: false }) // 旧实现：neAccount 吞异常→null→误报失效
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('服务端确认不认（profile 无 userId）→ loggedIn:false + sessionExpired:true', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-auth-'))
    fs.writeFileSync(path.join(dir, 'netease_cookie.json'), JSON.stringify({ cookie: 'MUSIC_U=EXP; __csrf=B' }), 'utf-8')
    const ok = vi.fn(async () => new Response(JSON.stringify({ code: 200, profile: {} }))) as unknown as typeof fetch
    const app = createApp({ userDataDir: dir, fetchImpl: ok })
    const s = await app.neAuthStatus()
    expect(s).toEqual({ loggedIn: false, sessionExpired: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('60s 内二次调用不再打网络（启动时 App.vue 与 NeteaseTab 各调一次）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-auth-'))
    fs.writeFileSync(path.join(dir, 'netease_cookie.json'), JSON.stringify({ cookie: 'MUSIC_U=AAA; __csrf=B' }), 'utf-8')
    const f = vi.fn(async () => new Response(JSON.stringify({ code: 200, profile: { userId: 123, nickname: 'x' } }))) as unknown as typeof fetch
    const app = createApp({ userDataDir: dir, fetchImpl: f })
    await app.neAuthStatus()
    await app.neAuthStatus()
    expect(f).toHaveBeenCalledTimes(1)
    app.settingsSet({})            // 不应失效缓存
    await app.neAuthStatus()
    expect(f).toHaveBeenCalledTimes(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('ne:account 会话判据（2026-10-07 断网误报「登录已失效」修复）', () => {
  it('探测抛错（断网/风控）→ neAccount 方法必须 reject，不得 resolve 成 null', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-acct-'))
    fs.writeFileSync(path.join(dir, 'netease_cookie.json'), JSON.stringify({ cookie: 'MUSIC_U=AAA; __csrf=B' }), 'utf-8')
    const boom = vi.fn(async () => { throw new Error('fetch failed') }) as unknown as typeof fetch
    const app = createApp({ userDataDir: dir, fetchImpl: boom })
    // 渲染侧 refreshNePlaylists 靠「resolve null / reject」区分「服务端确认不认」与「请求本身失败」：
    // 旧实现走 neAccount 壳（异常吞成 null），断网时 resolve null → 侧栏误置「登录已失效」。
    // 反锚：handler 退回 neAccount 壳后本用例即失败（resolve 而非 reject）。
    await expect(app.neAccount()).rejects.toThrow(/fetch failed/)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// 会话探测单点化（2026-10-07 阶段评审）：neAuthStatus 走 60s 缓存、neAccount 每次真探，
// 于是启动打两次 /api/nuser/account/get，且两条判据取自不同时刻——同一屏可以一边「已登录」一边
// 「登录已失效」。现在两个消费方读同一份结论：一个窗口一次探测。
describe('ne 会话探测单点缓存', () => {
  const neDirWithCookie = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-probe-'))
    fs.writeFileSync(path.join(dir, 'netease_cookie.json'), JSON.stringify({ cookie: 'MUSIC_U=AAA; __csrf=B' }), 'utf-8')
    return dir
  }
  const acctRes = (uid: number, nickname = 'x'): Response =>
    new Response(JSON.stringify({ code: 200, profile: { userId: uid, nickname } }))
  // 空响应＝网易云风控：client.getJson 当确定性错误立即上抛（不触发 1s/2s 退避，用例不白等）
  const blockedRes = (): Response => new Response('', { status: 200 })

  it('一个窗口只探一次：neAuthStatus 之后接 neAccount 不再重复打网络', async () => {
    const dir = neDirWithCookie()
    const f = vi.fn(async () => acctRes(777, '昵称')) as unknown as typeof fetch
    const app = createApp({ userDataDir: dir, fetchImpl: f })
    const s = await app.neAuthStatus() // App.vue 挂载的第一路
    const acc = await app.neAccount() // 同一次挂载里 refreshNePlaylists / NeteaseTab 的第二路
    expect(f).toHaveBeenCalledTimes(1) // 旧实现：neAccount 不读缓存 → 这里已经是第 2 次
    expect(s).toEqual({ loggedIn: true, sessionExpired: false })
    expect(acc).toEqual({ uid: 777, nickname: '昵称' })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('两条判据同源：服务端确认不认时 neAuthStatus 与 neAccount 给同一个结论', async () => {
    const dir = neDirWithCookie()
    const f = vi.fn(async () => new Response(JSON.stringify({ code: 200, profile: {} }))) as unknown as typeof fetch
    const app = createApp({ userDataDir: dir, fetchImpl: f })
    expect(await app.neAuthStatus()).toEqual({ loggedIn: false, sessionExpired: true })
    expect(await app.neAccount()).toBeNull()
    expect(f).toHaveBeenCalledTimes(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('探测失败不算结论：不进缓存（下次真重探）、一旦探通两个消费方立刻共用', async () => {
    const dir = neDirWithCookie()
    let n = 0
    const f = vi.fn(async () => (++n === 1 ? blockedRes() : acctRes(777, '昵称'))) as unknown as typeof fetch
    const app = createApp({ userDataDir: dir, fetchImpl: f })
    expect(await app.neAuthStatus()).toEqual({ loggedIn: true, sessionExpired: false }) // 判不了：沿用文件判据
    expect(await app.neAuthStatus()).toEqual({ loggedIn: true, sessionExpired: false })
    expect(f).toHaveBeenCalledTimes(2) // 旧实现把「判不了」也缓存了 → 这里只会打 1 次
    expect(await app.neAccount()).toEqual({ uid: 777, nickname: '昵称' })
    expect(f).toHaveBeenCalledTimes(2) // 成功那次进缓存，第二个消费方复用
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('neAuthImport 既失效缓存也清失效标记：离线时导入新 cookie 不再残留「登录已失效」', async () => {
    const dir = neDirWithCookie()
    let n = 0
    // 第 1 次服务端确认不认（置 sessionExpired），之后断网/风控（判不了，沿用上次的标记）
    const f = vi.fn(async () => (++n === 1 ? new Response(JSON.stringify({ code: 200, profile: {} })) : blockedRes())) as unknown as typeof fetch
    const app = createApp({ userDataDir: dir, fetchImpl: f })
    expect(await app.neAuthStatus()).toEqual({ loggedIn: false, sessionExpired: true })
    expect(app.neAuthImport('MUSIC_U=NEW; __csrf=C')).toBe(true)
    // 旧实现只清缓存不清 neSessionExpired：catch 分支把过期标记一路带到侧栏
    expect(await app.neAuthStatus()).toEqual({ loggedIn: true, sessionExpired: false })
    expect(f).toHaveBeenCalledTimes(2) // 缓存确被导入失效掉了（否则直接回用上一次的结论）
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // catch 分支的自相矛盾（2026-10-07 评审）：权威探测判为失效后，跨过 60s 窗口再遇到探测失败
  // （断网/风控）时，旧实现回 loggedIn:true + sessionExpired:true——侧栏读 sessionExpired 报
  // 「登录已失效」、网易云页头读 loggedIn 报「已登录：」+空昵称，同一屏两个相反的结论。
  it('已判失效后探测失败：loggedIn 必须跟着 sessionExpired 落 false，不得并存', async () => {
    vi.useFakeTimers() // 只为了跨过缓存窗口：窗口内第二次调用命中上次的 null 结论，走不到 catch 分支
    const dir = neDirWithCookie()
    try {
      let impl = async (): Promise<Response> => new Response(JSON.stringify({ code: 200, profile: {} })) // 服务端确认不认
      const f = vi.fn(async () => impl()) as unknown as typeof fetch
      const app = createApp({ userDataDir: dir, fetchImpl: f })
      expect(await app.neAuthStatus()).toEqual({ loggedIn: false, sessionExpired: true })
      let probedAgain = false
      impl = async () => { probedAgain = true; throw new Error('fetch failed') } // 换成真抛（断网）
      vi.advanceTimersByTime(61_000)
      const pending = app.neAuthStatus()
      await vi.advanceTimersByTimeAsync(3_000) // 放掉 getJson 的 1s/2s 退避，用例不白等
      expect(await pending).toEqual({ loggedIn: false, sessionExpired: true })
      // 红线：确实离开了缓存真重探并落到 catch——否则上面那条断言是靠缓存命中蒙对的。
      // 用标记而非调用次数：失败重试会再打 2 次，次数随重试策略浮动。
      expect(probedAgain).toBe(true)
    } finally {
      vi.useRealTimers()
      fs.rmSync(dir, { recursive: true, force: true }) // 邻近用例在末尾才 rm，断言失败会漏临时目录
    }
  })

  it('neAuthSaveFromWindow 失效缓存：扫码登录后必须真重探', async () => {
    const dir = neDirWithCookie()
    const f = vi.fn(async () => acctRes(777)) as unknown as typeof fetch
    const app = createApp({ userDataDir: dir, fetchImpl: f })
    await app.neAuthStatus()
    app.neAuthSaveFromWindow('MUSIC_U=NEWH; __csrf=B')
    await app.neAuthStatus()
    expect(f).toHaveBeenCalledTimes(2)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('neAuthClear 失效缓存：退出后用 neAccount 看出是否真重探（它没有文件判据可短路）', async () => {
    const dir = neDirWithCookie()
    const f = vi.fn(async () => acctRes(777)) as unknown as typeof fetch
    const app = createApp({ userDataDir: dir, fetchImpl: f })
    await app.neAccount()
    app.neAuthClear()
    await app.neAccount()
    expect(f).toHaveBeenCalledTimes(2)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ---------- Task 8：专辑 IPC 返回 { tracks, album } ----------
// 只测装配形状，不起本地下载 server（makeEnv 那套是给 runner 用的）：fetchImpl 按
// 「URL + 请求体」片段路由，未登记的片段回空 body——两个 client 都把空 body 判成风控
// 并立即上抛（不 sleep 退避），用例不会白等。
describe('专辑 IPC 形状（0.7.0）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  function albumApp(routes: Array<[string, string]>): App {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'album-ipc-'))
    dirs.push(dir)
    const f = vi.fn(async (input: any, init?: RequestInit) => {
      const hay = `${String(input)} ${String(init?.body ?? '')}`
      return new Response(routes.find(([frag]) => hay.includes(frag))?.[1] ?? '', { status: 200 })
    }) as unknown as typeof fetch
    return createApp({ userDataDir: dir, fetchImpl: f })
  }

  const QQ_ONE_TRACK = JSON.stringify({
    code: 0,
    data: {
      name: 'A', singername: 'S', aDate: '2019-01-02', mid: 'm1', total_song_num: 21,
      list: [{ songmid: 'S1', songname: 't1', albummid: 'm1', singer: [{ name: 'S' }], cdIdx: 1 }],
    },
  })

  it('qqAlbumSongs 返回 { tracks, album }，album 带 totalTracks/discs', async () => {
    const app = albumApp([['fcg_v8_album_info_cp', QQ_ONE_TRACK]])
    const r: any = await app.qqAlbumSongs('m1')
    expect(r.tracks).toHaveLength(1)
    expect(r.album).toMatchObject({ source: 'qq', id: 'm1', totalTracks: 1, discs: [1] })
    // 曲目级序号必须一起过 IPC：渲染侧把它原样带回 dl:enqueue，丢了整张专辑会全部命名成
    // '01 曲名' 互相撞名（Task 10 才落盘，坏在这里看不出来）
    expect(r.tracks[0]).toMatchObject({ trackNo: 1, disc: 1 })
    // bundle 是纯数据才算过得去 index.ts 的 JSON 净化与 Electron 的结构化克隆：混入 Set/Map/函数时
    // 净化会静默把整包变成 undefined（渲染侧只看到空专辑），这里同时验两条通路
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
    expect(structuredClone(r)).toEqual(r)
  })

  it('neAlbumSongs 同样返回 { tracks, album }', async () => {
    const body = JSON.stringify({
      code: 200,
      album: { id: 7, name: 'A', artist: { name: 'S' }, publishTime: 1558310400000, picUrl: '' },
      songs: [{ id: 1, name: 't', no: 1, cd: '01', ar: [{ name: 'S' }], al: { name: 'A' } }],
    })
    const app = albumApp([['/api/v1/album/', body]])
    const r: any = await app.neAlbumSongs(7)
    expect(r.tracks).toHaveLength(1)
    expect(r.album).toMatchObject({ source: 'netease', id: '7', totalTracks: 1 })
    expect(r.tracks[0]).toMatchObject({ trackNo: 1, disc: 1 })
    expect(structuredClone(r)).toEqual(r)
  })

  it('链接导入专辑也带 album（可整张下载）', async () => {
    const app = albumApp([['fcg_v8_album_info_cp', QQ_ONE_TRACK]])
    const r: any = await app.fetchTracksByLink('https://y.qq.com/n/ryqq/albumDetail/001LVtAD0sEPKu')
    expect(r.album).toMatchObject({ source: 'qq', id: 'm1', totalTracks: 1 })
    expect(r.kind).toEqual({ kind: 'album', id: '001LVtAD0sEPKu' })
  })

  // 反锚：这条通道同时服务单曲/歌单/专辑三种链接，只有专辑分支改形状。
  // 用 toStrictEqual（不是 toEqual）——它连「多出来的 undefined 键」也算差异，
  // song/playlist 分支若被顺手塞进 album 键、或 album 分支的改动波及曲目映射，这里就红。
  it('链接导入 song / playlist 分支返回形状与改动前逐键一致（不含 trackNo/disc/album）', async () => {
    const detail = JSON.stringify({
      info: { data: { track_info: {
        mid: 'S1', title: '曲一', interval: 60, album: { mid: 'm1', name: 'A' },
        singer: [{ name: 'S' }], file: { media_mid: 'P1' },
      } } },
    })
    const songApp = albumApp([['get_song_detail_yqq', detail]])
    expect(await songApp.fetchTracksByLink('https://y.qq.com/n/ryqq/songDetail/S1')).toStrictEqual({
      kind: { kind: 'song', id: 'S1' },
      tracks: [{
        id: 'S1', name: '曲一', artist: 'S', album: 'A', cover: 'https://y.gtimg.cn/music/photo_new/T002R300x300M000m1.jpg',
        mediaMid: 'P1', duration: 60, vip: false,
      }],
    })

    const cd = JSON.stringify({ cdlist: [{ songlist: [{ songmid: 'S1', songname: '曲一', albummid: 'm1', albumname: 'A', singer: [{ name: 'S' }], media_mid: 'P1' }] }] })
    const plApp = albumApp([['fcg_ucc_getcdinfo_byids_cp', cd]])
    expect(await plApp.fetchTracksByLink('https://y.qq.com/n/ryqq/playlist/123')).toStrictEqual({
      kind: { kind: 'playlist', id: '123' },
      tracks: [{
        id: 'S1', name: '曲一', artist: 'S', album: 'A', cover: 'https://y.gtimg.cn/music/photo_new/T002R300x300M000m1.jpg',
        mediaMid: 'P1', vip: false,
      }],
    })
  })

  it('空/畸形专辑响应：tracks [] + bundle 走文档化回退，不抛（接线不得推翻 Task 6/7 的解析层）', async () => {
    // 无名的畸形 body：回退名、单碟、0 首都得给出来——渲染侧靠 tracks.length 判「这张没歌」，
    // 装配层若在这里抛或回 undefined，专辑页遮罩就变成白屏而不是「专辑为空」。
    for (const body of ['{}', '{"code":0}', '{"data":{}}', '{"data":{"list":null}}']) {
      const r: any = await albumApp([['fcg_v8_album_info_cp', body]]).qqAlbumSongs('m-x')
      expect(r.tracks).toEqual([])
      expect(r.album).toMatchObject({ source: 'qq', name: '未知专辑', artist: '未知歌手', totalTracks: 0, discs: [1] })
    }
    for (const body of ['{}', '{"code":200}', '{"album":{}}', '{"album":{"publishTime":null},"songs":null}']) {
      const r: any = await albumApp([['/api/v1/album/', body]]).neAlbumSongs(9)
      expect(r.tracks).toEqual([])
      expect(r.album).toMatchObject({ source: 'netease', id: '9', name: '未知专辑', artist: '未知歌手', totalTracks: 0, discs: [1] })
    }
    // 有专辑名但零曲目：名字照留，只按实长算 0 首（Task 6/7 已定的口径，透传不得改成回退名）
    const named: any = await albumApp([['fcg_v8_album_info_cp', '{"data":{"name":"空专辑","mid":"m-y"}}']]).qqAlbumSongs('m-y')
    expect(named.album).toMatchObject({ id: 'm-y', name: '空专辑', totalTracks: 0 })
  })
})

// ---------- Task 10：整张专辑落盘路径 ----------
// 断言的是「目录 + 文件名」两段的最终字符串，不是「有没有落在某个子目录里」——
// 平铺模式必须逐字符不变（下面有反锚用例），专辑模式则必须是 albumBundle 算出来的那一个目录
// （Task 12 的 cover/cue 走同一个 albumTrackDir，这里若自己拼路径，cue 就会指向音频不在的目录）。
describe('专辑落盘路径（0.7.0）', () => {
  /** 专辑根目录名：albumDirName 的口径（歌手 - 专辑 (年)）在测试里独立写一遍，
   *  不用被测函数验证被测函数。 */
  const ROOT = 'S - A (2019)'

  /** 目录里除**专辑附属文件**（Task 12 在 jobDone 之后异步补写的 album.cue / cover.jpg）之外的条目。
   *  本组用例锁「目录 + 曲目文件名」；附属文件本身由「整张专辑的 cover 与 cue 落盘」那组断言。
   *  在这里滤掉，命名用例才不必去赌补写的时序，而「除这些之外没有别的文件」那层含义照旧留着。 */
  const withoutExtras = (dir: string): string[] =>
    fs.readdirSync(dir).filter((f) => f !== 'album.cue' && !/^cover\.(jpg|png)$/.test(f))

  // bundle 用字面量而非 mkBundle：discs/totalTracks 是本用例要依赖的输入，写死才看得出改了哪。
  function bundle(discs = 1, totalTracks = 2 * discs): AlbumBundle {
    return {
      source: 'qq', id: 'm1', name: 'A', artist: 'S', date: '2019-01-02',
      company: 'C', coverUrl: '', totalTracks,
      discs: Array.from({ length: discs }, (_, i) => i + 1),
    }
  }

  function tracks(discs = 1): TrackDTO[] {
    return [
      { id: 'a1', name: 't1', artist: 'S', album: 'A', cover: '', trackNo: 1, disc: 1 },
      { id: 'a2', name: 't2', artist: 'S', album: 'A', cover: '', trackNo: 2, disc: discs },
    ]
  }

  const flatTrack = (): TrackDTO => ({ id: 'f1', name: 't1', artist: 'S', album: 'A', cover: '' })

  it('job.album 存在 → 落 下载目录/歌手 - 专辑 (年)/NN 曲名.ext（单碟不建 CDnn 层）', async () => {
    const env = await makeEnv()
    env.app.enqueue({ tracks: tracks(), quality: '320', source: 'qq', album: bundle() })
    await waitFor(() => env.events.done >= 2)
    expect(env.events.failed).toBe(0)
    expect(withoutExtras(path.join(env.dl, ROOT)).sort()).toEqual(['01 t1.mp3', '02 t2.mp3'])
    // 专辑根下只有两个文件：单碟不得追加 CD01 层（discSegments 的规则），曲目也不得留在平铺根里
    expect(fs.readdirSync(env.dl)).toEqual([ROOT])
    expect(env.events.donePaths.every((p) => p.startsWith(path.join(env.dl, ROOT)))).toBe(true)
  })

  it('多碟 → 专辑根下每碟一个 CDnn 子目录（目录不存在时递归建出两层）', async () => {
    const env = await makeEnv()
    env.app.enqueue({ tracks: tracks(2), quality: '320', source: 'qq', album: bundle(2) })
    await waitFor(() => env.events.done >= 2)
    expect(env.events.failed).toBe(0)
    // env.dl 在用例开始前并不存在（makeEnv 只写 settings.json），这里能列出来即证明递归创建；
    // 专辑根下只有 CD01/CD02 两个目录：没有平铺的音频，cue 也各写在自己碟里、不冒到根上
    expect(fs.readdirSync(path.join(env.dl, ROOT)).sort()).toEqual(['CD01', 'CD02'])
    expect(withoutExtras(path.join(env.dl, ROOT, 'CD01'))).toEqual(['01 t1.mp3'])
    expect(withoutExtras(path.join(env.dl, ROOT, 'CD02'))).toEqual(['02 t2.mp3'])
    expect(fs.readdirSync(env.dl).filter((f) => f.endsWith('.mp3'))).toEqual([])
  })

  it('反锚：不带 album 的入队目录/文件名与改动前逐字符一致，且不建任何子目录', async () => {
    const env = await makeEnv({ lyricMode: 'lrc' })
    env.app.enqueue({ tracks: [flatTrack()], quality: '320', source: 'qq' })
    await waitFor(() => env.events.done >= 1)
    expect(env.events.failed).toBe(0)
    // 平铺命名是「歌名 - 歌手」（现有实现如此，非「歌手 - 歌名」），这里锁整串而不是前缀
    expect(fs.readdirSync(env.dl).sort()).toEqual(['t1 - S.lrc', 't1 - S.mp3'])
    expect(env.events.donePaths).toEqual([path.join(env.dl, 't1 - S.mp3')])
    expect(fs.existsSync(path.join(env.dl, ROOT))).toBe(false)
  })

  it('.lrc 侧车跟着音频进专辑目录并带 NN 前缀（lrcPath 由 dest 截断推出，最易掉回平铺根）', async () => {
    const env = await makeEnv({ lyricMode: 'lrc' })
    env.app.enqueue({ tracks: [tracks()[0]], quality: '320', source: 'qq', album: bundle() })
    await waitFor(() => env.events.done >= 1)
    expect(env.events.failed).toBe(0)
    expect(fs.readFileSync(path.join(env.dl, ROOT, '01 t1.lrc'), 'utf-8')).toContain('LRC行')
    // 反锚：侧车不得掉在下载目录根（现有 lrcPath 写法是 dest 去掉扩展名，改错一处才会暴露）
    expect(fs.readdirSync(env.dl).filter((f) => f.endsWith('.lrc'))).toEqual([])
    expect(withoutExtras(path.join(env.dl, ROOT)).sort()).toEqual(['01 t1.lrc', '01 t1.mp3'])
  })

  it('曲名含非法字符/超长仍经 safeName 得到合法文件名（专辑模式不得绕过现有清洗）', async () => {
    const env = await makeEnv()
    const long = 'x'.repeat(120)
    env.app.enqueue({
      tracks: [
        { id: 'a1', name: 'a/b\\c:d*e?f"g<h>i|j', artist: 'S', album: 'A', cover: '', trackNo: 1, disc: 1 },
        { id: 'a2', name: long, artist: 'S', album: 'A', cover: '', trackNo: 2, disc: 1 },
      ],
      quality: '320',
      source: 'qq',
      album: bundle(),
    })
    await waitFor(() => env.events.done >= 2)
    expect(env.events.failed).toBe(0)
    const files = withoutExtras(path.join(env.dl, ROOT)).sort()
    // 每个非法字符各换一个 '-'；超长名在「NN 前缀之外」的曲名部分截到 97+'...'（前缀不占额度）
    expect(files).toEqual(['01 a-b-c-d-e-f-g-h-i-j.mp3', `02 ${'x'.repeat(97)}....mp3`])
    expect(files.every((f) => !/[\\/:*?"<>|]/.test(f))).toBe(true)
    expect(files[1].length).toBeLessThanOrEqual('02 '.length + 100 + '.mp3'.length)
  })

  it('同一专辑同一曲并发下载 → 专辑目录内 uniquePath 错开，两份产物都在（wx 占位在新目录下仍生效）', async () => {
    const env = await makeEnv({ delayMs: 1200 })
    const t = tracks()[0]
    env.app.enqueue({ tracks: [t], quality: '320', source: 'qq', album: bundle() })
    env.app.enqueue({ tracks: [t], quality: '320', source: 'qq', album: bundle() })
    await waitFor(() => env.events.done >= 2)
    expect(env.events.failed).toBe(0)
    expect(new Set(env.events.donePaths).size).toBe(2)
    expect(withoutExtras(path.join(env.dl, ROOT)).sort()).toEqual(['01 t1(1).mp3', '01 t1.mp3'])
    for (const p of env.events.donePaths) expect(fs.statSync(p).size).toBeGreaterThan(PAYLOAD.length)
  })

  it('直链失败重取换档（flac→mp3）：第二次占位仍在专辑目录内，扩展名换成新档，不留旧档空文件', async () => {
    // 首解给 flac 档、该直链 404 → 重取给 320 档（mp3）。reserveDest 会在同一个 runDownloadJob
    // 里被调用两次，若第二次退回 settings.downloadDir 就漏成平铺文件。
    const env = await makeEnv({ purls: ['gone.flac', 'M800ok.mp3'] })
    env.app.enqueue({ tracks: [tracks()[0]], quality: 'flac', source: 'qq', album: bundle() })
    await waitFor(() => env.events.done >= 1)
    expect(env.events.failed).toBe(0)
    expect(withoutExtras(path.join(env.dl, ROOT))).toEqual(['01 t1.mp3']) // 只剩新档，flac 占位已清
    expect(fs.readdirSync(env.dl).filter((f) => f.endsWith('.mp3') || f.endsWith('.flac'))).toEqual([])
    expect(env.events.doneFinalQuality).toEqual(['320'])
  })

  it('trackNo 缺失（非专辑来源被塞进专辑批次）→ 按 1 命名，不得产出 NaN 前缀', async () => {
    const env = await makeEnv()
    const t = tracks()[0]
    delete (t as Partial<TrackDTO>).trackNo
    env.app.enqueue({ tracks: [t], quality: '320', source: 'qq', album: bundle() })
    await waitFor(() => env.events.done >= 1)
    expect(withoutExtras(path.join(env.dl, ROOT))).toEqual(['01 t1.mp3'])
  })

  it('曲目过百 → 序号位数取 trackPad(bundle)（三位），不是硬编码两位', async () => {
    // 位数由 bundle.totalTracks 决定；写死 2 时字典序会在第 100 首中插到第 1 首前面
    const env = await makeEnv()
    env.app.enqueue({
      tracks: [{ id: 'a57', name: 't57', artist: 'S', album: 'A', cover: '', trackNo: 57, disc: 1 }],
      quality: '320',
      source: 'qq',
      album: bundle(1, 120),
    })
    await waitFor(() => env.events.done >= 1)
    expect(withoutExtras(path.join(env.dl, ROOT))).toEqual(['057 t57.mp3'])
  })

  it('disc 缺失 → 回落 bundle.discs[0]（多碟专辑不得凭空造出 CD02）', async () => {
    const env = await makeEnv()
    const t = tracks(2)[1]
    delete (t as Partial<TrackDTO>).disc
    env.app.enqueue({ tracks: [t], quality: '320', source: 'qq', album: bundle(2) })
    await waitFor(() => env.events.done >= 1)
    expect(withoutExtras(path.join(env.dl, ROOT, 'CD01'))).toEqual(['02 t2.mp3'])
    expect(fs.existsSync(path.join(env.dl, ROOT, 'CD02'))).toBe(false)
  })

  it('网易云专辑批次走同一条落盘路径（两源共用 runDownloadJob 骨架）', async () => {
    const env = await makeEnv()
    env.app.enqueue({
      tracks: [{ id: '123', name: 't1', artist: 'S', album: 'A', cover: '', trackNo: 1, disc: 1 }],
      quality: '320',
      source: 'netease',
      album: { ...bundle(), source: 'netease' },
    })
    await waitFor(() => env.events.done >= 1)
    expect(env.events.failed).toBe(0)
    expect(withoutExtras(path.join(env.dl, ROOT))).toEqual(['01 t1.mp3'])
  })

  it('retryFailed 保留 album：重试成功的曲目回到专辑目录，不掉回平铺根', async () => {
    // 同一直链前两次 403（初下 + 重取各一次）→ 任务失败；重试那次第三次请求放行 → 成功。
    // jobSpecs 若没记 album，重跑的那首会落进下载目录根，整张专辑从此裂成两处。
    const env = await makeEnv({ failFirst: { '/M800a1.mp3': 2 } })
    env.app.enqueue({ tracks: [tracks()[0]], quality: '320', source: 'qq', album: bundle() })
    await waitFor(() => env.events.failed >= 1)
    const id = env.events.failedIds[0]
    env.app.retryFailed(id)
    await waitFor(() => env.events.done >= 1)
    expect(withoutExtras(path.join(env.dl, ROOT))).toEqual(['01 t1.mp3'])
    expect(fs.readdirSync(env.dl).filter((f) => f.endsWith('.mp3'))).toEqual([])
  })
})

// ---------- Task 12：整张专辑的附属文件（cover.jpg + album.cue）与标签序号 ----------
// 这里的核心断言只有一条：**cue 里每个 FILE 都能在同一个目录里 existsSync**。
// 落盘名可能被 uniquePath 改成 '01 t1(1).mp3'、容器可能被降级换成 mp3，两处任意一处写漏，
// 盘上都会留下一份「一加载就报错」的 cue，而下载列表全是绿的——只有回到磁盘取一次才测得出来。
describe('整张专辑的 cover 与 cue 落盘（0.7.0 Task 12）', () => {
  const ROOT = 'S - A (2019)'
  // JPEG 魔数 FF D8 FF：sniffImageMime 据此判 image/jpeg → 落盘名 cover.jpg（PNG 会写成 cover.png）
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('cover-body')])
  const COVER = 'http://cover.test/cover.jpg'

  function bundle(discs = 1, coverUrl = COVER): AlbumBundle {
    return {
      source: 'qq', id: 'm1', name: 'A', artist: 'S', date: '2019-01-02',
      company: 'C', coverUrl, totalTracks: 2,
      discs: Array.from({ length: discs }, (_, i) => i + 1),
    }
  }

  function tracks(discs = 1): TrackDTO[] {
    return [
      { id: 'a1', name: 't1', artist: 'S', album: 'A', cover: '', trackNo: 1, disc: 1 },
      { id: 'a2', name: 't2', artist: 'S', album: 'A', cover: '', trackNo: 2, disc: discs },
    ]
  }

  // 附属文件是 jobDone **之后**的异步写入：断言「不该有的东西确实没有」之前先等这一轮收尾，
  // 否则「还没写到」会被读成「写漏了也没关系」的假绿。
  const settle = async (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** cue 的 FILE 段逐个回磁盘 existsSync 一次，返回 '文件名:容器' 便于继续断言。
   *  正则不锚行尾：cue 是 CRLF，`$` 前会留一个 \r，把它算进容器组就永远匹配不上。 */
  function cueFiles(cueText: string, dir: string): string[] {
    const hits = [...cueText.matchAll(/^FILE "(.+?)" (\w+)/gm)]
    expect(hits.length, 'cue 里一个 FILE 都没有').toBeGreaterThan(0)
    for (const m of hits) expect(fs.existsSync(path.join(dir, m[1])), `cue 指向的文件不存在：${m[1]}`).toBe(true)
    return hits.map((m) => `${m[1]}:${m[2]}`)
  }

  const rawFrames = (file: string): Record<string, unknown> => (NodeID3.read(file).raw ?? {}) as Record<string, unknown>

  it('整张下齐 → 专辑根有 cover.jpg 与 album.cue，cue 的每个 FILE 都真实存在，字节级 BOM+CRLF', async () => {
    const env = await makeEnv({ coverBytes: JPEG })
    env.app.enqueue({ tracks: tracks(), quality: '320', source: 'qq', album: bundle() })
    await waitFor(() => env.events.done >= 2)
    const albumDir = path.join(env.dl, ROOT)
    await waitFor(() => fs.existsSync(path.join(albumDir, 'album.cue')) && fs.existsSync(path.join(albumDir, 'cover.jpg')))
    expect(env.events.failed).toBe(0)
    // cover 是抓到的字节原样落盘（转码/截断都会在这里露出来）；一次专辑只写一份
    expect(fs.readFileSync(path.join(albumDir, 'cover.jpg'))).toEqual(JPEG)
    expect(fs.readdirSync(albumDir).sort()).toEqual(['01 t1.mp3', '02 t2.mp3', 'album.cue', 'cover.jpg'])

    const buf = fs.readFileSync(path.join(albumDir, 'album.cue'))
    // BOM 只有在字节上才有意义（utf-8 写出 EF BB BF，播放器才不按 GBK 猜中文曲名）
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = buf.toString('utf-8')
    const lf = (text.match(/\n/g) ?? []).length
    expect((text.match(/\r\n/g) ?? []).length).toBe(lf)   // 每个 LF 前面都是 CR
    expect(text).toContain('REM DATE 2019')
    expect(text).toContain('PERFORMER "S"')
    expect(text).toContain('TITLE "A"')
    expect(cueFiles(text, albumDir)).toEqual(['01 t1.mp3:MP3', '02 t2.mp3:MP3'])
    // 曲名进 TITLE 而不是从文件名反推（这里两者恰好相同，所以另有用例覆盖差异形态）
    expect(text).toContain('    TITLE "t1"')
  })

  it('整张下载给标签带上序号：TRCK=「1/2」，单碟不写碟总数 TPOS=「1」', async () => {
    const env = await makeEnv({ coverBytes: JPEG })
    env.app.enqueue({ tracks: tracks(), quality: '320', source: 'qq', album: bundle() })
    await waitFor(() => env.events.done >= 2)
    const albumDir = path.join(env.dl, ROOT)
    // 序号与总数都来自 album（trackNo + totalTracks）：丢了它们，播放器只知道「第 1 首」而不知道整张共 2 首
    expect(rawFrames(path.join(albumDir, '01 t1.mp3')).TRCK).toBe('1/2')
    expect(rawFrames(path.join(albumDir, '02 t2.mp3')).TRCK).toBe('2/2')
    expect(rawFrames(path.join(albumDir, '01 t1.mp3')).TPOS).toBe('1')
  })

  it('多碟 → 每碟各一份 cue 在自己的 CDnn 里且只引用本碟文件；cover 只在专辑根', async () => {
    const env = await makeEnv({ coverBytes: JPEG })
    env.app.enqueue({ tracks: tracks(2), quality: '320', source: 'qq', album: bundle(2) })
    await waitFor(() => env.events.done >= 2)
    const root = path.join(env.dl, ROOT)
    await waitFor(() => fs.existsSync(path.join(root, 'CD01', 'album.cue')) && fs.existsSync(path.join(root, 'CD02', 'album.cue')))
    // 专辑根不放 cue（每碟一份，目录才是碟号的载体），cover 只在这一层
    expect(fs.readdirSync(root).sort()).toEqual(['CD01', 'CD02', 'cover.jpg'])
    expect(fs.readdirSync(path.join(root, 'CD01')).sort()).toEqual(['01 t1.mp3', 'album.cue'])
    // 碟总数来自 bundle.discs.length（>1 才写）：单碟写「1/1」是凭空造出一个只有一碟的事实
    expect(rawFrames(path.join(root, 'CD01', '01 t1.mp3')).TPOS).toBe('1/2')
    expect(rawFrames(path.join(root, 'CD02', '02 t2.mp3')).TPOS).toBe('2/2')
    for (const disc of ['CD01', 'CD02']) {
      const text = fs.readFileSync(path.join(root, disc, 'album.cue'), 'utf-8')
      // 各碟只 1 首：CD01 的 cue 里出现 t2，播放器就会在 CD01 目录下找一个只存在于 CD02 的文件
      expect(cueFiles(text, path.join(root, disc))).toHaveLength(1)
    }
    expect(fs.readFileSync(path.join(root, 'CD01', 'album.cue'), 'utf-8')).toContain('01 t1.mp3')
    expect(fs.readFileSync(path.join(root, 'CD02', 'album.cue'), 'utf-8')).toContain('02 t2.mp3')
  })

  it('一首失败 → 只有 cover 没有 cue；retryFailed 成功后补生成且含该曲', async () => {
    const env = await makeEnv({ coverBytes: JPEG, failFirst: { '/M800a2.mp3': 2 } })
    env.app.enqueue({ tracks: tracks(), quality: '320', source: 'qq', album: bundle() })
    await waitFor(() => env.events.failed >= 1)
    const albumDir = path.join(env.dl, ROOT)
    // cover 不等整张：首个任务落盘时就该在（专辑级资源，缺一个 FILE 不影响它）
    await waitFor(() => fs.existsSync(path.join(albumDir, 'cover.jpg')))
    await settle()
    // 半张绝不出 cue：指着缺失文件的 cue 比没有 cue 更糟（播放器加载即报错）
    expect(fs.readdirSync(albumDir).sort()).toEqual(['01 t1.mp3', 'cover.jpg'])
    const jobId = env.events.failedIds[0]
    env.app.retryFailed(jobId)
    await waitFor(() => fs.existsSync(path.join(albumDir, 'album.cue')))
    const text = fs.readFileSync(path.join(albumDir, 'album.cue'), 'utf-8')
    expect(cueFiles(text, albumDir)).toEqual(['01 t1.mp3:MP3', '02 t2.mp3:MP3'])
    expect(env.events.failed).toBe(1)   // 失败的那首没被算进完成度
  })

  it('第二次整张下载 → 新产物带 (1)，cue 的 FILE 跟着换成新名字且仍全部存在', async () => {
    const env = await makeEnv({ coverBytes: JPEG })
    env.app.enqueue({ tracks: tracks(), quality: '320', source: 'qq', album: bundle() })
    const albumDir = path.join(env.dl, ROOT)
    await waitFor(() => fs.existsSync(path.join(albumDir, 'album.cue')))
    env.app.enqueue({ tracks: tracks(), quality: '320', source: 'qq', album: bundle() })
    // uniquePath 加的是 '(1)'（无空格）：cue 若按 trackNo/safeName 重拼文件名，就会指向不存在的 '01 t1 (1).mp3'
    await waitFor(() => fs.existsSync(path.join(albumDir, '01 t1(1).mp3')) && fs.existsSync(path.join(albumDir, '02 t2(1).mp3')))
    await waitFor(async () => {
      const t = fs.readFileSync(path.join(albumDir, 'album.cue'), 'utf-8')
      return t.includes('01 t1(1).mp3') && t.includes('02 t2(1).mp3')
    })
    const text = fs.readFileSync(path.join(albumDir, 'album.cue'), 'utf-8')
    expect(cueFiles(text, albumDir)).toEqual(['01 t1(1).mp3:MP3', '02 t2(1).mp3:MP3'])
    // 不覆盖上一轮（4 个音频都在），但 cover 只有 1 份：专辑级资源，第二次不重写也不追加
    expect(fs.readdirSync(albumDir).filter((f) => f.startsWith('cover.'))).toEqual(['cover.jpg'])
    expect(fs.readdirSync(albumDir).filter((f) => f.endsWith('.mp3'))).toHaveLength(4)
  })

  it('降级换档（flac 直链 404 → 落 mp3）：cue 的容器与文件名都跟着实际落盘走', async () => {
    // 首解给 flac、该直链 404 → 重取拿到 320k。若 cue 的容器按**请求档位**写 FLAC，
    // 播放器就会拿 MP3 文件按 FLAC 索引——列表全绿、加载报错。
    const env = await makeEnv({ purls: ['gone.flac', 'M800ok.mp3'], coverBytes: JPEG })
    env.app.enqueue({ tracks: [tracks()[0]], quality: 'flac', source: 'qq', album: bundle() })
    const albumDir = path.join(env.dl, ROOT)
    await waitFor(() => env.events.done >= 1)
    await waitFor(() => fs.existsSync(path.join(albumDir, 'album.cue')))
    expect(fs.readdirSync(albumDir).sort()).toEqual(['01 t1.mp3', 'album.cue', 'cover.jpg'])
    expect(cueFiles(fs.readFileSync(path.join(albumDir, 'album.cue'), 'utf-8'), albumDir)).toEqual(['01 t1.mp3:MP3'])
  })

  it('m4a 整张：音频与 cover 都在，但该碟不出 cue（播放器索引不了这容器）', async () => {
    const env = await makeEnv({ coverBytes: JPEG })
    env.app.enqueue({ tracks: tracks(), quality: 'm4a', source: 'qq', album: bundle() })
    await waitFor(() => env.events.done >= 2)
    const albumDir = path.join(env.dl, ROOT)
    await waitFor(() => fs.existsSync(path.join(albumDir, 'cover.jpg')))
    await settle()
    // 出不了 cue 不算下载失败：曲目本身完好
    expect(env.events.failed).toBe(0)
    expect(fs.readdirSync(albumDir).sort()).toEqual(['01 t1.m4a', '02 t2.m4a', 'cover.jpg'])
  })

  it('coverUrl 为空 → 一份 cover 都不写，cue 照写（附属文件之间互不拖累）', async () => {
    const env = await makeEnv({ coverBytes: JPEG })
    env.app.enqueue({ tracks: tracks(), quality: '320', source: 'qq', album: bundle(1, '') })
    await waitFor(() => env.events.done >= 2)
    const albumDir = path.join(env.dl, ROOT)
    await waitFor(() => fs.existsSync(path.join(albumDir, 'album.cue')))
    await settle()
    expect(fs.readdirSync(albumDir).sort()).toEqual(['01 t1.mp3', '02 t2.mp3', 'album.cue'])
  })

  it('cover 抓取失败 → 不影响任务成功、cue 照写，只留一行诊断日志', async () => {
    // 没配 coverBytes → 封面端点回 404。附属文件的失败必须止步于此：
    // 一首下好的歌不该因为封面拿不到而变成失败行，也不该因此丢掉整碟 cue。
    const env = await makeEnv({ debugLogFile: true })
    env.app.enqueue({ tracks: tracks(), quality: '320', source: 'qq', album: bundle() })
    await waitFor(() => env.events.done >= 2)
    const albumDir = path.join(env.dl, ROOT)
    await waitFor(() => fs.existsSync(path.join(albumDir, 'album.cue')))
    expect(env.events.failed).toBe(0)
    expect(fs.readdirSync(albumDir).filter((f) => f.startsWith('cover.'))).toEqual([])
    expect(fs.readFileSync(env.debugLog as string, 'utf-8')).toMatch(/封面/)
  })

  it('反锚：平铺下载（无 album）零附属文件、零子目录、零 TRCK/TPOS', async () => {
    // 平铺的曲目**带着 trackNo/disc 也算数**：网易云的搜索/歌单条目同样从 `s.no` 填了 trackNo
    // （neteaseapi/tracks.ts:140），QQ 专辑来源的单曲下载也带序号。守卫写成 `track: job.track.trackNo`
    // 一样能让这批人凭空多出 TRCK 帧——0.6.1 产物逐字节一致就破了，所以这里必须给带序号的曲。
    const env = await makeEnv({ coverBytes: JPEG })
    env.app.enqueue({
      tracks: [{ id: 'f1', name: 't1', artist: 'S', album: 'A', cover: COVER, trackNo: 1, disc: 1 }],
      quality: '320',
      source: 'qq',
    })
    env.app.enqueue({
      tracks: [{ id: '123', name: 'ne歌', artist: '手', album: 'A', cover: '', trackNo: 3 }],
      quality: '320',
      source: 'netease',
    })
    await waitFor(() => env.events.done >= 2)
    await settle()
    expect(env.events.failed).toBe(0)
    // 下载目录根：两个平铺产物，没有 cover.jpg、没有 album.cue、没有专辑子目录
    expect(fs.readdirSync(env.dl).sort()).toEqual(['ne歌 - 手.mp3', 't1 - S.mp3'])
    expect(fs.existsSync(path.join(env.dl, ROOT))).toBe(false)
    for (const name of ['t1 - S.mp3', 'ne歌 - 手.mp3']) {
      const dest = path.join(env.dl, name)
      expect(rawFrames(dest).TRCK).toBeUndefined()
      expect(rawFrames(dest).TPOS).toBeUndefined()
    }
    // 其余标签照旧（不是把打标签整步跳了才没有 TRCK 的）
    expect((NodeID3.read(path.join(env.dl, 't1 - S.mp3')) as any).title).toBe('t1')
  })
})
