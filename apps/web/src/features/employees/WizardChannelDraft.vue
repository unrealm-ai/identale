<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NForm, NFormItem, NInput, NSelect, NSpace } from 'naive-ui';
import { api, ApiError, errorMessage } from '../../shared/api';
import ChannelProviderTabs from './ChannelProviderTabs.vue';
import type { EmployeeChannelDraft } from './useEmployeeWizard';
import type { DirectoryProvider } from '../directory/types';
import WizardChannelGuide from './WizardChannelGuide.vue';
import ChannelValidationReport from './ChannelValidationReport.vue';
import { channelApi, ChannelValidationFailure, type ChannelValidation } from './channel-validation';
const props = defineProps<{ base: string; disabled: boolean }>();
const emit = defineEmits<{ change: [draft: EmployeeChannelDraft | null]; readyChanged: [value: boolean]; busyChanged: [value: boolean]; sessionExpired: [] }>();
const provider = ref<DirectoryProvider>('feishu'), configuring = ref(true), busy = ref(false), directoryBusy = ref(false), error = ref(''), directoryError = ref('');
const blocked = computed(() => props.disabled || busy.value || directoryBusy.value);
const appId = ref(''), appSecret = ref(''), credentialId = ref<string | null>(null), label = ref(''), corpId = ref(''), agentId = ref(''), directorySecret = ref(''), confirmSameCorp = ref(false);
const credentials = ref<{ id: string; label: string; corpId: string; agentId: string; status: string }[]>([]);
const draft = ref<EmployeeChannelDraft | null>(null), scopeNotice = ref(''), report = ref<ChannelValidation | null>(null), directoryReport = ref<ChannelValidation | null>(null);
type DirectoryDraft = { draftId: string; expiresAt: number; validation: ChannelValidation };
const directoryDraft = ref<DirectoryDraft | null>(null);
const controller = new AbortController(); let expiry: ReturnType<typeof setTimeout> | undefined, directoryExpiry: ReturnType<typeof setTimeout> | undefined;
let version = 0, directoryVersion = 0, alive = true;
watch(() => busy.value || directoryBusy.value, value => emit('busyChanged', value), { flush: 'sync' });
watch([configuring, draft], () => { emit('change', draft.value); emit('readyChanged', !configuring.value || !!draft.value); }, { immediate: true, flush: 'sync' });
function removeDraft(id: string) { void api(`${props.base}/employee-channel-drafts/${encodeURIComponent(id)}`, new AbortController().signal, undefined, 'DELETE').catch(() => {}); }
function discard() {
  clearTimeout(expiry); version++;
  const old = draft.value; draft.value = null; scopeNotice.value = ''; report.value = null;
  if (old) removeDraft(old.draftId);
}
function discardDirectory() {
  clearTimeout(directoryExpiry); directoryVersion++;
  const old = directoryDraft.value; directoryDraft.value = null; directoryReport.value = null; directoryError.value = ''; confirmSameCorp.value = false;
  if (old) removeDraft(old.draftId);
  discard();
}
watch([appId, appSecret, confirmSameCorp], discard, { flush: 'sync' });
watch([credentialId, label, corpId, agentId, directorySecret], discardDirectory, { flush: 'sync' });
watch(provider, () => {
  discardDirectory(); configuring.value = true; error.value = ''; appId.value = ''; appSecret.value = ''; credentialId.value = null;
  label.value = ''; corpId.value = ''; agentId.value = ''; directorySecret.value = '';
}, { flush: 'sync' });
function skip() { if (blocked.value) return; discardDirectory(); appSecret.value = ''; directorySecret.value = ''; configuring.value = false; error.value = ''; }
const validDirectory = computed(() => !!credentialId.value || !!label.value.trim() && !!corpId.value.trim() && /^\d+$/.test(agentId.value.trim()) && !!directorySecret.value);
const valid = computed(() => !!appId.value.trim() && !!appSecret.value && (provider.value !== 'wecom' || confirmSameCorp.value && !!directoryDraft.value));
function validationError(cause: unknown, directory = false) {
  const validation = cause instanceof ChannelValidationFailure ? cause.validation : undefined;
  if (directory) { directoryReport.value = validation ?? null; directoryError.value = validation ? '' : errorMessage(cause); }
  else { report.value = validation ?? null; error.value = validation ? '' : errorMessage(cause); }
  if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired');
}
async function verifyDirectory() {
  if (blocked.value || !validDirectory.value) return;
  discardDirectory(); const generation = directoryVersion; directoryBusy.value = true;
  try {
    const result = await channelApi<DirectoryDraft>(`${props.base}/employee-channel-drafts`, controller.signal, { provider: 'wecom', operation: 'directory', directory: credentialId.value ? { credentialId: credentialId.value } : { label: label.value.trim(), corpId: corpId.value.trim(), agentId: agentId.value.trim(), appSecret: directorySecret.value } });
    if (!alive || generation !== directoryVersion || provider.value !== 'wecom') { removeDraft(result.draftId); return; }
    if (!result.validation.canContinue) { directoryReport.value = result.validation; removeDraft(result.draftId); return; }
    directoryDraft.value = result; directoryReport.value = result.validation;
    directoryExpiry = setTimeout(() => { discardDirectory(); directoryError.value = '目录验证已过期，请重新验证。'; }, Math.max(0, result.expiresAt - Date.now()));
  } catch (cause) { if (alive && !controller.signal.aborted) validationError(cause, true); }
  finally { directoryBusy.value = false; }
}
async function verify() {
  if (blocked.value || !valid.value) return;
  discard(); const generation = version, selected = provider.value; busy.value = true; error.value = '';
  try {
    const result = await channelApi<EmployeeChannelDraft & { scope: { departmentCount: number|null; userCount: number|null; entireOrganization: boolean } }>(`${props.base}/employee-channel-drafts`, controller.signal, {
      provider: selected, appId: appId.value.trim(), appSecret: appSecret.value,
      ...(selected === 'wecom' ? { directory: { draftId: directoryDraft.value!.draftId, confirmSameCorp: confirmSameCorp.value } } : {}),
    });
    if (!alive || generation !== version || selected !== provider.value) { removeDraft(result.draftId); return; }
    const validation = (result.source as typeof result.source & { validation?: ChannelValidation }).validation;
    if (!validation?.canContinue) { error.value = '必要验证结果不完整，请重新验证。'; removeDraft(result.draftId); return; }
    report.value = validation; draft.value = result;
    expiry = setTimeout(() => { discard(); error.value = '渠道草稿已过期，请重新验证。'; }, Math.max(0, result.expiresAt - Date.now()));
    scopeNotice.value = `已读取可见范围：${result.scope.departmentCount===null?'部门入口未披露':`${result.scope.departmentCount} 个部门入口`}、${result.scope.userCount===null?'直接用户入口未披露':`${result.scope.userCount} 个直接用户入口`}。`;
  } catch (cause) { if (alive && !controller.signal.aborted) validationError(cause); }
  finally { busy.value = false; }
}
void api<{ directoryCredentials: typeof credentials.value }>(`${props.base}/employee-creation-options`, controller.signal).then(result => { if (alive) credentials.value = result.directoryCredentials; }).catch(() => {});
onUnmounted(() => { alive = false; controller.abort(); discardDirectory(); appSecret.value = ''; directorySecret.value = ''; emit('busyChanged', false); });
</script>
<template>
<div class="channel-draft">
  <ChannelProviderTabs v-model="provider" :disabled="blocked">
    <template v-if="$slots.automation" #automation><slot name="automation" /></template>
    <p class="field-note">先验证必要身份与目录读取，再配置能力包。最后确认创建才保存并启动连接，不发送测试消息。</p>
    <WizardChannelGuide :report="report" :provider="provider" :ready="!configuring || !!draft" :busy="busy || directoryBusy" :skipped="!configuring" :locked="blocked">
      <template #directory>
        <NForm v-if="configuring" @submit.prevent="verifyDirectory">
          <NFormItem label="复用已有目录应用"><NSelect v-model:value="credentialId" clearable :virtual-scroll="false" :options="credentials.filter(c => c.status === 'verified').map(c => ({ value: c.id, label: `${c.label} · ${c.corpId} / ${c.agentId}` }))" placeholder="已有应用可直接选择；否则新建配置" :disabled="blocked" aria-label="企业微信通讯录应用" /></NFormItem>
          <template v-if="!credentialId">
            <NFormItem label="通讯录配置名称"><NInput v-model:value="label" :input-props="{ 'aria-label': '通讯录配置名称' }" :disabled="blocked" :maxlength="120" /></NFormItem>
            <NFormItem label="Corp ID"><NInput v-model:value="corpId" :input-props="{ 'aria-label': 'Corp ID' }" :disabled="blocked" :maxlength="256" /></NFormItem>
            <NFormItem label="Agent ID"><NInput v-model:value="agentId" :input-props="{ 'aria-label': 'Agent ID' }" :disabled="blocked" :maxlength="256" /></NFormItem>
            <NFormItem label="通讯录应用 Secret"><NInput v-model:value="directorySecret" :input-props="{ 'aria-label': '通讯录应用 Secret' }" type="password" autocomplete="new-password" :disabled="blocked" :maxlength="8192" /></NFormItem>
          </template>
          <NButton attr-type="submit" :disabled="blocked || !validDirectory" :loading="directoryBusy">单独验证通讯录与姓名</NButton>
        </NForm>
        <NAlert v-if="directoryBusy" type="info" role="status">正在验证目录应用，不使用机器人凭据。</NAlert>
        <NAlert v-if="directoryError" type="error" role="alert">{{ directoryError }}</NAlert>
        <ChannelValidationReport v-if="directoryReport" :report="directoryReport" />
      </template>
      <template #credentials>
        <NAlert v-if="!configuring" type="info">已跳过渠道连接，仅配置工作区平台用户。</NAlert>
        <NForm v-else @submit.prevent>
          <NAlert v-if="provider === 'wecom' && !directoryDraft" type="info">请先在第一卡单独验证通讯录应用。</NAlert>
          <NFormItem :label="provider === 'wecom' ? '智能机器人 Bot ID' : '应用 App ID / AppKey'"><NInput v-model:value="appId" :input-props="{ 'aria-label': '渠道应用 ID' }" :disabled="blocked" autocomplete="off" :maxlength="256" /></NFormItem>
          <NFormItem :label="provider === 'wecom' ? '机器人 Secret' : '应用 App Secret'"><NInput v-model:value="appSecret" :input-props="{ 'aria-label': '渠道应用 Secret' }" type="password" autocomplete="new-password" :disabled="blocked" :maxlength="8192" /></NFormItem>
          <NCheckbox v-if="provider === 'wecom'" v-model:checked="confirmSameCorp" :disabled="blocked || !directoryDraft">我确认机器人与所选通讯录应用属于同一企业（管理员声明）</NCheckbox>
          <p class="field-note">密钥只保留在当前配置流程中；请到最后一卡验证。</p>
        </NForm>
      </template>
      <template #validation>
        <NButton v-if="configuring" :disabled="blocked || !valid" :loading="busy" type="primary" @click="verify">验证渠道并读取通讯录</NButton>
        <div class="channel-verification-feedback" aria-live="polite">
          <NAlert v-if="busy" type="info" role="status">正在分层验证必要身份、目录和姓名读取，不启动长连接。</NAlert>
          <NAlert v-else-if="error" type="error" role="alert">{{ error }}</NAlert>
          <ChannelValidationReport v-if="report && !busy" :report="report" />
          <NAlert v-if="draft" type="success" role="status">渠道草稿已准备。{{ scopeNotice }}最后确认创建才保存，实际收发仍待后续验证。</NAlert>
        </div>
      </template>
    </WizardChannelGuide>
  </ChannelProviderTabs>
  <NSpace class="skip-actions"><NButton v-if="configuring" :disabled="blocked" @click="skip">跳过渠道连接</NButton><NButton v-else :disabled="blocked" @click="configuring = true">配置当前渠道</NButton></NSpace>
</div>
</template>
<style scoped>.channel-draft { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; }.skip-actions { margin-top: 1rem; }</style>
