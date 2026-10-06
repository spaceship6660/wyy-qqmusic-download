import fs from 'node:fs'
import path from 'node:path'
import { createQqClient } from './qqapi/client'
import { searchTracks, getTrackDetail, getSingleTrack, parseLink, fetchPlaylist, fetchAlbumInfo, fetchLyric, searchAlbums, describeTierSizes, availableTiers, TrackDTO, TrackDetail, Quality } from './qqapi/tracks'
import { getAudioUrl, QUALITY_MAP } from './qqapi/urls'
import { getUserPlaylists, getFavPlaylists, getDissTracksPage } from './qqapi/playlists'
import { getLoginUserInfo, isQqLoginExpired } from './qqapi/user'
import { createAuth } from './auth'
import { createNeClient } from './neteaseapi/client'
import type { NeClient } from './neteaseapi/client'
import { neSearch, neUserPlaylist, nePlaylistDetail, neGetTrackDetail, neAccountChecked, clearNeteaseTrackIdsCache } from './neteaseapi/tracks'
import type { NeAccount } from './neteaseapi/tracks'
import { neFetchLyric } from './neteaseapi/lyric'
import { neSearchAlbums, neAlbumInfo, nePlaylistPage } from './neteaseapi/tracks'
import { neGetAudioUrl } from './neteaseapi/urls'
import { cdnFallbackUrls } from './neteaseapi/cdn'
import { createNeAuth, neLoggedInFromAccount } from './neteaseAuth'
import { DownloadQueue, DownloadJob } from './downloader/queue'
import { RateLimiter } from './downloader/ratelimit'
import { downloadFile } from './downloader/file'
import { tagFile } from './tagger'
import type { TagMeta } from './tagger/types'
import { decryptQmcFile } from './unlock/decrypt'
import { safeName, uniquePath } from './fsUtils'
import type { AlbumBundle, AlbumPage } from './albumBundle'
import { albumRootDir, albumTrackDir, trackBaseName, trackPad } from './albumBundle'
import { AlbumPackager, albumKey, renderCue } from './albumPackaging'
import { loadSettings, saveSettings, Settings, isValidQuality, isValidLyricMode, isValidIdentity, clampConcurrency } from './settings'

export interface AppDeps {
  userDataDir: string
  fetchImpl?: typeof fetch
  emitEvent?: (channel: string, payload: unknown) => void  // 队列事件转发到渲染器
  /** 诊断：非空时把 QQ 登录各网络步响应摘要追加到该文件（仅排障用，正常不设） */
  debugLogFile?: string
  /** 网易云 403 时的同 URL 备用节点候选生成器（默认 cdnFallbackUrls）。
   *  网易云会轮换 CDN 节点，留出「不改码即可调整节点表」的口子；测试亦用它注入本地端点。 */
  neCdnFallbackUrls?: (url: string) => string[]
}

/** 封面 mime 按魔数嗅探（T8 评审项：不硬编码 jpeg；PNG 89 50 4E 47 / JPEG FF D8 FF） */
export function sniffImageMime(buf: Buffer): 'image/png' | 'image/jpeg' {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  return 'image/jpeg'
}

/** 解密单个文件的结果：completed=解密+补全标签 / decrypted=仅解密（搜索未命中/容器不可补） / failed=失败 */
export interface UnlockJobResult {
  file: string
  status: 'completed' | 'decrypted' | 'failed'
  outputPath?: string
  reason?: string
}

/** 专辑解析层的 AlbumPage（`{ bundle, tracks }`）→ IPC 载荷 `{ tracks, album }`（spec §5.2）。
 *  字段名只在这里收口一次：三条通道（qq/ne 专辑页、链接导入）各拼一遍就会漂，而渲染侧两处持有
 *  与 Task 13 的 dl:enqueue 回传都读 `album`——读不到就是「下载整张」入口静默消失。 */
function albumPayload(p: AlbumPage): { tracks: TrackDTO[]; album: AlbumBundle } {
  return { tracks: p.tracks, album: p.bundle }
}

export function createApp(deps: AppDeps) {
  const settingsFile = path.join(deps.userDataDir, 'settings.json')
  const cookieFile = path.join(deps.userDataDir, 'qqmusic_cookie.json')
  const fetchImpl = deps.fetchImpl ?? fetch
  const client = createQqClient(fetchImpl, { uin: '0' })
  // 匿名下载专用 client（永不 setAuth/挂 cookie；下载身份=匿名时直链/详情/歌词全走它）
  const anonQqClient = createQqClient(fetchImpl, { uin: '0' })
  const auth = createAuth({ qqClient: client, fetchImpl, cookiePath: cookieFile, debugLogFile: deps.debugLogFile })
  const neClient = createNeClient(fetchImpl)
  const anonNeClient = createNeClient(fetchImpl) // 同上：匿名下载专用，永不挂 MUSIC_U
  // 403 换节点候选生成器（默认真实节点表；deps 覆盖点见 AppDeps 注释）
  const neCdnFallbackUrls = deps.neCdnFallbackUrls ?? cdnFallbackUrls
  const neAuth = createNeAuth({ cookiePath: path.join(deps.userDataDir, 'netease_cookie.json') })
  const savedNe = neAuth.getCookie()
  if (savedNe) neClient.setCookie(savedNe)
  // 网易云会话有效性：cookie 文件在 ≠ 登录有效（旧 cookie 过期后文件仍在，
  // 会让侧栏一直显示「已登录」而所有鉴权接口静默失败）。
  // 判定走权威接口 /api/nuser/account/get（profile.userId 有无）。
  // 仅当「文件存在且服务端确认无效」才算会话失效；网络抖动导致的探测失败不算（保守，避免误报未登录）。
  let neSessionExpired = false
  // 会话探测结果缓存（60s）：与 neteaseapi/tracks.ts 的 TRACK_IDS_TTL_MS 同款窗口。
  // 缓存的是 account 探测的**结论本身**（NeAccount|null），neAuthStatus（侧栏判据）与 neAccount
  // （昵称/uid）两个消费方都读它。各探各的会一个窗口打两次 /api/nuser/account/get，
  // 而且只有一路写缓存 → 两条判据取自不同时刻，同一屏能给出相反结论
  // （2026-10-07 评审：侧栏「登录已失效」而网易云页头「已登录」+空昵称）。
  // 只缓存服务端给的确切结论：探测失败不写缓存（下次调用真重探），也不置 neSessionExpired。
  const NE_STATUS_TTL_MS = 60_000
  let neAccountCache: { at: number; value: NeAccount } | null = null

  /** 单点会话探测：窗口内复用同一结论，窗口外（或登录态变化清缓存后）真重探。异常照旧上抛。 */
  async function neAccountProbe(): Promise<NeAccount> {
    if (neAccountCache && Date.now() - neAccountCache.at < NE_STATUS_TTL_MS) return neAccountCache.value
    const acc = await neAccountChecked(neClient)
    neAccountCache = { at: Date.now(), value: acc }
    return acc
  }
  let settings = loadSettings(settingsFile)

  const emitEvent = deps.emitEvent ?? (() => {})

  // job id 生成：跨批次对同一首歌重复入队时 id 必须唯一——否则队列 inflight 记录互覆、
  // 取消/状态事件串台、渲染侧同 id 合并成一行（旧实现直接拿 track.id 当 job id）。
  let jobSeq = 0

  // 失败重试登记：jobId → 原入队参数（本 session 有效；渲染侧失败行“重试”按钮用）
  const jobSpecs = new Map<string, {
    track: TrackDTO
    quality: Settings['quality']
    lyricMode?: Settings['lyricMode']
    source: 'qq' | 'netease'
    album?: AlbumBundle
  }>()

  // 诊断日志 appender（vkey 全档失败现场 / 收藏接口字段史；仅 keys 与有无标记，不记密钥与直链）
  const dbgFile = deps.debugLogFile
    ? (line: string) => {
      try {
        fs.appendFileSync(deps.debugLogFile as string, `[${new Date().toISOString()}] ${line}\n`, 'utf-8')
      } catch {
        // 诊断失败不影响业务
      }
    }
    : undefined

  // ---------- 整张专辑的附属文件（spec §5.5 / §5.7） ----------
  // cover 在首个任务完成时写一次（专辑级资源，不等整张下齐）；album.cue 只在**该碟全部曲目落盘后**
  // 才写，且写进该碟自己的目录。目录一律走 albumBundle 的 albumRootDir/albumTrackDir——与
  // runDownloadJob 的落盘目录是同一个算式，两处各拼一遍必然漂移成「cue 指向音频不在的目录」，
  // 而那要到用户加载 cue 才暴露。
  const packager = new AlbumPackager()
  // 键 = albumKey(bundle)：与完成度表同源，避免同 id 不同源（QQ 的 'm1' / 网易云的 '1'）互相顶包。
  // session 内有效，与 jobSpecs/packager 同生命周期；重启后重新入队会再写一次。
  const coverWritten = new Set<string>()

  /** 抓并落 cover.jpg。不抛不等于不报：抓取失败只写诊断日志——一首下好的歌不该因为封面拿不到
   *  而被判成下载失败（cover 是附属品，曲目本身已经完好）。 */
  const writeAlbumCover = async (key: string, b: AlbumBundle): Promise<void> => {
    if (coverWritten.has(key)) return
    if (!b.coverUrl) {
      coverWritten.add(key)   // 这张根本没封面源，登记掉，后续每首不再重复判
      return
    }
    const cover = await fetchCover(b.coverUrl, fetchImpl)
    if (!cover) {
      dbgFile?.(`专辑 ${key} 封面抓取失败（${b.coverUrl}），跳过 cover（不影响曲目与 cue）`)
      return                  // 不登记：偶发失败留给下一首再试一次
    }
    // 扩展名按魔数嗅探结果给（PNG 不能冒充 .jpg）；落专辑根，多碟时不在每个 CDnn 里重复一份
    const ext = cover.mime === 'image/png' ? 'png' : 'jpg'
    fs.writeFileSync(path.join(albumRootDir(settings.downloadDir, b), `cover.${ext}`), cover.data)
    coverWritten.add(key)
  }

  /** 记一笔完成 + 补写 cover 与该碟的 cue。约定不抛（外层还有一道 .catch 兜底）。 */
  const writeAlbumExtras = async (job: DownloadJob): Promise<void> => {
    const b = job.album
    const out = job.outputPath
    if (!b || !out) return
    const key = albumKey(b)
    // 记账排在 cover 之前：cover 是网络活、可能失败，而「哪些曲目落了盘」是出 cue 的唯一依据，
    // 一旦被 cover 那次失败一起带走，这一碟就永远配不齐、再也出不了 cue。
    const justCompleted = packager.record(b, {
      trackNo: job.track.trackNo ?? 1,
      outputPath: out,
      // 落盘扩展名（不是请求档位）：降级换档后 cue 的 FILE 容器必须跟着真实文件走
      ext: path.extname(out).slice(1).toLowerCase(),
      // 原曲名（不是文件名）：文件名过了 safeName，会换掉 / : * 等字符并截断
      title: job.track.name,
    })
    try {
      await writeAlbumCover(key, b)
    } catch (e) {
      dbgFile?.(`专辑 ${key} cover 写入异常：${e instanceof Error ? e.message : String(e)}`)
    }
    for (const disc of justCompleted) {
      const text = renderCue(b, packager.cueEntries(b, disc))
      // renderCue 回 null = 这一碟不该有 cue（容器播放器索引不了 / 一条条目都没有）：直接跳过。
      // 不能写个空文件占位——0 字节的 album.cue 会让播放器报「无效的 cue」，比没有 cue 更扰民。
      if (!text) {
        dbgFile?.(`专辑 ${key} 第 ${disc} 碟不出 album.cue（容器不可索引或缺曲目），已跳过`)
        continue
      }
      try {
        // 同步写：cue 整碟全量覆盖（重试覆写落盘名后必须重写），异步写会让两次重写交错成半截文件
        fs.writeFileSync(path.join(albumTrackDir(settings.downloadDir, b, disc), 'album.cue'), text, 'utf-8')
      } catch (e) {
        dbgFile?.(`专辑 ${key} 第 ${disc} 碟 album.cue 写入失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // 共享下载骨架（QQ/网易云 runner 共同）：直链→占位→下载(失败重取一次)→标签→清理。
  // 两源差异仅三个参数化点：直链解析 resolveOnce、扩展名 extFor、元数据 fetchDetail/fetchLyrics；
  // ID 校验等前置守卫由各 wrapper 负责（如网易云的非数值 id 拒下载）。
  async function runDownloadJob(
    job: DownloadJob,
    report: (pct: number) => void,
    spec: {
      resolveOnce: (q: Quality, available?: Quality[]) => Promise<{ url: string; quality: Quality; downgraded: boolean }>
      extFor: (q: Quality) => string
      fetchDetail: () => Promise<{ date: string; sizes?: TrackDetail['sizes'] }>
      fetchLyrics: () => Promise<string>
      /** 可选：直链被 CDN 拒收（403）时的同 URL 备用节点候选（换 host，路径与签名不变）。
       *  网易云传 cdnFallbackUrls；QQ 无此机制则不传（旧行为完全不变）。 */
      altCdnUrls?: (url: string) => string[]
    },
    signal?: AbortSignal,
  ): Promise<{ outputPath: string }> {
    // 0) 详情**先取**：QQ 服务端只按候选首位核发直链，故候选必须按该曲实际登记的档位收窄
    //    （见 qqapi/urls.ts），而登记档位来自详情。详情在旧流程里本就要取（标签元数据步），
    //    这里提前并复用 → 全程仍只 1 次请求。详情失败不阻塞：available 传 undefined 退回旧行为。
    let detail: { date: string; sizes?: TrackDetail['sizes'] } | null = null
    try {
      detail = await spec.fetchDetail()
    } catch {
      detail = null
    }
    const available = availableTiers(detail?.sizes)
    // 1) 直链（约 20 分钟过期；下载失败重取一次）
    const first = await spec.resolveOnce(job.quality, available)
    if (first.downgraded) job.downgraded = true
    job.finalQuality = first.quality
    // 2) 下载（原子占位防并发撞名：wx 创建，EEXIST 则换后缀重试；
    //    占位文件在下载成功后由 renameSync 覆盖，Windows REPLACE_EXISTING 语义）
    //    整张专辑模式：落 专辑根目录[/CDnn]/NN 曲名.ext；平铺模式：落 歌名 - 歌手.ext（行为一字不改）
    //    目录算式只在 albumBundle.albumTrackDir 里有一份——Task 12 写 cover.jpg / album.cue 复用
    //    同一个函数，这里再拼一遍就会漂成「cue 指向音频不在的目录」，且要到用户加载 cue 才暴露。
    //    disc 回落 discs[0]（而非 1）：单曲没带碟号时，它属于这张专辑的第一碟。
    const bundle = job.album
    const dir = bundle
      ? albumTrackDir(settings.downloadDir, bundle, job.track.disc ?? bundle.discs[0] ?? 1)
      : settings.downloadDir
    const name = bundle
      ? trackBaseName(job.track, trackPad(bundle))
      : `${safeName(job.track.name)} - ${safeName(job.track.artist)}`
    fs.mkdirSync(dir, { recursive: true })
    const reserveDest = (extension: string): string => {
      let d = uniquePath(path.join(dir, `${name}.${extension}`))
      while (true) {
        try {
          fs.closeSync(fs.openSync(d, 'wx'))
          return d
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
          d = uniquePath(d)
        }
      }
    }
    let ext = spec.extFor(first.quality)
    let dest = reserveDest(ext)
    let lrcPath = dest.slice(0, -(ext.length + 1)) + '.lrc'
    const doDownload = (url: string, destPath: string) => downloadFile(url, destPath, {
      retries: 2,
      signal,
      onProgress: (got, total) => {
        report(total > 0 ? Math.round((got / total) * 100) : Math.min(99, Math.round(got / 1e6)))
      },
      altUrls: spec.altCdnUrls,
    })
    // 403 换节点成功只记诊断日志：同一串签名、同一身份、同一音质，产物性质未变，用户无需被告知；
    // 真正要给用户看的是「降级」与「改匿名」——那两条才改变了产物的音质或身份（见 runNeteaseJob）。
    const noteCdnSwitch = (r: { cdnSwitched: boolean }): void => {
      if (r.cdnSwitched) dbgFile?.(`${job.source} 下载 ${job.track.id}：直链被 CDN 节点拒收（403），换节点重试成功`)
    }
    try {
      noteCdnSwitch(await doDownload(first.url, dest))
    } catch (e) {
      // 先清占位/半成品：取消时占位不能留（否则同名歌曲下次下载变成 Name(1)）
      fs.rmSync(dest, { force: true })
      if (signal?.aborted) throw e
      // catch-all 重取直链重下；无论档位是否变化都重新占位——rmSync 后 dest 在 await 期间
      // 已失去 wx 保护，并发同名任务可能用 uniquePath 抢走同名（check-then-write）
      const fresh = await spec.resolveOnce(job.quality, available)
      // 覆写而非 OR：留下文件的是这一次解析，降级标记必须与它同源。
      // 旧写法 sticky-OR（if (fresh.downgraded) job.downgraded = true）配上 finalQuality 的覆写会自相矛盾：
      // 首解回 320k（downgraded=true）、重取回无损（downgraded=false/flac）时，徽标显示「已降级为 无损」。
      job.downgraded = fresh.downgraded
      job.finalQuality = fresh.quality
      ext = spec.extFor(fresh.quality)
      dest = reserveDest(ext)
      lrcPath = dest.slice(0, -(ext.length + 1)) + '.lrc'
      try {
        noteCdnSwitch(await doDownload(fresh.url, dest))
      } catch (e2) {
        fs.rmSync(dest, { force: true })
        throw e2
      }
    }
    // 取消恰在下载完成后到达：保留成品、不再打标签/发请求（队列会把 outputPath 记进 cancelled 任务）
    if (signal?.aborted) return { outputPath: dest }
    // 3) 标签。lyricMode：both=内嵌+另存、embed=仅内嵌、lrc=仅另存、none=不保存。
    //    tagFile 只负责内嵌；另存在此按 wantLrc 手写（此前 saveLrc 与内嵌耦合，lrc 档也会被内嵌）。
    //    ape/m4a（QQ 档）无标签写入器：跳过内嵌（否则整首歌下载后被删），按需只另存 .lrc。
    //    失败时清理已下载文件（含 .lrc）防堆积。
    const lyricMode = job.lyricMode ?? settings.lyricMode
    const canTag = ext === 'mp3' || ext === 'flac'
    const wantLrc = lyricMode === 'both' || lyricMode === 'lrc'
    try {
      const lyrics = lyricMode === 'none' ? '' : await spec.fetchLyrics()
      if (canTag) {
        // 复用步骤 0 取到的详情；若当时失败（detail=null）在这里重试一次，保持原「详情拿不到就判失败」语义
        const info = detail ?? (await spec.fetchDetail())
        const cover = await fetchCover(job.track.cover, fetchImpl, signal)
        const embedLyrics = lyricMode === 'both' || lyricMode === 'embed'
        const meta = {
          title: job.track.name,
          artist: job.track.artist,
          album: job.track.album || '未知专辑',
          date: info.date,
          copyright: '',
          genre: '',
          lyrics: embedLyrics ? lyrics : '',
          // 序号只在「整张」时给：平铺下载这几个全是 undefined → TRCK/TPOS 一帧都不写（0.6.1 产物逐字节一致）。
          // 总数取 album 而不是批次里数到的曲目数：专辑共 10 首、只勾了 2 首时，标签该写「1/10」而不是「1/2」。
          track: job.album ? job.track.trackNo : undefined,
          trackTotal: job.album ? job.album.totalTracks : undefined,
          // disc 回落 discs[0]，与上面落盘目录同一个算式：两处不一致时标签说的碟号和文件真在的碟目录会各说一套
          disc: job.album ? (job.track.disc ?? job.album.discs[0]) : undefined,
          // 碟总数只在多碟时写：单碟写「1/1」等于凭空造出「这专辑共分一碟」这个没人说过的事实
          discTotal: job.album && job.album.discs.length > 1 ? job.album.discs.length : undefined,
          cover: cover?.data,
          coverMime: cover?.mime,
        }
        // 取消恰在元数据取回后到达：保留成品、跳过打标签（队列按 cancelled 记录 outputPath）
        if (signal?.aborted) return { outputPath: dest }
        await tagFile(dest, meta, { saveLrc: false })
      }
      if (wantLrc && lyrics) fs.writeFileSync(lrcPath, lyrics, 'utf-8')
    } catch (e) {
      fs.rmSync(dest, { force: true })
      fs.rmSync(lrcPath, { force: true })
      throw e
    }
    return { outputPath: dest }
  }

  // QQ 登录态失效标记：置位后 authStatus 带 sessionExpired，UI 提示重新登录。
  // 触发：账户身份下载取不到直链时，用一个需要登录的接口探活（能通=确实没版权，不通=会话过期）。
  let qqSessionExpired = false
  // 最近一次探活判定“会话存活”的时间：60s 内同账号再失败直接沿用结论，不再重复打需登录接口
  // （否则账号能下少数歌、大批量失败时每首失败都多打一次探测，失败越多请求越多）
  let qqSessionAliveAt = 0
  const QQ_SESSION_PROBE_TTL_MS = 60_000
  async function qqSessionAlive(): Promise<boolean> {
    const s = auth.getStatus()
    const uin = s.uin?.replace(/^o/i, '') ?? ''
    if (!uin) return false
    // 探测接口：music.UserInfo.userInfoServer/GetLoginUserInfo —— 令牌依赖型，会话失效必报业务码
    // （1000/104400/104401）。**不要改回 GetPlaylistByUin 之类业务接口**：那些走 EncryptUin
    // （账号标识，不随会话密钥过期），密钥死了照样成功，会把过期误判成存活 → 直链全档空却不提示重新登录
    // （2026-09-27 实机故障根因，见 qqapi/user.ts 注释）。
    for (let i = 0; i < 2; i++) {
      try {
        await getLoginUserInfo(client)
        return true
      } catch (e) {
        if (isQqLoginExpired(e)) return false
        // 风控空响应/路径缺失（接口改版）等——判不了，不置失效（避免误报过期把用户赶去重扫码）
        const msg = e instanceof Error ? e.message : String(e)
        const transient = /rate-limited|空响应|timeout|fetch failed|network|路径缺失/i.test(msg)
        if (transient && i === 0) {
          await new Promise((r) => setTimeout(r, 1200))
          continue
        }
        dbgFile?.(`QQ 探活未定论（保留原「无版权/权益」语义）：${msg}`)
        return true
      }
    }
    return true
  }

  const queue = new DownloadQueue({
    concurrency: settings.concurrency,
    rateLimiter: new RateLimiter(1000),
    runner: async (job, report, signal) => {
      // 按 source 选 wrapper：一个参数化点集合 = 一条管线（QQ / 网易云）
      if (job.source === 'netease') return runNeteaseJob(job, report, signal)
      // 下载身份：匿名时直链/详情/歌词全走无凭证 client（歌单浏览不受影响，仍用登录态）
      const qc = settings.qqIdentity === 'anon' ? anonQqClient : client
      // 失败报错定性（账户身份、凭证已确认有效时）：
      // 1) 会员/付费曲点名权益问题，而非丢通用文案；
      // 2) 非会员曲则明确「服务端未提供任何档位直链、与所选档位无关」，并回显该曲实际登记的档位。
      //    起因（2026-09-27 实机）：用户选了无损、曲子只登记 128k/m4a 且 128k 也被拒，
      //    旧文案「可能需要登录，或账号权益不足，无损需绿钻权益」让人误以为「没做音质回退」。
      // 仅失败路径取一次详情（成功路径零额外请求）；详情失败则不带档位信息，不影响报错本身。
      const qqNoUrlError = async (e: unknown): Promise<unknown> => {
        if (!(e instanceof Error) || !/未拿到可播放/.test(e.message)) return e
        let detailNote = ''
        try {
          const d = await getTrackDetail(qc, job.track.id)
          detailNote = `；该曲服务端登记的档位：${describeTierSizes(d.sizes) || '无'}`
        } catch {
          // 详情取不到：不带附加信息
        }
        if (job.track.vip) {
          return new Error(`付费/会员歌曲下载不了：当前账号无该曲下载权限（需 QQ 音乐绿钻/豪华绿钻或单独购买）${detailNote}`)
        }
        return new Error(
          `该曲未拿到可播放 URL：服务端未提供任何档位的下载直链（与所选档位无关，多因版权方未开放下载、仅授权在线试听）${detailNote}`,
        )
      }
      try {
        const r = await runDownloadJob(job, report, {
          resolveOnce: (q, available) => getAudioUrl(qc, job.track.id, job.track.mediaMid, q, dbgFile, available),
          extFor: (q) => QUALITY_MAP[q].ext,
          fetchDetail: () => getTrackDetail(qc, job.track.id),
          fetchLyrics: () => fetchLyric(qc, job.track.id),
        }, signal)
        if (qc === client && settings.qqIdentity === 'account') { qqSessionExpired = false; qqSessionAliveAt = Date.now() }
        return r
      } catch (e) {
        // 账户身份拿不到直链：探活一次，过期则给出可操作提示（重新登录），
        // 未过期才保留“无下载版权/权益不足”的原始语义（“明明有绿钻却失败”多半是这里）
        if (qc === client && settings.qqIdentity === 'account') {
          // 已确认过期则不再重复探活（否则每首失败歌都多打一次需登录接口，失败越多请求越多）
          if (qqSessionExpired) {
            throw new Error('QQ 登录已过期（接口已失效，故直链取不到）。请在左下角重新登录后重试')
          }
          if (Date.now() - qqSessionAliveAt < QQ_SESSION_PROBE_TTL_MS) throw await qqNoUrlError(e) // 刚探活过：保留原“无版权/权益不足”语义
          const alive = await qqSessionAlive()
          if (!alive) {
            qqSessionExpired = true
            throw new Error('QQ 登录已过期（接口已失效，故直链取不到）。请在左下角重新登录后重试')
          }
          qqSessionAliveAt = Date.now()
        }
        throw await qqNoUrlError(e)
      }
    },
  })

  // 队列事件 → 渲染器（浅拷贝快照，避免活引用语义陷阱）
  queue.on('jobQueued', (j) => emitEvent('dl:queued', { ...j }))
  queue.on('jobStart', (j) => emitEvent('dl:jobStart', { ...j }))
  queue.on('jobProgress', (j) => emitEvent('dl:progress', { ...j }))
  queue.on('jobDone', (j) => {
    emitEvent('dl:done', { ...j })
    // 附属文件（cover/cue）是「下载成功之后」的副作用：写坏了不许把这行变成失败行，
    // 但也不能 `void` 一丢了之——async 函数的 reject 没人接就是 unhandled rejection，
    // Node 15+ 默认把它升成进程级崩溃。这里显式接住并落诊断日志。
    if (j.album) {
      const key = albumKey(j.album)
      writeAlbumExtras(j).catch((e) => dbgFile?.(`专辑 ${key} 附属文件写入失败：${e instanceof Error ? e.message : String(e)}`))
    }
  })
  queue.on('jobFailed', (j) => emitEvent('dl:failed', { ...j }))
  queue.on('jobCancelled', (j) => emitEvent('dl:cancelled', { ...j }))

  // 网易云 wrapper：ID 校验（netease 接口以数值 id 查询，非数值直接失败，不进下载），
  // 其余差异仅三个参数化点（直链 br 逐档降级 / 扩展名 / 元数据），复用共享骨架。
  // 账户 403 处置顺序（2026-10-01 修正）：下载内先做**同 URL 换 CDN 节点**重试（altCdnUrls），
  // 全部节点仍 403 才在这里改走匿名重下一遍并标记 anonFallback（只追加一次尝试，不循环）。
  // 起因：账号态直链常被发到 m704/m804 这类恒定 403 的节点上，而同一串 URL 换 m701/m801/m802
  // 立即可下（见 neteaseapi/cdn.ts 实测）。旧逻辑没有换节点这一步，一遇 403 就切匿名——
  // 看似总能成功，实则每首都丢账号身份、且因匿名拿不到无损而顺带降级，用户只看到「全转匿名」。
  // 会员提示：付费/会员歌曲拿不到直链时，报错点名为身份问题而非通用文案（有会员登录态能下则不受影响）。
  const runNeteaseJob = async (job: DownloadJob, report: (pct: number) => void, signal?: AbortSignal): Promise<{ outputPath?: string } | void> => {
    const id = Number(job.track.id)
    // 注意 Number('')===0：空串/空白必须拒掉，不能当合法 id=0 去请求
    if (!Number.isInteger(id) || id <= 0) throw new Error(`非法的网易云歌曲 ID: ${job.track.id}`)
    const vipify = (e: unknown): unknown => {
      if (job.track.vip && e instanceof Error && /未拿到可播放/.test(e.message)) {
        return new Error('付费/会员歌曲下载不了：当前账号无该曲权限（需网易云会员或单独购买）')
      }
      return e
    }
    const runWith = (nc: NeClient) => runDownloadJob(job, report, {
      resolveOnce: (q) => neGetAudioUrl(nc, id, q, dbgFile),
      extFor: (q) => (q === 'flac' ? 'flac' : 'mp3'),
      fetchDetail: () => neGetTrackDetail(nc, id),
      fetchLyrics: () => neFetchLyric(nc, id),
      altCdnUrls: (u) => neCdnFallbackUrls(u),
    }, signal)
    if (settings.neIdentity === 'anon') {
      try {
        return await runWith(anonNeClient)
      } catch (e) {
        throw vipify(e)
      }
    }
    try {
      return await runWith(neClient)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/HTTP 403/.test(msg)) throw vipify(e)
      dbgFile?.(`ne 下载 ${id}：账户直链 403（备用 CDN 节点均已试过），改走匿名重试一次`)
      job.anonFallback = true
      try {
        return await runWith(anonNeClient)
      } catch (e2) {
        throw vipify(e2)
      }
    }
  }

  // 解密补全管线（unlock:run）：读 .mflac/.mgg 加密文件 → 解密 → 文件名「歌手 - 歌名」
  // 搜索 QQ 匹配 → flac/mp3 补封面/歌词/标签；ogg 等容器只解密不补全。
  // 结果三元：completed=解密+补全 / decrypted=仅解密（搜索未命中或容器不可补） / failed=失败
  const QMC_EXTS = new Set(['.mflac', '.mflac0', '.mgg', '.mgg0', '.mgg1', '.qmc0', '.qmcflac', '.qmcogg'])
  const completeExts = new Set(['flac', 'mp3']) // 仅这两个容器有标签写入器（tagger）

  const unlockRun = async (files: string[]): Promise<UnlockJobResult[]> => {
    const outDir = path.resolve(settings.decryptOutDir || 'decrypted')
    fs.mkdirSync(outDir, { recursive: true })
    const results: UnlockJobResult[] = []
    for (const file of files) {
      // 逐个处理：解密是 CPU 活、补全是网络活，串行控制请求节奏（防风控）
      results.push(await unlockOneFile(file, outDir))
    }
    return results
  }

  async function unlockOneFile(file: string, outDir: string): Promise<UnlockJobResult> {
    const base = path.basename(file)
    const ext = path.extname(file).toLowerCase()
    if (!QMC_EXTS.has(ext)) return { file, status: 'failed', reason: `不支持的扩展名 ${ext}` }
    let decrypted: ReturnType<typeof decryptQmcFile>
    try {
      decrypted = decryptQmcFile(fs.readFileSync(file))
    } catch (e) {
      return { file, status: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }
    // 尝试补全：文件名按「歌手 - 歌名」/「歌名 - 歌手」拆段搜索，取首条
    const parts = base.slice(0, -ext.length).split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean)
    let track: TrackDTO | null = null
    if (completeExts.has(decrypted.ext) && parts.length >= 2) {
      try {
        const query = `${parts[0]} ${parts.slice(1).join(' ')}`
        const hits = await searchTracks(client, query)
        track = hits[0] ?? null
      } catch {
        track = null // 搜索失败不阻塞解密
      }
    }
    const outName = track ? `${safeName(track.name)} - ${safeName(track.artist)}.${decrypted.ext}` : `${safeName(base.slice(0, -ext.length))}.${decrypted.ext}`
    const outPath = uniquePath(path.join(outDir, outName))
    fs.writeFileSync(outPath, decrypted.audio)

    if (!track) return { file, status: 'decrypted', outputPath: outPath, reason: '搜索未命中，仅解密' }
    const lyricMode = settings.lyricMode
    try {
      const wantLrc = lyricMode === 'both' || lyricMode === 'lrc'
      const embedLyrics = lyricMode === 'both' || lyricMode === 'embed'
      const lyrics = lyricMode === 'none' ? '' : await fetchLyric(client, track.id) // 失败返回空串，不阻塞
      const cover = await fetchCover(track.cover, fetchImpl)
      const meta: TagMeta = {
        title: track.name,
        artist: track.artist,
        album: track.album || '未知专辑',
        date: '',
        copyright: '',
        genre: '',
        lyrics: embedLyrics ? lyrics : '',
        cover: cover?.data,
        coverMime: cover?.mime,
      }
      await tagFile(outPath, meta, { saveLrc: false })
      if (wantLrc && lyrics) {
        await fs.promises.writeFile(outPath.slice(0, -(decrypted.ext.length + 1)) + '.lrc', lyrics, 'utf-8')
      }
      return { file, status: 'completed', outputPath: outPath }
    } catch (e) {
      // 文件已解密落盘，补全失败不删文件
      return { file, status: 'decrypted', outputPath: outPath, reason: `补全失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  return {
    search: (q: string) => searchTracks(client, q),
    qqAlbumSearch: (q: string) => searchAlbums(client, q),
    // 0.7.0 破坏性形状变更：返回 { tracks, album }（spec §5.2，neAlbumSongs 同理）。渲染侧要持有批次
    // 元数据才谈得上整张下载，只回数组等于把 Task 6/7 接出来的专辑级字段再丢一遍。
    qqAlbumSongs: (mid: string) => fetchAlbumInfo(client, mid).then(albumPayload),
    // QQ 登录态歌单（2026-09-06 补全：我喜欢的音乐 + 创建/收藏歌单，点开批量下载）
    qqUserPlaylists: () => {
      const uin = auth.getStatus().uin?.replace(/^o/i, '') ?? ''
      return uin ? getUserPlaylists(client, uin) : []
    },
    qqFavPlaylists: () => {
      const euin = auth.getEncHostUin()
      if (!euin) return []
      // 诊断：收藏接口字段史（v_list 条目键名，仅 keys 无隐私）记入诊断日志，封面映射对不上时定位用
      return getFavPlaylists(client, euin, dbgFile)
    },
    qqDissTracks: (params: { disstid?: number; dirid?: number; songBegin?: number }) =>
      getDissTracksPage(client, {
        disstid: params.disstid,
        dirid: params.dirid,
        euin: auth.getEncHostUin() || undefined,
        songBegin: params.songBegin ?? 0,
      }, dbgFile),
    parseLink: async (url: string) => {
      const kind = parseLink(url)
      if (!kind) return null
      if (kind.kind === 'song') return { kind, tracks: [await getSingleTrack(client, kind.id)] }
      return null
    },
    fetchTracksByLink: async (url: string) => {
      const kind = parseLink(url)
      if (!kind) return null
      if (kind.kind === 'song') return { kind, tracks: [await getSingleTrack(client, kind.id)] }
      if (kind.kind === 'playlist') return { kind, tracks: await fetchPlaylist(client, kind.id) }
      // 三种链接里只有专辑带 album（单曲/歌单没有批次概念），渲染侧据此决定要不要给整张下载
      if (kind.kind === 'album') return { kind, ...albumPayload(await fetchAlbumInfo(client, kind.id)) }
      return null
    },
    enqueue: (payload: { tracks: TrackDTO[]; quality: Settings['quality']; lyricMode?: Settings['lyricMode']; source: 'qq' | 'netease'; album?: AlbumBundle }) => {
      const { tracks, quality, lyricMode, source, album } = payload
      // 注：质量是每批任务参数，不再回写 settings——持久化职责归 settings:set（renderer 单一事实源）
      // album 整批共用一份：它决定落盘目录与 NN 命名，故也随 jobSpecs 登记，
      // 否则重试那次没有它、这首歌掉回平铺根，一张专辑从此裂在两个目录里。
      // 同次入队按 track.id 去重（重复 id 只留一份）
      const seen = new Set<string>()
      const jobs: DownloadJob[] = []
      for (const t of tracks) {
        if (seen.has(t.id)) continue
        seen.add(t.id)
        const id = `${source}:${t.id}:${++jobSeq}`
        jobSpecs.set(id, { track: t, quality, lyricMode, source, album })
        jobs.push({
          id, source, track: t, quality, lyricMode, album, state: 'queued' as const, progress: 0,
        })
      }
      // spec 登记上限 500（LRU 淘汰最旧；重启后清空，重试需重新勾选）
      while (jobSpecs.size > 500) {
        const oldest = jobSpecs.keys().next()
        if (oldest.done) break
        jobSpecs.delete(oldest.value)
      }
      // 专辑批次：登记期望曲目，供完成度判定（无 album 时不调用 → 平铺下载零影响）。
      // 登记的是**去重后真正入队**的曲目而不是入参 tracks：同次入队里的重复 id 若占掉一个期望槽位，
      // 那一槽永远等不到落盘，整碟就再也出不了 cue。
      if (album) packager.plan(album, jobs.map((j) => j.track))
      queue.enqueue(jobs)
      return true
    },
    /** 失败重试：按登记的原参数重新入队（同 id，渲染侧移到队尾） */
    retryFailed: (jobId: string) => {
      const spec = jobSpecs.get(jobId)
      if (!spec) throw new Error('找不到该任务记录（应用重启后记录清空），请重新勾选下载')
      // 同 id 重试二次点击会被 inflight 覆盖（取消/状态串台），已在队列中则拒绝
      if (queue.has(jobId)) throw new Error('该任务已在队列中，无需重复重试')
      queue.enqueue([{
        id: jobId,
        source: spec.source,
        track: spec.track,
        quality: spec.quality,
        lyricMode: spec.lyricMode,
        album: spec.album,
        state: 'queued' as const,
        progress: 0,
      }])
      return true
    },
    /** 取消下载：排队中直接移除，下载中中止传输；找不到（已完成/已取消/不存在）返回 false */
    cancelDownload: (jobId: string) => queue.cancel(jobId),
    settingsGet: () => settings,
    settingsSet: (patch: Partial<Settings>) => {
      // 逐字段白名单校验：空/非法目录与越界枚举会让下载直接崩（mkdir('')/QUALITY_MAP[q]=undefined），
      // 渲染侧是文本框输入，不能只信类型标注。
      const next: Settings = { ...settings }
      if (isValidQuality(patch.quality)) next.quality = patch.quality
      if (isValidLyricMode(patch.lyricMode)) next.lyricMode = patch.lyricMode
      if (isValidIdentity(patch.qqIdentity)) next.qqIdentity = patch.qqIdentity
      if (isValidIdentity(patch.neIdentity)) next.neIdentity = patch.neIdentity
      if (typeof patch.downloadDir === 'string' && patch.downloadDir.trim()) next.downloadDir = patch.downloadDir
      if (typeof patch.decryptOutDir === 'string' && patch.decryptOutDir.trim()) next.decryptOutDir = patch.decryptOutDir
      if (typeof patch.ffmpegPath === 'string') next.ffmpegPath = patch.ffmpegPath
      next.concurrency = clampConcurrency(patch.concurrency ?? settings.concurrency, settings.concurrency)
      settings = next
      queue.setConcurrency(settings.concurrency)
      saveSettings(settingsFile, settings)
      return settings
    },
    authStartQr: () => auth.startQr(),
    authPoll: () => auth.poll(),
    authWaitResult: async (ms: number) => {
      const res = await auth.waitForResult(ms)
      if (res.ok) { qqSessionExpired = false; qqSessionAliveAt = 0 }
      // 失败时把诊断日志路径带进 UI（仅排障用；诊断文件在 userData，不入库、不打印内容）
      if (!res.ok && deps.debugLogFile) return { ok: false, reason: `${res.reason}\n（诊断日志：${deps.debugLogFile}）` }
      return res
    },
    authImportCookie: (cookie: string) => {
      const ok = auth.importCookie(cookie)
      if (ok) { qqSessionExpired = false; qqSessionAliveAt = 0 }
      return ok
    },
    authClear: () => {
      auth.clear()
      qqSessionExpired = false
      qqSessionAliveAt = 0
      return true
    },
    authStatus: () => {
      const s = auth.getStatus()
      // hasEncUin：收藏歌单（CgiGetPlaylistFavInfo）必需；手动导入的 Cookie 没有它，
      // 渲染侧据此给出精确提示；loginMethod 区分扫码/导入；sessionExpired=下载时探测到会话失效
      return {
        loggedIn: s.state === 'loggedIn',
        uin: s.uin,
        hasEncUin: !!auth.getEncHostUin(),
        loginMethod: auth.getLoginMethod(),
        sessionExpired: qqSessionExpired,
        diagLog: deps.debugLogFile ?? '',
      }
    },
    neSearch: (q: string) => neSearch(neClient, q),
    neAlbumSearch: (q: string) => neSearchAlbums(neClient, q),
    neAlbumSongs: (id: number) => neAlbumInfo(neClient, id).then(albumPayload),
    nePlaylistPage: (params: { id: string; offset: number; limit?: number }) =>
      nePlaylistPage(neClient, params.id, params.offset ?? 0, params.limit ?? 200),
    /** ne:account 与 neAuthStatus 读同一份 neAccountProbe 结论：一个窗口一次探测、一个结论，
     *  两侧判据不可能再取自不同时刻。异常照旧上抛（三态判据见 neSessionExpired 声明处）。 */
    neAccount: () => neAccountProbe(),
    nePlaylists: (uid: number) => neUserPlaylist(neClient, uid),
    nePlaylist: (id: string) => nePlaylistDetail(neClient, id),
    neAuthImport: (header: string) => {
      neAccountCache = null
      const ok = neAuth.importCookie(header)
      if (ok) {
        neClient.setCookie(header)
        clearNeteaseTrackIdsCache()
        // 与 neAuthClear / neAuthSaveFromWindow 一致地清失效标记：导入了新凭证却留着上一次的
        // 「登录已失效」，断网期间不重探就一直显示失效（2026-10-07 评审）。
        neSessionExpired = false
      }
      return ok
    },
    /** 登录态：文件存在 + 服务端确认有效才算「已登录」，三态判据见上方 neSessionExpired 声明处。
     *  60s 结果缓存 + 与 neAccount 共用同一探测：App.vue 与 NeteaseTab.vue 挂载时各调一次、
     *  之后每次进网易云页再调，不缓存会白打网络并挤占网易云频控预算（README「限速范围」条）。 */
    neAuthStatus: async () => {
      const hasFile = neAuth.getStatus().loggedIn
      if (!hasFile) {
        neSessionExpired = false
        neAccountCache = null
        return { loggedIn: false }
      }
      let acc: NeAccount
      try {
        acc = await neAccountProbe()
      } catch {
        // 探测本身失败：无法判定时不新增「失效」结论（不写缓存 → 下次调用真重探）。
        // 但此前已有权威探测判为失效时，loggedIn 必须跟着 false——否则同一份返回里
        // loggedIn:true 与 sessionExpired:true 并存，侧栏与网易云页头各读一半会当场打架。
        return { loggedIn: !neSessionExpired, sessionExpired: neSessionExpired }
      }
      if (neLoggedInFromAccount(acc)) {
        neSessionExpired = false
        return { loggedIn: true, sessionExpired: false }
      }
      neSessionExpired = true
      return { loggedIn: false, sessionExpired: true }
    },
    neAuthClear: () => {
      neAccountCache = null
      neAuth.clear()
      neClient.setCookie('')
      clearNeteaseTrackIdsCache()
      neSessionExpired = false
    },
    neAuthSaveFromWindow: (header: string) => {
      neAccountCache = null
      neAuth.saveCookie(header)
      neClient.setCookie(header)
      clearNeteaseTrackIdsCache()
      neSessionExpired = false
    },
    unlockRun,
  }
}

export type App = ReturnType<typeof createApp>

const COVER_TIMEOUT_MS = 20000
const COVER_MAX_BYTES = 15 * 1024 * 1024
async function fetchCover(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ data: Buffer; mime: 'image/png' | 'image/jpeg' } | undefined> {
  if (!url) return undefined
  try {
    // 封面 CDN 挂起会占住并发槽且无法取消：给独立超时，并与任务取消信号合并
    const timeout = AbortSignal.timeout(COVER_TIMEOUT_MS)
    const res = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    if (!res.ok) {
      // 消费/释放响应体，避免连接悬至 20s 超时才回收（连续 403/404 会拖住并发槽）
      try { await res.body?.cancel() } catch { /* ignore */ }
      return undefined
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > COVER_MAX_BYTES) return undefined
    return { data: buf, mime: sniffImageMime(buf) }
  } catch {
    return undefined
  }
}