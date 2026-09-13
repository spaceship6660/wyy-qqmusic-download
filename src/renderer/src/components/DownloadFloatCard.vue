<script setup lang="ts">
import type { UiQueueJob } from '../stores/download'

// 左上下载浮卡：有排队/进行中任务时常驻显示，可手动「隐藏」折叠成侧边小标签（下载不中断）。
// 点标题进我的下载；折叠态小标签点一下恢复。
defineProps<{ jobs: UiQueueJob[]; collapsed: boolean }>()
const emit = defineEmits<{ toggle: []; open: [] }>()

function stateText(j: UiQueueJob): string {
  if (j.state === 'queued') return '排队中'
  if (j.state === 'running') return `${Math.min(100, Math.max(0, j.progress))}%`
  return j.state
}
</script>

<template>
  <div v-if="jobs.length">
    <!-- 折叠态：贴左侧边的竖向小标签（下载继续，点击展开） -->
    <button v-if="collapsed" class="dl-tab" title="展开下载列表" @click="emit('toggle')">
      <span class="dl-tab-dot"></span>
      <span class="dl-tab-text">下载 {{ jobs.length }}</span>
    </button>

    <!-- 展开态：完整浮卡 -->
    <div v-else class="dl-float">
      <div class="dl-head">
        <span class="dl-title" title="前往我的下载" @click="emit('open')">下载中（{{ jobs.length }}）</span>
        <button class="dl-btn" @click="emit('toggle')">隐藏</button>
      </div>
      <div class="dl-list">
        <div v-for="j in jobs" :key="j.id" class="dl-row">
          <div class="dl-name" :title="j.artist ? `${j.name} - ${j.artist}` : j.name">
            {{ j.name }}<span v-if="j.artist" class="dl-artist"> - {{ j.artist }}</span>
          </div>
          <div class="dl-bar"><div class="dl-inner" :style="{ width: `${Math.min(100, Math.max(0, j.progress))}%` }"></div></div>
          <span class="dl-pct">{{ stateText(j) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dl-tab {
  position: fixed;
  left: 0;
  top: 44%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 8px;
  background: #31c27c;
  color: #fff;
  border: none;
  border-radius: 0 8px 8px 0;
  cursor: pointer;
  box-shadow: 2px 0 10px rgba(49, 194, 124, 0.35);
  z-index: 15;
  writing-mode: vertical-rl;
  font-size: 12px;
  font-weight: 700;
}
.dl-tab:hover { filter: brightness(1.06); }
.dl-tab-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #fff;
  animation: dl-pulse 1s infinite;
}
@keyframes dl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.dl-tab-text { letter-spacing: 1px; }
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
