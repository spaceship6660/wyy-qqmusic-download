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

// 左侧导航：QQ 音乐下载 / 网易云下载 同级两块；我的下载、解密、设置并列
const tab = ref<'qq' | 'netease' | 'download' | 'decrypt' | 'settings'>('qq')
const store = useDownloadStore()
const q = ref('')
// 入队中短暂态（按钮按压反馈：下载中 → 已加入 → 复原）
const queueing = ref(false)

// 窗口底部固定工具栏：当前 tab 的选中数 + 进行中任务数（任何页面都可见）
const selectedCount = computed(() => (tab.value === 'qq' ? store.selectedIds.size : tab.value === 'netease' ? store.neSelectedIds.size : 0))
const activeCount = computed(() => store.queue.filter((j) => j.state === 'queued' || j.state === 'running').length)
const doneCount = computed(() => store.queue.filter((j) => j.state === 'done' || j.state === 'failed').length)

async function doSearch(): Promise<void> {
  const text = q.value.trim()
  if (!text) return
  try {
    // 歌单/专辑/单曲链接 → 解析抓取；否则走搜索
    if (/y\.qq\.com\/n\/ryqq\/(songDetail|playlist|albumDetail)/.test(text)) {
      const res: any = await api.invoke('qq:linkTracks', text)
      if (res?.tracks?.length) store.setTracks(res.tracks)
      else window.alert('未能解析该链接，请确认是 QQ 音乐歌单 / 专辑 / 单曲链接')
      return
    }
    const tracks: any = await api.invoke('qq:search', text)
    if (!Array.isArray(tracks)) window.alert('搜索失败，请稍后重试')
    else store.setTracks(tracks)
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e))
  }
}

/** 底部工具栏下载按钮：按当前 tab 入队；成功后自动切到「我的下载」页（可见反馈） */
async function downloadSelected(): Promise<void> {
  if (queueing.value || selectedCount.value === 0) return
  queueing.value = true
  try {
    if (tab.value === 'qq') {
      const selected = store.tracks.filter((t) => store.selectedIds.has(t.id))
      if (selected.length) {
        await api.invoke('dl:enqueue', {
          tracks: selected, quality: store.quality, lyricMode: store.lyricMode, source: 'qq',
        })
        store.clear()
        tab.value = 'download' // 入队成功 → 直接看到下载页（明确反馈）
      }
    } else if (tab.value === 'netease') {
      // 入队执行在 NeteaseTab（选中集在 store.neSelectedIds）；成功后它会派发
      // ne:download-done 通知本组件切页
      window.dispatchEvent(new CustomEvent('ne:download-selected'))
    }
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e))
  } finally {
    queueing.value = false
  }
}

onMounted(() => {
  window.addEventListener('ne:download-done', () => {
    tab.value = 'download'
  })
})

onMounted(() => {
  void api.invoke('auth:status').then((s: any) => store.setLogin(!!s?.loggedIn, s?.uin ?? ''))
  // 设置的码率/歌词模式只是默认值：启动时载入 store 作为当前下载选择
  void api.invoke('settings:get').then((s: any) => {
    if (s?.quality) store.setQuality(s.quality)
    if (s?.lyricMode) store.setLyricMode(s.lyricMode)
  })
  api.on('dl:jobStart', store.onQueueEvent)
  api.on('dl:progress', store.onQueueEvent)
  api.on('dl:done', store.onQueueEvent)
  api.on('dl:failed', store.onQueueEvent)
})
</script>

<template>
  <div class="app">
    <aside class="sidebar">
      <h1>音乐下载器</h1>
      <nav>
        <button :class="{ active: tab === 'qq' }" @click="tab = 'qq'">QQ 音乐下载</button>
        <button :class="{ active: tab === 'netease' }" @click="tab = 'netease'">网易云下载</button>
        <button :class="{ active: tab === 'download' }" @click="tab = 'download'">我的下载</button>
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
        <TrackGrid
          :tracks="store.tracks"
          :selected-ids="store.selectedIds"
          @toggle="store.toggle($event)"
          @select-all="store.selectAll()"
          @clear="store.clear()"
        />
      </section>
      <section v-else-if="tab === 'netease'"><NeteaseTab /></section>
      <section v-else-if="tab === 'download'"><DownloadPage /></section>
      <section v-else-if="tab === 'decrypt'"><DecryptTab /></section>
      <section v-else><SettingsPanel /></section>
    </main>

    <!-- 窗口底部固定工具栏：下载按钮永远可见（不用翻列表）；按下即有反馈 -->
    <footer class="toolbar">
      <button
        class="download-btn"
        :class="{ active: selectedCount > 0, queueing }"
        :disabled="selectedCount === 0 || queueing"
        @click="downloadSelected"
      >
        {{ queueing ? '加入队列中…' : `下载选中 (${selectedCount})` }}
        <span v-if="tab === 'qq' && store.quality" class="q-badge">{{ store.quality }}</span>
      </button>
      <button class="count-btn" :class="{ has: activeCount > 0 }" @click="tab = 'download'">
        {{ activeCount > 0 ? `下载中 ${activeCount}` : `已完成 ${doneCount}` }}
      </button>
    </footer>
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
/* 底栏贯穿全宽后为 sidebar 底部（登录区）留出空间 */
.sidebar { padding-bottom: 72px; }
.content { flex: 1; padding: 20px 24px 76px; min-width: 0; }

/* 窗口底部固定工具栏（fixed 于视口底部，翻列表始终可见） */
.toolbar {
  position: fixed;
  left: 0; /* 贯穿全宽：覆盖 sidebar 底部，避免视觉断档（2026-09-06 用户反馈错位） */
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