<script setup lang="ts">
import { ref, onMounted } from 'vue'
import TrackGrid from './TrackGrid.vue'
import DownloadOptions from './DownloadOptions.vue'
import { useDownloadStore } from '../stores/download'
import type { UiTrack } from '../stores/download'
import { api } from '../api'

// 网易云功能页：登录（扫码/手动导入）+ 搜索（歌曲 | 专辑）。
// 歌单浏览（我喜欢的/自建/收藏）已由左侧导航承担（App.vue 统一管理）；
// 搜索/专辑结果内联展示在本页（歌曲/专辑 tab 常驻，不再跳走），下载走窗口底部工具栏。
const store = useDownloadStore()
const loggedIn = ref(false)
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

async function refreshAuth(): Promise<void> {
  const s: any = await api.invoke('ne:auth:status')
  loggedIn.value = !!s?.loggedIn
  if (loggedIn.value) {
    const acc: any = await api.invoke('ne:account')
    if (acc) nickname.value = acc.nickname ?? ''
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
      openedAlbum.value = ''
      store.setTracks([...hit], 'netease')
      return
    }
  }
  if (!force && searchTab.value === 'album') {
    const hit = neAlbumCache.get(kw)
    if (hit) {
      albums.value = hit
      albumSearched.value = true
      openedAlbum.value = ''
      return
    }
  }
  busy.value = '搜索中…'
  try {
    if (searchTab.value === 'album') {
      const found = (await api.invoke<NeAlbum[]>('ne:albumSearch', kw)) ?? []
      albums.value = found
      albumSearched.value = true
      openedAlbum.value = ''
      cachePut(neAlbumCache, kw, found)
      return
    }
    albums.value = []
    albumSearched.value = false
    openedAlbum.value = ''
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
    const tracks: any = (await api.invoke('ne:albumSongs', id)) ?? []
    if (!Array.isArray(tracks) || tracks.length === 0) {
      error.value = '专辑为空或加载失败'
      return
    }
    // 内联展示专辑歌曲（不再跳走；返回按钮回到专辑列表）
    store.setTracks(tracks, 'netease')
    openedAlbum.value = title
  } finally {
    busy.value = ''
  }
}

/** 歌曲 | 专辑 tab 切换：有关键词时自动按当前 tab 搜索（缓存命中零请求） */
function switchSearchTab(t: 'song' | 'album'): void {
  searchTab.value = t
  if (t === 'song') openedAlbum.value = ''
  if (!q.value.trim() || busy.value) return
  void doSearch(false)
}

async function openLogin(): Promise<void> {
  await api.invoke('ne:auth:open')
}

/** 退出登录：清本机网易云凭证，通知 App 收起歌单导航 */
async function logout(): Promise<void> {
  await api.invoke('ne:auth:clear')
  loggedIn.value = false
  nickname.value = ''
  window.dispatchEvent(new CustomEvent('ne:authChanged'))
}

async function doImportCookie(): Promise<void> {
  // 手动导入用内联 textarea，不用 window.prompt（Electron 不实现它）
  const ok: boolean = await api.invoke('ne:auth:importCookie', cookieText.value)
  if (ok) {
    showImport.value = false
    void refreshAuth()
    window.dispatchEvent(new CustomEvent('ne:authChanged')) // 触发 App 刷新歌单
  } else {
    error.value = 'Cookie 无效（需含 MUSIC_U）'
  }
}

onMounted(() => {
  void refreshAuth()
  api.on('ne:authChanged', () => void refreshAuth())
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
    <DownloadOptions v-if="searchTab === 'song'" />
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
        <button class="ghost" @click="openedAlbum = ''">‹ 返回专辑列表</button>
        <span class="songs-title">专辑 · {{ openedAlbum }}（{{ store.tracks.length }} 首）</span>
      </div>
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