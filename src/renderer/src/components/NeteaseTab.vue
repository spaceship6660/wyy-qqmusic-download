<script setup lang="ts">
import { ref, onMounted } from 'vue'
import TrackGrid from './TrackGrid.vue'
import { useDownloadStore } from '../stores/download'

interface NePlaylist { id: number; name: string; liked: boolean; trackCount: number }
interface NeTrack { id: string; name: string; artist: string; album: string; cover: string; vip?: boolean }

const store = useDownloadStore()
const loggedIn = ref(false)
const nickname = ref('')
const playlists = ref<NePlaylist[]>([])
const currentTracks = ref<NeTrack[]>([])
const selectedIds = ref(new Set<string>())
const q = ref('')
const error = ref('')
const cookieText = ref('')
const showImport = ref(false)

async function refreshAuth(): Promise<void> {
  const s: any = await window.api.invoke('ne:auth:status')
  loggedIn.value = s.loggedIn
  if (s.loggedIn) {
    const acc: any = await window.api.invoke('ne:account')
    if (acc) {
      nickname.value = acc.nickname
      void loadPlaylists(acc.uid)
    }
  }
}

async function loadPlaylists(uid: number): Promise<void> {
  const pls: any = await window.api.invoke('ne:playlists', uid)
  playlists.value = pls ?? []
}

async function openPlaylist(id: number): Promise<void> {
  error.value = ''
  const r: any = await window.api.invoke('ne:playlist', String(id))
  currentTracks.value = r.tracks ?? []
  selectedIds.value = new Set()
  if (r.requiresLogin && !loggedIn.value) error.value = '未登录，登录后查看完整曲目'
}

async function doSearch(): Promise<void> {
  error.value = ''
  const tracks: any = await window.api.invoke('ne:search', q.value.trim())
  currentTracks.value = tracks ?? []
  selectedIds.value = new Set()
}

function toggleSel(id: string): void {
  const s = new Set(selectedIds.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selectedIds.value = s
}

function selectAll(): void {
  selectedIds.value = new Set(currentTracks.value.map((t) => t.id))
}

function enqueue(): void {
  const selected = currentTracks.value.filter((t) => selectedIds.value.has(t.id))
  if (selected.length) {
    void window.api.invoke('dl:enqueue', { tracks: selected, quality: store.quality, source: 'netease' })
    selectedIds.value = new Set()
  }
}

async function openLogin(): Promise<void> {
  await window.api.invoke('ne:auth:open')
}

async function doImportCookie(): Promise<void> {
  // 手动导入用内联 textarea，不用 window.prompt（Electron 不实现它）
  const ok: boolean = await window.api.invoke('ne:auth:importCookie', cookieText.value)
  if (ok) {
    cookieText.value = ''
    showImport.value = false
    void refreshAuth()
  } else {
    error.value = 'Cookie 无效（需含 MUSIC_U）'
  }
}

onMounted(() => {
  void refreshAuth()
  window.api.on('ne:authChanged', () => void refreshAuth())
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
      <input v-model="q" placeholder="歌名 / 歌手" @keyup.enter="doSearch" />
      <button class="ghost" @click="doSearch">搜索</button>
    </div>
    <aside v-if="loggedIn" class="playlists">
      <h3>我的歌单</h3>
      <ul>
        <li v-for="pl in playlists" :key="pl.id" @click="openPlaylist(pl.id)">
          {{ pl.liked ? '❤ ' : '' }}{{ pl.name }}（{{ pl.trackCount }}）
        </li>
      </ul>
    </aside>
    <div class="grid">
      <div class="action-row">
        <button class="primary" :disabled="selectedIds.size === 0" @click="enqueue">
          下载选中 ({{ selectedIds.size }})
        </button>
        <button class="ghost" :disabled="currentTracks.length === 0" @click="selectAll">全选</button>
      </div>
      <TrackGrid :tracks="currentTracks" :selected-ids="selectedIds" @toggle="toggleSel" />
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
button.primary { background: #31c27c; color: #fff; border-color: #31c27c; }
button.primary:disabled { background: #b9c9c0; border-color: #b9c9c0; cursor: not-allowed; }
button.ghost:hover:not(:disabled) { border-color: #31c27c; color: #31c27c; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.import { display: flex; flex-direction: column; gap: 8px; }
.import textarea { resize: vertical; font-family: inherit; padding: 8px; border: 1px solid #d0d0d0; border-radius: 6px; }
.err { color: #d33; font-size: 13px; margin: 0; }
.tools { display: flex; gap: 8px; }
.tools input { flex: 1; padding: 6px 12px; border: 1px solid #d0d0d0; border-radius: 6px; font-size: 14px; }
.playlists ul { list-style: none; margin: 0; padding: 0; }
.playlists li {
  padding: 6px 10px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 6px;
}
.playlists li:hover { background: #eefaf4; color: #31c27c; }
.action-row { display: flex; gap: 8px; }
</style>