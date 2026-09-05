# 网易云音乐模块（P2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已完成的 QQ 音乐下载器（Electron，P1 M1-M5）中加入网易云模块：开窗扫码登录后直接浏览「我喜欢的音乐」与全部歌单，批量下载并复用现有下载/标签/队列管线。

**Architecture:** 新增 `src/main/neteaseapi/`（GET 明文接口客户端，复用 qqapi 的 `QqApiError` 语义）+ `src/main/neteaseAuth.ts`（cookie 持久化/导入/状态；开窗抓 cookie 的 BrowserWindow 部分在主进程 index.ts）+ 渲染器新增「网易云」Tab（登录横幅 + 歌单侧栏 + 曲目网格）。`DownloadJob.source` 字段与下载/标签/队列全部复用，app.ts runner 按 source 分流，`dl:enqueue` 签名升级为带 source。

**Tech Stack:** 与 P1 相同（Electron 36 / TS / Vitest / node-id3）。接口：`api/user/playlist`、`api/v6/playlist/detail`、`api/cloudsearch/pc`、`api/song/enhance/player/url`、`api/song/lyric`、`api/nuser/account/get`、`api/song/detail`（2026-09-04 已实测匿名可用性，见 `docs/netease-download-research-2026-09-04.md`）。

**复用清单（零改动直接拿）**：`src/main/downloader/`（file/ratelimit/queue，queue 的 `source` 字段 P1 已就绪）、`src/main/tagger/`（index/mp3/vorbis/types）、`src/main/fsUtils.ts`、`settings.ts`、`DownloadHttpError`、`fetchCover`（app.ts 内已含）、preload `api.invoke/on`、QueuePanel/TrackGrid 组件、`dl:*` 事件通道。

**文件结构总览**：

```
src/main/neteaseapi/
  client.ts       GET JSON 客户端（Referer music.163.com + cookie + 超时 15s + 网络错误重试 + 空响应风控识别，复用 QqApiError）
  tracks.ts       TrackDTO 映射（neteaseTrackToDto）+ neGetTrackDetail（date）
  library.ts      user/playlist → PlaylistDTO[]（喜欢 specialType=5 置顶）
  playlist.ts     v6/playlist/detail → { tracks, requiresLogin }
  search.ts       cloudsearch/pc → TrackDTO[]
  urls.ts         NE_QUALITY_BR（flac→0/320→320000/128→128000）+ NE_LADDER + neGetAudioUrl 降级链
  lyric.ts        api/song/lyric → lrc 文本
src/main/neteaseAuth.ts        cookie JSON 持久化/导入/清除/状态 + buildCookieHeader（纯函数）
src/main/app.ts 扩展            neClient/neAuth 组装 + runner 按 source 分流 + ne:* IPC 业务
src/main/index.ts 扩展          ne IPC 注册 + 开窗扫码（BrowserWindow → music.163.com/login → cookies.get）
src/renderer/src/components/NeteaseTab.vue   登录横幅/搜索/歌单侧栏/曲目网格/批量入队
src/renderer/src/App.vue       三 Tab → 四 Tab
tests/neteaseapi-*.test.ts / tests/neteaseAuth.test.ts / tests/app.test.ts 扩展
docs/acceptance-netease.md     验收记录（P2）
```

**数据契约（全计划一致）**：

```ts
// neteaseapi/tracks.ts
export interface PlaylistDTO { id: number; name: string; liked: boolean; trackCount: number }
// TrackDTO 复用 P1（src/main/qqapi/tracks.ts）：{id:string,name,artist,album,cover,mediaMid?,duration?,vip?}
// 网易云映射：id=String(song.id)；artist=ar 数组 ' / ' 合并；cover=al.picUrl；vip=fee>0；mediaMid 无
export interface NeTrackDetail { date: string }   // 'YYYY-MM-DD' 或 ''
// neteaseAuth.ts
export interface NeAuthCookie { cookie: string }  // 完整 Cookie 头（含 MUSIC_U）
// urls.ts
export const NE_QUALITY_BR: Partial<Record<Quality, number>> = { flac: 0, '320': 320000, '128': 128000 }
export const NE_LADDER: Quality[] = ['flac', '320', '128']
export interface NeAudioUrlResult { url: string; quality: Quality; downgraded: boolean }
// dl:enqueue 新签名（P1 兼容：App.vue 与 tests 同步改）
// window.api.invoke('dl:enqueue', { tracks: TrackDTO[], quality: Quality, source: 'qq' | 'netease' })
```

---

### Task N1-1: neteaseapi 请求客户端

**Files:**
- Create: `src/main/neteaseapi/client.ts`
- Test: `tests/neteaseapi-client.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/neteaseapi-client.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { createNeClient } from '../src/main/neteaseapi/client'
import { QqApiError } from '../src/main/qqapi/client'

function jsonFetch(body: unknown): typeof fetch {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
}

describe('createNeClient', () => {
  it('GET 带 Referer/UA/cookie 并解析 JSON', async () => {
    const fetchMock = jsonFetch({ code: 200, playlist: [{ id: 1 }] })
    const client = createNeClient(fetchMock)
    client.setCookie('MUSIC_U=abc')
    const out = await client.getJson('https://music.163.com/api/user/playlist?uid=1')
    expect(out).toEqual({ code: 200, playlist: [{ id: 1 }] })
    const [url, init] = (fetchMock as any).mock.calls[0]
    expect(String(url)).toContain('api/user/playlist')
    expect(init.headers.referer).toBe('https://music.163.com/')
    expect(init.headers.cookie).toBe('MUSIC_U=abc')
    expect(init.headers['user-agent']).toContain('Firefox')
  })

  it('空响应（风控特征）抛 QqApiError(rate-limited)', async () => {
    const fetchMock = jsonFetch('')
    const client = createNeClient(fetchMock)
    await expect(client.getJson('https://music.163.com/api/x')).rejects.toThrow(/rate/i)
  })

  it('非 JSON 抛 QqApiError；网络错误重试后成功', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('{"ok":true}'))
    const client = createNeClient(fetchMock as any)
    expect(await client.getJson('https://music.163.com/api/x')).toEqual({ ok: true })
    expect((fetchMock as any).mock.calls.length).toBe(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/neteaseapi-client.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 client.ts**

```ts
import { QqApiError } from '../qqapi/client'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0'
const REFERER = 'https://music.163.com/'
const TIMEOUT_MS = 15000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface NeClient {
  /** 设置登录 cookie（完整 Cookie 头，含 MUSIC_U） */
  setCookie(cookie: string): void
  getCookie(): string
  /** GET JSON；QqApiError（风控/路径缺失等确定性错误）不重试，网络错误重试 2 次退避 1s/2s */
  getJson<T = unknown>(url: string): Promise<T>
}

export function createNeClient(fetchImpl: typeof fetch = fetch): NeClient {
  let cookie = ''

  function headers(): Record<string, string> {
    const h: Record<string, string> = { 'user-agent': UA, referer: REFERER, accept: 'application/json' }
    if (cookie) h['cookie'] = cookie
    return h
  }

  async function getJson<T = unknown>(url: string): Promise<T> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1))
      try {
        const res = await fetchImpl(url, { headers: headers(), redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
        const text = await res.text()
        if (!text || text.trim() === '') throw new QqApiError('rate-limited: 空响应（风控）', 'rate-limited')
        try {
          return JSON.parse(text) as T
        } catch {
          throw new QqApiError(`非 JSON 响应: ${text.slice(0, 80)}`, res.status)
        }
      } catch (err) {
        if (err instanceof QqApiError) throw err
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new QqApiError(String(lastErr))
  }

  return {
    setCookie(c) { cookie = c },
    getCookie() { return cookie },
    getJson,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/neteaseapi-client.test.ts`
Expected: PASS（3 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/main/neteaseapi/client.ts tests/neteaseapi-client.test.ts && git commit -m "feat: 网易云 GET 请求客户端（Referer/cookie/风控识别/重试）"
```

---

### Task N1-2: 数据层（搜索/歌单列表/歌单详情 + TrackDTO 映射）

**Files:**
- Create: `src/main/neteaseapi/tracks.ts`（neteaseTrackToDto + neGetTrackDetail + neSearch + neUserPlaylist + nePlaylistDetail 统一放此文件，避免碎片化）
- Test: `tests/neteaseapi-tracks.test.ts`
- Create: `tests/fixtures/netease/search.json`、`library.json`、`playlist-full.json`、`playlist-anon.json`、`song-detail.json`（形状对齐 2026-09-04 实测与真实响应结构）

- [ ] **Step 1: 写失败的测试**

`tests/neteaseapi-tracks.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createNeClient } from '../src/main/neteaseapi/client'
import { neSearch, neUserPlaylist, nePlaylistDetail, neGetTrackDetail, neteaseTrackToDto } from '../src/main/neteaseapi/tracks'

const fx = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'netease', n), 'utf-8')

function routedFetch(): typeof fetch {
  return vi.fn(async (input: any) => {
    const url = String(input)
    if (url.includes('/api/cloudsearch/pc')) return new Response(fx('search.json'))
    if (url.includes('/api/user/playlist')) return new Response(fx('library.json'))
    if (url.includes('/api/v6/playlist/detail')) {
      return url.includes('id=ANON') ? new Response(fx('playlist-anon.json')) : new Response(fx('playlist-full.json'))
    }
    if (url.includes('/api/song/detail')) return new Response(fx('song-detail.json'))
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
}

// 真实响应条目（2026-09-04 实测结构）的映射：id(number)/name/ar[{}]/al{}/fee
const rawSong = {
  id: 103027, name: '天空之城（钢琴版）（Cover 久石让）',
  ar: [{ id: 1, name: 'iw ix' }],
  al: { id: 2, name: '翻唱合集', picUrl: 'https://p1.music.126.net/x.jpg' },
  fee: 0, dt: 180000,
}

describe('neteaseTrackToDto', () => {
  it('映射为 TrackDTO（String(id)、多歌手合并、封面、vip=fee>0）', () => {
    const dto = neteaseTrackToDto({ ...rawSong, ar: [{ name: 'A' }, { name: 'B' }], fee: 1 })
    expect(dto.id).toBe('103027')
    expect(dto.artist).toBe('A / B')
    expect(dto.cover).toBe('https://p1.music.126.net/x.jpg')
    expect(dto.vip).toBe(true)
    expect(dto.name).toContain('天空之城')
  })
})

describe('neSearch', () => {
  it('cloudsearch/pc 解析成 TrackDTO[]', async () => {
    const client = createNeClient(routedFetch())
    const tracks = await neSearch(client, '天空之城')
    expect(tracks.length).toBeGreaterThan(0)
    expect(tracks[0].id).toBe('103027')
  })
})

describe('neUserPlaylist', () => {
  it('解析歌单列表，喜欢的置顶（specialType=5）', async () => {
    const client = createNeClient(routedFetch())
    const pls = await neUserPlaylist(client, 1597610302)
    expect(pls.length).toBeGreaterThan(0)
    expect(pls[0].liked).toBe(true)
    expect(pls[0].name).toBe('我喜欢的音乐')
  })
})

describe('nePlaylistDetail', () => {
  it('匿名歌单（trackCount=0/tracks 空）返回 requiresLogin=true', async () => {
    const client = createNeClient(routedFetch())
    const r = await nePlaylistDetail(client, 'ANON')
    expect(r.tracks).toEqual([])
    expect(r.requiresLogin).toBe(true)
  })
  it('登录态歌单返回全量曲目', async () => {
    const client = createNeClient(routedFetch())
    const r = await nePlaylistDetail(client, '2418667007')
    expect(r.requiresLogin).toBe(false)
    expect(r.tracks.length).toBeGreaterThan(0)
    expect(r.tracks[0].id).toBe('103027')
  })
})

describe('neGetTrackDetail', () => {
  it('song/detail 取 date（YYYY-MM-DD）', async () => {
    const client = createNeClient(routedFetch())
    const d = await neGetTrackDetail(client, 103027)
    expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
```

- [ ] **Step 2: 造 fixture 并跑测试确认失败**

fixture 形状（对齐真实响应）：

- `search.json`：`{"result":{"songs":[{"id":103027,"name":"天空之城（钢琴版）（Cover 久石让）","ar":[{"id":1,"name":"iw ix"}],"al":{"id":2,"name":"翻唱合集","picUrl":"https://p1.music.126.net/x.jpg"},"fee":0,"dt":180000},{"id":421423022,"name":"天空之城 (Live)","ar":[{"name":"蒋敦豪"}],"al":{"picUrl":"https://p1.music.126.net/y.jpg","name":"专辑"},"fee":1,"dt":200000}]},"code":200}`
- `library.json`：`{"code":200,"playlist":[{"id":2418667007,"name":"我喜欢的音乐","specialType":5,"trackCount":0},{"id":888,"name":"测试歌单","specialType":0,"trackCount":20}]}`（对齐 2026-09-04 实测：specialType=5、匿名 trackCount=0）
- `playlist-full.json`：`{"playlist":{"id":2418667007,"name":"我喜欢的音乐","trackCount":1,"tracks":[{"id":103027,"name":"天空之城（钢琴版）（Cover 久石让）","ar":[{"name":"iw ix"}],"al":{"name":"翻唱合集","picUrl":"https://p1.music.126.net/x.jpg"},"fee":0,"dt":180000}]},"code":200}`
- `playlist-anon.json`：`{"playlist":{"id":2418667007,"name":"我喜欢的音乐","trackCount":0,"tracks":[]},"code":200}`
- `song-detail.json`：`{"songs":[{"id":103027,"name":"天空之城","album":{"name":"翻唱合集","publishTime":1588262400000}}],"code":200}`

Run: `npx vitest run tests/neteaseapi-tracks.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 tracks.ts**

```ts
import type { TrackDTO } from '../qqapi/tracks'
import type { NeClient } from './client'

export interface PlaylistDTO { id: number; name: string; liked: boolean; trackCount: number }
export interface NeTrackDetail { date: string }
export interface NePlaylistResult { tracks: TrackDTO[]; requiresLogin: boolean }

export function neteaseTrackToDto(s: any): TrackDTO {
  const ar: any[] = s?.ar ?? []
  return {
    id: String(s.id),
    name: s?.name ?? '',
    artist: ar.map((x) => x?.name ?? '').filter(Boolean).join(' / ') || '未知歌手',
    album: s?.al?.name ?? '',
    cover: s?.al?.picUrl ?? '',
    duration: typeof s?.dt === 'number' ? Math.round(s.dt / 1000) : undefined,
    vip: (s?.fee ?? 0) > 0,
  }
}

export async function neSearch(client: NeClient, q: string, limit = 20): Promise<TrackDTO[]> {
  const json = await client.getJson<{ result?: { songs?: any[] } }>(
    `https://music.163.com/api/cloudsearch/pc?type=1&s=${encodeURIComponent(q)}&limit=${limit}&offset=0`,
  )
  return (json?.result?.songs ?? []).filter((s) => s?.id).map(neteaseTrackToDto)
}

export async function neUserPlaylist(client: NeClient, uid: number): Promise<PlaylistDTO[]> {
  const json = await client.getJson<{ code?: number; playlist?: any[] }>(
    `https://music.163.com/api/user/playlist?uid=${uid}&limit=200&offset=0`,
  )
  const list = (json?.playlist ?? [])
    .filter((p) => p?.id)
    .map((p) => ({
      id: p.id,
      name: p.name ?? '',
      liked: p.specialType === 5,
      trackCount: p.trackCount ?? 0,
    }))
  return list.sort((a, b) => Number(b.liked) - Number(a.liked))
}

export async function nePlaylistDetail(client: NeClient, id: string): Promise<NePlaylistResult> {
  const json = await client.getJson<{ playlist?: { trackCount?: number; tracks?: any[] } }>(
    `https://music.163.com/api/v6/playlist/detail/?id=${id}`,
  )
  const tracks = (json?.playlist?.tracks ?? []).filter((t) => t?.id).map(neteaseTrackToDto)
  const trackCount = json?.playlist?.trackCount ?? 0
  return { tracks, requiresLogin: tracks.length === 0 && trackCount === 0 }
}

export async function neGetTrackDetail(client: NeClient, id: number): Promise<NeTrackDetail> {
  try {
    const json = await client.getJson<{ songs?: any[] }>(
      `https://music.163.com/api/song/detail/?id=${id}&ids=[${id}]`,
    )
    const t = json?.songs?.[0]
    const ms = t?.album?.publishTime
    if (typeof ms === 'number' && ms > 0) {
      return { date: new Date(ms).toISOString().slice(0, 10) }
    }
    return { date: '' }
  } catch {
    return { date: '' }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/neteaseapi-tracks.test.ts tests/neteaseapi-client.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/neteaseapi/tracks.ts tests/neteaseapi-tracks.test.ts tests/fixtures/netease/ && git commit -m "feat: 网易云数据层（搜索/歌单列表/歌单详情/单曲日期 + TrackDTO 映射）"
```

---

### Task N1-3: 直链（质量映射 + 降级链）与歌词

**Files:**
- Create: `src/main/neteaseapi/urls.ts`
- Create: `src/main/neteaseapi/lyric.ts`
- Test: `tests/neteaseapi-urls.test.ts`, `tests/neteaseapi-lyric.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/neteaseapi-urls.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { createNeClient } from '../src/main/neteaseapi/client'
import { NE_QUALITY_BR, NE_LADDER, neGetAudioUrl } from '../src/main/neteaseapi/urls'

function urlFetch(script: Array<{ url: string | null; br: number }>): typeof fetch {
  // 每收到一次 player/url 请求，返回 script 里对应次序的响应
  let i = 0
  return vi.fn(async (input: any) => {
    const u = String(input)
    if (!u.includes('/api/song/enhance/player/url')) return new Response('{}')
    const s = script[Math.min(i++, script.length - 1)] ?? script[script.length - 1]
    const data = s.url
      ? [{ id: 1, url: s.url, br: s.br, code: 200 }]
      : [{ id: 1, url: null, br: s.br, code: 200 }]
    return new Response(JSON.stringify({ code: 200, data }))
  }) as unknown as typeof fetch
}

describe('NE_QUALITY_BR / NE_LADDER', () => {
  it('三档映射与降级顺序', () => {
    expect(NE_QUALITY_BR.flac).toBe(0)
    expect(NE_QUALITY_BR['320']).toBe(320000)
    expect(NE_QUALITY_BR['128']).toBe(128000)
    expect(NE_LADDER).toEqual(['flac', '320', '128'])
  })
})

describe('neGetAudioUrl', () => {
  it('320 直接命中', async () => {
    const client = createNeClient(urlFetch([{ url: 'https://m10.music.126.net/1.mp3?x=1', br: 320000 }]))
    const r = await neGetAudioUrl(client, 103027, '320')
    expect(r.url).toContain('https://m10.music.126.net/1.mp3')
    expect(r.quality).toBe('320')
    expect(r.downgraded).toBe(false)
  })

  it('无损空 → 降 320 → 128（标记 downgraded）', async () => {
    const client = createNeClient(urlFetch([
      { url: null, br: 0 },
      { url: 'https://m10.music.126.net/320.mp3', br: 320000 },
    ]))
    const r = await neGetAudioUrl(client, 103027, 'flac')
    expect(r.quality).toBe('320')
    expect(r.downgraded).toBe(true)
  })

  it('全部空 → 抛 QqApiError（no-playable-url）', async () => {
    const client = createNeClient(urlFetch([{ url: null, br: 0 }]))
    const err = await neGetAudioUrl(client, 103027, 'flac').catch((e) => e)
    expect(err.code).toBe('no-playable-url')
  })

  it('ape/m4a 请求档不在支持表 → 从 320 起试', async () => {
    const client = createNeClient(urlFetch([{ url: 'https://m10.music.126.net/320.mp3', br: 320000 }]))
    const r = await neGetAudioUrl(client, 103027, 'ape')
    expect(r.quality).toBe('320')
    expect(r.downgraded).toBe(true)
  })
})
```

`tests/neteaseapi-lyric.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { createNeClient } from '../src/main/neteaseapi/client'
import { neFetchLyric } from '../src/main/neteaseapi/lyric'

describe('neFetchLyric', () => {
  it('lrc.lyric 解出文本', async () => {
    const body = JSON.stringify({ lrc: { lyric: '[00:01.00]第一行\n[ti:测试]' }, tlyric: { lyric: '' } })
    const fetchMock = vi.fn(async () => new Response(body)) as unknown as typeof fetch
    const client = createNeClient(fetchMock)
    expect(await neFetchLyric(client, 103027)).toContain('[00:01.00]第一行')
  })
  it('无歌词/异常 → 空串', async () => {
    const fetchMock = vi.fn(async () => new Response('{}')) as unknown as typeof fetch
    const client = createNeClient(fetchMock)
    expect(await neFetchLyric(client, 103027)).toBe('')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/neteaseapi-urls.test.ts tests/neteaseapi-lyric.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 urls.ts 与 lyric.ts**

`src/main/neteaseapi/urls.ts`：

```ts
import { QqApiError } from '../qqapi/client'
import type { Quality } from '../qqapi/tracks'
import type { NeClient } from './client'

// 网易云 br 档位：0=无损(flac)、320000、128000。ape/m4a 无对应档位。
export const NE_QUALITY_BR: Partial<Record<Quality, number>> = { flac: 0, '320': 320000, '128': 128000 }
export const NE_LADDER: Quality[] = ['flac', '320', '128']

export interface NeAudioUrlResult { url: string; quality: Quality; downgraded: boolean }

export async function neGetAudioUrl(
  client: NeClient,
  id: number,
  preferred: Quality,
): Promise<NeAudioUrlResult> {
  // ape/m4a 不支持 → 从 320 起
  const startIdx = NE_QUALITY_BR[preferred] !== undefined ? NE_LADDER.indexOf(preferred) : 1
  for (let i = Math.max(0, startIdx); i < NE_LADDER.length; i++) {
    const q = NE_LADDER[i]
    const br = NE_QUALITY_BR[q]!
    const json = await client.getJson<{ code?: number; data?: Array<{ url?: string | null; br?: number }> }>(
      `https://music.163.com/api/song/enhance/player/url?ids=[${id}]&br=${br}`,
    )
    const url = json?.data?.[0]?.url
    if (url) return { url, quality: q, downgraded: i > startIdx }
  }
  throw new QqApiError('未拿到可播放 URL（可能无版权/未上架，VIP 歌需登录，无损需会员权益）', 'no-playable-url')
}
```

`src/main/neteaseapi/lyric.ts`：

```ts
import type { NeClient } from './client'

/** 歌词（lrc.lyric）；失败/缺失返回空串，不阻塞下载 */
export async function neFetchLyric(client: NeClient, id: number): Promise<string> {
  try {
    const json = await client.getJson<{ lrc?: { lyric?: string } }>(
      `https://music.163.com/api/song/lyric?os=pc&id=${id}&lv=-1&tv=1`,
    )
    return json?.lrc?.lyric ?? ''
  } catch {
    return ''
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/neteaseapi-urls.test.ts tests/neteaseapi-lyric.test.ts`
Expected: PASS（6 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/main/neteaseapi/urls.ts src/main/neteaseapi/lyric.ts tests/neteaseapi-urls.test.ts tests/neteaseapi-lyric.test.ts && git commit -m "feat: 网易云直链（br 映射/降级链）与歌词"
```

---

### Task N2: 网易云登录（cookie 持久化/导入/开窗抓取）

**Files:**
- Create: `src/main/neteaseAuth.ts`
- Modify: `src/main/app.ts`（组装 neAuth + ne:auth 业务函数）
- Modify: `src/main/index.ts`（`ne:auth:open` 开窗扫码 IPC + `ne:auth:importCookie`/`ne:auth:status`/`ne:auth:clear` 注册）
- Test: `tests/neteaseAuth.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/neteaseAuth.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNeAuth, buildCookieHeader, cookieHeaderHasMusicU } from '../src/main/neteaseAuth'

describe('buildCookieHeader', () => {
  it('cookies 数组拼成 Cookie 头', () => {
    const h = buildCookieHeader([
      { name: 'MUSIC_U', value: 'abc' },
      { name: '__csrf', value: 'c' },
    ])
    expect(h).toBe('MUSIC_U=abc; __csrf=c')
  })
})

describe('cookieHeaderHasMusicU', () => {
  it('含 MUSIC_U 判定登录态', () => {
    expect(cookieHeaderHasMusicU('MUSIC_U=abc; x=1')).toBe(true)
    expect(cookieHeaderHasMusicU('__csrf=1')).toBe(false)
  })
})

describe('createNeAuth', () => {
  it('importCookie 需含 MUSIC_U；成功落盘且状态 loggedIn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nea-'))
    const file = path.join(dir, 'net_cookie.json')
    const auth = createNeAuth({ cookiePath: file })
    expect(auth.importCookie('__csrf=z')).toBe(false)
    expect(auth.getStatus().loggedIn).toBe(false)
    expect(auth.importCookie('MUSIC_U=abc; __csrf=z')).toBe(true)
    expect(auth.getStatus().loggedIn).toBe(true)
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(saved.cookie).toContain('MUSIC_U=abc')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('损坏文件容错按未登录；clear 删除文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nea2-'))
    const file = path.join(dir, 'net_cookie.json')
    fs.writeFileSync(file, 'broken{{{')
    const auth = createNeAuth({ cookiePath: file })
    expect(auth.getStatus().loggedIn).toBe(false)
    auth.importCookie('MUSIC_U=1')
    expect(fs.existsSync(file)).toBe(true)
    auth.clear()
    expect(auth.getStatus().loggedIn).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/neteaseAuth.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 neteaseAuth.ts**

```ts
import fs from 'node:fs'
import path from 'node:path'

export interface NeAuthCookie { cookie: string }
export interface NeAuthStatus { loggedIn: boolean }
export interface NeAuth {
  /** 完整 Cookie 头的持久化 cookie；空串表示未登录 */
  getCookie(): string
  getStatus(): NeAuthStatus
  importCookie(header: string): boolean
  saveCookie(header: string): void
  clear(): void
}

export function buildCookieHeader(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

export function cookieHeaderHasMusicU(header: string): boolean {
  return header.split(';').some((p) => p.trim().startsWith('MUSIC_U='))
}

export function createNeAuth(opts: { cookiePath: string }): NeAuth {
  const read = (): NeAuthCookie | null => {
    try {
      const raw = JSON.parse(fs.readFileSync(opts.cookiePath, 'utf-8'))
      if (raw && typeof raw.cookie === 'string' && cookieHeaderHasMusicU(raw.cookie)) return raw
      return null
    } catch {
      return null
    }
  }
  const write = (cookie: string): void => {
    fs.mkdirSync(path.dirname(opts.cookiePath), { recursive: true })
    fs.writeFileSync(opts.cookiePath, JSON.stringify({ cookie }, null, 2), 'utf-8')
  }

  return {
    getCookie() { return read()?.cookie ?? '' },
    getStatus() { return { loggedIn: read() !== null } },
    importCookie(header) {
      if (!cookieHeaderHasMusicU(header)) return false
      write(header)
      return true
    },
    saveCookie(header) { write(header) },
    clear() { fs.rmSync(opts.cookiePath, { force: true }) },
  }
}
```

- [ ] **Step 4: app.ts 与 index.ts 装配**

`src/main/app.ts`（createApp 内新增，`AppDeps` 不变）：

```ts
import { createNeClient } from './neteaseapi/client'
import { neSearch, neUserPlaylist, nePlaylistDetail, neGetTrackDetail, neAccount } from './neteaseapi/tracks'
import { neFetchLyric } from './neteaseapi/lyric'
import { neGetAudioUrl } from './neteaseapi/urls'
import { createNeAuth } from './neteaseAuth'

// createApp 内：
const neClient = createNeClient(fetchImpl)
const neAuth = createNeAuth({ cookiePath: path.join(deps.userDataDir, 'netease_cookie.json') })
const savedNe = neAuth.getCookie()
if (savedNe) neClient.setCookie(savedNe)
```

runner 内按 source 分流（替换现有 runner 为）：

```ts
runner: async (job, report) => {
  if (job.source === 'netease') {
    return runNeteaseJob(job, report)   // 见下
  }
  // ... 现有 QQ 逻辑不动 ...
}
```

新增私有函数（createApp 闭包内）：

```ts
async function runNeteaseJob(job: DownloadJob, report: (pct: number) => void): Promise<{ outputPath: string }> {
  const id = Number(job.track.id)
  if (!Number.isFinite(id)) throw new Error(`非法的网易云歌曲 ID: ${job.track.id}`)
  // 1) 直链（登录 cookie 由 neClient 携带；无损→320→128 降级）
  const first = await neGetAudioUrl(neClient, id, job.quality)
  if (first.downgraded) job.downgraded = true
  const ext = first.quality === 'flac' ? 'flac' : 'mp3'
  const name = `${safeName(job.track.name)} - ${safeName(job.track.artist)}`
  let dest = uniquePath(path.join(settings.downloadDir, `${name}.${ext}`))
  fs.mkdirSync(settings.downloadDir, { recursive: true })
  while (true) {
    try {
      const fd = fs.openSync(dest, 'wx'); fs.closeSync(fd); break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      dest = uniquePath(dest)
    }
  }
  try {
    await downloadFile(first.url, dest, { retries: 2, onProgress: (got, total) => {
      report(total > 0 ? Math.round((got / total) * 100) : Math.min(99, Math.round(got / 1e6)))
    } })
  } catch (err) {
    fs.rmSync(dest, { force: true })
    const fresh = await neGetAudioUrl(neClient, id, job.quality)   // 直链过期/网络抖动重取
    await downloadFile(fresh.url, dest)
  }
  try {
    const detail = await neGetTrackDetail(neClient, id)
    const meta = {
      title: job.track.name, artist: job.track.artist,
      album: job.track.album || '未知专辑', date: detail.date,
      copyright: '', genre: '',
      lyrics: settings.lyricMode !== 'none' ? await neFetchLyric(neClient, id) : '',
      cover: (await fetchCover(job.track.cover, fetchImpl))?.data,
      coverMime: (await fetchCover(job.track.cover, fetchImpl))?.mime,
    }
    await tagFile(dest, meta, { saveLrc: settings.lyricMode === 'both' || settings.lyricMode === 'lrc' })
  } catch (e) {
    fs.rmSync(dest, { force: true })
    fs.rmSync(dest.replace(/\.(mp3|flac)$/i, '.lrc'), { force: true })
    throw e
  }
  return { outputPath: dest }
}
```

（fetchCover 被调用两次可接受亦可缓存；实现时缓存一次即可。）

`createApp` 返回对象新增：

```ts
neSearch: (q: string) => neSearch(neClient, q),
neLibrary: () => {
  // 未登录无法确定性拿 uid：由 index.ts 开窗抓 cookie 后状态已更新；uid 从 nuser/account/get 获取
  return neAccount(neClient)
},
nePlaylist: (id: string) => nePlaylistDetail(neClient, id),
neAuthImport: (header: string) => {
  const ok = neAuth.importCookie(header)
  if (ok) neClient.setCookie(header)
  return ok
},
neAuthStatus: () => neAuth.getStatus(),
neAuthClear: () => { neAuth.clear(); neClient.setCookie('') },
neAuthSaveFromWindow: (header: string) => { neAuth.saveCookie(header); neClient.setCookie(header) },
```

`neteaseapi/tracks.ts` 追加 `neAccount`（登录态取 uid）+ 测试（fixture `account.json`）：

```ts
export type NeAccount = { uid: number; nickname: string } | null
export async function neAccount(client: NeClient): Promise<NeAccount | null> {
  try {
    const json = await client.getJson<{ profile?: { userId?: number; nickname?: string } }>(
      'https://music.163.com/api/nuser/account/get',
    )
    const p = json?.profile
    if (p?.userId) return { uid: p.userId, nickname: p.nickname ?? '' }
    return null
  } catch {
    return null
  }
}
```

`src/main/index.ts` 新增：

```ts
ipcMain.handle('ne:search', (_e, q: string) => appInstance.neSearch(q))
ipcMain.handle('ne:account', () => appInstance.neLibrary())
ipcMain.handle('ne:playlist', (_e, id: string) => appInstance.nePlaylist(id))
ipcMain.handle('ne:auth:importCookie', (_e, c: string) => appInstance.neAuthImport(c))
ipcMain.handle('ne:auth:status', () => appInstance.neAuthStatus())
ipcMain.handle('ne:auth:clear', () => appInstance.neAuthClear())
ipcMain.handle('ne:auth:open', async () => {
  // 开窗扫码：加载 music.163.com/login，用户登录后窗口关闭即抓 cookie
  const { BrowserWindow, session } = await import('electron')
  const win = new BrowserWindow({ width: 900, height: 700, autoHideMenuBar: true })
  await win.loadURL('https://music.163.com/login')
  win.on('closed', () => {
    void (async () => {
      const cookies = await session.defaultSession.cookies.get({ url: 'https://music.163.com' })
      const header = buildCookieHeader(cookies.filter((c) => c.name === 'MUSIC_U' || c.name === '__csrf'))
      if (cookieHeaderHasMusicU(header)) {
        appInstance.neAuthSaveFromWindow(header)
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ne:authChanged', true)
      }
    })()
  })
  return true
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run`（全部）
Expected: PASS（原有 80 + neteaseAuth 3 + account 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/main/neteaseAuth.ts src/main/neteaseapi/tracks.ts src/main/app.ts src/main/index.ts tests/neteaseAuth.test.ts tests/fixtures/netease/account.json && git commit -m "feat: 网易云登录（cookie 持久化/导入/开窗扫码抓取）+ 账号 uid"
```

---

### Task N3: dl:enqueue 带 source + runner 网易云分支 + 渲染器网易云 Tab

**Files:**
- Modify: `src/main/app.ts`（enqueue 签名）
- Modify: `src/main/index.ts`（dl:enqueue 参数解析）
- Modify: `src/renderer/src/App.vue`（四 Tab + enqueue 带 source）
- Create: `src/renderer/src/components/NeteaseTab.vue`
- Modify: `src/main/settings.ts`（无需改；歌词模式/目录/码率共享）
- Test: `tests/app.test.ts`（新增网易云 runner 用例）、`tests/renderer-enqueue.test.ts`（可并入 renderer-store 或新建）

- [ ] **Step 1: 写失败的测试**

`tests/app.test.ts` 追加（沿用既有 local http server + routedFetch 模式；网易云直链 mock 返回本地 server URL）：

```ts
it('netease 任务走网易云管线：直链→下载→标签→done', async () => {
  // routedFetch 增加：
  //   /api/song/enhance/player/url → {code:200,data:[{url: LOCAL_URL_320, br:320000, code:200}]}（LOCAL_URL_320 指向本地 http server）
  //   /api/song/lyric → {lrc:{lyric:'[00:01.00]测试歌词'}}
  //   /api/song/detail → {songs:[{album:{publishTime:1588262400000}}]}
  // enqueue({tracks:[{id:'123',name:'歌',artist:'手',album:'专',cover:''}], quality:'320', source:'netease'})
  // waitIdle → 断言 jobDone、输出文件存在、music-metadata 读回 title='歌'、
  //   lyrics 内嵌（USLT 或 LYRICS 键，取决于扩展名——320 是 mp3 → USLT 含 '测试歌词'）
})
```

`tests/renderer-store.test.ts` 追加 1 用例（netease source 的队列事件镜像）：

```ts
it('netease source 的队列事件镜像', () => {
  const s = useDownloadStore()
  s.onQueueEvent({ id: 'n1', source: 'netease', state: 'running', progress: 0, track: { name: 'N', artist: 'A' } })
  expect(s.queue[0].source).toBe('netease')
  expect(s.queue[0].name).toBe('N')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app.test.ts tests/renderer-store.test.ts`
Expected: FAIL（enqueue 新签名未实现 / netease 分支未实现）。

- [ ] **Step 3: 实现**

`src/main/app.ts` enqueue 签名变更：

```ts
enqueue: (payload: { tracks: TrackDTO[]; quality: Settings['quality']; source: 'qq' | 'netease' }) => {
  const { tracks, quality, source } = payload
  const seen = new Set<string>()
  queue.enqueue(tracks.filter((t) => { if (seen.has(t.id)) return false; seen.add(t.id); return true }).map((t) => ({
    id: t.id, source, track: t, quality, state: 'queued' as const, progress: 0,
  })))
  return true
},
```

`src/main/index.ts`：

```ts
ipcMain.handle('dl:enqueue', (_e, payload: unknown) => appInstance.enqueue(payload as any))
ipcMain.handle('ne:playlists', (_e, uid: number) => appInstance.nePlaylists(uid))
```

`src/main/app.ts` 补：`nePlaylists: (uid: number) => neUserPlaylist(neClient, uid)`（N2 已写 neLibrary → 改名/保留均可，以这里为准，返回值即 PlaylistDTO[]）。

`src/renderer/src/App.vue`：enqueue 调用改 `window.api.invoke('dl:enqueue', { tracks: selected, quality: store.quality, source: 'qq' })`；Tab 增「网易云」并挂 `NeteaseTab`。

`src/renderer/src/components/NeteaseTab.vue`（本地状态自持，不复用 download store 的 tracks/selectedIds，避免与 QQ Tab 互相污染；仅复用 store.quality 与 store.onQueueEvent 展示）：

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import TrackGrid from './TrackGrid.vue'
import { useDownloadStore } from '../stores/download'

interface NePlaylist { id: number; name: string; liked: boolean; trackCount: number }
interface NeTrack { id: string; name: string; artist: string; album: string; cover: string; vip?: boolean }

const store = useDownloadStore()
const loggedIn = ref(false)
const nickname = ref('')
const playlists = ref<NePlaylist[]>([])
const currentTracks = ref<NeTrack[]>([])
const selectedIds = ref(new Set<string>())
const q = ref('')
const error = ref('')
const cookieText = ref('')
const showImport = ref(false)

async function refreshAuth() {
  const s: any = await (window as any).api.invoke('ne:auth:status')
  loggedIn.value = s.loggedIn
  if (s.loggedIn) {
    const acc: any = await (window as any).api.invoke('ne:account')
    if (acc) { nickname.value = acc.nickname; void loadPlaylists(acc.uid) }
  }
}

async function loadPlaylists(uid: number) {
  const pls: any = await (window as any).api.invoke('ne:playlists', uid)
  playlists.value = pls ?? []
}

async function openPlaylist(id: number) {
  error.value = ''
  const r: any = await (window as any).api.invoke('ne:playlist', String(id))
  currentTracks.value = r.tracks ?? []
  selectedIds.value = new Set()
  if (r.requiresLogin && !loggedIn.value) error.value = '未登录，登录后查看完整曲目'
}

async function doSearch() {
  error.value = ''
  const tracks: any = await (window as any).api.invoke('ne:search', q.value.trim())
  currentTracks.value = tracks ?? []
  selectedIds.value = new Set()
}

function toggleSel(id: string) {
  const s = new Set(selectedIds.value)
  if (s.has(id)) s.delete(id); else s.add(id)
  selectedIds.value = s
}

function selectAll() { selectedIds.value = new Set(currentTracks.value.map((t) => t.id)) }

function enqueue() {
  const selected = currentTracks.value.filter((t) => selectedIds.value.has(t.id))
  if (selected.length) {
    void (window as any).api.invoke('dl:enqueue', { tracks: selected, quality: store.quality, source: 'netease' })
    selectedIds.value = new Set()
  }
}

async function openLogin() { await (window as any).api.invoke('ne:auth:open') }

async function doImportCookie() {
  const ok: boolean = await (window as any).api.invoke('ne:auth:importCookie', cookieText.value)
  if (ok) { cookieText.value = ''; showImport.value = false; void refreshAuth() }
  else { error.value = 'Cookie 无效（需含 MUSIC_U）' }
}

onMounted(() => {
  void refreshAuth()
  ;(window as any).api.on('ne:authChanged', () => void refreshAuth())
})
</script>

<template>
  <div class="netease">
    <header>
      <h2>网易云</h2>
      <span v-if="loggedIn">已登录：{{ nickname }}</span>
      <template v-else>
        <button @click="openLogin">扫码登录</button>
        <button @click="showImport = !showImport">手动导入 Cookie</button>
      </template>
    </header>
    <div v-if="showImport" class="import">
      <textarea v-model="cookieText" rows="3" placeholder="粘贴 music.163.com 的 Cookie 头（需含 MUSIC_U）" />
      <button @click="doImportCookie">导入</button>
    </div>
    <p v-if="error" class="err">{{ error }}</p>
    <div class="tools">
      <input v-model="q" placeholder="歌名 / 歌手" @keyup.enter="doSearch" />
      <button @click="doSearch">搜索</button>
    </div>
    <aside v-if="loggedIn">
      <h3>我的歌单</h3>
      <ul>
        <li v-for="pl in playlists" :key="pl.id" @click="openPlaylist(pl.id)">
          {{ pl.liked ? '❤ ' : '' }}{{ pl.name }}（{{ pl.trackCount }}）
        </li>
      </ul>
    </aside>
    <div class="grid">
      <button :disabled="selectedIds.size === 0" @click="enqueue">下载选中 ({{ selectedIds.size }})</button>
      <button @click="selectAll">全选</button>
      <TrackGrid :tracks="currentTracks" :selected-ids="selectedIds" @toggle="toggleSel" />
    </div>
  </div>
</template>
```

（手动导入用内联 textarea，不用 `window.prompt`——Electron 不实现它，P1 LoginButton 已踩过。）

- [ ] **Step 4: 跑测试确认通过 + 冒烟**

Run: `npx vitest run` 全绿；`npm run typecheck` 通过；`npm run dev` 冒烟（窗口四 Tab 可切换，网易云 Tab 未登录可搜索；登录流程留 N4 验收）。

- [ ] **Step 5: 提交**

```bash
git add src/main/app.ts src/main/index.ts src/renderer/src/App.vue src/renderer/src/components/NeteaseTab.vue tests/ && git commit -m "feat: dl:enqueue 带 source + 网易云 Tab（搜索/歌单/批量入队）"
```

---

### Task N4: 集成验收

**Files:**
- Create: `docs/acceptance-netease.md`

- [ ] **Step 1: 自动化回归**

Run: `npx vitest run` + `npm run typecheck`
Expected: 全绿。

- [ ] **Step 2: 手工验收清单（按 spec §8，逐项记录结果）**

1. 真实开窗扫码登录网易云 → 状态变已登录、`userData/netease_cookie.json` 生成（含 MUSIC_U）
2. 「我喜欢的音乐」显示全量曲目（登录态）→ 勾选 20 首 → 320k 批量下载全部成功（观察 1rps 限速）
3. foobar2000（ESLyric 组件）打开网易云产物：歌词显示；Musicolet 显示内嵌歌词 / .lrc 同步
4. 设置页码率=无损时网易云任务：有权益拿 flac、无权益降 320 且队列黄条
5. 匿名（未登录）搜索免费歌 → 320k 可下；VIP 歌提示登录
6. 与 QQ Tab 并存：QQ 歌单与网易云歌单互不干扰（各自选中态、同队列展示）

- [ ] **Step 3: 记录结果并提交**

```bash
git add docs/acceptance-netease.md && git commit -m "docs: P2 网易云模块验收记录"
```

---

### 超出本计划（后续）

- 网易云一键「喜欢/取消喜欢」（写操作走 weapi 加密，需新计划）
- 歌单/专辑链接解析（网易云侧 y.music.163.com 链接）——当前入口是「登录后浏览」与搜索，未覆盖链接粘贴
- mgg 解密、ogg 标签（P1 解密计划范围）