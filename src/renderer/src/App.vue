<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import SearchBar from './components/SearchBar.vue'
import TrackGrid from './components/TrackGrid.vue'
import LoginButton from './components/LoginButton.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import NeteaseTab from './components/NeteaseTab.vue'
import DecryptTab from './components/DecryptTab.vue'
import DownloadPage from './components/DownloadPage.vue'
import DownloadOptions from './components/DownloadOptions.vue'
import { useDownloadStore } from './stores/download'
import type { UiTrack } from './stores/download'
import { api } from './api'

// 界面模型（2026-09-06 用户定稿）：左侧两级导航。
// 顶级 = 功能页（QQ音乐=搜索-下载体系 / 网易云 / 我的下载 / 解密 / 设置）；
// 次级（登录后） = 我喜欢的音乐 / 自建歌单 / 收藏的歌单——点击后内容区只显示对应内容。
// 当前歌曲列表统一在 store.tracks（单选列表模型），下载按钮 source 由视图上下文决定。
type Tab = 'qq' | 'netease' | 'download' | 'decrypt' | 'settings'
interface QqPlaylist { id: string; name: string; cover: string; trackCount: number }
interface NePlaylist { id: number; name: string; liked: boolean; subscribed?: boolean; creatorUid?: number; trackCount: number; cover: string }

const tab = ref<Tab>('qq')
const store = useDownloadStore()
const q = ref('')
const queueing = ref(false)

// 歌单数据（登录后加载）
const qqCreated = ref<QqPlaylist[]>([])
const qqFav = ref<QqPlaylist[]>([])
const nePlaylists = ref<NePlaylist[]>([])

// 视图：groupView=歌单列表页；songsView=歌曲列表页（含懒加载游标）；albumsView=专辑列表页
type LoadCursor =
  | { kind: 'qq-diss'; disstid?: number; dirid?: number; begin: number }
  | { kind: 'ne-playlist'; id: string; offset: number }
/** 歌曲页返回目的地：专辑列表 / 歌单列表；空=回顶级功能页 */
type SongsBack =
  | { kind: 'albums'; query: string }
  | { kind: 'group'; source: 'qq' | 'netease'; group: 'created' | 'fav' }
const groupView = ref<{ source: 'qq' | 'netease'; group: 'created' | 'fav' } | null>(null)
const songsView = ref<{ title: string; source: 'qq' | 'netease'; total?: number; cursor?: LoadCursor; cacheKey?: string } | null>(null)
const albumsView = ref<{ source: 'qq' | 'netease'; query: string; albums: Array<{ mid: string; name: string; singer: string; cover: string; songCount: number }> } | null>(null)
const listNotice = ref('')
// QQ 搜索页：歌曲 | 专辑
const searchTab = ref<'song' | 'album'>('song')
const loadingMore = ref(false)
const listLoading = ref(false)

// 底栏：当前列表的下载 source + 选中数
const ctxSource = computed<'qq' | 'netease'>(() => songsView.value?.source ?? (tab.value === 'netease' ? 'netease' : 'qq'))
const selectedCount = computed(() => store.selectedIds.size)
const activeCount = computed(() => store.queue.filter((j) => j.state === 'queued' || j.state === 'running').length)
const doneCount = computed(() => store.queue.filter((j) => j.state === 'done' || j.state === 'failed').length)
const neUid = ref(0)
const neNickname = ref('')
/** QQ 登录是否带 EncryptUin（收藏歌单接口必需；手动导入 Cookie 没有） */
const qqHasEncUin = ref(false)
/** QQ 凭证来源（qr/import）：区分“扫码仍无”与“手动导入本就没有” */
const qqLoginMethod = ref('')
/** 主进程诊断日志路径（扫码仍无 EncryptUin 时上报用） */
const diagLogPath = ref('')
const contentEl = ref<HTMLElement | null>(null)
/** 列表请求序号：快速连点侧栏时，慢响应的过期结果直接丢弃（否则旧歌单覆盖新视图，看起来“切不过去”） */
let loadSeq = 0

/** 歌曲列表内存缓存（session 级）：切走再回来秒开，不再转圈。
 * SWR 策略：命中先同步渲染旧数据，后台 revalidate 首屏、有 diff 才更新；
 * entry.fetchedAt + FRESH_MS 控制新鲜度（窗口内零请求，防风控）；
 * loadMore 写穿更新 tracks/total/cursor（不动 firstIds/fetchedAt）；
 * 退出登录清对应源；上限 30（LRU）。 */
interface SongsCacheEntry {
  tracks: UiTrack[]
  total?: number
  cursor?: LoadCursor
  source: 'qq' | 'netease'
  /** 首屏 ids 快照（后台 diff 用） */
  firstIds: string[]
  fetchedAt: number
}
/** 后台 revalidate 新鲜度窗口：窗口内命中缓存零请求（浏览请求无全局限速，靠此压请求量） */
const SONGS_FRESH_MS = 60_000
const songsCache = new Map<string, SongsCacheEntry>()
const SONGS_CACHE_MAX = 30
/** 正在后台 revalidate 的 key（同 key 不重复发） */
const revalidating = new Set<string>()
/** 后台更新状态行（仅当前页是该 key 时显示） */
const revalState = ref<{ key: string; text: string } | null>(null)
let revalTimer: ReturnType<typeof setTimeout> | null = null
function showRevalState(key: string, text: string, autoClearMs = 3000): void {
  if (songsView.value?.cacheKey !== key) return
  revalState.value = { key, text }
  if (revalTimer) clearTimeout(revalTimer)
  revalTimer = setTimeout(() => {
    if (revalState.value?.key === key) revalState.value = null
  }, autoClearMs)
}
function cacheSongs(key: string, e: SongsCacheEntry): void {
  songsCache.delete(key)
  songsCache.set(key, e)
  while (songsCache.size > SONGS_CACHE_MAX) {
    const oldest = songsCache.keys().next()
    if (oldest.done) break
    songsCache.delete(oldest.value)
  }
}
function clearSongsCache(source?: 'qq' | 'netease'): void {
  if (!source) {
    songsCache.clear()
    albumSearchCache.clear()
    return
  }
  for (const k of [...songsCache.keys()]) if (k.startsWith(`${source}:`)) songsCache.delete(k)
  if (source === 'qq') albumSearchCache.clear()
}
/** QQ 专辑搜索结果缓存（返回上一级 + tab 来回切不再重搜） */
const albumSearchCache = new Map<string, { query: string; albums: Array<{ mid: string; name: string; singer: string; cover: string; songCount: number }> }>()
/** 当前歌曲页的强制重跑闭包（↻ 刷新按钮用：删缓存后按原参数重拉，返回链保持） */
let songsReload: (() => Promise<void>) | null = null
/** 歌曲页返回目的地（专辑列表 / 歌单列表；空则回顶级功能页） */
const songsBack = ref<SongsBack | null>(null)

function scrollTop(): void {
  const el = contentEl.value
  if (!el) return
  try {
    el.scrollTo({ top: 0 })
  } catch {
    el.scrollTop = 0
  }
}

/** 进入歌曲列表加载态（同步占位，2026-09-06 修复“切到我喜欢的没反应”）：
 * 此前先清 groupView 再 await，中间态 groupView/songsView 双空（或残留旧 songsView），
 * 模板掉回 QQ 搜索页并展示 stale 的 store.tracks，且唯一的“加载中”小字在列表顶部，
 * 从歌单页（滚动条在底部）切过去时根本看不见——像没切换成功。
 * 现在同步占位 songsView + 清空旧列表 + 回到顶部，模板全程停留在歌曲页并显示转圈遮罩。
 * 返回本次请求序号，异步落定后凭序号丢弃过期响应。 */
function enterSongsLoading(title: string, source: 'qq' | 'netease', opts?: { keepAlbums?: boolean }): number {
  loadSeq++
  groupView.value = null
  if (!opts?.keepAlbums) albumsView.value = null
  listNotice.value = ''
  songsBack.value = null
  songsReload = null
  store.setTracks([], source)
  songsView.value = { title, source }
  listLoading.value = true
  scrollTop()
  return loadSeq
}

/** 首屏抓取结果（各源 opener 组装；tracks 为空→走 emptyNotice） */
interface FirstPageResult { tracks: UiTrack[]; total?: number; cursor?: LoadCursor }

/** 歌曲列表统一入口：缓存秒开 + 后台 revalidate（SWR），force=跳过缓存走网络。
 * back=返回目的地；keepAlbums=保留专辑列表（专辑歌曲页返回用）。 */
async function openSongsView(opts: {
  key: string
  title: string
  source: 'qq' | 'netease'
  back: SongsBack | null
  keepAlbums?: boolean
  emptyNotice: string
  fetchFirst: () => Promise<FirstPageResult | null>
  reload: () => Promise<void>
  force?: boolean
}): Promise<void> {
  const { key, title, source, back } = opts
  songsReload = opts.reload
  const hit = opts.force ? undefined : songsCache.get(key)
  if (hit && hit.source === source) {
    // 秒开：同步渲染旧数据，网络在后台静默追新（有 diff 才更新，无感）
    groupView.value = null
    listNotice.value = ''
    store.setTracks([...hit.tracks], hit.source)
    songsView.value = { title, source, total: hit.total, cursor: hit.cursor, cacheKey: key }
    songsBack.value = back
    listLoading.value = false
    scrollTop()
    void revalidateSongs(key, opts)
    return
  }
  const my = enterSongsLoading(title, source, { keepAlbums: opts.keepAlbums })
  songsReload = opts.reload
  try {
    const fp = await opts.fetchFirst()
    if (my !== loadSeq) return
    if (!fp || fp.tracks.length === 0) {
      listNotice.value = opts.emptyNotice
      return
    }
    store.setTracks(fp.tracks, source)
    cacheSongs(key, {
      tracks: [...fp.tracks], total: fp.total, cursor: fp.cursor, source,
      firstIds: fp.tracks.map((t) => t.id), fetchedAt: Date.now(),
    })
    songsView.value = { title, source, total: fp.total, cursor: fp.cursor, cacheKey: key }
    songsBack.value = back
  } catch (e) {
    if (my === loadSeq) listNotice.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (my === loadSeq) listLoading.value = false
  }
}

/** 后台 revalidate：只拉首屏做 diff，有变化才原地更新；失败（风控空响应/断网）一律静默，保留缓存。 */
async function revalidateSongs(key: string, opts: {
  source: 'qq' | 'netease'
  fetchFirst: () => Promise<FirstPageResult | null>
}): Promise<void> {
  const entry = songsCache.get(key)
  if (!entry || entry.source !== opts.source) return
  if (Date.now() - entry.fetchedAt < SONGS_FRESH_MS) return // 新鲜：零请求
  if (revalidating.has(key)) return
  revalidating.add(key)
  const my = loadSeq
  if (songsView.value?.cacheKey === key) showRevalState(key, '正在检查更新…', 8000)
  try {
    const fp = await opts.fetchFirst()
    if (my !== loadSeq || !fp || fp.tracks.length === 0) return // 用户切走/失败/空：静默保留旧缓存
    if (songsView.value?.cacheKey !== key) {
      entry.fetchedAt = Date.now() // 用户已看别处：只顺手记个时间，不碰视图
      return
    }
    const freshIds = fp.tracks.map((t) => t.id)
    const sameTotal = (fp.total ?? entry.total) === entry.total
    const sameIds = freshIds.length === entry.firstIds.length && freshIds.every((id, i) => id === entry.firstIds[i])
    if (sameIds && sameTotal) {
      entry.fetchedAt = Date.now()
      showRevalState(key, '已是最新')
      return
    }
    // 有 diff：原地替换首屏（选中交集保留），翻页游标按新首屏重置
    const keep = new Set(freshIds)
    const sel = [...store.selectedIds].filter((id) => keep.has(id))
    store.setTracks(fp.tracks, opts.source)
    store.selectedIds = new Set(sel)
    songsCache.set(key, {
      tracks: [...fp.tracks], total: fp.total, cursor: fp.cursor, source: opts.source,
      firstIds: freshIds, fetchedAt: Date.now(),
    })
    songsView.value = { ...songsView.value, total: fp.total, cursor: fp.cursor }
    showRevalState(key, `已更新（共 ${fp.total ?? fp.tracks.length} 首）`)
  } catch {
    // 静默：风控/断网都不打扰用户，下次进入再试
  } finally {
    revalidating.delete(key)
  }
}

// ---------- 顶级页切换 ----------
function goTab(t: Tab): void {
  tab.value = t
  groupView.value = null
  songsView.value = null
  albumsView.value = null
  listNotice.value = ''
  songsBack.value = null
  songsReload = null
}

/** 歌曲页返回：专辑歌曲→专辑列表；歌单歌曲→歌单列表；其余→顶级功能页 */
function goBack(): void {
  const back = songsBack.value
  const src = songsView.value?.source ?? 'qq'
  if (back?.kind === 'albums') {
    const hit = albumSearchCache.get(back.query)
    if (hit) {
      songsView.value = null
      albumsView.value = { source: 'qq', query: hit.query, albums: hit.albums }
      listNotice.value = ''
      songsBack.value = null
      songsReload = null
      scrollTop()
      return
    }
  } else if (back?.kind === 'group') {
    songsView.value = null
    groupView.value = { source: back.source, group: back.group }
    listNotice.value = ''
    songsBack.value = null
    songsReload = null
    scrollTop()
    return
  }
  goTab(src === 'qq' ? 'qq' : 'netease')
}

/** 当前歌曲页强制刷新（↻ 按钮）：删缓存按原参数重拉 */
function reloadSongs(): void {
  if (songsReload && !listLoading.value && !loadingMore.value) void songsReload()
}

// ---------- QQ 搜索 ----------
/** QQ 歌曲搜索结果缓存：tab 来回切换不再重复请求；搜索按钮/回车强制刷新 */
const songSearchCache = new Map<string, UiTrack[]>()
function cacheSongSearch(text: string, tracks: UiTrack[]): void {
  songSearchCache.delete(text)
  songSearchCache.set(text, tracks)
  while (songSearchCache.size > SONGS_CACHE_MAX) {
    const oldest = songSearchCache.keys().next()
    if (oldest.done) break
    songSearchCache.delete(oldest.value)
  }
}
async function doSearch(force = true): Promise<void> {
  const text = q.value.trim()
  if (!text) return
  try {
    if (/y\.qq\.com\/n\/ryqq\/(songDetail|playlist|albumDetail)/.test(text)) {
      const res: any = await api.invoke('qq:linkTracks', text)
      if (res?.tracks?.length) {
        store.setTracks(res.tracks, 'qq')
        songsView.value = { title: '链接导入', source: 'qq' }
      } else window.alert('未能解析该链接，请确认是 QQ 音乐歌单 / 专辑 / 单曲链接')
      return
    }
    if (!force) {
      const hit = songSearchCache.get(text)
      if (hit) {
        store.setTracks([...hit], 'qq')
        groupView.value = null
        songsView.value = null
        albumsView.value = null
        listNotice.value = ''
        scrollTop()
        return
      }
    }
    const tracks: any = await api.invoke('qq:search', text)
    if (!Array.isArray(tracks)) window.alert('搜索失败，请稍后重试')
    else {
      // 内联展示：结果直接铺在搜索页下方，歌曲/专辑 tab 常驻可随时切换（不再跳 songsView）
      cacheSongSearch(text, [...tracks])
      store.setTracks(tracks, 'qq')
      groupView.value = null
      songsView.value = null
      albumsView.value = null
      scrollTop()
    }
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e))
  }
}

/** 专辑搜索（歌曲 | 专辑 tab 切换后的入口；结果缓存，返回/切 tab 不再重搜） */
async function albumSearch(): Promise<void> {
  const text = q.value.trim()
  if (!text) return
  groupView.value = null
  songsView.value = null
  songsBack.value = null
  songsReload = null
  listNotice.value = ''
  const hit = albumSearchCache.get(text)
  if (hit) {
    albumsView.value = { source: 'qq', query: hit.query, albums: hit.albums }
    return
  }
  albumsView.value = null
  listLoading.value = true
  try {
    const albums: any = await api.invoke('qq:albumSearch', text)
    if (!Array.isArray(albums)) {
      listNotice.value = '专辑搜索失败'
      return
    }
    albumSearchCache.set(text, { query: text, albums })
    albumsView.value = { source: 'qq', query: text, albums }
  } catch (e) {
    listNotice.value = e instanceof Error ? e.message : String(e)
  } finally {
    listLoading.value = false
  }
}

/** 搜索页歌曲 | 专辑 tab 切换：有关键词时自动按当前 tab 重搜（切过去即出结果，不用再按一次搜索） */
function switchSearchTab(t: 'song' | 'album'): void {
  searchTab.value = t
  if (!q.value.trim() || listLoading.value) return
  if (t === 'song') void doSearch(false)
  else void albumSearch()
}

/** 点开专辑 → 专辑歌曲列表（QQ：fetchAlbum；网易云：api/v1/album；缓存秒开 + 后台 diff 更新） */
async function openAlbum(mid: string | number, title: string, force = false): Promise<void> {
  const source = albumsView.value?.source ?? songsView.value?.source ?? 'qq'
  const key = `${source}:album:${String(mid)}`
  const fromQuery = albumsView.value?.query ?? ''
  const back: SongsBack | null = fromQuery ? { kind: 'albums', query: fromQuery } : null
  // albumsView 留存：返回按钮要回到专辑列表（enterSongsLoading 默认会清，用 keepAlbums 保留）
  await openSongsView({
    key,
    title: `专辑 · ${title}`,
    source,
    back,
    keepAlbums: true,
    force,
    emptyNotice: '专辑为空或加载失败',
    fetchFirst: async () => {
      const tracks: any =
        source === 'qq' ? await api.invoke('qq:albumSongs', mid) : await api.invoke('ne:albumSongs', Number(mid))
      if (!Array.isArray(tracks) || tracks.length === 0) return null
      return { tracks, total: tracks.length }
    },
    reload: () => openAlbum(mid, title, true),
  })
}

/** 歌单/喜欢懒加载：翻到哪加载到哪（QQ：CgiGetDiss 分页；网易云：trackIds → song/detail 分批） */
async function loadMoreSongs(): Promise<void> {
  const v = songsView.value
  if (!v?.cursor || loadingMore.value) return
  const startedKey = v.cacheKey
  loadingMore.value = true
  // 去重：切走又秒回（缓存渲染）时，在途旧请求的追加不能产生重复行
  const dedupe = (incoming: any[]): any[] => {
    if (!Array.isArray(incoming)) return []
    const seen = new Set(store.tracks.map((t) => t.id))
    return incoming.filter((t) => t?.id && !seen.has(t.id))
  }
  try {
    if (v.cursor.kind === 'qq-diss') {
      const r: any = await api.invoke('qq:dissTracks', {
        disstid: v.cursor.disstid,
        dirid: v.cursor.dirid,
        songBegin: v.cursor.begin,
      })
      if (songsView.value?.cacheKey !== startedKey) return // 中途切走了，本次结果丢弃
      if (r?.tracks?.length) {
        store.appendTracks(dedupe(r.tracks))
        songsView.value = {
          ...v,
          total: r.total,
          cursor: { ...v.cursor, begin: v.cursor.begin + r.tracks.length },
        }
      } else if (r) {
        songsView.value = { ...v, cursor: undefined } // 到底
      }
    } else {
      const r: any = await api.invoke('ne:playlistPage', { id: v.cursor.id, offset: v.cursor.offset, limit: 200 })
      if (songsView.value?.cacheKey !== startedKey) return // 中途切走了，本次结果丢弃
      if (r?.tracks?.length) {
        store.appendTracks(dedupe(r.tracks))
        // 推进用主进程返回的 nextOffset（按请求 batch 推进；song/detail 可能丢歌，
        // 用返回条数推进会造成重叠复拉、翻页错乱）
        const next = typeof r.nextOffset === 'number' ? r.nextOffset : v.cursor.offset + r.tracks.length
        songsView.value = {
          ...v,
          total: r.total,
          cursor: r.more ? { ...v.cursor, offset: next } : undefined,
        }
      } else if (r) {
        songsView.value = { ...v, cursor: undefined }
      }
    }
    // 缓存写穿：追加页同步进内存缓存（保留首屏快照与抓取时间），下次切回直接秒开全量已加载部分
    const ck = songsView.value?.cacheKey
    const sv = songsView.value
    const prev = ck ? songsCache.get(ck) : undefined
    if (ck && sv && ck === startedKey && prev) {
      cacheSongs(ck, { ...prev, tracks: [...store.tracks], total: sv.total, cursor: sv.cursor, source: sv.source })
    }
  } finally {
    loadingMore.value = false
    // 兜底自动续拉：窗口很高/首屏条目少时内容填不满视口，用户无处滚动触发 onContentScroll，
    // 下一帧检查仍贴着底部则继续拉，直到填满或到底
    await nextTick()
    const cel = contentEl.value
    if (songsView.value?.cursor && cel && cel.scrollHeight <= cel.clientHeight + 400 && !loadingMore.value) {
      void loadMoreSongs()
    }
  }
}

// ---------- 歌单加载（登录后） ----------
// allSettled：收藏接口挂了不连累自建歌单（反之亦然）；有失败抛给调用方展示原因
async function refreshQqPlaylists(): Promise<void> {
  if (!store.loggedIn) return
  const [created, fav] = await Promise.allSettled([
    api.invoke<QqPlaylist[]>('qq:userPlaylists'),
    api.invoke<QqPlaylist[]>('qq:favPlaylists'),
  ])
  if (created.status === 'fulfilled') qqCreated.value = created.value ?? []
  if (fav.status === 'fulfilled') qqFav.value = fav.value ?? []
  const firstErr = created.status === 'rejected' ? created.reason : fav.status === 'rejected' ? fav.reason : null
  if (firstErr != null) throw firstErr instanceof Error ? firstErr : new Error(String(firstErr))
}

async function refreshNePlaylists(): Promise<void> {
  if (!store.neLoggedIn) return
  const acc: any = await api.invoke('ne:account')
  if (acc?.uid) {
    neUid.value = acc.uid
    neNickname.value = acc.nickname ?? ''
    nePlaylists.value = (await api.invoke<NePlaylist[]>('ne:playlists', acc.uid)) ?? []
  }
}

// ---------- 次级导航动作 ----------
/** 我喜欢的音乐（QQ：dirid=201；网易云：specialType=5 歌单；缓存秒开 + 后台 diff 更新） */
async function openLiked(source: 'qq' | 'netease', force = false): Promise<void> {
  if (source === 'qq') {
    await openSongsView({
      key: 'qq:liked',
      title: '我喜欢的音乐',
      source: 'qq',
      back: null,
      force,
      emptyNotice: '「我喜欢的音乐」加载失败（可能需要重新扫码登录）',
      fetchFirst: async () => {
        const r: any = await api.invoke('qq:dissTracks', { dirid: 201, songBegin: 0 })
        if (!r?.tracks?.length) return null
        const cursor: LoadCursor | undefined = r.more ? { kind: 'qq-diss', dirid: 201, begin: r.tracks.length } : undefined
        return { tracks: r.tracks, total: r.total, cursor }
      },
      reload: () => openLiked('qq', true),
    })
    return
  }
  // 网易云：歌单缓存可能为空（刚登录/刷新失败），先尝试刷新一次
  let liked = nePlaylists.value.find((p) => p.liked)
  if (!liked) {
    await refreshNePlaylists()
    liked = nePlaylists.value.find((p) => p.liked)
  }
  if (!liked) {
    enterSongsLoading('我喜欢的音乐', 'netease')
    listNotice.value = '未找到「我喜欢的音乐」歌单（请确认网易云已登录）'
    listLoading.value = false
    return
  }
  await openNePlaylist(liked.id, '我喜欢的音乐', force)
}

/** 网易云歌单分页首屏（trackIds → song/detail 分批；缓存秒开 + 后台 diff 更新） */
async function openNePlaylist(
  id: number,
  title: string,
  force = false,
  fromGroup?: { source: 'qq' | 'netease'; group: 'created' | 'fav' } | null,
): Promise<void> {
  const back: SongsBack | null = fromGroup ? { kind: 'group', source: fromGroup.source, group: fromGroup.group } : null
  await openSongsView({
    key: `ne:pl:${id}`,
    title,
    source: 'netease',
    back,
    force,
    emptyNotice: '歌单为空或加载失败',
    fetchFirst: async () => {
      const r: any = await api.invoke('ne:playlistPage', { id: String(id), offset: 0, limit: 200 })
      if (!r?.tracks?.length) return null
      const cursor: LoadCursor | undefined = r.more
        ? { kind: 'ne-playlist', id: String(id), offset: typeof r.nextOffset === 'number' ? r.nextOffset : r.tracks.length }
        : undefined
      return { tracks: r.tracks, total: r.total, cursor }
    },
    reload: () => openNePlaylist(id, title, true, fromGroup ?? null),
  })
}

/** 歌单列表页（自建/收藏） */
async function openGroup(source: 'qq' | 'netease', group: 'created' | 'fav'): Promise<void> {
  songsView.value = null
  albumsView.value = null
  songsBack.value = null
  songsReload = null
  groupView.value = { source, group }
  listNotice.value = ''
  scrollTop()
  // 懒刷新失败不再静默吞掉：歌单页直接显示原因（此前空列表 + 一句固定文案，查无可查）
  try {
    if (source === 'qq' && group === 'fav' && qqFav.value.length === 0) await refreshQqPlaylists()
    if (source === 'netease' && nePlaylists.value.length === 0) await refreshNePlaylists()
  } catch (e) {
    listNotice.value = e instanceof Error ? e.message : String(e)
  }
}

/** 打开具体歌单 → 歌曲列表视图（缓存秒开 + 后台 diff 更新；返回回到歌单列表） */
async function openPlaylist(source: 'qq' | 'netease', id: string | number, title: string, force = false): Promise<void> {
  if (source === 'netease') {
    await openNePlaylist(Number(id), title, force, groupView.value)
    return
  }
  const fromGroup = groupView.value
  const back: SongsBack | null = fromGroup ? { kind: 'group', source: fromGroup.source, group: fromGroup.group } : null
  await openSongsView({
    key: `qq:diss:${id}`,
    title,
    source: 'qq',
    back,
    force,
    emptyNotice: '歌单为空或加载失败（部分歌单需要登录可见）',
    fetchFirst: async () => {
      const r: any = await api.invoke('qq:dissTracks', { disstid: Number(id), songBegin: 0 })
      if (!r?.tracks?.length) return null
      const cursor: LoadCursor | undefined = r.more ? { kind: 'qq-diss', disstid: Number(id), begin: r.tracks.length } : undefined
      return { tracks: r.tracks, total: r.total, cursor }
    },
    reload: () => openPlaylist(source, id, title, true),
  })
}

/** 歌单列表页展示数据（按分组过滤） */
const groupList = computed<Array<{ id: string; name: string; cover: string; trackCount: number }>>(() => {
  if (!groupView.value) return []
  const { source, group } = groupView.value
  if (source === 'qq') {
    return (group === 'created' ? qqCreated.value : qqFav.value).map((p) => ({ ...p }))
  }
  const list = nePlaylists.value.filter((p) => {
    if (p.liked) return false
    return group === 'created' ? p.creatorUid === neUid.value : !!p.subscribed
  })
  return list.map((p) => ({ id: String(p.id), name: p.name, cover: p.cover || '', trackCount: p.trackCount }))
})

/** 歌单列表页空态文案：QQ 收藏分三种——扫码仍无（腾讯没给字段，上报日志）、
 * 手动导入（本就没有，退出重扫）、有 euin 仍空（账号确实没收藏） */
const favHint = computed(() => {
  if (groupView.value?.source === 'qq' && groupView.value?.group === 'fav' && !qqHasEncUin.value) {
    if (qqLoginMethod.value === 'qr') {
      return `扫码登录成功但腾讯未返回 EncryptUin，收藏歌单拉不到。请把诊断日志发给开发者：${diagLogPath.value || '用户数据目录 qq-login-diag.log'}`
    }
    return '收藏歌单需要扫码登录后显示（手动导入的 Cookie 缺少 EncryptUin：请退出 QQ 登录后重新扫码）'
  }
  return '暂无内容'
})

/** 内容区滚动监听：接近底部时自动加载下一页（用户要求：翻动动态加载） */
function onContentScroll(e: Event): void {
  const el = e.target as HTMLElement
  if (!el || !songsView.value?.cursor) return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) void loadMoreSongs()
}

// ---------- 下载 ----------
async function downloadSelected(): Promise<void> {
  if (queueing.value || selectedCount.value === 0) return
  queueing.value = true
  try {
    const selected = store.tracks.filter((t) => store.selectedIds.has(t.id))
    if (selected.length) {
      await api.invoke('dl:enqueue', {
        tracks: selected, quality: store.quality, lyricMode: store.lyricMode, source: ctxSource.value,
      })
      store.clear()
      // 不跳页：留在当前列表继续勾选，进度看底部工具栏「下载中 N」→ 点进去即到我的下载
    }
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e))
  } finally {
    queueing.value = false
  }
}

function onQqLoginChanged(s: { loggedIn: boolean; uin?: string; hasEncUin?: boolean; loginMethod?: string }): void {
  store.setLogin(s.loggedIn, s.uin ?? '')
  qqHasEncUin.value = !!s.hasEncUin
  qqLoginMethod.value = s.loginMethod ?? ''
  if (s.loggedIn) void refreshQqPlaylists().catch(() => {})
  else {
    qqCreated.value = []
    qqFav.value = []
    clearSongsCache('qq')
    if (songsView.value?.source === 'qq' || groupView.value?.source === 'qq') {
      groupView.value = null
      songsView.value = null
    }
  }
}

/** 网易云登录/退出（侧栏入口；扫码开窗，关闭后靠 ne:authChanged 回调刷新） */
async function neLogin(): Promise<void> {
  await api.invoke('ne:auth:open')
}

async function neLogout(): Promise<void> {
  await api.invoke('ne:auth:clear')
  store.setNeLogin(false)
  nePlaylists.value = []
  neNickname.value = ''
  neUid.value = 0
  clearSongsCache('netease')
  if (songsView.value?.source === 'netease' || groupView.value?.source === 'netease') {
    groupView.value = null
    songsView.value = null
  }
}

function onNeAuthChanged(): void {
  void api.invoke('ne:auth:status').then((s: any) => {
    const ok = !!s?.loggedIn
    store.setNeLogin(ok)
    if (ok) void refreshNePlaylists()
    else {
      nePlaylists.value = []
      neNickname.value = ''
      neUid.value = 0
      clearSongsCache('netease')
      if (songsView.value?.source === 'netease' || groupView.value?.source === 'netease') {
        groupView.value = null
        songsView.value = null
      }
    }
  })
}

// ---------- 启动 ----------
onMounted(() => {
  void api.invoke('auth:status').then((s: any) => {
    store.setLogin(!!s?.loggedIn, s?.uin ?? '')
    qqHasEncUin.value = !!s?.hasEncUin
    qqLoginMethod.value = s?.loginMethod ?? ''
    if (typeof s?.diagLog === 'string') diagLogPath.value = s.diagLog
    if (s?.loggedIn) void refreshQqPlaylists().catch(() => {})
  })
  void api.invoke('ne:auth:status').then((s: any) => {
    store.setNeLogin(!!s?.loggedIn)
    if (s?.loggedIn) void refreshNePlaylists()
  })
  void api.invoke('settings:get').then((s: any) => {
    if (s?.quality) store.setQuality(s.quality)
    if (s?.lyricMode) store.setLyricMode(s.lyricMode)
  })
  api.on('dl:jobStart', store.onQueueEvent)
  api.on('dl:progress', store.onQueueEvent)
  api.on('dl:done', store.onQueueEvent)
  api.on('dl:failed', store.onQueueEvent)
  api.on('ne:authChanged', () => onNeAuthChanged())
})

const subActive = (source: 'qq' | 'netease', group?: 'created' | 'fav' | 'liked'): boolean => {
  if (group === 'liked') return songsView.value?.source === source && songsView.value?.title === '我喜欢的音乐'
  if (group) return groupView.value?.source === source && groupView.value?.group === group
  return groupView.value === null && songsView.value === null && tab.value === (source === 'qq' ? 'qq' : 'netease')
}
</script>

<template>
  <div class="app">
    <aside class="sidebar">
      <h1>音乐下载器</h1>
      <nav>
        <button :class="{ active: subActive('qq') }" @click="goTab('qq')">QQ 音乐</button>
        <template v-if="store.loggedIn">
          <button class="sub" :class="{ active: subActive('qq', 'liked') }" @click="openLiked('qq')">· 我喜欢的音乐</button>
          <button class="sub" :class="{ active: subActive('qq', 'created') }" @click="openGroup('qq', 'created')">· 自建歌单</button>
          <button class="sub" :class="{ active: subActive('qq', 'fav') }" @click="openGroup('qq', 'fav')">· 收藏的歌单</button>
        </template>
        <button :class="{ active: subActive('netease') }" @click="goTab('netease')">网易云</button>
        <template v-if="store.neLoggedIn">
          <button class="sub" :class="{ active: subActive('netease', 'liked') }" @click="openLiked('netease')">· 我喜欢的音乐</button>
          <button class="sub" :class="{ active: subActive('netease', 'created') }" @click="openGroup('netease', 'created')">· 自建歌单</button>
          <button class="sub" :class="{ active: subActive('netease', 'fav') }" @click="openGroup('netease', 'fav')">· 收藏的歌单</button>
        </template>
        <button :class="{ active: tab === 'download' }" @click="goTab('download')">我的下载</button>
        <button :class="{ active: tab === 'decrypt' }" @click="goTab('decrypt')">解密</button>
        <button :class="{ active: tab === 'settings' }" @click="goTab('settings')">设置</button>
      </nav>
      <div class="sidebar-foot">
        <LoginButton
          :logged-in="store.loggedIn"
          :uin="store.uin"
          @changed="onQqLoginChanged"
        />
        <div class="ne-auth">
          <button v-if="!store.neLoggedIn" class="login-btn ne" @click="neLogin">登录网易云</button>
          <template v-else>
            <span class="logged" :title="neNickname">网易云已登录{{ neNickname ? `（${neNickname}）` : '' }}</span>
            <button class="link-btn" @click="neLogout">退出登录</button>
          </template>
        </div>
      </div>
    </aside>
    <main ref="contentEl" class="content" @scroll.passive="onContentScroll">
      <!-- 歌单列表页（自建/收藏） -->
      <section v-if="groupView" class="plist-page">
        <h2>{{ groupView.source === 'qq' ? 'QQ 音乐' : '网易云' }} · {{ groupView.group === 'created' ? '自建歌单' : '收藏的歌单' }}</h2>
        <p v-if="listNotice" class="notice">{{ listNotice }}</p>
        <div v-if="groupList.length" class="plist-grid">
          <div v-for="p in groupList" :key="p.id" class="plist-card" @click="openPlaylist(groupView.source, p.id, p.name)">
            <div class="plist-cover" :style="p.cover ? { backgroundImage: `url(${p.cover})` } : {}">{{ p.trackCount }} 首</div>
            <div class="plist-name" :title="p.name">{{ p.name }}</div>
          </div>
        </div>
        <div v-else class="empty">
          {{ favHint }}
        </div>
      </section>
      <!-- 歌曲列表页（我喜欢的 / 歌单歌曲 / 链接导入） -->
      <section v-else-if="songsView" class="songs-page">
        <div class="songs-head">
          <button class="back-btn" @click="goBack()">‹ 返回</button>
          <h2>{{ songsView.title }}<span v-if="songsView.total" class="total">（{{ store.tracks.length }} / {{ songsView.total }}）</span><span v-if="revalState && songsView.cacheKey === revalState.key" class="reval"> · {{ revalState.text }}</span></h2>
          <button
            v-if="songsView.cacheKey"
            class="back-btn"
            title="清除缓存并重新加载"
            :disabled="listLoading || loadingMore"
            @click="reloadSongs()"
          >↻ 刷新</button>
        </div>
        <!-- 首屏加载遮罩：转圈 + 明确文案（此前只有顶部一行小字，滚到底部时看不见，像卡死） -->
        <div v-if="listLoading && store.tracks.length === 0" class="loading-mask">
          <span class="spinner big"></span>
          <p>正在加载{{ songsView.title }}…（歌曲多时可能需要十几秒）</p>
        </div>
        <p v-else-if="listLoading" class="loading">加载中…<span class="spinner"></span></p>
        <p v-if="listNotice" class="notice">{{ listNotice }}</p>
        <!-- 本批下载选项（码率/歌词）：喜欢/歌单/专辑/链接页此前都没有，只能用设置默认值 -->
        <DownloadOptions v-if="!listLoading || store.tracks.length > 0" />
        <TrackGrid
          :tracks="store.tracks"
          :selected-ids="store.selectedIds"
          :load-more="!!songsView.cursor"
          :load-more-total="songsView.total"
          :loading-more="loadingMore"
          @toggle="store.toggle($event)"
          @load-more="loadMoreSongs"
        />
      </section>
      <!-- 功能页 -->
      <section v-else-if="tab === 'qq'">
        <SearchBar v-model="q" @search="searchTab === 'song' ? doSearch() : albumSearch()" />
        <div class="search-tabs">
          <button :class="{ active: searchTab === 'song' }" @click="switchSearchTab('song')">歌曲</button>
          <button :class="{ active: searchTab === 'album' }" @click="switchSearchTab('album')">专辑</button>
        </div>
        <DownloadOptions v-if="searchTab === 'song'" />
        <p v-if="listNotice" class="notice">{{ listNotice }}</p>
        <TrackGrid
          v-if="searchTab === 'song' && store.trackSource !== 'netease'"
          :tracks="store.tracks"
          :selected-ids="store.selectedIds"
          @toggle="store.toggle($event)"
          @select-all="store.selectAll()"
          @clear="store.clear()"
        />
        <div v-else-if="searchTab === 'song'" class="empty">当前列表是网易云搜索结果，请到「网易云」页查看 / 下载</div>
        <div v-else class="plist-grid">
          <p v-if="listLoading" class="loading">专辑搜索中…<span class="spinner"></span></p>
          <div v-for="a in albumsView?.albums ?? []" :key="a.mid" class="plist-card" @click="openAlbum(a.mid, a.name)">
            <div class="plist-cover" :style="a.cover ? { backgroundImage: `url(${a.cover})` } : {}">{{ a.songCount }} 首</div>
            <div class="plist-name" :title="a.name">{{ a.name }}</div>
            <div class="plist-sub">{{ a.singer }}</div>
          </div>
          <div v-if="!albumsView && !listLoading" class="empty">输入关键词后按「搜索」查找专辑</div>
        </div>
      </section>
      <section v-else-if="tab === 'netease'"><NeteaseTab /></section>
      <section v-else-if="tab === 'download'"><DownloadPage /></section>
      <section v-else-if="tab === 'decrypt'"><DecryptTab /></section>
      <section v-else><SettingsPanel /></section>
    </main>

    <!-- 窗口底部固定工具栏：下载按钮永远可见（不再翻列表） -->
    <footer class="toolbar">
      <button
        class="download-btn"
        :class="{ active: selectedCount > 0, queueing }"
        :disabled="selectedCount === 0 || queueing"
        @click="downloadSelected"
      >
        {{ queueing ? '加入队列中…' : `下载选中 (${selectedCount})` }}
        <span v-if="store.quality" class="q-badge">{{ store.quality }}</span>
      </button>
      <span class="ctx-label">{{ ctxSource === 'qq' ? 'QQ' : '网易云' }}{{ songsView ? ' · ' + songsView.title : '' }}</span>
      <button class="count-btn" :class="{ has: activeCount > 0 }" @click="goTab('download')">
        {{ activeCount > 0 ? `下载中 ${activeCount}` : `已完成 ${doneCount}` }}
      </button>
    </footer>
  </div>
</template>

<style>
body { margin: 0; font-family: system-ui, 'Microsoft YaHei', sans-serif; background: #f7f8fa; color: #222; overflow: hidden; }
/* 侧栏独立于内容区滚动（2026-09-06 用户要求：侧边 tab 不随右侧内容滚动） */
.app { display: flex; height: 100vh; }
.sidebar {
  width: 190px;
  flex-shrink: 0;
  padding: 16px 12px 72px;
  background: #fff;
  border-right: 1px solid #e6e8ec;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
}
.sidebar h1 { font-size: 17px; margin: 0; padding: 0 8px; }
.sidebar nav { display: flex; flex-direction: column; gap: 4px; }
.sidebar nav button {
  padding: 9px 14px;
  font-size: 14px;
  text-align: left;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  color: #444;
}
.sidebar nav button.sub { padding: 7px 14px 7px 26px; font-size: 13px; color: #666; }
.sidebar nav button:hover { background: #f0f3f5; }
.sidebar nav button.active { font-weight: 700; color: #fff; background: #31c27c; }
.sidebar-foot { margin-top: auto; display: flex; flex-direction: column; gap: 10px; }
.ne-auth { display: flex; flex-direction: column; align-items: stretch; gap: 4px; min-width: 0; }
.ne-auth .logged {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ne-auth .link-btn { align-self: flex-start; }
.login-btn.ne { background: #d43c33; }
.login-btn.ne:hover { background: #b73229; }
.link-btn {
  padding: 4px 10px;
  font-size: 12px;
  color: #999;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.link-btn:hover { color: #d32f2f; background: #fdecea; }
.logged { font-size: 13px; color: #31c27c; }
.login-btn {
  padding: 6px 18px;
  font-size: 13px;
  color: #fff;
  background: #31c27c;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  width: 100%;
}
.login-btn:hover { filter: brightness(0.93); }
.songs-head { display: flex; align-items: center; gap: 10px; }
.songs-head h2 { font-size: 17px; margin: 0; }
.back-btn {
  padding: 4px 12px;
  font-size: 13px;
  color: #666;
  background: #fff;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;
}
.back-btn:hover { border-color: #31c27c; color: #31c27c; }
.loading-mask {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 70px 0;
  color: #31c27c;
  font-size: 14px;
}
.loading-mask p { margin: 0; }
.content { flex: 1; min-width: 0; overflow-y: auto; padding: 20px 24px 76px; }
.notice { color: #d9930e; font-size: 13px; }
.loading { color: #31c27c; font-size: 13px; display: flex; align-items: center; gap: 8px; }
.spinner {
  width: 14px; height: 14px;
  border: 2px solid #cfe9dc;
  border-top-color: #31c27c;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  display: inline-block;
}
.spinner.big { width: 30px; height: 30px; border-width: 3px; }
@keyframes spin { to { transform: rotate(360deg); } }
.empty { color: #888; font-size: 13px; padding: 24px 0; }
.plist-page, .songs-page { display: flex; flex-direction: column; gap: 12px; }
.plist-page h2, .songs-page h2 { font-size: 17px; margin: 0; }
.plist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
.plist-card { cursor: pointer; }
.plist-cover {
  height: 130px;
  border-radius: 8px;
  background: #e8edf0 url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="%23b9c6cc"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>') no-repeat center;
  background-size: cover, 36px;
  display: flex; align-items: flex-end; justify-content: flex-end;
  color: #fff; font-size: 12px; padding: 6px 8px;
}
.plist-name { font-size: 13px; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plist-sub { font-size: 12px; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.total { font-size: 12px; color: #999; font-weight: 400; margin-left: 8px; }
.reval { font-size: 12px; color: #31c27c; font-weight: 400; margin-left: 4px; }
.search-tabs { display: flex; gap: 6px; margin: 10px 0 4px; }
.search-tabs button {
  padding: 5px 18px;
  font-size: 13px;
  border: 1px solid #d0d0d0;
  border-radius: 16px;
  background: #fff;
  color: #666;
  cursor: pointer;
}
.search-tabs button.active { background: #31c27c; color: #fff; border-color: #31c27c; font-weight: 600; }

/* 窗口底部固定工具栏（fixed 于视口底部，翻列表始终可见） */
.toolbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: 56px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 24px;
  background: #ffffff;
  border-top: 1px solid #e6e8ec;
  box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.05);
  z-index: 20;
}
.download-btn {
  padding: 9px 26px;
  font-size: 14px;
  font-weight: 700;
  border: none;
  border-radius: 8px;
  background: #c8d2cc;
  color: #fff;
  cursor: pointer;
  transition: background 0.15s, transform 0.05s;
}
.download-btn.active { background: #31c27c; }
.download-btn:hover:not(:disabled) { filter: brightness(1.08); }
.download-btn:active:not(:disabled) { transform: translateY(1px); filter: brightness(0.94); }
.download-btn:disabled { cursor: not-allowed; }
.download-btn.queueing { background: #2ba367; }
.q-badge {
  margin-left: 6px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.25);
  border-radius: 4px;
  padding: 1px 6px;
}
.ctx-label { font-size: 12px; color: #999; }
.count-btn {
  margin-left: auto;
  padding: 6px 14px;
  font-size: 13px;
  border: 1px solid #d0d0d0;
  border-radius: 8px;
  background: #fff;
  color: #666;
  cursor: pointer;
}
.count-btn.has { color: #31c27c; border-color: #31c27c; font-weight: 600; }
.count-btn:hover { border-color: #31c27c; color: #31c27c; }
</style>