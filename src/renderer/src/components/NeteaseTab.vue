<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import TrackGrid from './TrackGrid.vue'
import DownloadOptions from './DownloadOptions.vue'
import { useDownloadStore, albumPartialConfirm, albumEnqueuedNotice } from '../stores/download'
import type { UiAlbumBundle, UiTrack } from '../stores/download'
import { api } from '../api'

// 网易云功能页：登录（扫码/手动导入）+ 搜索（歌曲 | 专辑）。
// 歌单浏览（我喜欢的/自建/收藏）已由左侧导航承担（App.vue 统一管理）；
// 搜索/专辑结果内联展示在本页（歌曲/专辑 tab 常驻，不再跳走），下载走窗口底部工具栏。
const store = useDownloadStore()
// 登录态以 store 为单一事实源（侧栏退出/开窗扫码都能同步到本页；此前用本地 ref 会与侧栏脱节）
const emit = defineEmits<{ changed: [] }>()
const loggedIn = computed(() => store.neLoggedIn)
const nickname = ref('')
const q = ref('')
const error = ref('')
const cookieText = ref('')
const showImport = ref(false)
const searchTab = ref<'song' | 'album'>('song')
const busy = ref('')

interface NeAlbum { id: number; name: string; artist: string; cover: string; songCount?: number }
const albums = ref<NeAlbum[]>([])
const albumSearched = ref(false)
/** 搜索结果缓存（tab 来回切换零请求；搜索按钮/回车强制刷新） */
const neSongCache = new Map<string, UiTrack[]>()
const neAlbumCache = new Map<string, NeAlbum[]>()
function cachePut<K, V>(m: Map<K, V>, k: K, v: V, max = 30): void {
  m.delete(k)
  m.set(k, v)
  while (m.size > max) {
    const oldest = m.keys().next()
    if (oldest.done) break
    m.delete(oldest.value)
  }
}
/** 点开的专辑（内联展示其歌曲，代替跳走；返回专辑列表则清空） */
const openedAlbum = ref('')
/** 当前内联展开的专辑元数据（Task 13 的「下载整张」用；非专辑列表时为 null） */
const openedAlbumBundle = ref<UiAlbumBundle | null>(null)
/** 整张入队进行中（按钮置灰用；与 busy 分开——busy 的文案挂在搜索按钮上） */
const queueing = ref(false)
/** 入队回显（专辑视图内的一行提示；error 是红字，报喜不该借用它） */
const notice = ref('')

/** 「下载整张」按钮文案：本页曲目少于整张时把两个数都写出来（QQ 侧同名 computed 同一口径）。
 *  网易云专辑页一次给全，正常走不到「已加载 x / y」这一支，留着是因为 store.tracks 是全仓共享列表，
 *  万一被别的来源改过，按钮不许假装自己下的就是整张。 */
const albumButtonLabel = computed(() => {
  const a = openedAlbumBundle.value
  if (!a) return '下载整张'
  const loaded = store.tracks.length
  return loaded < a.totalTracks
    ? `下载整张（已加载 ${loaded} / ${a.totalTracks} 首）`
    : `下载整张（${loaded} 首）`
})

/** 收起内联专辑视图。bundle 必须与 openedAlbum 同步清空：只清标题的话，列表已经换成搜索结果
 *  或别的专辑了，持有的批次上下文却还是上一张的——整张下载会写进错误的专辑目录。 */
function closeAlbum(): void {
  openedAlbum.value = ''
  openedAlbumBundle.value = null
  notice.value = ''
}

/** 整张下载：忽略勾选，把本页全部曲目 + 批次上下文一起入队 → 落专辑子目录，
 *  档位/歌词用当前批次选项（store.quality / store.lyricMode）。
 *  bundle 从 openedAlbumBundle 现取（与按钮的 v-if 同一份状态，不靠模板传参做可空收窄）；
 *  列表读 store.tracks——与 App.vue 的同名动作只差在这里的专辑是内联展开的、不经过 songsView。 */
function enqueueWholeAlbum(): void {
  const album = openedAlbumBundle.value
  const tracks = store.tracks
  if (!album || !tracks.length || queueing.value) return
  if (tracks.length < album.totalTracks && !window.confirm(albumPartialConfirm(album, tracks.length))) return
  queueing.value = true
  void api.invoke('dl:enqueue', {
    tracks, quality: store.quality, lyricMode: store.lyricMode, source: 'netease', album,
  }).then(() => {
    notice.value = albumEnqueuedNotice(album, tracks.length)
  }).catch((e: unknown) => {
    error.value = e instanceof Error ? e.message : String(e)
  }).finally(() => {
    queueing.value = false
  })
}

async function refreshAuth(): Promise<void> {
  const s: any = await api.invoke('ne:auth:status')
  const ok = !!s?.loggedIn
  store.setNeLogin(ok)
  if (ok) {
    // ne:account 走权威探测后会因断网/风控 reject（本函数由 onMounted 以 void 调用，裸 await 即未处理拒绝）；
    // 这里只取昵称，探测失败就留空——登录态以上面 ne:auth:status 的结论为准，不在此处改判。
    const acc: any = await api.invoke('ne:account').catch(() => null)
    nickname.value = acc?.nickname ?? ''
  } else {
    nickname.value = ''
  }
}

async function doSearch(force = true): Promise<void> {
  error.value = ''
  const kw = q.value.trim()
  if (!kw || busy.value) return
  if (!force && searchTab.value === 'song') {
    const hit = neSongCache.get(kw)
    if (hit) {
      albums.value = []
      albumSearched.value = false
      closeAlbum()
      store.setTracks([...hit], 'netease')
      return
    }
  }
  if (!force && searchTab.value === 'album') {
    const hit = neAlbumCache.get(kw)
    if (hit) {
      albums.value = hit
      albumSearched.value = true
      closeAlbum()
      return
    }
  }
  busy.value = '搜索中…'
  try {
    if (searchTab.value === 'album') {
      const found = (await api.invoke<NeAlbum[]>('ne:albumSearch', kw)) ?? []
      albums.value = found
      albumSearched.value = true
      closeAlbum()
      cachePut(neAlbumCache, kw, found)
      return
    }
    albums.value = []
    albumSearched.value = false
    closeAlbum()
    const tracks: any = await api.invoke('ne:search', kw)
    if (!Array.isArray(tracks)) {
      error.value = '搜索失败，请稍后重试'
      return
    }
    // 内联展示（不再 dispatch 跳 songsView，保证歌曲/专辑 tab 始终可见可切）
    cachePut(neSongCache, kw, [...tracks])
    store.setTracks(tracks, 'netease')
  } finally {
    busy.value = ''
  }
}

async function openAlbum(id: number, title: string): Promise<void> {
  error.value = ''
  if (busy.value) return
  busy.value = '专辑加载中…'
  try {
    // ne:albumSongs 自 0.7.0 起回 { tracks, album }（spec §5.2）：bundle 存进 openedAlbumBundle，
    // Task 13 的「下载整张」要用它算专辑目录/CD 子目录/cue
    const r: any = await api.invoke('ne:albumSongs', id)
    const tracks: any = r?.tracks
    if (!Array.isArray(tracks) || tracks.length === 0) {
      error.value = '专辑为空或加载失败'
      return
    }
    // 内联展示专辑歌曲（不再跳走；返回按钮回到专辑列表）
    store.setTracks(tracks, 'netease')
    openedAlbum.value = title
    openedAlbumBundle.value = r?.album ?? null
  } finally {
    busy.value = ''
  }
}

/** 歌曲 | 专辑 tab 切换：有关键词时自动按当前 tab 搜索（缓存命中零请求） */
function switchSearchTab(t: 'song' | 'album'): void {
  searchTab.value = t
  if (t === 'song') closeAlbum()
  if (!q.value.trim() || busy.value) return
  void doSearch(false)
}

async function openLogin(): Promise<void> {
  await api.invoke('ne:auth:open')
}

/** 退出登录：清本机网易云凭证，通知 App 收起歌单导航 */
async function logout(): Promise<void> {
  await api.invoke('ne:auth:clear')
  nickname.value = ''
  store.setNeLogin(false)
  emit('changed') // 通知 App 收起歌单导航并清缓存
}

async function doImportCookie(): Promise<void> {
  // 手动导入用内联 textarea，不用 window.prompt（Electron 不实现它）
  const ok: boolean = await api.invoke('ne:auth:importCookie', cookieText.value)
  if (ok) {
    showImport.value = false
    await refreshAuth()
    emit('changed') // 触发 App 刷新歌单
  } else {
    error.value = 'Cookie 无效（需含 MUSIC_U）'
  }
}

let offAuthChanged: (() => void) | null = null
onMounted(() => {
  void refreshAuth()
  offAuthChanged = api.on('ne:authChanged', () => void refreshAuth())
})
// 组件随 tab 切换反复挂载：必须移除监听，否则回调累积（重复刷新/请求）
onUnmounted(() => {
  if (offAuthChanged) offAuthChanged()
  offAuthChanged = null
})
</script>

<template>
  <div class="netease">
    <header class="top">
      <h2>网易云</h2>
      <span v-if="loggedIn" class="who">已登录：{{ nickname }}</span>
      <button v-if="loggedIn" class="ghost" @click="logout">退出登录</button>
      <template v-else>
        <button class="ghost" @click="openLogin">扫码登录</button>
        <button class="ghost" @click="showImport = !showImport">手动导入 Cookie</button>
      </template>
    </header>
    <div v-if="showImport" class="import">
      <textarea v-model="cookieText" rows="3" placeholder="粘贴 music.163.com 的 Cookie 头（需含 MUSIC_U）" />
      <button class="ghost" @click="doImportCookie">导入</button>
    </div>
    <p v-if="error" class="err">{{ error }}</p>
    <div class="tools">
      <input v-model="q" placeholder="歌名 / 歌手 / 专辑" @keyup.enter="doSearch(true)" />
      <button class="ghost" :disabled="!!busy" @click="doSearch(true)">{{ busy || '搜索' }}</button>
    </div>
    <div class="search-tabs">
      <button :class="{ active: searchTab === 'song' }" @click="switchSearchTab('song')">歌曲</button>
      <button :class="{ active: searchTab === 'album' }" @click="switchSearchTab('album')">专辑</button>
    </div>
    <DownloadOptions source="netease" />
    <template v-if="searchTab === 'album' && !openedAlbum">
      <div class="plist-grid">
        <div v-for="a in albums" :key="a.id" class="plist-card" @click="openAlbum(a.id, a.name)">
          <div class="plist-cover" :style="a.cover ? { backgroundImage: `url(${a.cover})` } : {}">{{ a.songCount ?? '?' }} 首</div>
          <div class="plist-name" :title="a.name">{{ a.name }}</div>
          <div class="plist-sub">{{ a.artist }}</div>
        </div>
      </div>
      <div v-if="albumSearched && !albums.length" class="empty">未找到专辑</div>
      <div v-else-if="!albumSearched" class="empty">切换到「专辑」，输入关键词搜索专辑</div>
    </template>
    <div v-else-if="searchTab === 'album'" class="grid">
      <div class="songs-head">
        <button class="ghost" @click="closeAlbum()">‹ 返回专辑列表</button>
        <span class="songs-title">专辑 · {{ openedAlbum }}（{{ store.tracks.length }} 首）</span>
        <button
          v-if="openedAlbumBundle"
          class="ghost"
          :disabled="!store.tracks.length || queueing"
          title="下载该专辑全部曲目到专辑子目录（忽略当前勾选；档位按上方选择条）"
          @click="enqueueWholeAlbum()"
        >{{ albumButtonLabel }}</button>
      </div>
      <p v-if="notice" class="notice">{{ notice }}</p>
      <TrackGrid
        :tracks="store.tracks"
        :selected-ids="store.selectedIds"
        @toggle="store.toggle($event)"
        @select-all="store.selectAll()"
        @clear="store.clear()"
      />
    </div>
    <div v-else class="grid">
      <TrackGrid
        v-if="store.trackSource !== 'qq'"
        :tracks="store.tracks"
        :selected-ids="store.selectedIds"
        @toggle="store.toggle($event)"
        @select-all="store.selectAll()"
        @clear="store.clear()"
      />
      <div v-else class="empty">当前列表是 QQ 音乐搜索结果，请到「QQ 音乐」页查看 / 下载</div>
    </div>
  </div>
</template>

<style scoped>
.netease { display: flex; flex-direction: column; gap: 12px; }
.top { display: flex; align-items: center; gap: 12px; }
.top h2 { font-size: 18px; margin: 0; }
.who { font-size: 13px; color: #31c27c; font-weight: 600; }
button {
  padding: 6px 16px;
  font-size: 13px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
}
button.ghost:hover:not(:disabled) { border-color: #31c27c; color: #31c27c; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.import { display: flex; flex-direction: column; gap: 8px; }
.import textarea { resize: vertical; font-family: inherit; padding: 8px; border: 1px solid #d0d0d0; border-radius: 6px; }
.err { color: #d33; font-size: 13px; margin: 0; }
.notice { color: #31c27c; font-size: 13px; margin: 0; }
.tools { display: flex; gap: 8px; }
.tools input { flex: 1; padding: 6px 12px; border: 1px solid #d0d0d0; border-radius: 6px; font-size: 14px; }
.search-tabs { display: flex; gap: 6px; }
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
.empty { color: #888; font-size: 13px; padding: 20px 0; }
.songs-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.songs-title { font-size: 15px; font-weight: 700; }
</style>