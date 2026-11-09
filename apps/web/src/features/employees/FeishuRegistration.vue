<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NSpace, NTag } from 'naive-ui';
import { api, ApiError, errorMessage } from '../../shared/api';
import FeishuRegistrationQr from './FeishuRegistrationQr.vue';
import ChannelValidationReport from './ChannelValidationReport.vue';
import type { ChannelValidation } from './channel-validation';
import { feishuRegistrationOperations as operations } from './feishu-registration-operations';

interface PermissionGroup { id: string; label: string; required: boolean; identity: 'tenant' | 'user'; scopes: string[]; note?: string; scopeNotes?: Record<string, string> }
interface PermissionResult extends PermissionGroup { status: 'granted' | 'missing' | 'unknown'; missingScopes: string[]; scopeStates: { scope: string; status: 'granted' | 'missing' | 'unknown' }[] }
type State = 'starting' | 'awaiting_confirmation' | 'credentials_saved' | 'checking' | 'needs_attention' | 'connected' | 'cancelled' | 'expired' | 'denied' | 'failed' | 'interrupted';
interface PermissionManifest { version: string; scopes: string[]; events: string[]; userScopes?: string[]; groups?: PermissionGroup[] }
interface Registration { id: string; state: State; appId?: string; credentialSaved: boolean; verificationUrl?: string; expiresAt?: number; error?: string; missingScopes?: string[]; validation?: ChannelValidation; updatedAt: number; permissionGroups?: PermissionResult[]; profileVersion?: string; requestedPermissions?: PermissionManifest; autoCheck?: { eligible: boolean; inProgress: boolean; nextCheckAt: number | null } }
interface Envelope { registration: Registration | null; preset: { name: string; description: string }; permissions: PermissionManifest }
const props = defineProps<{ base: string; active: boolean; disabled?: boolean; boundAppId?: string | undefined }>();
const emit = defineEmits<{ changed: []; sessionExpired: []; busyChanged: [boolean] }>();
const data = ref<Envelope | null>(null), busy = ref(false), error = ref(''), uncertain = ref(false);
const now = ref(Date.now());
const registration = computed(() => data.value?.registration);
const showingRequested = computed(() => !!registration.value && (registration.value.credentialSaved || !['cancelled', 'expired', 'denied', 'failed', 'interrupted'].includes(registration.value.state)));
const displayedManifest = computed(() => showingRequested.value ? registration.value?.requestedPermissions : data.value?.permissions);
const displayedGroups = computed<Array<PermissionGroup & Partial<PermissionResult>>>(() => showingRequested.value && registration.value?.permissionGroups?.length ? registration.value.permissionGroups : displayedManifest.value?.groups ?? []);
const pending = computed(() => !!registration.value && ['starting', 'awaiting_confirmation', 'checking'].includes(registration.value.state));
const matching = computed(() => !props.boundAppId || registration.value?.appId === props.boundAppId);
const labels: Record<State, string> = { starting: '正在准备飞书创建请求', awaiting_confirmation: '等待在飞书确认创建', credentials_saved: '凭据已保存，等待检查', checking: '正在检查已保存的应用', needs_attention: '检查未通过，需要处理', connected: '基础检查通过，已启用渠道', cancelled: '已取消本次等待', expired: '二维码已过期', denied: '飞书创建请求被拒绝', failed: '创建未完成', interrupted: '操作已中断' };
const qrExpired = computed(() => !!registration.value?.expiresAt && now.value >= registration.value.expiresAt);
const secondsLeft = computed(() => Math.max(0, Math.ceil(((registration.value?.expiresAt ?? now.value) - now.value) / 1000)));
const permissionStatus = { granted: '授权已生效', missing: '授权未齐', unknown: '授权待确认' };
const officialUrl = computed(() => {
  if (registration.value?.state !== 'awaiting_confirmation' || qrExpired.value) return '';
  try { const url = new URL(registration.value.verificationUrl ?? ''); return url.protocol === 'https:' && ['accounts.feishu.cn', 'open.feishu.cn'].includes(url.hostname) && !url.username && !url.password && !url.port ? url.href : ''; } catch { return ''; }
});
const consoleUrl = computed(() => /^cli_[a-zA-Z0-9]+$/.test(registration.value?.appId ?? '') ? `https://open.feishu.cn/app/${registration.value!.appId}` : '');
const canStart = computed(() => !props.boundAppId && !registration.value?.credentialSaved && !pending.value && !!data.value && !busy.value && !props.disabled);
const canRetry = computed(() => matching.value && !!registration.value?.credentialSaved && !pending.value && !registration.value?.autoCheck?.inProgress);
let controller = new AbortController(), generation = 0, timer: ReturnType<typeof setTimeout> | undefined, clockTimer: ReturnType<typeof setInterval> | undefined;
let announced = '', failures = 0, halted = false;
const pollingAllowed = () => props.active && !document.hidden && !props.disabled;
function stop() { generation++; controller.abort(); controller = new AbortController(); clearTimeout(timer); clearInterval(clockTimer); busy.value = false; emit('busyChanged', false); }
function schedule() {
  clearTimeout(timer);
  if (!pollingAllowed() || halted || !matching.value) return;
  const auto = registration.value?.autoCheck;
  if (!failures && !pending.value && !auto?.eligible && !auto?.inProgress) return;
  const delay = failures ? Math.min(1000 * 2 ** failures, 30000) : auto?.eligible && !auto.inProgress && typeof auto.nextCheckAt === 'number' ? Math.min(10000, Math.max(500, auto.nextCheckAt - Date.now())) : 1800;
  timer = setTimeout(() => {
    if (!pollingAllowed()) return;
    const next = registration.value?.autoCheck;
    const due = !failures && canRetry.value && registration.value?.credentialSaved && next?.eligible && !next.inProgress && typeof next.nextCheckAt === 'number' && next.nextCheckAt <= Date.now();
    void request(due ? 'retry' : undefined, !!due);
  }, delay);
}
async function request(action?: 'start' | 'retry' | 'cancel', automatic = false) {
  if (!props.active || document.hidden || busy.value || (action || automatic) && props.disabled) return;
  const origin = props.base, epoch = generation, signal = controller.signal;
  const id = registration.value?.id;
  if (action === 'start' && !canStart.value || action === 'retry' && !canRetry.value || action === 'cancel' && !id) return;
  if (action === 'start' && !operations.has(origin)) operations.set(origin, crypto.randomUUID());
  busy.value = true; emit('busyChanged', !!action && !automatic); error.value = '';
  try {
    const result = await api<Envelope>(`${origin}/channels/feishu/registration${action && action !== 'start' ? `/${action}` : ''}`, AbortSignal.any([signal, AbortSignal.timeout(15000)]), action ? action === 'start' ? { operationId: operations.get(origin) } : { id, ...(automatic ? { automatic: true } : {}) } : undefined, action ? 'POST' : undefined);
    if (epoch !== generation || signal.aborted) return;
    if (!result || !result.preset || !result.permissions) throw new Error('无法读取飞书创建配置');
    data.value = result; now.value = Date.now(); uncertain.value = false; failures = 0; halted = false;
    if (result.registration) operations.delete(origin);
    if (result.registration?.state === 'connected' && announced !== result.registration.id) { announced = result.registration.id; busy.value = false; emit('busyChanged', false); emit('changed'); }
  } catch (cause) {
    if (epoch !== generation || signal.aborted) return;
    error.value = errorMessage(cause); if (action === 'start') uncertain.value = true;
    failures++; halted = cause instanceof ApiError && [401, 403, 404].includes(cause.status);
    if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired');
  } finally {
    if (epoch === generation) { busy.value = false; emit('busyChanged', false); schedule(); }
  }
}
function resume() { now.value = Date.now(); if (!pollingAllowed()) return; clockTimer = setInterval(() => { now.value = Date.now(); }, 1000); void request(); }
// Hiding this tab is expected while confirming in Feishu. Only the explicit
// cancel button may cancel server work; lifecycle cleanup stops local polling.
function suspend() { stop(); }
function visibility() { if (document.hidden) suspend(); else { stop(); resume(); } }
watch(() => [props.base, props.active, props.disabled] as const, ([base], old) => {
  stop(); failures = 0; halted = false; error.value = ''; uncertain.value = operations.has(base);
  if (!old || old[0] !== base) { data.value = null; announced = ''; }
  resume();
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
      <p v-if="showingRequested && !displayedManifest" class="field-note">本次申请清单暂不可用，请刷新状态或查看飞书后台；不会用新建默认权限代替历史申请。</p>
      <details v-if="displayedManifest" class="registration-manifest"><summary>{{ showingRequested ? '本次申请权限' : '新建时申请权限' }}与事件（{{ displayedManifest.version }}）</summary><h4>应用身份权限</h4><ul><li v-for="scope in displayedManifest.scopes" :key="scope">{{ scope }}</li></ul><template v-if="displayedManifest.userScopes?.length"><h4>个人身份权限（仍需个人 OAuth 授权）</h4><ul><li v-for="scope in displayedManifest.userScopes" :key="scope">{{ scope }}</li></ul></template><h4>事件</h4><ul><li v-for="event in displayedManifest.events" :key="event">{{ event }}</li></ul></details>
      <div v-if="displayedGroups.length" class="registration-permission-groups" aria-label="基础与扩展权限">
        <section v-for="group in displayedGroups" :key="group.id" class="registration-permission-group" :data-required="group.required">
          <header><strong>{{ group.label }}</strong><NTag size="small">{{ group.required ? '基础 · 必需' : '扩展 · 独立授权' }}</NTag><span>{{ group.status ? permissionStatus[group.status] : '将申请' }}</span></header>
          <p v-if="group.note">{{ group.note }}</p><p v-if="group.identity === 'user'">个人身份权限仍需使用者完成个人 OAuth 授权；应用创建不代表个人已授权。</p>
          <details><summary>查看权限明细</summary><ul><li v-for="scope in group.scopes" :key="scope">{{ scope }} <span v-if="group.scopeStates"> · {{ permissionStatus[group.scopeStates.find(item => item.scope === scope)?.status ?? 'unknown'] }}</span><p v-if="group.scopeNotes?.[scope]" class="scope-evidence-note">{{ group.scopeNotes[scope] }}</p></li></ul></details>
        </section>
        <p class="field-note">基础检查通过即可启用渠道。扩展授权独立显示，授权生效不代表相关业务功能已实现或具体资料可访问。</p>
      </div>
      <p class="field-note">飞书可能忽略未识别权限，本页核对实际返回，未返回或未知不计为已授权。</p>
      <div v-if="registration" class="registration-progress" role="status" aria-live="polite"><strong>{{ labels[registration.state] }}</strong><p v-if="registration.credentialSaved">应用凭据已安全保存，无需重新扫码或填写密钥。凭据已取得不代表审批、发布或所有权限都已生效。</p><p v-if="registration.state === 'connected'">请核对渠道连接状态与使用范围，再用获准账号验证真实消息收发。</p><p v-if="registration.autoCheck?.inProgress">正在更新权限授权状态，已启用的基础渠道保持可用。</p><p v-else-if="registration.autoCheck?.eligible">停留在本页时将自动复查授权；离开页面后停止刷新。</p><p v-if="disabled && registration.credentialSaved">有未保存的修改或其他操作，自动检查暂已暂停。</p><p v-if="registration.expiresAt && pending">本次确认有效期至 {{ new Date(registration.expiresAt).toLocaleString('zh-CN') }}</p><p v-if="registration.error">{{ registration.error }}</p></div>
      <NAlert v-if="registration && !registration.credentialSaved && ['cancelled', 'expired', 'failed', 'interrupted'].includes(registration.state)" type="warning">停止等待不代表撤销飞书侧操作。如果已在飞书确认创建，请先检查飞书后台；也可使用下方手动接入，避免重复创建应用。</NAlert>
      <section v-if="registration && ['starting', 'awaiting_confirmation', 'expired'].includes(registration.state)" class="registration-scan" aria-label="identale 发起的飞书应用授权卡片">
        <header class="scan-card-heading"><img src="/channel-logos/feishu.png" width="32" height="32" alt="飞书"/><div><span class="scan-issuer">identale 发起</span><h4>飞书扫码创建应用</h4></div><NTag size="small">{{ qrExpired || registration.state === 'expired' ? '已过期' : officialUrl ? '待确认' : '准备中' }}</NTag></header>
        <div class="scan-card-body"><div class="scan-qr-frame"><FeishuRegistrationQr v-if="officialUrl" :value="officialUrl"/><div v-else class="scan-qr-placeholder" role="status">{{ qrExpired || registration.state === 'expired' ? '二维码已过期，请刷新状态' : '正在准备二维码' }}</div></div><div class="scan-instructions"><strong>用飞书扫描并确认</strong><p>请核对应用名称和申请权限。创建与授权由飞书确认页完成。</p><p v-if="officialUrl && registration.expiresAt" role="timer">二维码剩余 {{ secondsLeft }} 秒</p><a v-if="officialUrl" :href="officialUrl" target="_blank" rel="noopener noreferrer">打开飞书确认页 ↗</a><p class="field-note">这是 identale 的接入引导，不是飞书官方页面。</p></div></div>
      </section>
      <NAlert v-if="registration?.missingScopes?.length" type="warning"><strong>尚未生效的权限</strong><ul><li v-for="scope in registration.missingScopes" :key="scope">{{ scope }}</li></ul></NAlert>
      <ChannelValidationReport v-if="registration?.validation" :report="registration.validation"/>
      <a v-if="consoleUrl && registration?.credentialSaved" :href="consoleUrl" target="_blank" rel="noopener noreferrer">在飞书后台检查权限、发布与审批 ↗</a>
      <NSpace class="registration-actions"><NButton v-if="!boundAppId && !registration?.credentialSaved && !pending" type="primary" :disabled="!canStart" :loading="busy" @click="request('start')">{{ uncertain ? '重试同一次创建请求' : '创建飞书应用' }}</NButton><NButton v-if="canRetry" type="primary" :disabled="busy || disabled" @click="request('retry')">重新检查已保存的应用</NButton><NButton v-if="pending && !registration?.credentialSaved" :disabled="busy || disabled" @click="request('cancel')">取消等待</NButton><NButton :disabled="busy" @click="request()">刷新创建状态</NButton></NSpace>
    </template>
    <NAlert v-if="error" type="error" role="alert">{{ error }}<p>请求结果可能尚未确认。请先刷新状态；重试创建将沿用同一次请求，不会主动开启另一项创建。</p></NAlert>
    <p class="field-note">也可以在下方手动填写已有应用凭据。</p>
  </section>
</template>
<style scoped>
.feishu-registration{border:1px solid var(--border);border-radius:12px;padding:20px;display:grid;gap:14px;background:var(--surface)}
h3,h4,p{margin:0}.registration-preview{border-left:3px solid var(--primary-color,#387b68);padding:8px 14px;display:grid;gap:6px;background:var(--surface-muted,#f5f8f7)}.registration-preview p{white-space:pre-wrap}.registration-manifest{font-size:13px;overflow-wrap:anywhere}.registration-manifest summary{cursor:pointer}.registration-manifest h4{margin-top:12px}.registration-manifest ul{padding-left:20px}.registration-progress{display:grid;gap:8px;font-size:13px}.registration-scan{min-width:0;border:1px solid #c4d5ff;border-radius:14px;overflow:hidden;background:var(--surface)}.scan-card-heading{display:flex;align-items:center;gap:12px;padding:16px 20px;background:linear-gradient(110deg,#eef4ff,#f4f8ff);color:#203c73}.scan-card-heading>.n-tag{margin-left:auto}.scan-issuer{font-size:11px;letter-spacing:.06em}.scan-card-body{display:flex;align-items:center;gap:24px;flex-wrap:wrap;padding:22px}.scan-qr-frame{max-width:100%;box-sizing:border-box;padding:10px;border:2px solid #3370ff;border-radius:12px;background:white;flex:none}.scan-qr-frame :deep(.n-qr-code){max-width:100%;height:auto!important}.scan-qr-frame :deep(canvas){max-width:100%;height:auto!important}.scan-qr-placeholder{max-width:100%;width:192px;height:192px;display:grid;place-items:center;text-align:center;color:#536481;font-size:13px;padding:16px;box-sizing:border-box}.scan-instructions{flex:1;min-width:160px;font-size:13px}.registration-permission-groups{display:grid;gap:10px}.registration-permission-group{padding:12px;border:1px solid var(--border);border-radius:8px;font-size:13px;overflow-wrap:anywhere}.scope-evidence-note{color:var(--muted);font-size:12px;line-height:1.6}.registration-permission-group header{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.registration-permission-group p,.registration-permission-group details{margin-top:8px}@media(max-width:480px){.scan-card-body{justify-content:center;padding:16px}.scan-instructions{text-align:center}}.registration-scan p{margin:8px 0}.registration-actions{margin-top:4px}
</style>
