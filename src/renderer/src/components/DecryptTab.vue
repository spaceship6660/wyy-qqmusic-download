<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

interface UnlockResult {
  file: string
  status: 'completed' | 'decrypted' | 'failed'
  outputPath?: string
  reason?: string
}

// 与主进程 QMC_EXTS 一致的扩展名白名单（main/app.ts unlockRun）
const QMC_EXTS = ['.mflac', '.mflac0', '.mgg', '.mgg0', '.mgg1', '.qmc0', '.qmcflac', '.qmcogg']
const pickerAccept = QMC_EXTS.join(',')

const files = ref<string[]>([])
const results = ref<UnlockResult[]>([])
const running = ref(false)
const error = ref('')
const outDir = ref('')

const doneCount = computed(() => results.value.filter((r) => r.status === 'completed').length)
const decOnlyCount = computed(() => results.value.filter((r) => r.status === 'decrypted').length)
const failedCount = computed(() => results.value.filter((r) => r.status === 'failed').length)

function addFiles(paths: string[]): void {
  const seen = new Set(files.value)
  for (const p of paths) {
    if (!p) continue
    if (QMC_EXTS.some((e) => p.toLowerCase().endsWith(e)) && !seen.has(p)) {
      seen.add(p)
      files.value.push(p)
    }
  }
}

/** 多选文件：webUtils.getPathForFile 拿绝对路径 */
function pickFiles(e: Event): void {
  const input = e.target as HTMLInputElement
  const picked = Array.from(input.files ?? [])
    .map((f) => window.api.getPathForFile(f))
    .filter(Boolean) as string[]
  input.value = ''
  addFiles(picked)
}

/** 选文件夹：webkitdirectory 下每个 File 都有绝对路径，按扩展名过滤 */
function pickDir(e: Event): void {
  const input = e.target as HTMLInputElement
  const picked = Array.from(input.files ?? [])
    .map((f) => window.api.getPathForFile(f))
    .filter(Boolean) as string[]
  input.value = ''
  addFiles(picked)
}

function removeFile(i: number): void {
  files.value.splice(i, 1)
}

async function run(): Promise<void> {
  if (files.value.length === 0 || running.value) return
  running.value = true
  error.value = ''
  results.value = []
  try {
    results.value = await window.api.invoke('unlock:run', files.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

function openOutDir(): void {
  if (outDir.value) void window.api.invoke('fs:openDir', outDir.value)
}

function openFile(p: string): void {
  if (p) void window.api.invoke('fs:openDir', p)
}

onMounted(() => {
  void window.api.invoke('settings:get').then((s: any) => {
    outDir.value = s?.decryptOutDir ?? ''
  })
})
</script>

<template>
  <div class="decrypt">
    <header class="top">
      <h2>解密</h2>
      <span class="out" title="输出目录（设置页可改）">输出：{{ outDir || 'decrypted（默认）' }}</span>
      <button class="ghost" @click="openOutDir">打开目录</button>
    </header>
    <p class="hint">支持 QQ 音乐加密文件：.mflac / .mflac0 / .mgg / .mgg0 / .mgg1 / .qmc0。解密后按文件名「歌手 - 歌名」搜索匹配，FLAC/MP3 自动补封面与歌词；OGG 等只解密不补全。</p>
    <div class="tools">
      <label class="ghost pick">
        选择文件
        <input type="file" multiple :accept="pickerAccept" class="hidden-input" @change="pickFiles" />
      </label>
      <label class="ghost pick">
        选择文件夹
        <input type="file" webkitdirectory class="hidden-input" @change="pickDir" />
      </label>
      <button class="primary" :disabled="files.length === 0 || running" @click="run">
        {{ running ? '解密中…' : `解密并补全 (${files.length})` }}
      </button>
    </div>
    <p v-if="error" class="err">{{ error }}</p>
    <div v-if="files.length" class="files">
      <div v-for="(f, i) in files" :key="f" class="file-row">
        <span class="file-name" :title="f">{{ f.split(/[\\/]/).pop() }}</span>
        <button class="rm" @click="removeFile(i)">移除</button>
      </div>
    </div>
    <div v-if="results.length" class="summary">
      完成：{{ doneCount }} 已补全 / {{ decOnlyCount }} 仅解密 / {{ failedCount }} 失败
    </div>
    <ul v-if="results.length" class="results">
      <li v-for="r in results" :key="r.file" :class="r.status">
        <span class="icon">{{ r.status === 'completed' ? '✓' : r.status === 'decrypted' ? '○' : '✗' }}</span>
        <span class="file-name" :title="r.file">{{ r.file.split(/[\\/]/).pop() }}</span>
        <span class="reason">{{ r.reason ?? (r.status === 'completed' ? '解密 + 补全' : '') }}</span>
        <button v-if="r.outputPath" class="ghost small" @click="openFile(r.outputPath ?? '')">查看</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.decrypt { display: flex; flex-direction: column; gap: 12px; }
.top { display: flex; align-items: center; gap: 12px; }
.top h2 { font-size: 18px; margin: 0; }
.out { font-size: 13px; color: #666; }
.hint { font-size: 13px; color: #888; margin: 0; }
button, .pick {
  padding: 6px 16px;
  font-size: 13px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
}
button.primary { background: #31c27c; color: #fff; border-color: #31c27c; }
button.primary:disabled { background: #b9c9c0; border-color: #b9c9c0; cursor: not-allowed; }
button.ghost:hover:not(:disabled), .pick:hover { border-color: #31c27c; color: #31c27c; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.small { padding: 2px 10px; font-size: 12px; }
.hidden-input { display: none; }
.tools { display: flex; gap: 8px; align-items: center; }
.err { color: #d33; font-size: 13px; margin: 0; }
.files { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
.file-row { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 3px 8px; background: #fff; border-radius: 6px; }
.file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rm { border: none; background: none; color: #999; cursor: pointer; font-size: 12px; }
.rm:hover { color: #d33; }
.summary { font-size: 13px; font-weight: 600; }
.results { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.results li { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 6px 10px; background: #fff; border-radius: 6px; }
.results li.completed .icon { color: #31c27c; font-weight: 700; }
.results li.decrypted .icon { color: #d9930e; font-weight: 700; }
.results li.failed .icon { color: #d33; font-weight: 700; }
.results .file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.results .reason { color: #888; font-size: 12px; }
</style>