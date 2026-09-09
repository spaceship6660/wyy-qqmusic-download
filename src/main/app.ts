import fs from 'node:fs'
import path from 'node:path'
import { createQqClient } from './qqapi/client'
import { searchTracks, getTrackDetail, getSingleTrack, parseLink, fetchPlaylist, fetchAlbum, fetchLyric, searchAlbums, TrackDTO, Quality } from './qqapi/tracks'
import { getAudioUrl, QUALITY_MAP } from './qqapi/urls'
import { getUserPlaylists, getFavPlaylists, getDissTracksPage } from './qqapi/playlists'
import { createAuth } from './auth'
import { createNeClient } from './neteaseapi/client'
import { neSearch, neUserPlaylist, nePlaylistDetail, neGetTrackDetail, neAccount } from './neteaseapi/tracks'
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
import { loadSettings, saveSettings, Settings } from './settings'

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
  const auth = createAuth({ qqClient: client, fetchImpl, cookiePath: cookieFile, debugLogFile: deps.debugLogFile })
  const neClient = createNeClient(fetchImpl)
  const neAuth = createNeAuth({ cookiePath: path.join(deps.userDataDir, 'netease_cookie.json') })
  const savedNe = neAuth.getCookie()
  if (savedNe) neClient.setCookie(savedNe)
  let settings = loadSettings(settingsFile)

  const emitEvent = deps.emitEvent ?? (() => {})

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
  ): Promise<{ outputPath: string }> {
    // 1) 直链（约 20 分钟过期；下载失败重取一次）
    const first = await spec.resolveOnce(job.quality)
    if (first.downgraded) job.downgraded = true
    // 2) 下载（原子占位防并发撞名：wx 创建，EEXIST 则换后缀重试；
    //    占位文件在下载成功后由 renameSync 覆盖，Windows REPLACE_EXISTING 语义）
    const ext = spec.extFor(first.quality)
    const name = `${safeName(job.track.name)} - ${safeName(job.track.artist)}`
    let dest = uniquePath(path.join(settings.downloadDir, `${name}.${ext}`))
    fs.mkdirSync(settings.downloadDir, { recursive: true })
    while (true) {
      try {
        const fd = fs.openSync(dest, 'wx')
        fs.closeSync(fd)
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        dest = uniquePath(dest)
      }
    }
    const doDownload = (url: string, destPath: string) => downloadFile(url, destPath, {
      retries: 2,
      onProgress: (got, total) => {
        report(total > 0 ? Math.round((got / total) * 100) : Math.min(99, Math.round(got / 1e6)))
      },
    })
    try {
      await doDownload(first.url, dest)
    } catch {
      // catch-all 重取直链重下（标签步骤在块外，无掩盖调用方错误的风险）；
      // 失败清理占位文件，避免 .part 并发碰撞后的废文件堆积
      fs.rmSync(dest, { force: true })
      const fresh = await spec.resolveOnce(job.quality)
      if (fresh.downgraded) job.downgraded = true
      await doDownload(fresh.url, dest)
    }
    // 3) 标签（歌词内嵌/另存受「本批 lyricMode」（缺省回退 settings.lyricMode）控制：both=内嵌+另存、
    //    embed=仅内嵌、lrc=仅另存、none=不保存——tagFile 的 saveLrc 参数已有区分；歌词接口失败返回空串不阻塞）；
    //    失败时清理已下载文件（含 .lrc）防堆积
    try {
      const lyricMode = job.lyricMode ?? settings.lyricMode
      const detail = await spec.fetchDetail()
      const cover = await fetchCover(job.track.cover, fetchImpl)
      const meta = {
        title: job.track.name,
        artist: job.track.artist,
        album: job.track.album || '未知专辑',
        date: detail.date,
        copyright: '',
        genre: '',
        lyrics: lyricMode !== 'none' ? await spec.fetchLyrics() : '',
        cover: cover?.data,
        coverMime: cover?.mime,
      }
      await tagFile(dest, meta, { saveLrc: lyricMode === 'both' || lyricMode === 'lrc' })
    } catch (e) {
      fs.rmSync(dest, { force: true })
      fs.rmSync(dest.replace(/\.(mp3|flac|ape|m4a)$/i, '.lrc'), { force: true })
      throw e
    }
    return { outputPath: dest }
  }

  const queue = new DownloadQueue({
    concurrency: settings.concurrency,
    rateLimiter: new RateLimiter(1000),
    runner: async (job, report) => {
      // 按 source 选 wrapper：一个参数化点集合 = 一条管线（QQ / 网易云）
      if (job.source === 'netease') return runNeteaseJob(job, report)
      return runDownloadJob(job, report, {
        resolveOnce: (q) => getAudioUrl(client, job.track.id, job.track.mediaMid, q, dbgFile),
        extFor: (q) => QUALITY_MAP[q].ext,
        fetchDetail: () => getTrackDetail(client, job.track.id),
        fetchLyrics: () => fetchLyric(client, job.track.id),
      })
    },
  })

  // 队列事件 → 渲染器（浅拷贝快照，避免活引用语义陷阱）
  queue.on('jobStart', (j) => emitEvent('dl:jobStart', { ...j }))
  queue.on('jobProgress', (j) => emitEvent('dl:progress', { ...j }))
  queue.on('jobDone', (j) => emitEvent('dl:done', { ...j }))
  queue.on('jobFailed', (j) => emitEvent('dl:failed', { ...j }))

  // 网易云 wrapper：ID 校验（netease 接口以数值 id 查询，非数值直接失败，不进下载），
  // 其余差异仅三个参数化点（直链 br 逐档降级 / 扩展名 / 元数据），复用共享骨架
  const runNeteaseJob = async (job: DownloadJob, report: (pct: number) => void): Promise<{ outputPath?: string } | void> => {
    const id = Number(job.track.id)
    if (!Number.isFinite(id)) throw new Error(`非法的网易云歌曲 ID: ${job.track.id}`)
    return runDownloadJob(job, report, {
      resolveOnce: (q) => neGetAudioUrl(neClient, id, q, dbgFile),
      extFor: (q) => (q === 'flac' ? 'flac' : 'mp3'),
      fetchDetail: () => neGetTrackDetail(neClient, id),
      fetchLyrics: () => neFetchLyric(neClient, id),
    })
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
    try {
      const cover = await fetchCover(track.cover, fetchImpl)
      const lyrics = await fetchLyric(client, track.id) // 失败返回空串，不阻塞
      const meta: TagMeta = {
        title: track.name,
        artist: track.artist,
        album: track.album || '未知专辑',
        date: '',
        copyright: '',
        genre: '',
        lyrics,
        cover: cover?.data,
        coverMime: cover?.mime,
      }
      const lyricMode = settings.lyricMode
      await tagFile(outPath, meta, { saveLrc: lyricMode === 'both' || lyricMode === 'lrc' })
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
      queue.enqueue(
        tracks
          .filter((t) => {
            if (seen.has(t.id)) return false
            seen.add(t.id)
            return true
          })
          .map((t) => ({
            id: t.id, source, track: t, quality, lyricMode, state: 'queued' as const, progress: 0,
          })),
      )
      return true
    },
    settingsGet: () => settings,
    settingsSet: (patch: Partial<Settings>) => {
      settings = { ...settings, ...patch, concurrency: Math.max(1, patch.concurrency ?? settings.concurrency) }
      queue.setConcurrency(settings.concurrency)
      saveSettings(settingsFile, settings)
      return settings
    },
    authStartQr: () => auth.startQr(),
    authPoll: () => auth.poll(),
    authWaitResult: async (ms: number) => {
      const res = await auth.waitForResult(ms)
      // 失败时把诊断日志路径带进 UI（仅排障用；诊断文件在 userData，不入库、不打印内容）
      if (!res.ok && deps.debugLogFile) return { ok: false, reason: `${res.reason}\n（诊断日志：${deps.debugLogFile}）` }
      return res
    },
    authImportCookie: (cookie: string) => auth.importCookie(cookie),
    authClear: () => {
      auth.clear()
      return true
    },
    authStatus: () => {
      const s = auth.getStatus()
      // hasEncUin：收藏歌单（CgiGetPlaylistFavInfo）必需；手动导入的 Cookie 没有它，
      // 渲染侧据此给出精确提示；loginMethod 区分扫码/导入；diagLog 供用户上报排障日志
      return {
        loggedIn: s.state === 'loggedIn',
        uin: s.uin,
        hasEncUin: !!auth.getEncHostUin(),
        loginMethod: auth.getLoginMethod(),
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
      if (ok) neClient.setCookie(header)
      return ok
    },
    neAuthStatus: () => neAuth.getStatus(),
    neAuthClear: () => {
      neAuth.clear()
      neClient.setCookie('')
    },
    neAuthSaveFromWindow: (header: string) => {
      neAuth.saveCookie(header)
      neClient.setCookie(header)
    },
    unlockRun,
  }
}

export type App = ReturnType<typeof createApp>

async function fetchCover(url: string, fetchImpl: typeof fetch): Promise<{ data: Buffer; mime: 'image/png' | 'image/jpeg' } | undefined> {
  if (!url) return undefined
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) return undefined
    return { data: buf, mime: sniffImageMime(buf) }
  } catch {
    return undefined
  }
}