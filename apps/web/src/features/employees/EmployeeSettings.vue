<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import AvatarPicker from '../../shared/ui/AvatarPicker.vue';
import EmployeeAvatar from '../../shared/ui/EmployeeAvatar.vue';
import PageHeader from '../../shared/ui/PageHeader.vue';
import TriggerSettings from './TriggerSettings.vue';
import { computed, ref, watch,nextTick,defineAsyncComponent } from 'vue';
import { useAccessibleTabs, vAccessibleTablist } from '../../shared/ui/useAccessibleTabs';
import { NAlert, NButton, NForm, NSpace, NTabPane, NTabs, NSelect, NDropdown, NModal,NDrawer,NDrawerContent } from 'naive-ui';
import type { FormInst, FormRules } from 'naive-ui';
import AtomicModelSettings from './AtomicModelSettings.vue';
import EmployeeOverview from './EmployeeOverview.vue';
import WebChatAccessSettings from './WebChatAccessSettings.vue';
import {useWebChatAccess} from './useWebChatAccess';
import StatusBadge from '../../shared/ui/StatusBadge.vue';
import EmployeeIdentityFields from './EmployeeIdentityFields.vue';
import EmployeeConfigurationReadOnly from './EmployeeConfigurationReadOnly.vue';
import ChannelConnections from './ChannelConnections.vue';
import HandoffAccessSettings from './HandoffAccessSettings.vue';
import {useWorkItemBeta} from '../work-items/useWorkItemBeta';
import AccessSettings from './AccessSettings.vue';
import { useEmployeeSettings } from './useEmployeeSettings';
import type { EmployeeSettingsProps, EmployeeSettingsEmits } from './useEmployeeSettings';
const EntityWorkspace=defineAsyncComponent(()=>import('../conversations/EntityWorkspace.vue').then(module=>module.default));
const EmployeeTasks=defineAsyncComponent(()=>import('../tasks/EmployeeTasks.vue').then(module=>module.default));
const props = defineProps<EmployeeSettingsProps>();
const emit = defineEmits<EmployeeSettingsEmits>();
const { avatarPreset,canManage, base, name, description, executionThinkingLevel, saving, error, notice, modelBusy, accessBusy, channelBusy, busy:settingsBusy, saveBasics, verifyBasics,unknownBasic,setEnabled } = useEmployeeSettings(props, emit);
const workItemBeta=useWorkItemBeta(()=>base.value,()=>emit('sessionExpired'));
const handoffBusy=ref(false),handoffDirty=ref(false);
const statusRefresh=ref(0);watch(error,value=>{if(value)statusRefresh.value++;});
const humanBusy=ref(false),humanDirty=ref(false),channelBindingsVersion=ref(0);
const triggerBusy=ref(false),modelDirty=ref(false),confirmLeave=ref(false),channelDirty=ref(false),editDetails=ref(false),confirmDetails=ref(false);
const basicDirty=computed(()=>avatarPreset.value!==(props.entity.avatarPreset??null)||name.value!==props.entity.name||description.value!==(props.entity.description??''));
const sections=[{value:'overview',label:'概览'},{value:'chat',label:'对话'},{value:'tasks',label:'任务'},{value:'capabilities',label:'能力包'},{value:'channels',label:'渠道'},{value:'automation',label:'触发器'},{value:'model',label:'模型'}];
function normalizeSection(value?:string){return sections.some(s=>s.value===value)?value!:'overview';}
const tab=ref(props.embedded?'channels':normalizeSection(props.section));
const webAccess=useWebChatAccess(()=>base.value,()=>canManage.value&&tab.value==='overview',()=>{statusRefresh.value++;emit('configurationChanged');},()=>emit('sessionExpired'));
const dirty=computed(()=>handoffDirty.value||humanDirty.value||basicDirty.value||modelDirty.value||webAccess.dirty||channelDirty.value);
const busy=computed(()=>handoffBusy.value||humanBusy.value||settingsBusy.value||triggerBusy.value||webAccess.saving);
watch([busy,dirty], () => emit('busyChanged', busy.value || dirty.value), { flush: 'sync' });
watch(dirty, value => { if (!value) confirmLeave.value = false; });
const webCard=ref<HTMLElement|null>(null);
function focusWebAccess(){tab.value='overview';void nextTick(()=>webCard.value?.scrollIntoView?.({block:'nearest'}));}
watch(()=>props.section,v=>{if(v==='identity'){editDetails.value=true;return;}tab.value=normalizeSection(v);},{immediate:true});
watch(tab,v=>emit('sectionChanged',v));
const selectedConversationId=ref(props.conversationId);watch(()=>props.conversationId,id=>selectedConversationId.value=id);
function conversationSelected(id:string){selectedConversationId.value=id;emit('conversationSelected',id);}
function openConversation(id:string){conversationSelected(id);tab.value='chat';}
function selectSection(value:string){if(value==='access'){focusWebAccess();return;}tab.value=value==='identity'?'model':normalizeSection(value);}
function editIdentity(){if(busy.value)return;editDetails.value=true;emit('sectionChanged','identity');}
function closeIdentity(){if(busy.value)return;if(basicDirty.value||unknownBasic.value){confirmDetails.value=true;return;}editDetails.value=false;emit('sectionChanged',tab.value);}
function cancelIdentity(){if(busy.value)return;avatarPreset.value=props.entity.avatarPreset??null;name.value=props.entity.name;description.value=props.entity.description??'';error.value='';notice.value='';}
function discardIdentity(){if(busy.value||unknownBasic.value)return;cancelIdentity();confirmDetails.value=false;editDetails.value=false;emit('sectionChanged',tab.value);}
const leaveTarget=ref<'directory'|'recent'>('directory');
const statusConfirm=ref(false),sectionSelectOpen=ref(false);
const { tabProps, panelProps } = useAccessibleTabs(tab, () => sections.map(s=>s.value), () => busy.value);
const formRef = ref<FormInst | null>(null),identityFields=ref<InstanceType<typeof EmployeeIdentityFields>|null>(null);
const formModel = computed(() => ({ name: name.value }));
const rules: FormRules = { name: { required: true, validator: () => !!name.value.trim() || new Error('请输入员工名称'), trigger: ['input', 'blur'] } };
async function submitBasics() { if (busy.value) return; try { await formRef.value?.validate(); await saveBasics(); } catch { await identityFields.value?.showNameError(); } }
function focusStatusCancel(){document.querySelectorAll<HTMLButtonElement>('.n-dialog button').forEach(b=>{if(b.textContent?.includes('保留当前状态'))b.focus();});}
function requestNavigation(target:'directory'|'recent'){if(busy.value)return;leaveTarget.value=target;if(dirty.value){confirmLeave.value=true;return;}if(target==='recent')emit('recentConversations');else emit('close');}
function requestClose(){requestNavigation('directory');}
function discardAndClose(){if(busy.value)return;emit('busyChanged',false);if(leaveTarget.value==='recent')emit('recentConversations');else emit('close');}
</script>
<template>
<section class="employee-settings" :class="{'is-chat':tab==='chat'}" aria-label="数字员工设置">
  <div v-if="!embedded" class="employee-backlinks"><NButton text aria-label="返回员工列表" :disabled="busy" @click="requestClose">← 返回员工列表</NButton><NButton text :disabled="busy" @click="requestNavigation('recent')">最近对话</NButton></div>
  <PageHeader v-if="!embedded" class="employee-object-header" :title="entity.name" :description="entity.description||'尚未填写职责'"><template #leading><EmployeeAvatar :name="entity.name" :preset="entity.avatarPreset" :identity-key="entity.id" size="chat"/></template><template #meta><StatusBadge :status="entity.enabled===false?'disabled':'enabled'"/></template><NSpace><NButton v-if="entity.canChat===true&&tab!=='chat'" type="primary" :disabled="busy" @click="tab='chat'">进入对话</NButton><NButton v-if="canManage" class="employee-edit-button" :disabled="busy" @click="editIdentity">编辑资料</NButton><NDropdown v-if="canManage" trigger="click" :menu-props="()=>({role:'menu','aria-label':'员工更多操作'})" :options="[{key:'edit',label:'编辑资料',props:{role:'menuitem'}},{key:'status',props:{role:'menuitem'},label:entity.enabled===false?'恢复员工':'停用员工'}]" @select="key=>{if(key==='edit')editIdentity();else statusConfirm=true}"><NButton :disabled="busy" aria-label="更多员工操作">更多 ···</NButton></NDropdown></NSpace></PageHeader>
  <NModal v-model:show="statusConfirm" preset="dialog" :title="`${entity.enabled===false?'恢复':'停用'}「${entity.name}」？`" :content="entity.enabled===false?'恢复员工后，渠道需要逐项启用并验证。':'停用后不能发起新工作；历史和机器人绑定保留。有在途工作时会拒绝此操作。'" positive-text="确认员工状态变更" negative-text="保留当前状态" :auto-focus="true" @after-enter="focusStatusCancel" @positive-click="statusConfirm=false;setEnabled()"/>
  <EmployeeConfigurationReadOnly v-if="!canManage" :key="base" :base="base" @session-expired="emit('sessionExpired')" />
  <template v-else>
    <div v-if="confirmLeave||dirty||error||notice" class="employee-alerts">
      <NAlert v-if="confirmLeave" type="warning">有未保存的修改，确定丢弃并离开当前员工？<NSpace><NButton size="small" :disabled="busy" @click="confirmLeave=false">继续编辑员工</NButton><NButton size="small" :disabled="busy" @click="discardAndClose">丢弃本页修改并返回</NButton></NSpace></NAlert>
      <p v-else-if="dirty" class="employee-dirty-banner" role="status">有未保存的修改，离开前请保存或取消。</p>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    </div>
    <label class="mobile-section-picker"><span>员工页面</span><NSelect v-model:value="tab" :options="sections" :virtual-scroll="false" :input-props="{role:'combobox','aria-label':'员工分区','aria-expanded':sectionSelectOpen,'aria-controls':'employee-sections-'+entity.id}" :menu-props="{role:'listbox',id:'employee-sections-'+entity.id,'aria-label':'员工分区选项'}" :node-props="option=>({role:'option','aria-selected':option.value===tab})" :disabled="busy" @update:show="v=>sectionSelectOpen=v"/></label>
    <NTabs class="employee-section-tabs" v-accessible-tablist="'员工设置分类'" v-model:value="tab" type="line" :on-before-leave="()=>!busy">
      <NTabPane key="overview" name="overview" tab="概览" :tab-props="tabProps('overview')" v-bind="panelProps('overview')" display-directive="show:lazy"><EmployeeOverview @dirty-changed="v=>humanDirty=v" @busy-changed="v=>humanBusy=v" :base="base" :refresh-key="`${entity.lifecycleRevision??1}:${statusRefresh}`" @status-read="v=>{if(v.lifecycleRevision!==entity.lifecycleRevision||v.enabled!==entity.enabled)emit('entityUpdated',{...entity,...v})}" :can-manage="canManage" @status="statusConfirm=true" @section="selectSection" @chat="tab='chat'"><template #web-access><div ref="webCard" class="overview-web-access"><WebChatAccessSettings :state="webAccess" :disabled="saving||triggerBusy"/><HandoffAccessSettings v-if="workItemBeta.enabled.value" :base="base" :disabled="saving||triggerBusy||webAccess.saving" @busy-changed="v=>handoffBusy=v" @dirty-changed="v=>handoffDirty=v" @changed="emit('configurationChanged')" @session-expired="emit('sessionExpired')"/></div></template></EmployeeOverview></NTabPane>
      <NTabPane key="chat" name="chat" tab="对话" :tab-props="tabProps('chat')" v-bind="panelProps('chat')" display-directive="if"><EntityWorkspace :key="base" :entity="entity" :workspace="workspace" embedded v-bind="selectedConversationId?{initialConversationId:selectedConversationId}:{}" @close="requestNavigation('recent')" @session-expired="emit('sessionExpired')" @edit-settings="tab='overview'" @entity-updated="v=>emit('entityUpdated',v)" @conversation-selected="conversationSelected" @open-tasks="id=>{conversationSelected(id);tab='tasks'}"/></NTabPane>
      <NTabPane key="tasks" name="tasks" tab="任务" :tab-props="tabProps('tasks')" v-bind="panelProps('tasks')" display-directive="if"><EmployeeTasks :key="base" :entity="entity" :workspace="workspace" :conversation-id="selectedConversationId" embedded @session-expired="emit('sessionExpired')" @conversation-selected="conversationSelected" @open-conversation="openConversation"/></NTabPane>
      <NTabPane key="capabilities" name="capabilities" tab="能力包" :tab-props="tabProps('capabilities')" v-bind="panelProps('capabilities')" display-directive="show:lazy"><AccessSettings :key="`${base}:capabilities:${channelBindingsVersion}`" :base="base" section="capabilities" @busy-changed="v=>accessBusy=v" @changed="emit('configurationChanged')" @session-expired="emit('sessionExpired')"/></NTabPane>
      <NTabPane key="channels" name="channels" :tab-props="tabProps('channels')" v-bind="panelProps('channels')" tab="渠道" display-directive="show:lazy"><div class="employee-channels-stack"><ChannelConnections :employee-name="entity.name" :active="tab==='channels'" @rebound="channelBindingsVersion++" :key="base" @dirty-changed="v=>channelDirty=v" :base="base" :can-manage="canManage" :disabled="saving || triggerBusy" @busy-changed="v=>channelBusy=v" @changed="emit('configurationChanged')" @session-expired="emit('sessionExpired')"/></div></NTabPane>
      <NTabPane key="automation" name="automation" tab="触发器" :tab-props="tabProps('automation')" v-bind="panelProps('automation')" display-directive="show:lazy"><TriggerSettings :key="base" :base="base" :disabled="saving||channelBusy" @busy-changed="v=>triggerBusy=v" @changed="emit('configurationChanged')" @session-expired="emit('sessionExpired')"/></NTabPane>
      <NTabPane key="model" name="model" tab="模型" :tab-props="tabProps('model')" v-bind="panelProps('model')" display-directive="show:lazy"><AtomicModelSettings :key="base" :base="base" :disabled="saving||triggerBusy" @busy-changed="v=>modelBusy=v" @dirty-changed="v=>modelDirty=v" @saved="v=>{executionThinkingLevel=v;emit('entityUpdated',{...entity,executionThinkingLevel:v})}" @session-expired="emit('sessionExpired')"/></NTabPane>
    </NTabs>
    <NDrawer :show="editDetails" :width="'min(34rem,100vw)'" :mask-closable="false" @update:show="v=>{if(!v)closeIdentity()}"><NDrawerContent title="编辑资料" closable>
      <NAlert v-if="confirmDetails" type="warning">资料尚未保存。<NSpace><NButton @click="confirmDetails=false">继续编辑</NButton><NButton :disabled="unknownBasic" @click="discardIdentity">丢弃修改</NButton></NSpace></NAlert>
      <NForm ref="formRef" :model="formModel" :rules="rules" @submit.prevent="submitBasics"><AvatarPicker v-model:value="avatarPreset" :identity-key="entity.id" :disabled="busy"/><EmployeeIdentityFields ref="identityFields" v-model:name="name" v-model:description="description" :disabled="busy" :name-maxlength="120"/><NSpace><NButton :type="basicDirty?'primary':'default'" attr-type="submit" aria-label="保存基本信息" :disabled="busy||unknownBasic||!basicDirty" :loading="saving">保存</NButton><NButton :disabled="busy||unknownBasic" aria-label="取消员工信息修改" @click="discardIdentity">取消</NButton></NSpace></NForm>
      <NAlert v-if="unknownBasic" type="warning">保存结果暂未确认，请先核对。<NButton :disabled="busy" @click="verifyBasics">核对基本信息保存结果</NButton></NAlert>
    </NDrawerContent></NDrawer>
  </template>
</section>
</template>
<style scoped>
.employee-settings{min-width:0}
.employee-backlinks{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.employee-backlinks :deep(.n-button){height:28px;min-height:28px;font-size:13px;color:var(--muted)}
.employee-backlinks :deep(.n-button:hover){color:var(--text)}
.employee-object-header{--avatar-chat:56px;padding:20px 24px;border:1px solid var(--subtle);border-radius:12px;background:var(--surface);margin-bottom:16px;box-shadow:var(--id-shadow-xs,0 1px 2px #00000008)}
.employee-object-header :deep(.page-heading-identity){align-items:center;gap:16px}
.employee-object-header :deep(.page-actions){align-self:center}
.employee-object-header :deep(h1){font-size:20px;line-height:28px;margin-bottom:4px}
.employee-object-header :deep(.muted){margin-bottom:6px;font-size:13px;line-height:20px}
.employee-alerts{display:grid;gap:10px;margin-bottom:16px}
.employee-dirty-banner{margin:0;padding:8px 14px;border-radius:8px;background:var(--id-status-warning-bg,var(--warningTint));border:1px solid var(--id-status-warning-border,var(--subtle));color:var(--id-status-warning-fg,var(--warning));font-size:13px}
.mobile-section-picker{display:none}
.employee-section-tabs :deep(> .n-tabs-nav){margin-bottom:20px;background:transparent;border-bottom:1px solid var(--subtle);border-radius:0;padding:0;width:100%}
.employee-section-tabs :deep(> .n-tabs-nav .n-tabs-tab){min-height:42px;padding:10px 16px;border-radius:0;background:transparent;font-weight:500}
.employee-section-tabs :deep(> .n-tabs-nav .n-tabs-tab--active){background:transparent;color:var(--selectedText);box-shadow:inset 0 -2px var(--brand);font-weight:600}
.employee-section-tabs :deep(> .n-tabs-nav .n-tabs-tab--active .n-tabs-tab__label){color:var(--selectedText)}
.employee-section-tabs :deep(> .n-tabs-nav .n-tabs-bar){display:none}
.employee-section-tabs :deep(.n-tabs-pane-wrapper){min-width:0}
.employee-section-tabs :deep(.n-tab-pane){padding-top:0}
.employee-channels-stack{display:grid;gap:20px;min-width:0}
.employee-settings :deep(.n-form){margin-top:12px}
@media(max-width:47.5rem){
  .employee-backlinks :deep(.n-button){height:2.75rem;min-height:2.75rem}
  .mobile-section-picker{display:grid;gap:.5rem;margin:1rem 0}
  .employee-section-tabs :deep(> .n-tabs-nav){display:none}
  .is-chat .employee-object-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.5rem;padding:.75rem;margin-bottom:.5rem}
  .is-chat .employee-object-header :deep(.page-actions){width:auto}
  .is-chat .employee-object-header :deep(.page-heading-identity){gap:.5rem;--avatar-chat:2.5rem}
  .is-chat .employee-object-header :deep(h1){font-size:1.125rem;line-height:1.5;margin:0}
  .is-chat .employee-object-header :deep(.muted),.is-chat .employee-object-header :deep(.n-tag),.is-chat .employee-edit-button{display:none}
  .is-chat .mobile-section-picker{margin:.5rem 0;gap:0}
  .is-chat .mobile-section-picker>span{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  .is-chat .employee-backlinks{margin-bottom:.5rem}
}
</style>
