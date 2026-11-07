<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NCheckbox, NForm, NFormItem, NInput, NSelect } from 'naive-ui';
import { api, ApiError, errorMessage } from '../../shared/api';
import InfoHint from '../../shared/ui/InfoHint.vue';
import ChannelValidationReport from './ChannelValidationReport.vue';
import { channelApi, ChannelValidationFailure, type ChannelValidation } from './channel-validation';
import type { DirectoryConnection } from '../directory/types';
interface Credential { id: string; label: string; corpId: string; agentId: string; revision: number; credentialRevision: number; scopeRevision: string; status: string; lastError?: string | null; lastVerifiedAt?: number | null; referenceCount: number }
interface Impact { credentialId: string; revision: number; impactRevision: string; employees: { entityId: string; connectionId: string; name: string }[] }
const props = defineProps<{ base: string; connection?: DirectoryConnection | undefined; disabled: boolean }>();
const emit = defineEmits<{ busyChanged: [value: boolean]; changed: []; sessionExpired: [] }>();
const credentials = ref<Credential[]>([]), selectedId = ref<string | null>(null), mode = ref<'reuse' | 'create' | 'edit'>('reuse');
const selected = computed(() => credentials.value.find(item => item.id === selectedId.value));
const label = ref(''), corpId = ref(''), agentId = ref(''), appSecret = ref(''), sameCorp = ref(false), impactConfirmed = ref(false);
const impact = ref<Impact | null>(null), busy = ref(false), loaded = ref(false), error = ref(''), notice = ref('');
const report = ref<ChannelValidation | null>(null);
const blocked = computed(() => busy.value || props.disabled);
const complete = computed(() => !!label.value.trim() && !!corpId.value.trim() && /^\d+$/.test(agentId.value.trim()) && !!appSecret.value);
const endpoint = computed(() => `${props.base}/channels/wecom`);
let controller = new AbortController();
watch(busy, value => emit('busyChanged', value), { flush: 'sync' });
watch(selectedId, () => { sameCorp.value = false; impact.value = null; impactConfirmed.value = false; appSecret.value = ''; mode.value = 'reuse'; });
watch(() => props.connection?.revision, () => { sameCorp.value = false; impact.value = null; impactConfirmed.value = false; });
watch([label, corpId, agentId, appSecret], () => { impactConfirmed.value = false; });
async function read(signal: AbortSignal) {
  const result = await api<Credential[]>(`${endpoint.value}/directory-credentials`, signal);
  if (signal.aborted) return;
  credentials.value = result; loaded.value = true;
  if (!result.some(item => item.id === selectedId.value)) selectedId.value = result.find(item => item.id === props.connection?.directoryBinding?.credentialId)?.id ?? result[0]?.id ?? null;
  if (!result.length) mode.value = 'create';
}
async function run(action: (signal: AbortSignal) => Promise<void>, changed = false) {
  if (blocked.value) return; const signal = controller.signal; busy.value = true; error.value = ''; notice.value = '';
  try { await action(signal); }
  catch (cause) { if (!signal.aborted) { if (cause instanceof ChannelValidationFailure && cause.validation) { report.value = cause.validation; error.value = ''; } else error.value = cause instanceof ApiError && cause.status === 409 ? '配置或受影响员工已变化，未按旧确认继续修改。请刷新目录应用、重新预览影响并确认。' : errorMessage(cause); if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired'); } }
  finally { if (!signal.aborted) { busy.value = false; if (changed) emit('changed'); } }
}
async function refresh() { await run(async signal => { impact.value = null; impactConfirmed.value = false; sameCorp.value = false; await read(signal); }); }
async function verifyStored() {
  if (!selected.value) return; const current = selected.value;
  await run(async signal => { const result = await channelApi<{validation:ChannelValidation}>(`${endpoint.value}/directory-credentials/${encodeURIComponent(current.id)}/revalidate`, signal, {expectedRevision:current.revision});
    if (!signal.aborted) { report.value = result.validation; notice.value = '所选目录应用已单独验证。无需机器人凭据；企业关系仍需另行确认。'; await read(signal); }
  }, true);
}
function begin(modeValue: 'create' | 'edit') {
  mode.value = modeValue; impact.value = null; impactConfirmed.value = false; sameCorp.value = false; appSecret.value = '';
  label.value = modeValue === 'edit' ? selected.value?.label ?? '' : '';
  corpId.value = modeValue === 'edit' ? selected.value?.corpId ?? '' : '';
  agentId.value = modeValue === 'edit' ? selected.value?.agentId ?? '' : '';
}
async function preview() {
  if (!selected.value) return;
  await run(async signal => { const result = await api<Impact>(`${endpoint.value}/directory-credentials/${encodeURIComponent(selected.value!.id)}/impact`, signal); if (!signal.aborted) { impact.value = result; impactConfirmed.value = false; } });
}
async function save() {
  if (!complete.value || !loaded.value || mode.value === 'reuse') return;
  const editing = mode.value === 'edit', currentImpact = impact.value;
  if (editing && (!selected.value || !currentImpact || !impactConfirmed.value || currentImpact.credentialId !== selected.value.id)) return;
  const body = { label: label.value.trim(), corpId: corpId.value.trim(), agentId: agentId.value.trim(), appSecret: appSecret.value, ...(editing ? { expectedRevision: currentImpact!.revision, impactRevision: currentImpact!.impactRevision } : {}) };
  const url = `${endpoint.value}/directory-credentials${editing ? `/${encodeURIComponent(selected.value!.id)}` : ''}`;
  await run(async signal => {
    appSecret.value = '';
    try { const result = await channelApi<Credential & {validation?:ChannelValidation}>(url, signal, body, editing ? 'PUT' : 'POST'); if (!signal.aborted) { selectedId.value = result.id; report.value = result.validation ?? null; mode.value = 'reuse'; sameCorp.value = false; notice.value = editing ? '共享目录配置已更新。受影响员工需重新确认企业关系、验证机器人并核对使用范围。' : '目录应用已保存。请明确确认本机器人与此应用属于同一企业。'; } }
    finally { if (!signal.aborted) { impact.value = null; impactConfirmed.value = false; await read(signal); } }
  }, true);
}
async function bind(unbind = false) {
  if (!props.connection || !loaded.value || (!unbind && (!sameCorp.value || selected.value?.status !== 'verified'))) return;
  const body = { expectedRevision: props.connection.revision, ...(!unbind ? { credentialId: selected.value!.id, confirmSameCorp: true } : {}) };
  await run(async signal => { if(unbind) await api(`${endpoint.value}/directory-binding`, signal, body, 'DELETE'); else { const result = await channelApi<{validation?:ChannelValidation}>(`${endpoint.value}/directory-binding`, signal, body, 'PUT'); report.value = result.validation ?? null; } if (!signal.aborted) { sameCorp.value = false; notice.value = unbind ? '仅解除本员工目录关联，共享应用及其他员工不受影响。' : '已记录管理员同企业声明。请继续完成机器人身份挑战验证，并配置本员工使用范围。'; await read(signal); } }, true);
}
watch(() => props.base, () => { controller.abort(); controller = new AbortController(); busy.value = false; loaded.value = false; credentials.value = []; selectedId.value = null; appSecret.value = ''; sameCorp.value = false; impact.value = null; impactConfirmed.value = false; void refresh(); }, { immediate: true });
watch(() => props.disabled, value => { if (!value && !loaded.value && !busy.value) void refresh(); });
onUnmounted(() => { controller.abort(); appSecret.value = ''; emit('busyChanged', false); });
</script>
<template>
  <NCard title="通讯录应用" size="small" class="wecom-directory-binding">
    <div class="form-section-heading"><p class="field-note">用于选择可使用员工的人员和部门，可复用已有应用。</p><a href="https://work.weixin.qq.com/wework_admin/frame" target="_blank" rel="noopener noreferrer">打开官方后台 ↗</a></div><p class="field-note">必要权限：开放可见部门、人员及姓名读取，并按官方要求配置可信 IP。</p>
    <ChannelValidationReport v-if="report" :report="report" />
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert><NAlert v-if="notice" type="info" role="status">{{ notice }}</NAlert>
    <NButton :disabled="blocked" @click="refresh">刷新可复用目录应用</NButton>
    <NSelect v-if="credentials.length" v-model:value="selectedId" :disabled="blocked" aria-label="复用已配置目录应用" :options="credentials.map(item => ({ label: `${item.label} · CorpID ${item.corpId} · AgentId ${item.agentId} · ${item.referenceCount} 位员工`, value: item.id }))" placeholder="复用已配置目录应用" />
    <p v-if="loaded && !credentials.length">尚无可复用目录应用，请首次配置传统自建应用。</p>
    <template v-if="selected"><p>目录应用：{{ selected.label }} · CorpID {{ selected.corpId }} · AgentId {{ selected.agentId }}</p><p>目录验证：{{ selected.status === 'verified' ? '已验证' : '不可用，需检查或更新' }} · 引用员工 {{ selected.referenceCount }} 位 · 最近验证：{{ selected.lastVerifiedAt ? new Date(selected.lastVerifiedAt).toLocaleString('zh-CN') : '尚无记录' }}</p><p v-if="selected.lastError" role="status">{{ selected.lastError }}</p></template>
    <NButton v-if="selected" :disabled="blocked" @click="verifyStored">单独验证所选通讯录与姓名</NButton>
    <div class="actions"><NButton :disabled="blocked || !loaded" @click="begin('create')">配置另一个目录应用</NButton><NButton v-if="selected" :disabled="blocked" @click="begin('edit')">修改共享目录应用 / 轮换密钥</NButton></div>
    <NForm class="settings-form" v-if="mode !== 'reuse'" @submit.prevent="save">
      <NFormItem label="目录应用名称"><NInput v-model:value="label" :disabled="blocked" :input-props="{ 'aria-label': '目录应用名称' }" /></NFormItem>
      <NFormItem label="企业 CorpID"><NInput v-model:value="corpId" :disabled="blocked" :input-props="{ 'aria-label': '目录 CorpID', autocomplete: 'off' }" /></NFormItem>
      <NFormItem label="AgentId（数字）"><NInput v-model:value="agentId" :disabled="blocked" :input-props="{ 'aria-label': '目录 AgentId', inputmode: 'numeric', autocomplete: 'off' }" /></NFormItem>
      <NFormItem label="应用 AppSecret"><NInput v-model:value="appSecret" type="password" :disabled="blocked" :input-props="{ 'aria-label': '目录 AppSecret', autocomplete: 'new-password' }" /></NFormItem>
      <template v-if="mode === 'edit'"><NAlert type="warning">修改会使所有引用员工的旧授权失效，须重新确认企业关系、验证和核对使用范围。只想更改本员工时，请新建另一个应用并重新关联。</NAlert><NButton :disabled="blocked" @click="preview">预览受影响员工</NButton><template v-if="impact"><p>受影响员工：{{ impact.employees.length }} 位</p><ul><li v-for="employee in impact.employees" :key="employee.connectionId">{{ employee.name }}（{{ employee.entityId }}）</li></ul><NCheckbox v-model:checked="impactConfirmed" :disabled="blocked" aria-label="确认共享修改影响">我已核对以上员工及授权失效影响</NCheckbox></template></template>
      <NButton attr-type="submit" type="primary" :disabled="blocked || !loaded || !complete || (mode === 'edit' && (!impact || !impactConfirmed))">{{ mode === 'edit' ? '确认更新共享目录应用' : '验证并保存目录应用' }}</NButton>
    </NForm>
    <template v-if="mode === 'reuse' && selected">
      <p class="field-note">请核对机器人与通讯录应用属于同一企业。<InfoHint label="同企业确认依据">此关系由管理员明确确认，平台无法通过厂商接口证明；目录和机器人身份仍分别验证。</InfoHint></p>
      <NCheckbox v-model:checked="sameCorp" :disabled="blocked || !connection || selected.status !== 'verified'" aria-label="确认机器人与目录同企业">我确认此智能机器人与所选传统自建应用属于同一企业（CorpID {{ selected.corpId }}）</NCheckbox>
      <p v-if="!connection">目录可先独立验证并保存；在下方保存机器人后，再确认同企业关联。</p>
      <NButton :disabled="blocked || !connection || !sameCorp || selected.status !== 'verified'" type="primary" @click="bind()">确认企业关系并关联本员工</NButton>
    </template>
    <template v-if="connection?.directoryBinding"><p>当前关联：CorpID {{ connection.directoryBinding.corpId }} · AgentId {{ connection.directoryBinding.agentId }} · {{ connection.directoryBinding.status === 'confirmed' ? '管理员已确认' : '需要重新确认' }}</p><InfoHint label="目录关联说明">确认时间：{{new Date(connection.directoryBinding.assertion.confirmedAt).toLocaleString('zh-CN')}}。仅关联本员工，不继承其他员工的使用范围。</InfoHint><NButton :disabled="blocked" @click="bind(true)">仅解除本员工目录关联</NButton></template>
  </NCard>
</template>
<style scoped>.wecom-directory-binding :deep(.n-card__content) { display: grid; gap: 0.875rem; }.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; }p { overflow-wrap: anywhere; }</style>
