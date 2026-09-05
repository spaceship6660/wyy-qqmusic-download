<script setup lang="ts">
import { ref, onUnmounted } from 'vue'

defineProps<{ loggedIn: boolean; uin: string }>()
const emit = defineEmits<{ changed: [{ loggedIn: boolean; uin: string }] }>()

type QrPhase = 'idle' | 'loading' | 'waiting' | 'scanned'
const qrOpen = ref(false)
const qrPhase = ref<QrPhase>('idle')
const qrDataUrl = ref('')
const qrError = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null

function stopPolling(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

function closeQr(): void {
  stopPolling()
  qrOpen.value = false
  qrPhase.value = 'idle'
  qrDataUrl.value = ''
}

async function refreshStatus(): Promise<void> {
  const s = await window.api.invoke('auth:status')
  emit('changed', { loggedIn: !!s?.loggedIn, uin: s?.uin ?? '' })
}

async function onPoll(): Promise<void> {
  let status: string
  try {
    status = await window.api.invoke('auth:poll')
  } catch (e) {
    stopPolling()
    qrError.value = e instanceof Error ? e.message : String(e)
    return
  }
  switch (status) {
    case 'waiting':
      qrPhase.value = 'waiting'
      break
    case 'scanned':
      qrPhase.value = 'scanned'
      break
    case 'success': {
      stopPolling()
      const res = await window.api.invoke('auth:waitResult', 600000)
      if (res?.ok) {
        await refreshStatus()
        closeQr()
      } else {
        qrError.value = res?.reason ?? '登录失败'
      }
      break
    }
    case 'expired':
      stopPolling()
      qrError.value = '二维码已失效，请重新扫码'
      setTimeout(closeQr, 2000)
      break
    case 'rejected':
      stopPolling()
      qrError.value = '已拒绝扫码登录'
      setTimeout(closeQr, 2000)
      break
    default:
      break
  }
}

async function startLogin(): Promise<void> {
  qrError.value = ''
  qrOpen.value = true
  qrPhase.value = 'loading'
  try {
    const res = await window.api.invoke('auth:startQr')
    qrDataUrl.value = res?.qrDataUrl ?? ''
    qrPhase.value = 'waiting'
    stopPolling()
    pollTimer = setInterval(onPoll, 1000)
  } catch (e) {
    qrError.value = e instanceof Error ? e.message : String(e)
    qrPhase.value = 'idle'
  }
}

async function importCookie(): Promise<void> {
  const text = window.prompt(
    '手动导入 Cookie：粘贴浏览器里 y.qq.com 的 Cookie 头（需含 uin 与 qqmusic_key）：',
  )
  if (!text) return
  try {
    const ok = await window.api.invoke('auth:importCookie', text)
    if (ok) {
      await refreshStatus()
    } else {
      window.alert('Cookie 无效：缺少 uin 或 qqmusic_key，导入失败')
    }
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e))
  }
}

onUnmounted(stopPolling)
</script>

<template>
  <div class="login-btn-wrap">
    <button v-if="!loggedIn" class="login-btn" @click="startLogin">登录 QQ</button>
    <span v-else class="logged" :title="uin">已登录{{ uin ? `（${uin}）` : '' }}</span>

    <div v-if="qrOpen" class="modal-mask" @click.self="closeQr">
      <div class="modal">
        <div class="modal-title">扫码登录 QQ 音乐</div>
        <div v-if="qrPhase === 'loading'" class="qr-loading">正在获取二维码…</div>
        <template v-else-if="qrDataUrl">
          <img class="qr-img" :src="qrDataUrl" alt="QQ 登录二维码" />
          <div class="qr-tip" :class="qrPhase">{{ qrPhase === 'scanned' ? '已扫码，请在手机端确认' : '请使用 QQ / 微信手机版扫码' }}</div>
        </template>
        <div v-if="qrError" class="qr-error">{{ qrError }}</div>
        <div class="modal-actions">
          <button @click="closeQr">取消</button>
        </div>
      </div>
    </div>

    <div class="manual">
      <button class="manual-btn" @click="importCookie">手动导入 Cookie</button>
    </div>
  </div>
</template>

<style scoped>
.login-btn-wrap { display: flex; align-items: center; gap: 10px; }
.login-btn {
  padding: 6px 18px;
  font-size: 13px;
  color: #fff;
  background: #31c27c;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.login-btn:hover { background: #27ab6b; }
.logged { font-size: 13px; color: #31c27c; }
.manual-btn {
  padding: 6px 12px;
  font-size: 12px;
  color: #666;
  background: #fff;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  cursor: pointer;
}
.manual-btn:hover { border-color: #31c27c; color: #31c27c; }
.modal-mask {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex; align-items: center; justify-content: center;
  z-index: 100;
}
.modal {
  width: 300px;
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  text-align: center;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
}
.modal-title { font-size: 15px; font-weight: 700; margin-bottom: 14px; }
.qr-img { width: 220px; height: 220px; border: 1px solid #eee; border-radius: 6px; }
.qr-loading { padding: 80px 0; color: #999; }
.qr-tip { margin-top: 10px; font-size: 13px; color: #666; }
.qr-tip.scanned { color: #31c27c; }
.qr-error { margin-top: 10px; font-size: 13px; color: #d32f2f; }
.modal-actions { margin-top: 14px; }
.modal-actions button {
  padding: 6px 24px;
  font-size: 13px;
  background: #fff;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  cursor: pointer;
}
.modal-actions button:hover { border-color: #d32f2f; color: #d32f2f; }
</style>