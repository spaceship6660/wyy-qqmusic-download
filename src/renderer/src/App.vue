<script setup lang="ts">
import { ref } from 'vue'
const tab = ref<'download' | 'decrypt' | 'settings'>('download')
</script>

<template>
  <div class="app">
    <header>
      <h1>QQ 音乐下载器</h1>
      <nav>
        <button :class="{ active: tab === 'download' }" @click="tab = 'download'">下载</button>
        <button :class="{ active: tab === 'decrypt' }" @click="tab = 'decrypt'">解密</button>
        <button :class="{ active: tab === 'settings' }" @click="tab = 'settings'">设置</button>
      </nav>
    </header>
    <main>
      <section v-if="tab === 'download'">下载（M2 起实现）</section>
      <section v-else-if="tab === 'decrypt'">解密（后续计划）</section>
      <section v-else>设置（M2 起实现）</section>
    </main>
  </div>
</template>

<style>
body { margin: 0; font-family: system-ui, 'Microsoft YaHei', sans-serif; }
.app { padding: 16px; }
header { display: flex; align-items: center; gap: 24px; }
nav button.active { font-weight: 700; }
</style>