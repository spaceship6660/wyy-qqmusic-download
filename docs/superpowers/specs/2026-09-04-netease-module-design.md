# 网易云音乐模块设计（增补）

> 日期：2026-09-04
> 状态：设计已获用户批准（2026-09-04）
> 项目：`F:\research\wyy-download\wyy-download`（QQ 音乐下载器 → 双平台下载器）
> 关联：`docs/superpowers/specs/2026-09-04-qqmusic-downloader-design.md`（P1，QQ 侧）、`docs/netease-download-research-2026-09-04.md`（网易云接口实测调研）

---

## 1. 目标

在现有 QQ 音乐下载器（Electron）中加入**网易云音乐模块**：登录（开窗扫码抓 cookie / 手动导入）后，直接查看该账号的「我喜欢的音乐」与全部歌单列表，点开歌单批量勾选下载；未登录也可搜歌下载免费歌（320k，已实测）。下载、标签内嵌、队列、限速、解密等管线全部复用 QQ 侧已有实现。

**范围外（YAGNI）**：不做网易云专辑/歌手页解析、不做多平台聚合搜索、不做 VIP 破解（免费歌 320k 为主，登录后按权益尝试更高档、拿不到自动降级）、不动现有解密模块。

## 2. 决策记录（用户已确认 2026-09-04）

| 决策点 | 结论 |
|---|---|
| 登录方式 | **Electron 开窗扫码抓 cookie**（`music.163.com/login` 登录页 + 抓 session cookie）+ 手动 cookie 导入兜底；不实现 weapi/eapi 加密 |
| 数据范围 | 「我喜欢的音乐」（specialType=5）置顶 + 全部歌单（创建的+收藏的）列表 |
| 下载质量 | 匿名 320k（实测可行）；登录后尝试更高档（无损 br=0），空直链自动降级 320→128→失败 |
| 执行顺序 | **先收尾 P1（QQ T6-T12）再开工 P2**——P1 的 T7 需加 `source` 字段、T10/T11 改 app.ts/App.vue，避免两计划改同一批文件打架 |
| TrackDTO.id | 网易云 id 为数字，映射进现有 `TrackDTO.id: string` 时 `String(id)`；直链/详情接口用数字传参 |

## 3. 接口现状（2026-09-04 实测）

| 接口 | 匿名 | 说明 |
|---|---|---|
| `GET api/user/playlist?uid={uid}&limit=&offset=` | ✅ 200 | 用户歌单列表；「我喜欢的音乐」= specialType 5 |
| `GET api/v6/playlist/detail/?id={id}` | ✅ 200 | 歌单详情；**匿名 trackCount=0**（完整曲目需登录 cookie） |
| `GET api/cloudsearch/pc?type=1&s=` | ✅ | 搜索（沿用调研 §2 实测） |
| `GET api/song/enhance/player/url?ids=[{id}]&br={br}` | ✅ 免费歌 320k 完整直链 | 需 Referer；连发触发风控 |
| `GET api/song/lyric?os=pc&id={id}&lv=-1&tv=1` | ✅ | 返回 lrc（含 tlyric 翻译） |
| `GET api/nuser/account/get` | 需登录态 | 取 uid 与登录名（联调实测项） |

直链为临时 CDN 短链（expi≈1200s，约 20 分钟）；Referer 是硬条件；频控敏感（连发 3-4 个即空响应）——全局 RateLimiter 1s/请求直接复用。

## 4. 架构

```
src/main/neteaseapi/           （新增，风格对齐 qqapi）
  client.ts     请求层：GET + 可选 Cookie 头（复用 QqApiError/重试/风控/超时语义——
                实现方式：泛化 qqapi/client 或独立轻量实现，二选一，倾向泛化）
  account.ts    登录态识别（MUSIC_U cookie 存在）+ api/nuser/account/get → uid/昵称
  library.ts    user/playlist → PlaylistDTO[]（name/id/specialType 5=喜欢/trackCount）
  playlist.ts   v6/playlist/detail → 曲目 TrackDTO[]（id String 化）
  search.ts     cloudsearch/pc → TrackDTO[]
  urls.ts       直链 + 降级链（br 映射：320000→320 / 128000→128，对齐 Quality 语义）+
                空直链降级；QqApiError 语义复用
  lyric.ts      api/song/lyric → lrc 文本
src/main/neteaseAuth.ts        开窗扫码：BrowserWindow → music.163.com/login →
                                session.cookies.get({url}) → 落盘 userData/netease_cookie.json；
                                importCookie(header) 手动导入；getStatus/clear
src/main/app.ts 扩展            netease 相关 IPC（auth:netease*、ne:library、ne:playlist、
                                ne:search）+ 队列 runner 按 job.source 分支直链层
src/renderer/src/NeteaseTab.vue 登录态 + 歌单列表（左）+ 曲目网格（右，复用 TrackGrid 样式/勾选）
                               + 批量入队
src/renderer/src/App.vue       三 Tab → 四 Tab（下载/网易云/解密/设置）
```

### 复用清单（零改动直接拿）

`downloader/`（file/ratelimit/queue）、`tagger/`（MP3/FLAC/.lrc；ogg 标签属解密计划范围，网易云侧产物以 mp3/flac 为主）、`fsUtils`、`settings.ts`（新增 `neteaseCookiePath` 字段）、IPC/preload 骨架、队列进度 UI、`TrackDTO`/`DownloadJob` 结构（加 `source`）。

### 对 P1 的唯一必要侵入

`DownloadJob` 增加 `source: 'qq' | 'netease'`（T7 实现时一并加）；app.ts 的 queue runner 按 `job.source` 选直链层（getAudioUrl 是平台各自的）。其余 P1 结构不动。

## 5. 数据流

- **登录**：网易云 Tab → 「扫码登录」→ 主进程开窗 `music.163.com/login`（无边框，登录完成/用户点完成 → 抓 cookie）→ 存 `{cookie: "完整 Cookie 头"}` 到 `userData/netease_cookie.json`（gitignore 原则）→ 状态栏显示昵称。手动模式粘贴 cookie 头。
- **歌单浏览**：登录后 `account.ts` 拿 uid → `library.ts` 列歌单（「我喜欢的音乐」置顶）→ 点歌单 → `playlist.ts` 拉全量曲目（**未登录时提示「登录后查看完整曲目」**，允许匿名仅显示数量、禁用下载）→ 勾选 → 选质量 → 批量入队。
- **下载**：runner 拿 `job.source='netease'` → `urls.ts` 直链（带 cookie 尝试 br=0 → 空则 320000 → 128000，最小降级）→ `downloader.file` 下载 → `tagger` 内嵌（元数据/封面/歌词走网易云接口）→ 完成。文件命名沿用「标题 - 歌手」，扩展名按实际（mp3 为主；flac/ape 视权益）。
- **搜索**：网易云 Tab 顶部搜索框（cloudsearch/pc）→ 结果网格 → 与歌单流程同路径入队。

## 6. 错误处理 / 风控

- 全局 RateLimiter 单实例共享（QQ+网易云共用一个，1s/请求）
- 直链空 → 降级链；全程空 → 抛错（信息区分「免费歌无直链（可能下架/无版权）」与「权益不足」）
- 风控空响应 → client 层 QqApiError('rate-limited') 不重试（复用语义）；队列层指数退避
- 登录过期（MUSIC_U 失效、uid 接口 301）→ 状态提示「登录过期，请重新扫码」

## 7. UI

- 顶栏登录状态扩展：QQ 登录 / 网易云登录 两个独立按钮
- 网易云 Tab：左栏歌单列表（icon + 名称 + 数量，喜欢的置顶高亮）；右栏曲目网格（封面/标题/歌手/VIP 角标按需）+ 勾选 + 质量选择 + 入队；顶部搜索框；未登录态显示「扫码登录后查看歌单」
- 设置 Tab 增加：网易云登录状态/清除

## 8. 测试与验证

- 单测（mock fixture）：`library`（用实测真实响应结构）、`playlist`、`search`、`urls` 降级链（沿用 T4 测试模式）、`lyric`；`account` 登录态判定
- 登录逻辑薄（开窗抓 cookie = Electron session API），主要靠手工验收
- 手工验收清单：
  1. 真实扫码登录 → 昵称显示；cookie 落盘 `netease_cookie.json`
  2. 「我喜欢的音乐」显示全量曲目 → 勾选 20 首批量下载 → 320k 全成
  3. foobar2000/Musicolet 打开网易云产物：标签/封面/歌词规格与 QQ 侧一致
  4. 未登录搜索免费歌 → 320k 正常；VIP 歌提示
  5. 登录后尝试无损（有权益则成功，无则降级提示）
  6. 风控：连续 30 首队列下载稳定（1rps 限速生效）

## 9. 里程碑（P2，在 P1 收尾后执行）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **N1** neteaseapi 数据层 | client/account/library/playlist/search/urls/lyric + mock 单测 | 全绿；真实请求冒烟（搜索/歌单匿名） |
| **N2** 登录 | 开窗抓 cookie + 手动导入 + 状态/清除 + 落盘 | 真实扫码后 cookie 落盘、uid 可读 |
| **N3** UI + 入队 | 网易云 Tab + App.vue 四 Tab + runner source 分支 | 登录后浏览/批量下载全流程走通 |
| **N4** 验收 | P2 手工验收清单 + 双平台回归 | 清单全过 |

## 10. 开放风险（联调实测项）

1. `api/nuser/account/get` 2026 现况（登录态取 uid）——N2 实施时用真实 cookie 验证，失败则换 weapi/eapi 或从 cookie/歌单接口回推 uid
2. 登录态下 `v6/playlist/detail` 是否返回全量曲目（匿名 trackCount=0 已见）——N1 联调验证，失败则换 `api/v3/playlist/detail` 或 weapi
3. 登录后无损（br=0）实际权益边界——按「尝试→空→降级」兜底，不阻塞
4. 风控阈值双平台共享 —— N4 验收定量

## 11. 实施纪律

- cookie 明文落盘（同 QQ 侧惯例），路径 `userData/netease_cookie.json`；不入库、不打印
- 所有请求带 Referer `https://music.163.com/` + UA；绕过系统代理（国内直连）
- 移植/借鉴 Creamplayer 与调研文档处标注来源
- 每模块先测试（TDD）；沿用 P1 的 subagent-driven 执行流程与两审