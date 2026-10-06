# 整张专辑下载与标准专辑封装 设计

> 日期：2026-10-06
> 状态：设计已获用户批准（2026-10-06，四节逐节确认，用户指示「没改动，直接写 spec 和实施计划」）
> 项目：`F:\research\wyy-download\wyy-download`，目标版本 **0.7.0**
> 相关：`2026-09-04-qqmusic-downloader-design.md`（主产品）、`2026-09-04-netease-module-design.md`（网易云模块）

---

## 1. 目标

在现有「勾选若干首 → 平铺下载」之外，新增**整张专辑下载**，产物按标准专辑发行形态组织：一张专辑一个子目录、每曲一文件带序号前缀、附专辑封面与 `.cue` 索引。

同版本并入两组缺陷修复：音质档位与选择条的一揽子问题（§6 表 1-5），以及 `fix/netease-session-status` 分支审计产出的网易云登录态判定问题（§6 表 6-9）。

**范围外（YAGNI）**：整轨 image + 单文件 cue（用户已选「每曲一文件」形态）、歌单进子目录（用户已选「只有整张才进子目录」）、ReplayGain、多碟合并为单目录、APE/m4a 的标签写入器、下载后目录整理。

## 2. 决策记录（用户已确认）

| 决策点 | 结论 |
|---|---|
| 封装形态 | 每曲一文件 + 专辑子目录 + `.cue`（不做整轨 image） |
| 覆盖源 | QQ 音乐 + 网易云两侧都做 |
| 入口 | 专辑歌曲页顶部「下载整张」按钮（不在专辑卡片上加按钮，不做设置页全局开关） |
| 部分勾选 | **只有整张才进子目录**；手动勾选部分曲目保持现有平铺行为不变 |
| 目录命名 | `歌手 - 专辑 (年)/NN 曲名.ext`（一级目录，与现有平铺命名同风格） |
| 多碟 | **每碟一个子目录**（`… (年)/CD01/01 曲名.ext`） |
| 附属文件 | `cover.jpg` + `album.cue`，歌词严格走现有「歌词模式」设置，不额外强制 |
| 实现路线 | 方案 A「批次上下文」：元数据随 `DownloadJob` 传递，复用现有共享下载骨架；不建第二条管线 |

## 3. 接口实测事实（2026-10-06 真接口探针，探针文件已删）

### 3.1 QQ `https://i.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?albummid=<mid>&format=json`

- 端点**存活**（注意 `.fcg` 后缀必需；漏后缀得 HTTP 404 空 body，`client.get` 会把它误报成 `rate-limited: 空响应（风控）`）。
- `data` 键：`aDate, albumTips, color, company, company_new, cur_song_num, desc, genre, id, lan, list, mid, name, radio_anchor, singerid, singermblog, singermid, singername, song_begin, total, total_song_num`。
  - 专辑名 `data.name`；歌手 `data.singername` / `data.singermid`；发行日 `data.aDate`；公司 `data.company`（实测 `"未确定"`）。
  - **响应内无封面字段**，封面由 `data.mid` 拼标准 URL（同 `qqCoverUrl` 规则）。
  - `total_song_num` 与 `list.length` **口径不一致**（实测同一张 21 vs 22）→ 一律以 `list.length` 为准。
- `data.list[]` 条目键含 `belongCD, cdIdx, interval, sizeflac, sizeape, size320, size128, sizeogg, pay, songmid, strMediaMid, singer, albummid, albumname, songtype, tid`。
  - **无显式曲目序号字段**（`track`/`seq` 均不存在）→ 序号取数组下标 +1。
  - 碟号候选 `cdIdx` / `belongCD`：字段存在已确认，**取值语义未经多碟样本验证**（见 §9 风险 R1）。

### 3.2 网易云 `https://music.163.com/api/v1/album/{id}`

- 顶层键：`resourceState, songs, code, album`。专辑对象叫 **`album`**（不是 `info`）。
- `album` 键含 `name, artist（对象，取 .name）, artists, publishTime, company, picUrl, pic, size, alias, description, tags, type, subType`。
  - `company` 实测可为 `null`；`size` = 曲目数，与 `songs.length` 一致（实测 13 = 13）。
- `songs[]` 条目含 **`no`（曲目序号，实测 1）** 与 **`cd`（碟号字符串，实测 `"01"`）**，另有 `ar / al / dt / fee / id / name`。
- 结论：专辑级与曲目级元数据**在同一次请求内全部可得，零额外请求**。

### 3.3 现状缺口

`fetchAlbum`（`src/main/qqapi/tracks.ts:231-237`）与 `neAlbumSongs`（`src/main/neteaseapi/tracks.ts:128-131`）都只 `return TrackDTO[]`，把上述专辑级字段全部丢弃；`TrackDTO`（`src/main/qqapi/tracks.ts:6-15`）没有 `trackNo` / `disc` 字段。本设计的第一件事就是把这层元数据接出来。

## 4. 架构

```
渲染器                          preload 白名单 IPC              主进程
────────────────────────────────────────────────────────────────────────────
专辑页（QQ songsView /          qq:albumSongs ──────▶ fetchAlbumInfo  ┐
网易云 openedAlbum）             ne:albumSongs ──────▶ neAlbumInfo     ├─▶ albumBundle.ts
  持有 bundle，                  qq:linkTracks ──────▶ 同上（链接导入） ┘   （纯解析，可单测）
  显示「下载整张」
        │
        └─ dl:enqueue { tracks(+trackNo,+disc), album: bundle, quality, lyricMode, source }
                          │
                          ▼
              app.ts createApp.enqueue → DownloadJob{ album? }
                          │
                          ▼
              runDownloadJob（现有共享骨架，app.ts:101）
                ├─ 目标路径：album 存在 → 专辑子目录/NN 曲名.ext；否则现有平铺
                ├─ 标签：TagMeta 增 track/disc → tagger 写 TRCK/TPOS、TRACKNUMBER/DISCNUMBER
                └─ 完成回调 → albumPackaging.ts 记进度 → 齐碟则写 cover.jpg + album.cue
```

新增两个主进程模块，各自单一职责、纯 Node、可脱离网络单测：

| 模块 | 职责 | 依赖 | 对外接口 |
|---|---|---|---|
| `src/main/albumBundle.ts` | `AlbumBundle` 类型、日期归一、碟号采信、bundle 组装、目录/文件名与路径计算 | `fsUtils`（`safeName`）、`qqapi/tracks` 的**类型** | `AlbumBundle`、`mkBundle`、`normalizeDate`、`discOf`、`albumDirName`、`albumRootDir`、`albumTrackDir`、`discSegments`、`trackBaseName`、`trackFileName`、`trackPad`、`qqAlbumCoverUrl` |
| `src/main/albumPackaging.ts` | `album.cue` 文本生成 + 批次完成度跟踪 | `albumBundle` | `renderCue(bundle, entries)`、`AlbumPackager`（`plan` / `record` / `cueEntries`）、`CueEntry`、`AlbumCompletion` |

**两源原始 JSON → bundle 的解析不放 `albumBundle.ts`，放各自的 api 模块**（`fetchAlbumInfo` / `neAlbumInfo`）：曲目映射已有经过测试的实现（`trackFromEntry`、`neteaseTrackToDto`、`isVipEntry`），在 albumBundle 里重写等于复制 VIP 判据，且会形成 `albumBundle ↔ qqapi/tracks` 的循环 import。

目录路径的**唯一算式**是 `albumTrackDir(downloadDir, bundle, disc)`：曲目落盘（`runDownloadJob`）与附属文件写入（cover / cue）都调它。两处各拼一遍会漂移成 cue 指向不存在的目录。

`app.ts` 继续只做装配，不塞解析与排版逻辑（它已是全仓最大文件，649 行）。

## 5. 规格

### 5.1 数据类型

```ts
// src/main/albumBundle.ts
export interface AlbumBundle {
  source: 'qq' | 'netease'
  id: string            // QQ albummid / 网易云数字 id 的字符串形式
  name: string          // 空则回退 '未知专辑'
  artist: string        // 空则回退 '未知歌手'
  date: string          // 'YYYY-MM-DD'，可能空串
  company: string       // 可能空串（网易云实测 null）
  coverUrl: string      // 可能空串（拼不出则不写 cover.jpg）
  totalTracks: number   // 曲目数组实长，不信 total_song_num / album.size
  discs: number[]       // 去重升序碟号；长度 1 即单碟
}

// src/main/qqapi/tracks.ts TrackDTO 增两字段（渲染侧原样回传）
trackNo?: number        // 1 起
disc?: number           // 1 起，缺省视为 1
```

解析规则（两源各自的怪癖都收在这一层，下游不再分支）：

- QQ：`disc = Number.isInteger(cdIdx) && cdIdx >= 1 ? cdIdx : 1`；`trackNo = 下标 + 1`；`coverUrl` 由 `data.mid` 拼；`date = normalizeDate(data.aDate)`。
- 网易云：`disc = Number(songs[].cd) || 1`（`'01' → 1`）；`trackNo = Number(songs[].no) || 下标 + 1`；`coverUrl = album.picUrl`；`date = normalizeDate(album.publishTime)`。
- `normalizeDate(v)`：`v` 为数字或纯数字串 → 按时间戳（10 位按秒、13 位按毫秒）转本地时区 `YYYY-MM-DD`；否则取字符串前 10 位，且仅当匹配 `^\d{4}-\d{2}-\d{2}` 时采用，其余一律 `''`。**必要性**：`aDate` 与 `publishTime` 的确切格式本次未逐值验证（`publishTime` 在网易云通常是毫秒时间戳），归一化后下游只面对一种格式，目录名取年份与 cue 的 `REM DATE` 才不会被脏值带崩。
- `discs = [...new Set(tracks.map(t => t.disc ?? 1))].sort((a,b)=>a-b)`。

### 5.2 IPC 变更（破坏性，仅影响本应用）

| 通道 | 原返回 | 新返回 |
|---|---|---|
| `qq:albumSongs` | `TrackDTO[]` | `{ tracks: TrackDTO[]; album: AlbumBundle }` |
| `ne:albumSongs` | `TrackDTO[]` | `{ tracks: TrackDTO[]; album: AlbumBundle }` |
| `qq:linkTracks` | `{ kind, tracks } \| null` | `{ kind, tracks, album?: AlbumBundle }`（仅 `kind==='album'` 时带） |
| `dl:enqueue` | `{ tracks, quality, lyricMode, source }` | 追加可选 `album?: AlbumBundle`；`tracks` 内条目可带 `trackNo`/`disc` |

`src/preload/index.ts` 的通道白名单不变（无新通道）。

### 5.3 渲染侧

- `App.vue` 的 `songsView` 增可选 `album: AlbumBundle`；QQ 专辑页（`openAlbum`，`App.vue:429`）与链接导入专辑页填入。
- `NeteaseTab.vue` 增 `openedAlbumBundle: AlbumBundle | null`，`openAlbum`（`:103`）填入。
- 两处专辑歌曲页头部各加按钮「下载整张（N 首）」，点击 = 用该专辑全部 tracks + bundle 调 `dl:enqueue`，**忽略当前勾选**，并沿用现有底部「下载选中」的批次参数（quality/lyricMode）。
- 非专辑来源（我喜欢 / 自建 / 收藏 / 搜索结果 / 歌单链接）不显示该按钮。

### 5.4 落盘布局

```
<downloadDir>\阿良良木健 - 奇爱人生 LOVE ELEGIA (2019)\
    01 告别曲（Love Elegia Ver.）.flac
    02 遗忘山丘.flac
    cover.jpg
    album.cue
```

多碟：

```
<downloadDir>\歌手 - 专辑名 (2019)\CD01\01 ….flac
<downloadDir>\歌手 - 专辑名 (2019)\CD02\01 ….flac
<downloadDir>\歌手 - 专辑名 (2019)\cover.jpg
```

命名算法（`albumBundle.ts` 实现，全部走现有 `safeName`）：

- 专辑目录名 = `safeName(artist)` + `' - '` + `safeName(name)` + （`date` 前 4 位是 4 位数字时）`' (' + year + ')'`。
- 碟目录段 = 多碟时追加 `'CD' + String(disc).padStart(2,'0')`；单碟不追加。
- 文件名 = `NN` + 空格 + `safeName(track.name)` + `.` + ext；`NN` 位数 = `totalTracks >= 100 ? 3 : 2`。
- 同名冲突仍由现有 `uniquePath`（`app.ts:132`）处理，**不覆盖已有文件**；cue 用实际落盘 basename（见 §5.5），故加过 `(1)` 也不会指向不存在的文件。
- `job.album` 缺省时完全走现有平铺路径 `歌手 - 歌名.ext`，一行不改。

### 5.5 album.cue

- 位置与粒度：**每碟一份**，写在该碟目录里，单碟即专辑根目录的 `album.cue`。碟号只决定写到哪个目录，**不进 cue 文本**（`renderCue(bundle, entries)` 无 disc 形参）。
- 生成时机：该碟全部曲目都已成功落盘时写；未下齐不写。此后任一重试成功都会重写该碟 cue（幂等，全量覆盖）。
- 编码：**UTF-8 with BOM**（`\uFEFF`）。无 BOM 时 foobar2000 在中文 Windows 上按 GBK 猜，含中文曲名会乱码。
- 换行：CRLF（Windows 播放器惯例）。
- 形态：每曲一文件，每个 `FILE` 段一个 `TRACK`，`INDEX 00 00:00:00`。

```
\uFEFFREM DATE 2019
PERFORMER "阿良良木健"
TITLE "奇爱人生 LOVE ELEGIA"
FILE "01 告别曲（Love Elegia Ver.）.flac" FLAC
  TRACK 01 AUDIO
    TITLE "告别曲（Love Elegia Ver.）"
    PERFORMER "阿良良木健"
    INDEX 00 00:00:00
FILE "02 遗忘山丘.mp3" MP3
  TRACK 02 AUDIO
    TITLE "遗忘山丘"
    PERFORMER "阿良良木健"
    INDEX 00 00:00:00
```

- `FILE` 段容器关键字按**实际落盘扩展名**映射：`flac→FLAC`、`mp3→MP3`、其余（ape/m4a/ogg）→ 该碟不出 cue（这些容器无标签写入器，且非发行主流，宁缺不错）。
- 曲目顺序 = `trackNo` 升序。
- `REM DATE` 写 `bundle.date` 的前 4 位年份；`date` 为空则**省略整行**。
- 头部**只写** `REM DATE` / `PERFORMER` / `TITLE` 三行。不写 `REM GENRE`（`AlbumBundle` 无 genre 字段）、不写 `REM REPLAYGAIN_*`（没有 gain 数据，写了就是假数据）。
- 引号转义：字段值里的 `"` 替换为 `'`（cue 语法无标准转义，替换比破坏引号配对安全）。
- `cover.jpg` 在专辑内**首个任务落盘时**写一次（不依赖下齐），`coverUrl` 为空或抓取失败则跳过并写诊断日志。

### 5.6 标签写入器扩展

`TagMeta`（`src/main/tagger/types.ts`）增 `track?: number; trackTotal?: number; disc?: number; discTotal?: number`。

| 容器 | 帧/键 | 来源 |
|---|---|---|
| MP3 | `TRCK`（node-id3 `trackNumber: { position, total }`）、`TPOS`（`partOfSet: { numberOfParts, totalNumberOfParts }`） | `tagger/mp3.ts` |
| FLAC | `TRACKNUMBER` / `TRACKTOTAL` / `DISCNUMBER` / `DISCTOTAL` | `tagger/vorbis.ts:91-101` 的 fields 表 |

- 平铺下载（无 `album`）时这些字段缺省 → 不写，行为与现状逐字节一致。
- APE / m4a 仍无写入器（`app.ts:187` 的 `canTag` 判定不变），整张专辑选这两档时只出裸音频 + cover.jpg，不出 cue。README 已知限制同步。

### 5.7 完成度跟踪

`app.ts` 内 `const packager = new AlbumPackager()`，键为 `${source}:${album.id}`：

- 期望登记：`enqueue` 收到 `album` 时调 `packager.plan(album, tracks)`（平铺下载不调用 → 零影响）。
- 记录来源：`DownloadQueue` 的 `jobDone` 事件（`app.ts:319` 已转发）里，`job.album` 存在则 `packager.record(bundle, { trackNo, outputPath, ext, title })`；`outputPath` 为空（取消/失败）不入账。
- `title` **存原曲名**而非从文件名反推：文件名经 `safeName` 会替换 `/ : * ?` 等字符并在 100 字截断，反推会让 cue 的 TITLE 失真。
- 值语义：`Map<trackNo, {fileName, ext, title}>` + `Map<trackNo, disc>`；同一 trackNo 重复完成（重试）按后到者覆盖。
- 出 cue：`record` 返回**本次刚下齐**的碟号列表，逐碟取 `cueEntries(bundle, disc)`（碟内任一曲缺失、或含无标签写入器的容器 → 返回空，不出 cue）。
- 生命周期：session 内有效，与现有 `jobSpecs`（`app.ts:80`，上限 500）同规格处理——应用重启后不恢复，需重新整张入队。这是既有约束的延续，不是新增缺陷。
- 取消（`jobCancelled`）与失败（`jobFailed`）不记账，因此不会把半张算成整张。

## 6. 缺陷修复（同版本并入）

| # | 位置 | 问题 | 改法 |
|---|---|---|---|
| 1 | `NeteaseTab.vue:189`、`App.vue:976` | 切到「专辑」tab 后码率/歌词选择条整条消失，专辑路径全程无法调档 | 去掉 `v-if="searchTab === 'song'"`，常驻渲染 |
| 2 | `neteaseapi/urls.ts:35-37` | `ape`/`m4a` 无 br 档 → `startIdx=1`，**连无损请求都不发**，直接 320k 起 | 不支持的档位从 `startIdx=0`（无损）起跳 |
| 3 | `neteaseapi/urls.ts:51` | `downgraded: !supported \|\| …` → 选 ape/m4a 时恒为真 | 改为「实际落档索引 > 请求档位在降级链中的目标索引」才判降级；`supported=false` 时目标档位视为 `flac` |
| 4 | `DownloadOptions.vue:19-25` | QQ 独有的 APE/m4a 摆给网易云用 | 组件增 `source: 'qq' \| 'netease'` prop，按源过滤档位（网易云只给 无损/320k/128k）；挂载或 source 变化时，若当前 `store.quality` 不在可见档位内，立即 `setQuality('flac')` 并持久化 |
| 5 | `DownloadPage.vue:95` | 「已降级为低品质」不回显实际落档 | `DownloadJob` 增 `finalQuality?: Quality`（`runDownloadJob` 里由 `resolveOnce` 返回的 `quality` 写入，QQ/网易云两路都写；重试站点用 `=` 覆盖而非 OR，使 `downgraded` 与 `finalQuality` 合并语义一致）。档位中文名**复用渲染层已有的 `qualityOptions.ts`**：新增 `labelForQuality(q?: string)` 从 `QQ_QUALITIES` 查表，查不到回落「低品质」；主进程不再造第二份词表（`describeTierSizes` 回答的是「该曲登记了哪些档」，是另一个问题）。文案改为「已降级为 `labelForQuality(job.finalQuality)`」。渲染侧 `UiQueueJob`（`stores/download.ts`）同步加该字段——队列事件本就是 `{...job}` 浅拷贝透传，只需镜像层认它 |
| 6 | `neteaseapi/tracks.ts:96-98` + `app.ts:597` | `neAccount` 把一切异常 `catch { return null }`，故 `neAuthStatus` 的 `catch` 分支永不触发；断网/风控被误判成「登录已失效」——与 `app.ts:66-69` 注释声明的「探测失败不算失效」相反 | 新增 `neAccountChecked(client)`：业务层 `profile.userId` 缺失才返回 `null`，传输/风控异常**上抛**；`neAccount` 改为 `neAccountChecked().catch(() => null)` 保持既有调用点行为。`app.ts` 的 `neAuthStatus` 用 checked 版：`null` → sessionExpired；抛错 → 保守沿用文件判据 |
| 7 | `neteaseAuth.ts:30` | `neLoggedInFromAccount` 生产代码零调用，权威判据被复制成两份 | `app.ts:599` 的 `if (acc)` 改为 `if (neLoggedInFromAccount(acc))` |
| 8 | `App.vue:583-587` | 判出 acc 缺失只写 `nePlaylistError`，侧栏仍显示绿色「已登录」 | 同一分支里同步 `neSessionExpired.value = true` |
| 9 | `app.ts:591` | `neAuthStatus` 变异步后每次调用都打网络；启动时 `App.vue:841` 与 `NeteaseTab.vue:43` 各打一次，之后每次进网易云页再 +1 | 结果缓存 60s（与 `neteaseapi/tracks.ts:145` 的 `TRACK_IDS_TTL_MS` 同款窗口）；`neAuthImport` / `neAuthClear` / `neAuthSaveFromWindow` 与登录态事件到达时失效缓存 |

## 7. 测试

全部 mock 或本地 server，真实网络只做手工验收（项目既有纪律）。

**单元测试**
- `tests/albumBundle.test.ts`：`normalizeDate`（13/10 位时间戳、字符串数字、`YYYY-MM-DD`、脏值→空串）、`discOf`（`'01'→1`、0/缺失/非整数/负数→1）、`mkBundle`（空名回退、discs 去重升序、无曲目时 discs 仍为 `[1]`）、目录与文件名（含年份缺失、非法字符、≥100 首三位序号）、`albumRootDir`/`albumTrackDir` 路径算式。
- `tests/qqapi-tracks.test.ts` / `tests/neteaseapi-tracks.test.ts` 扩展：两源原始 JSON → `{bundle, tracks}` 的解析（mock fetch），含 `company:null`、`total_song_num` 与实长不一致（取实长）、QQ 无序号字段按下标、网易云 `no`/`cd` 采信、网易云专辑对象键名是 `album` 不是 `info`。
- `tests/albumPackaging.test.ts`：`renderCue` 纯函数——BOM 存在、CRLF、每 FILE 一个 TRACK、`INDEX 00`、容器关键字按实际 ext、混合 flac/mp3 时仍出 cue、含 ape 时该碟不出 cue、未下齐不出 cue、曲名含双引号时的转义、顺序按 trackNo、TITLE 用原曲名而非文件名；`AlbumPackager` 完成度（单碟/多碟各碟独立齐、重试覆盖、空 outputPath 不入账）。
- `tests/tagger-mp3.test.ts` / `tagger-flac.test.ts` 扩展：写 `track/disc` 后用 `music-metadata` 读回断言 `TRCK`/`TPOS` 与 `TRACKNUMBER`/`DISCNUMBER`；无 album 时断言这些键**不存在**（防回归到平铺下载）。
- `tests/neteaseapi-urls.test.ts` 扩展：`ape`/`m4a` 请求必须先打 `br=999000`；无损命中时 `downgraded === false`；无损回 320k 时 `downgraded === true` 且 quality 校正为 `'320'`（**反锚**：锁住「ape 直接 320 起跳」这个旧行为不再回来）。
- `tests/neteaseAuth.test.ts` 扩展：`neAccountChecked` 三态——有效 uid / 服务端确认无效（null）/ 传输异常（抛）；替换现有那条传字面量 `null` 的伪反锚。

**集成测试**（`tests/app.test.ts` 模式，本地 server 喂 fixture）
- 整张入队 → 全部完成 → 目录结构为 `专辑目录/NN 曲名.ext` + `cover.jpg` + `album.cue`；cue 里每个 `FILE` 名都能 `existsSync`。
- 一首失败 → 无 cue → `retryFailed` 成功后 cue 补生成，且内容含该曲。
- 多碟 fixture → 落 `CD01/`、`CD02/`，两碟各一份 cue，各只引用本碟文件。
- 平铺回归：不带 `album` 的 enqueue 产物路径与 0.6.1 完全一致（断言无子目录、无 cue、无 TRCK 帧）。
- 同名专辑二次整张下载 → 不覆盖，新文件带 `(1)`，cue 的 FILE 名跟着变且可解析。
- `neAuthStatus`：探测抛错 → `{loggedIn:true}` 且**不**置 sessionExpired（锁 §6 第 6 条）；探测确认无效 → `{loggedIn:false, sessionExpired:true}`；60s 内二次调用**不再发请求**（数 fetch 次数）。

**手工验收清单** → 新建 `docs/acceptance-album.md`
1. QQ 真实专辑整张下载（含一张只登记 128k 的曲子，验证降级链与 cue 仍自洽）。
2. 网易云真实专辑整张下载（`奇爱人生 LOVE ELEGIA`，id 74829483，13 首）。
3. 找一张 QQ 多碟专辑实测 `cdIdx` 取值语义，验证 §5.1 的碟号规则（R1）。
4. foobar2000 打开 `album.cue`：整张按 cue 播放、中文曲名不乱码、切轨正确。
5. Musicolet（安卓）导入子目录：按专辑聚合、序号顺序正确、内嵌歌词可见。
6. 档位修复回归：QQ 页选 APE → 切网易云页 → 选择条只出现 无损/320k/128k 且自动落回无损；下载后队列**不再**挂「已降级」。

## 8. 版本与文档

- `package.json` `0.6.1 → 0.7.0`（新增功能 + IPC 载荷破坏性变更）。
- `README.md`：功能表加「整张专辑下载」段；「风控与已知限制」补「整张专辑的 cue 只在下齐时生成」「QQ 专辑曲目序号取列表下标（服务端无序号字段）」「QQ/网易云专辑元数据来源」；测试用例数同步。
- `docs/acceptance-album.md` 新建（§7 清单 + 实测结论）。
- 本 spec 与后续实施计划进 `docs/superpowers/`。
- 提交遵循 Conventional Commits 中文描述；**commit 与 push 前等用户明示**。

## 9. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | QQ `cdIdx` / `belongCD` 取值语义未经多碟样本验证（本次只确认字段存在） | 实现按「去重碟号集合 >1 才算多碟」，取值异常时恒退化为单碟——单碟是安全默认，最坏情况是多碟专辑被拍平成一个目录且序号连续，不出错只丢结构。手工验收第 3 条实测后如需改，只动 `qqAlbumBundle` 一处 |
| R2 | 整张专辑 = N 首 × (详情 + 直链 + 下载 + 封面 + 歌词)，网易云频控窗口内请求量陡增 | 沿用现有 1 请求/秒下载限速（`downloader/ratelimit.ts`）与并发上限 4；按钮点击后按现有队列逐首排队，不引入并发放大。失败行保留「重试」，重试成功即补 cue，不必整张重来 |
| R3 | `qq:albumSongs` / `ne:albumSongs` 返回值形状变更，漏改调用点会白屏 | 调用点全仓仅 3 处（QQ 专辑页、网易云专辑页、`fetchTracksByLink`），实施计划里逐点列名并配 typecheck 把关 |
| R4 | cue 的 FILE 名与实际落盘名不一致（uniquePath 加后缀 / 降级换容器） | 设计上 FILE 名只从「实际完成记录」取，不重新推导；集成测试断言每个 FILE 名 `existsSync` |
| R5 | 用户把 `downloadDir` 设成只读目录或含非法字符 | 现有 `settingsSet` 白名单校验 + `mkdirSync` 抛错路径不变；专辑目录创建失败按现有任务失败处理，错误进队列行 |

## 10. 实施纪律（沿用既有约定）

- 凭证不落库、不打印；诊断日志脱敏（本设计只新增 cue/目录相关日志，不含凭证）。
- 移植/参考代码在文件头标注来源与许可。
- 每个模块先写测试再写实现（TDD）；§6 每条修复各配一条锁死旧行为的反锚用例。
- 真实网络探针跑完即删、不入库（本轮 `tests/tmp-album-probe.test.ts` 已按此删除）。
