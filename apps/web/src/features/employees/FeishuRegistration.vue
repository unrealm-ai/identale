<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NQrCode, NSpace, NTag } from 'naive-ui';
import { api, ApiError, errorMessage } from '../../shared/api';
import ChannelValidationReport from './ChannelValidationReport.vue';
import type { ChannelValidation } from './channel-validation';
import { feishuRegistrationOperations as operations } from './feishu-registration-operations';

type State = 'starting' | 'awaiting_confirmation' | 'credentials_saved' | 'checking' | 'needs_attention' | 'connected' | 'cancelled' | 'expired' | 'denied' | 'failed' | 'interrupted';
interface Registration { id: string; state: State; appId?: string; credentialSaved: boolean; verificationUrl?: string; expiresAt?: number; error?: string; missingScopes?: string[]; validation?: ChannelValidation; updatedAt: number }
interface Envelope { registration: Registration | null; preset: { name: string; description: string }; permissions: { version: string; scopes: string[]; events: string[] } }
const props = defineProps<{ base: string; active: boolean; disabled?: boolean; boundAppId?: string | undefined }>();
const emit = defineEmits<{ changed: []; sessionExpired: []; busyChanged: [boolean] }>();
const data = ref<Envelope | null>(null), busy = ref(false), error = ref(''), uncertain = ref(false);
const registration = computed(() => data.value?.registration);
const pending = computed(() => !!registration.value && ['starting', 'awaiting_confirmation', 'checking'].includes(registration.value.state));
const matching = computed(() => !props.boundAppId || registration.value?.appId === props.boundAppId);
const labels: Record<State, string> = { starting: '正在准备飞书创建请求', awaiting_confirmation: '等待在飞书确认创建', credentials_saved: '凭据已保存，等待检查', checking: '正在检查已保存的应用', needs_attention: '检查未通过，需要处理', connected: '检查通过，已启用渠道', cancelled: '已取消本次等待', expired: '二维码已过期', denied: '飞书创建请求被拒绝', failed: '创建未完成', interrupted: '操作已中断' };
const officialUrl = computed(() => {
  if (registration.value?.state !== 'awaiting_confirmation') return '';
  try { const url = new URL(registration.value.verificationUrl ?? ''); return url.protocol === 'https:' && ['accounts.feishu.cn', 'open.feishu.cn'].includes(url.hostname) && !url.username && !url.password && !url.port ? url.href : ''; } catch { return ''; }
});
const consoleUrl = computed(() => /^cli_[a-zA-Z0-9]+$/.test(registration.value?.appId ?? '') ? `https://open.feishu.cn/app/${registration.value!.appId}` : '');
const canStart = computed(() => !props.boundAppId && !registration.value?.credentialSaved && !pending.value && !!data.value && !busy.value && !props.disabled);
const canRetry = computed(() => matching.value && !!registration.value?.credentialSaved && !pending.value && registration.value?.state !== 'connected');
let controller = new AbortController(), generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
// In-memory IDs only: an uncertain start is retried with its original idempotency key.
let announced = '';
function stop() { generation++; controller.abort(); controller = new AbortController(); clearTimeout(timer); busy.value = false; emit('busyChanged', false); }
function schedule() { clearTimeout(timer); if (props.active && !document.hidden && pending.value && !error.value) timer = setTimeout(() => void request(), 1800); }
async function request(action?: 'start' | 'retry' | 'cancel') {
  if (!props.active || document.hidden || busy.value || action && props.disabled) return;
  const origin = props.base, epoch = generation, signal = controller.signal;
  const id = registration.value?.id;
  if (action === 'start' && !canStart.value || action === 'retry' && !canRetry.value || action === 'cancel' && !id) return;
  if (action === 'start' && !operations.has(origin)) operations.set(origin, crypto.randomUUID());
  busy.value = true; emit('busyChanged', !!action); error.value = '';
  try {
    const result = await api<Envelope>(`${origin}/channels/feishu/registration${action && action !== 'start' ? `/${action}` : ''}`, AbortSignal.any([signal, AbortSignal.timeout(15000)]), action ? action === 'start' ? { operationId: operations.get(origin) } : { id } : undefined, action ? 'POST' : undefined);
    if (epoch !== generation || signal.aborted) return;
    if (!result || !result.preset || !result.permissions) throw new Error('无法读取飞书创建配置');
    data.value = result; uncertain.value = false;
    if (result.registration) operations.delete(origin);
    if (result.registration?.state === 'connected' && announced !== result.registration.id) { announced = result.registration.id; busy.value = false; emit('busyChanged', false); emit('changed'); }
  } catch (cause) {
    if (epoch !== generation || signal.aborted) return;
    error.value = errorMessage(cause); if (action === 'start') uncertain.value = true;
    if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired');
  } finally {
    if (epoch === generation) { busy.value = false; emit('busyChanged', false); schedule(); }
  }
}
// Hiding this tab is expected while confirming in Feishu. Only the explicit
// cancel button may cancel server work; lifecycle cleanup stops local polling.
function suspend() { stop(); }
function visibility() { if (document.hidden) suspend(); else if (props.active) void request(); }
watch(() => [props.base, props.active] as const, ([base, active], old) => {
  stop(); error.value = ''; uncertain.value = operations.has(base);
  if (!old || old[0] !== base) { data.value = null; announced = ''; }
  if (active) void request();
}, { immediate: true });
document.addEventListener('visibilitychange', visibility);
onUnmounted(() => { document.removeEventListener('visibilitychange', visibility); suspend(); });
</script>
<template>
  <section class="feishu-registration form-section" aria-label="飞书自动创建应用">
    <header class="form-section-heading"><div><h3>扫码创建飞书机器人</h3><p class="field-note">使用已保存的员工资料，创建独立应用并自动检查连接。</p></div><NTag size="small">自动接入</NTag></header>
    <NAlert v-if="boundAppId && !matching" type="info">已绑定飞书应用。如需换绑，请使用下方手动配置并明确确认；此处不会创建新应用覆盖现有连接。</NAlert>
    <template v-else>
      <div v-if="data" class="registration-preview"><span class="field-note">即将提交给飞书的员工资料</span><strong>{{ data.preset.name }}</strong><p>{{ data.preset.description || '（无描述）' }}</p></div>
      <p class="field-note">点击创建会向飞书提交上方员工名称、描述及下列权限和事件配置，并创建一个真实的新飞书应用。请使用有权限的飞书账号确认。应用密钥仅由服务端保存，不会显示在此页面。</p>
      <details v-if="data" class="registration-manifest"><summary>查看申请的权限与事件（{{ data.permissions.version }}）</summary><h4>权限</h4><ul><li v-for="scope in data.permissions.scopes" :key="scope">{{ scope }}</li></ul><h4>事件</h4><ul><li v-for="event in data.permissions.events" :key="event">{{ event }}</li></ul></details>
      <div v-if="registration" class="registration-progress" role="status" aria-live="polite"><strong>{{ labels[registration.state] }}</strong><p v-if="registration.credentialSaved">应用凭据已安全保存，无需重新扫码或填写密钥。凭据已取得不代表审批、发布或所有权限都已生效。</p><p v-if="registration.state === 'connected'">请核对渠道连接状态与使用范围，再用获准账号验证真实消息收发。</p><p v-if="registration.expiresAt && pending">本次确认有效期至 {{ new Date(registration.expiresAt).toLocaleString('zh-CN') }}</p><p v-if="registration.error">{{ registration.error }}</p></div>
      <NAlert v-if="registration && !registration.credentialSaved && ['cancelled', 'expired', 'failed', 'interrupted'].includes(registration.state)" type="warning">停止等待不代表撤销飞书侧操作。如果已在飞书确认创建，请先检查飞书后台；也可使用下方手动接入，避免重复创建应用。</NAlert>
      <div v-if="officialUrl" class="registration-scan"><NQrCode :value="officialUrl" :size="160"/><div><strong>用飞书扫描二维码</strong><p class="field-note">或在浏览器打开飞书官方确认页。</p><a :href="officialUrl" target="_blank" rel="noopener noreferrer">打开飞书确认页 ↗</a></div></div>
      <NAlert v-if="registration?.missingScopes?.length" type="warning"><strong>尚未生效的权限</strong><ul><li v-for="scope in registration.missingScopes" :key="scope">{{ scope }}</li></ul></NAlert>
      <ChannelValidationReport v-if="registration?.validation" :report="registration.validation"/>
      <a v-if="consoleUrl && registration?.credentialSaved && registration.state !== 'connected'" :href="consoleUrl" target="_blank" rel="noopener noreferrer">在飞书后台检查权限、发布与审批 ↗</a>
      <NSpace class="registration-actions"><NButton v-if="!boundAppId && !registration?.credentialSaved && !pending" type="primary" :disabled="!canStart" :loading="busy" @click="request('start')">{{ uncertain ? '重试同一次创建请求' : '创建飞书应用' }}</NButton><NButton v-if="canRetry" type="primary" :disabled="busy || disabled" @click="request('retry')">重新检查已保存的应用</NButton><NButton v-if="pending && !registration?.credentialSaved" :disabled="busy || disabled" @click="request('cancel')">取消等待</NButton><NButton :disabled="busy" @click="request()">刷新创建状态</NButton></NSpace>
    </template>
    <NAlert v-if="error" type="error" role="alert">{{ error }}<p>请求结果可能尚未确认。请先刷新状态；重试创建将沿用同一次请求，不会主动开启另一项创建。</p></NAlert>
    <p class="field-note">也可以在下方手动填写已有应用凭据。</p>
  </section>
</template>
<style scoped>
.feishu-registration{border:1px solid var(--border);border-radius:12px;padding:20px;display:grid;gap:14px;background:var(--surface)}
h3,h4,p{margin:0}.registration-preview{border-left:3px solid var(--primary-color,#387b68);padding:8px 14px;display:grid;gap:6px;background:var(--surface-muted,#f5f8f7)}.registration-preview p{white-space:pre-wrap}.registration-manifest{font-size:13px;overflow-wrap:anywhere}.registration-manifest summary{cursor:pointer}.registration-manifest h4{margin-top:12px}.registration-manifest ul{padding-left:20px}.registration-progress{display:grid;gap:8px;font-size:13px}.registration-scan{display:flex;align-items:center;gap:24px;flex-wrap:wrap}.registration-scan p{margin:8px 0}.registration-actions{margin-top:4px}
</style>
