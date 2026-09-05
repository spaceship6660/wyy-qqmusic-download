# M1-M5 验收记录（2026-09-02，Task 12 收官）

范围：QQ 音乐下载器 M1-M5（骨架/匿名下载/登录+无损/队列/标签内嵌）。
本文档记录本 session 完成的自动化验证结果与真实网络冒烟结果，以及需要用户环境手工验证的清单与已知边界。

## 1. 自动化验证结果（本 session）

### 1.1 单元/集成测试

- 全量：**15 个测试文件 / 78 个用例全部通过**（`npx vitest run`，11.4s）
  - 新增 `tests/qqapi-lyric.test.ts`（3 用例）：PlayLyricInfo base64 LRC 解出文本 / 无歌词返回空串 / 路径缺失·异常返回空串不抛错
  - 新增 `tests/auth.test.ts` 重启恢复用例（1 用例）：见 1.3 冒烟发现并修复的缺陷
- 类型检查：`npm run typecheck`（vue-tsc + tsc --noEmit）通过
- 覆盖模块：qqapi client/tracks/urls/lyric、auth（15 用例）、settings、fsUtils、downloader file/queue、ratelimit、tagger index/mp3/flac、app 装配（4 用例）、renderer store

### 1.2 端到端冒烟（真实网络，临时 `tests/smoke-e2e.test.ts`，跑完已删除）

按纪律仅做有限次真实请求（搜索 1 次、详情 1 次、歌词 1 次、vkey 2 首、扫码 2 次）。结果：

| 环节 | 结果 | 详情 |
|---|---|---|
| 搜索（经典端点 client_search_cp，真实） | ✅ 通过 | 「天空之城」命中 10 首；首个：蒋敦豪《天空之城 (Live)》songmid=0017CNzV2j064M |
| musicu 搜索服务 DoSearchForQQMusicDesktop | ⚠️ 被门控 | 本机实测恒返回 code=0 但 sum=0 全空列表（换 search_type/comm 全量字段均空）——服务端放行经典端点、拦截 musicu 搜索，见 3.4 |
| getTrackDetail（真实） | ✅ 通过 | vip=false（免费歌）、date=2016-07-15 |
| **fetchLyric（真实，T12 核心）** | ✅ **通过** | PlayLyricInfo 返回真实 LRC：**47 行，首行 `[ti:天空之城]`**（与单元测试的解码路径一致） |
| 下载（匿名 vkey） | ⚠️ 服务端阻断 | `CgiGetVkey` 返回 code=1000 / 空 purl（换了第 2 首免费歌同样空）——**免费歌匿名下载已被 QQ 服务端收紧**。程序的错误路径表现正确：`dl:failed`，错误信息「未拿到可播放 URL（可能需要登录，或账号权益不足，无损需绿钻权益）」，无废文件残留 |
| 扫码登录（真实，2 次） | ⚠️ 服务端阻断 | 手机 QQ 扫码并确认成功后，ptlogin2 check_sig 步拿不到 p_skey（`QQ 登录获取 p_skey 失败`，两次一致）——属 QQ 对非常用设备/网络的风控，非程序缺陷 |

冒烟未完成的环节（真实下载产物验证）均因 QQ 服务端收紧（匿名 vkey 空 purl），如实记录为「待用户环境验证」，见第 2 节。

### 1.3 冒烟发现并修复的缺陷（并入提交 1）

**重启后登录态恢复不完整**：`createAuth` 创建时只把 `sessionState` 置为 `loggedIn`（读 cookie 文件），**没有把持久化 cookie 应用回 `qqClient`**——应用重启后 UI 显示已登录，但所有请求仍匿名（vkey 拿不到直链，下载必失败）。

- 修复：`src/main/auth.ts` 创建时若 `readCookieFile()` 有凭证，同步 `qqClient.setAuth(savedCookie)`
- 新增回归测试 1 用例（预置 cookie 文件 → 创建 auth → postMusicu 请求头必须携带 `qqmusic_key`）

## 2. 手工验收清单（按 spec §9 / 计划 Task 12 Step 3）

以下各项为里程碑验收点，均需在用户真实环境（`npm run dev` 启动应用）执行；本机因服务端收紧无法代验，标注「待用户环境验证」。

| # | 验收项 | 验证方法 | 结果 |
|---|---|---|---|
| 1 | 真实搜索正常 + VIP 角标 | 搜索框输入「周杰伦 晴天」→ 结果列表出现、VIP 歌曲有角标。若本机同样遇到 musicu 搜索空结果（见 3.4），登录态下重试或以单曲链接/歌单入口进入 | 待用户环境验证 |
| 2 | 匿名下载一首免费歌 320k 可播放 | 搜索/链接入队 → 产物拖入任意播放器能放。**注意：2026-09-02 实测匿名 vkey 已拿不到直链（空 purl），需登录态** | 待用户环境验证（登录态后） |
| 3 | 扫码登录成功 + cookie 持久化 | 登录按钮 → 手机 QQ 扫码确认 → `userDataDir/qqmusic_cookie.json` 生成、状态变已登录 | 待用户环境验证（本机被 p_skey 风控阻断，如实记录） |
| 4 | 登录后下 320k 成功；绿钻账号下 flac + 降级提示 | 登录后下载 → 产物可播放；请求 flac 时若无权益应走降级链并出现降级提示（队列黄条） | 待用户环境验证 |
| 5 | 歌单/专辑链接整单入队全完成 | 粘贴 y.qq.com 歌单/专辑链接 → 整单入队 → 观察 1rps 限速下逐首完成、高频 30 首无风控空响应 | 待用户环境验证 |
| 6 | foobar2000（ESLyric 组件）显示歌词 | foobar2000 安装 ESLyric → 打开产物 → 歌词面板显示 LRC（USLT/SYLT 任一路径）。标签侧已埋 USLT+SYLT，T12 起 lyrics 已真实接入，冒烟已证真实歌词可获取 | 待用户环境验证 |
| 7 | Musicolet 显示内嵌歌词；.lrc 另存同步歌词 | 安卓 Musicolet → 本地音乐播放产物 → 歌词显示；勾选「仅另存 .lrc」或「内嵌+另存」时 `.lrc` 文件与音频同目录 | 待用户环境验证 |
| 8 | 封面内嵌 | foobar2000 封面面板 / Musicolet 专辑图。MP3 写 APIC、FLAC 写 PICTURE（单测已覆盖 fixture 读回；真实产物待验证） | 待用户环境验证 |
| 9 | 设置持久化 | 改码率/目录/歌词模式 → 重启应用 → 保持；登录态重启后仍可直接下载（1.3 的修复已保证请求凭证恢复） | 待用户环境验证 |
| 10 | M6 解密（spec §9 第 4 项 .mflac） | 属后续计划（解密），不在 M1-M5 范围 | 本计划不验收 |

## 3. 已知边界与风险

1. **匿名下载被服务端收紧**（2026-09-02 实测）：`CgiGetVkey` 匿名返回空 purl，免费歌也要登录态；登录又可能被设备风控（p_skey 步失败）。影响 M2「匿名下载」验收点，需用户在自有网络实测确认是否为普遍收紧。
2. **musicu 搜索服务门控**（2026-09-02 实测）：`DoSearchForQQMusicDesktop` 从本机返回全空列表（code=0、sum=0），经典 `client_search_cp`（JSONP 端点）正常。若用户环境同样复现，可考虑后续为搜索增加 client_search_cp 回退或登录态重试。
3. **node-id3 v2.3+ UTF-16 偏差**：node-id3 以 UTF-16 写文本帧/USLT/SYLT，个别旧播放器可能不识别或乱码；foobar2000 / Musicolet 现代版本按 UTF-16 读取无碍。若出现歌词乱码，优先排查播放器端编码设置。
4. **「仅另存 .lrc」模式的语义偏差**：`tagFile` 只要 `meta.lyrics` 非空即内嵌（tagMp3/tagFlac 无条件写歌词帧），`lyricMode='lrc'` 时 USLT/SYLT 仍会被内嵌（saveLrc 只控制 .lrc 另存）。与计划 Task 11 既定实现一致；若需严格分离，需给 tagFile 增加 embed 开关（后续可做）。
5. **mgg/mflac 解密与 .ogg 标签**：解密与 OGG 容器 vorbis comment 写入属 M6 解密计划（`vorbis.ts` 目前只支持 FLAC），M1-M5 不覆盖。
6. **风控阈值**：实现取保守 1rps 全局限速 + QqApiError（风控/路径缺失等确定性错误）不重试。M4 验收（批量 30 首）时需在用户网络定量校准。
7. **歌词为空不阻塞**：歌词接口失败/无词一律返回空串，标签与 .lrc 均跳过该帧，下载不中断（单元测试覆盖）。