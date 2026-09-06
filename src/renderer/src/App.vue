<script setup lang="ts">
import { ref, onMounted } from 'vue'
import SearchBar from './components/SearchBar.vue'
import TrackGrid from './components/TrackGrid.vue'
import QueuePanel from './components/QueuePanel.vue'
import LoginButton from './components/LoginButton.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import NeteaseTab from './components/NeteaseTab.vue'
import DownloadOptions from './components/DownloadOptions.vue'
import { useDownloadStore } from './stores/download'

// 左侧导航：QQ 音乐下载 / 网易云下载 同级两块；解密、设置并列
const tab = ref<'qq' | 'netease' | 'decrypt' | 'settings'>('qq')
const store = useDownloadStore()
const q = ref('')

async function doSearch(): Promise<void> {
  const text = q.value.trim()
  if (!text) return
  try {
    // 歌单/专辑/单曲链接 → 解析抓取；否则走搜索
    if (/y\.qq\.com\/n\/ryqq\/(songDetail|playlist|albumDetail)/.test(text)) {
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
  if (selected.length) {
    void window.api.invoke('dl:enqueue', {
      tracks: selected, quality: store.quality, lyricMode: store.lyricMode, source: 'qq',
    })
  }
  store.clear()
}

onMounted(() => {
  void window.api.invoke('auth:status').then((s: any) => store.setLogin(!!s?.loggedIn, s?.uin ?? ''))
  // 设置的码率/歌词模式只是默认值：启动时载入 store 作为当前下载选择
  void window.api.invoke('settings:get').then((s: any) => {
    if (s?.quality) store.setQuality(s.quality)
    if (s?.lyricMode) store.setLyricMode(s.lyricMode)
  })
  window.api.on('dl:jobStart', store.onQueueEvent)
  window.api.on('dl:progress', store.onQueueEvent)
  window.api.on('dl:done', store.onQueueEvent)
  window.api.on('dl:failed', store.onQueueEvent)
})
</script>

<template>
  <div class="app">
    <aside class="sidebar">
      <h1>音乐下载器</h1>
      <nav>
        <button :class="{ active: tab === 'qq' }" @click="tab = 'qq'">QQ 音乐下载</button>
        <button :class="{ active: tab === 'netease' }" @click="tab = 'netease'">网易云下载</button>
        <button :class="{ active: tab === 'decrypt' }" @click="tab = 'decrypt'">解密</button>
        <button :class="{ active: tab === 'settings' }" @click="tab = 'settings'">设置</button>
      </nav>
      <div class="sidebar-foot">
        <LoginButton
          :logged-in="store.loggedIn"
          :uin="store.uin"
          @changed="(s: any) => store.setLogin(s.loggedIn, s.uin ?? '')"
        />
      </div>
    </aside>
    <main class="content">
      <section v-if="tab === 'qq'">
        <SearchBar v-model="q" @search="doSearch" />
        <DownloadOptions />
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
      <section v-else-if="tab === 'netease'"><NeteaseTab /></section>
      <section v-else-if="tab === 'decrypt'">解密（后续计划）</section>
      <section v-else><SettingsPanel /></section>
    </main>
  </div>
</template>

<style>
body { margin: 0; font-family: system-ui, 'Microsoft YaHei', sans-serif; background: #f7f8fa; color: #222; }
.app { display: flex; min-height: 100vh; }
.sidebar {
  width: 190px;
  flex-shrink: 0;
  padding: 16px 12px;
  background: #fff;
  border-right: 1px solid #e6e8ec;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.sidebar h1 { font-size: 17px; margin: 0; padding: 0 8px; }
.sidebar nav { display: flex; flex-direction: column; gap: 6px; }
.sidebar nav button {
  padding: 10px 14px;
  font-size: 14px;
  text-align: left;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  color: #444;
}
.sidebar nav button:hover { background: #f0f3f5; }
.sidebar nav button.active {
  font-weight: 700;
  color: #fff;
  background: #31c27c;
}
.sidebar-foot { margin-top: auto; }
.content { flex: 1; padding: 20px 24px; min-width: 0; }
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