<script setup lang="ts">
import type { UiQueueJob } from '../stores/download'

defineProps<{ queue: UiQueueJob[] }>()

const STATE_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '下载中',
  done: '已完成',
  failed: '失败',
}

async function openDir(outputPath?: string): Promise<void> {
  if (!outputPath) return
  try {
    await window.api.invoke('fs:openDir', outputPath)
  } catch {
    // 主进程 fs:openDir 找不到路径时忽略，用户可自行打开下载目录
  }
}

function rowClass(state: string): string {
  return `row ${state}`
}
</script>

<template>
  <div class="queue-panel">
    <h3 class="title">下载队列（{{ queue.length }}）</h3>
    <div v-if="queue.length" class="list">
      <div v-for="j in queue" :key="j.id" :class="rowClass(j.state)">
        <div class="head">
          <span class="song-name" :title="j.name">{{ j.name }}</span>
          <span class="artist" v-if="j.artist">- {{ j.artist }}</span>
          <span class="state" :class="j.state">{{ STATE_TEXT[j.state] ?? j.state }}</span>
        </div>
        <div class="bar">
          <div class="bar-inner" :style="{ width: `${Math.min(100, Math.max(0, j.progress))}%` }"></div>
        </div>
        <div class="foot" v-if="j.downgraded || j.error || (j.state === 'done' && j.outputPath)">
          <span v-if="j.downgraded" class="downgrade">已降级为低品质</span>
          <span v-if="j.error" class="error">{{ j.error }}</span>
          <button v-if="j.state === 'done' && j.outputPath" class="open-btn" @click="openDir(j.outputPath)">打开目录</button>
        </div>
      </div>
    </div>
    <div v-else class="empty">队列为空——选中歌曲后点「下载选中」</div>
  </div>
</template>

<style scoped>
.queue-panel { margin-top: 24px; }
.title { font-size: 15px; margin: 0 0 10px; }
.list { display: flex; flex-direction: column; gap: 8px; }
.row {
  border: 1px solid #e3e3e3;
  border-radius: 8px;
  padding: 10px 12px;
  background: #fff;
}
.row.failed { border-color: #e57373; }
.row.done { border-color: #31c27c; }
.head { display: flex; align-items: baseline; gap: 8px; }
.song-name { font-size: 14px; font-weight: 600; max-width: 45%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.artist { font-size: 13px; color: #888; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.state { font-size: 12px; flex-shrink: 0; color: #666; }
.state.running { color: #2f7de1; }
.state.queued { color: #999; }
.state.done { color: #31c27c; }
.state.failed { color: #d32f2f; }
.bar { height: 6px; border-radius: 3px; background: #ececec; margin-top: 8px; overflow: hidden; }
.bar-inner { height: 100%; background: #31c27c; border-radius: 3px; transition: width 0.2s; }
.row.failed .bar-inner { background: #d32f2f; }
.foot { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
.downgrade {
  font-size: 12px; color: #b26a00;
  background: #fff3d6; border: 1px solid #f0d9a0;
  border-radius: 4px; padding: 1px 8px;
}
.error { font-size: 12px; color: #d32f2f; }
.open-btn {
  margin-left: auto;
  font-size: 12px; padding: 3px 12px;
  border: 1px solid #31c27c; color: #31c27c;
  background: #fff; border-radius: 5px; cursor: pointer;
}
.open-btn:hover { background: #e8faf0; }
.empty { padding: 24px 0; text-align: center; color: #999; font-size: 13px; }
</style>