# 0.7.0 整张专辑下载与标准封装 验收记录（2026-10-07）

范围：整张专辑下载（`albumBundle.ts` / `albumPackaging.ts` / 专辑落盘与附属文件 / 「下载整张」入口）+ 同版本并入的两组修复（音质档位与选择条 1-5、网易云会话判据 6-9，见 spec §6 表）。
本文档记录本 session 的自动化结果、一次真实网络复核，以及**需要人在真实环境逐条填「实测」**的手工清单；「实测」列留空即未验。

> 纪律沿用项目既有约定：真实网络只做本清单，不写进单测（接口易变 + 触发风控）。清单跑完把结论回写本文档并入库，产物目录自行清理（不入库）。

## 1. 本 session 已复核的结果

### 1.1 自动化（离线，全部 mock 或本地 server）

- `npx vitest run`：**28 个测试文件 / 379 个用例全部通过**（68.5s）
- `npm run typecheck`（`vue-tsc --noEmit -p tsconfig.web.json && tsc --noEmit -p tsconfig.json`）：**通过，零错误**
- 本版新增/扩展的专辑用例（按模块）：
  - `tests/albumBundle.test.ts`：`normalizeDate`（13/10 位时间戳、`YYYY-MM-DD`、脏值→空串）、`discOf`（`'01'→1`；0/缺失/非整数/负数→1）、`mkBundle`（空名回退、`discs` 去重升序、`discTotals` 与 `discs` 同集）、目录与文件名（缺年份、非法字符、≥100 首转三位序号）、`albumRootDir`/`albumTrackDir` 路径算式、`qqAlbumCoverUrl` 的 R500 拼接
  - `tests/albumPackaging.test.ts`：`renderCue` 的 BOM + CRLF 字节级、每 `FILE` 一个 `TRACK`、`INDEX 00`、容器关键字取落盘 ext、flac/mp3 混排仍出 cue、含 ape/m4a 整碟撤回、曲名含 `"` 的转义、按 `trackNo` 升序、TITLE 用原曲名；`AlbumPackager` 的判齐（每碟各自齐、重试覆写、空 `outputPath` 不入账、`(disc, trackNo)` 双键下两碟重编号不互顶、`disc` 不在 `discTotals` 里→永不判齐）
  - `tests/app.test.ts`（端到端，本地 server 喂 fixture）：专辑落盘路径与 `safeName`/`uniquePath`、`retryFailed` 保留 `album`、整张下齐 → `cover.jpg` + `album.cue` 且 cue 每个 `FILE` 都 `existsSync`、TRCK=`1/2`、多碟 → 每碟各一份 cue 各引本碟文件 + cover 只在根、**每碟从 1 重编号的两碟专辑**两碟都出 cue、一首失败 → 只有 cover 无 cue → 重试成功补生成、**懒加载回归**（10 首只入队 2 首且都成功 → 无 cue；补齐 8 首后 cue 出 10 个 FILE）、**残缺批次后重新整张入队**（已下过的落成 `01 t1(1).mp3`，cue 只认最新那一笔）、第二次整张下载 FILE 跟着改名、m4a 整张无 cue、`coverUrl` 为空/封面抓取失败都不拖累 cue 与任务、反锚：平铺下载零附属文件零子目录零 TRCK/TPOS
  - `tests/tagger-mp3.test.ts` / `tests/tagger-flac.test.ts`：`TRCK`/`TPOS` 原始帧值（`3/13`、`1/2`；总数缺省时只写 `3` 不写 `3/`）与 `TRACKNUMBER`/`TRACKTOTAL`/`DISCNUMBER`/`DISCTOTAL` 读回；不传 track/disc 时这些帧/键**完全不出现**
  - `tests/qqapi-tracks.test.ts` / `tests/neteaseapi-tracks.test.ts`：两源原始 JSON → `{bundle, tracks}`；QQ 无序号字段按下标+1、`totalTracks` 用实长不信 `total_song_num`；网易云专辑对象键名是 `album` 不是 `info`（反锚）、`songs[].no`/`cd` 采信
  - `tests/neteaseapi-urls.test.ts` / `tests/neteaseAuth.test.ts` / `tests/renderer-store.test.ts`：ape/m4a 必须先打 `br=999000`、无损命中 `downgraded=false`、回 320k 才 `true` 且档位校正；`neAccountChecked` 三态；`labelForQuality` 词表与 `albumPartialConfirm`/`albumEnqueuedNotice` 文案

### 1.2 真实网络（本 session 已复核，**不是开放项**）

| 项 | 结果 | 详情 |
|---|---|---|
| QQ 专辑封面大图 URL 形态（计划 Task 6 Step 4） | ✅ **成立，不回退 R300** | `GET https://y.gtimg.cn/music/photo_new/T002R500x500M000001LVtAD0sEPKu.jpg`（UA + referer）→ **HTTP 200、63,584 字节、首三字节 `ffd8ff`（JPEG 魔数）**。2026-10-07 复核。`qqAlbumCoverUrl` 保持 `T002R500x500`；曲目自带的 R300 只用于单曲封面 |

## 2. 手工验收清单（真实环境逐条填「实测」）

前置：`npm run dev` 起应用；下载目录先在设置页指到临时目录；两侧均已登录（QQ 扫码、网易云 cookie）。诊断日志在 `userData/qq-login-diag.log`（专辑附属文件被跳过 / 写失败会在里面留一行）。

| # | 项目 | 步骤 | 期望（代码与单测已锁的行为） | 实测 |
|---|---|---|---|---|
| 1 | QQ 整张下载 | QQ → 「专辑」tab → 搜「奇爱人生」→ 点专辑卡片 → 「下载整张（N 首）」 | 只建出 `下载目录/歌手 - 专辑 (年)/` 一个子目录；曲目文件名 `NN 曲名.ext`（≥100 首转三位）；根下 `cover.jpg` + `album.cue`；cue 里每个 `FILE` 名都能在目录里找到实体；中文曲名在 cue 里不乱码 | 待填 |
| 2 | 只登记 128k 的曲子 | 挑一张含「详情里 `file.size_flac=0`、只登记 128k」曲子的专辑整张下载 | 该曲落 128k mp3，cue 里那一段的 `FILE … MP3` 且文件名跟着实际落盘名走——同一张专辑 flac/mp3 混排时 cue 仍自洽 | 待填 |
| 3 | 网易云整张下载 | 网易云 → 「专辑」tab → 搜「奇爱人生」→「奇爱人生 LOVE ELEGIA」（id 74829483，13 首）→「下载整张（13 首）」 | 13 首全落 `阿良良木健 - 奇爱人生 LOVE ELEGIA (2019)/`，cue 13 个 `FILE`；序号取服务端 `songs[].no` 而非下标 | 待填 |
| 4 | 手动勾选仍走平铺（对照项） | 在同一个专辑页只勾 2 首，用底部「下载选中」 | 产物是原来的平铺 `曲名 - 歌手.ext`，**不进专辑目录**；专辑目录里不新增文件、已有 cue 不被改写；这两个文件无 TRCK/TPOS（或 TRACKNUMBER）帧 | 待填 |
| 5 | cue 只在整碟真下齐时出 | 整张下载中取消其中一首（或临时断网让它失败） | 该碟目录有音频与 cover、**没有 `album.cue`**；点失败行「重试」成功后该碟 cue 自动补生成且包含该曲 | 待填 |
| 6 | **QQ 多碟 `cdIdx` 取值语义（spec 风险 R1，开放问题）** | 找一张确认为 2CD 的 QQ 精选集整张下载 | 若服务端确实回多碟值 → 专辑根下 `CD01/`+`CD02/`、每碟各一份 cue 各只引本碟文件、cover 只在根、`TPOS` 写 `1/2` 与 `2/2`；若 `cdIdx` 恒 0/1 → 拍平成单目录连续序号（安全默认，丢结构不出错）。**请把实测到的 `cdIdx` 原值抄进本节下方「多碟实测记录」**——该字段至今只确认存在、语义从未被真实多碟样本验证过；若判据要改，改动点只有 `src/main/qqapi/tracks.ts` 里 `disc: discOf(e?.cdIdx)` 这一处 | 待填 |
| 7 | **残缺批次（懒加载）路径是否可达（本版新增关注点）** | 打开一张曲目较多的 QQ 专辑页，观察按钮文案；若能构造出「本页曲目数 < 专辑实长」就点「下载整张」 | 正常流程**预期走不到**这一支：两侧专辑页都是单响应给出全部曲目（`App.vue`/`NeteaseTab.vue` 的 `openAlbum` 都不带分页游标）。若真走到（服务端截断、或列表被别的来源改短）：按钮应写「下载整张（已加载 x / y 首）」、点击先弹确认并明说「这批不会有 album.cue」、入队回显重复一次；盘上只有音频 + cover、无 cue。恢复路径：把剩余曲目加载完再点一次 → 已下过的**不覆盖**而是多落一份 `01 曲名(1).flac`，cue 收最新那一笔账（`tests/app.test.ts` 已锁逻辑，此处只验 UI 文案与真实文件系统表现） | 待填 |
| 8 | foobar2000 按 cue 播放 | foobar2000 打开专辑目录里的 `album.cue` | 整张按 cue 载入、可逐轨切换、中文曲名不乱码（BOM 生效的证据）；头部只有 `REM DATE` / `PERFORMER` / `TITLE` 三行且与专辑信息一致 | 待填 |
| 9 | Musicolet（安卓）聚合 | 把专辑子目录整体导入 Musicolet | 按专辑聚合、曲目顺序按序号正确、内嵌歌词可见；多碟时 `CD01`/`CD02` 不互相串；单曲总数显示取自专辑实长（TRCK `3/13` / TRACKTOTAL 13） | 待填 |
| 10 | 档位修复回归 + 默认值被改写 | QQ 页选 APE → 切到网易云 tab | 选择条只出现 **无损 / 320k / 128k**，当前档自动落回无损；**回设置页确认默认档位已从 APE 变成 FLAC 无损**（这条改写会落盘，不是只在内存里）；随后网易云整张下载队列**不**挂「已降级」 | 待填 |
| 11 | 降级回显实际落档 | 网易云选无损但账号无权益（或切匿名） | 黄条文案是「已降级为 320k」，点名落档，而不是旧的「已降级为低品质」 | 待填 |
| 12 | APE/m4a 整张不出 cue | QQ 页选 APE 后整张下载 | 该碟只有 `NN 曲名.ape` + cover，**没有 `album.cue`**（诊断日志应有一行「第 N 碟不出 album.cue（容器不可索引或缺曲目），已跳过」）；ape 曲目本身可正常播放（无内嵌封面/歌词，按歌词档只另存 `.lrc`） | 待填 |
| 13 | 会话判据不误报 | ① 网易云登录态下断网（或撞频控）再进网易云页 / 点侧栏歌单；② 换一份真过期的旧 cookie 重复一次 | ① 侧栏**不得**出现红色「登录已失效」（探测失败 = 没有结论，保守沿用 cookie 文件判据）；② 只有服务端确实不认这份凭证才判失效。探测结果 60 秒缓存且与 `ne:account` 共用同一次探测：结论确认后 60 秒内的重复调用不再打网络，所以会话**中途**失效会在窗口外那一次调用才暴露，不是立刻 | 待填 |
| 14 | cover 落盘正确性 | 看整张下载产物里的 `cover.jpg` | 大图形态已在 §1.2 复核（R500 取到真 JPEG），本项只核产品侧：封面落在**专辑根**、多碟时不在每个 `CDnn` 里重复；若源是 PNG 应落 `cover.png` 而不是冒充 `.jpg` | 待填 |

### 多碟实测记录（清单项 6 填这里）

```
专辑名 / albummid：
cdIdx 逐条取值（前若干条即可）：
belongCD 逐条取值：
实际是否多碟： 是 / 否
产物结构：     CDnn 分层 / 单目录连续序号
```

## 3. 已知边界（衔接 README「风控与已知限制」）

1. **完成度表只在 session 内有效**：`AlbumPackager` 与 `jobSpecs` 同生命周期，应用重启后不恢复。重启后要补 cue，需重新点一次「下载整张」（已下过的会多落一份 `(1)`，cue 跟着换成最新落盘名——这是设计选择，不是缺陷）。
2. **cue 是整碟全量重写**：任一重试成功都重写该碟 cue，不追加。写失败只进诊断日志，不把已下好的歌判成失败。
3. **QQ 专辑曲目序号是下标**（服务端无序号字段），`total_song_num` 与实长不一致时一律取实长；碟号语义见清单项 6。
4. **只有整张进专辑目录**：歌单/我喜欢/搜索结果/专辑页手动勾选全部维持 0.6.1 的平铺产物（有反锚用例锁死）。
5. **专辑页的分页假设未经真实长专辑验证**：见清单项 7。判齐逻辑按专辑真实曲目数走，所以即便某天真出现截断，产物也只是「缺 cue」，不会出一份把 10 首呈成 2 首的错 cue。
6. **设置页仍无条件列五档**（`SettingsPanel.vue`）：按源过滤只做在列表页的选择条上，是本次未做的遗留项；后果见 README 对应条。
