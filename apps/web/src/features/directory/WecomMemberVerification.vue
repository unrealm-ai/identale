<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import { NButton, NInput, NTag } from 'naive-ui';
import type { DirectoryIdentityEvidence } from './types';
import { api, errorMessage } from '../../shared/api';
const props = defineProps<{ base: string; sourceId: string; userId: string; authRevision: number; label: string; identityVerified?: boolean; disabled?: boolean; readonly?: boolean }>();
const emit = defineEmits<{ verified: [evidence: DirectoryIdentityEvidence] }>();
type Status = 'unverified' | 'pending' | 'verified' | 'expired' | 'failed';
interface Result { userId: string; status: Status; phrase?: string; expiresAt?: number }
const status = ref<Status>('unverified'), phrase = ref(''), busy = ref(false), message = ref(''), stopped = ref(false);
const expiresAt = ref<number>();
const requestId = ref<string>();
let controller = new AbortController(), timer: ReturnType<typeof setTimeout> | undefined, startedAt = 0, requestReplace = false, automaticSuppressed = false;
const visible = () => document.visibilityState !== 'hidden';
function stop() { controller.abort(); clearTimeout(timer); busy.value = false; phrase.value = ''; stopped.value = true; }
function schedule() {
  clearTimeout(timer);
  if (stopped.value || !visible() || controller.signal.aborted || status.value === 'verified') return;
  if (status.value === 'failed' || (automaticSuppressed && ['expired', 'unverified'].includes(status.value))) return;
  const delay = Date.now() - startedAt < 600000 ? 3000 : 30000;
  timer = setTimeout(() => void query(), Math.max(100, Math.min(delay, expiresAt.value && expiresAt.value > Date.now() ? expiresAt.value - Date.now() : Infinity)));
}
function apply(result: Result, signal: AbortSignal) {
  if (signal.aborted) return;
  if (result.userId !== props.userId) throw Error('核验目标已改变，请重新查询。');
  const wasVerified = status.value === 'verified'; status.value = result.status;
  expiresAt.value = result.expiresAt;
  if (result.phrase) { phrase.value = result.phrase; if (result.status === 'pending') { automaticSuppressed = false; requestId.value = undefined; } }
  if (['verified', 'expired', 'failed', 'unverified'].includes(result.status)) phrase.value = '';
  if (result.status === 'failed') automaticSuppressed = true;
  if (result.status === 'verified' && !wasVerified) emit('verified', { sourceId: props.sourceId, authRevision: props.authRevision, userId: props.userId });
}
async function query() {
  if (busy.value || props.readonly || !visible()) return;
  if (controller.signal.aborted) { controller = new AbortController(); startedAt = Date.now(); }
  stopped.value = false; const signal = controller.signal; busy.value = true; message.value = ''; let loaded = false;
  try { apply(await api<Result>(`${props.base}/channels/wecom/member-verification?${new URLSearchParams({ userId: props.userId, sourceId: props.sourceId })}`, signal), signal); loaded = true; }
  catch (cause) { if (!signal.aborted) message.value = `无法查询验证状态：${errorMessage(cause)}`; }
  finally { if (!signal.aborted) busy.value = false; }
  if (signal.aborted || !loaded) return;
  if (['unverified', 'expired'].includes(status.value) && !automaticSuppressed && !props.disabled && visible()) await generate();
  else schedule();
}
async function generate(replace = false) {
  if (busy.value || props.disabled || props.readonly || status.value === 'verified' || !visible()) return;
  clearTimeout(timer);
  if (controller.signal.aborted) controller = new AbortController();
  const signal = controller.signal; stopped.value = false; busy.value = true; message.value = '';
  if (!requestId.value) { requestId.value = crypto.randomUUID(); requestReplace = replace; }
  try {
    apply(await api<Result>(`${props.base}/channels/wecom/member-verification`, signal, { sourceId: props.sourceId, userId: props.userId, requestId: requestId.value, ...(requestReplace ? { replace: true } : {}) }, 'POST'), signal);
    if (!signal.aborted) { requestId.value = undefined; if (status.value === 'pending') automaticSuppressed = false; schedule(); }
  } catch (cause) { if (!signal.aborted) { automaticSuppressed = true; message.value = `验证码获取结果未知，请重试获取同一次验证码或查询状态：${errorMessage(cause)}`; } }
  finally { if (!signal.aborted) busy.value = false; }
}
function visibilityChanged() { clearTimeout(timer); if (visible() && !stopped.value && !props.readonly && status.value !== 'verified') void query(); }
document.addEventListener('visibilitychange', visibilityChanged);
async function copy() {
  const signal = controller.signal;
  try { await navigator.clipboard.writeText(phrase.value); if (!signal.aborted) message.value = '验证码已复制，请仅交给所选成员。'; }
  catch { if (!signal.aborted) message.value = '复制失败，请选中验证码手动复制。'; }
}
watch(() => [props.base, props.sourceId, props.userId, props.authRevision, props.identityVerified, props.readonly], () => {
  stop(); controller = new AbortController(); requestId.value = undefined; requestReplace = false; automaticSuppressed = false; expiresAt.value = undefined; message.value = ''; stopped.value = false; startedAt = Date.now();
  status.value = props.identityVerified ? 'verified' : 'unverified';
  if (!props.identityVerified && !props.readonly) void query();
}, { immediate: true, flush: 'sync' });
onUnmounted(() => { stop(); document.removeEventListener('visibilitychange', visibilityChanged); });
</script>
<template>
  <div class="member-verification">
    <NTag size="small" :type="status === 'verified' ? 'success' : 'warning'">{{ status === 'verified' ? '身份已验证' : '待验证' }}</NTag>
    <template v-if="status !== 'verified'">
      <p class="field-note">可先保存，身份待验证。</p>
      <template v-if="!readonly">
        <p v-if="phrase" class="field-note">请让{{ label }}通过企微私聊向机器人发送验证码 {{ phrase }}，完成身份绑定。</p>
        <p v-if="status === 'expired'" role="status">验证码已过期，正在获取新码。</p>
        <p v-if="status === 'failed'" role="status">验证失败，请重试。</p>
        <p v-if="status === 'pending' && !phrase" class="field-note">正在读取验证码。</p>
        <p v-if="phrase" class="field-note">24 小时有效<template v-if="expiresAt">，至 {{ new Date(expiresAt).toLocaleString() }}</template>；换码后旧码失效。</p>
        <NInput v-if="phrase" :value="phrase" readonly :input-props="{ 'aria-label': label + '验证码' }" />
        <div class="verification-actions">
          <NButton key="generate" v-if="!phrase" size="small" :disabled="disabled || busy" :loading="busy" @click="generate()">{{ requestId ? '重试获取验证码' : '获取验证码' }}</NButton>
          <NButton key="copy" v-if="phrase" size="small" @click="copy">复制验证码</NButton>
          <NButton key="replace" v-if="phrase" size="small" :disabled="disabled || busy" @click="generate(true)">重新生成验证码</NButton>
          <NButton key="query" size="small" :disabled="busy" @click="query">查询验证状态</NButton>
          <NButton key="stop" v-if="!stopped" size="small" @click="stop">停止查询</NButton>
        </div>
        <p v-if="stopped" class="field-note">已停止本页查询，不会撤销验证码。</p>
      </template>
    </template>
    <p v-if="message" role="status">{{ message }}</p>
  </div>
</template>
<style scoped>.member-verification { display: grid; gap: .5rem; min-width: 0; }.member-verification p { margin: 0; }.verification-actions { display: flex; flex-wrap: wrap; gap: .5rem; }</style>
