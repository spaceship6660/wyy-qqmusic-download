<script setup lang="ts">
const model = defineModel<string>({ default: '' })
const emit = defineEmits<{ search: [q: string] }>()

function submit(): void {
  const q = model.value.trim()
  if (!q) return
  emit('search', q)
}
</script>

<template>
  <div class="search-bar">
    <input
      v-model="model"
      class="search-input"
      type="text"
      placeholder="歌名 / 歌手 / QQ 音乐歌单·专辑·单曲链接"
      @keyup.enter="submit"
    />
    <button class="search-btn" :disabled="!model.trim()" @click="submit">搜索</button>
  </div>
</template>

<style scoped>
.search-bar { display: flex; gap: 8px; margin-bottom: 16px; }
.search-input {
  flex: 1;
  padding: 8px 12px;
  font-size: 14px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  outline: none;
}
.search-input:focus { border-color: #31c27c; box-shadow: 0 0 0 2px rgba(49, 194, 124, 0.15); }
.search-btn {
  padding: 8px 20px;
  font-size: 14px;
  color: #fff;
  background: #31c27c;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.search-btn:disabled { background: #b9c9c0; cursor: not-allowed; }
</style>