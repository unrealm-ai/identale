<script setup lang="ts">
import {useWorkItemBeta,workItemWorkspaceBase} from '../work-items/useWorkItemBeta';
import {computed,onUnmounted,ref,watch} from 'vue';
import {NAlert,NButton} from 'naive-ui';
import {api,ApiError,errorMessage} from '../../shared/api';
import type {ConfigMember} from '../../phase2';
import type {DirectorySubjects} from '../directory/types';
import type {EmployeeAccessDraft,EmployeeChannelDraft} from './useEmployeeWizard';
import CapabilityPackageList from './CapabilityPackageList.vue';
import CapabilityPackageEditor from './CapabilityPackageEditor.vue';
import {clonePackage,emptyPackage,packageInput,type PackageEditorValue,type NamedResource} from './capability-package-view';
const props=defineProps<{base:string;disabled:boolean;refreshKey?:number;triggerOptions?:import('./trigger-types').TriggerOption[];channel:EmployeeChannelDraft|null;selfMemberId:string;ownWebUse:boolean}>();
const beta=useWorkItemBeta(()=>props.base,()=>emit('sessionExpired')),handoffOptions=ref<{id:string;name:string;enabled:boolean}[]>([]);
const emit=defineEmits<{change:[draft:EmployeeAccessDraft];busyChanged:[busy:boolean];sessionExpired:[];catalogChanged:[value:{members:ConfigMember[];resources:NamedResource[]}]}>();
const members=ref<ConfigMember[]>([]),resources=ref<NamedResource[]>([]),error=ref(''),loading=ref(false),editorQueryBusy=ref(false);
const packages=ref<(PackageEditorValue&{key:string})[]>([]),editor=ref<PackageEditorValue|null>(null),editingKey=ref<string|null>(null);
const busy=computed(()=>loading.value||editorQueryBusy.value||editor.value!==null);
watch(busy,value=>emit('busyChanged',value),{flush:'sync'});
watch(packages,value=>emit('change',{packages:value.map(packageInput)}),{deep:true});
const subjects=computed<DirectorySubjects>(()=>({sources:props.channel?[props.channel.source]:[],users:[],departments:[]}));
const directoryBase=computed(()=>props.channel?`${props.base}/employee-channel-drafts/${encodeURIComponent(props.channel.draftId)}/directory`:undefined);
watch(()=>props.channel?.draftId,()=>{for(const p of packages.value)p.directoryAccess={allow:[],deny:[]};if(editor.value)editor.value.directoryAccess={allow:[],deny:[]};editorQueryBusy.value=false;});
function edit(key?:string){if(props.disabled||loading.value)return;editingKey.value=key??null;editor.value=key?clonePackage(packages.value.find(p=>p.key===key)!):emptyPackage();}
function save(value:PackageEditorValue){if(props.disabled||loading.value||editorQueryBusy.value)return;const key=editingKey.value??crypto.randomUUID(),row={...clonePackage(value),key};packages.value=editingKey.value?packages.value.map(p=>p.key===key?row:p):[...packages.value,row];editor.value=null;editingKey.value=null;}
function toggle(key:string){if(props.disabled||busy.value)return;packages.value=packages.value.map(p=>p.key===key?{...p,enabled:!p.enabled}:p);}
function remove(key:string){if(props.disabled||busy.value)return;packages.value=packages.value.filter(p=>p.key!==key);}
const controller=new AbortController();
watch(beta.enabled,async enabled=>{if(!enabled)return;try{const value=await api<{entities:{id:string;name:string;enabled?:boolean}[]}>(workItemWorkspaceBase(props.base)+'/entities',controller.signal);handoffOptions.value=value.entities.map(e=>({...e,enabled:e.enabled!==false}));}catch{/* No implicit grants from missing candidates. */}});
async function load(){loading.value=true;error.value='';try{const result=await api<{members:ConfigMember[];resources:NamedResource[]}>(`${props.base}/employee-creation-options`,controller.signal);if(!controller.signal.aborted){members.value=result.members;resources.value=result.resources;emit('catalogChanged',result);}}catch(cause){if(!controller.signal.aborted){error.value=errorMessage(cause);if(cause instanceof ApiError&&cause.status===401)emit('sessionExpired');}}finally{loading.value=false;}}
watch(()=>props.refreshKey,()=>void load());void load();onUnmounted(()=>{controller.abort();emit('busyChanged',false);});
</script>
<template><div class="access-settings"><p class="field-note">使用范围由前一步独立确定。本步仅保存能力包草稿，最后确认创建时统一写入。</p><NAlert v-if="error" type="error" role="alert">{{ error }}<NButton :disabled="disabled||busy" @click="load">重试读取</NButton></NAlert>
 <CapabilityPackageList :packages="packages" :trigger-options="triggerOptions??[]" :resources="resources" :members="members" :disabled="disabled||busy" draft @create="edit()" @edit="edit" @toggle="toggle" @remove="remove" />
 <CapabilityPackageEditor :handoff-enabled="beta.enabled.value" :handoff-options="handoffOptions" v-if="editor" :show="true" :value="editor" :trigger-options="triggerOptions??[]" :resources="resources" :members="members" :subjects="subjects" :base="base" v-bind="directoryBase?{directoryBase}:{}" draft :busy="disabled||loading" @submit="save" @close="editor=null;editingKey=null" @busy-changed="value=>{editorQueryBusy=value}" />
 <p class="field-note">仅关联工作区已有资源；新增或更新 Skill/MCP 请在管理页面完成。</p>
</div></template>
<style scoped>.access-settings{display:grid;gap:1rem}</style>
