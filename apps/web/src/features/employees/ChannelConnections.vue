<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NCheckbox, NForm, NFormItem, NInput, NSpace, NTag, NPopconfirm } from 'naive-ui';
import { api, ApiError, errorMessage } from '../../shared/api';
import ChannelBrand from './ChannelBrand.vue';
import WeComRegistration from './WeComRegistration.vue';
import type { WeComRegistrationCredentials } from './wecom-registration';
import ChannelCapabilities from './ChannelCapabilities.vue';
import ChannelAccessSettings from './ChannelAccessSettings.vue';
import GroupSharingSettings from './GroupSharingSettings.vue';
import ChannelProviderTabs from './ChannelProviderTabs.vue';
import ChannelSetupRequirements from './ChannelSetupRequirements.vue';
import InfoHint from '../../shared/ui/InfoHint.vue';
import ChannelValidationReport from './ChannelValidationReport.vue';
import { channelApi, ChannelValidationFailure, type ChannelValidation } from './channel-validation';
import { directoryStatusLabel } from '../directory/types';
import type { DirectoryConnection, DirectoryProvider, DirectoryIdentityEvidence } from '../directory/types';
const props = withDefaults(defineProps<{ base: string; canManage: boolean; disabled?: boolean; active?: boolean }>(), { active: true });
const emit = defineEmits<{ busyChanged: [value: boolean]; sessionExpired: []; changed: [];rebound:[];dirtyChanged:[boolean] }>();
const sharingBusy=ref(false),sharingDirty=ref(false),registrationBusy=ref(false);
const sharingEditor=ref<InstanceType<typeof GroupSharingSettings>|null>(null);
const selectedConnection=ref(false),policyBusy=ref(false),policyDirty=ref(false),confirmPolicySwitch=ref(false);
const policyEditor=ref<InstanceType<typeof ChannelAccessSettings>|null>(null);
let pendingPolicySwitch:(()=>void)|undefined;
const channelLocked=computed(()=>!!props.disabled||busy.value||directoryBusy.value||policyBusy.value||sharingBusy.value||registrationBusy.value);
const unsaved=computed(()=>policyDirty.value||sharingDirty.value||contextDirty.value||!!appSecret.value||!!appId.value&&appId.value!==(connection.value?.appId??''));
const registrationBlocked=computed(()=>props.active===false||!!props.disabled||busy.value||directoryBusy.value||policyBusy.value||sharingBusy.value||!loaded.value||unsaved.value);
function receiveRegistration(credentials:WeComRegistrationCredentials){if(!props.canManage||provider.value!=='wecom'||!selectedConnection.value||registrationBlocked.value)return;appId.value=credentials.botId;appSecret.value=credentials.secret;report.value=null;notice.value='';error.value='';}
function requestPolicySwitch(action:()=>void){if(channelLocked.value)return;if(unsaved.value){pendingPolicySwitch=action;confirmPolicySwitch.value=true;return;}action();}
function discardPolicySwitch(){if(channelLocked.value)return;policyEditor.value?.cancel();sharingEditor.value?.discard();historyEnabled.value=connection.value?.context?.groupListenEnabled??false;keywordText.value=(connection.value?.context?.groupTriggerKeywords??[]).join('\n');appId.value=connection.value?.appId??'';clearSecrets();replaceSource.value=false;confirmPolicySwitch.value=false;pendingPolicySwitch?.();pendingPolicySwitch=undefined;}
function guardProvider(value:DirectoryProvider){if(channelLocked.value)return false;if(unsaved.value){requestPolicySwitch(()=>provider.value=value);return false;}return true;}
function selectProvider(value:DirectoryProvider){requestPolicySwitch(()=>provider.value=value);}

const connections = ref<DirectoryConnection[]>([]), provider = ref<DirectoryProvider>('feishu');
type RuntimeChannel = Pick<DirectoryConnection, 'id' | 'appId' | 'provider' | 'revision' | 'authRevision' | 'transport'>;
type RuntimeSnapshot = { observedAt: number | null; employee: { channels: RuntimeChannel[] } | null };
const runtimeSnapshot = ref<RuntimeSnapshot | null>(null);
const displayConnections = computed(() => connections.value.map(item => {
  const observed = runtimeSnapshot.value?.employee?.channels?.find(channel => channel.id === item.id && channel.appId === item.appId && channel.provider === item.provider && channel.revision === item.revision && channel.authRevision === item.authRevision);
  return { ...item, runtimeTransport: observed?.transport ?? null, observedAt: observed?.transport ? runtimeSnapshot.value?.observedAt : null };
}));
const evidenceLabel = (value: DirectoryConnection['identityEvidence']) => ({ provider_api: '厂商 API 身份证据', authenticated_event_confirmed: '管理员确认的已认证事件', authenticated_first_message: '首条真实消息自动确认', app_credentials_only: '仅应用凭据', admin_asserted: '管理员同企业声明（非厂商证明）' })[value] ?? '尚无身份验证证据';
const connection = computed(() => connections.value.find(item => item.provider === provider.value));
const historyEnabled = ref(false),keywordText=ref('');
const contextDirty=computed(()=>historyEnabled.value!==(connection.value?.context?.groupListenEnabled??false)||keywordText.value!==(connection.value?.context?.groupTriggerKeywords??[]).join('\n'));
const appId = ref(''), appSecret = ref(''), replaceSource = ref(false);
const replacing=computed(()=>!!connection.value&&!!appId.value.trim()&&appId.value.trim()!==connection.value.appId);
watch(appId,()=>{replaceSource.value=false;});
const transportLabel = (state: DirectoryConnection['transport']['state']) => ({ stopped: '已停止', connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', failed: '连接失败' })[state];
const formatTime = (value: number) => new Date(value).toLocaleString('zh-CN');
const credentialsComplete = computed(() => !!appId.value.trim() && !!appSecret.value);
const directoryBusy = ref(false);
const report = ref<ChannelValidation | null>(null);
const busy = ref(false), loaded = ref(false), error = ref(''), notice = ref('');
let controller = new AbortController();
watch(() => busy.value || directoryBusy.value || policyBusy.value || sharingBusy.value || registrationBusy.value, value => emit('busyChanged', value), { flush: 'sync' });
watch(unsaved,v=>emit('dirtyChanged',v),{flush:'sync'});
function clearSecrets() { appSecret.value = ''; }
watch(provider, () => { clearSecrets(); appId.value = connection.value?.appId ?? ''; replaceSource.value = false; notice.value = ''; error.value = ''; report.value = null; });
watch(connection, value => { historyEnabled.value = value?.context?.groupListenEnabled ?? false;keywordText.value=(value?.context?.groupTriggerKeywords??[]).join('\n'); appId.value = value?.appId ?? ''; clearSecrets(); replaceSource.value = false; });
async function run(action: (signal: AbortSignal) => Promise<void>) {
  if (channelLocked.value) return; const signal = controller.signal; busy.value = true; error.value = ''; notice.value = '';
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
function mergeIdentityEvidence(evidence: DirectoryIdentityEvidence) {
  const current = connections.value.find(item => item.sourceId === evidence.sourceId && item.authRevision === evidence.authRevision && item.provider === 'wecom');
  if (current) current.memberSearchVerifiedUserIds = [...new Set([...(current.memberSearchVerifiedUserIds ?? []), evidence.userId])];
}
async function load() { await run(read); }
async function mutate(action: 'connect' | 'revalidate' | 'settings') {
  if (!props.canManage || !loaded.value || channelLocked.value || policyDirty.value || sharingDirty.value || contextDirty.value || action === 'connect' && (!credentialsComplete.value || replacing.value&&!replaceSource.value)) return;
  const current = connection.value, selected = provider.value, rebinding=action==='connect'&&replacing.value;
  const body = action === 'connect' ? { appId: appId.value.trim(), appSecret: appSecret.value, expectedRevision: current?.revision ?? 0, replaceSource: rebinding&&replaceSource.value } : { expectedRevision: current?.revision ?? 0, ...(action === 'settings' ? { enabled: !current?.enabled } : {}) };
  clearSecrets();
  await run(async signal => {
    try {
      const result = await channelApi<DirectoryConnection & {validation?:ChannelValidation}>(`${props.base}/channels/${selected}${action === 'connect' ? '' : `/${action}`}`, signal, body, action === 'revalidate' ? 'POST' : 'PUT');
      if (signal.aborted) return;
      report.value = result.validation ?? null;
      notice.value = rebinding ? '换绑已保存。本渠道已恢复新建默认配置，旧名单未迁移；请核对新连接状态与使用范围。' : action === 'settings' ? (current?.enabled ? '已提交停用，请刷新核对连接状态。' : '已提交启用，请重新验证凭据并等待连接。') : current ? '已提交重新验证或连接。使用范围、能力包、群共享和上下文设置均保留，停用状态不变；请核对连接状态。' : '配置已保存：空白名单、群内可用，能力包继承本渠道范围。请核对连接状态。';
      if(rebinding)emit('rebound');
    } finally { if (!signal.aborted) { await read(signal); if (!signal.aborted) emit('changed'); } }
  });
}
async function unbindChannel() {
  if (!props.canManage || channelLocked.value || policyDirty.value || sharingDirty.value || contextDirty.value || !connection.value) return;
  const current = connection.value, selected = provider.value; clearSecrets();
  await run(async signal => {
    try { await api(`${props.base}/channels/${selected}`, signal, { expectedRevision: current.revision }, 'DELETE'); if (!signal.aborted) notice.value = '渠道绑定已解除，机器人身份已释放。其他渠道和历史业务记录保留，旧授权不会转给新的绑定。'; }
    finally { if (!signal.aborted) { await read(signal); if (!signal.aborted) emit('changed'); } }
  });
}
async function saveContext() {
  if (!props.canManage || channelLocked.value || policyDirty.value || sharingDirty.value || !loaded.value || !connection.value || !connection.value.capabilities?.recentGroupContext.supported && !connection.value.capabilities?.keywordTriggers.supported) return;
  const body = { enabled: connection.value.enabled, expectedRevision: connection.value.revision, groupListenEnabled: historyEnabled.value,groupTriggerKeywords:keywordText.value.split('\n').map(word=>word.trim()).filter(Boolean) };
  if(body.groupTriggerKeywords.length>20||body.groupTriggerKeywords.some(word=>word.length>80)){error.value='最多20个关键词，每个不超过80个字符。';return;}
  await run(async signal => {
    await api(`${props.base}/channels/${provider.value}/settings`, signal, body, 'PUT');
    if (!signal.aborted) { await read(signal);notice.value = '已保存。';emit('changed'); }
  });
}
watch(() => props.base, () => { controller.abort(); controller = new AbortController(); busy.value = false; loaded.value = false; report.value = null; notice.value = ''; error.value = ''; connections.value = []; runtimeSnapshot.value = null;policyDirty.value=false;policyBusy.value=false;sharingBusy.value=false;sharingDirty.value=false;confirmPolicySwitch.value=false;pendingPolicySwitch=undefined; clearSecrets(); void load(); }, { immediate: true });
onUnmounted(() => { controller.abort(); clearSecrets();emit('dirtyChanged',false); emit('busyChanged', false); });
</script>
<template>
  <div class="channel-connections">
    <NAlert v-if="confirmPolicySwitch" type="warning">当前渠道有未保存的修改，是否放弃并切换？<NSpace><NButton :disabled="channelLocked" @click="confirmPolicySwitch=false;pendingPolicySwitch=undefined">继续编辑当前渠道</NButton><NButton :disabled="channelLocked" @click="discardPolicySwitch">放弃策略修改并切换</NButton></NSpace></NAlert>
    <section v-if="!selectedConnection" class="connection-list">
      <header class="connection-list-heading"><div><h3>渠道连接</h3><p class="field-note">为员工接入飞书、钉钉或企业微信独立机器人，分别管理连接与使用范围。</p></div><NButton v-if="canManage" type="primary" @click="requestPolicySwitch(()=>selectedConnection=true)">添加渠道连接</NButton></header>
      <NCard v-for="item in displayConnections" :key="item.id" size="small"><div class="connection-summary"><ChannelBrand :provider="item.provider"/><NTag size="small">{{directoryStatusLabel(item)}}</NTag><span class="field-note">{{item.enabled?'已启用':'已停用'}} · {{item.runtimeTransport?transportLabel(item.runtimeTransport.state):'运行状态未知'}} · {{item.directoryMode==='member_search'?'成员搜索':item.directoryStatus==='available'?'通讯录可查询':'通讯录不可用'}}</span><NButton size="small" secondary @click="requestPolicySwitch(()=>{provider=item.provider;selectedConnection=true})">查看此连接</NButton></div></NCard>
      <div v-if="loaded&&!connections.length" class="connection-empty-state"><p class="field-note">尚未连接渠道，可按需添加。</p></div>
      <NAlert v-if="error" type="error" role="alert">{{error}}</NAlert>
    </section>
    <div v-show="selectedConnection" class="channel-detail">
      <div class="channel-detail-toolbar"><NButton size="small" aria-label="返回连接列表" :disabled="channelLocked" @click="requestPolicySwitch(()=>selectedConnection=false)">返回连接列表</NButton><NButton size="small" :disabled="channelLocked" :loading="busy" @click="requestPolicySwitch(()=>{void load()})">刷新渠道状态</NButton></div>
      <ChannelProviderTabs :before-change="guardProvider" :model-value="provider" @update:model-value="selectProvider" :disabled="disabled || channelLocked" :hide-navigation="!canManage">
        <template v-if="canManage && $slots.automation" #automation><slot name="automation" /></template>
        <section v-for="item in displayConnections.filter(c=>c.provider===provider)" :key="item.id" class="connection-status form-section" aria-label="当前连接状态">
          <div class="form-section-heading"><h3>当前连接</h3><NSpace><NTag size="small">{{directoryStatusLabel(item)}}</NTag><NTag size="small">{{item.directoryMode==='member_search'?'成员搜索':item.directoryStatus==='available'?'通讯录可查询':'通讯录不可用'}}</NTag></NSpace></div>
          <p data-testid="transport-status">长连接：{{item.runtimeTransport?.error==='channel_ingress_standby'?'由另一平台进程维护连接':item.runtimeTransport?transportLabel(item.runtimeTransport.state):'状态未知'}}<InfoHint label="连接状态说明">连接状态与身份、目录和使用权限分别核验。无法获取状态时不能判断为离线。</InfoHint></p>
          <p v-if="item.provider==='wecom'" data-testid="wecom-credential-status">机器人凭据：{{item.runtimeTransport?.state==='connected'?'当前长连接已认证':item.runtimeTransport?.state==='failed'?'连接未通过，请查看连接错误':'等待当前长连接认证结果'}}</p>
          <p v-if="!item.runtimeTransport" role="status">暂时无法确认此连接的运行状态，请稍后刷新。</p>
          <p v-if="item.runtimeTransport?.error && item.runtimeTransport.error!=='channel_ingress_standby'" role="status">连接错误：{{item.runtimeTransport.error}}</p><p v-if="item.lastError" role="status">{{item.lastError==='channel_identity_revalidation_required'?'机器人身份规则已更新，请先核对未完成任务，再重新验证此钉钉连接。':item.lastError}}</p>
          <details class="connection-diagnostics"><summary>连接诊断</summary><p v-if="item.observedAt">运行状态观测时间：{{formatTime(item.observedAt)}}</p><template v-if="item.runtimeTransport"><p>状态更新时间：{{formatTime(item.runtimeTransport.changedAt)}}</p><p v-if="item.runtimeTransport.lastConnectedAt">最近连接：{{formatTime(item.runtimeTransport.lastConnectedAt)}}</p><p v-if="item.runtimeTransport.lastDisconnectedAt">最近断线：{{formatTime(item.runtimeTransport.lastDisconnectedAt)}}</p><p v-if="item.runtimeTransport.error==='channel_ingress_standby'">当前平台进程处于待命状态，不代表渠道已停用或全局连接离线；此处不推断另一进程的在线状态。</p></template>
            <p>{{item.provider==='wecom'?'BotID':item.provider==='feishu'?'应用 App ID':'应用'}} {{item.appId}} · 版本 {{item.revision}}</p><p>身份证据：{{evidenceLabel(item.identityEvidence)}}</p><p>{{item.provider==='feishu'?'入站确认记录':'首条消息'}}：{{item.inboundVerified?'已确认':item.provider==='feishu'?'尚无确认记录':'尚未确认'}}</p><p v-if="item.botId">{{item.provider==='feishu'?'机器人 open_id':item.provider==='dingtalk'?'机器人 robotCode':item.status==='verified'?'已验证机器人':'配置机器人（待验证）'}} {{item.botId}}</p><p>身份依据：{{item.tenantIdNamespace}} · {{item.tenantId}}</p><p v-if="item.tenantIdNamespace==='app_scoped'||item.tenantIdNamespace==='app_id'">{{item.provider==='feishu'?'租户 tenant_key 尚未确认，应用 App ID 不能代替租户身份。':'仅证明应用身份，不代表企业 corpId 已验证。'}}</p>
          </details>
        </section>
        <ChannelCapabilities v-if="connection" :capabilities="connection.capabilities" :provider="provider" @session-expired="emit('sessionExpired')"/>
        <template v-if="canManage">
          <section class="form-section channel-setup" aria-label="渠道接入配置">
            <header class="form-section-heading"><h3>机器人连接凭据</h3><a :href="provider==='feishu'?'https://open.feishu.cn/app':provider==='dingtalk'?'https://open-dev.dingtalk.com/':'https://work.weixin.qq.com/wework_admin/frame'" target="_blank" rel="noopener noreferrer">打开官方后台 ↗</a></header>
            <WeComRegistration v-if="selectedConnection && provider==='wecom'" :key="base" :context="base" :disabled="registrationBlocked" @busy-changed="v=>registrationBusy=v" @credentials="receiveRegistration"/>
            <p v-if="provider==='wecom' && unsaved" class="field-note">当前有未保存修改。请先保存，或清空手填凭据并取消其他修改，再开始扫码。</p>
            <NForm class="channel-connection-form settings-form" @submit.prevent>
              <NFormItem :label="provider==='wecom'?'BotID':provider==='dingtalk'?'Client ID（AppKey）':'App ID'"><NInput v-model:value="appId" :disabled="channelLocked||!loaded" :input-props="{'aria-label':'渠道应用 ID',autocomplete:'off'}"/></NFormItem>
              <NFormItem :label="provider==='wecom'?'Secret':provider==='dingtalk'?'Client Secret（AppSecret）':'App Secret'"><NInput v-model:value="appSecret" type="password" :disabled="channelLocked||!loaded" :input-props="{'aria-label':'渠道应用密钥',autocomplete:'new-password'}"/></NFormItem>
              <p v-if="provider==='feishu'" class="field-note">App ID 标识应用；机器人 open_id 标识应用内的机器人，由官方 API 自动读取，无需手填。未取得可信 open_id 时不能完成连接验证。</p>
              <p class="field-note">{{provider==='wecom'?'仅需本员工独立机器人的 BotID 和 Secret。':'每位员工使用独立机器人应用。'}}<InfoHint label="凭据保存与更换">密钥只写入，提交后清空。相同机器人重新验证、重连或轮换密钥保留所有配置和停用状态。更换机器人须确认换绑并保存；转绑其他员工前须先解除原绑定。</InfoHint></p>
            </NForm>
            <NAlert v-if="replacing" type="warning" aria-label="换绑授权重置提醒">保存换绑后，启用新连接，仅当前渠道恢复新建默认值：空白名单、群内可用、能力包继承员工使用范围；飞书近期群消息上下文默认打开。当前渠道的人员名单、能力包渠道限制、群共享规则与缓存会重置，旧名单不迁移。群内可用和能力包继承可能扩大授权。其他渠道、网页权限和资源绑定不变。未保存前原绑定继续有效。<NCheckbox v-model:checked="replaceSource" :disabled="channelLocked" aria-label="确认换绑并重置当前渠道配置">我确认换绑并重置当前渠道配置</NCheckbox></NAlert>
            <ChannelSetupRequirements :provider="provider"/>
            <NAlert v-if="error" type="error" role="alert">{{error}}</NAlert><NAlert v-if="notice" type="info" role="status">{{notice}}</NAlert>
            <ChannelValidationReport v-if="report && (provider!=='wecom'||!report.canContinue)" :report="report"/>
        <div class="channel-actions" ><NButton key="connect" @click="mutate('connect')" type="primary" :disabled="channelLocked || policyDirty || sharingDirty || contextDirty || !loaded || !credentialsComplete || (replacing&&!replaceSource)" :loading="busy">{{replacing?'保存换绑':provider==='wecom'?'保存机器人配置':'验证并保存渠道连接'}}</NButton><NButton key="revalidate" v-if="connection" :disabled="channelLocked||policyDirty||sharingDirty||contextDirty" @click="mutate('revalidate')">{{provider==='wecom'?'重新连接并检查':'重新验证已存凭据'}}</NButton><NButton key="settings" v-if="connection" :disabled="channelLocked||policyDirty||sharingDirty||contextDirty" @click="mutate('settings')">{{ connection.enabled ? '停用此渠道' : '启用此渠道' }}</NButton><NPopconfirm v-if="connection" :disabled="channelLocked||policyDirty||sharingDirty||contextDirty" positive-text="确认解除绑定" negative-text="保留绑定" @positive-click="unbindChannel"><template #trigger><NButton :disabled="channelLocked||policyDirty||sharingDirty||contextDirty">解除渠道绑定</NButton></template>解除本员工的当前渠道绑定并停止连接，释放全平台机器人身份；历史业务记录保留，旧授权不会转给新的绑定。</NPopconfirm></div>
          </section>
      <NAlert v-if="provider === 'feishu' && connection?.status === 'verified'" type="success">机器人与租户身份已验证，可按使用范围使用；实际收发、长连接与模型状态仍需分别核对。</NAlert>
      <NAlert v-if="provider === 'feishu' && connection?.status === 'pending_verification'" :type="connection.botId ? 'info' : 'warning'" aria-label="飞书身份确认状态">
        <template v-if="connection.botId">已通过官方 API 取得机器人 open_id，仅待确认租户 tenant_key。长连接在线后，从飞书客户端给此机器人发普通真人私聊，或在群里真正 @ 此机器人；系统会自动确认租户，并按现有使用范围处理同一条消息。首发者不会自动获得使用权，无需验证口令或人工确认。发送后可刷新渠道状态。</template>
        <template v-else>尚未取得可信的机器人 open_id，不能自动确认身份。请先在飞书应用中启用机器人能力，再重新验证已存凭据；应用 App ID 或消息中的 @ 不能替代机器人身份。</template>
      </NAlert>
      <NAlert v-if="provider !== 'feishu' && connection?.status === 'pending_verification'" type="info">凭据已保存。长连接在线后，给机器人发一条普通私聊或群定向消息，系统会自动确认身份；同一条消息仍按现有使用范围鉴权，首发者不会自动获得使用权。</NAlert>
    <ChannelAccessSettings v-if="canManage && selectedConnection && connection" ref="policyEditor" :base="base" :connection="connection" :can-manage="canManage" :disabled="!!disabled||busy||directoryBusy||sharingBusy" @busy-changed="v=>policyBusy=v" @dirty-changed="v=>policyDirty=v" @identity-verified="mergeIdentityEvidence" @changed="emit('changed')" @session-expired="emit('sessionExpired')" />
      <NCard v-if="connection && provider!=='wecom' && (connection.capabilities?.recentGroupContext.supported || connection.capabilities?.keywordTriggers.supported)" title="群聊触发与上下文" size="small">
        <p class="field-note">普通群消息：{{ connection.groupListeningStatus?.permission === 'granted' ? '已授权' : connection.groupListeningStatus?.permission === 'denied' ? '未授权' : '未核验' }}<InfoHint label="关于群消息接收">上下文开关只控制近期群消息保留，不控制 SDK 接收或关键词触发。群消息接收权限与连接状态分别核验。最近窗口缓存 {{ connection.groupListeningStatus?.cachedMessages ?? 0 }} 条；没有缓存不表示已获权限。</InfoHint></p>
        <p class="field-note">当前保存的触发方式：{{connection.context?.groupTriggerKeywords?.length ? '@ 或关键词（关键词须有普通群消息权限）' : '仅 @'}}；均须通过使用授权。</p>
        <NForm class="channel-context-form" @submit.prevent="saveContext">
          <NFormItem v-if="connection.capabilities?.keywordTriggers.supported" label="触发关键词"><div><NInput v-model:value="keywordText" type="textarea" :rows="3" :input-props="{'aria-label':'群聊触发关键词'}" aria-label="群聊触发关键词" :disabled="channelLocked || !['available','authorization_required'].includes(connection.capabilities?.keywordTriggers.availability??'unknown')" placeholder="每行一个关键词" /><p class="field-note">每行一个，最多20个，每个80字；留空关闭。未获权限时可保存草稿，实际触发仍须通过后台权限核验。<InfoHint label="关键词匹配规则">正文包含任一词即可触发，英文忽略大小写，不支持正则。没有使用权时静默；@ 按原规则处理。</InfoHint></p><NAlert v-if="connection.groupListeningStatus?.permission!=='granted'" :type="connection.groupListeningStatus?.permission==='denied'?'warning':'info'">{{ connection.groupListeningStatus?.permission==='denied'?'缺少普通群消息接收权限，关键词暂不可触发。':'普通群消息接收权限尚未验证，关键词暂不可触发。' }}请在飞书确认应用权限后重新验证连接。</NAlert></div></NFormItem>
          <NCheckbox v-if="connection.capabilities?.recentGroupContext.supported" v-model:checked="historyEnabled" :disabled="channelLocked" aria-label="保留近期群消息作为上下文">保留近期群消息作为上下文</NCheckbox>
          <p class="field-note">新建默认打开，与上方“群成员在群内使用”和群消息共享分别配置。关闭后不再保留此近期群消息窗口；已获普通群消息权限且渠道可用时，仍接收消息并匹配关键词。仅 @ 或关键词命中且有使用权时回复。<InfoHint label="群上下文范围">每群/话题保留最近100条，不补拉历史。文件、图片和会议以资料引用记录，能否读取取决于资料权限与可用状态。</InfoHint></p>
          <NSpace><NButton attr-type="submit" type="primary" :disabled="channelLocked || policyDirty || sharingDirty || !contextDirty" :loading="busy">保存</NButton><NButton :disabled="busy||directoryBusy||!contextDirty" @click="historyEnabled=connection.context?.groupListenEnabled??false;keywordText=(connection.context?.groupTriggerKeywords??[]).join('\n')">取消</NButton></NSpace>
        </NForm>
      </NCard>
      <GroupSharingSettings v-if="selectedConnection && provider==='feishu' && connection" :key="base+':sharing:'+connection.sourceId" ref="sharingEditor" :base="base" :disabled="!!disabled||busy||directoryBusy||policyBusy||policyDirty" @busy-changed="v=>sharingBusy=v" @dirty-changed="v=>sharingDirty=v" @changed="emit('changed')" @session-expired="emit('sessionExpired')"/>
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
.optional-directory{display:grid;justify-items:start;gap:12px}
.optional-directory .wecom-directory-binding{width:100%}
.connection-diagnostics{color:var(--muted);font-size:var(--id-font-size-meta);padding-top:8px;border-top:1px solid var(--subtle)}
.connection-diagnostics summary{cursor:pointer;font-weight:500;color:var(--text)}
.channel-context-form{max-width:var(--id-form-max-width)}
</style>
