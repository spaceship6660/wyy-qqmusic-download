# 整张专辑下载与标准专辑封装 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 QQ 音乐与网易云两侧都能「下载整张专辑」，产物按标准发行形态组织（专辑子目录 + `NN 曲名.ext` + `cover.jpg` + `album.cue`），并并入 9 项音质/登录态缺陷修复，升版 0.7.0。

**Architecture:** 方案 A「批次上下文」——专辑元数据在打开专辑页的那一次请求里解析成 `AlbumBundle`，随 `DownloadJob` 传递；下载骨架（`src/main/app.ts:101` `runDownloadJob`）按 `job.album` 决定落盘路径与额外标签，不建第二条管线；批次完成度由 `AlbumPackager` 跟踪，某碟下齐才写该碟的 `album.cue`。

**Tech Stack:** Electron 36 / TypeScript / Vue 3 + Pinia / Vitest / node-id3 / music-metadata（测试读回）。

**规格来源：** `docs/superpowers/specs/2026-10-06-album-packaging-design.md`（本计划所有决策的出处；冲突以 spec 为准）。

---

## 全局约定（每个任务都适用）

1. **验证门槛**：每个任务收尾前跑 `npx vitest run <该任务的测试文件>`；阶段末跑 `npm run typecheck` 与 `npx vitest run` 全量。
2. **提交**：本项目约定 commit 前须用户明示。每个任务末尾的 Commit 步骤写作 `（等用户明示）`——未获批准就跳过、继续下一任务，不要自行提交。
3. **禁止真实网络单测**：所有新单测用 mock fetch 或本地 server。真实接口只做手工验收（Task 16 清单），临时探针跑完即删。
4. **平铺下载不得回归**：`job.album` 缺省路径必须与 0.6.1 逐字节一致。每个改 `runDownloadJob` / `tagger` 的任务都带一条「无 album 时行为不变」的反锚用例。

## 文件结构

**新建**

| 文件 | 职责 |
|---|---|
| `src/main/albumBundle.ts` | `AlbumBundle` 类型、日期归一、碟号采信、bundle 组装、目录/文件名与路径计算。**不解析原始 JSON、不 import 网络层实现**（纯函数，见 Task 5 职责边界） |
| `src/main/albumPackaging.ts` | `renderCue`（纯文本生成）+ `AlbumPackager`（批次完成度跟踪） |
| `tests/albumBundle.test.ts` | 解析与命名单测 |
| `tests/albumPackaging.test.ts` | cue 生成与完成度单测 |
| `docs/acceptance-album.md` | 手工验收清单 |

**修改**

| 文件 | 改什么 |
|---|---|
| `src/main/qqapi/tracks.ts` | `TrackDTO` +`trackNo`/`disc`；`fetchAlbum` → `fetchAlbumInfo`（保留 `fetchAlbum` 兼容壳） |
| `src/main/neteaseapi/tracks.ts` | `neAlbumSongs` → `neAlbumInfo`；`neAccountChecked`（异常上抛） |
| `src/main/neteaseapi/urls.ts` | ape/m4a 起跳点、降级判定 |
| `src/main/tagger/{types,mp3,vorbis}.ts` | track/disc 帧与键 |
| `src/main/downloader/queue.ts` | `DownloadJob` +`album`/`finalQuality` |
| `src/main/app.ts` | 专辑路径、packager 接线、`neAuthStatus` 三态与缓存 |
| `src/main/index.ts` | 三个 IPC 返回形状 |
| `src/renderer/src/components/DownloadOptions.vue` | `source` prop + 档位过滤 + 自动回落 |
| `src/renderer/src/components/NeteaseTab.vue` | 选择条常驻、bundle 持有、「下载整张」按钮 |
| `src/renderer/src/App.vue` | 同上（QQ 侧）+ `neSessionExpired` 同步 |
| `src/renderer/src/components/DownloadPage.vue` | 降级文案回显落档 |
| `src/renderer/src/stores/download.ts` | `UiQueueJob` +`finalQuality` |
| `package.json` / `README.md` | 0.7.0 与文档同步 |

---

## 阶段 A：缺陷修复（独立可验，先落地）

### Task 1: 网易云档位起跳点与降级判定

**Files:**
- Modify: `src/main/neteaseapi/urls.ts:28-53`
- Test: `tests/neteaseapi-urls.test.ts`（改 `:78-83` 旧用例 + 新增）

- [ ] **Step 1: 改写旧用例为失败态（锁定 bug）**

把 `tests/neteaseapi-urls.test.ts:78-83` 整段替换为：

```ts
  it('ape 档必须先打 br=999000（无损），不得从 320 起跳', async () => {
    const requested: string[] = []
    const client = createNeClient(urlFetch([{ url: 'https://m10.music.126.net/a.flac', br: 1065126 }], requested))
    const r = await neGetAudioUrl(client, 103027, 'ape')
    expect(requested[0]).toContain('br=999000')
    expect(r.quality).toBe('flac')
    expect(r.downgraded).toBe(false) // ape → 真无损到手：不是降级（旧实现恒判 true，是误报）
  })

  it('ape 无损拿不到 → 降 320 且标降级', async () => {
    const client = createNeClient(urlFetch([
      { url: null, br: 0 },
      { url: 'https://m10.music.126.net/320.mp3', br: 320000 },
    ]))
    const r = await neGetAudioUrl(client, 103027, 'ape')
    expect(r.quality).toBe('320')
    expect(r.downgraded).toBe(true)
  })

  it('m4a 同 ape：从无损起跳', async () => {
    const requested: string[] = []
    const client = createNeClient(urlFetch([{ url: 'https://m10.music.126.net/a.flac', br: 902102 }], requested))
    const r = await neGetAudioUrl(client, 103027, 'm4a')
    expect(requested[0]).toContain('br=999000')
    expect(r.quality).toBe('flac')
    expect(r.downgraded).toBe(false)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/neteaseapi-urls.test.ts`
Expected: FAIL — `expected 'br=320000' to contain 'br=999000'`，以及 `expected true to be false`

- [ ] **Step 3: 改实现**

`src/main/neteaseapi/urls.ts` 把 `neGetAudioUrl` 函数体（`:28-53`）换成：

```ts
export async function neGetAudioUrl(
  client: NeClient,
  id: number,
  preferred: Quality,
  debug?: (line: string) => void,
): Promise<NeAudioUrlResult> {
  // ape/m4a 在网易云没有对应 br 档，但它们表达的是「用户想要尽可能高的音质」，
  // 所以起跳点取降级链首位（无损）。旧实现写 startIdx=1（从 320 起），等于
  // 「选了 APE 就对整张网易云歌单放弃无损」——2026-10-06 实机三首全标「已降级」的根因。
  const supported = NE_QUALITY_BR[preferred] !== undefined
  const targetIdx = supported ? NE_LADDER.indexOf(preferred) : 0
  for (let i = targetIdx; i < NE_LADDER.length; i++) {
    const q = NE_LADDER[i]
    const br = NE_QUALITY_BR[q]!
    const json = await client.getJson<{ code?: number; data?: Array<{ url?: string | null; br?: number }> }>(
      `https://music.163.com/api/song/enhance/player/url?ids=[${id}]&br=${br}`,
    )
    const row = json?.data?.[0]
    const url = row?.url
    // 诊断：只记命中与否 + 业务码，不记直链（失败现场定位：版权空 vs 风控 vs 权益）
    debug?.(`ne vkey ${id} ${q}(br=${br})：${url ? `命中(实际br=${row?.br ?? '?'})` : `空(code=${json?.code ?? '?'})`}`)
    if (url) {
      // 以响应 br 校正实际质量；拿不到 br 才回退请求档。
      // 降级 = 实际档比目标档低。ape/m4a 的目标档按无损算，故「ape → 无损」不算降级。
      const actual = qualityFromBr(row?.br) ?? q
      const actualIdx = NE_LADDER.indexOf(actual)
      return { url, quality: actual, downgraded: actualIdx > targetIdx }
    }
  }
  throw new QqApiError(
    // 2026-09-06 真实网络冒烟：普通歌匿名 320k 可下（code 200）；个别版权歌匿名 url
    // 404（如周杰伦类），登录后可下。文案按登录态分流，避免「会员」误导。
    client.getCookie()
      ? '未拿到可播放 URL（可能无版权/未上架，或账号无对应权益）'
      : '未拿到可播放 URL（匿名仅可下普通歌；此歌可能需登录，登录后可下载更多）',
    'no-playable-url',
  )
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `npx vitest run tests/neteaseapi-urls.test.ts`
Expected: PASS（含原有 6 条用例不回归）

- [ ] **Step 5: Commit（等用户明示）**

```bash
git add src/main/neteaseapi/urls.ts tests/neteaseapi-urls.test.ts
git commit -m "fix(netease): ape/m4a 档从无损起跳，降级判定不再无条件为真"
```

---

### Task 2: 码率选择条常驻 + 按源过滤档位

**Files:**
- Modify: `src/renderer/src/components/DownloadOptions.vue`
- Modify: `src/renderer/src/components/NeteaseTab.vue:189`
- Modify: `src/renderer/src/App.vue:958,976`
- Test: `tests/renderer-store.test.ts`（追加 store 层回落用例）

- [ ] **Step 1: 重写 DownloadOptions**

`src/renderer/src/components/DownloadOptions.vue` 整个文件替换为：

```vue
<script setup lang="ts">
import { computed, watch } from 'vue'
import { useDownloadStore } from '../stores/download'
import { api } from '../api'

// 下载时选择器：码率 + 歌词模式（本次下载批次生效；改动即持久化为默认值，
// 下次打开接着用——设置页存的是同一份，启动时由 App.vue 从 settings:get 载入 store）
//
// source 决定可见档位：APE/m4a 是 QQ 独有档，网易云没有对应 br。
// 把 QQ 档位摆给网易云用会静默丢无损（历史上还会恒标「已降级」），
// 所以这里按源过滤，且当前档位不在可见档内时立即回落无损并持久化。
const props = defineProps<{ source: 'qq' | 'netease' }>()
const store = useDownloadStore()

type Q = 'flac' | 'ape' | '320' | '128' | 'm4a'
const QQ_QUALITIES: Array<{ v: Q; label: string }> = [
  { v: 'flac', label: '无损' },
  { v: 'ape', label: 'APE' },
  { v: '320', label: '320k' },
  { v: '128', label: '128k' },
  { v: 'm4a', label: 'm4a' },
]
const NE_QUALITIES: Array<{ v: Q; label: string }> = [
  { v: 'flac', label: '无损' },
  { v: '320', label: '320k' },
  { v: '128', label: '128k' },
]
const visible = computed(() => (props.source === 'netease' ? NE_QUALITIES : QQ_QUALITIES))

function setQuality(q: Q): void {
  store.setQuality(q)
  void api.invoke('settings:set', { quality: q })
}

function setLyricMode(m: 'both' | 'embed' | 'lrc' | 'none'): void {
  store.setLyricMode(m)
  void api.invoke('settings:set', { lyricMode: m })
}

// 当前档位对本源不可用时回落。immediate 保证首次挂载即校正：
// settings.json 里可能残留另一源写入的档位（如 QQ 侧选过 ape），
// 不回落就会带着无效档位进下载管线。
watch(
  () => [props.source, store.quality] as const,
  () => {
    if (!visible.value.some((x) => x.v === store.quality)) setQuality('flac')
  },
  { immediate: true },
)

const LYRIC_MODES: Array<{ v: 'both' | 'embed' | 'lrc' | 'none'; label: string }> = [
  { v: 'both', label: '内嵌+另存' },
  { v: 'embed', label: '仅内嵌' },
  { v: 'lrc', label: '仅另存' },
  { v: 'none', label: '不保存' },
]
</script>

<template>
  <div class="download-options">
    <span class="label">码率</span>
    <label v-for="q in visible" :key="q.v" class="opt">
      <input type="radio" name="quality" :value="q.v" :checked="store.quality === q.v" @change="setQuality(q.v)" />
      {{ q.label }}
    </label>
    <span class="label">歌词</span>
    <label v-for="m in LYRIC_MODES" :key="m.v" class="opt">
      <input type="radio" name="lyric-mode" :value="m.v" :checked="store.lyricMode === m.v" @change="setLyricMode(m.v)" />
      {{ m.label }}
    </label>
  </div>
</template>

<style scoped>
.download-options {
  display: flex;
  align-items: center;
  gap: 4px 12px;
  flex-wrap: wrap;
  padding: 8px 12px;
  margin-bottom: 12px;
  background: #fff;
  border: 1px solid #e3e6ea;
  border-radius: 8px;
  font-size: 13px;
  /* 置顶：翻长列表时码率/歌词选项始终可见（滚动容器是 main.content，sticky 相对它生效） */
  position: sticky;
  top: 0;
  z-index: 5;
}
.label { color: #666; margin-right: 2px; }
.opt { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; color: #444; }
.opt input { accent-color: #31c27c; }
</style>
```

- [ ] **Step 2: 三处调用点补 source，并去掉 tab 条件**

`src/renderer/src/components/NeteaseTab.vue:189`：

```vue
    <DownloadOptions source="netease" />
```

（原为 `<DownloadOptions v-if="searchTab === 'song'" />`。这行在三个分支之前，去掉条件后歌曲列表 / 专辑卡片 / 专辑内联歌曲页全部常驻。）

`src/renderer/src/App.vue:976`（QQ 功能页，该页只下 QQ 列表）：

```vue
        <DownloadOptions source="qq" />
```

`src/renderer/src/App.vue:958`（歌曲列表页，来源随视图）：

```vue
        <DownloadOptions v-if="!listLoading || store.tracks.length > 0" :source="songsView.source" />
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: 通过。若报 `songsView` 可能为 null，把该行改为 `:source="songsView?.source ?? 'qq'"`（该行位于 `v-else-if="songsView"` 块内，vue-tsc 通常能收窄）。

- [ ] **Step 4: 全量测试**

Run: `npx vitest run`
Expected: 全绿（本步不改主进程逻辑，仅确认没碰坏渲染层用例）

- [ ] **Step 5: Commit（等用户明示）**

```bash
git add src/renderer/src/components/DownloadOptions.vue src/renderer/src/components/NeteaseTab.vue src/renderer/src/App.vue
git commit -m "fix(renderer): 码率/歌词选择条在专辑 tab 常驻，档位按来源过滤并自动回落无损"
```

---

### Task 3: 降级文案回显实际落档

> **⚠️ 本节已执行，但实现方式与下文不同（Phase A 评审修正，后续任务勿照抄下文）。**
> 下文 Step 1-4 要求在 `src/main/qqapi/tracks.ts` 新增 `qualityLabel()` 并在 `DownloadPage.vue` 再写一份 `QUALITY_CN` 字面表。Task 2 已经把档位中文名收进 `src/renderer/src/qualityOptions.ts`（`QQ_QUALITIES` 是五档超集），照抄会造出第六份词表、且 `flac` 在不同屏幕显示成 `无损` / `FLAC 无损` / `无损 FLAC`。
> **实际实现**：`labelForQuality(q?: string)` 加在 `qualityOptions.ts`，从 `QQ_QUALITIES` 查表，查不到回落「低品质」；主进程**不**新增 `qualityLabel`（无消费者，`describeTierSizes` 回答的是「该曲有哪些档」这个不同问题）；`tests/quality-label.test.ts` **不**建立，断言并入 `tests/renderer-store.test.ts`。
> 主进程侧只保留 `DownloadJob.finalQuality` 与 `runDownloadJob` 的两处写入（下文 Step 3 的主进程部分仍然有效）。

**Files:**
- Modify: `src/main/downloader/queue.ts:6-19`
- Modify: `src/main/qqapi/tracks.ts`（新增 `qualityLabel`）
- Modify: `src/main/app.ts:126-127,168-169`
- Modify: `src/renderer/src/stores/download.ts:10-13,57-75`
- Modify: `src/renderer/src/components/DownloadPage.vue:95`
- Test: `tests/qqapi-urls.test.ts` 或新建 `tests/quality-label.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/quality-label.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { qualityLabel } from '../src/main/qqapi/tracks'

describe('qualityLabel', () => {
  it('五档中文名与 describeTierSizes 用词一致', () => {
    expect(qualityLabel('flac')).toBe('无损')
    expect(qualityLabel('ape')).toBe('APE')
    expect(qualityLabel('320')).toBe('320k')
    expect(qualityLabel('128')).toBe('128k')
    expect(qualityLabel('m4a')).toBe('m4a')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/quality-label.test.ts`
Expected: FAIL — `qualityLabel is not a function`（导入为 undefined）

- [ ] **Step 3: 实现 `qualityLabel` + `finalQuality`**

`src/main/qqapi/tracks.ts`，紧跟 `describeTierSizes`（`:77` 之后）插入：

```ts
/** 单个档位的中文名。降级提示回显落档时用——describeTierSizes 是「该曲有哪些档」，
 *  这里回答的是「这首最终下成了什么」，两者词表必须一致故同源定义。 */
export function qualityLabel(q: Quality): string {
  return { flac: '无损', ape: 'APE', '320': '320k', '128': '128k', m4a: 'm4a' }[q]
}
```

`src/main/downloader/queue.ts` 的 `DownloadJob` 里，`downgraded?: boolean` 那行（`:16`）下面加一行：

```ts
  finalQuality?: Quality       // 实际落档（降级提示回显用）；缺省=未走完直链解析
```

`src/main/app.ts` 的 `runDownloadJob` 内，两处 `if (first.downgraded)` / `if (fresh.downgraded)` 各补一行落档记录：

```ts
    const first = await spec.resolveOnce(job.quality, available)
    if (first.downgraded) job.downgraded = true
    job.finalQuality = first.quality
```

```ts
      const fresh = await spec.resolveOnce(job.quality, available)
      if (fresh.downgraded) job.downgraded = true
      job.finalQuality = fresh.quality
```

`src/renderer/src/stores/download.ts`：`UiQueueJob` 增 `finalQuality?: string`（`:12` 那组字段里），`onQueueEvent` 的 `entry` 构造里增：

```ts
        error: job.error, downgraded: job.downgraded, anonFallback: job.anonFallback, outputPath: job.outputPath,
        finalQuality: job.finalQuality,
```

- [ ] **Step 4: 改文案**

`src/renderer/src/components/DownloadPage.vue:95`：

```vue
          <span v-if="j.downgraded" class="downgrade">已降级为 {{ j.finalQuality ? QUALITY_CN[j.finalQuality] : '低品质' }}</span>
```

并在该文件 `<script setup>` 里加：

```ts
const QUALITY_CN: Record<string, string> = { flac: '无损', ape: 'APE', '320': '320k', '128': '128k', m4a: 'm4a' }
```

- [ ] **Step 5: 跑测试 + typecheck**

Run: `npx vitest run tests/quality-label.test.ts && npm run typecheck`
Expected: PASS + 通过

- [ ] **Step 6: Commit（等用户明示）**

```bash
git add src/main/qqapi/tracks.ts src/main/downloader/queue.ts src/main/app.ts src/renderer/src/stores/download.ts src/renderer/src/components/DownloadPage.vue tests/quality-label.test.ts
git commit -m "feat: 降级提示回显实际落档"
```

---

### Task 4: 网易云会话判据三态 + 结果缓存 + 侧栏同步

**Files:**
- Modify: `src/main/neteaseapi/tracks.ts:88-99`
- Modify: `src/main/app.ts:591-608`
- Modify: `src/renderer/src/App.vue:583-587`
- Test: `tests/neteaseAuth.test.ts`、`tests/app.test.ts`

- [ ] **Step 1: 写失败测试（探测异常不得判失效）**

`tests/neteaseAuth.test.ts` 里，把 `describe('neLoggedInFromAccount（登录态语义判据）')` 块中那条「反锚」用例（`:37-47`，传字面量 `null` 的那条）整段替换为：

```ts
  it('反锚：cookie 文件在但服务端确认不认 → 文件判据真、语义判据假', () => {
    // 锁本次 bug 根因：getStatus().loggedIn 只看文件存在，旧 cookie 过期后仍返回 true。
    // 语义判据必须拿服务端探测结果（null = 服务端不认）来推翻文件判据。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne3-'))
    const file = path.join(dir, 'net_cookie.json')
    const auth = createNeAuth({ cookiePath: file })
    auth.importCookie('MUSIC_U=EXPIRED_TOKEN; __csrf=z')
    expect(auth.getStatus().loggedIn).toBe(true)      // 文件判据：仍视为已登录（旧行为）
    expect(neLoggedInFromAccount(null)).toBe(false)   // 语义判据：服务端不认 → 必须为假
    fs.rmSync(dir, { recursive: true, force: true })
  })
```

`tests/app.test.ts` 末尾追加（沿用该文件已有的 `createApp({ userDataDir, fetchImpl })` 写法——该文件的 mock 就是注入 `fetchImpl`，不需要本地 server）：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app.test.ts -t "会话判据"`
Expected: FAIL — 第一条返回 `{loggedIn:false, sessionExpired:true}`；第三条 fetch 被调 2 次

- [ ] **Step 3: `neAccountChecked`（异常上抛）**

`src/main/neteaseapi/tracks.ts:88-99` 整段替换为：

```ts
/** 会话有效性权威探测。
 *  与 neAccount 的唯一区别：**传输/风控异常上抛**，只有「服务端确实不认这份凭证」才返回 null。
 *  旧实现把异常一并 catch 成 null，调用方就无法区分「cookie 过期」与「断网/被频控」——
 *  于是网络抖动会被显示成「登录已失效」，把用户赶去重新扫码（2026-10-06 审计发现）。
 *  判据：/api/nuser/account/get 三种情形都回 code=200，只有 profile.userId 有无能区分凭证有效性。 */
export async function neAccountChecked(client: NeClient): Promise<NeAccount | null> {
  const json = await client.getJson<{ profile?: { userId?: number; nickname?: string } }>(
    'https://music.163.com/api/nuser/account/get',
  )
  const p = json?.profile
  if (p?.userId) return { uid: p.userId, nickname: p.nickname ?? '' }
  return null
}

/** 兼容壳：调用方只想要数据、不关心「为什么拿不到」时用它（异常吞成 null）。 */
export async function neAccount(client: NeClient): Promise<NeAccount | null> {
  try {
    return await neAccountChecked(client)
  } catch {
    return null
  }
}
```

- [ ] **Step 4: `neAuthStatus` 三态 + 缓存**

`src/main/app.ts` 顶部 import 区（`:11`）把 `neAccount` 那行改为同时引入 checked 版与语义判据：

```ts
import { neSearch, neUserPlaylist, nePlaylistDetail, neGetTrackDetail, neAccount, neAccountChecked, clearNeteaseTrackIdsCache } from './neteaseapi/tracks'
```

并在 `:8` 的 auth import 后加一行：

```ts
import { neLoggedInFromAccount } from './neteaseAuth'
```

`src/main/app.ts:591-608` 的 `neAuthStatus` 整段替换为：

```ts
    /** 登录态：文件存在 + 服务端确认有效才算「已登录」。
     *  三态严格分开（2026-10-06 审计修复）：
     *    服务端回带 profile.userId → 已登录；
     *    服务端确认不认（profile 空）→ 未登录 + sessionExpired；
     *    请求本身失败（断网/风控空响应）→ 判不了，保守沿用文件判据，**不置 sessionExpired**。
     *  旧实现走 neAccount（异常也吞成 null），第三种情形塌进第二种，断网即误报「登录已失效」。
     *  结果缓存 60s：App.vue 与 NeteaseTab.vue 挂载时各调一次、之后每次进网易云页再调，
     *  不缓存会白打网络并挤占网易云频控预算（README「限速范围」条）。 */
    neAuthStatus: async () => {
      const hasFile = neAuth.getStatus().loggedIn
      if (!hasFile) {
        neSessionExpired = false
        neStatusCache = null
        return { loggedIn: false }
      }
      if (neStatusCache && Date.now() - neStatusCache.at < NE_STATUS_TTL_MS) return neStatusCache.value
      let value: { loggedIn: boolean; sessionExpired?: boolean }
      try {
        const acc = await neAccountChecked(neClient)
        if (neLoggedInFromAccount(acc)) {
          neSessionExpired = false
          value = { loggedIn: true, sessionExpired: false }
        } else {
          neSessionExpired = true
          value = { loggedIn: false, sessionExpired: true }
        }
      } catch {
        // 探测本身失败：无法判定，保留文件判据且不标记失效
        value = { loggedIn: true, sessionExpired: neSessionExpired }
      }
      neStatusCache = { at: Date.now(), value }
      return value
    },
```

在 `app.ts:70` 的 `let neSessionExpired = false` 下方加缓存状态：

```ts
// neAuthStatus 结果缓存（60s）：与 neteaseapi/tracks.ts 的 TRACK_IDS_TTL_MS 同款窗口
const NE_STATUS_TTL_MS = 60_000
let neStatusCache: { at: number; value: { loggedIn: boolean; sessionExpired?: boolean } } | null = null
```

> 注：`NE_STATUS_TTL_MS` 是 `createApp` 内的局部常量，写在函数体内（与 `QQ_SESSION_PROBE_TTL_MS` 同位置风格）。

并在三个会改变登录态的方法里清缓存——`neAuthImport`（`:580`）、`neAuthClear`（`:609`）、`neAuthSaveFromWindow`（`:615`）各自函数体开头加：

```ts
      neStatusCache = null
```

- [ ] **Step 5: 渲染侧同步侧栏状态**

`src/renderer/src/App.vue:583-587` 的 `if (!acc?.uid) { ... }` 分支改为：

```ts
    if (!acc?.uid) {
      // cookie 文件在但服务端不认（会话过期 / MUSIC_U 失效）→ 权威判据
      nePlaylistError.value = '网易云登录状态已失效（cookie 过期），请点左下角「退出」后重新扫码登录'
      neSessionExpired.value = true // 同步侧栏：否则列表说「已失效」而侧栏仍绿色「已登录」
      return
    }
```

- [ ] **Step 6: 跑测试**

Run: `npx vitest run tests/neteaseAuth.test.ts tests/app.test.ts && npm run typecheck`
Expected: 全绿 + 通过

- [ ] **Step 7: Commit（等用户明示）**

```bash
git add src/main/neteaseapi/tracks.ts src/main/app.ts src/renderer/src/App.vue tests/neteaseAuth.test.ts tests/app.test.ts
git commit -m "fix(netease): 会话探测区分「服务端确认无效」与「请求失败」，并缓存登录态结果"
```

---

## 阶段 B：专辑元数据接出来

### Task 5: `albumBundle.ts` 类型、日期归一与命名

**Files:**
- Create: `src/main/albumBundle.ts`
- Test: `tests/albumBundle.test.ts`

**职责边界（重要）**：本模块只做**类型、日期归一、碟号采信、bundle 组装、目录/文件名计算**，**不解析两源原始 JSON**。原始 JSON → `AlbumBundle` 的解析放在各自的 api 模块里（Task 6/7），因为曲目映射已有**经过测试**的实现（`trackFromEntry` / `neteaseTrackToDto` / `isVipEntry`），在 albumBundle 里重写一份等于复制 VIP 判据，还会造成 `albumBundle ↔ qqapi/tracks` 的循环 import。

- [ ] **Step 1: 写失败测试**

新建 `tests/albumBundle.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  mkBundle, normalizeDate, discOf, albumDirName, discSegments, trackBaseName, trackFileName, trackPad,
  albumRootDir, albumTrackDir,
} from '../src/main/albumBundle'
import type { TrackDTO } from '../src/main/qqapi/tracks'

const t = (id: string, name: string, trackNo?: number, disc?: number): TrackDTO =>
  ({ id, name, artist: 'A', album: 'B', cover: '', trackNo, disc }) as TrackDTO

describe('normalizeDate', () => {
  it('13 位毫秒时间戳 → YYYY-MM-DD', () => {
    expect(normalizeDate(1558310400000)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('10 位秒时间戳 → YYYY-MM-DD', () => {
    expect(normalizeDate(1558310400)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('数字型字符串也认', () => {
    expect(normalizeDate('1558310400000')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('已是 YYYY-MM-DD 字符串 → 取前 10 位', () => {
    expect(normalizeDate('2019-05-20')).toBe('2019-05-20')
    expect(normalizeDate('2019-05-20 12:00')).toBe('2019-05-20')
  })
  it('脏值/空 → 空串（不得污染目录名与 cue）', () => {
    expect(normalizeDate('')).toBe('')
    expect(normalizeDate(null)).toBe('')
    expect(normalizeDate(undefined)).toBe('')
    expect(normalizeDate('未确定')).toBe('')
    expect(normalizeDate('2019/05/20')).toBe('')
    expect(normalizeDate(0)).toBe('')
    expect(normalizeDate(-1)).toBe('')
  })
})

describe('discOf（碟号采信）', () => {
  it('≥1 的整数才采信；字符串数字也认', () => {
    expect(discOf(2)).toBe(2)
    expect(discOf('01')).toBe(1)
    expect(discOf('2')).toBe(2)
  })
  it('0 / 缺失 / 非整数 / 负数 → 1（单碟是安全默认）', () => {
    expect(discOf(0)).toBe(1)
    expect(discOf(undefined)).toBe(1)
    expect(discOf(null)).toBe(1)
    expect(discOf('x')).toBe(1)
    expect(discOf(1.5)).toBe(1)
    expect(discOf(-2)).toBe(1)
  })
})

describe('mkBundle', () => {
  it('空名回退「未知专辑/未知歌手」，discs 去重升序，totalTracks 取实长', () => {
    const b = mkBundle('qq', 'm1', '', '', '', '', '', [t('a', 'x', 1, 2), t('b', 'y', 2, 1)])
    expect(b.name).toBe('未知专辑')
    expect(b.artist).toBe('未知歌手')
    expect(b.discs).toEqual([1, 2])
    expect(b.totalTracks).toBe(2)
    expect(b.source).toBe('qq')
    expect(b.id).toBe('m1')
  })
  it('无曲目 → discs 仍是 [1]（不能让下游拿到空数组）', () => {
    expect(mkBundle('netease', '7', 'A', 'S', '', '', '', []).discs).toEqual([1])
  })
})

describe('命名', () => {
  const b = mkBundle('qq', 'x', '奇爱人生 LOVE ELEGIA', '阿良良木健', '2019-05-20', '', '', [t('a', 'x', 1, 1)])

  it('目录名 = 歌手 - 专辑 (年)', () => {
    expect(albumDirName(b)).toBe('阿良良木健 - 奇爱人生 LOVE ELEGIA (2019)')
  })
  it('无日期 → 不带括号段', () => {
    expect(albumDirName({ ...b, date: '' })).toBe('阿良良木健 - 奇爱人生 LOVE ELEGIA')
  })
  it('非法字符进 safeName（目录名不得含 \\ / : * ? " < > |）', () => {
    // safeName 的字符类见 src/main/fsUtils.ts:5，每个非法字符换成 '-'
    expect(albumDirName({ ...b, name: 'A/B:C*D' })).toBe('阿良良木健 - A-B-C-D (2019)')
  })
  it('单碟不追加 CD 段，多碟按碟追加', () => {
    expect(discSegments(b, 1)).toEqual([])
    expect(discSegments({ ...b, discs: [1, 2] }, 2)).toEqual(['CD02'])
  })
  it('序号位数：≥100 首用三位', () => {
    expect(trackPad({ ...b, totalTracks: 13 })).toBe(2)
    expect(trackPad({ ...b, totalTracks: 120 })).toBe(3)
  })
  it('trackBaseName = NN 曲名；trackFileName = 基础名 + .ext', () => {
    expect(trackBaseName(t('a', '告别曲（Love Elegia Ver.）', 1), 2)).toBe('01 告别曲（Love Elegia Ver.）')
    expect(trackFileName(t('a', '告别曲（Love Elegia Ver.）', 1), 2, 'flac')).toBe('01 告别曲（Love Elegia Ver.）.flac')
    expect(trackFileName(t('a', 'x', 7), 3, 'mp3')).toBe('007 x.mp3')
  })
  it('trackNo 缺失 → 按 1（不得出现 NaN 前缀）', () => {
    expect(trackBaseName(t('a', 'x'), 2)).toBe('01 x')
  })
  it('albumRootDir / albumTrackDir：单碟同目录，多碟在专辑根下嵌 CDnn', () => {
    const root = path.join('D', '阿良良木健 - 奇爱人生 LOVE ELEGIA (2019)')
    expect(albumRootDir('D', b)).toBe(root)
    expect(albumTrackDir('D', b, 1)).toBe(root)
    const multi = mkBundle('qq', 'x', '奇爱人生 LOVE ELEGIA', '阿良良木健', '2019-05-20', '', '',
      [t('a', 'x', 1, 1), t('c', 'y', 1, 2)])
    expect(albumRootDir('D', multi)).toBe(root)
    expect(albumTrackDir('D', multi, 2)).toBe(path.join(root, 'CD02'))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/albumBundle.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

新建 `src/main/albumBundle.ts`：

```ts
import path from 'node:path'
import { safeName } from './fsUtils'
import type { TrackDTO } from './qqapi/tracks'

/** 一张专辑的批次上下文：随 DownloadJob 传递，渲染侧原样回传（纯数据，可结构化克隆）。 */
export interface AlbumBundle {
  source: 'qq' | 'netease'
  id: string            // QQ albummid / 网易云 album.id
  name: string
  artist: string
  date: string          // 'YYYY-MM-DD'，可能空串
  company: string       // 可能空串（网易云实测 null）
  coverUrl: string      // 可能空串（空则不写 cover）
  totalTracks: number   // 曲目数组实长——服务端 total_song_num / album.size 与实长口径不一致（实测 21 vs 22），一律以实长为准
  discs: number[]       // 去重升序碟号；长度 1 即单碟
}

export interface AlbumPage {
  bundle: AlbumBundle
  tracks: TrackDTO[]
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/

/** 日期归一：两源发行日字段格式本次未逐值验证（网易云 publishTime 通常是毫秒时间戳，
 *  QQ aDate 观察到 'YYYY-MM-DD'），归一后下游只面对一种格式——目录名取年份与 cue 的
 *  REM DATE 才不会被脏值带崩。认不出一律空串，不猜。 */
export function normalizeDate(v: unknown): string {
  if (typeof v === 'string') {
    const s = v.trim()
    if (DATE_RE.test(s)) return s.slice(0, 10)
    if (/^\d{10}$/.test(s) || /^\d{13}$/.test(s)) return normalizeDate(Number(s))
    return ''
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v < 1e11 ? v * 1000 : v          // 10 位按秒、13 位按毫秒
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return ''
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  return ''
}

/** 碟号采信：仅 ≥1 的整数（字符串数字如网易云的 '01' 也认），其余一律 1。
 *  QQ 的 cdIdx/belongCD 取值语义未经多碟样本验证（spec R1）——异常值退化为单碟是安全默认，
 *  最坏情况是多碟被拍平成连续序号，不会出错只丢结构。 */
export function discOf(v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : 1
}

/** 组装 bundle：曲目映射由各 api 模块用**已有的、经过测试的** mapper 完成，这里只收口元数据。 */
export function mkBundle(
  source: 'qq' | 'netease', id: string, name: string, artist: string,
  date: string, company: string, coverUrl: string, tracks: TrackDTO[],
): AlbumBundle {
  const discs = [...new Set(tracks.map((x) => x.disc ?? 1))].sort((a, b) => a - b)
  return {
    source, id,
    name: name || '未知专辑',
    artist: artist || '未知歌手',
    date, company, coverUrl,
    totalTracks: tracks.length,
    discs: discs.length ? discs : [1],
  }
}

/** 专辑封面大图 URL（曲目封面用的 R300 太小）。R500 形态由 Task 6 Step 4 手工冒烟验证 200 + 图像魔数。 */
export function qqAlbumCoverUrl(albumMid: string): string {
  return albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg` : ''
}

/** 专辑目录名：歌手 - 专辑 (年)。年份取 date 前 4 位，无日期则省略整个括号段。 */
export function albumDirName(b: AlbumBundle): string {
  const year = /^\d{4}-/.test(b.date) ? b.date.slice(0, 4) : ''
  return `${safeName(b.artist)} - ${safeName(b.name)}${year ? ` (${year})` : ''}`
}

/** 碟目录段：多碟时 CD01/CD02…，单碟不追加（专辑根目录即碟目录） */
export function discSegments(b: AlbumBundle, disc: number): string[] {
  return b.discs.length > 1 ? [`CD${String(disc).padStart(2, '0')}`] : []
}

export function trackPad(b: AlbumBundle): number {
  return b.totalTracks >= 100 ? 3 : 2
}

/** 专辑根目录：downloadDir/歌手 - 专辑 (年)。cover 落这里。 */
export function albumRootDir(downloadDir: string, b: AlbumBundle): string {
  return path.join(downloadDir, albumDirName(b))
}

/** 曲目落盘目录：多碟时在专辑根下再嵌 CDnn，单碟即专辑根目录。cue 落这里。 */
export function albumTrackDir(downloadDir: string, b: AlbumBundle, disc: number): string {
  return path.join(albumRootDir(downloadDir, b), ...discSegments(b, disc))
}

/** 不含扩展名的文件名：NN 曲名 */
export function trackBaseName(t: Pick<TrackDTO, 'name' | 'trackNo'>, pad: number): string {
  const no = String(t.trackNo ?? 1).padStart(pad, '0')
  return `${no} ${safeName(t.name)}`
}

export function trackFileName(t: Pick<TrackDTO, 'name' | 'trackNo'>, pad: number, ext: string): string {
  return `${trackBaseName(t, pad)}.${ext}`
}
```

- [ ] **Step 4: `TrackDTO` 增序号与碟号字段**

`src/main/qqapi/tracks.ts` 的 `TrackDTO`（`:6-15`）在 `vip?: boolean` 之前加：

```ts
  trackNo?: number      // 专辑内曲目序号（1 起）；仅专辑来源填充
  disc?: number         // 碟号（1 起）；仅专辑来源填充
```

> 这两个字段必须在这里加，否则 Task 6/7 的 `{ ...trackFromEntry(e), trackNo: i + 1 }` 过不了 `npm run typecheck`。搜索/歌单等非专辑来源不填充它们，平铺下载不受影响。

- [ ] **Step 5: 跑测试**

Run: `npx vitest run tests/albumBundle.test.ts`
Expected: PASS

- [ ] **Step 6: Commit（等用户明示）**

```bash
git add src/main/albumBundle.ts tests/albumBundle.test.ts
git commit -m "feat: 专辑批次上下文类型与封装命名（albumBundle）"
```

---

### Task 6: QQ 专辑接口接出元数据

**Files:**
- Modify: `src/main/qqapi/tracks.ts:231-237`
- Test: `tests/qqapi-tracks.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

`tests/qqapi-tracks.test.ts` 末尾追加（沿用该文件已有的 mock client 写法；下例用 `mockClient(handler)`，若该文件用的是别的名字按实际替换）：

```ts
describe('fetchAlbumInfo（0.7.0 专辑封装）', () => {
  it('返回 { bundle, tracks }，元数据不再被丢弃', async () => {
    const raw = JSON.stringify({ code: 0, data: {
      name: '奇爱人生 LOVE ELEGIA', singername: '阿良良木健', aDate: '2019-05-20',
      company: '未确定', mid: '002xyz', total_song_num: 21,
      list: [{ songmid: 'S1', songname: '告别曲', albummid: '002xyz', singer: [{ name: '阿良良木健' }], cdIdx: 1 }],
    } })
    const client = mockClient(async () => raw)
    const r = await fetchAlbumInfo(client, '002xyz')
    expect(r.bundle).toMatchObject({ source: 'qq', id: '002xyz', name: '奇爱人生 LOVE ELEGIA', totalTracks: 1 })
    expect(r.tracks[0].trackNo).toBe(1)
  })

  it('请求 URL 必须带 .fcg 后缀（漏了得 404，被 client 误报成风控）', async () => {
    const urls: string[] = []
    await fetchAlbumInfo(mockClient(async (u: string) => { urls.push(u); return '{"data":{"list":[]}}' }), 'm1')
    expect(urls[0]).toContain('fcg_v8_album_info_cp.fcg')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/qqapi-tracks.test.ts -t "fetchAlbumInfo"`
Expected: FAIL — `fetchAlbumInfo is not a function`

- [ ] **Step 3: 实现**

`src/main/qqapi/tracks.ts` 顶部 import 加：

```ts
import { mkBundle, normalizeDate, discOf, qqAlbumCoverUrl, type AlbumPage } from '../albumBundle'
```

`:231-237` 的 `fetchAlbum` 整段替换为：

```ts
/** 专辑详情（含专辑级元数据 + 每曲序号/碟号）。
 *  ⚠️ URL 的 .fcg 后缀是必需的：去掉得 HTTP 404 空 body，client.get 会把它报成
 *  「rate-limited: 空响应（风控）」——排查 QQ 专辑问题时先看这条文案有没有骗人（2026-10-06 踩过）。
 *  曲目映射复用同文件已有的 trackFromEntry（含经过测试的 isVipEntry 判据），不另写一份。 */
export async function fetchAlbumInfo(client: QqClient, mid: string): Promise<AlbumPage> {
  const text = await client.get(`https://i.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?albummid=${mid}&format=json`)
  const json = JSON.parse(stripJsonp(text))
  const d = json?.data ?? {}
  const albumMid = typeof d?.mid === 'string' ? d.mid : ''
  const list = (Array.isArray(d?.list) ? d.list : []) as any[]
  const tracks: TrackDTO[] = list.map((e, i) => ({
    ...trackFromEntry(e, d?.name ?? ''),
    trackNo: i + 1,          // 服务端无序号字段（实测条目只有 belongCD/cdIdx）→ 按下标 +1
    disc: discOf(e?.cdIdx),
  }))
  const bundle = mkBundle(
    'qq', albumMid, d?.name ?? '', d?.singername ?? '', normalizeDate(d?.aDate),
    typeof d?.company === 'string' ? d.company : '', qqAlbumCoverUrl(albumMid), tracks,
  )
  return { bundle, tracks }
}

/** 兼容壳：只要曲目列表的调用方（链接导入等） */
export async function fetchAlbum(client: QqClient, mid: string): Promise<TrackDTO[]> {
  return (await fetchAlbumInfo(client, mid)).tracks
}
```

- [ ] **Step 4: 手工冒烟验证封面大图 URL 可用（真实网络，一次性）**

Run（单行，勿建文件）:

```bash
node -e "fetch('https://y.gtimg.cn/music/photo_new/T002R500x500M000001LVtAD0sEPKu.jpg',{headers:{'user-agent':'Mozilla/5.0',referer:'https://y.qq.com/'}}).then(async r=>{const b=Buffer.from(await r.arrayBuffer());console.log(r.status,b.length,b.subarray(0,3).toString('hex'))})"
```

Expected: `200 <字节数> ffd8ff`（JPEG 魔数）。若 404/非图像 → 把 `qqAlbumCoverUrl` 的 `T002R500x500` 改为 `T002R300x300`（该形态已在 `qqCoverUrl` 生产验证），并把结论记进 `docs/acceptance-album.md`。

- [ ] **Step 5: 跑测试 + Commit（等用户明示）**

```bash
npx vitest run tests/qqapi-tracks.test.ts
git add src/main/qqapi/tracks.ts tests/qqapi-tracks.test.ts src/main/albumBundle.ts
git commit -m "feat(qq): 专辑接口接出专辑级元数据与曲目序号"
```

---

### Task 7: 网易云专辑接口接出元数据

**Files:**
- Modify: `src/main/neteaseapi/tracks.ts:128-131`
- Test: `tests/neteaseapi-tracks.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```ts
describe('neAlbumInfo（0.7.0 专辑封装）', () => {
  it('一次请求同时拿到专辑元数据与带序号的曲目', async () => {
    const urls: string[] = []
    const client = mockNeClient(async (u: string) => {
      urls.push(u)
      return new Response(JSON.stringify({ code: 200,
        album: { id: 74829483, name: '奇爱人生 LOVE ELEGIA', artist: { name: '阿良良木健' }, publishTime: 1558310400000, company: null, picUrl: 'https://p/1.jpg', size: 13 },
        songs: [{ id: 1356370987, name: '告别曲', no: 1, cd: '01', ar: [{ name: '阿良良木健' }], al: { name: '奇爱人生 LOVE ELEGIA', picUrl: 'https://p/1.jpg' }, dt: 300000, fee: 1 }] }))
    })
    const r = await neAlbumInfo(client, 74829483)
    expect(urls.length).toBe(1) // 零额外请求：album 与 songs 同响应
    expect(r.bundle).toMatchObject({ source: 'netease', id: '74829483', name: '奇爱人生 LOVE ELEGIA', artist: '阿良良木健', totalTracks: 1 })
    expect(r.bundle.company).toBe('')
    expect(r.tracks[0]).toMatchObject({ trackNo: 1, disc: 1 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/neteaseapi-tracks.test.ts -t "neAlbumInfo"`
Expected: FAIL — `neAlbumInfo is not a function`

- [ ] **Step 3: 实现**

`src/main/neteaseapi/tracks.ts` 顶部 import 加：

```ts
import { mkBundle, normalizeDate, discOf, type AlbumPage } from '../albumBundle'
```

`:128-131` 的 `neAlbumSongs` 整段替换为：

```ts
/** 专辑详情（含专辑级元数据 + 每曲 no/cd）。专辑对象是 `album`（不是 `info`），
 *  与曲目列表在同一次响应里 → 零额外请求。
 *  曲目映射复用同文件已有的 neteaseTrackToDto（双形状兼容，经过测试），不另写一份。 */
export async function neAlbumInfo(client: NeClient, id: number): Promise<AlbumPage> {
  const json = await client.getJson<any>(`https://music.163.com/api/v1/album/${id}`)
  const a = json?.album ?? {}
  const songs = (Array.isArray(json?.songs) ? json.songs : []) as any[]
  const tracks: TrackDTO[] = songs.map((s, i) => ({
    ...neteaseTrackToDto(s),
    trackNo: (typeof s?.no === 'number' && s.no >= 1 ? s.no : undefined) ?? i + 1,
    disc: discOf(s?.cd),
  }))
  const bundle = mkBundle(
    'netease', String(a?.id ?? id), a?.name ?? '', a?.artist?.name ?? '', normalizeDate(a?.publishTime),
    typeof a?.company === 'string' ? a.company : '', a?.picUrl ?? '', tracks,
  )
  return { bundle, tracks }
}

/** 兼容壳：只要曲目列表的调用方 */
export async function neAlbumSongs(client: NeClient, id: number): Promise<TrackDTO[]> {
  return (await neAlbumInfo(client, id)).tracks
}
```

- [ ] **Step 4: 跑测试 + Commit（等用户明示）**

```bash
npx vitest run tests/neteaseapi-tracks.test.ts
git add src/main/neteaseapi/tracks.ts tests/neteaseapi-tracks.test.ts
git commit -m "feat(netease): 专辑接口接出专辑级元数据与曲目序号"
```

---

### Task 8: IPC 返回形状变更 + 渲染侧持有 bundle

**Files:**
- Modify: `src/main/app.ts:445,470-477,574`
- Modify: `src/renderer/src/App.vue:47,85-93,183-232,429-451,989`
- Modify: `src/renderer/src/components/NeteaseTab.vue:24-41,80-84,103-119,192`
- Test: `tests/app.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

`tests/app.test.ts` 末尾追加（沿用该文件已有的 `createApp({ fetchImpl })` + 本地 server 模式）：

```ts
describe('专辑 IPC 形状（0.7.0）', () => {
  it('qqAlbumSongs 返回 { tracks, album }，album 带 totalTracks/discs', async () => {
    const raw = JSON.stringify({ code: 0, data: { name: 'A', singername: 'S', aDate: '2019-01-02', mid: 'm1',
      list: [{ songmid: 'S1', songname: 't1', albummid: 'm1', singer: [{ name: 'S' }], cdIdx: 1 }] } })
    const app = createApp({ userDataDir: mkd(), fetchImpl: fakeFetch({ 'album_info_cp': raw }) })
    const r: any = await app.qqAlbumSongs('m1')
    expect(r.tracks).toHaveLength(1)
    expect(r.album).toMatchObject({ source: 'qq', id: 'm1', totalTracks: 1, discs: [1] })
  })

  it('neAlbumSongs 同样返回 { tracks, album }', async () => {
    const body = JSON.stringify({ code: 200, album: { id: 7, name: 'A', artist: { name: 'S' }, publishTime: 1558310400000, picUrl: '' },
      songs: [{ id: 1, name: 't', no: 1, cd: '01', ar: [{ name: 'S' }], al: { name: 'A' } }] })
    const app = createApp({ userDataDir: mkd(), fetchImpl: fakeFetch({ '/api/v1/album/': body }) })
    const r: any = await app.neAlbumSongs(7)
    expect(r.album).toMatchObject({ source: 'netease', id: '7', totalTracks: 1 })
  })

  it('链接导入专辑也带 album（可整张下载）', async () => {
    const raw = JSON.stringify({ code: 0, data: { name: 'A', singername: 'S', mid: 'm1',
      list: [{ songmid: 'S1', songname: 't1', albummid: 'm1', singer: [{ name: 'S' }] }] } })
    const app = createApp({ userDataDir: mkd(), fetchImpl: fakeFetch({ 'album_info_cp': raw }) })
    const r: any = await app.fetchTracksByLink('https://y.qq.com/n/ryqq/albumDetail/001LVtAD0sEPKu')
    expect(r.album).toMatchObject({ source: 'qq' })
  })
})
```

> `mkd()` / `fakeFetch()` 若该文件没有同名帮助函数，按该文件现有等价工具写（`fs.mkdtempSync` + 一个按 URL 片段路由的 mock fetch）。**不要为此新增生产代码。**

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app.test.ts -t "专辑 IPC"`
Expected: FAIL — 返回的是数组，`r.album` 为 undefined

- [ ] **Step 3: 主进程改三处装配**

`src/main/app.ts` import 区（`:4`、`:13`）扩项：

```ts
import { searchTracks, getTrackDetail, getSingleTrack, parseLink, fetchPlaylist, fetchAlbumInfo, fetchLyric, searchAlbums, describeTierSizes, availableTiers, TrackDTO, TrackDetail, Quality } from './qqapi/tracks'
```

```ts
import { neSearchAlbums, neAlbumInfo, nePlaylistPage } from './neteaseapi/tracks'
```

`app.ts:445`（`qqAlbumSongs`）与 `:574`（`neAlbumSongs`）改为透传：

```ts
    qqAlbumSongs: (mid: string) => fetchAlbumInfo(client, mid),
```

```ts
    neAlbumSongs: (id: number) => neAlbumInfo(client, id),
```

`fetchTracksByLink`（`:470-477`）的 album 分支带出 bundle：

```ts
      if (kind.kind === 'album') {
        const page = await fetchAlbumInfo(client, kind.id)
        return { kind, tracks: page.tracks, album: page.bundle }
      }
```

- [ ] **Step 4: 渲染侧持有 bundle（含 `UiTrack` 字段透传）**

**先补 `UiTrack`**：`src/renderer/src/stores/download.ts:3-6` 的 `UiTrack` 加两字段——渲染侧把 tracks 原样回传给 `dl:enqueue`，`UiTrack` 不声明这两个字段时 `trackNo`/`disc` 会在类型层被丢掉，专辑文件名就会全部退化成 `01 …` 并互相撞名：

```ts
export interface UiTrack {
  id: string; name: string; artist: string; album: string; cover: string
  mediaMid?: string; duration?: number; vip?: boolean
  trackNo?: number; disc?: number   // 专辑序号；仅专辑来源填充（整张下载要用）
}
```

`src/renderer/src/App.vue` 的 `songsView` ref 类型加 `album?`：

```ts
const songsView = ref<{ title: string; source: 'qq' | 'netease'; total?: number; cursor?: LoadCursor; cacheKey?: string; album?: AlbumBundle } | null>(null)
```

`:85-93` 的 `SongsCacheEntry` 加一行：

```ts
  album?: AlbumBundle
```

`FirstPageResult`（`openSongsView` 上方，`:183` 之前）加 `album?`：

```ts
interface FirstPageResult { tracks: UiTrack[]; total?: number; cursor?: LoadCursor; album?: AlbumBundle }
```

`openSongsView` 内三处把 album 带上：

- 缓存命中分支 `:204`：`songsView.value = { title, source, total: hit.total, cursor: hit.cursor, cacheKey: key, album: hit.album }`
- `cacheSongs` 调用 `:221-224`：对象里加 `album: fp.album`
- `:225`：`songsView.value = { title, source, total: fp.total, cursor: fp.cursor, cacheKey: key, album: fp.album }`

`openAlbum`（`:443-448`）的 `fetchFirst` 改为：

```ts
    fetchFirst: async () => {
      const r: any =
        source === 'qq' ? await api.invoke('qq:albumSongs', mid) : await api.invoke('ne:albumSongs', Number(mid))
      const tracks = r?.tracks
      if (!Array.isArray(tracks) || tracks.length === 0) return null
      return { tracks, total: tracks.length, album: r.album }
    },
```

`doSearch` 的链接导入分支（`:348-351`）带 bundle：

```ts
      if (res?.tracks?.length) {
        store.setTracks(res.tracks, 'qq')
        songsView.value = { title: '链接导入', source: 'qq', album: res.album }
      }
```

文件顶部 import 加类型：

```ts
import type { AlbumBundle } from '../../main/albumBundle'
```

- [ ] **Step 5: NeteaseTab.vue 同样持有**

`:40` 下方加：

```ts
/** 当前内联展开的专辑元数据（整张下载用） */
const openedAlbumBundle = ref<AlbumBundle | null>(null)
```

`openAlbum`（`:103-119`）里把 `const tracks: any = await api.invoke('ne:albumSongs', id)` 换成：

```ts
    const r: any = await api.invoke('ne:albumSongs', id)
    const tracks: any = r?.tracks
```

并在 `openedAlbum.value = title` 旁加 `openedAlbumBundle.value = r?.album ?? null`；`doSearch` 的两个 `openedAlbum.value = ''` 之后各补 `openedAlbumBundle.value = null`。

顶部 import 加 `import type { AlbumBundle } from '../../../main/albumBundle'`。

- [ ] **Step 6: 验证 + Commit（等用户明示）**

```bash
npx vitest run tests/app.test.ts && npm run typecheck
git add src/main/app.ts src/renderer/src/App.vue src/renderer/src/components/NeteaseTab.vue tests/app.test.ts
git commit -m "feat: 专辑 IPC 返回 { tracks, album }，渲染侧持有批次元数据"
```

---

## 阶段 C：封装落盘

### Task 9: 标签写入器支持 track/disc

**Files:**
- Modify: `src/main/tagger/types.ts`
- Modify: `src/main/tagger/mp3.ts:24-40`
- Modify: `src/main/tagger/vorbis.ts:91-101`
- Test: `tests/tagger-mp3.test.ts`、`tests/tagger-flac.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/tagger-mp3.test.ts` 追加（沿用该文件的 fixture 复制 + `mm.parseFile` 读回模式）：

```ts
  it('track/disc 写入后可读回（TRCK / TPOS）', async () => {
    const f = await copyFixture('mini.mp3')
    await tagMp3(f, { ...baseMeta, track: 3, trackTotal: 13, disc: 1, discTotal: 2 })
    const t = await mm.parseFile(f)
    expect(t.common.track?.no).toBe(3)
    expect(t.common.track?.total).toBe(13)
    expect(t.common.disk?.no).toBe(1)
    expect(t.common.disk?.total).toBe(2)
  })

  it('反锚：无 track/disc 字段时不得出现 TRCK/TPOS（平铺下载行为不变）', async () => {
    const f = await copyFixture('mini.mp3')
    await tagMp3(f, baseMeta)
    const t = await mm.parseFile(f)
    expect(t.common.track).toBeUndefined()
    expect(t.common.disk).toBeUndefined()
  })
```

`tests/tagger-flac.test.ts` 追加：

```ts
  it('Vorbis 键 TRACKNUMBER/TRACKTOTAL/DISCNUMBER/DISCTOTAL', async () => {
    const f = await copyFixture('mini.flac')
    await tagFlac(f, { ...baseMeta, track: 3, trackTotal: 13, disc: 2, discTotal: 2 })
    const c = await readVorbis(f)   // 该文件已有的读回帮助函数；无则用 mm.parseFile 的 native 字段
    expect(c.TRACKNUMBER).toBe('3')
    expect(c.TRACKTOTAL).toBe('13')
    expect(c.DISCNUMBER).toBe('2')
    expect(c.DISCTOTAL).toBe('2')
  })

  it('反锚：无 track/disc 时这四个键都不写', async () => {
    const f = await copyFixture('mini.flac')
    await tagFlac(f, baseMeta)
    const c = await readVorbis(f)
    expect(c.TRACKNUMBER).toBeUndefined()
    expect(c.DISCNUMBER).toBeUndefined()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tagger-mp3.test.ts tests/tagger-flac.test.ts`
Expected: FAIL — 类型不接受 `track` 字段 / 读回为 undefined

- [ ] **Step 3: 实现**

`src/main/tagger/types.ts` 在 `coverMime` 前加：

```ts
  // 专辑封装用（整张下载才有）；缺省 = 不写，平铺下载行为逐字节不变
  track?: number
  trackTotal?: number
  disc?: number
  discTotal?: number
```

`src/main/tagger/mp3.ts` 在 `if (meta.copyright) ...`（`:32`）之后加：

```ts
  // TRCK / TPOS：node-id3 用 trackNumber / partOfSet 映射
  if (meta.track !== undefined) {
    frames.trackNumber = { position: String(meta.track), total: meta.trackTotal !== undefined ? String(meta.trackTotal) : '' }
  }
  if (meta.disc !== undefined) {
    frames.partOfSet = { numberOfParts: String(meta.disc), totalNumberOfParts: meta.discTotal !== undefined ? String(meta.discTotal) : '' }
  }
```

`src/main/tagger/vorbis.ts` 在 `if (meta.genre) ...`（`:97`）之后加：

```ts
  if (meta.track !== undefined) {
    fields.TRACKNUMBER = String(meta.track)
    if (meta.trackTotal !== undefined) fields.TRACKTOTAL = String(meta.trackTotal)
  }
  if (meta.disc !== undefined) {
    fields.DISCNUMBER = String(meta.disc)
    if (meta.discTotal !== undefined) fields.DISCTOTAL = String(meta.discTotal)
  }
```

- [ ] **Step 4: 跑测试 + Commit（等用户明示）**

```bash
npx vitest run tests/tagger-mp3.test.ts tests/tagger-flac.test.ts
git add src/main/tagger/types.ts src/main/tagger/mp3.ts src/main/tagger/vorbis.ts tests/tagger-mp3.test.ts tests/tagger-flac.test.ts
git commit -m "feat(tagger): 支持 track/disc 号（TRCK/TPOS 与 TRACKNUMBER/DISCNUMBER）"
```

---

### Task 10: `runDownloadJob` 专辑落盘路径

**Files:**
- Modify: `src/main/downloader/queue.ts:6-19`
- Modify: `src/main/app.ts:101-218`
- Test: `tests/app.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```ts
describe('专辑落盘路径（0.7.0）', () => {
  it('job.album 存在 → 落 下载目录/歌手 - 专辑 (年)/NN 曲名.ext', async () => {
    const dir = mkd()
    const app = createApp({ userDataDir: dir, fetchImpl: qqAlbumFetch() })
    app.settingsSet({ downloadDir: dir })
    app.enqueue({ tracks: albumTracks(), quality: '320', source: 'qq', album: albumBundle() })
    await waitQueueIdle(app)
    const files = fs.readdirSync(path.join(dir, 'S - A (2019)'))
    expect(files.sort()).toEqual(['01 t1.mp3', '02 t2.mp3'])
  })

  it('多碟 → 每碟一个子目录', async () => {
    const dir = mkd()
    const app = createApp({ userDataDir: dir, fetchImpl: qqAlbumFetch(2) })
    app.settingsSet({ downloadDir: dir })
    app.enqueue({ tracks: albumTracks(2), quality: '320', source: 'qq', album: albumBundle(2) })
    await waitQueueIdle(app)
    expect(fs.readdirSync(path.join(dir, 'S - A (2019)', 'CD01'))).toEqual(['01 t1.mp3'])
    expect(fs.readdirSync(path.join(dir, 'S - A (2019)', 'CD02'))).toEqual(['02 t2.mp3'])
  })

  it('反锚：不带 album 的入队仍是平铺「歌手 - 歌名.ext」，不建子目录', async () => {
    const dir = mkd()
    const app = createApp({ userDataDir: dir, fetchImpl: qqFlatFetch() })
    app.settingsSet({ downloadDir: dir })
    app.enqueue({ tracks: [flatTrack()], quality: '320', source: 'qq' })
    await waitQueueIdle(app)
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.mp3'))).toEqual(['A - t1.mp3'])
    expect(fs.existsSync(path.join(dir, 'S - A (2019)'))).toBe(false)
  })
})
```

> `albumBundle()` / `albumTracks(discs)` / `qqAlbumFetch()` / `waitQueueIdle()` 是测试内联辅助，写在 `tests/app.test.ts` 顶部或该 describe 内；`waitQueueIdle` 用队列 `waitIdle`（`queue.ts:142`）或该文件已有的等待方式。**不进生产代码。**

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app.test.ts -t "专辑落盘路径"`
Expected: FAIL — 文件落在 `dir` 根、名字是 `歌手 - 歌名.mp3`

- [ ] **Step 3: `DownloadJob` 增 album**

`src/main/downloader/queue.ts` 顶部 import 加 `import type { AlbumBundle } from '../albumBundle'`，`DownloadJob` 里 `anonFallback` 下方加：

```ts
  album?: AlbumBundle       // 整张专辑批次上下文；缺省 = 平铺下载（现有行为）
```

- [ ] **Step 4: 实现路径分支**

`src/main/app.ts` import 区加（`path` 该文件第 2 行已引入，勿重复）：

```ts
import { albumTrackDir, trackBaseName, trackPad } from './albumBundle'
```

`runDownloadJob` 里 `:130-146` 的命名段替换为（保持 `reserveDest` / `lrcPath` 语义不变）：

```ts
    // 2) 下载（原子占位防并发撞名：wx 创建，EEXIST 则换后缀重试；
    //    占位文件在下载成功后由 renameSync 覆盖，Windows REPLACE_EXISTING 语义）
    //    整张专辑模式：落 专辑根目录[/CDnn]/NN 曲名.ext；平铺模式：落 歌手 - 歌名.ext（行为一字不改）
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
```

> 目录路径的唯一算式在 `albumBundle.albumTrackDir` 里；Task 12 写 cover / cue 时复用同一个函数，**不要在 app.ts 里再拼一遍**（否则两处规则会漂移，cue 指向不存在的目录）。

- [ ] **Step 5: 跑测试**

Run: `npx vitest run tests/app.test.ts -t "专辑落盘路径"`
Expected: PASS（三条含反锚）

- [ ] **Step 6: Commit（等用户明示）**

```bash
git add src/main/downloader/queue.ts src/main/app.ts tests/app.test.ts
git commit -m "feat: 整张专辑按子目录 + NN 序号命名落盘（平铺路径行为不变）"
```

---

### Task 11: `renderCue` 纯函数

**Files:**
- Create: `src/main/albumPackaging.ts`
- Test: `tests/albumPackaging.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/albumPackaging.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { renderCue, type CueEntry } from '../src/main/albumPackaging'
import type { AlbumBundle } from '../src/main/albumBundle'

const B: AlbumBundle = {
  source: 'netease', id: '7', name: '奇爱人生 LOVE ELEGIA', artist: '阿良良木健',
  date: '2019-05-20', company: '', coverUrl: '', totalTracks: 2, discs: [1],
}
const E: CueEntry[] = [
  { trackNo: 1, title: '告别曲（Love Elegia Ver.）', fileName: '01 告别曲（Love Elegia Ver.）.flac', container: 'FLAC' },
  { trackNo: 2, title: '遗忘山丘', fileName: '02 遗忘山丘.mp3', container: 'MP3' },
]

describe('renderCue', () => {
  it('UTF-8 BOM 开头（无 BOM 时 foobar 在中文 Windows 按 GBK 猜 → 中文曲名乱码）', () => {
    expect(renderCue(B, E).charCodeAt(0)).toBe(0xfeff)
  })

  it('CRLF 换行', () => {
    expect(renderCue(B, E)).toContain('\r\n')
    expect(renderCue(B, E).split('\n').length).toBeGreaterThan(2)
  })

  it('头部只有 REM DATE / PERFORMER / TITLE 三行', () => {
    const lines = renderCue(B, E).replace(/^/, '').split('\r\n')
    expect(lines[0]).toBe('REM DATE 2019')
    expect(lines[1]).toBe('PERFORMER "阿良良木健"')
    expect(lines[2]).toBe('TITLE "奇爱人生 LOVE ELEGIA"')
    expect(renderCue(B, E)).not.toContain('REM GENRE')
    expect(renderCue(B, E)).not.toContain('REPLAYGAIN')
  })

  it('每 FILE 一段 TRACK + INDEX 00，容器按实际 ext，顺序按 trackNo', () => {
    const s = renderCue(B, [...E].reverse())
    expect(s).toContain('FILE "01 告别曲（Love Elegia Ver.）.flac" FLAC')
    expect(s).toContain('FILE "02 遗忘山丘.mp3" MP3')
    expect(s.indexOf('TRACK 01 AUDIO')).toBeLessThan(s.indexOf('TRACK 02 AUDIO'))
    expect(s).toContain('    INDEX 00 00:00:00')
  })

  it('无日期 → 省略 REM DATE 整行', () => {
    expect(renderCue({ ...B, date: '' }, E).replace(/^/, '').startsWith('PERFORMER')).toBe(true)
  })

  it('曲名含双引号 → 换成单引号（cue 语法无标准转义，破坏引号配对更糟）', () => {
    expect(renderCue(B, [{ trackNo: 1, title: 'A"B', fileName: 'x.flac', container: 'FLAC' }])).toContain('TITLE "A\'B"')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/albumPackaging.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

新建 `src/main/albumPackaging.ts`：

```ts
import type { AlbumBundle } from './albumBundle'

export interface CueEntry {
  trackNo: number
  title: string
  fileName: string          // **实际落盘 basename**（含 uniquePath 加过的 (1) 后缀）——不重新推导，否则 cue 指向不存在的文件
  container: 'FLAC' | 'MP3'
}

const q = (s: string): string => `"${s.replace(/"/g, "'")}"`

/** 标准「每曲一文件」cue：每个 FILE 段一个 TRACK，INDEX 00 指向该文件起点。
 *  多碟时同一张专辑每碟各一份，碟号只影响**写到哪个目录**（调用方决定），不进 cue 文本。
 *  编码 UTF-8 with BOM、换行 CRLF（中文 Windows 上无 BOM 会被按 GBK 猜，曲名乱码）。
 *  头部只写有依据的三行：没有 genre 数据就不写 REM GENRE，没有 gain 数据就不写 REM REPLAYGAIN_*。 */
export function renderCue(b: AlbumBundle, entries: CueEntry[]): string {
  const sorted = [...entries].sort((x, y) => x.trackNo - y.trackNo)
  const lines: string[] = []
  if (/^\d{4}-/.test(b.date)) lines.push(`REM DATE ${b.date.slice(0, 4)}`)
  lines.push(`PERFORMER ${q(b.artist)}`, `TITLE ${q(b.name)}`)
  for (const e of sorted) {
    const no = String(e.trackNo).padStart(2, '0')
    lines.push(`FILE ${q(e.fileName)} ${e.container}`)
    lines.push(`  TRACK ${no} AUDIO`)
    lines.push(`    TITLE ${q(e.title)}`)
    lines.push(`    PERFORMER ${q(b.artist)}`)
    lines.push('    INDEX 00 00:00:00')
  }
  return '' + lines.join('\r\n') + '\r\n'
}
```

- [ ] **Step 4: 跑测试 + Commit（等用户明示）**

```bash
npx vitest run tests/albumPackaging.test.ts
git add src/main/albumPackaging.ts tests/albumPackaging.test.ts
git commit -m "feat: album.cue 生成（UTF-8 BOM + CRLF，每 FILE 一个 TRACK）"
```

---

### Task 12: `AlbumPackager` 完成度跟踪 + cover.jpg + 写 cue

**Files:**
- Modify: `src/main/albumPackaging.ts`
- Modify: `src/main/app.ts:478-501,315-321`
- Test: `tests/albumPackaging.test.ts`、`tests/app.test.ts`

- [ ] **Step 1: 写失败测试（完成度）**

`tests/albumPackaging.test.ts` 追加：

```ts
describe('AlbumPackager 完成度', () => {
  const B1: AlbumBundle = { ...B, totalTracks: 2, discs: [1] }
  const B2: AlbumBundle = { ...B, totalTracks: 2, discs: [1, 2] }
  const done = (trackNo: number, fileName: string, title: string, ext = 'flac') =>
    ({ trackNo, outputPath: fileName, ext, title })

  it('单碟：未下齐不出 cue，下齐返回该碟', () => {
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    expect(p.record(B1, done(1, '01 a.flac', 'a'))).toEqual([])
    expect(p.record(B1, done(2, '02 b.flac', 'b'))).toEqual([1])
  })

  it('多碟：CD01 齐了先出 CD01，不等 CD02', () => {
    const p = new AlbumPackager()
    p.plan(B2, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 2 }])
    expect(p.record(B2, done(1, '01 a.flac', 'a'))).toEqual([1])
    expect(p.record(B2, done(2, '02 b.flac', 'b'))).toEqual([2])
  })

  it('同一曲重复完成（重试）按后到者覆盖，不重复触发', () => {
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    p.record(B1, done(1, '01 a.flac', 'a'))
    expect(p.record(B1, done(1, '01 a(1).flac', 'a'))).toEqual([])
    p.record(B1, done(2, '02 b.flac', 'b'))
    expect(p.cueEntries(B1, 1).map((e) => e.fileName)).toEqual(['01 a(1).flac', '02 b.flac'])
  })

  it('cue 条目的 title 用原曲名，不从文件名反推（safeName 会换掉 / : * 等字符并截断）', () => {
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    p.record(B1, done(1, '01 A-B.flac', 'A/B'))
    p.record(B1, done(2, '02 b.flac', 'b'))
    expect(p.cueEntries(B1, 1)[0].title).toBe('A/B')
  })

  it('ape/m4a 容器 → cueEntries 返回空（该碟不出 cue，宁缺不错）', () => {
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    p.record(B1, done(1, '01 a.ape', 'a', 'ape'))
    p.record(B1, done(2, '02 b.ape', 'b', 'ape'))
    expect(p.cueEntries(B1, 1)).toEqual([])
  })

  it('取消/失败不入账（半张不会被算成整张）', () => {
    const p = new AlbumPackager()
    p.plan(B1, [{ trackNo: 1, disc: 1 }, { trackNo: 2, disc: 1 }])
    p.record(B1, done(1, '01 a.flac', 'a'))
    expect(p.record(B1, done(2, '', 'b'))).toEqual([])   // outputPath 空 = 未产出，不记账
    expect(p.cueEntries(B1, 1)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/albumPackaging.test.ts -t "AlbumPackager"`
Expected: FAIL — `AlbumPackager is not a constructor`

- [ ] **Step 3: 实现 AlbumPackager**

`src/main/albumPackaging.ts` 顶部 import 补 `import path from 'node:path'`，文件末尾追加：

```ts
/** 一笔完成记录：outputPath 必须是**实际落盘全路径**（含 uniquePath 加过的 (1) 后缀），
 *  title 必须是**原曲名**——文件名经 safeName 会换掉 / : * 等字符并截断，反推会失真。 */
export interface AlbumCompletion {
  trackNo: number
  outputPath: string
  ext: string
  title: string
}

/** 整张专辑的批次完成度：plan() 登记期望，record() 记账，某碟下齐才允许出该碟 cue。
 *  session 内有效（与 app.ts 的 jobSpecs 同生命周期）；重启后需重新整张入队。 */
export class AlbumPackager {
  private expected = new Map<string, Map<number, number>>()  // key → (trackNo → disc)
  private done = new Map<string, Map<number, { fileName: string; ext: string; title: string }>>()

  private static key(b: AlbumBundle): string {
    return `${b.source}:${b.id}`
  }

  plan(b: AlbumBundle, tracks: Array<{ trackNo?: number; disc?: number }>): void {
    const k = AlbumPackager.key(b)
    const exp = this.expected.get(k) ?? new Map<number, number>()
    tracks.forEach((t, i) => {
      exp.set(t.trackNo ?? i + 1, t.disc ?? b.discs[0] ?? 1)
    })
    this.expected.set(k, exp)
    if (!this.done.has(k)) this.done.set(k, new Map())
  }

  /** 记一笔完成；outputPath 为空视为未产出（取消/失败）不入账。返回**本次刚下齐**的碟号列表。 */
  record(b: AlbumBundle, c: AlbumCompletion): number[] {
    if (!c.outputPath) return []
    const k = AlbumPackager.key(b)
    const d = this.done.get(k) ?? new Map<number, { fileName: string; ext: string; title: string }>()
    d.set(c.trackNo, { fileName: path.basename(c.outputPath), ext: c.ext, title: c.title })
    this.done.set(k, d)
    const exp = this.expected.get(k)
    if (!exp) return []
    const justCompleted = new Set<number>()
    for (const [no, disc] of exp) {
      if (!d.has(no)) continue
      const discTracks = [...exp.entries()].filter(([, dd]) => dd === disc)
      if (discTracks.every(([n]) => d.has(n))) justCompleted.add(disc)
    }
    return [...justCompleted].sort((a, b2) => a - b2)
  }

  /** 该碟的 cue 条目；碟内任一曲未落盘、或含不可写标签的容器（ape/m4a/ogg）→ 返回空，不出 cue */
  cueEntries(b: AlbumBundle, disc: number): CueEntry[] {
    const k = AlbumPackager.key(b)
    const exp = this.expected.get(k)
    const d = this.done.get(k)
    if (!exp || !d) return []
    const out: CueEntry[] = []
    for (const [no, dd] of exp) {
      if (dd !== disc) continue
      const rec = d.get(no)
      if (!rec) return []
      const container = rec.ext === 'flac' ? 'FLAC' : rec.ext === 'mp3' ? 'MP3' : null
      if (!container) return []
      out.push({ trackNo: no, title: rec.title, fileName: rec.fileName, container })
    }
    return out.sort((x, y) => x.trackNo - y.trackNo)
  }
}
```

- [ ] **Step 4: app.ts 接线**

`src/main/app.ts` import 补（`path` 该文件已有，勿重复引入）：

```ts
import { AlbumPackager, renderCue } from './albumPackaging'
```

并把 Task 10 加进来的 albumBundle import 行补上两个目录函数：

```ts
import { AlbumBundle, albumRootDir, albumTrackDir, trackBaseName, trackPad } from './albumBundle'
```

`createApp` 内、`queue` 定义之前加：

```ts
  const packager = new AlbumPackager()
  // 专辑附属文件：cover 在首个任务完成时写一次（专辑级资源，不等下齐）；
  // 某碟全部曲目落盘后才写该碟的 album.cue。目录一律走 albumBundle 的 albumRootDir/albumTrackDir，
  // 与 runDownloadJob 的落盘目录是同一个算式——两处各拼一遍必然漂移成 cue 指向不存在的目录。
  const coverWritten = new Set<string>()
  const writeAlbumExtras = async (job: DownloadJob): Promise<void> => {
    const b = job.album
    const out = job.outputPath
    if (!b || !out) return
    const key = `${b.source}:${b.id}`
    if (!coverWritten.has(key)) {
      if (!b.coverUrl) {
        coverWritten.add(key) // 没有封面源，不再每首重试
      } else {
        const cover = await fetchCover(b.coverUrl, fetchImpl)
        if (cover) {
          const ext = cover.mime === 'image/png' ? 'png' : 'jpg'
          fs.writeFileSync(path.join(albumRootDir(settings.downloadDir, b), `cover.${ext}`), cover.data)
          coverWritten.add(key)
        } else {
          dbgFile?.(`专辑 ${key} 封面抓取失败，跳过 cover（不影响曲目本身）`)
        }
      }
    }
    const justCompleted = packager.record(b, {
      trackNo: job.track.trackNo ?? 1,
      outputPath: out,
      ext: path.extname(out).slice(1).toLowerCase(),
      title: job.track.name,
    })
    for (const disc of justCompleted) {
      const entries = packager.cueEntries(b, disc)
      if (!entries.length) continue
      fs.writeFileSync(
        path.join(albumTrackDir(settings.downloadDir, b, disc), 'album.cue'),
        renderCue(b, entries),
        'utf-8',
      )
    }
  }
```

队列事件区（`:319` 的 `jobDone` 转发）改为同时记账：

```ts
  queue.on('jobDone', (j) => {
    emitEvent('dl:done', { ...j })
    if (j.album) void writeAlbumExtras(j)
  })
```

`enqueue`（`:478-501`）里，在 `queue.enqueue(jobs)` 之前加：

```ts
      // 专辑批次：登记期望曲目，供完成度判定。无 album 时不调用 → 平铺下载零影响。
      if (album) packager.plan(album, tracks)
```

并把 `enqueue` 的解构与 job 构造带上 `album`：

```ts
    enqueue: (payload: { tracks: TrackDTO[]; quality: Settings['quality']; lyricMode?: Settings['lyricMode']; source: 'qq' | 'netease'; album?: AlbumBundle }) => {
      const { tracks, quality, lyricMode, source, album } = payload
```

```ts
        jobs.push({
          id, source, track: t, quality, lyricMode, album, state: 'queued' as const, progress: 0,
        })
```

`jobSpecs` 登记处（`:488`）与 `retryFailed`（`:503-518`）各加 `album` 字段透传：

```ts
        jobSpecs.set(id, { track: t, quality, lyricMode, source, album })
```

```ts
      queue.enqueue([{ id: jobId, source: spec.source, track: spec.track, quality: spec.quality, lyricMode: spec.lyricMode, album: spec.album, state: 'queued' as const, progress: 0 }])
```

`jobSpecs` 的 `Map` 值类型（`:80-85`）加 `album?: AlbumBundle`。

- [ ] **Step 5: 打标签时带上 track/disc**

`runDownloadJob` 的 `meta` 构造（`app.ts:196-206`）加：

```ts
          track: job.album ? job.track.trackNo : undefined,
          trackTotal: job.album ? job.album.totalTracks : undefined,
          disc: job.album ? (job.track.disc ?? job.album.discs[0]) : undefined,
          discTotal: job.album ? (job.album.discs.length > 1 ? job.album.discs.length : undefined) : undefined,
```

- [ ] **Step 6: 跑测试**

Run: `npx vitest run tests/albumPackaging.test.ts tests/app.test.ts && npm run typecheck`
Expected: 全绿 + 通过

- [ ] **Step 7: Commit（等用户明示）**

```bash
git add src/main/albumPackaging.ts src/main/app.ts tests/albumPackaging.test.ts tests/app.test.ts
git commit -m "feat: 整张专辑完成度跟踪 + cover 落盘 + cue 按下齐生成"
```

---

### Task 13: 「下载整张」按钮

**Files:**
- Modify: `src/renderer/src/App.vue:938-968`
- Modify: `src/renderer/src/components/NeteaseTab.vue:201-213`

- [ ] **Step 1: QQ / 通用歌曲页加按钮**

`src/renderer/src/App.vue` 的 `songs-page` 头部（`:939-949` 的 `songs-head` div 内，`↻ 刷新` 按钮之后）加：

```vue
          <button
            v-if="songsView.album"
            class="back-btn"
            :disabled="store.tracks.length === 0"
            title="下载该专辑全部曲目到专辑子目录"
            @click="enqueueAlbum(songsView.album, store.tracks)"
          >下载整张（{{ store.tracks.length }} 首）</button>
```

`<script setup>` 内加动作函数（放在 `openAlbum` 附近）：

```ts
/** 整张专辑下载：忽略当前勾选，把本页全部曲目 + 专辑批次上下文一起入队 → 落专辑子目录。
 *  懒加载未翻完时 tracks.length < album.totalTracks：按已加载部分入队并在提示里说明，
 *  不静默假装下完了整张（否则 cue 永远不出，用户不知道为什么）。 */
function enqueueAlbum(album: AlbumBundle, tracks: UiTrack[]): void {
  if (!tracks.length) return
  const full = tracks.length >= album.totalTracks
  if (!full && !window.confirm(
    `该专辑共 ${album.totalTracks} 首，当前只加载了 ${tracks.length} 首（长专辑是滚动懒加载的）。\n` +
    `现在下载只会下已加载的这部分，专辑 .cue 要等整张下齐才生成。\n要继续吗？`,
  )) return
  void api.invoke('dl:enqueue', {
    tracks, quality: store.quality, lyricMode: store.lyricMode, source: album.source, album,
  }).then(() => {
    listNotice.value = full
      ? `已把整张《${album.name}》${tracks.length} 首加入下载队列`
      : `已加入 ${tracks.length} 首（专辑共 ${album.totalTracks} 首，未加载部分需继续下拉后再下载）`
  }).catch((e: unknown) => { window.alert(e instanceof Error ? e.message : String(e)) })
}
```

- [ ] **Step 2: 网易云内联专辑页加同样按钮**

`src/renderer/src/components/NeteaseTab.vue` 的 `songs-head`（`:202-205`）内、返回按钮之后加：

```vue
        <button
          v-if="openedAlbumBundle"
          class="ghost"
          :disabled="!store.tracks.length"
          @click="enqueueWholeAlbum"
        >下载整张（{{ store.tracks.length }} 首）</button>
```

`<script setup>` 内加：

```ts
function enqueueWholeAlbum(): void {
  const album = openedAlbumBundle.value
  if (!album || !store.tracks.length) return
  const full = store.tracks.length >= album.totalTracks
  if (!full && !window.confirm(`该专辑共 ${album.totalTracks} 首，当前 ${store.tracks.length} 首。继续只下已加载部分？`)) return
  void api.invoke('dl:enqueue', {
    tracks: store.tracks, quality: store.quality, lyricMode: store.lyricMode, source: 'netease', album,
  }).catch((e: unknown) => { error.value = e instanceof Error ? e.message : String(e) })
}
```

- [ ] **Step 3: typecheck + 手工确认按钮出现**

Run: `npm run typecheck`
Expected: 通过

Run: `npm run dev`
Expected: 网易云 → 专辑 tab → 搜「奇爱人生」→ 点进任一专辑 → 头部出现「下载整张（N 首）」；QQ 侧同样路径同样出现。

- [ ] **Step 4: Commit（等用户明示）**

```bash
git add src/renderer/src/App.vue src/renderer/src/components/NeteaseTab.vue
git commit -m "feat: 专辑歌曲页新增「下载整张」入口"
```

---

## 阶段 D：集成、文档、打包

### Task 14: 端到端集成用例

**Files:**
- Test: `tests/app.test.ts`（追加）

- [ ] **Step 1: 写集成用例**

```ts
describe('整张专辑端到端（0.7.0）', () => {
  it('全部完成 → 目录含 cover + album.cue，cue 里每个 FILE 都真实存在', async () => {
    const dir = mkd()
    const app = createApp({ userDataDir: dir, fetchImpl: qqAlbumFetchWithCover() })
    app.settingsSet({ downloadDir: dir, lyricMode: 'embed' })
    app.enqueue({ tracks: albumTracks(), quality: 'flac', source: 'qq', album: albumBundle() })
    await waitQueueIdle(app)
    const albumDir = path.join(dir, 'S - A (2019)')
    const files = fs.readdirSync(albumDir)
    expect(files).toContain('album.cue')
    expect(files.some((f) => f.startsWith('cover.'))).toBe(true)
    const cue = fs.readFileSync(path.join(albumDir, 'album.cue'), 'utf-8')
    for (const m of cue.matchAll(/FILE "(.+?)" (FLAC|MP3)/g)) {
      expect(fs.existsSync(path.join(albumDir, m[1]))).toBe(true)
    }
    expect(cue.charCodeAt(0)).toBe(0xfeff)
  })

  it('一首失败 → 无 cue；retryFailed 成功后补生成，内容含该曲', async () => {
    const dir = mkd()
    const app = createApp({ userDataDir: dir, fetchImpl: qqAlbumFetchFailOne(2) })
    app.settingsSet({ downloadDir: dir })
    app.enqueue({ tracks: albumTracks(), quality: 'flac', source: 'qq', album: albumBundle() })
    await waitQueueIdle(app)
    const albumDir = path.join(dir, 'S - A (2019)')
    expect(fs.existsSync(path.join(albumDir, 'album.cue'))).toBe(false)
    app.retryFailed('qq:S2:2')
    await waitQueueIdle(app)
    const cue = fs.readFileSync(path.join(albumDir, 'album.cue'), 'utf-8')
    expect(cue).toContain('02 t2.flac')
  })

  it('多碟 → 两碟各一份 cue，各只引用本碟文件', async () => {
    const dir = mkd()
    const app = createApp({ userDataDir: dir, fetchImpl: qqAlbumFetch(2) })
    app.settingsSet({ downloadDir: dir })
    app.enqueue({ tracks: albumTracks(2), quality: 'flac', source: 'qq', album: albumBundle(2) })
    await waitQueueIdle(app)
    const root = path.join(dir, 'S - A (2019)')
    const c1 = fs.readFileSync(path.join(root, 'CD01', 'album.cue'), 'utf-8')
    const c2 = fs.readFileSync(path.join(root, 'CD02', 'album.cue'), 'utf-8')
    expect(c1).toContain('01 t1.flac')
    expect(c1).not.toContain('02 t2.flac')
    expect(c2).toContain('02 t2.flac')
  })

  it('二次整张下载 → 不覆盖，新文件带 (1)，cue FILE 名跟着变且仍可 existsSync', async () => {
    const dir = mkd()
    const app = createApp({ userDataDir: dir, fetchImpl: qqAlbumFetchWithCover() })
    app.settingsSet({ downloadDir: dir })
    app.enqueue({ tracks: albumTracks(), quality: 'flac', source: 'qq', album: albumBundle() })
    await waitQueueIdle(app)
    app.enqueue({ tracks: albumTracks(), quality: 'flac', source: 'qq', album: albumBundle() })
    await waitQueueIdle(app)
    const albumDir = path.join(dir, 'S - A (2019)')
    const cue = fs.readFileSync(path.join(albumDir, 'album.cue'), 'utf-8')
    expect(cue).toContain('(1)')
    for (const m of cue.matchAll(/FILE "(.+?)" (FLAC|MP3)/g)) {
      expect(fs.existsSync(path.join(albumDir, m[1]))).toBe(true)
    }
  })
})
```

- [ ] **Step 2: 跑测试**

Run: `npx vitest run tests/app.test.ts -t "端到端"`
Expected: PASS。若「一首失败」那条因 job id 硬编码 `qq:S2:2` 不符（id 形如 `source:trackId:seq`），改成从 `jobQueued` 事件里捕获该 track 的实际 jobId，**不要改生产代码去凑测试**。

- [ ] **Step 3: 全量回归**

Run: `npx vitest run`
Expected: 全绿（0.6.1 基线 226 例 + 新增全部通过）。若 `tests/app.test.ts` 偶发 `Hook timed out in 10000ms`，那是 `tests/app.test.ts:177` 的既有 flaky（`afterEach` 不 await server 关闭），单独跑该文件确认后即可判定非本次引入。

- [ ] **Step 4: 顺手修既有 flaky（本次新增用例进一步增加同文件并发压力，会更容易触发）**

`tests/app.test.ts:177` 的 `afterEach` 改为：

```ts
afterEach(async () => {
  await Promise.all(envs.splice(0).map((e) => new Promise<void>((r) => e.server.close(r))))
})
```

Run: `npx vitest run`
Expected: 全绿且不再出现 hook 超时

- [ ] **Step 5: Commit（等用户明示）**

```bash
git add tests/app.test.ts
git commit -m "test: 整张专辑端到端用例；修 app.test.ts afterEach 未 await 导致的 flaky"
```

---

### Task 15: 版本号与文档

**Files:**
- Modify: `package.json:3`
- Modify: `README.md`
- Create: `docs/acceptance-album.md`

- [ ] **Step 1: 升版本**

`package.json` 的 `"version": "0.6.1"` → `"version": "0.7.0"`。

- [ ] **Step 2: README 功能表**

`README.md` 的「### 歌词与标签」之前插入一节：

```markdown
### 整张专辑下载（标准专辑封装）

- **入口**：QQ / 网易云专辑歌曲页顶部「下载整张（N 首）」按钮，与现有「下载选中」并存。**只有整张才进专辑子目录**；在专辑页手动勾选部分曲目仍是原来的平铺下载。
- **产物形态**：`下载目录/歌手 - 专辑名 (年)/01 曲名.flac …` + `cover.jpg` + `album.cue`；多碟专辑每碟一个子目录（`CD01/`、`CD02/`），每碟各一份 cue。
- **标签**：专辑模式下额外写 track / disc 号（MP3 `TRCK`+`TPOS`，FLAC `TRACKNUMBER`+`DISCNUMBER`），foobar2000 与 Musicolet 按专辑聚合正确。
- **cue 只在整张下齐时生成**：某碟全部曲目成功落盘才写该碟 `album.cue`；未下齐就没有 cue（半张的 cue 会让播放器指向不存在的音轨）。失败行照常「重试」，重试成功后自动补生成。
- **cue 的 FILE 名取实际落盘文件名**：同名冲突加过 `(1)`、或降级导致 flac/mp3 混合，cue 都不会指向不存在的文件。
- **编码**：UTF-8 with BOM + CRLF（无 BOM 时 foobar2000 在中文 Windows 按 GBK 猜，中文曲名乱码）。
```

- [ ] **Step 3: README 已知限制补四条**

在「## 风控与已知限制（如实说明）」末尾追加：

```markdown
- **QQ 专辑曲目序号取列表下标**：`fcg_v8_album_info_cp.fcg` 响应里**没有**序号字段（实测条目只有 `belongCD`/`cdIdx`），故 `trackNo = 下标 + 1`；碟号仅当 `cdIdx` 是 ≥1 的整数且出现多个不同值才按多碟处理，否则一律单碟（安全默认：最坏情况是多碟被拍平成连续序号，不出错只丢结构）。网易云侧有权威 `songs[].no` / `songs[].cd`。
- **QQ 专辑 `total_song_num` 与 `list.length` 口径不一致**（实测同张 21 vs 22）：一律以实长为准，`album.totalTracks` 也是实长。
- **APE/m4a 档不出 cue**：这两个容器无标签写入器，cue 依赖的 track 信息无从写入，故该碟跳过 cue（宁缺不错，曲目本身仍可正常下载）。
- **专辑元数据只在打开专辑页那一次请求里取**：`/api/v1/album/{id}` 的 `album` 对象与 `songs[]` 同响应，QQ 的 `data` 里 `name/singername/aDate/company/mid` 齐备，**零额外请求**；封面大图 URL 由 albummid 拼（QQ 响应内无封面字段）。
```

- [ ] **Step 4: README 技术栈与测试数同步**

`README.md:95` 那行「测试：`tests/`（223 用例全绿…）」改为实际数字（Task 14 Step 3 的输出）。技术栈行的模块清单补 `albumBundle.ts`（专辑批次上下文解析/命名）、`albumPackaging.ts`（cue 生成 + 完成度跟踪）。

- [ ] **Step 5: 手工验收清单**

新建 `docs/acceptance-album.md`：

```markdown
# 整张专辑下载 手工验收清单（0.7.0）

> 真实网络只做本清单，跑完记录结论；不写进单测（接口易变 + 触发风控）。

| # | 项目 | 步骤 | 期望 | 实测 |
|---|---|---|---|---|
| 1 | QQ 整张下载 | QQ → 专辑 tab → 搜「奇爱人生」→ 点进 → 「下载整张」 | 子目录 + `NN 曲名` + cover + cue；cue 每个 FILE 都存在 | 待填 |
| 2 | QQ 只登记 128k 的曲子 | 挑一张含 `size_flac=0` 曲子的专辑整张下载 | 该曲落 128k mp3，cue 里 FILE 段写 `MP3` 且指向实际文件名 | 待填 |
| 3 | 网易云整张下载 | 网易云 → 专辑 tab → 搜「奇爱人生」→ 「奇爱人生 LOVE ELEGIA」(id 74829483，13 首) → 下载整张 | 13 首全部落 `阿良良木健 - 奇爱人生 LOVE ELEGIA (2019)/`，cue 13 段 | 待填 |
| 4 | QQ 多碟 `cdIdx` 语义 | 找一张 QQ 多碟专辑（如 2CD 精选）整张下载 | 若服务端确实回多碟值 → 生成 `CD01/`+`CD02/` 两碟各一 cue；若恒 0/1 → 拍平为单目录连续序号（spec R1 的安全默认，需在 `albumBundle.ts` 注释里记实测取值） | 待填 |
| 5 | foobar2000 播 cue | 用 foobar2000 打开 `album.cue` | 整张按 cue 播放、可切轨、中文曲名不乱码 | 待填 |
| 6 | Musicolet | 把专辑子目录导入安卓 Musicolet | 按专辑聚合、序号顺序正确、内嵌歌词可见 | 待填 |
| 7 | 未下齐不出 cue | 整张下载中断掉一首（断网/取消） | 目录里无 `album.cue`；重试成功后自动补生成 | 待填 |
| 8 | 档位修复回归 | QQ 页选 APE → 切网易云页 | 选择条只出现 无损/320k/128k 且自动落回无损；下载后队列**不**挂「已降级」 | 待填 |
| 9 | 降级回显落档 | 网易云选无损但账号无权益（或匿名） | 黄条文案是「已降级为 320k」而非「低品质」 | 待填 |
| 10 | 会话判据不误报 | 退出网易云后断网，重启应用 | 侧栏不得显示红色「登录已失效」（探测失败应保守） | 待填 |
| 11 | 封面大图 URL | 打开 QQ 专辑整张下载后看 `cover.jpg` | 500x500 可辨识；若 R500 形态 404 → 按 Task 6 Step 4 回退 R300 并在此记录 | 待填 |
```

- [ ] **Step 6: Commit（等用户明示）**

```bash
git add package.json README.md docs/acceptance-album.md
git commit -m "chore(release): 0.7.0 —— 整张专辑下载与标准封装 + 音质/会话判据一揽子修复"
```

---

### Task 16: 全量验证与打包

**Files:** 无源码改动（产物 `dist/`）

- [ ] **Step 1: 类型检查**

Run: `npm run typecheck`
Expected: 无输出、退出码 0（`vue-tsc` + `tsc` 两遍都过）

- [ ] **Step 2: 全量测试**

Run: `npx vitest run`
Expected: `Test Files  29 passed (29)` 量级、`Tests  <全绿数>`，无 failed

- [ ] **Step 3: 开发模式手工冒烟（打包前最后一道）**

Run: `npm run dev`
Expected: 应用启动；按 `docs/acceptance-album.md` 的第 3、8、9 条各跑一次（真实下载一张网易云专辑 + 验证档位回落与降级文案）。

- [ ] **Step 4: 打包（必须走本机代理，否则 electron 二进制下载阶段 socket hang up）**

Run:

```bash
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm run dist
```

Expected: 约 1-2 分钟完成，产出 `dist/音乐下载器 Setup 0.7.0.exe`。
失败若为 `socket hang up` / `CONNECT tunnel failed` → 代理未开或该代理对 github 偶发 502，**重试第二次通常即成**（本机实测规律）。

- [ ] **Step 5: 校验安装包**

Run: `ls -la dist/ | grep "0.7.0"`
Expected: 存在 `音乐下载器 Setup 0.7.0.exe`（及 `.blockmap`）

- [ ] **Step 6: 提交产物清单外的收尾（等用户明示）**

安装包本身不入库（`dist/` 已在 `.gitignore`）。若需推送分支/合并到 `main`，**须用户明示**；推送同样走 `127.0.0.1:7890`。

---

## 自检记录（写计划时已核对）

**spec 覆盖**：§5.1 → Task 5（类型/归一/命名）+ Task 6/7（两源解析）；§5.2 IPC → Task 8；§5.3 渲染侧与入口 → Task 8/13；§5.4 落盘布局 → Task 10；§5.5 cue → Task 11/12；§5.6 标签 → Task 9；§5.7 完成度 → Task 12；§6 表 1-9 → Task 1-4；§7 测试 → 各任务 Step 1 + Task 14；§8 版本/文档 → Task 15；§9 R1 → Task 5 `discOf` 用例 + Task 15 README；R4 → Task 11/12/14 用例；R2 → Task 16 Step 3 手工冒烟。

**写计划后回改的四处（已定稿，实现时照现文本做）**：

1. `albumBundle.ts` **不解析原始 JSON**——曲目映射复用 `trackFromEntry` / `neteaseTrackToDto` / `isVipEntry`（都有测试），避免复制 VIP 判据与 `albumBundle ↔ qqapi/tracks` 循环 import。解析分别落在 Task 6/7 的 api 模块。
2. 目录算式收口到 `albumRootDir` / `albumTrackDir` 两个函数，`runDownloadJob`（Task 10）与附属文件写入（Task 12）共用——两处各拼一遍会漂移成 cue 指向不存在的目录。
3. `renderCue(b, entries)` **不带 disc 形参**：碟号只决定写到哪个目录，不进 cue 文本；留着不用会沦为噪声参数。
4. `AlbumPackager.record` 收 `AlbumCompletion` 对象并**存原曲名**：文件名经 `safeName` 会替换 `/ : * ?` 等字符并在 100 字截断，从文件名反推 cue 的 TITLE 会失真。

**类型一致性核对**：`AlbumBundle` 字段（`totalTracks`/`discs`/`coverUrl`）在 Task 5 定义、Task 8/10/12/13/14 使用处逐一对齐；档位中文名**只有一份**（`src/renderer/src/qualityOptions.ts` 的 `QQ_QUALITIES`，经 `labelForQuality` 查询），主进程不再有 `qualityLabel`；`mkBundle` 的 8 个位置参数在 Task 6/7 调用处顺序一致；`trackBaseName`/`trackPad` 签名与 Task 10 调用一致。

**遗留的显式判断点（不是占位符，是实现时要读的注）**：Task 5 Step 4 的「非法字符」用例期望值以 `src/main/fsUtils.ts:5` 的字符类为准；Task 6 Step 4 的封面 R500 若实测 404 则回退 R300 并记进 `docs/acceptance-album.md`；Task 14 Step 2 的 jobId 若与硬编码不符，改测试取实际 id，不改生产代码凑测试。
