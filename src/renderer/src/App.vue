<script setup lang="ts">
import { ref, onMounted } from 'vue'
import SearchBar from './components/SearchBar.vue'
import TrackGrid from './components/TrackGrid.vue'
import QueuePanel from './components/QueuePanel.vue'
import LoginButton from './components/LoginButton.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import { useDownloadStore } from './stores/download'

const tab = ref<'download' | 'decrypt' | 'settings'>('download')
const store = useDownloadStore()
const q = ref('')

async function doSearch(): Promise<void> {
  const text = q.value.trim()
  if (!text) return
  try {
    // 歌单/专辑/单曲链接 → 解析抓取；否则走搜索
    if (/y\.qq\.com\/(n\/ryqq\/(songDetail|playlist|albumDetail)|music\.qq\.com)/.test(text)) {
      const res: any = await window.api.invoke('qq:linkTracks', text)
      if (res?.tracks?.length) store.setTracks(res.tracks)
      else window.alert('未能解析该链接，请确认是 QQ 音乐歌单 / 专辑 / 单曲链接')
      return
    }
    const tracks: any = await window.api.invoke('qq:search', text)
    if (!Array.isArray(tracks)) window.alert('搜索失败，请稍后重试')
    else store.setTracks(tracks)
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e))
  }
}

function enqueue(): void {
  const selected = store.tracks.filter((t) => store.selectedIds.has(t.id))
  if (selected.length) void window.api.invoke('dl:enqueue', selected, store.quality)
  store.clear()
}

onMounted(() => {
  void window.api.invoke('auth:status').then((s: any) => store.setLogin(!!s?.loggedIn, s?.uin ?? ''))
  window.api.on('dl:jobStart', store.onQueueEvent)
  window.api.on('dl:progress', store.onQueueEvent)
  window.api.on('dl:done', store.onQueueEvent)
  window.api.on('dl:failed', store.onQueueEvent)
})
</script>

<template>
  <div class="app">
    <header>
      <h1>QQ 音乐下载器</h1>
      <LoginButton
        :logged-in="store.loggedIn"
        :uin="store.uin"
        @changed="(s: any) => store.setLogin(s.loggedIn, s.uin ?? '')"
      />
      <nav>
        <button :class="{ active: tab === 'download' }" @click="tab = 'download'">下载</button>
        <button :class="{ active: tab === 'decrypt' }" @click="tab = 'decrypt'">解密</button>
        <button :class="{ active: tab === 'settings' }" @click="tab = 'settings'">设置</button>
      </nav>
    </header>
    <main>
      <section v-if="tab === 'download'">
        <SearchBar v-model="q" @search="doSearch" />
        <div class="action-row">
          <button @click="store.selectAll()">全选</button>
          <button @click="store.clear()">清空</button>
          <button class="primary" :disabled="store.selectedIds.size === 0" @click="enqueue">
            下载选中 ({{ store.selectedIds.size }}) - {{ store.quality }}
          </button>
        </div>
        <TrackGrid
          :tracks="store.tracks"
          :selected-ids="store.selectedIds"
          @toggle="store.toggle($event)"
          @select-all="store.selectAll()"
          @clear="store.clear()"
        />
        <QueuePanel :queue="store.queue" />
      </section>
      <section v-else-if="tab === 'decrypt'">解密（后续计划）</section>
      <section v-else><SettingsPanel /></section>
    </main>
  </div>
</template>

<style>
body { margin: 0; font-family: system-ui, 'Microsoft YaHei', sans-serif; background: #f7f8fa; color: #222; }
.app { padding: 16px; }
header { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; margin-bottom: 16px; }
header h1 { font-size: 20px; margin: 0; }
nav { margin-left: auto; display: flex; gap: 8px; }
nav button {
  padding: 6px 18px;
  font-size: 14px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  color: #444;
}
nav button.active {
  font-weight: 700;
  color: #fff;
  background: #31c27c;
  border-color: #31c27c;
}
.action-row { display: flex; gap: 8px; margin-bottom: 12px; }
.action-row button {
  padding: 6px 16px;
  font-size: 13px;
  background: #fff;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  cursor: pointer;
}
.action-row button.primary {
  background: #31c27c;
  color: #fff;
  border-color: #31c27c;
}
.action-row button.primary:disabled { background: #b9c9c0; border-color: #b9c9c0; cursor: not-allowed; }
.action-row button:not(.primary):hover { border-color: #31c27c; color: #31c27c; }
.action-row button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>