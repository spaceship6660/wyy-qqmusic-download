import path from 'node:path'
import { createQqClient } from './qqapi/client'
import { searchTracks, getTrackDetail, getSingleTrack, parseLink, fetchPlaylist, fetchAlbum, TrackDTO } from './qqapi/tracks'
import { getAudioUrl } from './qqapi/urls'
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
      // 2) 下载
      const ext = first.quality === 'm4a' ? 'm4a' : first.quality === 'flac' ? 'flac' : first.quality === 'ape' ? 'ape' : 'mp3'
      const name = `${safeName(job.track.name)} - ${safeName(job.track.artist)}`
      const dest = uniquePath(path.join(settings.downloadDir, `${name}.${ext}`))
      try {
        await downloadFile(first.url, dest, { retries: 2, onProgress: (got, total) => {
          report(total > 0 ? Math.round((got / total) * 100) : Math.min(99, Math.round(got / 1e6)))
        } })
      } catch (err) {
        if (err instanceof TypeError) {   // 网络层错误才重取直链重下
          const fresh = await resolveOnce(job.quality)
          await downloadFile(fresh.url, dest)
        } else {
          throw err
        }
      }
      // 3) 标签（T12 接入歌词前 lyrics 为空串）
      const detail = await getTrackDetail(client, job.track.id)
      const cover = await fetchCover(job.track.cover, fetchImpl)
      const meta = {
        title: job.track.name,
        artist: job.track.artist,
        album: job.track.album || '未知专辑',
        date: detail.date,
        copyright: '',
        genre: '',
        lyrics: settings.lyricMode !== 'none' ? '' : '',   // T12 接入 fetchLyric
        cover: cover?.data,
        coverMime: cover?.mime,
      }
      await tagFile(dest, meta, { saveLrc: settings.lyricMode === 'both' || settings.lyricMode === 'lrc' })
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
      if (kind.kind === 'playlist') return { kind, tracks: await fetchPlaylist(client, kind.id) }
      if (kind.kind === 'album') return { kind, tracks: await fetchAlbum(client, kind.id) }
      return null
    },
    enqueue: (tracks: TrackDTO[], quality: Settings['quality']) => {
      settings.quality = quality
      saveSettings(settingsFile, settings)
      queue.enqueue(tracks.map((t) => ({
        id: t.id, source: 'qq' as const, track: t, quality, state: 'queued' as const, progress: 0,
      })))
      return true
    },
    settingsGet: () => settings,
    settingsSet: (patch: Partial<Settings>) => {
      settings = { ...settings, ...patch }
      saveSettings(settingsFile, settings)
      return settings
    },
    authStartQr: () => auth.startQr(),
    authPoll: () => auth.poll(),
    authWaitResult: (ms: number) => auth.waitForResult(ms),
    authImportCookie: (cookie: string) => auth.importCookie(cookie),
    authStatus: () => ({ loggedIn: auth.getStatus().state === 'loggedIn', uin: auth.getStatus().uin }),
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