import fs from 'node:fs'
import path from 'node:path'
import { createQqClient } from './qqapi/client'
import { searchTracks, getTrackDetail, getSingleTrack, parseLink, fetchPlaylist, fetchAlbum, fetchLyric, searchAlbums, TrackDTO, Quality } from './qqapi/tracks'
import { getAudioUrl, QUALITY_MAP } from './qqapi/urls'
import { getUserPlaylists, getFavPlaylists, getDissTracksPage } from './qqapi/playlists'
import { createAuth } from './auth'
import { createNeClient } from './neteaseapi/client'
import type { NeClient } from './neteaseapi/client'
import { neSearch, neUserPlaylist, nePlaylistDetail, neGetTrackDetail, neAccount, clearNeteaseTrackIdsCache } from './neteaseapi/tracks'
import { neFetchLyric } from './neteaseapi/lyric'
import { neSearchAlbums, neAlbumSongs, nePlaylistPage } from './neteaseapi/tracks'
import { neGetAudioUrl } from './neteaseapi/urls'
import { createNeAuth } from './neteaseAuth'
import { DownloadQueue, DownloadJob } from './downloader/queue'
import { RateLimiter } from './downloader/ratelimit'
import { downloadFile } from './downloader/file'
import { tagFile } from './tagger'
import type { TagMeta } from './tagger/types'
import { decryptQmcFile } from './unlock/decrypt'
import { safeName, uniquePath } from './fsUtils'
import { loadSettings, saveSettings, Settings, isValidQuality, isValidLyricMode, isValidIdentity, clampConcurrency } from './settings'

export interface AppDeps {
  userDataDir: string
  fetchImpl?: typeof fetch
  emitEvent?: (channel: string, payload: unknown) => void  // 队列事件转发到渲染器
  /** 诊断：非空时把 QQ 登录各网络步响应摘要追加到该文件（仅排障用，正常不设） */
  debugLogFile?: string
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
  const neAuth = createNeAuth({ cookiePath: path.join(deps.userDataDir, 'netease_cookie.json') })
  const savedNe = neAuth.getCookie()
  if (savedNe) neClient.setCookie(savedNe)
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

  // 共享下载骨架（QQ/网易云 runner 共同）：直链→占位→下载(失败重取一次)→标签→清理。
  // 两源差异仅三个参数化点：直链解析 resolveOnce、扩展名 extFor、元数据 fetchDetail/fetchLyrics；
  // ID 校验等前置守卫由各 wrapper 负责（如网易云的非数值 id 拒下载）。
  async function runDownloadJob(
    job: DownloadJob,
    report: (pct: number) => void,
    spec: {
      resolveOnce: (q: Quality) => Promise<{ url: string; quality: Quality; downgraded: boolean }>
      extFor: (q: Quality) => string
      fetchDetail: () => Promise<{ date: string }>
      fetchLyrics: () => Promise<string>
    },
    signal?: AbortSignal,
  ): Promise<{ outputPath: string }> {
    // 1) 直链（约 20 分钟过期；下载失败重取一次）
    const first = await spec.resolveOnce(job.quality)
    if (first.downgraded) job.downgraded = true
    // 2) 下载（原子占位防并发撞名：wx 创建，EEXIST 则换后缀重试；
    //    占位文件在下载成功后由 renameSync 覆盖，Windows REPLACE_EXISTING 语义）
    const name = `${safeName(job.track.name)} - ${safeName(job.track.artist)}`
    fs.mkdirSync(settings.downloadDir, { recursive: true })
    const reserveDest = (extension: string): string => {
      let d = uniquePath(path.join(settings.downloadDir, `${name}.${extension}`))
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
    })
    try {
      await doDownload(first.url, dest)
    } catch (e) {
      // 先清占位/半成品：取消时占位不能留（否则同名歌曲下次下载变成 Name(1)）
      fs.rmSync(dest, { force: true })
      if (signal?.aborted) throw e
      // catch-all 重取直链重下；无论档位是否变化都重新占位——rmSync 后 dest 在 await 期间
      // 已失去 wx 保护，并发同名任务可能用 uniquePath 抢走同名（check-then-write）
      const fresh = await spec.resolveOnce(job.quality)
      if (fresh.downgraded) job.downgraded = true
      ext = spec.extFor(fresh.quality)
      dest = reserveDest(ext)
      lrcPath = dest.slice(0, -(ext.length + 1)) + '.lrc'
      try {
        await doDownload(fresh.url, dest)
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
        const detail = await spec.fetchDetail()
        const cover = await fetchCover(job.track.cover, fetchImpl, signal)
        const embedLyrics = lyricMode === 'both' || lyricMode === 'embed'
        const meta = {
          title: job.track.name,
          artist: job.track.artist,
          album: job.track.album || '未知专辑',
          date: detail.date,
          copyright: '',
          genre: '',
          lyrics: embedLyrics ? lyrics : '',
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
    // 探测接口：GetPlaylistByUin 需登录态；空响应（风控）判不了——重试一次，仍空则按“未知”不置失效
    for (let i = 0; i < 2; i++) {
      try {
        await getUserPlaylists(client, uin)
        return true
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const transient = /rate-limited|空响应|timeout|fetch failed|network/i.test(msg)
        if (transient && i === 0) {
          await new Promise((r) => setTimeout(r, 1200))
          continue
        }
        if (transient) return true // 判不了，别误报过期
        return false
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
      try {
        const r = await runDownloadJob(job, report, {
          resolveOnce: (q) => getAudioUrl(qc, job.track.id, job.track.mediaMid, q, dbgFile),
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
          if (Date.now() - qqSessionAliveAt < QQ_SESSION_PROBE_TTL_MS) throw e // 刚探活过：保留原“无版权/权益不足”语义
          const alive = await qqSessionAlive()
          if (!alive) {
            qqSessionExpired = true
            throw new Error('QQ 登录已过期（接口已失效，故直链取不到）。请在左下角重新登录后重试')
          }
          qqSessionAliveAt = Date.now()
        }
        throw e
      }
    },
  })

  // 队列事件 → 渲染器（浅拷贝快照，避免活引用语义陷阱）
  queue.on('jobQueued', (j) => emitEvent('dl:queued', { ...j }))
  queue.on('jobStart', (j) => emitEvent('dl:jobStart', { ...j }))
  queue.on('jobProgress', (j) => emitEvent('dl:progress', { ...j }))
  queue.on('jobDone', (j) => emitEvent('dl:done', { ...j }))
  queue.on('jobFailed', (j) => emitEvent('dl:failed', { ...j }))
  queue.on('jobCancelled', (j) => emitEvent('dl:cancelled', { ...j }))

  // 网易云 wrapper：ID 校验（netease 接口以数值 id 查询，非数值直接失败，不进下载），
  // 其余差异仅三个参数化点（直链 br 逐档降级 / 扩展名 / 元数据），复用共享骨架。
  // 账户 403 兜底：登录态拿到的直链若被 CDN 拒收（个别账号会被限制下载，匿名反而正常），
  // 自动改走匿名重下一遍并标记 anonFallback（只追加一次尝试，不循环）。
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
      dbgFile?.(`ne 下载 ${id}：账户直链 403，改走匿名重试一次`)
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
    qqAlbumSongs: (mid: string) => fetchAlbum(client, mid),
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
      if (kind.kind === 'album') return { kind, tracks: await fetchAlbum(client, kind.id) }
      return null
    },
    enqueue: (payload: { tracks: TrackDTO[]; quality: Settings['quality']; lyricMode?: Settings['lyricMode']; source: 'qq' | 'netease' }) => {
      const { tracks, quality, lyricMode, source } = payload
      // 注：质量是每批任务参数，不再回写 settings——持久化职责归 settings:set（renderer 单一事实源）
      // 同次入队按 track.id 去重（重复 id 只留一份）
      const seen = new Set<string>()
      const jobs: DownloadJob[] = []
      for (const t of tracks) {
        if (seen.has(t.id)) continue
        seen.add(t.id)
        const id = `${source}:${t.id}:${++jobSeq}`
        jobSpecs.set(id, { track: t, quality, lyricMode, source })
        jobs.push({
          id, source, track: t, quality, lyricMode, state: 'queued' as const, progress: 0,
        })
      }
      // spec 登记上限 500（LRU 淘汰最旧；重启后清空，重试需重新勾选）
      while (jobSpecs.size > 500) {
        const oldest = jobSpecs.keys().next()
        if (oldest.done) break
        jobSpecs.delete(oldest.value)
      }
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
    neAlbumSongs: (id: number) => neAlbumSongs(neClient, id),
    nePlaylistPage: (params: { id: string; offset: number; limit?: number }) =>
      nePlaylistPage(neClient, params.id, params.offset ?? 0, params.limit ?? 200),
    neAccount: () => neAccount(neClient),
    nePlaylists: (uid: number) => neUserPlaylist(neClient, uid),
    nePlaylist: (id: string) => nePlaylistDetail(neClient, id),
    neAuthImport: (header: string) => {
      const ok = neAuth.importCookie(header)
      if (ok) {
        neClient.setCookie(header)
        clearNeteaseTrackIdsCache()
      }
      return ok
    },
    neAuthStatus: () => neAuth.getStatus(),
    neAuthClear: () => {
      neAuth.clear()
      neClient.setCookie('')
      clearNeteaseTrackIdsCache()
    },
    neAuthSaveFromWindow: (header: string) => {
      neAuth.saveCookie(header)
      neClient.setCookie(header)
      clearNeteaseTrackIdsCache()
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