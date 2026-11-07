<script setup lang="ts">
import {computed,onUnmounted,ref,watch} from 'vue';
import {NAlert,NButton,NCard,NCheckbox,NForm,NSpace} from 'naive-ui';
import {api,ApiError,errorMessage} from '../../shared/api';
import DirectoryRulePicker from '../directory/DirectoryRulePicker.vue';
import {providerLabel,type DirectoryAccess,type DirectoryAccessRule,type DirectoryConnection} from '../directory/types';
const props=defineProps<{base:string;connection:DirectoryConnection;disabled?:boolean;canManage:boolean}>();
const emit=defineEmits<{dirtyChanged:[boolean];busyChanged:[boolean];changed:[];sessionExpired:[]}>();
const rules=ref<DirectoryAccessRule[]>([]),allowGroupMembers=ref(false),revision=ref(0),baseline=ref('');
const loaded=ref(false),loading=ref(false),saving=ref(false),queryBusy=ref(false),unknown=ref(false),error=ref(''),notice=ref('');
const value=()=>({allow:rules.value,allowGroupMembers:allowGroupMembers.value});
const dirty=computed(()=>loaded.value&&JSON.stringify(value())!==baseline.value),busy=computed(()=>saving.value||queryBusy.value);
const locked=computed(()=>!!props.disabled||loading.value||busy.value||unknown.value||!props.canManage);
const available=computed(()=>props.connection.enabled&&props.connection.status==='verified'&&props.connection.directoryStatus==='available');
const restricted=ref(false);
const subjects=computed(()=>({sources:[props.connection],users:[] as never[],departments:[] as never[]}));
let controller=new AbortController(),generation=0;
function apply(policy:DirectoryAccess,keep=false){
  const selected=policy.allow.filter(r=>r.sourceId===props.connection.sourceId),next={allow:selected,allowGroupMembers:policy.allowGroupMembers===true};
  const same=JSON.stringify(value())===JSON.stringify(next);revision.value=policy.revision;baseline.value=JSON.stringify(next);loaded.value=true;
  restricted.value=policy.deny.some(r=>r.sourceId===props.connection.sourceId)||selected.some(r=>r.conversationKinds.length!==2||!r.conversationKinds.includes('private')||!r.conversationKinds.includes('group'));
  if(!keep||same){rules.value=selected;allowGroupMembers.value=next.allowGroupMembers;}
  else notice.value='已读取服务器配置，你的修改已保留，请核对后保存。';
}
async function load(){
  if(loading.value||busy.value)return;const signal=controller.signal,current=generation,keep=dirty.value;loading.value=true;error.value='';notice.value='';
  try{const result=await api<DirectoryAccess>(props.base+'/directory-access',signal);if(signal.aborted||current!==generation)return;apply(result,keep);unknown.value=false;}
  catch(cause){if(!signal.aborted&&current===generation){error.value=errorMessage(cause);if(cause instanceof ApiError&&cause.status===401)emit('sessionExpired');}}
  finally{if(current===generation)loading.value=false;}
}
function cancel(){if(loading.value||busy.value||unknown.value||!baseline.value)return;const old=JSON.parse(baseline.value);rules.value=old.allow;allowGroupMembers.value=old.allowGroupMembers;error.value='';notice.value='';}
defineExpose({cancel});
async function save(){
  if(!loaded.value||locked.value||!dirty.value)return;const signal=controller.signal,current=generation;
  const body=JSON.parse(JSON.stringify({sourceId:props.connection.sourceId,allow:rules.value,expectedRevision:revision.value,allowGroupMembers:allowGroupMembers.value}));
  saving.value=true;error.value='';notice.value='';
  try{const result=await api<DirectoryAccess>(props.base+'/directory-access',signal,body,'PATCH');if(signal.aborted||current!==generation)return;apply(result);notice.value='已保存。';emit('changed');}
  catch(cause){if(!signal.aborted&&current===generation){unknown.value=!(cause instanceof ApiError)||cause.status>=500;error.value=errorMessage(cause);if(cause instanceof ApiError&&cause.status===401)emit('sessionExpired');}}
  finally{if(current===generation)saving.value=false;}
}
watch(dirty,v=>emit('dirtyChanged',v),{flush:'sync'});watch(saving,v=>emit('busyChanged',v),{flush:'sync'});
watch(()=>[props.base,props.connection.sourceId],()=>{generation++;controller.abort();controller=new AbortController();rules.value=[];allowGroupMembers.value=false;revision.value=0;baseline.value='';loaded.value=false;loading.value=false;saving.value=false;queryBusy.value=false;unknown.value=false;error.value='';notice.value='';void load();},{immediate:true});
onUnmounted(()=>{generation++;controller.abort();emit('dirtyChanged',false);emit('busyChanged',false);});
</script>
<template>
<NCard class="channel-access-settings" :title="providerLabel(connection.provider)+'使用范围'" size="small" :aria-label="providerLabel(connection.provider)+'使用范围'">
  <p v-if="loading" role="status">正在读取本渠道使用范围…</p><NAlert v-if="error" type="error" role="alert">{{error}}</NAlert><NAlert v-if="notice" type="success" role="status">{{notice}}</NAlert>
  <NAlert v-if="unknown" type="warning">保存结果尚未确认，请先读取服务器配置核对。</NAlert>
  <template v-if="loaded"><p class="field-note">选择可在本渠道使用员工的人员和部门。</p>
    <NAlert v-if="!available" type="info">当前连接的目录不可用，暂不能新增人员或部门；已有规则保留，可移除。</NAlert><NAlert v-if="restricted" type="warning">已配置额外使用限制，仍会生效。本次保存不会移除拒绝规则或改写已有会话范围。</NAlert>
    <NForm class="directory-access-form" @submit.prevent="save">
      <div class="group-use"><NCheckbox v-model:checked="allowGroupMembers" :disabled="locked" aria-label="允许群成员在群内使用">允许群成员在群内使用</NCheckbox><p class="field-note">仅在机器人所在群内可用，不授予私聊或网页使用权；拒绝规则仍优先。</p></div>
      <DirectoryRulePicker employee-scope fixed-source v-model:rules="rules" :subjects="subjects" hide-unavailable-notice :base="base" label="允许渠道用户或部门" :disabled="locked" :readonly="!canManage" @busy-changed="v=>queryBusy=v" />
      <NSpace v-if="canManage" class="policy-actions"><NButton type="primary" attr-type="submit" aria-label="保存渠道使用策略" :disabled="locked||!dirty" :loading="saving">保存使用范围</NButton><NButton aria-label="取消渠道范围修改" :disabled="locked||!dirty" @click="cancel">取消范围修改</NButton><NButton :disabled="loading||busy" @click="load">读取服务器配置并核对</NButton></NSpace>
    </NForm>
  </template><NButton v-else-if="!loading" @click="load">重新读取渠道范围</NButton>
</NCard>
</template>
<style scoped>.channel-access-settings{min-width:0}.channel-access-settings :deep(.n-alert){margin-bottom:.75rem}.group-use,.policy-actions{margin:1rem 0}.channel-access-settings .field-note{line-height:1.6}</style>
