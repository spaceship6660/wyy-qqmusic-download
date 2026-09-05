import fs from 'node:fs'
import path from 'node:path'
import { createQqClient } from './qqapi/client'
import { searchTracks, getTrackDetail, getSingleTrack, parseLink, fetchPlaylist, fetchAlbum, fetchLyric, TrackDTO } from './qqapi/tracks'
import { getAudioUrl, QUALITY_MAP } from './qqapi/urls'
import { createAuth } from './auth'
import { DownloadQueue } from './downloader/queue'
import { RateLimiter } from './downloader/ratelimit'
import { downloadFile } from './downloader/file'
import { tagFile } from './tagger'
import { safeName, uniquePath } from './fsUtils'
import { loadSettings, saveSettings, Settings } from './settings'

export interface AppDeps {
  userDataDir: string
  fetchImpl?: typeof fetch
  emitEvent?: (channel: string, payload: unknown) => void  // 队列事件转发到渲染器
}

/** 封面 mime 按魔数嗅探（T8 评审项：不硬编码 jpeg；PNG 89 50 4E 47 / JPEG FF D8 FF） */
export function sniffImageMime(buf: Buffer): 'image/png' | 'image/jpeg' {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  return 'image/jpeg'
}

export function createApp(deps: AppDeps) {
  const settingsFile = path.join(deps.userDataDir, 'settings.json')
  const cookieFile = path.join(deps.userDataDir, 'qqmusic_cookie.json')
  const fetchImpl = deps.fetchImpl ?? fetch
  const client = createQqClient(fetchImpl, { uin: '0' })
  const auth = createAuth({ qqClient: client, fetchImpl, cookiePath: cookieFile })
  let settings = loadSettings(settingsFile)

  const emitEvent = deps.emitEvent ?? (() => {})

  const queue = new DownloadQueue({
    concurrency: settings.concurrency,
    rateLimiter: new RateLimiter(1000),
    runner: async (job, report) => {
      // 1) 直链（约 20 分钟过期；下载失败重取一次）
      const resolveOnce = async (q: typeof job.quality) => getAudioUrl(client, job.track.id, job.track.mediaMid, q)
      const first = await resolveOnce(job.quality)
      if (first.downgraded) job.downgraded = true
      // 2) 下载（原子占位防并发撞名：wx 创建，EEXIST 则换后缀重试；
      //    占位文件在下载成功后由 renameSync 覆盖，Windows REPLACE_EXISTING 语义）
      const ext = QUALITY_MAP[first.quality].ext
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
      } catch (err) {
        // catch-all 重取直链重下（标签步骤在块外，无掩盖调用方错误的风险）；
        // 失败清理占位文件，避免 .part 并发碰撞后的废文件堆积
        fs.rmSync(dest, { force: true })
        const fresh = await resolveOnce(job.quality)
        if (fresh.downgraded) job.downgraded = true
        await doDownload(fresh.url, dest)
      }
      // 3) 标签（歌词内嵌/另存受 settings.lyricMode 控制：both=内嵌+另存、embed=仅内嵌、
      //    lrc=仅另存、none=不保存——tagFile 的 saveLrc 参数已有区分；歌词接口失败返回空串不阻塞）；
      //    失败时清理已下载文件（含 .lrc）防堆积
      try {
        const detail = await getTrackDetail(client, job.track.id)
        const cover = await fetchCover(job.track.cover, fetchImpl)
        const meta = {
          title: job.track.name,
          artist: job.track.artist,
          album: job.track.album || '未知专辑',
          date: detail.date,
          copyright: '',
          genre: '',
          lyrics: settings.lyricMode !== 'none' ? await fetchLyric(client, job.track.id) : '',
          cover: cover?.data,
          coverMime: cover?.mime,
        }
        await tagFile(dest, meta, { saveLrc: settings.lyricMode === 'both' || settings.lyricMode === 'lrc' })
      } catch (e) {
        fs.rmSync(dest, { force: true })
        fs.rmSync(dest.replace(/\.(mp3|flac|ape|m4a)$/i, '.lrc'), { force: true })
        throw e
      }
      return { outputPath: dest }
    },
  })

  // 队列事件 → 渲染器（浅拷贝快照，避免活引用语义陷阱）
  queue.on('jobStart', (j) => emitEvent('dl:jobStart', { ...j }))
  queue.on('jobProgress', (j) => emitEvent('dl:progress', { ...j }))
  queue.on('jobDone', (j) => emitEvent('dl:done', { ...j }))
  queue.on('jobFailed', (j) => emitEvent('dl:failed', { ...j }))

  return {
    search: (q: string) => searchTracks(client, q),
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
    enqueue: (tracks: TrackDTO[], quality: Settings['quality']) => {
      // 注：质量是每批任务参数，不再回写 settings——持久化职责归 settings:set（renderer 单一事实源）
      // 同次入队按 track.id 去重（重复 id 只留一份）
      const seen = new Set<string>()
      const jobs = tracks
        .filter((t) => {
          if (seen.has(t.id)) return false
          seen.add(t.id)
          return true
        })
        .map((t) => ({
          id: t.id, source: 'qq' as const, track: t, quality, state: 'queued' as const, progress: 0,
        }))
      queue.enqueue(jobs)
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
    authWaitResult: (ms: number) => auth.waitForResult(ms),
    authImportCookie: (cookie: string) => auth.importCookie(cookie),
    authStatus: () => {
      const s = auth.getStatus()
      return { loggedIn: s.state === 'loggedIn', uin: s.uin }
    },
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