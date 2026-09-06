<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import SearchBar from './components/SearchBar.vue'
import TrackGrid from './components/TrackGrid.vue'
import LoginButton from './components/LoginButton.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import NeteaseTab from './components/NeteaseTab.vue'
import DecryptTab from './components/DecryptTab.vue'
import DownloadPage from './components/DownloadPage.vue'
import DownloadOptions from './components/DownloadOptions.vue'
import { useDownloadStore } from './stores/download'
import { api } from './api'

// 界面模型（2026-09-06 用户定稿）：左侧两级导航。
// 顶级 = 功能页（QQ音乐=搜索-下载体系 / 网易云 / 我的下载 / 解密 / 设置）；
// 次级（登录后） = 我喜欢的音乐 / 自建歌单 / 收藏的歌单——点击后内容区只显示对应内容。
// 当前歌曲列表统一在 store.tracks（单选列表模型），下载按钮 source 由视图上下文决定。
type Tab = 'qq' | 'netease' | 'download' | 'decrypt' | 'settings'
interface QqPlaylist { id: string; name: string; cover: string; trackCount: number }
interface NePlaylist { id: number; name: string; liked: boolean; subscribed?: boolean; creatorUid?: number; trackCount: number }

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
const groupView = ref<{ source: 'qq' | 'netease'; group: 'created' | 'fav' } | null>(null)
const songsView = ref<{ title: string; source: 'qq' | 'netease'; total?: number; cursor?: LoadCursor } | null>(null)
const albumsView = ref<{ source: 'qq' | 'netease'; query: string; albums: Array<{ mid: string; name: string; singer: string; cover: string; songCount: number }> } | null>(null)
const listNotice = ref('')
// QQ 搜索页：歌曲 | 专辑
const searchTab = ref<'song' | 'album'>('song')
const loadingMore = ref(false)

// 底栏：当前列表的下载 source + 选中数
const ctxSource = computed<'qq' | 'netease'>(() => songsView.value?.source ?? (tab.value === 'netease' ? 'netease' : 'qq'))
const selectedCount = computed(() => store.selectedIds.size)
const activeCount = computed(() => store.queue.filter((j) => j.state === 'queued' || j.state === 'running').length)
const doneCount = computed(() => store.queue.filter((j) => j.state === 'done' || j.state === 'failed').length)
const neUid = ref(0)

// ---------- 顶级页切换 ----------
function goTab(t: Tab): void {
  tab.value = t
  groupView.value = null
  songsView.value = null
  albumsView.value = null
  listNotice.value = ''
}

// ---------- QQ 搜索 ----------
async function doSearch(): Promise<void> {
  const text = q.value.trim()
  if (!text) return
  try {
    if (/y\.qq\.com\/n\/ryqq\/(songDetail|playlist|albumDetail)/.test(text)) {
      const res: any = await api.invoke('qq:linkTracks', text)
      if (res?.tracks?.length) {
        store.setTracks(res.tracks)
        songsView.value = { title: '链接导入', source: 'qq' }
      } else window.alert('未能解析该链接，请确认是 QQ 音乐歌单 / 专辑 / 单曲链接')
      return
    }
    const tracks: any = await api.invoke('qq:search', text)
    if (!Array.isArray(tracks)) window.alert('搜索失败，请稍后重试')
    else {
      store.setTracks(tracks)
      songsView.value = { title: `「${text}」搜索`, source: 'qq' }
    }
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e))
  }
}

/** 专辑搜索（歌曲 | 专辑 tab 切换后的入口） */
async function albumSearch(): Promise<void> {
  const text = q.value.trim()
  if (!text) return
  const albums: any = await api.invoke('qq:albumSearch', text)
  if (!Array.isArray(albums)) window.alert('专辑搜索失败')
  else {
    groupView.value = null
    songsView.value = null
    albumsView.value = { source: 'qq', query: text, albums }
  }
}

/** 点开专辑 → 专辑歌曲列表（QQ：fetchAlbum；网易云：api/v1/album） */
async function openAlbum(mid: string | number, title: string): Promise<void> {
  listNotice.value = ''
  try {
    const source = albumsView.value?.source ?? 'qq'
    const tracks: any =
      source === 'qq' ? await api.invoke('qq:albumSongs', mid) : await api.invoke('ne:albumSongs', Number(mid))
    if (!Array.isArray(tracks) || tracks.length === 0) {
      listNotice.value = '专辑为空或加载失败'
      return
    }
    store.setTracks(tracks)
    albumsView.value = null
    songsView.value = { title: `专辑 · ${title}`, source, total: tracks.length }
  } catch (e) {
    listNotice.value = e instanceof Error ? e.message : String(e)
  }
}

/** 歌单/喜欢懒加载：翻到哪加载到哪（QQ：CgiGetDiss 分页；网易云：trackIds → song/detail 分批） */
async function loadMoreSongs(): Promise<void> {
  const v = songsView.value
  if (!v?.cursor || loadingMore.value) return
  loadingMore.value = true
  try {
    if (v.cursor.kind === 'qq-diss') {
      const r: any = await api.invoke('qq:dissTracks', {
        disstid: v.cursor.disstid,
        dirid: v.cursor.dirid,
        songBegin: v.cursor.begin,
      })
      if (r?.tracks?.length) {
        store.appendTracks(r.tracks)
        songsView.value = {
          ...v,
          total: r.total,
          cursor: { ...v.cursor, begin: v.cursor.begin + r.tracks.length },
        }
      } else if (r) {
        songsView.value = { ...v, cursor: undefined } // 到底
      }
    } else {
      const r: any = await api.invoke('ne:playlistPage', { id: v.cursor.id, offset: v.cursor.offset })
      if (r?.tracks?.length) {
        store.appendTracks(r.tracks)
        songsView.value = {
          ...v,
          total: r.total,
          cursor: r.more ? { ...v.cursor, offset: v.cursor.offset + r.tracks.length } : undefined,
        }
      } else if (r) {
        songsView.value = { ...v, cursor: undefined }
      }
    }
  } finally {
    loadingMore.value = false
  }
}

// ---------- 歌单加载（登录后） ----------
async function refreshQqPlaylists(): Promise<void> {
  if (!store.loggedIn) return
  const [created, fav] = await Promise.all([
    api.invoke<QqPlaylist[]>('qq:userPlaylists'),
    api.invoke<QqPlaylist[]>('qq:favPlaylists'),
  ])
  qqCreated.value = created ?? []
  qqFav.value = fav ?? []
}

async function refreshNePlaylists(): Promise<void> {
  if (!store.neLoggedIn) return
  const acc: any = await api.invoke('ne:account')
  if (acc?.uid) {
    neUid.value = acc.uid
    nePlaylists.value = (await api.invoke<NePlaylist[]>('ne:playlists', acc.uid)) ?? []
  }
}

// ---------- 次级导航动作 ----------
/** 我喜欢的音乐（QQ：dirid=201；网易云：specialType=5 歌单） */
async function openLiked(source: 'qq' | 'netease'): Promise<void> {
  listNotice.value = ''
  albumsView.value = null
  try {
    if (source === 'qq') {
      const r: any = await api.invoke('qq:dissTracks', { dirid: 201, songBegin: 0 })
      if (!r?.tracks?.length) {
        listNotice.value = '「我喜欢的音乐」加载失败（可能需要重新扫码登录）'
        return
      }
      store.setTracks(r.tracks)
      songsView.value = {
        title: '我喜欢的音乐',
        source: 'qq',
        total: r.total,
        cursor: r.more ? { kind: 'qq-diss', dirid: 201, begin: r.tracks.length } : undefined,
      }
    } else {
      const liked = nePlaylists.value.find((p) => p.liked)
      if (!liked) {
        listNotice.value = '未找到「我喜欢的音乐」歌单'
        return
      }
      await openNePlaylist(liked.id, '我喜欢的音乐')
    }
  } catch (e) {
    listNotice.value = e instanceof Error ? e.message : String(e)
  }
}

/** 网易云歌单全量分页（trackIds → song/detail 分批；替代旧版仅前 10 首） */
async function openNePlaylist(id: number, title: string): Promise<void> {
  const r: any = await api.invoke('ne:playlistPage', { id: String(id), offset: 0 })
  if (!r?.tracks?.length) {
    listNotice.value = '歌单为空或加载失败'
    return
  }
  store.setTracks(r.tracks)
  songsView.value = {
    title,
    source: 'netease',
    total: r.total,
    cursor: r.more ? { kind: 'ne-playlist', id: String(id), offset: r.tracks.length } : undefined,
  }
}

/** 歌单列表页（自建/收藏） */
async function openGroup(source: 'qq' | 'netease', group: 'created' | 'fav'): Promise<void> {
  songsView.value = null
  albumsView.value = null
  groupView.value = { source, group }
  listNotice.value = ''
  if (source === 'qq' && group === 'fav' && qqFav.value.length === 0) await refreshQqPlaylists()
  if (source === 'netease' && nePlaylists.value.length === 0) await refreshNePlaylists()
}

/** 打开具体歌单 → 歌曲列表视图 */
async function openPlaylist(source: 'qq' | 'netease', id: string | number, title: string): Promise<void> {
  listNotice.value = ''
  try {
    if (source === 'qq') {
      const r: any = await api.invoke('qq:dissTracks', { disstid: Number(id), songBegin: 0 })
      if (!r?.tracks?.length) {
        listNotice.value = '歌单为空或加载失败（部分歌单需要登录可见）'
        return
      }
      store.setTracks(r.tracks)
      songsView.value = {
        title,
        source: 'qq',
        total: r.total,
        cursor: r.more ? { kind: 'qq-diss', disstid: Number(id), begin: r.tracks.length } : undefined,
      }
    } else {
      await openNePlaylist(Number(id), title)
    }
  } catch (e) {
    listNotice.value = e instanceof Error ? e.message : String(e)
  }
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
  return list.map((p) => ({ id: String(p.id), name: p.name, cover: '', trackCount: p.trackCount }))
})

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
      tab.value = 'download' // 明确反馈：入队成功立刻看到下载页
      groupView.value = null
      songsView.value = null
    }
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e))
  } finally {
    queueing.value = false
  }
}

function onQqLoginChanged(s: { loggedIn: boolean; uin?: string }): void {
  store.setLogin(s.loggedIn, s.uin ?? '')
  if (s.loggedIn) void refreshQqPlaylists()
  else {
    qqCreated.value = []
    qqFav.value = []
    groupView.value = null
    songsView.value = null
  }
}

// ---------- 启动 ----------
onMounted(() => {
  void api.invoke('auth:status').then((s: any) => {
    store.setLogin(!!s?.loggedIn, s?.uin ?? '')
    if (s?.loggedIn) void refreshQqPlaylists()
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
  api.on('ne:authChanged', () => {
    void api.invoke('ne:auth:status').then((s: any) => {
      store.setNeLogin(!!s?.loggedIn)
      if (s?.loggedIn) void refreshNePlaylists()
    })
  })
  // 网易云页搜索/专辑结果 → 歌曲列表视图（底栏下载走网易云 source）
  window.addEventListener('ne:list-updated', (e: Event) => {
    const title = (e as CustomEvent<string>).detail || '网易云搜索'
    groupView.value = null
    albumsView.value = null
    songsView.value = { title, source: 'netease' }
  })
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
      </div>
    </aside>
    <main class="content">
      <!-- 歌单列表页（自建/收藏） -->
      <section v-if="groupView" class="plist-page">
        <h2>{{ groupView.source === 'qq' ? 'QQ 音乐' : '网易云' }} · {{ groupView.group === 'created' ? '自建歌单' : '收藏的歌单' }}</h2>
        <div v-if="groupList.length" class="plist-grid">
          <div v-for="p in groupList" :key="p.id" class="plist-card" @click="openPlaylist(groupView.source, p.id, p.name)">
            <div class="plist-cover" :style="p.cover ? { backgroundImage: `url(${p.cover})` } : {}">{{ p.trackCount }} 首</div>
            <div class="plist-name" :title="p.name">{{ p.name }}</div>
          </div>
        </div>
        <div v-else class="empty">
          {{ groupView.source === 'qq' && groupView.group === 'fav' ? '收藏歌单需要重新扫码登录后显示（需保存 EncryptUin）' : '暂无内容' }}
        </div>
      </section>
      <!-- 歌曲列表页（我喜欢的 / 歌单歌曲 / 链接导入） -->
      <section v-else-if="songsView" class="songs-page">
        <h2>{{ songsView.title }}<span v-if="songsView.total" class="total">（{{ store.tracks.length }} / {{ songsView.total }}）</span></h2>
        <p v-if="listNotice" class="notice">{{ listNotice }}</p>
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
          <button :class="{ active: searchTab === 'song' }" @click="searchTab = 'song'">歌曲</button>
          <button :class="{ active: searchTab === 'album' }" @click="searchTab = 'album'">专辑</button>
        </div>
        <DownloadOptions v-if="searchTab === 'song'" />
        <p v-if="listNotice" class="notice">{{ listNotice }}</p>
        <TrackGrid
          v-if="searchTab === 'song'"
          :tracks="store.tracks"
          :selected-ids="store.selectedIds"
          @toggle="store.toggle($event)"
          @select-all="store.selectAll()"
          @clear="store.clear()"
        />
        <div v-else class="plist-grid">
          <div v-for="a in albumsView?.albums ?? []" :key="a.mid" class="plist-card" @click="openAlbum(a.mid, a.name)">
            <div class="plist-cover" :style="a.cover ? { backgroundImage: `url(${a.cover})` } : {}">{{ a.songCount }} 首</div>
            <div class="plist-name" :title="a.name">{{ a.name }}</div>
            <div class="plist-sub">{{ a.singer }}</div>
          </div>
          <div v-if="!albumsView" class="empty">切换到「专辑」，输入关键词搜索专辑</div>
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
.sidebar-foot { margin-top: auto; }
.content { flex: 1; min-width: 0; overflow-y: auto; padding: 20px 24px 76px; }
.notice { color: #d9930e; font-size: 13px; }
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