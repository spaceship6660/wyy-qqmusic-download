<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import { api } from '../api'

defineProps<{ loggedIn: boolean; uin: string }>()
const emit = defineEmits<{ changed: [{ loggedIn: boolean; uin: string }] }>()

type QrPhase = 'idle' | 'loading' | 'waiting' | 'scanned' | 'finalizing'
const qrOpen = ref(false)
const qrPhase = ref<QrPhase>('idle')
const qrDataUrl = ref('')
const qrError = ref('')
const cookieText = ref('')
const cookieError = ref('')
/**
 * 会话代号：startQr 成功 / importCookie 成功 / 终态（success、expired、rejected、关闭）时自增。
 * 轮询与异步续体（poll、waitResult、自动关闭定时器、importCookie 回调）动作前校验代号，
 * 防止关闭 / 重开后旧会话的迟到回调操作新会话。
 */
let session = 0
let pollTimer: ReturnType<typeof setInterval> | null = null

function stopPolling(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

function closeQr(): void {
  stopPolling()
  session++
  qrOpen.value = false
  qrPhase.value = 'idle'
  qrDataUrl.value = ''
  cookieText.value = ''
  cookieError.value = ''
}

/** 终态（expired/rejected）2s 后自动关闭；定时器用代号守卫，超时前重开/关闭则作废 */
function scheduleAutoClose(): void {
  const my = session
  setTimeout(() => {
    if (my !== session) return
    closeQr()
  }, 2000)
}

async function refreshStatus(): Promise<void> {
  const s = await api.invoke('auth:status')
  emit('changed', { loggedIn: !!s?.loggedIn, uin: s?.uin ?? '' })
}

async function onPoll(): Promise<void> {
  const my = session
  if (my !== session) return
  let status: string
  try {
    status = await api.invoke('auth:poll')
  } catch (e) {
    if (my !== session) return
    stopPolling()
    qrError.value = e instanceof Error ? e.message : String(e)
    return
  }
  if (my !== session) return
  switch (status) {
    case 'waiting':
      qrPhase.value = 'waiting'
      break
    case 'scanned':
      qrPhase.value = 'scanned'
      break
    case 'success': {
      if (my !== session) return
      stopPolling()
      qrPhase.value = 'finalizing' // UI：正在完成登录…
      try {
        const res = await api.invoke('auth:waitResult', 600000)
        if (my !== session) return
        if (res?.ok) {
          await refreshStatus()
          if (my !== session) return
          closeQr()
        } else {
          qrError.value = res?.reason ?? '登录失败'
          qrPhase.value = 'waiting'
        }
      } catch (e) {
        if (my !== session) return
        qrError.value = e instanceof Error ? e.message : String(e)
        qrPhase.value = 'waiting'
      }
      session++
      break
    }
    case 'expired': {
      if (my !== session) return
      stopPolling()
      session++
      qrError.value = '二维码已失效，请重新扫码'
      scheduleAutoClose()
      break
    }
    case 'rejected': {
      if (my !== session) return
      stopPolling()
      session++
      qrError.value = '已拒绝扫码登录'
      scheduleAutoClose()
      break
    }
    default:
      break
  }
}

async function startLogin(): Promise<void> {
  const my = session
  qrError.value = ''
  cookieError.value = ''
  qrOpen.value = true
  qrPhase.value = 'loading'
  try {
    const res = await api.invoke('auth:startQr')
    if (my !== session) return // 等待二维码期间模态被关闭 → 丢弃，不进入轮询
    qrDataUrl.value = res?.qrDataUrl ?? ''
    qrPhase.value = 'waiting'
    stopPolling()
    session++ // 新会话代号（旧会话的在途续体将被守卫丢弃）
    pollTimer = setInterval(() => { void onPoll() }, 1000)
  } catch (e) {
    if (my !== session) return
    qrError.value = e instanceof Error ? e.message : String(e)
    qrPhase.value = 'idle'
  }
}

/** 手动导入入口：打开登录模态（不启动扫码），聚焦导入区 */
function openManualImport(): void {
  qrError.value = ''
  cookieError.value = ''
  qrOpen.value = true
  qrPhase.value = 'idle'
}

async function importCookie(): Promise<void> {
  const text = cookieText.value.trim()
  if (!text) return
  const my = session
  cookieError.value = ''
  try {
    const ok = await api.invoke('auth:importCookie', text)
    if (my !== session) return
    if (ok) {
      stopPolling()
      session++ // 新会话代号（旧代号 my 已失效）
      const mine = session
      await refreshStatus()
      if (mine !== session) return // 刷新状态期间被重开/关闭 → 丢弃
      closeQr()
    } else {
      cookieError.value = 'Cookie 无效：缺少 uin 或 qqmusic_key，导入失败'
    }
  } catch (e) {
    if (my !== session) return
    cookieError.value = e instanceof Error ? e.message : String(e)
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
        <div class="modal-title">登录 QQ 音乐</div>
        <div v-if="qrPhase === 'loading'" class="qr-loading">正在获取二维码…</div>
        <template v-else-if="qrPhase === 'finalizing'">
          <div class="qr-loading">正在完成登录…</div>
        </template>
        <template v-else-if="qrDataUrl">
          <img class="qr-img" :src="qrDataUrl" alt="QQ 登录二维码" />
          <div class="qr-tip" :class="qrPhase">{{ qrPhase === 'scanned' ? '已扫码，请在手机端确认' : '请使用 QQ / 微信手机版扫码' }}</div>
        </template>
        <div v-if="qrError" class="qr-error">{{ qrError }}</div>
        <div class="manual-import">
          <textarea v-model="cookieText" class="cookie-input" rows="3" placeholder="粘贴 y.qq.com 的 Cookie 头（需含 uin 与 qqmusic_key）"></textarea>
          <div v-if="cookieError" class="qr-error">{{ cookieError }}</div>
          <button class="import-btn" :disabled="!cookieText.trim()" @click="importCookie">手动导入 Cookie</button>
        </div>
        <div class="modal-actions">
          <button @click="closeQr">取消</button>
        </div>
      </div>
    </div>

    <button class="manual-btn" @click="openManualImport">手动导入 Cookie</button>
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
.manual-import { margin-top: 14px; border-top: 1px dashed #e3e3e3; padding-top: 12px; }
.cookie-input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 10px;
  font-size: 12px;
  line-height: 1.5;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  resize: vertical;
  outline: none;
  font-family: inherit;
}
.cookie-input:focus { border-color: #31c27c; }
.import-btn {
  margin-top: 8px;
  padding: 5px 14px;
  font-size: 12px;
  color: #666;
  background: #fff;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  cursor: pointer;
}
.import-btn:hover:not(:disabled) { border-color: #31c27c; color: #31c27c; }
.import-btn:disabled { opacity: 0.5; cursor: not-allowed; }
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