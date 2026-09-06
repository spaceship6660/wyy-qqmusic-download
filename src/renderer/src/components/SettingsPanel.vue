<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useDownloadStore } from '../stores/download'

const store = useDownloadStore()

interface UiSettings {
  quality: 'flac' | 'ape' | '320' | '128' | 'm4a'
  concurrency: number
  downloadDir: string
  lyricMode: 'both' | 'embed' | 'lrc' | 'none'
  decryptOutDir: string
}

const settings = ref<UiSettings>({
  quality: '320',
  concurrency: 2,
  downloadDir: 'downloads',
  lyricMode: 'both',
  decryptOutDir: 'decrypted',
})
const loaded = ref(false)
const dirNotice = ref('')
let dirTimer: ReturnType<typeof setTimeout> | null = null
let decryptDirTimer: ReturnType<typeof setTimeout> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

onMounted(async () => {
  try {
    const s = await window.api.invoke('settings:get')
    if (s) settings.value = { quality: s.quality ?? '320', concurrency: s.concurrency ?? 2, downloadDir: s.downloadDir ?? '', lyricMode: s.lyricMode ?? 'both', decryptOutDir: s.decryptOutDir ?? '' }
  } catch {
    // 读取失败则保留默认值
  }
  loaded.value = true
})
onUnmounted(() => {
  if (dirTimer) clearTimeout(dirTimer)
  if (decryptDirTimer) clearTimeout(decryptDirTimer)
  if (saveTimer) clearTimeout(saveTimer)
})

/** 改动即保存：目录输入走独立 dirTimer 防抖 400ms；其余设置走 saveTimer，互不清理对方的定时器 */
function save(patch: Partial<UiSettings>, delay = 0): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  saveTimer = setTimeout(() => { saveTimer = null; void window.api.invoke('settings:set', patch) }, delay)
}

function setQuality(q: UiSettings['quality']): void {
  store.setQuality(q) // store 为展示/入队/持久化的单一事实源，再落盘
  save({ quality: q })
}

function setConcurrency(n: number): void {
  settings.value.concurrency = n
  save({ concurrency: n })
}

function setDir(v: string): void {
  settings.value.downloadDir = v
  if (dirTimer) { clearTimeout(dirTimer); dirTimer = null }
  dirTimer = setTimeout(() => { dirTimer = null; void window.api.invoke('settings:set', { downloadDir: v }) }, 400)
}

/** 解密输出目录：与下载目录同款独立防抖（互不清理对方的定时器） */
function setDecryptDir(v: string): void {
  settings.value.decryptOutDir = v
  if (decryptDirTimer) { clearTimeout(decryptDirTimer); decryptDirTimer = null }
  decryptDirTimer = setTimeout(() => { decryptDirTimer = null; void window.api.invoke('settings:set', { decryptOutDir: v }) }, 400)
}

function setLyricMode(m: UiSettings['lyricMode']): void {
  settings.value.lyricMode = m
  store.setLyricMode(m) // 与码率一致：store 为当前下载选择的单一事实源，改了默认值即同步当前选择
  save({ lyricMode: m })
}

/** Electron 限制：webkitdirectory 拿不到绝对路径；经 preload 的 webUtils.getPathForFile 取绝对路径 */
function pickDir(e: Event): void {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  const candidate = window.api.getPathForFile(f)
  if (candidate) {
    if (dirTimer) { clearTimeout(dirTimer); dirTimer = null } // 覆盖未落地的防抖输入
    settings.value.downloadDir = candidate
    void window.api.invoke('settings:set', { downloadDir: candidate })
    dirNotice.value = '已选择下载目录'
  } else {
    dirNotice.value = '未能读取所选文件夹路径，请在输入框中手动粘贴完整路径'
  }
}

function pickDecryptDir(e: Event): void {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  const candidate = window.api.getPathForFile(f)
  if (candidate) {
    if (decryptDirTimer) { clearTimeout(decryptDirTimer); decryptDirTimer = null }
    settings.value.decryptOutDir = candidate
    void window.api.invoke('settings:set', { decryptOutDir: candidate })
  }
}
</script>

<template>
  <div class="settings-panel">
    <h3>设置</h3>
    <div v-if="loaded" class="form">
      <div class="field">
        <span class="label">默认码率（下载时可改）</span>
        <div class="radios">
          <label v-for="q in (['320', '128', 'm4a', 'flac', 'ape'] as const)" :key="q">
            <input type="radio" :value="q" :checked="store.quality === q" @change="setQuality(q)" />
            {{ q === '320' ? '320kbps MP3' : q === '128' ? '128kbps MP3' : q === 'm4a' ? 'm4a' : q === 'ape' ? 'APE 无损' : 'FLAC 无损' }}
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
        <span class="label">解密输出目录</span>
        <div class="dir-row">
          <input class="text-input" type="text" :value="settings.decryptOutDir" @input="setDecryptDir(($event.target as HTMLInputElement).value)" />
          <label class="pick-btn">
            选择目录
            <input type="file" webkitdirectory class="hidden-input" @change="pickDecryptDir" />
          </label>
        </div>
      </div>
      <div class="field">
        <span class="label">默认歌词模式（下载时可改）</span>
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