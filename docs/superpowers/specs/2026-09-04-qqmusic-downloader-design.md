# QQ 音乐下载器（Electron）设计

> 日期：2026-09-04
> 状态：设计已获用户批准（2026-09-04）
> 项目位置：`F:\research\wyy-download\wyy-download`
> 相关调研：`docs/netease-download-research-2026-09-04.md`（网易云侧参考，本项目只做 QQ）

---

## 1. 目标

一个对标 Creamplayer 的 QQ 音乐下载器（Electron 桌面应用，中文界面）：

- 搜索 / 单曲链接 / **歌单链接** / **专辑链接** 四种入口，支持多选批量下载
- 登录（ptlogin2 扫码 + 手动 cookie）后按账号权益下载无损（flac/ape）；无权益自动降级 320k 并提示
- 自动内嵌封面；歌词处理 4 档：内嵌+另存 .lrc / 仅内嵌 / 仅另存 / 不保存
- 内嵌标签面向 foobar2000 与 Musicolet（规格见 §5）
- 导入 QQ 音乐加密文件（`.mflac/.mflac0/.mgg/.mgg0/.mgg1`）→ 解密（保持原容器）→ 自动搜索匹配补全封面/歌词内嵌
- 并发队列、限速防风控、错误可读

**范围外（YAGNI）**：不破解会员（无绿钻只能下免费/试听档）、不做歌手页/排行榜、不做卡拉OK逐字歌词、不做多平台聚合、ogg→flac 转码非强制（见 §4.3）。

## 2. 决策记录（用户已确认）

| 决策点 | 结论 |
|---|---|
| 技术栈 | Electron + Vite + Vue3 + TypeScript，**全 JS 单语言**（不用 Python 后端、不套 yt-dlp） |
| 解密深度 | 解密 + 自动补封面歌词（与下载器共享内嵌管线） |
| 批量入口 | 搜索 / 单曲 / 歌单 / 专辑 |
| 加密格式 | 新版 `.mflac/.mflac0/.mgg/.mgg0/.mgg1` 系（不移植老 qmc0/qmc3） |
| 解密产物 | **保持原容器**：mflac→flac、mgg→ogg；检测到系统 ffmpeg 时提供可选「转 flac」 |
| MP3 标签 | **ID3v2.4 + UTF-8** |

许可：移植 unlock-music（MIT）qmc 解密核心、参考 lx-music（MIT）node-id3 管线写法，均需在代码注释标注出处。

## 3. 架构

```
renderer (Vue3 + Pinia)  ── preload contextBridge（白名单 invoke）──▶  main (纯 Node)
                                    │
        ┌───────────────────────────┼────────────────────────────────┐
        ▼                           ▼                                ▼
   qqapi.ts                  auth.ts                        downloader.ts
   musicu.fcg 客户端：          ptlogin2 扫码五步             流式下载 .part 原子替换
   搜索/详情/歌单/专辑/          (移植 Spica qqmusic.py 逻辑)   并发队列+指数退避
   CgiGetVkey 直链              cookie JSON 落盘 (userData)   限速节流 (≥1s/请求)
        ▼                           ▼                                ▼
   unlock.ts                  tagger.ts                     fsUtils.ts
   mflac/mgg 系解密             MP3: USLT+SYLT+APIC+文本帧      命名/重名(n)/目录管理
   (移植 unlock-music qmc 核心) FLAC/OGG: LYRICS+UNSYNCEDLYRICS
                               +PICTURE+文本字段
```

模块边界（每个模块单职责、纯 Node 可单测、通过 IPC 只传简单数据）：

| 模块 | 职责 | 依赖 | 对外接口 |
|---|---|---|---|
| `qqapi` | musicu.fcg POST、歌单/专辑 fcg 解析、搜索结果打分 | 无 | `search(q)`, `resolveLink(url)`, `getTrackUrl(songmid, quality, cookie)`, `getDetail(songmid)` |
| `auth` | ptqrshow→ptqrlogin→check_sig→authorize→QQLogin；cookie 读写 | `qqapi`（QQLogin 步骤） | `startQrLogin()`, `pollQr()`, `saveCookie()`, `loadCookie()`, `manualCookie(str)` |
| `downloader` | 单曲流式下载、队列、重试退避 | `qqapi`, `fsUtils` | `downloadTrack(job)`, `enqueue(tracks)`, 队列事件 |
| `tagger` | 标签写入（§5 规格） | `node-id3`, 自写 FLAC/OGG vorbis 写入 | `tagFile(path, meta)` |
| `unlock` | 格式检测、解密、补全协调 | `qqapi`, `tagger`, `fsUtils` | `unlockFile(path, outDir)` |
| `fsUtils` | 安全文件名、重名 `(n)`、目录确保 | 无 | `safeName()`, `uniquePath()` |

## 4. QQ 接口规格

全部走 `POST https://u.y.qq.com/cgi-bin/musicu.fcg`（data=JSON，Header：UA Firefox/115、`Content-Type: application/json;charset=utf-8`、`Referer: https://y.qq.com/`；登录态附加 `Cookie` 头）。本机国内网络直连，**显式绕过代理**（参考 Spica `_direct_opener` 的 `ProxyHandler({})` 模式）。

### 4.1 搜索
- module `music.search.SearchCgiService` / `DoSearchForQQMusicDesktop`
- param: `grp=1, num_per_page=limit, page_num=1, search_type=0`
- 响应 `data.req.data.body.song.list[]`（mid/name/singer/album）；同名多结果打分取最优（移植 Spica `_score_song` 思路）

### 4.2 直链（CgiGetVkey）
- module `vkey.GetVkeyServer` / `CgiGetVkey`
- param: `filename=[f"{prefix}{songmid}{songmid}.{suffix}"]`, `guid`（随机 1e10 量级）, `songmid[songmid]`, `songtype:[0]`, `uin`（登录 uin 或 "0"）, `loginflag:1`, `platform:"20"`
- comm: `uin` + `ct:24` + `cv:0`
- 响取 `data.req_1.data.sip[0] + midurlinfo[0].purl`；**purl 为空 → 需登录或权益不足**
- 质量前缀映射：`m4a→C400.m4a`、`128→M500.mp3`、`320→M800.mp3`、`无损→F000.flac`（优先）/ `A000.ape`

### 4.3 歌单 / 专辑
- 实施时以 yt-dlp `qqmusic.py` extractor 的端点为参考（`c.y.qq.com` fcg 系：`fcg_v8_playlist_cp.fcg`、专辑详情等），配 mock fixture 测试，不依赖死记端口
- 链接识别：`y.qq.com/n/ryqq/songDetail/{mid}` / `playlist/{id}` / `album/{id}` 及 `music.163.com` 无关的 QQ 域

### 4.4 登录（ptlogin2 扫码，参考 Spica `agent_tools/function_tools/song/qqmusic.py:285-511`）
1. `GET ssl.ptlogin2.qq.com/ptqrshow`（appid=716027609, daid=383, pt_3rd_aid=100497308）→ 二维码 + `qrsig`
2. 轮询 `ssl.ptlogin2.qq.com/ptqrlogin`（66 等码 / 67 已扫待确认 / 65 失效 / 68 拒绝 / 0 成功），`ptqrtoken=hash33(qrsig)`
3. `ssl.ptlogin2.graph.qq.com/check_sig` 换 `p_skey`（禁跟随重定向）
4. `POST graph.qq.com/oauth2.0/authorize`（client_id=100497308）换 code
5. musicu.fcg `QQConnectLogin.LoginServer/QQLogin` 换 `musicid+musickey` → cookie：`uin=o{musicid}; qqmusic_uin=o{musicid}; qm_keyst={musickey}; qqmusic_key={musickey}`
- 手动模式：粘贴浏览器 y.qq.com 完整 cookie 头保存
- 存储：明文 JSON 落盘 `userData/qqmusic_cookie.json`（本地使用；UI 提示敏感）
- 续期：无自动刷新；下载遇空 purl → 状态栏提示「登录过期，请重新扫码」

### 4.5 降级链
`F000 →(空) M800 →(空) M500 →(空) C400 → 失败(明确原因)`；降级时黄色提示「当前账号权益不足以获取无损，已降级 320k」

## 5. 标签内嵌规格（foobar2000 + Musicolet 兼容）

调研依据：foobar2000 官方标签映射（USLT→Unsynced Lyrics、Vorbis `LYRICS`）；Musicolet 官方功能页「Embedded Lyrics and .LRC support」；ID3 规范（USLT/SYLT 帧结构）。详见 `docs/netease-download-research-2026-09-04.md §5`。

| 容器 | 写入内容 | 说明 |
|---|---|---|
| MP3 | ID3v2.4 + UTF-8；**USLT**（lang=`XXX`，descr 空，非同步歌词全文）+ **SYLT**（format=1=LRC 时间戳格式，type=0，descr 空）+ **APIC**（type=3）+ `TIT2/TPE1/TALB/TDRC/TCOP/TCON` | foobar 原生解析 USLT 为歌词字段（显示需任意歌词组件：ESLyric / Lyric Show Panel 3 / OpenLyrics）；Musicolet 原生读 ID3 内嵌歌词 |
| FLAC / OGG | Vorbis comment：**`LYRICS` + `UNSYNCEDLYRICS` 双键**（同一份纯文本，勿再加小写 `lyrics`，Vorbis 大小写不敏感会重复）+ `METADATA_BLOCK_PICTURE`（type=3）+ `TITLE/ARTIST/ALBUM/DATE/COPYRIGHT/GENRE` | `LYRICS`=foobar 原生键；`UNSYNCEDLYRICS`=Mp3tag 系惯例；双键覆盖 Musicolet 未公开的 FLAC 键名未知数 |
| .lrc 另存 | 与音频**同目录同名**，UTF-8 | Musicolet 同步歌词最稳路径（官方要求文件名完全一致）；foobar 组件也读本地 .lrc |

封面：MP3 用 JPEG（或 PNG）；FLAC/OGG 的 picture block mime 依实际。无封面时跳过 APIC/PICTURE（不写空块）。

## 6. 解密（unlock.ts）

- **格式检测**（魔数）：`.mflac/.mflac0` → 音频数据起始藏 `fLaC` 标志；`.mgg/.mgg0/.mgg1` → ogg `OggS` 特征
- **解密**：移植 unlock-music（MIT）qmc 核心——ekey 从文件尾部读取（128 位），静态密钥表 / RC4 变体按检测结果分派；只做新版 mflac/mgg 系，老 qmc0/qmc3 明确弹「不支持」
- **产物**：mflac→`.flac`、mgg→`.ogg`（原容器）；若检测到系统 `ffmpeg` 存在，解锁页提供可选「ogg→flac 转码」按钮（无损重封装，非默认）
- **补全**：文件名解析「曲名 - 歌手」（无分隔符则整名作曲名）→ `qqapi.search` 取最优 → 拉封面/歌词 → tagger 写入。匹配失败：仅解密，UI 标记「未匹配」
- 批量：多文件拖入 → 队列逐个处理 → 结果列表（✓ 解密+补全 / ○ 仅解密 / ✗ 失败原因）

## 7. 错误处理 / 风控

- 全局限速：≥1 秒/请求；空响应（风控特征，详见调研实测）→ 指数退避（1s/2s/4s，最多 3 次）
- 直链 20 分钟过期（`expi=1200`）：下载前校验，失败重取直链再下
- 未登录遇 VIP 歌：提示登录，不静默失败
- 文件名：非法字符 `\/:*?"<>|` 替换、100 字符截断、重名 `(n)`
- 下载 `.part` 临时文件 + 完成后原子改名；失败清理残留

## 8. UI（中文，单窗口）

- **顶栏**：应用名、登录状态按钮（未登录 / 扫码中 / 已登录）
- **下载 Tab**：搜索框（关键词/链接智能识别）→ 结果网格（封面缩略、标题、歌手、VIP 角标、码率可选）→ 批量勾选 → 队列列表（进度、状态、失败原因、打开所在目录）
- **解密 Tab**：拖放/选择文件 → 文件列表 → 输出目录 → 开始；结果列表含补全状态
- **设置 Tab**：默认码率、并发数（1-4/不限）、下载目录、歌词模式（内嵌+另存/仅内嵌/仅另存/不保存）、解密输出目录、ffmpeg 检测状态、手动 cookie 粘贴

## 9. 测试与验证

- **单测（vitest）**：
  - `tagger`：对生成的 fixture mp3/flac/ogg 写标签后读回断言（USLT 内容 / SYLT 存在 / APIC、PICTURE 存在 / LYRICS+UNSYNCEDLYRICS 双键 / 文本帧）
  - `unlock`：加密 fixture 样本（取自 unlock-music 仓库测试数据）解密 → 输出为合法 flac/ogg
  - `qqapi`：mock 网络层（fixture JSON），测搜索解析、质量映射、空 purl 判定
  - `fsUtils`：命名/重名/截断
- **不做**：依赖真实接口的用例进 CI（接口易变且触发风控）
- **手工验证清单**（里程碑验收用）：
  1. 真实登录 → 下载 320k 与 flac（绿钻账号实测无损权益边界）
  2. foobar2000（装 ESLyric 组件）打开产物显示歌词
  3. Musicolet（安卓）显示内嵌歌词；.lrc 模式显示同步歌词
  4. 真实 .mflac 文件解密 → flac 可播放、封面歌词齐全
  5. 歌单/专辑链接整单下载

## 10. 里程碑（实施顺序，每个独立可验）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1** 骨架 | electron+vite+vue3 工程、单窗口、三 Tab 布局、IPC 骨架 | 应用可启动，三页可切换 |
| **M2** 匿名下载 | 搜索/链接解析 + CgiGetVkey + 流式下载（免费歌 320k），无标签 | 真实下载一首免费歌可播放 |
| **M3** 登录+无损 | 扫码/手动 cookie + F000 请求 + 降级链 | 登录态下载 flac（绿钻）或降级提示 |
| **M4** 队列 | 并发、限速、退避、进度 UI、失败原因 | 批量 10 首稳定完成，无风控空响应 |
| **M5** 标签内嵌 | tagger 管线 + 封面 + 歌词三模式 + .lrc 另存 | foobar2000/Musicolet 双验证通过 |
| **M6** 解密 | mflac/mgg 检测+解密+自动补全 + 批量 | 真实加密文件验证通过 |
| **M7** 打磨 | 歌单/专辑全量、批量体验、错误文案、electron-builder 打包 | 打出的 exe 可运行全功能 |

## 11. 开放风险（设计假设，需实测）

1. **无损权益边界**：F000 flac 是否仅绿钻/超级会员可拿——以真实账号实测为准；实现按「空 purl → 降级」兜底，不阻塞
2. **Musicolet FLAC 歌词键名**：官方无公开文档，以双键 + .lrc 兜底覆盖
3. **风控阈值**：调研实测连发 3-4 请求即空；实现取保守 1rps + 退避，M4 验收时定量校准
4. **专辑/歌单端点**：以 yt-dlp extractor 为参考实现，联调时若有变动以实测为准

## 12. 实施纪律

- 凭证文件（cookie JSON）属敏感数据：不入库（.gitignore）、不打印日志
- 所有网络请求带 Referer/UA；绕过系统代理
- 移植代码（unlock-music qmc 核心、Spica 登录逻辑）在文件头标注来源与许可
- 每个模块先写测试（TDD）；里程碑逐个验收后再进下一个