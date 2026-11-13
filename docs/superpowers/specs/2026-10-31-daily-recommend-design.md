# 0.8.0 日推设计（QQ 音乐 + 网易云）

日期：2026-10-31
状态：已实现，已通过真实网络冒烟与 UI mock 验证；真实窗口像素级验收待人工完成。

## 目标

在侧边栏两个音源下各增加一个「· 日推」入口，聚合官方/个性化每日推荐，支持：

- 总览卡片（封面、数量、每日更新标记）；
- 点进当天歌曲列表，勾选单下；
- 「下载全部」整批落到按日期命名的文件夹，曲目自动编号；
- 每次打开都取当天最新列表，不把昨天的日推当今天。

## 真实接口结论（2026-10-31 实号实测）

### QQ 音乐

| 入口 | 接口/ID | 实测 |
|---|---|---|
| 日推30首 | `music.recommend.RecommendFeed/get_recommend_feed` → `v_shelf[*].v_niche[*].v_card` 中 `subtype=510` → 动态 `disstid` → `music.srfDissInfo.DissInfo/CgiGetDiss` | 动态 ID 每日变化；卡片 `time`=上海时间，可用作当天校验；30 首 |
| 百万收藏 | 官方歌单 `disstid=211111` | 50 首，官方歌单，mtime 当日 |
| 新歌推荐 | 官方歌单 `disstid=211207` | 50 首，官方歌单，mtime 当日 |
| 红心雷达 | 官方歌单 `disstid=211143` | 50 首，官方歌单，描述写明每日自动更新 |

- `get_recommend_feed` 参数：`{ direction:0, page:1, v_cache:[], v_uniq:[], s_num:0 }`。
- 官方歌单封面从 `CgiGetDiss` 的 `data.dirinfo.picurl` 取，数量从 `dirinfo.songnum` 取。
- 未使用 `newsong.NewSongServer/get_new_song_info`（它返回 84 首最新歌曲，不是截图里的 50 首官方歌单）。

### 网易云

| 入口 | 接口/ID | 实测 |
|---|---|---|
| 日推30首 | `GET https://music.163.com/api/v1/discovery/recommend/songs` | `data.dailySongs` 今日 34 首（数量浮动，**不截断**），带推荐理由；需登录 |
| 风格推荐 | `GET https://music.163.com/api/homepage/category/daily/song/list` | `data.tags` 当前曲风（今日二次元），`data.dailySongs` 30 首；只读当前曲风 |
| 私人雷达 | 固定歌单 `3136952023`，走 `v6/playlist/detail` + `song/detail` 分页 | 35 首，今日标题「今天《别把夏天关掉》爱不释耳\|私人雷达」 |

- 风格切换需要 POST `/api/homepage/daily/song/tag/save`（写账号偏好），本版不做。
- 网易云日推接口没有可靠的“今日日期”字段；`history/recent` 只返回最近归档日期，不能当今日判据。

## 数据流

1. 渲染侧侧栏「· 日推」→ `openDaily(source)`。
2. 调 `qq:dailyCards` / `ne:dailyCards` 取总览卡片（标题、描述、封面、数量、更新时间、单卡错误）。
3. 点卡片 → `qq:dailyRec(mode)` / `ne:dailyRec(mode)`。
4. 主进程返回 `{ tracks, bundle, meta }`；渲染侧 `openSongsView({ cache:false, back:{kind:'daily'} })`。
5. 「下载全部」→ 现有 `dl:enqueue`，把 `bundle` 放进 `album` 字段；下载管线按 bundle 落目录 + NN 命名。

### 主进程文件

- `src/main/qqapi/recommend.ts`：日推卡片、每日30首动态 ID/日期校验、官方歌单。
- `src/main/neteaseapi/recommend.ts`：日推、风格推荐、私人雷达。
- `src/main/dailyRec.ts`：上海日期、目录名、playlist bundle 构造。
- `src/main/qqapi/playlists.ts`：`QqDissPage` 增加 `dirinfo`。

### 批处理 bundle

`AlbumBundle` 新增：

```ts
kind?: 'album' | 'playlist'
dirName?: string
```

- `kind='playlist'`：`albumDirName` 优先用 `dirName`；不写 `cover.jpg` / `album.cue`；不写 TRCK/TPOS；仍按 `NN 曲名.ext` 编号。
- 默认 `album` 行为完全不变（现有 0.7.0 用例全绿）。

## 目录命名

当前上海日期 `YYYY-MM-DD`，目录中显示为 `YY-MM-DD`：

| 入口 | 目录 |
|---|---|
| QQ 日推30首 | `Q音26-10-31日推30首` |
| QQ 百万收藏 | `Q音26-10-31百万收藏` |
| QQ 新歌推荐 | `Q音26-10-31新歌推荐` |
| QQ 红心雷达 | `Q音26-10-31红心雷达` |
| 网易云 日推30首 | `网易云26-10-31日推30首` |
| 网易云 风格推荐 | `网易云26-10-31风格推荐` |
| 网易云 私人雷达 | `网易云26-10-31私人雷达` |

- 同一天重复下载沿用 `uniquePath`：已存在文件变成 `01 曲名 (1).flac`，不覆盖。
- 勾选单下保持平铺（与专辑页「下载选中」一致）；只有「下载全部」进日推目录。
- **v0.8.1 修**：日推 `TrackDTO` 没有 `trackNo`，`runDownloadJob` 的 `trackNo ?? 1` 会把整批文件都命名成 `01`。现在 `enqueue` 对 `kind='playlist'` 的批次按入队顺序补 `trackNo=1..N`、`disc=1`；QQ/网易云各有一条落盘回归测试。

## 新鲜度

- 日推页 `cache:false`，不读不写 `songsCache`，每次进入都请求。
- QQ 每日30首：`subtype=510` 卡片 `time` → 上海日期，必须等于今天；否则报「今日日推尚未生成（服务端最后更新：…）」。
- 网易云日推：无日期字段；打开即拉，README/UI 标注每日 6:00 更新。
- `↻ 刷新` 复用现有 `songsReload`，强制重拉。

## UI

- 侧栏：两个音源登录后子项末尾各加 `· 日推`。
- 日推总览：卡片网格，每张卡有封面（用户要求每卡抓封面）、数量徽标、标题、描述、每日更新/更新时间；单卡错误只禁用该卡并显示原因。
- 歌曲页：复用现有歌曲页（返回、标题、数量、↻、下载全部、码率/歌词选择条、勾选、VIP 角标、底部下载选中）。
- 返回链：日推卡片 → 歌曲页 → 返回日推总览；其它入口会清空日推视图，避免总览残留挡住内容区。

## 非目标

- 不做网易云曲风切换（写账号偏好）。
- 不做日推历史归档。
- 不改专辑下载的既有行为（cue/cover/TRCK/TPOS）。
- 不新增依赖、不新增凭证。

## 测试

- 新增 `tests/dailyRec.test.ts`、`tests/qqapi-recommend.test.ts`、`tests/neteaseapi-recommend.test.ts`。
- `tests/albumBundle.test.ts` 增加 `dirName` 优先级。
- `tests/app.test.ts` 增加日推 IPC 装配与 playlist 落盘（固定目录、无 cover/cue/TRCK）。
- `tests/renderer-store.test.ts` 增加 playlist 回显文案与类型同集。
- 真实网络冒烟见 `docs/acceptance-daily-recommend.md`。
