<script setup lang="ts">
import type { UiQueueJob } from '../stores/download'

// 左上下载浮卡：有进行中任务时悬浮显示当前曲目与进度，可收起；点标题进我的下载
defineProps<{ jobs: UiQueueJob[]; collapsed: boolean }>()
const emit = defineEmits<{ toggle: []; open: [] }>()

function stateText(j: UiQueueJob): string {
  if (j.state === 'queued') return '等待中'
  if (j.state === 'running') return `${Math.min(100, Math.max(0, j.progress))}%`
  return j.state
}
</script>

<template>
  <div v-if="jobs.length" class="dl-float">
    <div class="dl-head">
      <span class="dl-title" @click="emit('open')" title="前往我的下载">下载中（{{ jobs.length }}）</span>
      <button class="dl-btn" @click="emit('toggle')">{{ collapsed ? '展开' : '收起' }}</button>
    </div>
    <div v-if="!collapsed" class="dl-list">
      <div v-for="j in jobs" :key="j.id" class="dl-row">
        <div class="dl-name" :title="j.artist ? `${j.name} - ${j.artist}` : j.name">
          {{ j.name }}<span v-if="j.artist" class="dl-artist"> - {{ j.artist }}</span>
        </div>
        <div class="dl-bar"><div class="dl-inner" :style="{ width: `${Math.min(100, Math.max(0, j.progress))}%` }"></div></div>
        <span class="dl-pct">{{ stateText(j) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dl-float {
  position: fixed;
  left: 202px;
  top: 12px;
  width: 320px;
  max-width: calc(100vw - 220px);
  background: #fff;
  border: 1px solid #e3e6ea;
  border-radius: 10px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.12);
  z-index: 15;
  overflow: hidden;
}
.dl-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: #f0faf4;
}
.dl-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 700;
  color: #31c27c;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dl-title:hover { text-decoration: underline; }
.dl-btn {
  flex-shrink: 0;
  font-size: 12px;
  color: #666;
  background: #fff;
  border: 1px solid #d0d0d0;
  border-radius: 5px;
  padding: 2px 10px;
  cursor: pointer;
}
.dl-btn:hover { border-color: #31c27c; color: #31c27c; }
.dl-list { max-height: 260px; overflow-y: auto; padding: 6px 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.dl-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.dl-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #333; }
.dl-artist { color: #999; }
.dl-bar { width: 70px; flex-shrink: 0; height: 5px; background: #eef0f2; border-radius: 3px; overflow: hidden; }
.dl-inner { height: 100%; background: #31c27c; transition: width 0.3s; }
.dl-pct { flex-shrink: 0; width: 44px; text-align: right; color: #999; }
</style>
