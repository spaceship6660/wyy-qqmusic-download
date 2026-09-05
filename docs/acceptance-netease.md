# P2 网易云模块验收记录（2026-09-02，Task N4 收官）

范围：P2 网易云模块（数据层/登录/UI/入队，在 P1 QQ 模块之上）。
本文档记录本 session 完成的自动化回归结果与一次真实匿名下载冒烟，以及需要用户环境手工验证的清单（spec §8 六项 + P1 遗留 QQ 登录复验）与已知边界。

## 1. 自动化验证结果（本 session）

### 1.1 单元/集成测试

- 全量：**20 个测试文件 / 106 个用例全部通过**（`npx vitest run`，11.55s）
- 覆盖模块：neteaseapi client/tracks/urls/lyric（18 用例）、neteaseAuth、app 装配（7 用例，含网易云 runner 分支）、tagger index/mp3/flac、downloader file/queue、ratelimit、auth、settings、fsUtils、renderer store，以及 P1 全部 QQ 侧用例回归
- 网易云侧重点用例：TrackDTO 映射（多歌手合并/vip=fee>0）、cloudsearch 解析、歌单「喜欢」置顶、匿名歌单 requiresLogin 判定、单曲日期北京时间锚（回归锚：退回 UTC 必挂）、直链 320 命中/降级链、歌词解码、account 登录态判定

### 1.2 类型检查

- `npm run typecheck`（vue-tsc --noEmit -p tsconfig.web.json && tsc --noEmit -p tsconfig.json）：**通过，零错误**

### 1.3 构建

- `npm run build`（electron-vite build）：**通过，三目标全部产出 out/**
  - `out/main/index.js` 50.32 kB（含网易云 neteaseapi 分支）
  - `out/preload/index.js` 0.46 kB
  - `out/renderer/`（index.html + assets/index-D8gpbwf2.css 11.82 kB + assets/index-m6FUvDxm.js 246.32 kB）

### 1.4 端到端冒烟（真实网络匿名，2026-09-02）

临时集成测试 `tests/__smoke__.test.ts`（跑完即删，不入库）：`createNeClient(fetch)` 真实客户端，走「搜索 → 直链 → 下载 → 标签 → 读回」全链路；请求纪律：搜索 1 次、直链 1 次、下载 1 次、歌词 1 次、封面 1 次，请求间间隔 ~2s，风控空响应冷却重试至多 1 次。

| 环节 | 结果 | 详情 |
|---|---|---|
| 搜索（cloudsearch/pc，真实） | ✅ 通过 | 「天空之城」命中 20 首。**首曲为 VIP（《天空之城 (Live)》蒋敦豪 / 中国新歌声 第1期，vip=true）——匿名不可下载**；同批搜索结果的免费歌中回退第一首《天空之城。》，不新增请求（选曲逻辑如实记录，见 §3 风险 2） |
| 直链（enhance/player/url br=320000，匿名） | ✅ **通过** | 拿到完整 CDN 直链；br=320 命中、`downgraded=false`（2026-09-04 调研「免费歌匿名 320k 实测可用」再次复证） |
| 歌词（song/lyric，匿名） | ✅ 通过 | 真实 LRC **25 行**，首行 `[00:02.770]飞机飞过天空 天空之城` |
| 封面（picUrl 直抓，匿名） | ✅ 通过 | image/jpeg 181,308 B（~177KB，魔数嗅探为 JPEG） |
| 下载（CDN 直链 → tmpdir，兜底 2s 单次超时） | ✅ 通过 | **8,962,133 bytes（~8.55MB）/ 0.6s**，远低于兜底超时；`.part` 原子落盘无残留 |
| 标签写入（tagFile → tagMp3：USLT/SYLT/APIC） | ✅ 通过 | title/artist/album 取 track 字段，lyrics 用真实 LRC，cover 内嵌 |
| 标签读回（music-metadata parseFile） | ✅ 通过 | `title` 与源一致（"天空之城。"）、`picture` 1 张、`lyrics` 1 条（USLT 文本）；断言全绿 |
| 清理 | ✅ | 临时目录递归删除，无产物残留（不入库） |

冒烟期间的一次失败为**临时脚手架自身缺陷**（非产品代码）：内联封面函数对 `res.arrayBuffer()` 读了两次致 `Body has already been read`，修复后通过；产品代码（app.ts / neteaseapi / tagger）零改动、零缺陷暴露。

> 说明：spec §8 手工项 4 的「未登录搜索免费歌 → 320k 正常」已被本冒烟自动化覆盖；其余手工项见第 2 节。

## 2. 手工验收清单（spec §8 六项 + P1 遗留复验）

以下各项需在用户真实环境（`npm run dev` 启动应用）执行；扫码登录与播放器实机项用户已明示不值守、本 session 不代验，全部标注「待用户环境验证」。

| # | 验收项 | 验证方法 | 结果 |
|---|---|---|---|
| 1 | 网易云真实扫码登录成功 + nickname 显示 + cookie 落盘 | 网易云 Tab 登录 → 开窗扫码确认 → `userDataDir/netease_cookie.json` 生成、昵称显示 | 待用户环境验证 |
| 2 | 「我喜欢的音乐」显示全量曲目 → 勾选 20 首批量下载 → 320k 全成 | 登录态打开歌单 Tab → 勾选 20 首入队 → 队列逐首完成、无废文件 | 待用户环境验证 |
| 3 | foobar2000/Musicolet 打开网易云产物：标签/封面/歌词规格与 QQ 侧一致 | 播放器打开产物：标题/歌手/专辑、封面面板、歌词面板（USLT/SYLT）均显示 | 待用户环境验证 |
| 4 | 未登录搜索免费歌 → 320k 正常；VIP 歌提示 | 匿名搜索入队免费歌下载播放正常；VIP 歌入队应有失败提示（匿名直链为空，已实证） | 部分自动化覆盖（免费歌 320k 链已验证）；「VIP 提示」UI 表现待用户环境验证 |
| 5 | 登录后尝试无损：有权益成功，无则降级提示 | 登录态入队 flac → 有权益则 flac 产物，无则自动降级 320 且队列出现降级提示（黄条） | 待用户环境验证 |
| 6 | 风控：连续 30 首队列下载稳定（1rps 限速生效） | 歌单 30 首连续入队 → 逐首成功、无空响应中断 | 待用户环境验证 |
| 7 | P1 遗留：QQ 扫码登录复验 | 修复（b6b4569 check_sig 重定向链跟跳 + f649af6 302 降 GET）后真实扫码 → `qqmusic_cookie.json` 落盘、登录态下载有效 | 待用户环境验证（P1 acceptance-m1-m5.md §2 项 3/4 延续） |

## 3. 已知边界与风险（衔接 P1）

1. **QQ 匿名下载已被服务端收紧（P1 实测，2026-09-02）**：`CgiGetVkey` 匿名返回空 purl，免费歌也需登录态。与网易云形成对比——本冒烟再次证明**网易云免费歌匿名 320k 可用**（2026-09-04 调研 + 2026-09-02 冒烟双证）。
2. **网易云匿名同样受服务端收紧风险**：本次冒烟搜索首曲即为 VIP 歌（此前 2026-09-03 调研首曲是免费钢琴版，结果随排名变化）——VIP 歌匿名直链为空响应已两次实证；免费歌档位通常最高 320k（flac 需权益）；调研实测连发 3-4 个请求即触发频控空响应（冷却 ~20-60s）。本实现已按纪律处理：1rps 全局限速、风控等确定性错误不自动重试；若某日服务端进一步收紧匿名路径，免费歌将同样需要登录态（与 P1 QQ 侧现状一致），届时降级为「全部走登录态」即可，数据层/队列无需改动。
3. **Creamplayer 参照点与差异**：本实现与 Creamplayer 同款明文老接口（cloudsearch/pc、enhance/player/url、song/lyric，无需 weapi/eapi 加密）；差异在于 Creamplayer 是半成品——cookie 抓取未真正参与请求（作者实际只活在匿名 320k 路径）、无重试、无频控、生产链路断裂；本实现补齐了登录接线、网络错误重试退避、1rps 限速、标签双格式（MP3 USLT+SYLT+APIC / FLAC PICTURE+LYRICS）、降级链与占位防撞。音乐服务端对两家的同一套收紧风险，见风险 1/2。
4. **网易云扫码登录为「开窗抓 cookie」薄实现**（`src/main/neteaseAuth.ts`，Electron session API，非主应用逻辑），真实性依赖用户扫码实测（清单项 1）；MUSIC_U 凭证落盘明文（与 P1 QQ 侧 `qqmusic_cookie.json` 同纪律，gitignore 排除）。
5. **无损（br=0）匿名边界未闭环**：调研实测匿名未拿到无损直链（可能需登录/可能频控，未二次确认）；`NE_LADDER` 逐档降级链（flac→320→128）已就位且有单测覆盖，登录权益下的无损行为待清单项 5 实测。

## 4. 存储与保密

- 本 session 冒烟产物全部落系统临时目录并在测试内删除，仓库无任何下载产物；真实请求仅 ~9 次（含一次修复重跑），未对服务端构成压力。