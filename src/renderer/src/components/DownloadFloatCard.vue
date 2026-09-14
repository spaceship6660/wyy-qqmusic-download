<script setup lang="ts">
import type { UiQueueJob } from '../stores/download'

// 侧栏下载卡：挂在左侧导航下方空白区（不再悬浮挡内容）。
// 有排队/进行中任务时常驻；可收起成一条细栏（下载不中断），点标题进我的下载。
defineProps<{ jobs: UiQueueJob[]; collapsed: boolean }>()
const emit = defineEmits<{ toggle: []; open: []; cancel: [id: string] }>()

function stateText(j: UiQueueJob): string {
  if (j.state === 'queued') return '排队中'
  if (j.state === 'running') return `${Math.min(100, Math.max(0, j.progress))}%`
  return j.state
}
</script>

<template>
  <div v-if="jobs.length" class="side-dl">
    <!-- 收起态：一条细栏 -->
    <button v-if="collapsed" class="side-dl-slim" title="展开下载列表" @click="emit('toggle')">
      <span class="side-dl-dot"></span>
      <span class="side-dl-count">下载 {{ jobs.length }}</span>
      <span class="side-dl-arrow">›</span>
    </button>

    <!-- 展开态 -->
    <div v-else class="side-dl-card">
      <div class="side-dl-head">
        <span class="side-dl-title" title="前往我的下载" @click="emit('open')">下载中（{{ jobs.length }}）</span>
        <button class="side-dl-btn" @click="emit('toggle')">收起</button>
      </div>
      <div class="side-dl-list">
        <div v-for="j in jobs" :key="j.id" class="side-dl-row">
          <div class="side-dl-name" :title="j.artist ? `${j.name} - ${j.artist}` : j.name">{{ j.name }}</div>
          <div class="side-dl-sub">
            <div class="side-dl-bar"><div class="side-dl-inner" :style="{ width: `${Math.min(100, Math.max(0, j.progress))}%` }"></div></div>
            <span class="side-dl-pct">{{ stateText(j) }}</span>
            <button class="side-dl-x" title="取消下载" @click="emit('cancel', j.id)">✕</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.side-dl { width: 100%; }
.side-dl-slim {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  background: #f0faf4;
  border: 1px solid #d7efe0;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  color: #31c27c;
}
.side-dl-slim:hover { background: #e4f6ec; }
.side-dl-dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #31c27c;
  animation: side-dl-pulse 1s infinite;
}
@keyframes side-dl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.side-dl-count { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-dl-arrow { color: #999; font-size: 14px; }
.side-dl-card {
  background: #fff;
  border: 1px solid #e3e6ea;
  border-radius: 10px;
  overflow: hidden;
}
.side-dl-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: #f0faf4;
}
.side-dl-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 700;
  color: #31c27c;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-dl-title:hover { text-decoration: underline; }
.side-dl-btn {
  flex-shrink: 0;
  font-size: 11px;
  color: #666;
  background: #fff;
  border: 1px solid #d0d0d0;
  border-radius: 5px;
  padding: 1px 8px;
  cursor: pointer;
}
.side-dl-btn:hover { border-color: #31c27c; color: #31c27c; }
.side-dl-list { max-height: 220px; overflow-y: auto; padding: 6px 8px 8px; display: flex; flex-direction: column; gap: 8px; }
.side-dl-row { display: flex; flex-direction: column; gap: 3px; font-size: 12px; min-width: 0; }
.side-dl-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #333; }
.side-dl-sub { display: flex; align-items: center; gap: 6px; }
.side-dl-bar { flex: 1; min-width: 0; height: 5px; background: #eef0f2; border-radius: 3px; overflow: hidden; }
.side-dl-inner { height: 100%; background: #31c27c; transition: width 0.3s; }
.side-dl-pct { flex-shrink: 0; color: #999; font-size: 11px; }
.side-dl-x {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  padding: 0;
  font-size: 10px;
  line-height: 1;
  color: #bbb;
  background: transparent;
  border: none;
  border-radius: 50%;
  cursor: pointer;
}
.side-dl-x:hover { color: #d32f2f; background: #fdecea; }
</style>
