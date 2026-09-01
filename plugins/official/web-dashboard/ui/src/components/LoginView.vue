<script setup>
import { ref } from 'vue';
import { setToken, hasToken } from '../api.js';

const token = ref('');
const showPwd = ref(false);
const error = ref('');
const loading = ref(false);

async function submit() {
  const t = token.value.trim();
  if (!t) { error.value = '请输入访问令牌'; return; }
  loading.value = true;
  error.value = '';
  try {
    // 用 /health 验证令牌：Authorization: Bearer 传递，避免令牌出现在 URL（日志/历史残留风险）
    const r = await fetch('/health', {
      headers: { 'Authorization': 'Bearer ' + t },
      signal: AbortSignal.timeout(20000),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.auth && d.auth.authenticated) {
      setToken(t);
      location.reload();  // 重新走正常加载流程
      return;
    }
    if (r.status === 401) { error.value = '令牌无效，请检查后重试'; }
    else if (d && d.auth && d.auth.needsTotp) { error.value = '账号需要 TOTP 验证（服务自动处理，稍后重试）'; }
    else { error.value = '验证失败（' + r.status + '），请稍后重试'; }
  } catch (e) {
    error.value = '无法连接服务，请确认服务已启动（' + (e.message || e) + '）';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-logo"><i class="pi pi-shield"></i></div>
      <h1 class="login-title">VRChat Assistant</h1>
      <p class="login-sub">输入访问令牌以进入监控面板</p>
      <form @submit.prevent="submit">
        <div class="login-field">
          <label for="login-token">访问令牌</label>
          <div class="login-input-row">
            <i class="pi pi-key login-ico"></i>
            <input
              id="login-token"
              v-model="token"
              :type="showPwd ? 'text' : 'password'"
              class="login-input"
              placeholder="粘贴 VRC_MONITOR_AUTH_TOKEN…"
              autocomplete="off"
              spellcheck="false"
            />
            <button type="button" class="login-eye" :title="showPwd ? '隐藏' : '显示'" :aria-label="showPwd ? '隐藏令牌' : '显示令牌'" @click="showPwd = !showPwd">
              <i :class="showPwd ? 'pi pi-eye-slash' : 'pi pi-eye'"></i>
            </button>
          </div>
        </div>
        <div v-if="error" class="login-error"><i class="pi pi-exclamation-circle"></i> {{ error }}</div>
        <button type="submit" class="login-btn" :disabled="loading || !token.trim()">
          <i v-if="loading" class="pi pi-spin pi-spinner"></i>
          <i v-else class="pi pi-sign-in"></i>
          {{ loading ? '验证中…' : '登录' }}
        </button>
      </form>
      <p class="login-hint"><i class="pi pi-info-circle"></i> 令牌仅保存在本机 sessionStorage，关闭页面自动清除；不会写入地址栏。</p>
    </div>
  </div>
</template>

<style scoped>
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--surface); }
.login-card { width: min(380px, 92vw); background: var(--surface-2); border: 1px solid var(--border); border-radius: 16px; padding: 36px 28px; box-shadow: 0 12px 40px rgba(0,0,0,0.35); }
.login-logo { width: 52px; height: 52px; margin: 0 auto 14px; border-radius: 14px; background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 24px; }
.login-title { text-align: center; font-size: 19px; margin: 0 0 4px; color: var(--text); }
.login-sub { text-align: center; font-size: 12.5px; color: var(--text-dim); margin: 0 0 24px; }
.login-field label { display: block; font-size: 12px; color: var(--text-dim); margin-bottom: 6px; }
.login-input-row { position: relative; display: flex; align-items: center; }
.login-ico { position: absolute; left: 12px; color: var(--text-dim); font-size: 14px; pointer-events: none; }
.login-input { flex: 1; height: 44px; padding: 0 44px 0 36px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; color: var(--text); font-size: 14px; font-family: var(--font-mono, monospace); outline: none; transition: border-color 0.15s; }
.login-input:focus { border-color: var(--accent); }
.login-eye { position: absolute; right: 8px; width: 32px; height: 32px; background: none; border: none; color: var(--text-dim); cursor: pointer; border-radius: 6px; display: flex; align-items: center; justify-content: center; }
.login-eye:hover { color: var(--text); }
.login-error { display: flex; align-items: center; gap: 6px; margin-top: 10px; padding: 8px 10px; background: color-mix(in srgb, var(--danger) 12%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); border-radius: 8px; color: var(--danger); font-size: 12px; }
.login-btn { width: 100%; height: 44px; margin-top: 16px; background: var(--accent); border: none; border-radius: 10px; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; transition: opacity 0.15s; }
.login-btn:hover:not(:disabled) { opacity: 0.9; }
.login-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.login-hint { display: flex; align-items: flex-start; gap: 6px; margin-top: 18px; font-size: 11px; color: var(--text-dim); line-height: 1.5; }
.login-hint .pi { margin-top: 2px; flex: none; }
</style>
