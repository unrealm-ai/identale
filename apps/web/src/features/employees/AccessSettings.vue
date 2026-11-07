<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import {computed,ref} from 'vue';
import {NAlert,NButton,NCard,NCheckbox,NForm,NFormItem,NSelect,NSpace} from 'naive-ui';
import {useAccessSettings} from './useAccessSettings';
import type {AccessSettingsProps,AccessSettingsEmits} from './useAccessSettings';
import DirectoryRulePicker from '../directory/DirectoryRulePicker.vue';
import CapabilityPackageList from './CapabilityPackageList.vue';
import HandoffAccessSettings from './HandoffAccessSettings.vue';
import CapabilityPackageEditor from './CapabilityPackageEditor.vue';
import {emptyPackage,packageEditor,packageInput,type PackageEditorValue} from './capability-package-view';
const props=defineProps<AccessSettingsProps>(),emit=defineEmits<AccessSettingsEmits>();
const handoffBusy=ref(false),handoffDirty=ref(false);const editor=ref<PackageEditorValue|null>(null),editorQueryBusy=ref(false);
const state=useAccessSettings(props,(event:string,value?:boolean)=>{if(event==='dirtyChanged')emit('dirtyChanged',!!value||handoffDirty.value);else if(event==='busyChanged')emit('busyChanged',!!value||editor.value!==null||handoffBusy.value);else if(event==='changed'||event==='sessionExpired')emit(event);});
const {packageUserPolicyMode,beta,handoffOptions,packageHandoffMode,packageHandoffScope,legacyWeb,legacyDirectory,webDirty,directoryDirty,resetWeb,resetDirectory,triggerOptions,packageTriggerScope,packageConversationKinds,uploadSkill,directoryAccess,subjects,packageDirectoryAllow,packageDirectoryDeny,saveDirectoryAccess,members,resources,packages,access,name,packageDescription,enabled,mode,allowMemberIds,denyMemberIds,resourceIds,busy,loaded,error,notice,load,edit,saveAccess,savePackage,togglePackage}=state;
const memberOptions=computed(()=>members.value.map(m=>({label:m.displayName,value:m.id})));
const rows=computed(()=>packages.value.map(p=>({...packageEditor(p),key:p.id,version:p.version})));
const availableDirectory=computed(()=>subjects.value.sources.some(s=>s.enabled&&s.status==='verified'&&s.directoryStatus==='available'));
const locked=computed(()=>busy.value||editor.value!==null||handoffBusy.value);
function open(key?:string){if(busy.value||!loaded.value)return;const p=packages.value.find(p=>p.id===key);edit(p);editor.value=p?packageEditor(p):emptyPackage();emit('busyChanged',true);}
function close(){if(busy.value||editorQueryBusy.value)return;editor.value=null;emit('busyChanged',false);}
async function submit(value:PackageEditorValue){if(busy.value||editorQueryBusy.value)return;const input=packageInput(value);packageUserPolicyMode.value=input.userPolicyMode;name.value=input.name;packageDescription.value=input.description??'';enabled.value=input.enabled;mode.value=input.mode;allowMemberIds.value=input.allowMemberIds;denyMemberIds.value=input.denyMemberIds;resourceIds.value=input.resourceIds;packageDirectoryAllow.value=input.directoryAccess?.allow??[];packageDirectoryDeny.value=input.directoryAccess?.deny??[];packageConversationKinds.value=input.conversationKinds;packageTriggerScope.value=input.triggerUsageScope;packageHandoffScope.value=input.handoffUsageScope;packageHandoffMode.value=input.handoffUsageMode;await savePackage();if(!error.value)close();}
async function upload(file:File,value:PackageEditorValue){resourceIds.value=[...value.resourceIds];await uploadSkill(file);if(editor.value)editor.value={...value,resourceIds:[...resourceIds.value]};}
function toggle(key:string){const p=packages.value.find(p=>p.id===key);if(p&&!locked.value)void togglePackage(p);}
</script>
<template>
<div class="config-stack access-settings">
  <div class="access-toolbar">
    <p class="field-note access-note">网页成员和渠道人员分别设置。管理员工不代表自动获得使用权。能力包仍按自己的权限配置使用。</p>
    <NButton size="small" :disabled="locked" :loading="busy" @click="load">重新读取配置</NButton>
  </div>
  <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert><NAlert v-if="notice" :type="error ? 'warning' : 'success'" role="status">{{ notice }}</NAlert>
  <template v-if="loaded">
    <NCard v-if="section!=='capabilities'" title="Web 私聊使用策略" size="small"><p class="field-note">白名单中的平台成员可以使用网页对话；与渠道身份不自动关联。</p>
      <NAlert v-if="legacyWeb" type="warning">已配置额外使用限制，仍会生效。本页修改白名单不会移除这些限制。</NAlert><NForm @submit.prevent="saveAccess"><NFormItem label="工作区范围"><NCheckbox v-model:checked="access.allowWorkspaceMembers" :disabled="locked" aria-label="允许工作区成员使用">允许当前及以后加入的活跃工作区成员使用</NCheckbox></NFormItem><div class="policy-grid"><NFormItem label="允许成员"><NSelect v-model:value="access.allowMemberIds" aria-label="允许成员" :input-props="{ 'aria-label': '允许成员' }" multiple filterable :disabled="locked" :options="memberOptions" placeholder="选择允许使用的成员" /></NFormItem></div><NSpace><NButton :type="webDirty?'primary':'default'" attr-type="submit" :disabled="locked" :loading="busy">保存 Web 使用策略</NButton><NButton :disabled="locked||!webDirty" @click="resetWeb">取消 Web 范围修改</NButton></NSpace></NForm>
    </NCard>
    <NCard v-if="section!=='capabilities'" title="渠道用户与部门使用策略" size="small"><NAlert v-if="!availableDirectory" type="info">当前没有可选择的员工渠道目录；平台成员策略仍独立有效，已有渠道规则保留。</NAlert><p class="field-note">与网页对话的使用范围分别保存。新加入的人员和部门可在私聊、群聊使用；已有额外限制保持不变。部门默认不包含子部门；可选范围受应用的通讯录权限限制。</p><NAlert v-if="legacyDirectory" type="warning">已配置额外使用限制，仍会生效。本页修改白名单或群内开放不会移除这些限制。</NAlert><NForm class="directory-access-form" @submit.prevent="saveDirectoryAccess"><NFormItem label="群内使用"><div><NCheckbox v-model:checked="directoryAccess.allowGroupMembers" :disabled="locked" aria-label="允许群成员在群内使用">允许群成员在群内使用</NCheckbox><p class="field-note">默认关闭。目前适用于飞书：群成员可在机器人所在群内通过 @ 或已配置的关键词使用员工；不会获得私聊或网页使用权。白名单成员的私聊使用不受此开关影响。</p></div></NFormItem><div class="policy-grid"><NFormItem label="允许渠道用户 / 部门"><DirectoryRulePicker employee-scope v-model:rules="directoryAccess.allow" :subjects="subjects" hide-unavailable-notice :base="base" label="允许渠道用户或部门" :disabled="locked" /></NFormItem></div><NSpace><NButton :type="directoryDirty?'primary':'default'" attr-type="submit" :disabled="locked" :loading="busy">保存渠道使用策略</NButton><NButton :disabled="locked||!directoryDirty" @click="resetDirectory">取消渠道范围修改</NButton></NSpace></NForm></NCard>
    <HandoffAccessSettings v-if="section!=='capabilities'&&beta.enabled.value" :base="base" :disabled="busy||editor!==null" @changed="emit('changed')" @session-expired="emit('sessionExpired')" @busy-changed="v=>{handoffBusy=v;emit('busyChanged',v||busy||editor!==null)}" @dirty-changed="v=>{handoffDirty=v;emit('dirtyChanged',v||webDirty||directoryDirty)}"/>
    <CapabilityPackageList v-if="section!=='access'" :packages="rows" :trigger-options="triggerOptions" :resources="resources" :members="members" :disabled="locked" @create="open()" @edit="open" @toggle="toggle" />
    <CapabilityPackageEditor :handoff-enabled="beta.enabled.value" :handoff-options="handoffOptions" v-if="editor" :show="true" :value="editor" :trigger-options="triggerOptions" :resources="resources" :members="members" :subjects="subjects" :base="base" :busy="busy" :error="error" :notice="notice" @submit="submit" @upload="upload" @close="close" @busy-changed="value=>{editorQueryBusy=value}" />
  </template>
</div>
</template>
<style scoped>
.config-stack { display: grid; gap: 16px; min-width: 0; }
.access-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border: 1px solid var(--subtle); border-radius: 10px; background: var(--surface); }
.access-note { margin: 0; }
.policy-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
@media (max-width: 40rem) { .policy-grid { grid-template-columns: 1fr; } }
</style>
