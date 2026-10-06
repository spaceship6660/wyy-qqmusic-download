<script setup lang="ts">
import { computed, watch } from 'vue'
import { useDownloadStore } from '../stores/download'
import { isQualityFor, qualitiesFor, type Quality, type QualitySource } from '../qualityOptions'
import { api } from '../api'

// 下载时选择器：码率 + 歌词模式（本次下载批次生效；改动即持久化为默认值，
// 下次打开接着用——设置页存的是同一份，启动时由 App.vue 从 settings:get 载入 store）
//
// source 决定可见档位（档位表与规则在 qualityOptions.ts）：APE/m4a 是 QQ 独有档，
// 网易云没有对应 br，摆过去会静默丢无损；当前档位不在可见档内时立即回落无损并持久化。
const props = defineProps<{ source: QualitySource }>()
const store = useDownloadStore()

const visible = computed(() => qualitiesFor(props.source))

function setQuality(q: Quality): void {
  store.setQuality(q)
  void api.invoke('settings:set', { quality: q })
}

function setLyricMode(m: 'both' | 'embed' | 'lrc' | 'none'): void {
  store.setLyricMode(m)
  void api.invoke('settings:set', { lyricMode: m })
}

// immediate 保证首次挂载即校正：settings.json 的 quality 是两个源共用的一份全局档，
// QQ 侧写过 ape 后打开网易云页，得先把它改回无损再进下载管线。
watch(
  () => [props.source, store.quality] as const,
  () => {
    if (!isQualityFor(props.source, store.quality)) setQuality('flac')
  },
  { immediate: true },
)

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
    <label v-for="q in visible" :key="q.v" class="opt">
      <input type="radio" name="quality" :value="q.v" :checked="store.quality === q.v" @change="setQuality(q.v)" />
      {{ q.label }}
    </label>
    <span class="label">歌词</span>
    <label v-for="m in LYRIC_MODES" :key="m.v" class="opt">
      <input type="radio" name="lyric-mode" :value="m.v" :checked="store.lyricMode === m.v" @change="setLyricMode(m.v)" />
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
  /* 置顶：翻长列表时码率/歌词选项始终可见（滚动容器是 main.content，sticky 相对它生效） */
  position: sticky;
  top: 0;
  z-index: 5;
}
.label { color: #666; margin-right: 2px; }
.opt { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; color: #444; }
.opt input { accent-color: #31c27c; }
</style>
