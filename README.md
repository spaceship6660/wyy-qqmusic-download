# 音乐下载器（QQ 音乐 + 网易云）

一个对标 [Creamplayer](https://github.com/Beadd/Creamplayer) 的桌面音乐下载器（Electron + TypeScript 单语言实现）：搜索 / 歌单 / 登录后无损下载，自动内嵌封面与中日对照歌词，标签规格面向 **foobar2000** 与 **Musicolet**。

> 本项目从调研到实现全流程记录在 `docs/`（specs / plans / 验收 / 调研），详见文末「文档索引」。

## 功能

### 找歌：搜索

- **双平台音源**：QQ 音乐 + 网易云，歌曲 / 专辑双 tab，关键词搜索 + 单曲/歌单/专辑链接导入。
- **结果内联展示**：搜完直接铺在搜索页下方，歌曲/专辑 tab 常驻；切 tab 有关键词时自动按当前 tab 重搜，不用再按一次搜索。
- **专辑**：点卡片进专辑歌曲页，返回回到专辑列表（QQ 专辑封面为完整直链；网易云专辑内联展开）。

### 拿歌单：登录后左侧导航

- **QQ 音乐**：我喜欢的音乐（dirid=201）/ 自建歌单 / 收藏的歌单。扫码登录（ptlogin2）同时保存 EncryptUin（收藏歌单接口必需）；手动导入的 Cookie 没有它，收藏页会明确提示退出重扫。
- **网易云**：我喜欢的音乐（specialType=5 置顶）/ 自建 / 收藏，歌单卡片带封面。
- **退出登录**：左下两行登录态各带退出按钮，退出清对应缓存并收起导航。

### 下歌：质量与队列

- **质量档位**：无损（flac）/ APE / 320k / 128k / m4a（QQ）；拿不到自动降级，「我的下载」里黄条提示（进行中与已完成都显示）。
- **本批选项**：码率 + 歌词模式选择条在所有歌曲列表页顶部**吸顶显示**，翻多长都看得见；只影响当前批次，默认值在设置页改。
- **下载不跳页**：点「下载选中」后留在当前列表继续勾选，进度看底部工具栏「下载中 N」。
- **下载管线**：并发队列（可调 1-4）、下载侧 1 请求/秒限速、`.part` 原子写、同名占位防碰撞、直链过期自动重取一次。
- **失败可查**：全档拿不到直链时队列显示服务端原文因；vkey 失败现场（每档有无，不记密钥）写入本地诊断日志。

### 歌词与标签

- **中文译文自动合并**：网易云 `tlyric` + QQ（`trans:1` 参数）译文按**时间戳**配对，插到原文行下中日对照；作词/作曲头行不动，QQ 的 `//` 占位行与注音标签自动丢弃。源头没有译文的歌保持原文（QQ 译文覆盖本就少于网易云）。
- **歌词四档**：内嵌+另存 .lrc / 仅内嵌 / 仅另存 / 不保存。
- **播放器兼容**：封面必内嵌（MP3=APIC / FLAC=PICTURE）；MP3 写 ID3v2.3 USLT+SYLT 双帧，FLAC/OGG 写 Vorbis `LYRICS`+`UNSYNCEDLYRICS` 双键——foobar2000 装 ESLyric 等任意歌词组件即可显示，Musicolet 原生读取。

### 浏览体验：缓存

- **秒开**：我喜欢 / 歌单 / 专辑歌曲页 session 级内存缓存，切走再回零等待；翻页进度写穿进缓存。
- **后台追新（SWR）**：命中缓存先渲染旧数据，后台只拉首屏做 diff，有变化才原地替换（勾选交集保留），标题旁小字提示「正在检查更新… / 已是最新 / 已更新」；60 秒新鲜度窗口内零请求，无感且防风控。
- **手动刷新**：标题旁 `↻ 刷新` 按钮随时强制重拉；失败（风控/断网）静默保留旧缓存。
- **加载态**：切页瞬间同步占位 + 居中转圈遮罩 + 回到顶部；快速连点时慢响应自动丢弃，不会旧页面盖住新页面。

### 解密

- 导入 QQ 音乐加密文件（.mflac/.mflac0/.mgg/.mgg0/.mgg1/.qmc0）→ 还原原容器（flac/ogg/mp3）；文件名「歌手 - 歌名」搜索匹配后自动补封面/歌词/标签；musicex 等无密钥格式明确报错。

## 快速开始

```bash
# 开发运行（Electron 二进制下载需代理时加 HTTPS_PROXY）
npm install
npm run dev

# 打包 Windows 安装包（electron-builder，产出 dist/）
npm run dist

# 类型检查与测试
npm run typecheck
npx vitest run
```

**使用流程**

1. **QQ 音乐 / 网易云**：搜索框输入歌名/歌手（歌曲/专辑 tab 随时切，自动重搜）+ 粘贴单曲/歌单/专辑链接；结果勾选后点**窗口底部固定下载栏**「下载选中」，留在本页继续挑。
2. **歌单**（登录后左侧导航出现次级项）：我喜欢的音乐 / 自建歌单 / 收藏的歌单 → 歌单列表 → 点开 → 歌曲列表；超长歌单滚动到底自动续拉（1500+ 首也不会一次全拉）；标题旁 `↻` 可强制刷新。
3. **解密 Tab**：选文件或整个文件夹（自动过滤加密扩展名）→「解密并补全」→ 结果列表 ✓ 已补全 / ○ 仅解密 / ✗ 失败原因；输出目录在设置页可改。
4. **设置**：默认码率、并发数、下载目录、解密输出目录、歌词模式。

## 风控与已知限制（如实说明）

- **能播≠能下**：播放（流媒体）与下载是两套权益。部分同人/OST/数字单曲 App 里能播，但服务端全档不给下载直链——此时失败是正确的，队列会显示原因。
- **限速范围**：1 请求/秒限速目前只覆盖**下载管线**；浏览请求（搜索/歌单/翻页）不限速，靠 60 秒缓存新鲜度窗口压请求量。短时间内连点三四个不同歌单仍可能撞网易云频控（空响应，冷却 20~60 秒），等半分钟按 `↻` 重试即可；QQ 宽松得多。
- **QQ 匿名下载已被服务端收紧**：匿名 `CgiGetVkey` 返回空 purl，免费歌也要登录态。
- **网易云匿名**：普通歌 320k/128k 可下；个别版权歌匿名 404 需登录；无损需登录+账号权益，无权益自动降级。
- **QQ 译文覆盖**：少于网易云；源头没有译文的歌只写原文。已下载的旧文件不会自动补译文，删了重下即可（同名自动加后缀不覆盖）。
- node-id3 写 MP3 为 ID3v2.3 + UTF-16（foobar2000/Musicolet 均原生支持；个别古董设备可能不识别）。
- 解密：musicex（"cex\0" 结尾）与 STag 无内嵌密钥（密钥在 Mac/Android 的 MMKV），Windows 侧明确报错；OGG 等容器暂不补标签（只解密）。

## 技术栈与结构

- Electron 36 / electron-vite / Vue 3 + Pinia / TypeScript / Vitest / node-id3 / music-metadata（测试读回验证）
- 主进程（纯 Node）模块：`qqapi/`（QQ 接口）、`neteaseapi/`（网易云接口，参照 Creamplayer 端点）、`auth`/`neteaseAuth`（登录）、`downloader/`（队列/限速/文件）、`tagger/`（MP3/FLAC 标签）、`lyricMerge.ts`（中外文歌词时间戳配对合并）、`unlock/`（mflac/mgg 解密：TEA/密钥派生/密码器/文件解码器）、`app.ts`（依赖树 + IPC）
- 渲染器：`stores/`（含列表来源标记防串台下载）+ `components/`（搜索/网格/队列/登录/设置/网易云/解密 Tab）
- 测试：`tests/`（150 用例全绿：client/数据层/直链/登录/队列/标签/歌词合并/app 集成/renderer store/unlock 向量，全部 mock 或本地 server；真实网络仅手工验收）

## 文档索引（`docs/`）

- `superpowers/specs/2026-09-04-qqmusic-downloader-design.md` — QQ 下载器设计
- `superpowers/specs/2026-09-04-netease-module-design.md` — 网易云模块设计
- `superpowers/plans/2026-09-04-qqmusic-downloader.md` — M1-M5 实施计划
- `superpowers/plans/2026-09-04-netease-module.md` — 网易云实施计划
- `netease-download-research-2026-09-04.md` — 网易云接口调研（实测）
- `acceptance-m1-m5.md` / `acceptance-netease.md` — 验收记录（含手工清单与已知边界）
- `unlock-port-progress-2026-09-06.md` — 解密算法分析与移植进度（Go 参考 + 测试向量说明）

## 致谢（参考仓库）

本项目单语言重写，但协议与算法细节站在这些仓库肩膀上，按用途致谢：

| 参考 | 用途 |
|---|---|
| [Beadd/Creamplayer](https://github.com/Beadd/Creamplayer) | 对标产品；网易云明文老接口（cloudsearch / player/url / lyric）同款 |
| [showhwa/UnlockMusicProject_Archive](https://github.com/showhwa/UnlockMusicProject_Archive) | QQ 加密文件解密算法（TEA / 密钥派生 / mflac-mgg-qmc 密码器）逐字节移植 |
| [luren-dc/QQMusicApi](https://github.com/luren-dc/QQMusicApi) | QQ 登录态歌单接口（`modules/user.py`：自建 / 收藏 / 我喜欢） |
| [L-1124/QQMusicApi](https://github.com/L-1124/QQMusicApi) | QQ 扫码登录与歌词接口参考 |
| [jsososo/QQMusicApi](https://github.com/jsososo/QQMusicApi) | vkey 接口调研对照 |
| [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/qqmusic.py) | 文件名前缀反查质量档（F000/M800…） |
| [lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) | node-id3 标签内嵌管线参考 |
| [Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) | 网易云 weapi/eapi 与扫码登录调研对照 |
| [imsyy/SPlayer](https://github.com/imsyy/SPlayer) | QQ 歌词 `trans:1` + 完整参数取译文（避开 QRC 加密） |
| [Unlock Music 生态](https://git.unlock-music.dev/um/web) | 本地解密方案参考 |

## 隐私与合规

- 登录凭证（QQ/网易云 cookie）明文存于用户数据目录（`userData/qqmusic_cookie.json`、`netease_cookie.json`），仅本机使用，不入库、不打印、不上传。
- QQ 登录尝试与 vkey 失败现场写本地诊断日志（`userData/qq-login-diag.log`，只记 QQ 号、接口字段名与每档有无，不记密钥与直链），仅排障用；审计后可直接删除。
- 所有请求直连国内服务（绕过系统代理），Referer/UA 模拟浏览器；下载管线限速 1 请求/秒。
- **使用边界**：本工具仅供个人下载**已获授权的歌曲**（如已购买会员可下载的曲目、免费歌曲）与解密本人缓存文件备份；禁止绕过付费、传播与商业使用。完整声明见 [`DISCLAIMER.md`](./DISCLAIMER.md)，使用即视为同意。
