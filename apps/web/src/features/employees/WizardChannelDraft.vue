<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NForm, NFormItem, NInput, NSpace } from 'naive-ui';
import { api, ApiError, errorMessage } from '../../shared/api';
import ChannelProviderTabs from './ChannelProviderTabs.vue';
import type { EmployeeChannelDraft } from './useEmployeeWizard';
import type { DirectoryProvider } from '../directory/types';
import WizardChannelGuide from './WizardChannelGuide.vue';
import ChannelValidationReport from './ChannelValidationReport.vue';
import { channelApi, ChannelValidationFailure, type ChannelValidation } from './channel-validation';
const props = defineProps<{ base: string; disabled: boolean }>();
const emit = defineEmits<{ change: [draft: EmployeeChannelDraft | null]; readyChanged: [value: boolean]; busyChanged: [value: boolean]; sessionExpired: [] }>();
const provider = ref<DirectoryProvider>('feishu'), configuring = ref(true), busy = ref(false), error = ref('');
const blocked = computed(() => props.disabled || busy.value);
const appId = ref(''), appSecret = ref('');
const draft = ref<EmployeeChannelDraft | null>(null), scopeNotice = ref(''), report = ref<ChannelValidation | null>(null);
const identityNotice = computed(() => draft.value?.source.provider !== 'feishu' ? '' : draft.value.source.status === 'verified' ? '机器人 open_id 与租户 tenant_key 已由官方 API 验证，无需首条消息完成身份确认。' : draft.value.source.status === 'pending_verification' && draft.value.source.botId ? '机器人 open_id 已确认；创建并启动长连接后，普通真人私聊或真实群 @ 消息可自动确认租户 tenant_key，随后同条消息按使用范围鉴权，首发者不会自动获得使用权。' : '机器人身份尚未完整确认，请核对验证结果。');
let controller = new AbortController(); let expiry: ReturnType<typeof setTimeout> | undefined;
let version = 0, alive = true;
watch(busy, value => emit('busyChanged', value), { flush: 'sync' });
watch([configuring, draft], () => { emit('change', draft.value); emit('readyChanged', !configuring.value || !!draft.value); }, { immediate: true, flush: 'sync' });
function removeDraft(id: string, base = props.base) { void api(`${base}/employee-channel-drafts/${encodeURIComponent(id)}`, new AbortController().signal, undefined, 'DELETE').catch(() => {}); }
function discard(base = props.base) {
  clearTimeout(expiry); version++;
  const old = draft.value; draft.value = null; scopeNotice.value = ''; report.value = null;
  if (old) removeDraft(old.draftId, base);
}
watch([appId, appSecret], () => discard(), { flush: 'sync' });
watch(() => props.base, (_, previous) => { controller.abort(); controller = new AbortController(); discard(previous); appId.value = ''; appSecret.value = ''; error.value = ''; configuring.value = true; busy.value = false; });
watch(provider, () => { discard(); configuring.value = true; error.value = ''; appId.value = ''; appSecret.value = ''; }, { flush: 'sync' });
function skip() { if (blocked.value) return; discard(); appSecret.value = ''; configuring.value = false; error.value = ''; }
const valid = computed(() => !!appId.value.trim() && !!appSecret.value);
function validationError(cause: unknown) {
  const validation = cause instanceof ChannelValidationFailure ? cause.validation : undefined;
  report.value = validation ?? null; error.value = validation ? '' : errorMessage(cause);
  if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired');
}
async function verify() {
  if (blocked.value || !valid.value) return;
  discard(); const generation = version, selected = provider.value, base = props.base, signal = controller.signal; busy.value = true; error.value = '';
  try {
    const result = await channelApi<EmployeeChannelDraft & { validation: ChannelValidation; scope: { departmentCount: number|null; userCount: number|null; entireOrganization: boolean } }>(`${base}/employee-channel-drafts`, signal, {
      provider: selected, appId: appId.value.trim(), appSecret: appSecret.value,
    });
    if (!alive || signal.aborted || generation !== version || base !== props.base || selected !== provider.value) { removeDraft(result.draftId, base); return; }
    const validation = (result.source as typeof result.source & { validation?: ChannelValidation }).validation ?? result.validation;
    if (!validation?.canContinue) { error.value = '必要验证结果不完整，请重新验证。'; removeDraft(result.draftId); return; }
    if (selected === 'feishu' && !result.source.botId) { error.value = '未取得可信的机器人 open_id，请启用机器人能力并重新验证；App ID 不能代替机器人身份。'; removeDraft(result.draftId, base); return; }
    report.value = validation; draft.value = result;
    expiry = setTimeout(() => { discard(); error.value = '渠道草稿已过期，请重新验证。'; }, Math.max(0, result.expiresAt - Date.now()));
    scopeNotice.value = selected === 'wecom' ? '新建数字员工首次接入默认全员 + 空黑名单，群内可用；换绑重置为空白名单。首条真实消息自动确认身份。' : `已读取可见范围：${result.scope.departmentCount===null?'部门入口未披露':`${result.scope.departmentCount} 个部门入口`}、${result.scope.userCount===null?'直接用户入口未披露':`${result.scope.userCount} 个直接用户入口`}。`;
  } catch (cause) { if (alive && !signal.aborted && generation === version && base === props.base) validationError(cause); }
  finally { if (alive && !signal.aborted && generation === version && base === props.base) busy.value = false; }
}
onUnmounted(() => { alive = false; controller.abort(); clearTimeout(expiry); appSecret.value = ''; emit('busyChanged', false); });
</script>
<template>
<div class="channel-draft">
  <ChannelProviderTabs v-model="provider" :disabled="blocked">
    <template v-if="$slots.automation" #automation><slot name="automation" /></template>
    <p class="field-note">先检查渠道配置，再配置能力包。三渠道新建数字员工首次接入默认全员 + 空黑名单、群内可用，能力包继承员工使用范围。飞书近期群消息上下文默认打开，跨群共享另行配置。最后确认创建才保存并启动连接。</p>
    <WizardChannelGuide :report="report" :provider="provider" :ready="!configuring || !!draft" :busy="busy" :skipped="!configuring" :locked="blocked">
      <template #credentials>
        <NAlert v-if="!configuring" type="info">已跳过渠道连接，仅配置工作区平台用户。</NAlert>
        <NForm v-else @submit.prevent>
          <NAlert v-if="provider === 'wecom'" type="info">仅需 BotID 和 Secret。新建数字员工首次接入默认全员 + 空黑名单，允许群成员在群内使用。</NAlert>
          <NFormItem :label="provider === 'wecom' ? 'BotID' : provider === 'feishu' ? 'App ID' : 'Client ID（AppKey）'"><NInput v-model:value="appId" :input-props="{ 'aria-label': '渠道应用 ID' }" :disabled="blocked" autocomplete="off" :maxlength="256" /></NFormItem>
          <p v-if="provider === 'feishu'" class="field-note">App ID 标识应用，不是机器人 open_id；机器人 open_id 由官方 API 读取，无需手填。</p>
          <NFormItem :label="provider === 'wecom' ? 'Secret' : provider === 'feishu' ? 'App Secret' : 'Client Secret（AppSecret）'"><NInput v-model:value="appSecret" :input-props="{ 'aria-label': '渠道应用 Secret' }" type="password" autocomplete="new-password" :disabled="blocked" :maxlength="8192" /></NFormItem>
          <p class="field-note">{{ provider==='wecom'?'密钥只保留在当前配置流程中；请到最后一卡检查配置，创建后才进行长连接认证。':'密钥只保留在当前配置流程中；请到最后一卡验证。' }}</p>
        </NForm>
      </template>
      <template #validation>
        <NButton v-if="configuring" :disabled="blocked || !valid" :loading="busy" type="primary" @click="verify">{{provider==='wecom'?'检查并继续':'验证渠道凭据'}}</NButton>
        <div class="channel-verification-feedback" aria-live="polite">
          <NAlert v-if="busy" type="info" role="status">{{ provider==='wecom' ? '正在检查机器人凭据配置。创建后启动长连接。' : '正在分层验证必要身份、目录和姓名读取，不启动长连接。' }}</NAlert>
          <NAlert v-else-if="error" type="error" role="alert">{{ error }}</NAlert>
          <ChannelValidationReport v-if="report && !busy" :report="report" />
          <NAlert v-if="draft" type="success" role="status">渠道草稿已准备。{{ scopeNotice }}{{ identityNotice }}最后确认创建才保存，实际收发仍待后续验证。</NAlert>
        </div>
      </template>
    </WizardChannelGuide>
  </ChannelProviderTabs>
  <NSpace class="skip-actions"><NButton v-if="configuring" :disabled="blocked" @click="skip">跳过渠道连接</NButton><NButton v-else :disabled="blocked" @click="configuring = true">配置当前渠道</NButton></NSpace>
</div>
</template>
<style scoped>.channel-draft { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; }.skip-actions { margin-top: 1rem; }</style>
