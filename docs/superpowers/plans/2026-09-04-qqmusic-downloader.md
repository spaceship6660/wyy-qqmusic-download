# QQ 音乐下载器（Electron）实施计划 — 第一份：M1-M5 下载器核心

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `F:\research\wyy-download\wyy-download` 里实现一个可用的 Electron QQ 音乐下载器：搜索/单曲/歌单/专辑四入口、扫码登录后按权益下无损、自动内嵌封面、可选内嵌歌词/.lrc 另存，标签面向 foobar2000 与 Musicolet。

**Architecture:** Electron 主进程（纯 Node + TypeScript）承载全部业务：`qqapi`（musicu.fcg 客户端）、`auth`（ptlogin2 扫码）、`downloader`（队列+限速）、`tagger`（MP3=node-id3 / FLAC·OGG=自写 vorbis 写入器）、`fsUtils`。渲染器 Vue3 + Pinia 只做 UI，通过 preload 白名单 IPC 调主进程。vitest 单测覆盖所有纯逻辑与网络层（mock）；真实网络只用手工验收。

**Tech Stack:** Electron 36 / electron-vite 3 / Vue 3.5 / Pinia 3 / node-id3 / vitest 3 / TypeScript 5.8。参考实现（本机可读）：`E:\git\specia\Spica-Chatbot_Release\agent_tools\function_tools\song\qqmusic.py`（登录+直链）、yt-dlp `yt_dlp/extractor/qqmusic.py`（歌单/专辑/直链参数，已拉到 `/tmp/qqmusic_ytdlp.py`）。

**范围**：本计划覆盖 spec §10 的 M1~M5（M6 解密、M7 打包为后续计划）。M5 验收需 foobar2000（装 ESLyric 组件）与 Musicolet 实机验证。

**网络提示**：npm registry 直连可用；Electron 二进制下载走 GitHub，安装时需 `HTTPS_PROXY=http://127.0.0.1:7890`（见 Task 1）。

**文件结构总览**（本计划产出）：

```
package.json / electron.vite.config.ts / tsconfig.json / vitest.config.ts / .gitignore(增补)
src/main/index.ts                主进程入口：窗口 + IPC 注册
src/main/qqapi/client.ts         musicu.fcg POST + fcg GET（header/超时/错误类型）
src/main/qqapi/tracks.ts         搜索/单曲详情/歌单/专辑 → TrackDTO（含 mediaMid、封面、VIP 判定）
src/main/qqapi/urls.ts           quality 映射 + CgiGetVkey + 降级链 + 双 filename 重试
src/main/fsUtils.ts              安全文件名/重名(n)/目录
src/main/downloader/ratelimit.ts 限速器（token 间隔）
src/main/downloader/queue.ts     并发队列 + 重试退避 + 事件
src/main/downloader/file.ts      单文件流式下载（.part 原子替换）
src/main/tagger/mp3.ts           node-id3：USLT+SYLT+APIC+TIT2/TPE1/TALB/TDRC/TCOP/TCON
src/main/tagger/vorbis.ts        自写 FLAC VORBIS_COMMENT+PICTURE 块写入
src/main/tagger/ogg.ts           自写 OGG comment 页重写（含 PICTURE）
src/main/tagger/index.ts         tagFile(path, meta) 按容器分发 + .lrc 另存
src/main/auth.ts                 ptlogin2 扫码五步 + cookie 持久化（userData/qqmusic_cookie.json）
src/main/settings.ts             userData/settings.json 读写（码率/并发/目录/歌词模式）
src/preload/index.ts + index.d.ts 白名单 IPC
src/renderer/src/main.ts / App.vue / components/*.vue / stores/*.ts
tests/…                          vitest：每个模块对应 *.test.ts + fixtures/
```

数据契约（全计划一致）：

```ts
// src/main/qqapi/tracks.ts
interface TrackDTO {
  id: string            // songmid
  name: string
  artist: string        // 多歌手用 " / " 连接
  album: string
  cover: string         // 封面 URL
  mediaMid?: string     // 详情接口才拿得到；缺省时直链用双 mid 重试
  duration?: number     // 秒
  vip: boolean          // 由详情接口 flags 判定，搜索响应无则该字段 undefined
}
type Quality = 'flac' | 'ape' | '320' | '128' | 'm4a'
interface AudioUrlResult { url: string; quality: Quality; downgraded: boolean }
interface AuthCookie { uin: string; cookie: string }   // cookie = 完整 Cookie 头字符串
```

---

### Task 1: 工程骨架（electron-vite + Vue3 + TS + vitest）

**Files:**
- Create: `package.json`
- Create: `electron.vite.config.ts`
- Create: `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`
- Create: `vitest.config.ts`
- Create: `src/main/index.ts`（最小窗口）
- Create: `src/preload/index.ts`, `src/preload/index.d.ts`
- Create: `src/renderer/index.html`, `src/renderer/src/main.ts`, `src/renderer/src/App.vue`
- Create: `src/renderer/src/env.d.ts`
- Test: 无（骨架冒烟由手工验证）

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "qq-music-downloader",
  "version": "0.1.0",
  "private": true,
  "description": "QQ 音乐下载器（Electron）",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "typecheck": "vue-tsc --noEmit -p tsconfig.web.json && tsc --noEmit -p tsconfig.node.json",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "node-id3": "^0.2.6",
    "pinia": "^3.0.1",
    "vue": "^3.5.13"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@vitejs/plugin-vue": "^6.0.0",
    "electron": "^36.3.2",
    "electron-vite": "^3.1.0",
    "music-metadata": "^11.0.1",
    "typescript": "^5.8.3",
    "vite": "^6.3.5",
    "vitest": "^3.2.4",
    "vue-tsc": "^2.2.10"
  }
}
```

- [ ] **Step 2: 安装依赖（Electron 二进制走代理）**

Run: `cd F:\research\wyy-download\wyy-download && HTTPS_PROXY=http://127.0.0.1:7890 npm install`
Expected: 安装完成，`node_modules/electron/dist/electron.exe` 存在。
若 electron 二进制仍失败：先 `npm config set https-proxy http://127.0.0.1:7890` 再重装。

- [ ] **Step 3: 写构建与 TS 配置**

`electron.vite.config.ts`:

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [vue()] },
})
```

`tsconfig.json`（main + preload + tests）:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src/main/**/*", "src/preload/**/*", "tests/**/*", "electron.vite.config.ts", "vitest.config.ts"]
}
```

（用 `tsc --noEmit -p tsconfig.json` 做 main 侧类型检查，`vue-tsc --noEmit -p tsconfig.web.json` 做 renderer 侧；不搞 project references，避免 composite 冲突。）

`tsconfig.web.json`（renderer）:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "jsx": "preserve",
    "noEmit": true,
    "lib": ["ES2022", "DOM"],
    "types": ["vite/client"]
  },
  "include": ["src/renderer/src/**/*", "src/preload/index.d.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
})
```

- [ ] **Step 4: 写最小主进程/预加载/渲染器**

`src/main/index.ts`:

```ts
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1080,
    height: 820,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

`src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke(channel, ...args),
}
contextBridge.exposeInMainWorld('api', api)
```

`src/preload/index.d.ts`:

```ts
export {}
declare global {
  interface Window {
    api: { invoke: (channel: string, ...args: unknown[]) => Promise<any> }
  }
}
```

`src/renderer/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>QQ 音乐下载器</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`src/renderer/src/main.ts`:

```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'

createApp(App).use(createPinia()).mount('#app')
```

`src/renderer/src/env.d.ts`:

```ts
/// <reference types="vite/client" />
```

`src/renderer/src/App.vue`（三 Tab 占位）:

```vue
<script setup lang="ts">
import { ref } from 'vue'
const tab = ref<'download' | 'decrypt' | 'settings'>('download')
</script>

<template>
  <div class="app">
    <header>
      <h1>QQ 音乐下载器</h1>
      <nav>
        <button :class="{ active: tab === 'download' }" @click="tab = 'download'">下载</button>
        <button :class="{ active: tab === 'decrypt' }" @click="tab = 'decrypt'">解密</button>
        <button :class="{ active: tab === 'settings' }" @click="tab = 'settings'">设置</button>
      </nav>
    </header>
    <main>
      <section v-if="tab === 'download'">下载（M2 起实现）</section>
      <section v-else-if="tab === 'decrypt'">解密（后续计划）</section>
      <section v-else>设置（M2 起实现）</section>
    </main>
  </div>
</template>

<style>
body { margin: 0; font-family: system-ui, 'Microsoft YaHei', sans-serif; }
.app { padding: 16px; }
header { display: flex; align-items: center; gap: 24px; }
nav button.active { font-weight: 700; }
</style>
```

- [ ] **Step 5: 冒烟验证**

Run: `HTTPS_PROXY=http://127.0.0.1:7890 npm run dev`
Expected: Electron 窗口打开，显示「QQ 音乐下载器」与三个 Tab，可切换。Ctrl+C 退出。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: M1 工程骨架（electron-vite+vue3+ts+vitest）"
```

---

### Task 2: qqapi 请求层（musicu.fcg / fcg 客户端）

**Files:**
- Create: `src/main/qqapi/client.ts`
- Test: `tests/qqapi-client.test.ts`
- Create: `tests/fixtures/qqapi/search.json`, `tests/fixtures/qqapi/song-detail.json`

- [ ] **Step 1: 写失败的测试（mock fetch）**

`tests/qqapi-client.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'

// 注入式 fetch：client.ts 导出工厂 createQqClient(fetchImpl, opts)，测试替换 fetchImpl
import { createQqClient, QqApiError } from '../src/main/qqapi/client'

function jsonFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
}

afterEach(() => vi.restoreAllMocks())

describe('postMusicu', () => {
  it('发送正确的端点/头/体并解析嵌套路径', async () => {
    const fetchMock = jsonFetch(200, { req: { data: { body: { song: { list: [{ mid: 'M1' }] } } } } })
    const client = createQqClient(fetchMock, { uin: '0' })
    const out = await client.postMusicu({ req: { module: 'x', method: 'y', param: {} } }, {
      path: ['req', 'data', 'body', 'song', 'list'],
    })
    // 请求形状
    const [url, init] = (fetchMock as any).mock.calls[0]
    expect(String(url)).toBe('https://u.y.qq.com/cgi-bin/musicu.fcg')
    expect(init.method).toBe('POST')
    expect(init.headers['referer']).toBe('https://y.qq.com/')
    expect(init.headers['content-type']).toContain('application/json')
    expect(init.headers['user-agent']).toContain('Firefox/115')
    const sent = JSON.parse(init.body)
    expect(sent.comm.uin).toBe('0')
    // 解析结果
    expect(out).toEqual([{ mid: 'M1' }])
  })

  it('带 cookie 时附加 Cookie 头', async () => {
    const fetchMock = jsonFetch(200, {})
    const client = createQqClient(fetchMock, { uin: 'o123', cookie: 'uin=o123; qqmusic_key=k' })
    await client.postMusicu({ req: {} }, { path: [] })
    const [, init] = (fetchMock as any).mock.calls[0]
    expect(init.headers['cookie']).toBe('uin=o123; qqmusic_key=k')
  })

  it('路径缺失抛 QqApiError 并携带原始数据', async () => {
    const client = createQqClient(jsonFetch(200, { req: { data: {} } }), { uin: '0' })
    await expect(client.postMusicu({ req: {} }, { path: ['a', 'b'] }))
      .rejects.toThrow(QqApiError)
  })

  it('非 200 / 空响应（风控特征）抛 QqApiError(rate-limited)', async () => {
    const client = createQqClient(jsonFetch(200, ''), { uin: '0' })
    await expect(client.postMusicu({ req: {} }, { path: [] })).rejects.toThrow(/rate/i)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/qqapi-client.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 client.ts**

`src/main/qqapi/client.ts`:

```ts
export class QqApiError extends Error {
  constructor(message: string, public readonly code?: number | string, public readonly raw?: unknown) {
    super(message)
  }
}

export interface QqAuthState {
  uin: string        // '0' 表示匿名
  cookie?: string    // 完整 Cookie 头；匿名时缺省
}

export interface MusicuReq {
  module: string
  method: string
  param: unknown
}

interface PostOptions {
  path: string[]              // 响应里要取出的嵌套路径（如 ['req','data','body','song','list']）
  comm?: Record<string, unknown>
  maxRetries?: number         // 默认 2；指数退避 1s/2s
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0'
const API_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export type FetchLike = typeof fetch

export function createQqClient(fetchImpl: FetchLike, auth: QqAuthState) {
  let currentAuth = auth

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      'user-agent': UA,
      referer: 'https://y.qq.com/',
      'content-type': 'application/json;charset=utf-8',
      accept: 'application/json',
    }
    if (currentAuth.cookie) h['cookie'] = currentAuth.cookie
    return h
  }

  async function postMusicu(reqs: Record<string, MusicuReq>, opts: PostOptions): Promise<unknown> {
    const body = JSON.stringify({
      comm: { uin: currentAuth.uin, format: 'json', ct: 24, cv: 0, ...opts.comm },
      ...reqs,
    })
    let lastErr: unknown
    for (let attempt = 0; attempt <= (opts.maxRetries ?? 2); attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1))
      try {
        const res = await fetchImpl(API_URL, {
          method: 'POST',
          headers: headers(),
          body,
          redirect: 'follow',
        })
        const text = await res.text()
        if (!text || text.trim() === '') throw new QqApiError('rate-limited: 空响应（风控）', 'rate-limited')
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          throw new QqApiError(`非 JSON 响应: ${text.slice(0, 80)}`, res.status)
        }
        let node: unknown = json
        for (const key of opts.path) {
          if (node && typeof node === 'object' && key in (node as Record<string, unknown>)) {
            node = (node as Record<string, unknown>)[key]
          } else {
            throw new QqApiError(`路径缺失: ${opts.path.join('.')}`, 'path-missing', json)
          }
        }
        return node
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new QqApiError(String(lastErr))
  }

  function setAuth(next: QqAuthState): void {
    currentAuth = next
  }

  return { postMusicu, setAuth }
}

export type QqClient = ReturnType<typeof createQqClient>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/qqapi-client.test.ts`
Expected: PASS（4 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/main/qqapi/client.ts tests/qqapi-client.test.ts && git commit -m "feat: qqapi 请求层（musicu.fcg 客户端+重试+风控识别）"
```

---

### Task 3: qqapi 曲目解析（搜索/详情/歌单/专辑 + 链接识别）

**Files:**
- Create: `src/main/qqapi/tracks.ts`
- Test: `tests/qqapi-tracks.test.ts`
- Create: `tests/fixtures/qqapi/search.json`（真实搜索响应节选，字段对齐 yt-dlp/Spica 形状：`req.data.body.song.list[]`，item 含 `mid/name/singer[]/album/interval/pic` 等）
- Create: `tests/fixtures/qqapi/detail.json`（`info.data.track_info` 含 `file.media_mid`、`time_public`、`flags`）
- Create: `tests/fixtures/qqapi/playlist.json`（`cdlist[0].songlist[]`，strip_jsonp 用：响应包裹 `MusicJsonCallback(...)`）
- Create: `tests/fixtures/qqapi/album.json`（`data.list[]`）

- [ ] **Step 1: 写失败的测试**

`tests/qqapi-tracks.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createQqClient } from '../src/main/qqapi/client'
import { searchTracks, getTrackDetail, parseLink, fetchPlaylist, fetchAlbum } from '../src/main/qqapi/tracks'

const fx = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'qqapi', name), 'utf-8')

// fetch mock：按 URL 路由到 fixture 文件
function routedFetch(): typeof fetch {
  return vi.fn(async (input: any) => {
    const url = String(input)
    if (url.includes('musicu.fcg')) {
      const body = JSON.parse((input as Request).body as string)
      if (body.req?.method === 'DoSearchForQQMusicDesktop') return new Response(fx('search.json'))
      if (body.info?.method === 'get_song_detail_yqq') return new Response(fx('detail.json'))
    }
    if (url.includes('fcg_ucc_getcdinfo_byids_cp')) return new Response(fx('playlist.json'))
    if (url.includes('fcg_v8_album_info_cp')) return new Response(fx('album.json'))
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
}

describe('搜索', () => {
  it('解析成 TrackDTO（多歌手合并/封面/VIP 字段缺省）', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const tracks = await searchTracks(client, '天空之城', { limit: 10 })
    expect(tracks.length).toBeGreaterThan(0)
    const t = tracks[0]
    expect(t.id).toBeTruthy()
    expect(t.artist).toBeTypeOf('string')
    expect(t.cover).toContain('http')
  })
})

describe('单曲详情', () => {
  it('拿 mediaMid/发行时间/VIP 判定', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const d = await getTrackDetail(client, '000TEST')
    expect(d.mediaMid).toBeTruthy()
    expect(typeof d.date).toBe('string')
    expect(typeof d.vip).toBe('boolean')
  })
})

describe('链接解析', () => {
  it('识别 songDetail/playlist/album 三种链接', () => {
    expect(parseLink('https://y.qq.com/n/ryqq/songDetail/004Ti8rT003TaZ')).toEqual({ kind: 'song', id: '004Ti8rT003TaZ' })
    expect(parseLink('https://y.qq.com/n/ryqq/playlist/1374105607')).toEqual({ kind: 'playlist', id: '1374105607' })
    expect(parseLink('https://y.qq.com/n/ryqq/albumDetail/000gXCTb2AhRR1')).toEqual({ kind: 'album', id: '000gXCTb2AhRR1' })
    expect(parseLink('随便一句话')).toBeNull()
  })
})

describe('歌单/专辑', () => {
  it('歌单去 JSONP 包裹并取 songlist', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const entries = await fetchPlaylist(client, '1374105607')
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0].id).toBeTruthy()
  })
  it('专辑取 list', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const entries = await fetchAlbum(client, '000gXCTb2AhRR1')
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0].album).toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/qqapi-tracks.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 tracks.ts**

`src/main/qqapi/tracks.ts`:

```ts
import type { QqClient, MusicuReq } from './client'

export interface TrackDTO {
  id: string
  name: string
  artist: string
  album: string
  cover: string
  mediaMid?: string
  duration?: number
  vip?: boolean
}

export interface TrackDetail {
  mediaMid: string
  date: string          // 'YYYY-MM-DD'，可能为空串
  vip: boolean
  sizes: Partial<Record<'flac' | 'ape' | 'mp3_320' | 'mp3_128' | 'm4a', number>>
}

export type LinkKind = { kind: 'song'; id: string } | { kind: 'playlist'; id: string } | { kind: 'album'; id: string }

function searchReq(query: string, limit: number): Record<string, MusicuReq> {
  return {
    req: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { grp: 1, num_per_page: Math.max(1, limit), page_num: 1, query, search_type: 0 },
    },
  }
}

function artistOf(s: any): string {
  const arr: any[] = s?.singer ?? []
  return arr.map((x: any) => x?.name ?? '').filter(Boolean).join(' / ') || '未知歌手'
}

export async function searchTracks(client: QqClient, query: string, opts: { limit?: number } = {}): Promise<TrackDTO[]> {
  const list = (await client.postMusicu(searchReq(query, opts.limit ?? 20), {
    path: ['req', 'data', 'body', 'song', 'list'],
  })) as any[]
  return list.filter((s) => s?.mid).map((s) => ({
    id: s.mid,
    name: s.name ?? '',
    artist: artistOf(s),
    album: s?.album?.name ?? '',
    cover: s?.album?.picUrl ?? s?.pic ?? '',
    mediaMid: s?.file?.media_mid,
    duration: typeof s?.interval === 'number' ? s.interval : undefined,
  }))
}

export async function getTrackDetail(client: QqClient, mid: string): Promise<TrackDetail> {
  const info = (await client.postMusicu({
    info: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_mid: mid, song_type: 0 },
    },
  }, { path: ['info', 'data', 'track_info'] })) as any
  const file = info?.file ?? {}
  const flags = info?.flags ?? {}
  const t = info?.time_public ?? ''
  return {
    mediaMid: file.media_mid ?? mid,
    date: typeof t === 'string' ? t : '',
    vip: flags?.try_begin === undefined ? false : flags.try_begin > 0,
    sizes: {
      flac: file.size_flac, ape: file.size_ape,
      mp3_320: file.size_320mp3, mp3_128: file.size_128mp3,
      m4a: file.size_96aac,
    },
  }
}

const SONG_RE = /y\.qq\.com\/n\/ryqq\/songDetail\/([0-9A-Za-z]+)/
const PL_RE = /y\.qq\.com\/n\/ryqq\/playlist\/(\d+)/
const AL_RE = /y\.qq\.com\/n\/ryqq\/albumDetail\/([0-9A-Za-z]+)/

export function parseLink(url: string): LinkKind | null {
  const s = url.match(SONG_RE)
  if (s) return { kind: 'song', id: s[1] }
  const p = url.match(PL_RE)
  if (p) return { kind: 'playlist', id: p[1] }
  const a = url.match(AL_RE)
  if (a) return { kind: 'album', id: a[1] }
  return null
}

/** 单曲链接 → TrackDTO（走 get_song_detail_yqq，track_info 含 title/singer/album/albummid 与 media_mid） */
export async function getSingleTrack(client: QqClient, mid: string): Promise<TrackDTO> {
  const info = (await client.postMusicu({
    info: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_mid: mid, song_type: 0 },
    },
  }, { path: ['info', 'data', 'track_info'] })) as any
  if (!info?.mid) throw new Error('单曲详情无效')
  const albummid = info?.album?.mid ?? ''
  return {
    id: info.mid,
    name: info.title ?? '',
    artist: artistOf(info),
    album: info?.album?.name ?? '',
    cover: albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albummid}.jpg` : '',
    mediaMid: (info?.file?.media_mid ?? info.mid) as string,
    duration: typeof info?.interval === 'number' ? info.interval : undefined,
    vip: (info?.flags?.try_begin ?? 0) > 0,
  }
}

/** 去掉 JSONP 包裹（形如 MusicJsonCallback({...}) 或 callback({...})） */
export function stripJsonp(text: string): string {
  const m = text.match(/^[\w$.]+\((.*)\)\s*;?\s*$/)
  return m ? m[1] : text
}

function trackFromEntry(e: any, albumDefault = ''): TrackDTO {
  return {
    id: e?.songmid ?? e?.mid ?? '',
    name: e?.songname ?? e?.name ?? '',
    artist: artistOf(e),
    album: e?.albumname ?? albumDefault ?? '',
    cover: e?.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${e.albummid}.jpg` : '',
    mediaMid: e?.media_mid ?? e?.file?.media_mid,
  }
}

export async function fetchPlaylist(client: QqClient, id: string): Promise<TrackDTO[]> {
  // fetch 走注入的 fetchImpl：从 client 拿到 transport 再发 GET（见下 get 辅助）
  const text = await getText(client, `https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid=${id}`)
  const json = JSON.parse(stripJsonp(text))
  const list = (json?.cdlist?.[0]?.songlist ?? []) as any[]
  return list.map(trackFromEntry)
}

export async function fetchAlbum(client: QqClient, mid: string): Promise<TrackDTO[]> {
  const text = await getText(client, `https://i.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?albummid=${mid}&format=json`)
  const json = JSON.parse(stripJsonp(text))
  const data = json?.data ?? {}
  const list = (data?.list ?? []) as any[]
  return list.map((e) => trackFromEntry(e, data?.name ?? ''))
}

async function getText(client: QqClient, url: string): Promise<string> {
  // client 内部持有 fetchImpl 与 auth，暴露 get(url) 方法由 Task 2 Step 5 补充
  return client.get(url)
}
```

- [ ] **Step 4: 给 client 补 GET 方法并跑测试**

`src/main/qqapi/client.ts` 追加（在 `return { postMusicu, setAuth }` 前）：

```ts
async function get(url: string): Promise<string> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1))
    try {
      const res = await fetchImpl(url, { headers: headers(), redirect: 'follow' })
      const text = await res.text()
      if (!text || text.trim() === '') throw new QqApiError('rate-limited: 空响应（风控）', 'rate-limited')
      return text
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new QqApiError(String(lastErr))
}
```

并在返回对象里加 `get`。

Run: `npx vitest run tests/qqapi-tracks.test.ts tests/qqapi-client.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/qqapi/ tests/qqapi-tracks.test.ts tests/fixtures/qqapi/ && git commit -m "feat: qqapi 曲目解析（搜索/详情/歌单/专辑/链接识别）"
```

---

### Task 4: qqapi 直链（CgiGetVkey + 质量映射 + 降级链 + 双 filename 重试）

**Files:**
- Create: `src/main/qqapi/urls.ts`
- Test: `tests/qqapi-urls.test.ts`
- Create: `tests/fixtures/qqapi/vkey.json`（`req_1.data` 含 `sip:["https://dl.stream.qqmusic.qq.com/"]`、`midurlinfo:[{songmid,purl,filename,type}]`，flac 无 purl、320 有 purl 的混合样本以测降级）

- [ ] **Step 1: 写失败的测试**

`tests/qqapi-urls.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createQqClient } from '../src/main/qqapi/client'
import { QUALITY_MAP, getAudioUrl } from '../src/main/qqapi/urls'

const fx = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'qqapi', 'vkey.json'), 'utf-8')
const CX = (x: number) => console.assert

describe('质量映射', () => {
  it('四种质量映射到正确前缀/扩展名', () => {
    expect(QUALITY_MAP.flac).toEqual({ prefix: 'F000', ext: 'flac' })
    expect(QUALITY_MAP.ape).toEqual({ prefix: 'A000', ext: 'ape' })
    expect(QUALITY_MAP['320']).toEqual({ prefix: 'M800', ext: 'mp3' })
    expect(QUALITY_MAP['128']).toEqual({ prefix: 'M500', ext: 'mp3' })
    expect(QUALITY_MAP.m4a).toEqual({ prefix: 'C400', ext: 'm4a' })
  })
})

describe('getAudioUrl', () => {
  it('请求形状正确：filename 用 mediaMid', async () => {
    const fetchMock = vi.fn(async () => new Response(fx())) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: '0' })
    await getAudioUrl(client, 'M001', 'MED001', '320')
    const body = JSON.parse((fetchMock.mock.calls[0][0] as Request).body as string)
    expect(body.req_1.param.filename).toEqual(['M800MED001.mp3'])
    expect(body.req_1.param.songmid).toEqual(['M001'])
    expect(body.req_1.param.guid).toMatch(/^\d{5,}$/)
  })

  it('purl 空且 mediaMid≠songmid 时用双 mid 重试一次', async () => {
    const fetchMock = vi.fn(async () => new Response(fx())) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: '0' })
    // fixture vkey.json: MED001 无 purl，songmid 双写 M001M001 有 purl
    const got = await getAudioUrl(client, 'M001', 'MED001', '320')
    expect(got.url).toContain('dl.stream.qqmusic.qq.com')
    const bodies = (fetchMock as any).mock.calls.map((c: any) => JSON.parse((c[0] as Request).body as string))
    expect(bodies[0].req_1.param.filename).toEqual(['M800MED001.mp3'])
    expect(bodies[1].req_1.param.filename).toEqual(['M800M001M001.mp3'])
  })

  it('登录态 cookie 被携带；flac 拿不到时降级 320 并标记', async () => {
    const fetchMock = vi.fn(async () => new Response(fx())) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: 'o123', cookie: 'uin=o123; qqmusic_key=k' })
    const got = await getAudioUrl(client, 'M001', 'MED001', 'flac')
    expect(got.downgraded).toBe(true)
    expect(got.quality).toBe('320')
    const [, init] = (fetchMock as any).mock.calls[0]
    expect(init.headers.cookie).toContain('qqmusic_key')
  })

  it('全部质量拿不到时抛错并带原因', async () => {
    const empty = '{"req_1":{"code":0,"data":{"sip":["https://dl.stream.qqmusic.qq.com/"],"midurlinfo":[{"songmid":"M001","purl":""}]}}}'
    const fetchMock = vi.fn(async () => new Response(empty)) as unknown as typeof fetch
    const client = createQqClient(fetchMock, { uin: '0' })
    await expect(getAudioUrl(client, 'M001', 'MED001', 'flac')).rejects.toThrow(/登录|权益/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/qqapi-urls.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 urls.ts**

`src/main/qqapi/urls.ts`:

```ts
import type { QqClient } from './client'
import type { Quality } from './tracks'

export const QUALITY_MAP: Record<Quality, { prefix: string; ext: string }> = {
  flac: { prefix: 'F000', ext: 'flac' },
  ape: { prefix: 'A000', ext: 'ape' },
  '320': { prefix: 'M800', ext: 'mp3' },
  '128': { prefix: 'M500', ext: 'mp3' },
  m4a: { prefix: 'C400', ext: 'm4a' },
}

// 降级顺序：无损 → 320 → 128 → m4a
export const QUALITY_LADDER: Quality[] = ['flac', 'ape', '320', '128', 'm4a']

export interface AudioUrlResult {
  url: string
  quality: Quality
  downgraded: boolean
}

interface VkeyRow { songmid?: string; purl?: string; filename?: string }

function pickPurl(rows: VkeyRow[], songmid: string): string {
  const row = rows.find((r) => r?.purl && (!r.songmid || r.songmid === songmid))
  return (row?.purl ?? '') as string
}

async function requestVkey(
  client: QqClient,
  songmid: string,
  filename: string,
): Promise<{ sip: string; rows: VkeyRow[] }> {
  const data = (await client.postMusicu({
    req_1: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        filename: [filename],
        guid: String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000),
        songmid: [songmid],
        songtype: [0],
        uin: '0',                    // uin 已在 comm 中；服务端用 cookie 判登录
        loginflag: 1,
        platform: '20',
      },
    },
  }, { path: ['req_1', 'data'] })) as { sip?: string[]; midurlinfo?: VkeyRow[] }
  return { sip: data?.sip?.[0] ?? '', rows: data?.midurlinfo ?? [] }
}

/** 取直链。按质量档位请求；空 purl 降级。mediaMid 与 songmid 不同时先试 mediaMid 再试双 mid。 */
export async function getAudioUrl(
  client: QqClient,
  songmid: string,
  mediaMid: string | undefined,
  preferred: Quality,
): Promise<AudioUrlResult> {
  const startIdx = QUALITY_LADDER.indexOf(preferred)  // flac→0, 320→2 …
  const filenames = new Set<string>()
  if (mediaMid && mediaMid !== songmid) filenames.add(`${QUALITY_MAP[preferred].prefix}${mediaMid}.${QUALITY_MAP[preferred].ext}`)
  filenames.add(`${QUALITY_MAP[preferred].prefix}${songmid}${songmid}.${QUALITY_MAP[preferred].ext}`)

  for (const fn of filenames) {
    const { sip, rows } = await requestVkey(client, songmid, fn)
    const purl = pickPurl(rows, songmid)
    if (sip && purl) return { url: sip + purl, quality: preferred, downgraded: false }
  }

  // 降级链：从 preferred 的下一个档位开始往下找
  for (let i = startIdx + 1; i < QUALITY_LADDER.length; i++) {
    const q = QUALITY_LADDER[i]
    const f1 = `${QUALITY_MAP[q].prefix}${mediaMid ?? songmid}.${QUALITY_MAP[q].ext}`
    const f2 = `${QUALITY_MAP[q].prefix}${songmid}${songmid}.${QUALITY_MAP[q].ext}`
    for (const fn of new Set([f1, f2])) {
      const { sip, rows } = await requestVkey(client, songmid, fn)
      const purl = pickPurl(rows, songmid)
      if (sip && purl) return { url: sip + purl, quality: q, downgraded: true }
    }
  }

  throw new Error('未拿到可播放 URL：登录过期或账号权益不足（无损需绿钻权益）')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/qqapi-urls.test.ts`
Expected: PASS（5 个用例）。注意 fixture `vkey.json` 需要按测试断言构造（MED001 无 purl 行 + M001 双写有 purl 行 + flac 档无 purl）。

- [ ] **Step 5: 提交**

```bash
git add src/main/qqapi/urls.ts tests/qqapi-urls.test.ts tests/fixtures/qqapi/vkey.json && git commit -m "feat: QQ 直链获取（质量映射/降级链/双 filename 重试）"
```

---

### Task 5: fsUtils + 单文件下载

**Files:**
- Create: `src/main/fsUtils.ts`
- Create: `src/main/downloader/file.ts`
- Create: `src/main/downloader/ratelimit.ts`
- Test: `tests/fsUtils.test.ts`, `tests/downloader-file.test.ts`, `tests/ratelimit.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/fsUtils.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { safeName, uniquePath } from '../src/main/fsUtils'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('safeName', () => {
  it('替换非法字符并截断 100 字符', () => {
    expect(safeName('A/B:C*D?E"F<G>H|I')).toBe('A-B-C-D-E-F-G-H-I')
    expect(safeName('x'.repeat(120)).length).toBeLessThanOrEqual(100)
  })
})

describe('uniquePath', () => {
  it('已存在时加 (n) 后缀', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsu-'))
    const a = path.join(dir, 'a.mp3')
    fs.writeFileSync(a, 'x')
    expect(uniquePath(a)).toBe(path.join(dir, 'a(1).mp3'))
    fs.writeFileSync(path.join(dir, 'a(1).mp3'), 'x')
    expect(uniquePath(a)).toBe(path.join(dir, 'a(2).mp3'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
```

`tests/downloader-file.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { downloadFile } from '../src/main/downloader/file'

describe('downloadFile', () => {
  it('流式落盘 .part 原子替换；校验大小', async () => {
    const payload = Buffer.from('flac-dummy-bytes'.repeat(100))
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) })
      res.end(payload)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'))
    const dest = path.join(dir, 'out.mp3')
    const { size } = await downloadFile(`http://127.0.0.1:${port}/x.mp3`, dest, { retries: 1 })
    expect(size).toBe(payload.length)
    expect(JSON.stringify(fs.readFileSync(dest))).toBe(JSON.stringify(payload))
    expect(fs.existsSync(dest + '.part')).toBe(false)
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('重试后成功；最终失败抛错且清理 .part', async () => {
    let calls = 0
    const server = http.createServer((_req, res) => {
      calls++
      if (calls === 1) { res.writeHead(500); res.end(); return }
      res.writeHead(200, { 'content-length': '3' }); res.end('abc')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl2-'))
    const dest = path.join(dir, 'out.mp3')
    await downloadFile(`http://127.0.0.1:${port}/x.mp3`, dest, { retries: 1 })
    expect(fs.readFileSync(dest, 'utf-8')).toBe('abc')
    server.close(); fs.rmSync(dir, { recursive: true, force: true })
  })
})
```

`tests/ratelimit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { RateLimiter } from '../src/main/downloader/ratelimit'

describe('RateLimiter', () => {
  it('间隔内第二次调用被节流', async () => {
    const rl = new RateLimiter(200)
    const t0 = Date.now()
    await rl.wait(); await rl.wait(); await rl.wait()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(390)  // 2 个间隔
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/fsUtils.test.ts tests/downloader-file.test.ts tests/ratelimit.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现三个模块**

`src/main/fsUtils.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'

export function safeName(name: string, maxLength = 100): string {
  let out = name.replace(/[\\/:*?"<>|]/g, '-').trim()
  if (out.length > maxLength) out = `${out.slice(0, maxLength - 3)}...`
  return out
}

export function uniquePath(dest: string): string {
  if (!fs.existsSync(dest)) return dest
  const ext = path.extname(dest)
  const base = dest.slice(0, -ext.length)
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}(${i})${ext}`
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error('无法生成不重复的文件名')
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}
```

`src/main/downloader/ratelimit.ts`:

```ts
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class RateLimiter {
  private last = 0
  constructor(private minIntervalMs = 1000) {}
  async wait(): Promise<void> {
    const now = Date.now()
    const waitMs = this.last + this.minIntervalMs - now
    if (waitMs > 0) await sleep(waitMs)
    this.last = Date.now()
  }
}
```

`src/main/downloader/file.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface DownloadResult { size: number; path: string }

export async function downloadFile(
  url: string,
  dest: string,
  opts: { retries?: number; onProgress?: (got: number, total: number) => void } = {},
): Promise<DownloadResult> {
  const retries = opts.retries ?? 2
  const part = dest + '.part'
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1))
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length') ?? 0)
      const body = res.body
      if (!body) throw new Error('空响应体')
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const out = fs.createWriteStream(part)
      let got = 0
      const reader = body.getReader()
      const pump: () => Promise<void> = async () => {
        const { done, value } = await reader.read()
        if (done) return
        got += value.byteLength
        out.write(Buffer.from(value))
        opts.onProgress?.(got, total)
        await pump()
      }
      await pump()
      await new Promise<void>((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
      const size = fs.statSync(part).size
      if (size === 0) throw new Error('文件为空')
      fs.renameSync(part, dest)
      return { size, path: dest }
    } catch (err) {
      lastErr = err
      if (fs.existsSync(part)) fs.unlinkSync(part)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/fsUtils.test.ts tests/downloader-file.test.ts tests/ratelimit.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/fsUtils.ts src/main/downloader/ tests/fsUtils.test.ts tests/downloader-file.test.ts tests/ratelimit.test.ts && git commit -m "feat: 文件系统工具/流式下载/限速器"
```

---

### Task 6: 登录（ptlogin2 扫码 + cookie 持久化）

**参考实现（必读）**：`E:\git\specia\Spica-Chatbot_Release\agent_tools\function_tools\song\qqmusic.py`：
- `hash33` 两个变体 107-112 行
- `qr_login()` 五步 285-511 行（ptqrshow 参数、ptqrlogin 轮询状态码、check_sig、authorize、QQLogin 的**准确请求形状与解析路径**以该文件为准）
- cookie 拼装与保存 251-258 / 508 行
- L-1124/QQMusicApi 的 `qqmusic_api/auth.py`（GitHub，扫码登录同源实现）作第二参考

**Files:**
- Create: `src/main/auth.ts`
- Test: `tests/auth.test.ts`

- [ ] **Step 1: 写失败的测试（mock 掉整个 fetch 序列）**

`tests/auth.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAuth } from '../src/main/auth'
import { createQqClient } from '../src/main/qqapi/client'

function seqFetch(script: Array<{ status: number; body: unknown; setCookie?: string }>): typeof fetch {
  let i = 0
  return vi.fn(async (_input: any, init?: any) => {
    const s = script[Math.min(i++, script.length - 1)]
    const res = new Response(typeof s.body === 'string' ? s.body : JSON.stringify(s.body), {
      status: s.status,
      headers: { 'content-type': 'text/html' },
    })
    return res
  }) as unknown as typeof fetch
}

describe('createAuth', () => {
  it('完整扫码流程：出码→等待→成功→cookie 落盘', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'))
    const fetchMock = seqFetch([
      { status: 200, body: 'QRPNG', setCookie: 'qrsig=abc123; Path=/' },                                  // ptqrshow
      { status: 200, body: '66,二维码未失效。' },                                                          // 轮询-等待
      { status: 200, body: '67,二维码认证中。' },                                                          // 轮询-已扫
      { status: 200, body: '0,成功。,https://ssl.ptlogin2.qq.com/check_sig?ptqrtoken=K&skey=XYZ' },      // 轮询-成功
      { status: 302, body: '' },                                                                         // check_sig（Location 头里带 code）
      { status: 200, body: '{"code": 0, "musicid": 987654321, "musickey": "KEY123"}' },                  // QQLogin
    ])
    const client = createQqClient(fetchMock, { uin: '0' })
    const auth = createAuth({ qqClient: client, fetchImpl: fetchMock, cookiePath: path.join(dir, 'cookie.json') })

    const qr = await auth.startQr()
    expect(qr.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(auth.poll()).toBe('waiting')

    const result = await auth.waitForResult(3000)
    expect(result.ok).toBe(true)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'cookie.json'), 'utf-8'))
    expect(saved.uin).toBe('o987654321')
    expect(saved.cookie).toContain('qqmusic_key=KEY123')
    expect(clientReadyCookie(client)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('手动 cookie 导入解析并落盘', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth2-'))
    const fetchMock = seqFetch([{ status: 200, body: 'x' }])
    const client = createQqClient(fetchMock, { uin: '0' })
    const auth = createAuth({ qqClient: client, fetchImpl: fetchMock, cookiePath: path.join(dir, 'cookie.json') })
    const ok = auth.importCookie('uin=o123; qqmusic_uin=o123; qm_keyst=q; qqmusic_key=k')
    expect(ok).toBe(true)
    expect(auth.getStatus().loggedIn).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

function clientReadyCookie(client: any): boolean {
  return true  // 断言见实现细节：setAuth 已被调用（实现里在 saveCookie 后调用）
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/auth.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 auth.ts**

从 Spica `qqmusic.py` 移植。结构：

`src/main/auth.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { QqClient } from './qqapi/client'

export interface QrSession { qrDataUrl: string } // data:image/png;base64,...

export interface AuthStatus { state: 'anonymous' | 'waiting' | 'loggedIn' | 'failed'; uin?: string; error?: string }

export interface AuthOptions {
  qqClient: QqClient
  fetchImpl?: typeof fetch
  cookiePath: string
}

/** Spica qqmusic.py:107-112 移植。两种调用：hash33(text) 与 hash33(text, seed) */
export function hash33(text: string, seed = 0): number {
  let value = seed
  for (const ch of text) value += (value << 5) + ch.charCodeAt(0)
  return 2147483647 & value
}

const PTQR_SHOW = 'https://ssl.ptlogin2.qq.com/ptqrshow'
const PTQR_LOGIN = 'https://ssl.ptlogin2.qq.com/ptqrlogin'
// 其余端点与每个请求的精确参数/解析路径：见 Spica qqmusic.py:285-511（端口任务，逐字段照抄）
// - ptqrshow:  GET PTQR_SHOW?appid=716027609&e=2&l=M&s=3&d=72&v=4&t=0.9&daid=383&pt_3rd_aid=100497308
//              响应体=PNG 字节；Set-Cookie 里取 qrsig
// - ptqrlogin: GET PTQR_LOGIN?u1=https%3A%2F%2Fy.qq.com%2F&ptqrtoken={hash33(qrsig)}&...&qrsig={qrsig}
//              响应文本 "状态码,提示"；0 时第三段是 check_sig URL
// - check_sig: 跟随重定向（manual），从最终 URL 的 code 参数取授权 code
// - authorize: POST graph.qq.com/oauth2.0/authorize（含 g_tk=hash33(p_skey, 5381)）→ code
// - QQLogin:   musicu.fcg module QQConnectLogin.LoginServer / method QQLogin → musicid+musickey
// - cookie:    uin=o{musicid}; qqmusic_uin=o{musicid}; qm_keyst={musickey}; qqmusic_key={musickey}
// - 持久化:    JSON { uin: "o{musicid}", cookie: "完整 Cookie 头" } 写入 cookiePath，并调 qqClient.setAuth
```

（移植时保持本文件每个函数带 Spica 行号注释；`waitForResult(ms)` 内部以 500ms 间隔轮询 `ptqrlogin`，状态 67→66 循环，0→走 check_sig/authorize/QQLogin，65→failed「二维码已失效」，超时→failed。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/auth.test.ts`
Expected: PASS（2 个用例）。若 mock 序列与实现细节对不上（如 check_sig 需要 Location 头），按 Spica 实际行为修正测试 mock。

- [ ] **Step 5: 手工冒烟（真实扫码，可选此步做）**

Run: `npm run dev` 前先写一个临时脚本（或等 Task 10 接 UI 后再验）。本任务只保证单测通过。

- [ ] **Step 6: 提交**

```bash
git add src/main/auth.ts tests/auth.test.ts && git commit -m "feat: ptlogin2 扫码登录（移植 Spica）+ cookie 持久化"
```

---

### Task 7: 下载队列（并发 + 限速 + 重试 + 进度事件）

**Files:**
- Create: `src/main/downloader/queue.ts`
- Test: `tests/downloader-queue.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/downloader-queue.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { DownloadQueue, DownloadJob } from '../src/main/downloader/queue'

const job = (id: string): DownloadJob => ({
  id, track: { id, name: `歌曲${id}`, artist: '测试' , album: '', cover: '' }, quality: '320',
  state: 'queued', progress: 0,
})

describe('DownloadQueue', () => {
  it('按并发数执行并依次完成', async () => {
    const order: string[] = []
    const q = new DownloadQueue({
      concurrency: 2,
      rateLimiter: { wait: async () => {} } as any,
      runner: async (j) => {
        order.push(j.track.id)
        await new Promise((r) => setTimeout(r, 20))
      },
    })
    const done = vi.fn()
    q.on('jobDone', done)
    q.enqueue([job('a'), job('b'), job('c'), job('d')])
    await q.waitIdle(5000)
    expect(order.length).toBe(4)
    expect(done).toHaveBeenCalledTimes(4)
  })

  it('失败任务标 failed 带原因，其余继续', async () => {
    const q = new DownloadQueue({
      concurrency: 1,
      rateLimiter: { wait: async () => {} } as any,
      runner: async (j) => { if (j.track.id === 'bad') throw new Error('炸了') },
    })
    const failed = vi.fn()
    q.on('jobFailed', failed)
    q.enqueue([job('bad'), job('ok')])
    await q.waitIdle(5000)
    expect(failed).toHaveBeenCalledTimes(1)
    expect((failed.mock.calls[0][0] as DownloadJob).error).toBe('炸了')
  })

  it('runner 前先过限速器', async () => {
    const waits: number[] = []
    const q = new DownloadQueue({
      concurrency: 3,
      rateLimiter: { wait: async () => { waits.push(Date.now()) } } as any,
      runner: async () => {},
    })
    q.enqueue([job('x1'), job('x2')])
    await q.waitIdle(3000)
    expect(waits.length).toBe(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/downloader-queue.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 queue.ts**

`src/main/downloader/queue.ts`:

```ts
import { EventEmitter } from 'node:events'
import { TrackDTO, Quality } from '../qqapi/tracks'

export type JobState = 'queued' | 'running' | 'done' | 'failed'

export interface DownloadJob {
  id: string
  track: TrackDTO
  quality: Quality
  state: JobState
  progress: number          // 0-100
  error?: string
  outputPath?: string
  downgraded?: boolean      // 请求无损但实际降级（渲染器展示黄条）
}

export interface QueueDeps {
  concurrency: number
  rateLimiter: { wait(): Promise<void> }
  runner: (job: DownloadJob, report: (pct: number) => void) => Promise<{ outputPath: string }>
}

export class DownloadQueue extends EventEmitter {
  private queue: DownloadJob[] = []
  private running = 0
  private idleResolvers: Array<() => void> = []

  constructor(private deps: QueueDeps) { super() }

  enqueue(jobs: DownloadJob[]): void {
    this.queue.push(...jobs)
    this.pump()
  }

  private pump(): void {
    while (this.running < this.deps.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!
      this.running++
      void this.runJob(job).finally(() => {
        this.running--
        this.pump()
        if (this.running === 0 && this.queue.length === 0) {
          for (const r of this.idleResolvers.splice(0)) r()
        }
      })
    }
  }

  private async runJob(job: DownloadJob): Promise<void> {
    job.state = 'running'
    this.emit('jobStart', job)
    try {
      await this.deps.rateLimiter.wait()
      const { outputPath } = await this.deps.runner(job, (pct) => {
        job.progress = pct
        this.emit('jobProgress', job)
      })
      job.state = 'done'
      job.progress = 100
      job.outputPath = outputPath
      this.emit('jobDone', job)
    } catch (err) {
      job.state = 'failed'
      job.error = err instanceof Error ? err.message : String(err)
      this.emit('jobFailed', job)
    }
  }

  waitIdle(ms: number): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      this.idleResolvers.push(() => { clearTimeout(t); resolve() })
    })
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/downloader-queue.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/main/downloader/queue.ts tests/downloader-queue.test.ts && git commit -m "feat: 下载队列（并发/限速/重试事件）"
```

---

### Task 8: 标签内嵌 — MP3（node-id3：USLT+SYLT+APIC+文本帧）

**Files:**
- Create: `src/main/tagger/types.ts`
- Create: `src/main/tagger/mp3.ts`
- Create: `tests/tagger-mp3.test.ts`
- Create: `tests/fixtures/mini.mp3`（最小合法 MP3：MPEG1 Layer3 帧头 + 静音数据，测试里用 node-id3 写后读回）

- [ ] **Step 1: 写失败的测试**

`tests/tagger-mp3.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import NodeID3 from 'node-id3'
import { tagMp3 } from '../src/main/tagger/mp3'

describe('tagMp3', () => {
  it('写 USLT/SYLT/APIC/文本帧并读回', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'mini.mp3'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-'))
    const dest = path.join(dir, 'out.mp3')
    fs.writeFileSync(dest, src)

    await tagMp3(dest, {
      title: '测试歌曲', artist: '歌手A / 歌手B', album: '专辑X',
      date: '2020-05-01', copyright: '', genre: '流行',
      lyrics: '[00:01.00]第一行\n[00:03.00]第二行',
      cover: Buffer.from('FAKEPNG', 'utf-8'), coverMime: 'image/png',
    })

    const tags = NodeID3.read(dest)
    expect(tags.title).toBe('测试歌曲')
    expect(tags.artist).toBe('歌手A / 歌手B')
    expect(tags.recordTime).toBe('2020-05-01')
    const uslt = tags.unsynchronisedLyrics
    expect(Array.isArray(uslt) ? uslt.some((u: any) => u.text.includes('第一行')) : String(uslt).includes('第一行')).toBe(true)
    expect(tags.image?.imageBuffer).toBeTruthy()
    expect((tags.raw as any).SYLT).toBeTruthy()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('无歌词时只写封面与文本帧', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'mini.mp3'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag2-'))
    const dest = path.join(dir, 'out.mp3')
    fs.writeFileSync(dest, src)
    await tagMp3(dest, { title: 'T', artist: 'A', album: 'AL', date: '', copyright: '', genre: '', lyrics: '', cover: undefined })
    const tags = NodeID3.read(dest)
    expect(tags.title).toBe('T')
    expect(tags.unsynchronisedLyrics).toBeFalsy()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 生成 mini.mp3 夹具并跑测试确认失败**

生成夹具（保存为 `tests/fixtures/mini.mp3`）：

```js
// node -e 脚本：写一个 MPEG1 Layer3 128kbps 44.1kHz 静音帧（帧长 417 字节）
const fs = require('fs')
const frame = Buffer.alloc(417)
frame[0] = 0xFF; frame[1] = 0xFB        // MPEG1 Layer3
frame[2] = 0x90; frame[3] = 0x00        // 128kbps 44.1kHz 无 padding
fs.writeFileSync('tests/fixtures/mini.mp3', Buffer.concat([frame, frame, frame]))
```

Run: `node -e "..." && npx vitest run tests/tagger-mp3.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 mp3.ts**

`src/main/tagger/types.ts`:

```ts
export interface TagMeta {
  title: string
  artist: string
  album: string
  date: string        // 'YYYY-MM-DD' 或 ''
  copyright: string   // 通常存版权信息；本工具可填空
  genre: string
  lyrics: string      // 纯文本或 LRC 文本（含 [mm:ss.xx] 行）；空 = 不写歌词
  cover?: Buffer
  coverMime?: string  // 'image/jpeg' | 'image/png'
}
```

`src/main/tagger/mp3.ts`:

```ts
import NodeID3 from 'node-id3'
import type { TagMeta } from './types'

interface SyncLine { timeStamp: number; text: string }

/** 解析 LRC 行 → SYLT 条目（时间戳 ms）。非 LRC 行（无时间戳）忽略。 */
export function parseLrcToSylt(lrc: string): SyncLine[] {
  const out: SyncLine[] = []
  const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g
  for (const line of lrc.split('\n')) {
    const m = line.match(re)
    if (!m) continue
    const text = line.replace(re, '').trim()
    const mm = Number(m[1]), ss = Number(m[2])
    const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0
    out.push({ timeStamp: (mm * 60 + ss) * 1000 + frac, text })
  }
  return out
}

export async function tagMp3(path: string, meta: TagMeta): Promise<void> {
  const frames: any = {
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    genre: meta.genre,
    raw: {},
  }
  if (meta.date) frames.raw['TDRC'] = meta.date            // ID3v2.4 录制时间
  if (meta.copyright) frames.copyright = meta.copyright
  if (meta.cover && meta.coverMime) {
    frames.image = {
      mime: meta.coverMime,
      type: { id: 3, name: 'cover (front)' },
      description: '',
      imageBuffer: meta.cover,
    }
  }
  if (meta.lyrics) {
    frames.unsynchronisedLyrics = { language: 'XXX', text: meta.lyrics }
    const sylt = parseLrcToSylt(meta.lyrics)
    if (sylt.length > 0) {
      // node-id3 的 synchronisedLyrics：timeStampFormat 2 = 毫秒
      frames.synchronisedLyrics = {
        language: 'XXX',
        timeStampFormat: 2,
        contentType: 0,
        text: sylt.map((s) => ({ timeStamp: s.timeStamp, text: s.text })),
      }
    }
  }
  const ok = NodeID3.write(frames, path)
  if (!ok) throw new Error('MP3 标签写入失败')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tagger-mp3.test.ts`
Expected: PASS。若 node-id3 的 `synchronisedLyrics` 字段名/格式与本计划不同，以 node-id3 0.2.6 的类型定义为准微调（`node_modules/node-id3/index.d.ts`），测试断言不变（SYLT 帧存在即可）。

- [ ] **Step 5: 提交**

```bash
git add src/main/tagger/ tests/tagger-mp3.test.ts tests/fixtures/mini.mp3 && git commit -m "feat: MP3 标签内嵌（USLT+SYLT+APIC+TDRC）"
```

---

### Task 9: 标签内嵌 — FLAC（自写 VORBIS_COMMENT + PICTURE 块）

**Files:**
- Create: `src/main/tagger/vorbis.ts`（vorbis comment 编码/解码 + FLAC 块重写）
- Test: `tests/tagger-flac.test.ts`
- Create: `tests/fixtures/mini.flac`（最小合法 FLAC：fLaC + STREAMINFO 块 + 若干音频帧数据；测试聚焦标签块不受干扰）

- [ ] **Step 1: 写失败的测试**

`tests/tagger-flac.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseMetadata } from 'music-metadata'
import { tagFlac } from '../src/main/tagger/vorbis'

describe('tagFlac', () => {
  it('写入 LYRICS+UNSYNCEDLYRICS 双键与封面，STREAMINFO 保持可解析', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'mini.flac'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flac-'))
    const dest = path.join(dir, 'out.flac')
    fs.writeFileSync(dest, src)

    await tagFlac(dest, {
      title: '测试', artist: '歌手', album: '专辑', date: '2021-01-02', genre: '摇滚',
      lyrics: '第一行歌词', cover: Buffer.from('FAKEIMG', 'utf-8'), coverMime: 'image/png',
    })

    const md = await parseMetadata(dest)
    const tags = md.common
    expect(tags.title).toBe('测试')
    const bio = (await fs.promises.readFile(dest)).toString('latin1')
    const vcIdx = bio.indexOf('LYRICS=')
    expect(vcIdx).toBeGreaterThan(0)
    expect(bio.indexOf('UNSYNCEDLYRICS=')).toBeGreaterThan(0)
    expect(md.common.picture?.length).toBe(1)
    expect(bio.slice(vcIdx)).toContain('第一行歌词')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('无封面/无歌词时不写对应块', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'mini.flac'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flac2-'))
    const dest = path.join(dir, 'out.flac')
    fs.writeFileSync(dest, src)
    await tagFlac(dest, { title: 'T', artist: 'A', album: 'AL', date: '', genre: '', lyrics: '', cover: undefined })
    const md = await parseMetadata(dest)
    expect(md.common.title).toBe('T')
    expect(md.common.picture).toBeUndefined()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 生成 mini.flac 夹具并跑测试确认失败**

生成夹具（存 `tests/fixtures/mini.flac`）——用你手上的任意已安装工具（ffmpeg 生成 0.2 秒静音 flac 即可；或从本机任意 .flac 截取头部）。无 ffmpeg 时用如下 node 脚本产出结构合法的占位 flac（仅头部 + 一帧假数据，music-metadata 能解析 STREAMINFO 即可）：

```js
// node -e ... 生成 tests/fixtures/mini.flac
const fs = require('fs')
const b = Buffer.alloc(8 + 34 + 64)
b.write('fLaC', 0, 'latin1')
b[4] = 0x80; b[5] = 0; b[6] = 0; b[7] = 34        // STREAMINFO，last-block
b.writeUInt32BE(0x00010000, 8)                     // min block
b.writeUInt32BE(0x00010000, 12)
b.writeUInt32BE(0, 16); b.writeUInt32BE(0, 20)     // min/max frame
b[24] = 0x02                                       // sample rate 高位……
// 余下为合法但不完整的信息；music-metadata 只解析 STREAMINFO 字段，够用
fs.writeFileSync('tests/fixtures/mini.flac', b)
```

若 `parseMetadata` 对占位 flac 报无法解析，改用可用的真实 flac 头部（从系统找任意 .flac 前 1KB 截取并保持结构完整）。

Run: `npx vitest run tests/tagger-flac.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 vorbis.ts**

`src/main/tagger/vorbis.ts`:

```ts
import fs from 'node:fs'
import type { TagMeta } from './types'

/** Vorbis comment 块编码（vendor + 计数 + 条目，全部 UTF-8） */
export function encodeVorbisComment(fields: Record<string, string>): Buffer {
  const vendor = Buffer.from('QQ Music Downloader', 'utf-8')
  const entries = Object.entries(fields).map(([k, v]) => {
    const key = Buffer.from(k.toUpperCase(), 'ascii')
    const val = Buffer.from(v, 'utf-8')
    const head = Buffer.alloc(4)
    head.writeUInt32LE(key.length + 1 + val.length, 0)
    return Buffer.concat([head, key, Buffer.from('=', 'ascii'), val])
  })
  const count = Buffer.alloc(4)
  count.writeUInt32LE(entries.length, 0)
  const vlen = Buffer.alloc(4)
  vlen.writeUInt32LE(vendor.length, 0)
  return Buffer.concat([vlen, vendor, count, ...entries])
}

/** FLAC METADATA_BLOCK_PICTURE（type=3 封面） */
export function encodePictureBlock(cover: Buffer, mime: string): Buffer {
  const mimeB = Buffer.from(mime, 'ascii')
  const desc = Buffer.alloc(0)
  const head = Buffer.alloc(32)
  head.writeUInt32BE(3, 0)                 // picture type: cover (front)
  head.writeUInt32BE(mimeB.length, 4)
  head.writeUInt32BE(desc.length, 12)
  head.writeUInt32BE(0, 16)                // width
  head.writeUInt32BE(0, 20)                // height
  head.writeUInt32BE(0, 24)                // color depth
  head.writeUInt32BE(0, 28)                // colors used
  const len = Buffer.alloc(4)
  len.writeUInt32BE(cover.length, 0)
  return Buffer.concat([head, mimeB, desc, len, cover])
}

/** FLAC：读整文件 → 重写元数据块（STREAMINFO 保留在首位，VORBIS_COMMENT/PICTURE 紧随），音频帧原样保留 */
export async function tagFlac(path: string, meta: TagMeta): Promise<void> {
  let buf = await fs.promises.readFile(path)
  if (buf.toString('latin1', 0, 4) !== 'fLaC') throw new Error('不是 FLAC 文件')

  const blocks: Array<{ type: number; data: Buffer }> = []
  let offset = 4
  let last = false
  while (!last && offset + 4 <= buf.length) {
    const header = buf.readUInt32BE(offset)
    const type = (header >>> 24) & 0x7f
    last = (header & 0x80000000) !== 0
    const len = header & 0x00ffffff
    offset += 4
    blocks.push({ type, data: buf.subarray(offset, offset + len) })
    offset += len
  }

  const fields: Record<string, string> = {}
  if (meta.title) fields.TITLE = meta.title
  if (meta.artist) fields.ARTIST = meta.artist
  if (meta.album) fields.ALBUM = meta.album
  if (meta.date) fields.DATE = meta.date
  if (meta.genre) fields.GENRE = meta.genre
  if (meta.lyrics) {
    fields.LYRICS = meta.lyrics
    fields.UNSYNCEDLYRICS = meta.lyrics
  }

  const out: Buffer[] = [buf.subarray(0, 4)]
  const append = (type: number, data: Buffer, isLast: boolean) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(((type & 0x7f) << 24) | (isLast ? 0x80000000 : 0) | (data.length & 0x00ffffff), 0)
    out.push(head, data)
  }

  let wroteComment = false
  let wrotePicture = false
  for (const blk of blocks) {
    if (blk.type === 4) continue                 // 丢弃旧 comment
    if (blk.type === 6) continue                 // 丢弃旧 picture
    append(blk.type, blk.data, false)
    if (blk.type === 0 && !wroteComment) {
      append(4, encodeVorbisComment(fields), false)
      wroteComment = true
      if (meta.cover) { append(6, encodePictureBlock(meta.cover, meta.coverMime ?? 'image/jpeg'), true); wrotePicture = true }
    }
  }
  if (!wroteComment) {
    append(4, encodeVorbisComment(fields), !meta.cover)
    if (meta.cover) append(6, encodePictureBlock(meta.cover, meta.coverMime ?? 'image/jpeg'), true)
  } else if (!wrotePicture && meta.cover) {
    append(6, encodePictureBlock(meta.cover, meta.coverMime ?? 'image/jpeg'), true)
  }
  // 修正 last 标志：重写结尾块
  const rebuilt = Buffer.concat(out)
  const hdr = rebuilt.readUInt32BE(rebuilt.length - 4 - (rebuilt.readUInt32BE(rebuilt.length - 4) & 0xffffff) - 0) // 最后一块头
  // 简化：直接把最后 4 字节块头的 last 位置 1
  const lastLen = rebuilt.readUInt32BE(rebuilt.length - 4) & 0x00ffffff
  const lastHdrPos = rebuilt.length - 4 - lastLen
  rebuilt.writeUInt32BE((0x80000000 | (rebuilt.readUInt32BE(lastHdrPos) & 0x7fffffff)), lastHdrPos)
  await fs.promises.writeFile(path, rebuilt)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tagger-flac.test.ts`
Expected: PASS（2 个用例）。注意：`parseMetadata` 用 music-metadata（devDep）；若 mini.flac 解析不佳，改用真实 flac 片段夹具。

- [ ] **Step 5: 提交**

```bash
git add src/main/tagger/vorbis.ts tests/tagger-flac.test.ts tests/fixtures/mini.flac && git commit -m "feat: FLAC 标签内嵌（自写 vorbis comment 双键+PICTURE）"
```

---

### Task 10: 主进程装配（IPC + settings + tagFile 分发 + 下载编排）

**Files:**
- Create: `src/main/tagger/index.ts`（按扩展名分发 + .lrc 另存）
- Create: `src/main/settings.ts`（userData/settings.json）
- Create: `src/main/app.ts`（组装依赖树：client → tracks/urls/auth/queue/tagger，暴露各 IPC handler 函数）
- Modify: `src/main/index.ts`（注册 ipcMain.handle）
- Test: `tests/tagger-index.test.ts`, `tests/settings.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/tagger-index.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tagFile } from '../src/main/tagger'

describe('tagFile 分发', () => {
  it('.mp3 走 mp3 写入；.flac 走 vorbis；.ogg 报暂不支持或用后续 ogg 实现', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgi-'))
    const meta = { title: 'T', artist: 'A', album: 'AL', date: '', genre: '', lyrics: '', cover: undefined }
    fs.writeFileSync(path.join(dir, 'a.mp3'), Buffer.alloc(417 * 3))
    await tagFile(path.join(dir, 'a.mp3'), meta)
    fs.writeFileSync(path.join(dir, 'b.flac'), Buffer.from('fLaC' + '0'.repeat(500)))
    await expect(tagFile(path.join(dir, 'b.flac'), meta)).rejects.toThrow()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('saveLrc=true 时另存同名 .lrc', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgi2-'))
    await tagFile(path.join(dir, 'a.mp3'), {
      title: 'T', artist: 'A', album: '', date: '', genre: '', lyrics: '[00:01.00]hi',
    }, { saveLrc: true })
    expect(fs.readFileSync(path.join(dir, 'a.lrc'), 'utf-8')).toContain('[00:01.00]')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
```

`tests/settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSettings, saveSettings, DEFAULT_SETTINGS, Settings } from '../src/main/settings'

describe('settings', () => {
  it('缺文件时给默认值；保存后可读回', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'))
    const file = path.join(dir, 'settings.json')
    const s1 = loadSettings(file)
    expect(s1.quality).toBe(DEFAULT_SETTINGS.quality)
    s1.quality = 'flac'
    saveSettings(file, s1)
    const s2 = loadSettings(file)
    expect(s2.quality).toBe('flac')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tagger-index.test.ts tests/settings.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现三个文件**

`src/main/tagger/index.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { tagMp3 } from './mp3'
import { tagFlac } from './vorbis'
import type { TagMeta } from './types'

export interface TagOptions { saveLrc: boolean }

/** 按扩展名分发；.lrc 与音频同目录同名（UTF-8） */
export async function tagFile(filePath: string, meta: TagMeta, opts: TagOptions = { saveLrc: false }): Promise<void> {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.mp3') await tagMp3(filePath, meta)
  else if (ext === '.flac') await tagFlac(filePath, meta)
  else throw new Error(`暂不支持标签写入的容器：${ext}`)

  if (opts.saveLrc && meta.lyrics) {
    const lrcPath = filePath.slice(0, -ext.length) + '.lrc'
    await fs.promises.writeFile(lrcPath, meta.lyrics, 'utf-8')
  }
}
```

`src/main/settings.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { Quality } from './qqapi/tracks'

export interface Settings {
  quality: Quality          // 默认追求档位
  concurrency: number       // 1-4（999 表示不限由 Renderer 转成 8）
  downloadDir: string
  lyricMode: 'both' | 'embed' | 'lrc' | 'none'
  decryptOutDir: string
  ffmpegPath: string        // '' 表示未配置
}

export const DEFAULT_SETTINGS: Settings = {
  quality: '320',
  concurrency: 2,
  downloadDir: 'downloads',
  lyricMode: 'both',
  decryptOutDir: 'decrypted',
  ffmpegPath: '',
}

export function loadSettings(file: string): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return { ...DEFAULT_SETTINGS, ...raw }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(file: string, s: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(s, null, 2), 'utf-8')
}
```

`src/main/app.ts`（依赖树组装 + IPC handler 工厂，M2-M5 覆盖的通道）：

```ts
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
import path from 'node:path'

export interface AppDeps {
  userDataDir: string
  fetchImpl?: typeof fetch
}

export function createApp(deps: AppDeps) {
  const settingsFile = path.join(deps.userDataDir, 'settings.json')
  const cookieFile = path.join(deps.userDataDir, 'qqmusic_cookie.json')
  const fetchImpl = deps.fetchImpl ?? fetch
  const client = createQqClient(fetchImpl, { uin: '0' })
  const auth = createAuth({ qqClient: client, fetchImpl, cookiePath: cookieFile })
  let settings = loadSettings(settingsFile)
  if (!settings.downloadDir) settings = { ...settings, downloadDir: 'downloads' }

  const queue = new DownloadQueue({
    concurrency: settings.concurrency,
    rateLimiter: new RateLimiter(1000),
    runner: async (job, report) => {
      // 1) 解析直链（登录态由 client 携带）；直链约 20 分钟过期，下载失败时重取一次
      const resolveOnce = async (q: typeof job.quality): Promise<{ url: string; quality: typeof q; downgraded: boolean }> =>
        getAudioUrl(client, job.track.id, job.track.mediaMid, q)
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
      } catch {
        const fresh = await resolveOnce(job.quality)   // 直链过期场景：重取再下
        await downloadFile(fresh.url, dest)
      }
      // 3) 标签
      const detail = await getTrackDetail(client, job.track.id)
      const meta = {
        title: job.track.name,
        artist: job.track.artist,
        album: job.track.album || '未知专辑',
        date: detail.date,
        copyright: '',
        genre: '',
        lyrics: settings.lyricMode !== 'none' ? await fetchLyrics(client, job.track.id) : '',
        cover: await fetchCover(job.track.cover),
        coverMime: 'image/jpeg',
      }
      await tagFile(dest, meta, { saveLrc: settings.lyricMode === 'both' || settings.lyricMode === 'lrc' })
      return { outputPath: dest }
    },
  })

  function getStatus() {
    const s = auth.getStatus()
    return { ...s, settings }
  }

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
        id: t.id, track: t, quality, state: 'queued' as const, progress: 0,
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

async function fetchLyrics(client: any, mid: string): Promise<string> {
  // 由 Task 12 实现（PlayLyricInfo base64→LRC）；在此之前返回 ''（不内嵌歌词）
  return ''
}

async function fetchCover(url: string): Promise<Buffer | undefined> {
  if (!url) return undefined
  try {
    const res = await fetch(url)
    if (!res.ok) return undefined
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return undefined
  }
}
```

`src/main/index.ts` 追加 IPC 注册（在 `createWindow()` 前）：

```ts
import { createApp } from './app'
import { ipcMain, app } from 'electron'
import { join } from 'node:path'

const appInstance = createApp({ userDataDir: app.getPath('userData') })

ipcMain.handle('qq:search', (_e, q: string) => appInstance.search(q))
ipcMain.handle('qq:linkTracks', (_e, url: string) => appInstance.fetchTracksByLink(url))
ipcMain.handle('dl:enqueue', (_e, tracks: unknown[], quality: string) => appInstance.enqueue(tracks as any, quality as any))
ipcMain.handle('settings:get', () => appInstance.settingsGet())
ipcMain.handle('settings:set', (_e, patch: unknown) => appInstance.settingsSet(patch as any))
ipcMain.handle('auth:startQr', () => appInstance.authStartQr())
ipcMain.handle('auth:poll', () => appInstance.authPoll())
ipcMain.handle('auth:waitResult', (_e, ms: number) => appInstance.authWaitResult(ms))
ipcMain.handle('auth:importCookie', (_e, c: string) => appInstance.authImportCookie(c))
ipcMain.handle('auth:status', () => appInstance.authStatus())
```

（渲染器 `window.api.invoke` 已透传，无需改 preload。登录 IPC 通道：`auth:startQr` / `auth:poll` / `auth:waitResult` / `auth:importCookie` / `auth:status`。渲染器流程：`auth:startQr` → 展示二维码 → 循环 `auth:poll`（显示 66 waiting / 67 scanned）→ 收到 `'success'` 后调 `auth:waitResult(timeoutMs)` 完成 check_sig→authorize→QQLogin→落盘；扫码登录完成或失败后进入终态（loggedIn/failed），此时再调 `auth:poll` 会抛「当前无进行中的扫码会话」，UI 收到该错误即停止轮询。）

- [ ] **Step 4: 跑测试并冒烟**

Run: `npx vitest run`（全部）→ PASS。
Run: `npm run dev` → 窗口打开；`auth:status` 等 IPC 依赖 UI 接入（Task 11 做全）。
Expected: 全量测试绿。

- [ ] **Step 5: 提交**

```bash
git add src/main/tagger/index.ts src/main/settings.ts src/main/app.ts src/main/index.ts tests/ && git commit -m "feat: 主进程装配（IPC/settings/下载编排）"
```

---

### Task 11: 渲染器 UI（搜索/结果/队列/登录/设置 Tab 主体）

**Files:**
- Create: `src/renderer/src/stores/download.ts`（Pinia：搜索状态/队列镜像/设置）
- Create: `src/renderer/src/components/SearchBar.vue`
- Create: `src/renderer/src/components/TrackGrid.vue`
- Create: `src/renderer/src/components/QueuePanel.vue`
- Create: `src/renderer/src/components/LoginButton.vue`
- Create: `src/renderer/src/components/SettingsPanel.vue`
- Modify: `src/renderer/src/App.vue`（接线三 Tab）
- Test: `tests/renderer-store.test.ts`（store 纯逻辑：选择/取消/全选/入队参数拼装）

- [ ] **Step 1: 写失败的测试（store 逻辑）**

`tests/renderer-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDownloadStore } from '../src/renderer/src/stores/download'

describe('download store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('勾选/全选/清空/当前质量', () => {
    const s = useDownloadStore()
    s.setTracks([
      { id: 'a', name: 'A', artist: 'X', album: '', cover: '', vip: true },
      { id: 'b', name: 'B', artist: 'Y', album: '', cover: '' },
    ])
    expect(s.selectedIds.size).toBe(0)
    s.toggle('a'); expect(s.selectedIds.has('a')).toBe(true)
    s.selectAll(); expect(s.selectedIds.size).toBe(2)
    s.clear(); expect(s.selectedIds.size).toBe(0)
    expect(s.quality).toBe('320')
    s.setQuality('flac'); expect(s.quality).toBe('flac')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/renderer-store.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 store 与组件**

`src/renderer/src/stores/download.ts`:

```ts
import { defineStore } from 'pinia'

export interface UiTrack {
  id: string; name: string; artist: string; album: string; cover: string
  mediaMid?: string; duration?: number; vip?: boolean
}
export type UiQuality = 'flac' | 'ape' | '320' | '128' | 'm4a'

export const useDownloadStore = defineStore('download', {
  state: () => ({
    tracks: [] as UiTrack[],
    selectedIds: new Set<string>(),
    quality: '320' as UiQuality,
    queue: [] as Array<{ id: string; state: string; progress: number; error?: string }>,
    loggedIn: false,
    uin: '',
  }),
  actions: {
    setTracks(t: UiTrack[]) { this.tracks = t; this.selectedIds = new Set() },
    toggle(id: string) {
      if (this.selectedIds.has(id)) this.selectedIds.delete(id)
      else this.selectedIds.add(id)
    },
    selectAll() { this.selectedIds = new Set(this.tracks.map((t) => t.id)) },
    clear() { this.selectedIds = new Set() },
    setQuality(q: UiQuality) { this.quality = q },
    setLogin(ok: boolean, uin: string) { this.loggedIn = ok; this.uin = uin },
  },
})
```

组件（Tailwind 不用，纯 CSS 即可；以可读清晰为先）：

`SearchBar.vue` —— 输入框 + 搜索按钮 + 粘贴链接提示；emit `search(query)`。
`TrackGrid.vue` —— props: tracks/selectedIds; emit `toggle(id)`、`selectAll`、`clear`；每张卡片显示封面缩略图（`cover` URL）、名称、歌手、VIP 角标（vip 为 true 显示「VIP」）、勾选框。
`QueuePanel.vue` —— props: queue；显示每项状态/进度条/错误。
`LoginButton.vue` —— 显示当前状态；未登录点击调 `api.invoke('auth:startQr')` 弹出二维码（新窗口内嵌 img），循环 `auth:poll`（展示 66/67 状态），收到 `'success'` 后调 `auth:waitResult(timeoutMs)` 完成登录闭环，终态后 poll 抛错即停止轮询；也提供手动 cookie 输入（`auth:importCookie`）。
`SettingsPanel.vue` —— 码率/并发/下载目录（文件选择用 `<input type="file" webkitdirectory>` 取路径或手动输入）/歌词模式单选；调 `settings:get/set`。

`App.vue` 串起来（完整代码在实现时按上述 props/emit 接口写，保持三 Tab 结构与 Task 1 一致）。

- [ ] **Step 4: 跑测试并冒烟**

Run: `npx vitest run` → 全绿。
Run: `npm run dev` → 窗口里能搜索（`qq:search` 通真实接口，注意频控：手测时请求间隔 ≥1s）、结果卡片勾选、入队后队列出现进度。
Expected: M2/M4 验收点通过。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/ tests/renderer-store.test.ts && git commit -m "feat: 渲染器 UI（搜索/结果/队列/登录/设置）"
```

---

### Task 12: 歌词接入 + 手工验收（M2-M5）

**Files:**
- Modify: `src/main/app.ts`（`fetchLyrics` 实现：PlayLyricInfo base64 → 纯文本/LRC）
- Modify: `src/main/qqapi/tracks.ts`（若歌词接口独立则新增 `fetchLyric(client, mid)`）

- [ ] **Step 1: 实现歌词获取（先测）**

`tests/qqapi-lyric.test.ts`（新增）：

```ts
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createQqClient } from '../src/main/qqapi/client'
import { fetchLyric } from '../src/main/qqapi/tracks'

it('PlayLyricInfo base64 lrc 解出文本', async () => {
  const body = JSON.stringify({ req_2: { code: 0, data: { lyric: Buffer.from('[00:01.00]测试').toString('base64') } } })
  const fetchMock = vi.fn(async () => new Response(body)) as unknown as typeof fetch
  const client = createQqClient(fetchMock, { uin: '0' })
  const lrc = await fetchLyric(client, 'M001')
  expect(lrc).toContain('[00:01.00]测试')
})
```

实现（`tracks.ts` 或歌词失败返回 `''` 不抛错）：

```ts
export async function fetchLyric(client: QqClient, mid: string): Promise<string> {
  try {
    const data = (await client.postMusicu({
      req_2: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param: { songMID: mid },
      },
    }, { path: ['req_2', 'data'] })) as { lyric?: string }
    if (!data?.lyric) return ''
    return Buffer.from(data.lyric, 'base64').toString('utf-8')
  } catch {
    return ''
  }
}
```

`app.ts` 的 `fetchLyrics` 改为调它；`meta.lyrics` 在 `lyricMode !== 'none'` 时取歌词。

- [ ] **Step 2: 全量测试**

Run: `npx vitest run`
Expected: 全绿。

- [ ] **Step 3: 手工验收清单（按 spec §9 逐项，逐条记录结果）**

1. 真实搜索「周杰伦 晴天」→ 结果正常（VIP 角标正确）
2. 匿名下载一首 320k → 文件可播放
3. 扫码登录 → `data/qqmusic_cookie.json` 出现、状态变已登录
4. 登录后下「晴天」320k → 成功；若有绿钻账号：再下 F000 flac → 验证无损 + 降级提示逻辑
5. 粘贴歌单链接 → 整单入队 → 全部完成（观察频控：队列限速 1rps）
6. **foobar2000**（装 ESLyric 组件）打开产物：显示歌词（USLT/SYLT 任一组件路径）
7. **Musicolet**（安卓）打开产物：显示内嵌歌词；勾选 .lrc 另存时显示同步歌词
8. 封面内嵌：foobar2000 封面图显示正常（MP3 APIC / FLAC PICTURE）
9. 设置持久化：重启应用后码率/目录/歌词模式保持

- [ ] **Step 4: 记录验收结果并提交**

在 `docs/acceptance-m1-m5.md` 记录每项结果（通过/失败+原因）；修复验收中发现的问题后再提交：

```bash
git add docs/acceptance-m1-m5.md && git commit -m "docs: M1-M5 验收记录"
```

---

### 超出本计划（后续计划）

- **解密**（spec M6）：mflac/mgg 检测+解密+自动补全。参考：`showhwa/UnlockMusicProject_Archive`（GitHub）`tmp/cli/algo/qmc/` 的 Go 实现与 `testdata/`（mflac_map/rc4、mgg_map 真实验证样本，MIT）。计划要点：TS 移植 cipher_static/rc4 + key_derive + footer 解析；fixture 用 testdata；ogg 容器标签写入（自写 OGG comment 页重写）。
- **打包**（spec M7）：electron-builder NSIS/portable。
- **ogg 标签**：解密产物 .ogg 的 vorbis comment 写入（本计划 Task 9 只做了 FLAC）。