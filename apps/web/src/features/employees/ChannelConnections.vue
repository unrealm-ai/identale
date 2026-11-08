<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NCheckbox, NForm, NFormItem, NInput, NSpace, NTag, NPopconfirm } from 'naive-ui';
import { api, ApiError, errorMessage } from '../../shared/api';
import ChannelBrand from './ChannelBrand.vue';
import ChannelCapabilities from './ChannelCapabilities.vue';
import ChannelAccessSettings from './ChannelAccessSettings.vue';
import ChannelProviderTabs from './ChannelProviderTabs.vue';
import WecomDirectoryBinding from './WecomDirectoryBinding.vue';
import ChannelSetupRequirements from './ChannelSetupRequirements.vue';
import InfoHint from '../../shared/ui/InfoHint.vue';
import ChannelValidationReport from './ChannelValidationReport.vue';
import { channelApi, ChannelValidationFailure, type ChannelValidation } from './channel-validation';
import { directoryStatusLabel } from '../directory/types';
import type { DirectoryConnection, DirectoryProvider } from '../directory/types';
const props = defineProps<{ base: string; canManage: boolean; disabled?: boolean }>();
const emit = defineEmits<{ busyChanged: [value: boolean]; sessionExpired: []; changed: [];dirtyChanged:[boolean] }>();
const selectedConnection=ref(false),policyBusy=ref(false),policyDirty=ref(false),confirmPolicySwitch=ref(false);
const policyEditor=ref<InstanceType<typeof ChannelAccessSettings>|null>(null);
let pendingPolicySwitch:(()=>void)|undefined;
const channelLocked=computed(()=>busy.value||directoryBusy.value||policyBusy.value);
function requestPolicySwitch(action:()=>void){if(channelLocked.value)return;if(policyDirty.value){pendingPolicySwitch=action;confirmPolicySwitch.value=true;return;}action();}
function discardPolicySwitch(){if(channelLocked.value)return;policyEditor.value?.cancel();confirmPolicySwitch.value=false;pendingPolicySwitch?.();pendingPolicySwitch=undefined;}
function guardProvider(value:DirectoryProvider){if(channelLocked.value)return false;if(policyDirty.value){requestPolicySwitch(()=>provider.value=value);return false;}return true;}
function selectProvider(value:DirectoryProvider){requestPolicySwitch(()=>provider.value=value);}

const connections = ref<DirectoryConnection[]>([]), provider = ref<DirectoryProvider>('feishu');
type RuntimeChannel = Pick<DirectoryConnection, 'id' | 'appId' | 'provider' | 'revision' | 'authRevision' | 'transport'>;
type RuntimeSnapshot = { observedAt: number | null; employee: { channels: RuntimeChannel[] } | null };
const runtimeSnapshot = ref<RuntimeSnapshot | null>(null);
const displayConnections = computed(() => connections.value.map(item => {
  const observed = runtimeSnapshot.value?.employee?.channels?.find(channel => channel.id === item.id && channel.appId === item.appId && channel.provider === item.provider && channel.revision === item.revision && channel.authRevision === item.authRevision);
  return { ...item, runtimeTransport: observed?.transport ?? null, observedAt: observed?.transport ? runtimeSnapshot.value?.observedAt : null };
}));
const evidenceLabel = (value: DirectoryConnection['identityEvidence']) => ({ provider_api: '厂商 API 身份证据', authenticated_event_confirmed: '管理员确认的已认证事件', app_credentials_only: '仅应用凭据', admin_asserted: '管理员同企业声明（非厂商证明）' })[value] ?? '尚无身份验证证据';
const connection = computed(() => connections.value.find(item => item.provider === provider.value));
const historyEnabled = ref(false),keywordText=ref('');
const contextDirty=computed(()=>historyEnabled.value!==(connection.value?.context?.groupListenEnabled??false)||keywordText.value!==(connection.value?.context?.groupTriggerKeywords??[]).join('\n'));
const appId = ref(''), appSecret = ref(''), replaceSource = ref(false);
const transportLabel = (state: DirectoryConnection['transport']['state']) => ({ stopped: '已停止', connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', failed: '连接失败' })[state];
const formatTime = (value: number) => new Date(value).toLocaleString('zh-CN');
type Challenge = { challengeId: string; challengeText: string; expiresAt: number; revision: number };
type Verification = { status: 'not_started' | 'waiting' | 'observed'; revision?: number; candidateId?: string; botId?: string; tenantId?: string; robotCode?: string; expiresAt: number };
const credentialsComplete = computed(() => !!appId.value.trim() && !!appSecret.value);
const challenge = ref<Challenge | null>(null), verification = ref<Verification | null>(null);
const directoryBusy = ref(false);
const report = ref<ChannelValidation | null>(null);
const busy = ref(false), loaded = ref(false), error = ref(''), notice = ref('');
let controller = new AbortController();
watch(() => busy.value || directoryBusy.value || policyBusy.value, value => emit('busyChanged', value), { flush: 'sync' });
watch(()=>!!appSecret.value||!!appId.value&&appId.value!==(connection.value?.appId??'')||contextDirty.value||policyDirty.value,v=>emit('dirtyChanged',v),{flush:'sync'});
function clearSecrets() { appSecret.value = ''; }
watch(provider, () => { challenge.value = null; verification.value = null; clearSecrets(); appId.value = connection.value?.appId ?? ''; replaceSource.value = false; notice.value = ''; error.value = ''; report.value = null; });
watch(connection, value => { historyEnabled.value = value?.context?.groupListenEnabled ?? false;keywordText.value=(value?.context?.groupTriggerKeywords??[]).join('\n'); challenge.value = null; verification.value = null; appId.value = value?.appId ?? ''; clearSecrets(); replaceSource.value = false; });
async function run(action: (signal: AbortSignal) => Promise<void>) {
  if (busy.value || directoryBusy.value || policyBusy.value) return; const signal = controller.signal; busy.value = true; error.value = ''; notice.value = '';
  try { await action(signal); } catch (cause) { if (!signal.aborted) { if (cause instanceof ChannelValidationFailure && cause.validation) { report.value = cause.validation; error.value = ''; } else error.value = errorMessage(cause); if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired'); } }
  finally { if (!signal.aborted) busy.value = false; }
}
async function read(signal: AbortSignal) {
  runtimeSnapshot.value = null;
  const result = await api<DirectoryConnection[]>(`${props.base}/channels`, signal);
  if (signal.aborted) return;
  connections.value = result; loaded.value = true;
  const snapshot = await api<RuntimeSnapshot>(`${props.base}/runtime-status`, AbortSignal.any([signal, AbortSignal.timeout(8000)])).catch(cause => {
    if (!signal.aborted && cause instanceof ApiError && cause.status === 401) emit('sessionExpired');
    return null;
  });
  if (!signal.aborted) runtimeSnapshot.value = snapshot;
}
async function load() { await run(read); }
async function mutate(action: 'connect' | 'revalidate' | 'settings') {
  if (!props.canManage || !loaded.value || busy.value || policyBusy.value || policyDirty.value || action === 'connect' && !credentialsComplete.value) return;
  const current = connection.value, selected = provider.value;
  const body = action === 'connect' ? { appId: appId.value.trim(), appSecret: appSecret.value, expectedRevision: current?.revision ?? 0, replaceSource: replaceSource.value } : { expectedRevision: current?.revision ?? 0, ...(action === 'settings' ? { enabled: !current?.enabled } : {}) };
  clearSecrets();
  await run(async signal => {
    try {
      const result = await channelApi<DirectoryConnection & {validation?:ChannelValidation}>(`${props.base}/channels/${selected}${action === 'connect' ? '' : `/${action}`}`, signal, body, action === 'revalidate' ? 'POST' : 'PUT');
      report.value = result.validation ?? null;
      if (signal.aborted) return;
      notice.value = action === 'settings' ? (current?.enabled ? '已提交停用，请刷新核对连接状态。' : '已提交启用，请重新验证凭据并等待连接。') : action === 'revalidate' && selected === 'wecom' ? (current?.enabled ? '已开始重新连接，请完成机器人身份验证；通讯录关联和使用范围保留。' : '已提交凭据重新验证，渠道仍保持停用；通讯录关联和使用范围保留。') : '配置已保存，请核对下方连接状态。';
    } finally { if (!signal.aborted) { await read(signal); if (!signal.aborted) emit('changed'); } }
  });
}
async function unbindChannel() {
  if (!props.canManage || channelLocked.value || policyDirty.value || !connection.value) return;
  const current = connection.value, selected = provider.value; clearSecrets();
  await run(async signal => {
    try { await api(`${props.base}/channels/${selected}`, signal, { expectedRevision: current.revision }, 'DELETE'); if (!signal.aborted) notice.value = '渠道绑定已解除，机器人身份已释放。共享目录应用仍保留；历史授权不会转移给下一位员工。'; }
    finally { if (!signal.aborted) { await read(signal); if (!signal.aborted) emit('changed'); } }
  });
}
async function saveContext() {
  if (!props.canManage || busy.value || !loaded.value || !connection.value || !connection.value.capabilities?.recentGroupContext.supported && !connection.value.capabilities?.keywordTriggers.supported) return;
  const body = { enabled: connection.value.enabled, expectedRevision: connection.value.revision, groupListenEnabled: historyEnabled.value,groupTriggerKeywords:keywordText.value.split('\n').map(word=>word.trim()).filter(Boolean) };
  if(body.groupTriggerKeywords.length>20||body.groupTriggerKeywords.some(word=>word.length>80)){error.value='最多20个关键词，每个不超过80个字符。';return;}
  await run(async signal => {
    await api(`${props.base}/channels/${provider.value}/settings`, signal, body, 'PUT');
    if (!signal.aborted) { await read(signal);notice.value = '已保存。';emit('changed'); }
  });
}
async function verifyRobot(action: 'start' | 'read' | 'confirm') {
  if (!props.canManage || !connection.value || connection.value.status !== 'pending_verification' || busy.value) return;
  const selected = provider.value, expectedRevision = action === 'confirm' ? verification.value?.revision : connection.value.revision;
  const candidateId = verification.value?.candidateId;
  if (action === 'confirm' && (!candidateId || verification.value?.status !== 'observed' || expectedRevision === undefined)) return;
  if (action === 'confirm' && verification.value!.expiresAt <= Date.now()) { error.value = '本次验证已过期，请重新开始。'; return; }
  await run(async signal => {
    const url = `${props.base}/channels/${selected}/verification`;
    if (action === 'start') {
      const result = await api<Challenge>(`${url}/start`, signal, { expectedRevision });
      if (!signal.aborted) { connection.value!.revision = result.revision; challenge.value = result; verification.value = null; }
    } else if (action === 'read') {
      const result = await api<Verification>(url, signal);
      if (!signal.aborted) { verification.value = result; if (result.status === 'not_started') challenge.value = null; }
    } else {
      try { await api(`${url}/confirm`, signal, { candidateId, expectedRevision }); if (!signal.aborted) { notice.value = '候选确认已提交，请以下方测试入站状态为准；这不代表完整收发已验证。'; emit('changed'); } }
      finally { if (!signal.aborted) await read(signal); }
    }
  });
}
watch(() => props.base, () => { controller.abort(); controller = new AbortController(); busy.value = false; loaded.value = false; challenge.value = null; verification.value = null; connections.value = [];policyDirty.value=false;policyBusy.value=false;confirmPolicySwitch.value=false;pendingPolicySwitch=undefined; clearSecrets(); void load(); }, { immediate: true });
onUnmounted(() => { controller.abort(); clearSecrets();emit('dirtyChanged',false); emit('busyChanged', false); });
</script>
<template>
  <div class="channel-connections">
    <NAlert v-if="confirmPolicySwitch" type="warning">当前渠道策略尚未保存，是否放弃修改并切换？<NSpace><NButton :disabled="channelLocked" @click="confirmPolicySwitch=false;pendingPolicySwitch=undefined">继续编辑当前渠道</NButton><NButton :disabled="channelLocked" @click="discardPolicySwitch">放弃策略修改并切换</NButton></NSpace></NAlert>
    <section v-if="!selectedConnection" class="connection-list">
      <header class="connection-list-heading"><div><h3>渠道连接</h3><p class="field-note">为员工接入飞书、钉钉或企业微信独立机器人，分别管理连接与使用范围。</p></div><NButton v-if="canManage" type="primary" @click="requestPolicySwitch(()=>selectedConnection=true)">添加渠道连接</NButton></header>
      <NCard v-for="item in displayConnections" :key="item.id" size="small"><div class="connection-summary"><ChannelBrand :provider="item.provider"/><NTag size="small">{{directoryStatusLabel(item)}}</NTag><span class="field-note">{{item.enabled?'已启用':'已停用'}} · {{item.runtimeTransport?transportLabel(item.runtimeTransport.state):'运行状态未知'}} · 通讯录{{item.directoryStatus==='available'?'可查询':'不可用'}}</span><NButton size="small" secondary @click="requestPolicySwitch(()=>{provider=item.provider;selectedConnection=true})">查看此连接</NButton></div></NCard>
      <div v-if="loaded&&!connections.length" class="connection-empty-state"><p class="field-note">尚未连接渠道，可按需添加。</p></div>
      <NAlert v-if="error" type="error" role="alert">{{error}}</NAlert>
    </section>
    <div v-show="selectedConnection" class="channel-detail">
      <div class="channel-detail-toolbar"><NButton size="small" aria-label="返回连接列表" :disabled="channelLocked" @click="requestPolicySwitch(()=>selectedConnection=false)">返回连接列表</NButton><NButton size="small" :disabled="channelLocked" :loading="busy" @click="load">刷新渠道状态</NButton></div>
      <ChannelProviderTabs :before-change="guardProvider" :model-value="provider" @update:model-value="selectProvider" :disabled="disabled || channelLocked" :hide-navigation="!canManage">
        <template v-if="canManage && $slots.automation" #automation><slot name="automation" /></template>
        <section v-for="item in displayConnections.filter(c=>c.provider===provider)" :key="item.id" class="connection-status form-section" aria-label="当前连接状态">
          <div class="form-section-heading"><h3>当前连接</h3><NSpace><NTag size="small">{{directoryStatusLabel(item)}}</NTag><NTag size="small">通讯录{{item.directoryStatus==='available'?'可查询':'不可用'}}</NTag></NSpace></div>
          <p data-testid="transport-status">长连接：{{item.runtimeTransport?.error==='channel_ingress_standby'?'由另一平台进程维护连接':item.runtimeTransport?transportLabel(item.runtimeTransport.state):'状态未知'}}<InfoHint label="连接状态说明">连接状态与身份、目录和使用权限分别核验。无法获取状态时不能判断为离线。</InfoHint></p>
          <p v-if="!item.runtimeTransport" role="status">暂时无法确认此连接的运行状态，请稍后刷新。</p>
          <p v-if="item.runtimeTransport?.error && item.runtimeTransport.error!=='channel_ingress_standby'" role="status">连接错误：{{item.runtimeTransport.error}}</p><p v-if="item.lastError" role="status">{{item.lastError}}</p>
          <details class="connection-diagnostics"><summary>连接诊断</summary><p v-if="item.observedAt">运行状态观测时间：{{formatTime(item.observedAt)}}</p><template v-if="item.runtimeTransport"><p>状态更新时间：{{formatTime(item.runtimeTransport.changedAt)}}</p><p v-if="item.runtimeTransport.lastConnectedAt">最近连接：{{formatTime(item.runtimeTransport.lastConnectedAt)}}</p><p v-if="item.runtimeTransport.lastDisconnectedAt">最近断线：{{formatTime(item.runtimeTransport.lastDisconnectedAt)}}</p><p v-if="item.runtimeTransport.error==='channel_ingress_standby'">当前平台进程处于待命状态，不代表渠道已停用或全局连接离线；此处不推断另一进程的在线状态。</p></template>
            <p>{{item.provider==='wecom'?'BotID':'应用'}} {{item.appId}} · 版本 {{item.revision}}</p><p>身份证据：{{evidenceLabel(item.identityEvidence)}}</p><p>测试入站：{{item.inboundVerified?'已确认':'尚未确认'}}</p><p v-if="item.botId">{{item.status==='verified'?'已验证机器人':'配置机器人（待验证）'}} {{item.botId}}</p><p>身份依据：{{item.tenantIdNamespace}} · {{item.tenantId}}</p><p v-if="item.provider==='wecom'">目录关联：{{item.directoryBinding?.status==='confirmed'?'管理员已确认同企业（非厂商证明）':item.directoryBinding?'需要重新确认企业关系':'未关联目录应用'}}</p><p v-if="item.tenantIdNamespace==='app_scoped'||item.tenantIdNamespace==='app_id'">仅证明应用身份，不代表企业 corpId 已验证。</p>
          </details>
        </section>
        <ChannelCapabilities v-if="connection" :capabilities="connection.capabilities" :provider="provider" @session-expired="emit('sessionExpired')"/>
        <template v-if="canManage">
          <WecomDirectoryBinding v-if="provider==='wecom'" :base="base" :connection="connection" :disabled="busy" @busy-changed="directoryBusy=$event" @changed="load();emit('changed')" @session-expired="emit('sessionExpired')"/>
          <section class="form-section channel-setup" aria-label="渠道接入配置">
            <header class="form-section-heading"><h3>{{provider==='wecom'?'智能机器人':'应用凭据'}}</h3><a :href="provider==='feishu'?'https://open.feishu.cn/app':provider==='dingtalk'?'https://open-dev.dingtalk.com/':'https://work.weixin.qq.com/wework_admin/frame'" target="_blank" rel="noopener noreferrer">打开官方后台 ↗</a></header>
            <NForm class="channel-connection-form settings-form" @submit.prevent>
              <NFormItem :label="provider==='wecom'?'智能机器人 BotID':provider==='dingtalk'?'Client ID（AppKey）':'App ID'"><NInput v-model:value="appId" :disabled="busy||directoryBusy||!loaded" :input-props="{'aria-label':'渠道应用 ID',autocomplete:'off'}"/></NFormItem>
              <NFormItem :label="provider==='wecom'?'机器人 Secret':provider==='dingtalk'?'Client Secret（AppSecret）':'App Secret'"><NInput v-model:value="appSecret" type="password" :disabled="busy||directoryBusy||!loaded" :input-props="{'aria-label':'渠道应用密钥',autocomplete:'new-password'}"/></NFormItem>
              <p class="field-note">{{provider==='wecom'?'使用本员工独立机器人的凭据，与目录应用凭据不同。':'每位员工使用独立机器人应用。'}}<InfoHint label="凭据保存与更换">密钥只写入，提交后清空。相同应用可轮换密钥；更换应用或转绑员工前须解除原绑定，停用仍保留绑定。</InfoHint></p>
            </NForm>
            <ChannelSetupRequirements :provider="provider"/>
            <NAlert v-if="error" type="error" role="alert">{{error}}</NAlert><NAlert v-if="notice" type="info" role="status">{{notice}}</NAlert>
            <ChannelValidationReport v-if="report" :report="report"/>
        <div class="channel-actions" ><NButton key="connect" @click="mutate('connect')" type="primary" :disabled="channelLocked || policyDirty || !loaded || !credentialsComplete" :loading="busy">验证并保存渠道连接</NButton><NButton key="revalidate" v-if="connection" :disabled="channelLocked||policyDirty" @click="mutate('revalidate')">重新验证已存凭据</NButton><NButton key="settings" v-if="connection" :disabled="channelLocked||policyDirty" @click="mutate('settings')">{{ connection.enabled ? '停用此渠道' : '启用此渠道' }}</NButton><NPopconfirm v-if="connection" :disabled="channelLocked||policyDirty" positive-text="确认解除绑定" negative-text="保留绑定" @positive-click="unbindChannel"><template #trigger><NButton :disabled="channelLocked||policyDirty">解除渠道绑定</NButton></template>解除本员工的当前渠道绑定并停止连接，释放全平台机器人身份；共享目录应用和历史业务记录保留，旧授权不会转给新的绑定。</NPopconfirm></div>
          </section>
      <NAlert v-if="connection?.status === 'pending_verification'" type="warning">应用凭据已保存，但真实机器人身份尚未验证。请完成官方配置并重新验证；未验证前不会开放渠道使用。</NAlert>
      <NCard v-if="connection?.status === 'pending_verification'" title="显式验证机器人身份" size="small">
        <p v-if="provider === 'wecom' && connection?.directoryBinding?.status !== 'confirmed'">请先完成上方目录应用验证与同企业确认，再开始挑战验证。</p>
        <p>先开始本次验证，再从企业客户端向目标机器人发送下方完整验证文本，不要附带业务或敏感信息。收到测试消息后，请核对机器人身份并明确确认。</p>
        <NButton :disabled="busy || directoryBusy || (provider === 'wecom' && (connection?.directoryBinding?.status !== 'confirmed' || connection?.directoryStatus !== 'available'))" @click="verifyRobot('start')">开始机器人身份验证</NButton>
        <template v-if="challenge"><p>请完整发送：{{ challenge.challengeText }}</p><p>本次验证截止：{{ new Date(challenge.expiresAt).toLocaleString('zh-CN') }}</p><NButton :disabled="channelLocked" @click="verifyRobot('read')">检查测试消息候选</NButton></template>
        <NAlert v-if="verification?.status === 'not_started'" type="warning">验证尚未开始或已过期，请重新开始。</NAlert>
        <NAlert v-if="verification?.status === 'waiting'" type="info">尚未收到可确认的测试消息。请检查目标应用、长连接在线状态及验证有效期。</NAlert>
        <template v-if="verification?.status === 'observed'"><NAlert type="warning">核对下列身份是否属于此员工的目标机器人；不匹配时不要确认。</NAlert><p>机器人：{{ verification.botId || '未提供' }}</p><p>{{ provider === 'wecom' ? '管理员声明的企业（不是厂商证明）' : '企业依据' }}：{{ verification.tenantId || '未提供，不推断企业身份' }}</p><p v-if="verification.robotCode">机器人代码：{{ verification.robotCode }}</p><NButton type="primary" :disabled="busy || !verification.candidateId || verification.revision === undefined || verification.expiresAt <= Date.now()" @click="verifyRobot('confirm')">身份核对无误，确认绑定此候选</NButton></template>
      </NCard>
    <ChannelAccessSettings v-if="canManage && selectedConnection && connection" ref="policyEditor" :base="base" :connection="connection" :can-manage="canManage" :disabled="!!disabled||busy||directoryBusy" @busy-changed="v=>policyBusy=v" @dirty-changed="v=>policyDirty=v" @changed="emit('changed')" @session-expired="emit('sessionExpired')" />
      <NCard v-if="connection && (connection.capabilities?.recentGroupContext.supported || connection.capabilities?.keywordTriggers.supported)" title="群聊触发与上下文" size="small">
        <p class="field-note">普通群消息：{{ connection.groupListeningStatus?.permission === 'granted' ? '已授权' : connection.groupListeningStatus?.permission === 'denied' ? '未授权' : '未核验' }}<InfoHint label="关于群消息接收">上下文开关只控制近期群消息保留，不控制 SDK 接收或关键词触发。群消息接收权限与连接状态分别核验。最近窗口缓存 {{ connection.groupListeningStatus?.cachedMessages ?? 0 }} 条；没有缓存不表示已获权限。</InfoHint></p>
        <p class="field-note">当前保存的触发方式：{{connection.context?.groupTriggerKeywords?.length ? '@ 或关键词（关键词须有普通群消息权限）' : '仅 @'}}；均须通过使用授权。</p>
        <NForm class="channel-context-form" @submit.prevent="saveContext">
          <NFormItem v-if="connection.capabilities?.keywordTriggers.supported" label="触发关键词"><div><NInput v-model:value="keywordText" type="textarea" :rows="3" :input-props="{'aria-label':'群聊触发关键词'}" aria-label="群聊触发关键词" :disabled="channelLocked || !['available','authorization_required'].includes(connection.capabilities?.keywordTriggers.availability??'unknown')" placeholder="每行一个关键词" /><p class="field-note">每行一个，最多20个，每个80字；留空关闭。未获权限时可保存草稿，实际触发仍须通过后台权限核验。<InfoHint label="关键词匹配规则">正文包含任一词即可触发，英文忽略大小写，不支持正则。没有使用权时静默；@ 按原规则处理。</InfoHint></p><NAlert v-if="connection.groupListeningStatus?.permission!=='granted'" :type="connection.groupListeningStatus?.permission==='denied'?'warning':'info'">{{ connection.groupListeningStatus?.permission==='denied'?'缺少普通群消息接收权限，关键词暂不可触发。':'普通群消息接收权限尚未验证，关键词暂不可触发。' }}请在飞书确认应用权限后重新验证连接。</NAlert></div></NFormItem>
          <NCheckbox v-if="connection.capabilities?.recentGroupContext.supported" v-model:checked="historyEnabled" :disabled="channelLocked || (!historyEnabled && connection.capabilities?.recentGroupContext.availability!=='available')" aria-label="保留近期群消息作为上下文">保留近期群消息作为上下文</NCheckbox>
          <p class="field-note">关闭后不再保留此近期群消息窗口；已获普通群消息权限且渠道可用时，仍接收消息并匹配关键词。仅 @ 或关键词命中且有使用权时回复。<InfoHint label="群上下文范围">每群/话题保留最近100条，不补拉历史。文件、图片和会议以资料引用记录，能否读取取决于资料权限与可用状态。</InfoHint></p>
          <NSpace><NButton attr-type="submit" type="primary" :disabled="channelLocked || !contextDirty" :loading="busy">保存</NButton><NButton :disabled="busy||directoryBusy||!contextDirty" @click="historyEnabled=connection.context?.groupListenEnabled??false;keywordText=(connection.context?.groupTriggerKeywords??[]).join('\n')">取消</NButton></NSpace>
        </NForm>
      </NCard>
          <p v-if="connection&&!connection.enabled" class="field-note">渠道已停用。启用后请重新验证凭据。</p>
        </template><p v-else class="field-note">当前没有渠道编辑权限，不展示凭据。</p>
      </ChannelProviderTabs>
    </div>
  </div>
</template>
<style scoped>
.channel-connections,.channel-detail{display:grid;gap:16px;min-width:0}
.connection-list{display:grid;gap:12px}
.connection-list-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:16px 20px;background:var(--surface);border:1px solid var(--subtle);border-radius:12px}
.connection-list-heading h3{margin:0;font-size:16px;font-weight:600;line-height:24px}
.connection-list-heading .field-note{margin:4px 0 0}
.connection-empty-state{padding:24px 20px;background:var(--surface);border:1px solid var(--subtle);border-radius:12px;text-align:center}
.connection-empty-state .field-note{margin:0}
.channel-detail-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.connection-summary{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.connection-summary :deep(.channel-brand){margin-right:auto}
.channel-actions{display:flex;flex-wrap:wrap;gap:10px;padding-top:4px}
.channel-connections p{overflow-wrap:anywhere}
.connection-status p{margin:6px 0}
.channel-setup{display:grid;gap:16px}
.channel-setup .settings-form{margin:0}
.channel-setup .field-note{margin:0}
.connection-diagnostics{color:var(--muted);font-size:var(--id-font-size-meta);padding-top:8px;border-top:1px solid var(--subtle)}
.connection-diagnostics summary{cursor:pointer;font-weight:500;color:var(--text)}
.channel-context-form{max-width:var(--id-form-max-width)}
</style>
