<script setup lang="ts">
import { computed } from 'vue'
import type { UiQueueJob } from '../stores/download'
import { useDownloadStore } from '../stores/download'
import { api } from '../api'

const store = useDownloadStore()

// 「我的下载」页：进行中（排队/下载）+ 已完成（完成/失败）两段
const active = computed(() => store.queue.filter((j) => j.state === 'queued' || j.state === 'running'))
const doneList = computed(() => store.queue.filter((j) => j.state === 'done' || j.state === 'failed'))

const STATE_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '下载中',
  done: '已完成',
  failed: '失败',
}
const SOURCE_TEXT: Record<string, string> = { qq: 'QQ', netease: '网易云' }

async function openDir(outputPath?: string): Promise<void> {
  if (!outputPath) return
  try {
    await api.invoke('fs:openDir', outputPath)
  } catch {
    // 主进程 fs:openDir 找不到路径时忽略，用户可自行打开下载目录
  }
}
</script>

<template>
  <div class="download-page">
    <header class="top">
      <h2>我的下载</h2>
      <button v-if="doneList.length" class="ghost" @click="store.clearDone()">清除已完成</button>
    </header>

    <h3 class="sec" v-if="active.length">进行中（{{ active.length }}）</h3>
    <div v-if="active.length" class="list">
      <div v-for="j in active" :key="j.id" class="row">
        <div class="head">
          <span class="src" :class="j.source">{{ SOURCE_TEXT[j.source] ?? j.source }}</span>
          <span class="song-name" :title="j.name">{{ j.name }}</span>
          <span class="artist" v-if="j.artist">- {{ j.artist }}</span>
          <span class="state" :class="j.state">{{ STATE_TEXT[j.state] ?? j.state }}</span>
        </div>
        <div class="bar"><div class="bar-inner" :style="{ width: `${Math.min(100, Math.max(0, j.progress))}%` }"></div></div>
        <div class="foot" v-if="j.downgraded || j.error">
          <span v-if="j.downgraded" class="downgrade">已降级为低品质</span>
          <span v-if="j.error" class="error">{{ j.error }}</span>
        </div>
      </div>
    </div>

    <h3 class="sec">已完成（{{ doneList.length }}）</h3>
    <div v-if="doneList.length" class="list">
      <div v-for="j in doneList" :key="j.id" class="row" :class="j.state">
        <div class="head">
          <span class="src" :class="j.source">{{ SOURCE_TEXT[j.source] ?? j.source }}</span>
          <span class="song-name" :title="j.name">{{ j.name }}</span>
          <span class="artist" v-if="j.artist">- {{ j.artist }}</span>
          <span class="state" :class="j.state">{{ STATE_TEXT[j.state] ?? j.state }}</span>
        </div>
        <div class="foot" v-if="j.error || j.downgraded || (j.state === 'done' && j.outputPath)">
          <span v-if="j.downgraded" class="downgrade">已降级为低品质</span>
          <span v-if="j.error" class="error">{{ j.error }}</span>
          <button v-if="j.state === 'done' && j.outputPath" class="open-btn" @click="openDir(j.outputPath)">打开目录</button>
        </div>
      </div>
    </div>
    <div v-else class="empty">还没有下载记录——在 QQ 音乐 / 网易云页勾选歌曲后点「下载选中」</div>
  </div>
</template>

<style scoped>
.download-page { display: flex; flex-direction: column; gap: 10px; }
.top { display: flex; align-items: center; gap: 12px; }
.top h2 { font-size: 18px; margin: 0; }
.sec { font-size: 14px; margin: 4px 0 0; color: #555; }
.list { display: flex; flex-direction: column; gap: 8px; }
.row { background: #fff; border-radius: 8px; padding: 10px 12px; }
.row.failed { border-left: 3px solid #d33; }
.row.done { border-left: 3px solid #31c27c; }
.head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.src { font-size: 11px; color: #31c27c; border: 1px solid #31c27c; border-radius: 4px; padding: 1px 5px; flex-shrink: 0; }
.src.netease { color: #e60026; border-color: #e60026; }
.song-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.artist { color: #777; flex-shrink: 0; }
.state { margin-left: auto; font-size: 12px; color: #666; flex-shrink: 0; }
.state.running { color: #31c27c; }
.state.failed { color: #d33; }
.bar { height: 5px; background: #eef0f2; border-radius: 3px; margin: 8px 0 4px; overflow: hidden; }
.bar-inner { height: 100%; background: #31c27c; transition: width 0.3s; }
.foot { display: flex; gap: 10px; font-size: 12px; }
.downgrade { color: #d9930e; }
.error { color: #d32f2f; word-break: break-all; }
.foot { display: flex; align-items: center; gap: 10px; font-size: 12px; min-height: 22px; }
.open-btn { margin-left: auto; border: 1px solid #d0d0d0; border-radius: 5px; background: #fff; font-size: 12px; padding: 2px 10px; cursor: pointer; }
.open-btn:hover { border-color: #31c27c; color: #31c27c; }
.empty { color: #888; font-size: 13px; padding: 18px 0; }
button.ghost { border: 1px solid #d0d0d0; border-radius: 6px; background: #fff; font-size: 12px; padding: 3px 12px; cursor: pointer; }
button.ghost:hover { border-color: #d33; color: #d33; }
</style>