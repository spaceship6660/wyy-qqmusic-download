# 网易云音乐下载可行性调研

> 调研日期：2026-09-03（接口实测）～ 2026-09-04（成文）
> 范围：网易云 web 端免登录/登录下载「不付费也能听的歌」；对标 Creamplayer（网易云下载器）；对照 Spica 现有 QQ 音乐登录+下载实现；盘点 QQ 音乐同类项目。
> 参考源码本地位置：`F:\research\wyy-download\Creamplayer`（本仓库外层，Beadd/Creamplayer @ github）

---

## 0. TL;DR

- **可行**。网易云明文老接口（无 weapi/eapi 加密）今天（2026-09-03 实测）仍然有效：**免登录 + Referer 即可拿到免费歌（fee=0）320k MP3 完整直链**；歌词、封面、搜索全部免登录可用。
- **边界**：VIP 歌匿名拿不到直链（实测空响应）；无损（br=0）匿名未拿到。这两者需要登录态（社区共识：成员登录可拿 320k，无损需相应权益）。
- **Creamplayer 是现成的「网易云下载 + 封面/歌词自动内嵌」参考实现**，源码已本地化，Python 下载器仅 201 行，可直接借鉴或改造。
- **Spica 已实现 QQ 音乐完整登录闭环**（扫码 → cookie → VIP 直链）与 web 端解析下载——这套「工具+host 闭包+凭证落盘+惰性登录检测」模式可直接平移给网易云。
- **QQ 音乐侧无现成「下载即内嵌封面歌词」成品，但积木齐全**（yt-dlp extractor / L-1124/QQMusicApi / lx-music 内嵌管线）。

---

## 1. 背景与目标

原始诉求：Spica 已有「QQ 音乐 web 端下载」能力，能否活用到网易云——支持「登录/不登录」两种模式，下载「不用会员就可以听的歌」。

调研期间补充确认的事实（2026-09-04 代码核查）：

- Spica 的 QQ 音乐实现**不止是下载，还有完整的扫码登录闭环**（详见 §4）。
- Spica 的网易云集成**只有搜索/直链/下载（pyncm），没有任何登录入口**——这是与 QQ 侧最大的差距。

**结论先行**：能力可平移，且网易云侧比 QQ 更简单（不需要 sign、不需要加密参数）。

---

## 2. 网易云 web 接口现状（2026-09-03 实测）

### 2.1 实测结果

环境：本机匿名 curl（非登录态），UA `Mozilla/5.0`，Referer `https://music.163.com/`。

| 接口 | 匿名可用 | 说明 |
|---|---|---|
| `GET https://music.163.com/api/cloudsearch/pc?type=1&s=关键词&limit=10` | ✅ 200 | 搜索，返回含 fee / privilege.fl / 封面 picUrl |
| `GET .../api/song/enhance/player/url?ids=[{id}]&br=320000` | ✅ 免费歌拿到 320k 完整直链 | **本次调研关键实测**，见下 |
| 同接口，VIP 歌（fee=1） | ❌ | 响应为空（拿不到 url） |
| 同接口，br=0（无损请求） | ❌ | 匿名未拿到（可能需登录，也可能被频控，未二次确认） |
| `GET https://music.163.com/api/song/lyric?os=pc&id={id}&lv=-1&tv=1` | ✅ | 返回 lrc（含翻译字段 tlyric） |

**免费歌 320k 直链实测响应（节选）**：

```json
{"data":[{"id":103027,
  "url":"http://m10.music.126.net/20260903231445/c6bd1ea5a6184d11f85b5fca395f5d40/ymusic/5097/.../7746095....mp3?vuutv=...",
  "br":320000,"size":6529611,"md5":"7746095...","code":200,"expi":1200,"type":"mp3","fee":0}]}
```

直链为**临时 CDN 短链**（约 20 分钟有效，`expi=1200`），带一次性签名参数（vuutv），可直接 `requests.get` 落盘。

### 2.2 注意点（踩过的坑）

1. **Referer 是硬条件**：不带 `Referer: https://music.163.com/` 时该接口直接空响应（至少与风控联动，实测无 Referer 请求失败）。
2. **频控明显**：实测连发 3-4 个请求后后续全部空响应（包括免费歌），冷却 ~20-60s 后恢复。**成品必须限速/降频**（建议 ≥2s/请求 + 失败退避）。
3. 码率参数：`128000 / 192000 / 256000 / 320000 / 0`；大部分免费歌最高只有 320k（privilege.fl 决定）。
4. 该路径全是**明文老接口**：不需要 weapi/eapi 的 AES+RSA 加密参数，也不需要 sign——这也是 Creamplayer 能用 201 行 Python 跑通全链路的根本原因。

### 2.3 登录态的收益（未实测，社区共识）

- 成员（免费账号）登录后可解锁部分「仅登录」歌曲与更高码率；
- VIP 会员：320k（部分无损 flac）可下载；无损 flac/ape 需要相应会员权益；
- 登录方式建议（与 Spica QQ 侧同构）：**二维码扫码**（eapi/login/qrcode 系，Binaryify/NeteaseCloudMusicApi 有完整实现），cookie 关键字段 `MUSIC_U` / `MUSIC_A`。

---

## 3. Creamplayer 实现拆解（现成参考）

> 仓库：github.com/Beadd/Creamplayer（863★，2026-04 仍有活动；README 明言「后续支持 QQ 音乐」——至今未做）
> 本地源码：`F:\research\wyy-download\Creamplayer`（15MB，含 `resources/musicdownloader.py` + PyInstaller exe）

### 3.1 架构

```
Vue3 前端 (Nuxt 3 + Pinia)  ←─ vite dev proxy "/api" ─→ music.163.com（明文接口）
   │  搜索/歌单/详情/直链/歌词
   │  electron.invoke("download", 参数字符串)
   ▼
Electron 主进程 (main.cjs)
   │  exec() 调 resources/musicdownloader.exe
   │  stdout 正则 /successfully:(.*)/ 取结果 → decodeURIComponent 返回前端
   ▼
Python 下载器 (resources/musicdownloader.py, 201 行)
   → downloads/「标题 - 歌手」.mp3/flac → requests 拉音频+封面+歌词 → eyed3/mutagen 内嵌标签
```

### 3.2 关键链路

| 链路 | 实现 | 要点 |
|---|---|---|
| 取直链 | `utils/api.ts` → `.../api/song/enhance/player/url?ids=[id]&br=码率` | 无加密、无 sign；码率 128k~320k/0=无损 |
| 歌词 | `.../api/song/lyric?os=pc&id=..&lv=-1&tv=1` | 明文 JSON，取 `lrc.lyric` |
| 登录 | Electron 开隐藏窗加载 `music.163.com/login` → 用户扫码 → 抓 session cookie 字符串存 Pinia（persist）| **半成品：cookie 存了但前端请求没真正挂上**（main.cjs 有 `flag` 头→Cookie 钩子但前端未用）|
| 下载+内嵌 | `musicdownloader.py` | mp3=eyed3（APIC 封面 `images.set(3,..)` + USLT 歌词 `tag.lyrics.set(..)` + 标题/歌手/专辑/发行日期，`copyright` 字段存歌曲 ID）；flac=mutagen（`add_picture()` + LYRICS/date/YEAR）|
| 另存歌词 | `-sl` 参数 | 老式 MP3 设备读不了 USLT 时的兜底（README FAQ）|
| 落盘 | `downloads/` 相对目录 | 命名「标题 - 歌手」；重名加 `(n)`；非法字符替换；100 字符截断 |

### 3.3 半成品/坑（改造时避开）

- **生产模式 API 代理缺失**：`nuxt.config.ts` 的 `/api` proxy 只在 dev（vite server）生效；实际运行靠 `npm start`（NODE_ENV=development + nuxt dev server）——打包版链路是断的（README 自述 nuxt 重构计划中）。
- 「匿名下载非无损」开关、并发数设置**未真正接线**进下载参数（WIP）。
- cookie 未真正参与请求 → 作者实际大概率只活在「匿名 320k」路径。
- 单请求无重试、无频控节流（与网易云风控冲突，长列表下载会频繁失败）。

---

## 4. Spica 现状核查（2026-09-04）

> 全部路径相对 `E:\git\specia\Spica-Chatbot_Release`

### 4.1 QQ 音乐登录（已有，完整闭环）

- 入口：工具 `qqmusic_login`（shim `spica\adapters\tools\qqmusic_login.py`）→ host 闭包 `_qqmusic_login`（`spica\host\app_host.py:1137-1194`）→ 后台线程 `qr_login`（`agent_tools\function_tools\song\qqmusic.py:285-511`）。
- 扫码链路：`ssl.ptlogin2.qq.com/ptqrshow` 出码（appid=716027609）→ `ptqrlogin` 轮询（66 等待/67 已扫/0 成功）→ `check_sig` 换 `p_skey` → `oauth2.0/authorize` 换 code → `musicu.fcg`（`QQConnectLogin.LoginServer/QQLogin`）换 `musicid+musickey`。
- 凭证存储：**明文 JSON `data/qqmusic_cookie.json`**（gitignored），格式 `{"uin":"o<QQ号>","cookie":"uin=o..; qqmusic_uin=o..; qm_keyst=..; qqmusic_key=.."}`。无加密（设计文档确认用户接受）。
- 续期策略：**无自动刷新**。惰性检测——`get_audio_url` 拿到空 purl → 抛 `QqmusicLoginRequired` → 解析器标记 `qqmusic_login_required` → 主 LLM 主动询问用户 → 重新扫码。扫码超时 600s。
- 登录态用途：仅 `CgiGetVkey` 请求携带 Cookie 头（`_post_musicu` qqmusic.py:517-528），用于拿 VIP 歌直链。

### 4.2 QQ 音乐解析/下载（唱歌链路内，无独立下载工具）

- 入口：`sing_song` 工具（shim `spica\adapters\tools\sing_song.py`）→ host 闭包 `_request_song`（app_host.py:1196-1311）。
- 回退链（`song\sources.py:85-146`）：**① QQ 音乐（登录态）→ ② 网易云原唱 → ③ B 站原唱 → ④ 网易云翻唱**；QQ 无凭证/空 purl → 顺延下一源并置 login_required。
- 搜索：POST `u.y.qq.com/cgi-bin/musicu.fcg`，module `music.search.SearchCgiService/DoSearchForQQMusicDesktop`（qqmusic.py:115-140）。
- 直链：同端点，`vkey.GetVkeyServer/CgiGetVkey`（qqmusic.py:143-177）：`guid:"10000"`（固定值，**免 sign**）、`platform:"20"`；**免登录免费歌可下**（uin=0），VIP 歌必须登录态否则 purl 为空。
- 品质：`m4a(C400) / 128(M500) / 320(M800)` 默认 320，配置 `app.yaml → song.qqmusic.quality`。
- 落盘：`static/generated_song/cache/original/{songmid}.mp3`（pipeline.py:134-162），流式下载 `.part` 原子替换。
- HTTP：stdlib `urllib.request`，**显式绕过代理**（`ProxyHandler({})`，国内服务走梯子必失败）；UA Firefox/115；`Referer: https://y.qq.com/`。

### 4.3 网易云在 Spica 的现状（差距所在）

- 文件 `agent_tools\function_tools\song\netease.py`：搜索 `pyncm.cloudsearch.GetSearchResult`（40-56）、直链 `pyncm.apis.track.GetTrackAudio(song_id, bitrate)`（59-68）、下载与 qqmusic.py 逐行同构（71-96）。
- **无登录工具/无登录 UI**：仅 `get_audio_url` 时被动加载 `~/.pyncm` 会话文件（149-172）——登录需用户在外部自行完成（netease_cli 等）。
- 即：网易云在 Spica 里只有「匿名免费歌」这一档能力。

### 4.4 可平移的「模式」（Spica → 网易云）

1. **工具 + host 闭包 shim 双层**（零逻辑 shim + 逻辑在闭包）：复用 `qqmusic_login` 同构写 `netease_login`。
2. **明文凭证落盘 + gitignore**：`data/qqmusic_cookie.json` 同构 → `data/netease_cookie.json`。
3. **惰性登录检测 + LLM 引导**：空直链 → login_required 标志 → 主模型主动问「要重新扫码吗」。
4. **回退链**：网易云登录态缺失时顺延 B 站/其他，歌不卡住。
5. **单例解析器组装**：`build_song_resolver_from_config` 按配置装配源。

---

## 5. QQ 音乐同类项目盘点（对标「下载自动封面+歌词」）

**结论：没有现成「QQ 版 Creamplayer」成品；积木全齐。**

| 项目 | 星数/状态 | 能力 | 封面+歌词 |
|---|---|---|---|
| **lyswhut/lx-music-desktop** | 53k★ / 活跃 | 聚合播放器+下载；音源支持 QQ | **最完整**：node-id3 内嵌 APIC+USLT（`src/common/utils/musicMeta/`），可拆 |
| **yt-dlp qqmusic extractor** | yt-dlp 内置 / 持续维护 | 免登录免费歌直链（musicu.fcg CgiGetVkey，免 sign 仍通）；VIP 无 cookie 报 login required；格式 flac/ape/320/128/m4a | 单独 `.lrc` + 封面文件；`--embed-metadata`（ffmpeg）可内嵌封面但**不能内嵌 USLT 歌词** |
| **L-1124/QQMusicApi** | 466★ / 2026-08 仍更新（Python）| 免登录搜索/直链、QR/手机号登录、**zzc_sign**、歌词含翻译 | 接口层，不内嵌 |
| jsososo/QQMusicApi | 1.6k★ / 2024-06 停更 | 文档最全；老 `/vkey` 已废弃 | 接口层 |
| musicdl | 6k★ / 活跃 | Python 批量下载，QQ 直链走第三方 vkeys 服务 | 歌词 .lrc；封面**不内嵌** |
| unlock-music 系 + luyikk/qqmusic_decrypt | — / 活跃 | **QQ 客户端加密文件**（mflac/mgg/qmc）解锁为明文 | 解锁后补标签是成熟组合 |
| jitwxs/163MusicLyrics、ZonyLrcToolsX | 4k/1.8k★ | 网易+QQ 批量歌词 .lrc | 纯歌词工具 |

**内嵌层结论**：ffmpeg 写不了 USLT 歌词帧 → 必须 tag 库。JS 侧 node-id3（lx-music 完整写法可抄）；Python 侧 eyed3/mutagen（Creamplayer 写法同构，直接照搬）。

**QQ web 接口要点**：`u.y.qq.com/cgi-bin/musicu.fcg`（CgiGetVkey 免 sign 现仍通，Spica 与 yt-dlp 双证）；绿钻 cookie 可拿会员歌 320k，无损需对应权益；qmc 加密只在客户端下载产物，web 播放流是明文。

---

## 6. 结论与路线建议

### 6.1 回答最初问题

**Spica 的 QQ 音乐 web 下载能力可以活用到网易云，而且网易云侧更简单**：

- 网易云无需 sign/加密（Creamplayer + 本次实测双证），匿名+Referer 即拿免费歌 320k 直链；
- Spica 侧唯一缺口是「网易云登录」（VIP/无损/登录解锁歌曲），补齐方式与 QQ 登录完全同构（扫码头像模式平移）。

### 6.2 三条路线

| 路线 | 内容 | 优点 | 缺点 |
|---|---|---|---|
| **A. Spica 内扩展** | 新增 `netease_login` 工具（扫码→`data/netease_cookie.json`）+ netease 直链层补 cookie 头 + 回退链微调 | 复用面最大（shim/闭包/存储/引导全现成）；用户可对话式点歌下载 | 网易云登录实现（eapi 扫码）要做一遍；唱歌链路外无独立下载工具 |
| **B. 独立小工具** | 照 Creamplayer 模式做一个（Electron 或纯 CLI），Python 下载器直接改 | 不碰 Spica；封面/歌词内嵌天然支持；可顺带支持 QQ（yt-dlp/L-1124 积木） | 新工程；登录/UI 工作量 |
| **C. 混合（推荐起点）** | 先做**独立 CLI/脚本**（B 的下载器内核 + A 的扫码登录模式），跑通后视需要集成 Spica | 验证成本最低；脚本即 Creamplayer 的 musicdownloader.py 扩展 | 两步走 |

**推荐**：C —— 最快拿到「免登录免费歌 320k + 封面/歌词内嵌」的最小可用物；登录补 VIP 是增量。

### 6.3 待验证事项

1. 登录态（扫码）下 VIP 歌 320k / 无损 flac 的实测边界（本次未测）。
2. 网易云匿名接口的频控阈值（实测连发 3-4 个即空响应，需定量）。
3. 无损（br=0）匿名拿不到是「需登录」还是「频控」——用登录态复测。
4. 多线程下载是否加剧风控（Creamplayer 的并发设置未接线，存疑）。

### 6.4 开发注意事项（纪律）

- 凭证文件 gitignore（Spica 仓库公开，沿用 `data/qqmusic_cookie.json` 先例）。
- 新增 LLM 调用点/落盘数据时同步 `docs/PRIVACY.md`（Spica 项目约定）。
- 实施后 CHANGELOG + 三处文档一致（Spica 项目约定）。

---

## 附录 A：实测命令记录（2026-09-03）

```bash
# 搜索（匿名）
curl -s -A "Mozilla/5.0" -H "Referer: https://music.163.com/" \
  "https://music.163.com/api/cloudsearch/pc?type=1&s=%E5%A4%A9%E7%A9%BA%E4%B9%8B%E5%9F%8E&limit=10"
# → 200 / 15795B / fee=0(免费) 与 fee=1(VIP) 混排，privilege.fl 给最高码率

# 直链（匿名+Referer，免费歌 id=103027）
curl -s -A "Mozilla/5.0" -H "Referer: https://music.163.com/" \
  "https://music.163.com/api/song/enhance/player/url?ids=[103027]&br=320000"
# → 200 / data[0].url = http://m10.music.126.net/...mp3?vuutv=... / br=320000 / size=6529611 / code=200

# 同接口 VIP 歌（id=421423022，fee=1）：→ 空响应
# 同接口 br=0 无损（id=103027）：→ 空响应（未二次确认）

# 歌词（匿名，id=103027）
curl -s -A "Mozilla/5.0" -H "Referer: https://music.163.com/" \
  "https://music.163.com/api/song/lyric?os=pc&id=103027&lv=-1&tv=1"
# → 200 / lrc.lyric 有内容

# 频控观察：连续 4 个请求后全部空响应；冷却 ~20-60s 恢复
```

## 附录 B：参考链接

- Creamplayer：https://github.com/Beadd/Creamplayer
- yt-dlp qqmusic extractor：https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/qqmusic.py
- L-1124/QQMusicApi（zzc_sign / QR 登录 / 歌词）：https://github.com/L-1124/QQMusicApi
- jsososo/QQMusicApi（含 /vkey 废弃说明）：https://github.com/jsososo/QQMusicApi
- lx-music-desktop（node-id3 内嵌管线）：https://github.com/lyswhut/lx-music-desktop
- unlock-music（迁移后官方站）：https://git.unlock-music.dev/um/web 、https://git.unlock-music.dev/um/cli
- Binaryify/NeteaseCloudMusicApi（网易云 weapi/eapi + QR 登录参考）：https://github.com/Binaryify/NeteaseCloudMusicApi

## 附录 C：Spica 关键文件索引（E:\git\specia\Spica-Chatbot_Release）

| 文件 | 内容 |
|---|---|
| `agent_tools\function_tools\song\qqmusic.py` | QQ 全部逻辑：搜索 115-140、直链 143-177（CgiGetVkey）、下载 180-208、登录持久化 222-266、扫码 285-511 |
| `agent_tools\function_tools\song\netease.py` | 网易云：pyncm 搜索/直链 40-68、下载 71-96、会话加载 149-172（无登录） |
| `agent_tools\function_tools\song\sources.py` | 回退链 85-146、resolver 装配 181-405 |
| `agent_tools\function_tools\song\pipeline.py` | QQ 下载分支 134-162、落盘 469-470 |
| `spica\adapters\tools\sing_song.py` / `qqmusic_login.py` | 工具 shim |
| `spica\host\app_host.py` | 注册 262-283、登录闭包 1137-1194、点歌闭包 1196-1311 |
| `data\config\app.yaml` | `song.qqmusic.{enabled,quality}` 281-282 |
| `docs\交接-QQ音乐源接入-2026-08-14.md` | QQ 接口实测证据 |
| `docs\superpowers\specs\2026-08-14-qqmusic-login-renew-design.md` | QQ 登录续期设计 |