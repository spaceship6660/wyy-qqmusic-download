<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

interface UiSettings {
  quality: 'flac' | 'ape' | '320' | '128' | 'm4a'
  concurrency: number
  downloadDir: string
  lyricMode: 'both' | 'embed' | 'lrc' | 'none'
}

const settings = ref<UiSettings>({
  quality: '320',
  concurrency: 2,
  downloadDir: 'downloads',
  lyricMode: 'both',
})
const loaded = ref(false)
const dirNotice = ref('')
let dirTimer: ReturnType<typeof setTimeout> | null = null

onMounted(async () => {
  try {
    const s = await window.api.invoke('settings:get')
    if (s) settings.value = { quality: s.quality ?? '320', concurrency: s.concurrency ?? 2, downloadDir: s.downloadDir ?? '', lyricMode: s.lyricMode ?? 'both' }
  } catch {
    // 读取失败则保留默认值
  }
  loaded.value = true
})
onUnmounted(() => { if (dirTimer) clearTimeout(dirTimer) })

/** 改动即保存（目录输入框防抖 400ms） */
function save(patch: Partial<UiSettings>, delay = 0): void {
  const apply = () => void window.api.invoke('settings:set', patch)
  if (dirTimer) { clearTimeout(dirTimer); dirTimer = null }
  dirTimer = setTimeout(apply, delay)
}

function setQuality(q: UiSettings['quality']): void {
  settings.value.quality = q
  save({ quality: q })
}

function setConcurrency(n: number): void {
  settings.value.concurrency = n
  save({ concurrency: n })
}

function setDir(v: string): void {
  settings.value.downloadDir = v
  save({ downloadDir: v }, 400)
}

function setLyricMode(m: UiSettings['lyricMode']): void {
  settings.value.lyricMode = m
  save({ lyricMode: m })
}

/** Electron 限制：webkitdirectory 拿不到绝对路径；有 File.path 就填上，否则提示手输 */
function pickDir(e: Event): void {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  const candidate = (f as unknown as { path?: string }).path
  if (typeof candidate === 'string' && candidate) {
    settings.value.downloadDir = candidate
    save({ downloadDir: candidate })
    dirNotice.value = '已选择下载目录'
  } else {
    dirNotice.value = '当前 Electron 无法直接读取所选文件夹路径，请在输入框中手动粘贴完整路径'
  }
}
</script>

<template>
  <div class="settings-panel">
    <h3>设置</h3>
    <div v-if="loaded" class="form">
      <div class="field">
        <span class="label">码率</span>
        <div class="radios">
          <label v-for="q in (['320', '128', 'm4a', 'flac'] as const)" :key="q">
            <input type="radio" :value="q" :checked="settings.quality === q" @change="setQuality(q)" />
            {{ q === '320' ? '320kbps MP3' : q === '128' ? '128kbps MP3' : q === 'm4a' ? 'm4a' : 'FLAC 无损' }}
          </label>
        </div>
      </div>
      <div class="field">
        <span class="label">并发下载数</span>
        <div class="radios">
          <label v-for="n in [1, 2, 3, 4]" :key="n">
            <input type="radio" :value="n" :checked="settings.concurrency === n" @change="setConcurrency(n)" />
            {{ n }}
          </label>
        </div>
      </div>
      <div class="field">
        <span class="label">下载目录</span>
        <div class="dir-row">
          <input class="text-input" type="text" :value="settings.downloadDir" @input="setDir(($event.target as HTMLInputElement).value)" />
          <label class="pick-btn">
            选择目录
            <input type="file" webkitdirectory class="hidden-input" @change="pickDir" />
          </label>
        </div>
        <div v-if="dirNotice" class="notice">{{ dirNotice }}</div>
      </div>
      <div class="field">
        <span class="label">歌词模式</span>
        <div class="radios">
          <label v-for="m in ([{ v: 'both', t: '嵌入 + 另存 .lrc' }, { v: 'embed', t: '仅嵌入' }, { v: 'lrc', t: '仅另存 .lrc' }, { v: 'none', t: '不保存歌词' }] as const)" :key="m.v">
            <input type="radio" :value="m.v" :checked="settings.lyricMode === m.v" @change="setLyricMode(m.v)" />
            {{ m.t }}
          </label>
        </div>
      </div>
    </div>
    <div v-else class="loading">加载中…</div>
  </div>
</template>

<style scoped>
.settings-panel { max-width: 640px; }
.settings-panel h3 { font-size: 15px; margin: 0 0 16px; }
.form { display: flex; flex-direction: column; gap: 18px; }
.field { display: flex; flex-direction: column; gap: 8px; }
.label { font-size: 14px; font-weight: 600; color: #333; }
.radios { display: flex; flex-wrap: wrap; gap: 6px 18px; }
.radios label { font-size: 13px; color: #444; display: flex; align-items: center; gap: 5px; cursor: pointer; }
.dir-row { display: flex; gap: 8px; }
.text-input {
  flex: 1;
  padding: 7px 10px;
  font-size: 13px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  outline: none;
}
.text-input:focus { border-color: #31c27c; }
.pick-btn {
  padding: 7px 16px;
  font-size: 13px;
  color: #31c27c;
  border: 1px solid #31c27c;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.pick-btn:hover { background: #e8faf0; }
.hidden-input { display: none; }
.notice { font-size: 12px; color: #b26a00; }
.loading { color: #999; font-size: 13px; }
</style>