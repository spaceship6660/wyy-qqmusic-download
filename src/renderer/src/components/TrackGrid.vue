<script setup lang="ts">
import type { UiTrack } from '../stores/download'

defineProps<{
  tracks: UiTrack[]
  selectedIds: Set<string>
}>()
const emit = defineEmits<{
  toggle: [id: string]
  selectAll: []
  clear: []
}>()

function durText(sec?: number): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
</script>

<template>
  <div class="track-grid">
    <div class="toolbar">
      <span class="count" v-if="tracks.length">共 {{ tracks.length }} 首，已选 {{ selectedIds.size }} 首</span>
      <span class="count" v-else>输入关键词或歌单链接开始搜索</span>
      <div class="toolbar-actions">
        <button :disabled="tracks.length === 0" @click="emit('selectAll')">全选</button>
        <button :disabled="selectedIds.size === 0" @click="emit('clear')">清空</button>
      </div>
    </div>
    <div class="grid" v-if="tracks.length">
      <article
        v-for="t in tracks"
        :key="t.id"
        class="card"
        :class="{ checked: selectedIds.has(t.id) }"
        @click="emit('toggle', t.id)"
      >
        <div class="cover-wrap">
          <img v-if="t.cover" class="cover" :src="t.cover" loading="lazy" alt="" />
          <div v-else class="cover cover-placeholder">♫</div>
          <span v-if="t.vip" class="vip-badge" title="VIP 歌曲（可能降级下载）">VIP</span>
          <span class="check" :class="{ on: selectedIds.has(t.id) }">{{ selectedIds.has(t.id) ? '✓' : '' }}</span>
        </div>
        <div class="info">
          <div class="name" :title="t.name">{{ t.name }}</div>
          <div class="artist" :title="t.artist">{{ t.artist || '未知歌手' }}</div>
          <div class="sub" v-if="t.album || durText(t.duration)">
            <span class="album" v-if="t.album">{{ t.album }}</span>
            <span class="dur" v-if="durText(t.duration)">{{ durText(t.duration) }}</span>
          </div>
        </div>
      </article>
    </div>
    <div v-else class="empty">暂无结果</div>
  </div>
</template>

<style scoped>
.toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.count { font-size: 13px; color: #666; }
.toolbar-actions { display: flex; gap: 8px; }
.toolbar-actions button {
  padding: 4px 14px;
  font-size: 13px;
  background: #fff;
  border: 1px solid #d0d0d0;
  border-radius: 5px;
  cursor: pointer;
}
.toolbar-actions button:hover:not(:disabled) { border-color: #31c27c; color: #31c27c; }
.toolbar-actions button:disabled { opacity: 0.4; cursor: not-allowed; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 14px;
}
.card {
  border: 1px solid #e3e3e3;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
  cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s;
}
.card:hover { box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1); }
.card.checked { border-color: #31c27c; box-shadow: 0 0 0 1px #31c27c inset; }
.cover-wrap { position: relative; aspect-ratio: 1/1; }
.cover { width: 100%; height: 100%; object-fit: cover; display: block; background: #f0f0f0; }
.cover-placeholder {
  display: flex; align-items: center; justify-content: center;
  font-size: 40px; color: #bbb;
}
.vip-badge {
  position: absolute; top: 6px; left: 6px;
  padding: 1px 6px;
  font-size: 11px; font-weight: 700; color: #fff;
  background: linear-gradient(90deg, #e8a13a, #d37a12);
  border-radius: 4px;
}
.check {
  position: absolute; bottom: 6px; right: 6px;
  width: 22px; height: 22px;
  display: flex; align-items: center; justify-content: center;
  border: 2px solid #fff;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.35);
  color: #fff; font-size: 13px; font-weight: 700;
}
.check.on { background: #31c27c; }
.info { padding: 8px 10px 10px; }
.name {
  font-size: 14px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.artist { font-size: 12px; color: #888; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { display: flex; justify-content: space-between; gap: 6px; margin-top: 4px; }
.album { font-size: 11px; color: #aaa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dur { font-size: 11px; color: #aaa; flex-shrink: 0; }
.empty { padding: 40px 0; text-align: center; color: #999; }
</style>