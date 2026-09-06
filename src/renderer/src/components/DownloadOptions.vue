<script setup lang="ts">
import { useDownloadStore } from '../stores/download'

// 下载时选择器：码率 + 歌词模式（本次下载批次生效；设置页存的是默认值，
// 启动时由 App.vue 从 settings:get 载入 store 作为当前选择）
const store = useDownloadStore()

const QUALITIES: Array<{ v: 'flac' | 'ape' | '320' | '128' | 'm4a'; label: string }> = [
  { v: 'flac', label: '无损' },
  { v: 'ape', label: 'APE' },
  { v: '320', label: '320k' },
  { v: '128', label: '128k' },
  { v: 'm4a', label: 'm4a' },
]
const LYRIC_MODES: Array<{ v: 'both' | 'embed' | 'lrc' | 'none'; label: string }> = [
  { v: 'both', label: '内嵌+另存' },
  { v: 'embed', label: '仅内嵌' },
  { v: 'lrc', label: '仅另存' },
  { v: 'none', label: '不保存' },
]
</script>

<template>
  <div class="download-options">
    <span class="label">码率</span>
    <label v-for="q in QUALITIES" :key="q.v" class="opt">
      <input type="radio" name="quality" :value="q.v" :checked="store.quality === q.v" @change="store.setQuality(q.v)" />
      {{ q.label }}
    </label>
    <span class="label">歌词</span>
    <label v-for="m in LYRIC_MODES" :key="m.v" class="opt">
      <input type="radio" name="lyric-mode" :value="m.v" :checked="store.lyricMode === m.v" @change="store.setLyricMode(m.v)" />
      {{ m.label }}
    </label>
  </div>
</template>

<style scoped>
.download-options {
  display: flex;
  align-items: center;
  gap: 4px 12px;
  flex-wrap: wrap;
  padding: 8px 12px;
  margin-bottom: 12px;
  background: #fff;
  border: 1px solid #e3e6ea;
  border-radius: 8px;
  font-size: 13px;
}
.label { color: #666; margin-right: 2px; }
.opt { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; color: #444; }
.opt input { accent-color: #31c27c; }
</style>