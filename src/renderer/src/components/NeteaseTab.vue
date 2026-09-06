<script setup lang="ts">
import { ref, onMounted } from 'vue'
import TrackGrid from './TrackGrid.vue'
import DownloadOptions from './DownloadOptions.vue'
import { useDownloadStore } from '../stores/download'
import { api } from '../api'

// 网易云功能页：登录（扫码/手动导入）+ 搜索（歌曲 | 专辑）。
// 歌单浏览（我喜欢的/自建/收藏）已由左侧导航承担（App.vue 统一管理）；
// 搜索结果统一进 store.tracks，下载走窗口底部工具栏。
const store = useDownloadStore()
const loggedIn = ref(false)
const nickname = ref('')
const q = ref('')
const error = ref('')
const cookieText = ref('')
const showImport = ref(false)
const searchTab = ref<'song' | 'album'>('song')

interface NeAlbum { id: number; name: string; artist: string; cover: string; songCount?: number }
const albums = ref<NeAlbum[]>([])
const albumSearched = ref(false)

async function refreshAuth(): Promise<void> {
  const s: any = await api.invoke('ne:auth:status')
  loggedIn.value = !!s?.loggedIn
  if (loggedIn.value) {
    const acc: any = await api.invoke('ne:account')
    if (acc) nickname.value = acc.nickname ?? ''
  }
}

async function doSearch(): Promise<void> {
  error.value = ''
  const kw = q.value.trim()
  if (!kw) return
  if (searchTab.value === 'album') {
    albums.value = (await api.invoke<NeAlbum[]>('ne:albumSearch', kw)) ?? []
    albumSearched.value = true
    return
  }
  albums.value = []
  albumSearched.value = false
  const tracks: any = await api.invoke('ne:search', kw)
  if (!Array.isArray(tracks)) {
    error.value = '搜索失败，请稍后重试'
    return
  }
  store.setTracks(tracks)
  // 通知 App：当前列表 = 网易云搜索结果（底栏下载用网易云 source 与标题展示）
  window.dispatchEvent(new CustomEvent('ne:list-updated', { detail: `「${kw}」搜索` }))
}

async function openAlbum(id: number, title: string): Promise<void> {
  error.value = ''
  const tracks: any = (await api.invoke('ne:albumSongs', id)) ?? []
  if (!Array.isArray(tracks) || tracks.length === 0) {
    error.value = '专辑为空或加载失败'
    return
  }
  store.setTracks(tracks)
  window.dispatchEvent(new CustomEvent('ne:list-updated', { detail: `专辑 · ${title}` }))
}

async function openLogin(): Promise<void> {
  await api.invoke('ne:auth:open')
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
      <input v-model="q" placeholder="歌名 / 歌手 / 专辑" @keyup.enter="doSearch" />
      <button class="ghost" @click="doSearch">搜索</button>
    </div>
    <div class="search-tabs">
      <button :class="{ active: searchTab === 'song' }" @click="searchTab = 'song'">歌曲</button>
      <button :class="{ active: searchTab === 'album' }" @click="searchTab = 'album'">专辑</button>
    </div>
    <DownloadOptions v-if="searchTab === 'song'" />
    <template v-if="searchTab === 'album'">
      <div class="plist-grid">
        <div v-for="a in albums" :key="a.id" class="plist-card" @click="openAlbum(a.id, a.name)">
          <div class="plist-cover" :style="a.cover ? { backgroundImage: `url(${a.cover})` } : {}">{{ a.songCount ?? '?' }} 首</div>
          <div class="plist-name" :title="a.name">{{ a.name }}</div>
          <div class="plist-sub">{{ a.artist }}</div>
        </div>
      </div>
      <div v-if="albumSearched && !albums.length" class="empty">未找到专辑</div>
    </template>
    <div v-else class="grid">
      <TrackGrid :tracks="store.tracks" :selected-ids="store.selectedIds" @toggle="store.toggle($event)" />
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
</style>