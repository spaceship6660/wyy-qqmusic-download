# 音乐下载器（QQ 音乐 + 网易云）

一个对标 [Creamplayer](https://github.com/Beadd/Creamplayer) 的桌面音乐下载器（Electron + TypeScript 单语言实现）：搜索 / 歌单 / 登录后无损下载，自动内嵌封面与歌词，标签规格面向 **foobar2000** 与 **Musicolet**。

> 本项目从调研到实现全流程记录在 `docs/`（specs / plans / 验收 / 调研），详见文末「文档索引」。

## 功能

| 能力 | 说明 |
|---|---|
| **双平台音源** | QQ 音乐（搜索 / 单曲 / 歌单 / 专辑链接）+ 网易云（搜索 / 登录后「我喜欢的音乐」与全部歌单） |
| **登录** | QQ：ptlogin2 扫码 + 手动 Cookie 导入；网易云：开窗扫码抓 Cookie + 手动导入。凭证明文落盘于用户数据目录（本地使用） |
| **质量档位** | 无损(flac/ape 按账号权益) / 320k / 128k / m4a(QQ)；**拿不到自动降级**并在队列黄条提示 |
| **标签内嵌** | 封面必内嵌（MP3=APIC / FLAC=PICTURE）；歌词四档：内嵌+另存 .lrc / 仅内嵌 / 仅另存 / 不保存 |
| **播放器兼容** | MP3 写 ID3v2.3 USLT+SYLT 双帧（node-id3）；FLAC/OGG 写 Vorbis `LYRICS`+`UNSYNCEDLYRICS` 双键——foobar2000 装 ESLyric 等任意歌词组件即可显示，Musicolet 原生读取 |
| **下载管线** | 并发队列（可调 1-4）、全局 1 请求/秒限速防风控、`.part` 原子写、同名任务占位防碰撞、直链过期自动重取 |
| **解密** | 计划中（M6 后续：mflac/mgg → flac/ogg + 自动补标签） |

## 快速开始

```bash
# 开发运行（Electron 二进制下载需代理时加 HTTPS_PROXY）
npm install
npm run dev

# 打包 Windows 安装包（electron-builder，产出 dist/）
npm run dist
```

**使用流程**
1. **下载 Tab**：搜索框输入歌名/歌手（或粘贴 QQ 单曲/歌单/专辑链接）→ 结果网格勾选 → 选码率 → 下载选中；队列面板实时进度/状态/失败原因/打开目录。
2. **网易云 Tab**：扫码登录（或粘贴 Cookie）→ 左侧歌单列表（「我喜欢的音乐」置顶）→ 点开 → 勾选批量下载；未登录也可搜索免费歌。
3. **设置**：默认码率、并发数、下载目录、歌词模式。

## 验证状态（2026-09-04）

- **自动化**：106 个单测/集成用例全绿（`npx vitest run`），类型检查与构建通过。
- **真实网络冒烟**：网易云匿名全链路一次通过（搜索 → 320k 直链 8.55MB → 下载 → 歌词 USLT + 封面 JPEG 内嵌读回一致）；QQ 歌词接口真实可用（47 行 LRC）。
- **待你环境验证**（详见 `docs/acceptance-*.md`）：
  - QQ 扫码登录（p_skey 重定向链缺陷已修复，需真实扫码复验）
  - 网易云扫码登录 + 歌单全量
  - 无损（会员权益）下载
  - foobar2000（ESLyric 组件）/ Musicolet 实机歌词与封面显示

## 已知限制（如实说明）

- **QQ 匿名下载已被服务端收紧**：2026-09-02 实测匿名 `CgiGetVkey` 返回空 purl，免费歌也要登录态；网易云匿名 320k 目前可用但受同样风险（服务端可能随时收紧）。
- QQ 搜索的 `DoSearchForQQMusicDesktop` 在部分环境返回空列表（经典 `client_search_cp` 端点正常）——如遇空结果请用单曲/歌单链接入口或登录态重试。
- node-id3 写 MP3 为 ID3v2.3 + UTF-16（foobar2000/Musicolet 均原生支持；个别古董设备可能不识别）。
- 网易云无损（br=0）与 VIP 歌需要登录+对应权益；无权益时自动降级 320k。

## 技术栈与结构

- Electron 36 / electron-vite / Vue 3 + Pinia / TypeScript / Vitest / node-id3 / music-metadata（测试读回验证）
- 主进程（纯 Node）模块：`qqapi/`（QQ 接口）、`neteaseapi/`（网易云接口，参照 Creamplayer 端点）、`auth`/`neteaseAuth`（登录）、`downloader/`（队列/限速/文件）、`tagger/`（MP3/FLAC 标签）、`app.ts`（依赖树 + IPC）
- 渲染器：`stores/` + `components/`（搜索/网格/队列/登录/设置/网易云 Tab）
- 测试：`tests/`（client/数据层/直链/登录/队列/标签/app 集成/renderer store，全部 mock 或本地 server；真实网络仅手工验收）

## 文档索引（`docs/`）

- `superpowers/specs/2026-09-04-qqmusic-downloader-design.md` — QQ 下载器设计
- `superpowers/specs/2026-09-04-netease-module-design.md` — 网易云模块设计
- `superpowers/plans/2026-09-04-qqmusic-downloader.md` — M1-M5 实施计划
- `superpowers/plans/2026-09-04-netease-module.md` — 网易云实施计划
- `netease-download-research-2026-09-04.md` — 网易云接口调研（实测）
- `acceptance-m1-m5.md` / `acceptance-netease.md` — 验收记录（含手工清单与已知边界）

## 隐私

- 登录凭证（QQ/网易云 cookie）明文存于用户数据目录（`userData/qqmusic_cookie.json`、`netease_cookie.json`），仅本机使用，不入库、不打印、不上传。
- 所有请求直连国内服务（绕过系统代理），Referer/UA 模拟浏览器以规避基本风控；全局限速 1 请求/秒。
- 本工具仅供个人下载**已获授权的歌曲**（如已购买会员可下载的曲目、免费歌曲）；请遵守平台服务条款与版权法规。