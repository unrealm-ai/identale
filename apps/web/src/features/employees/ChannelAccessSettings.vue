<script setup lang="ts">
import {computed,onUnmounted,ref,watch} from 'vue';
import {NAlert,NButton,NCard,NCheckbox,NForm,NRadio,NRadioGroup,NSpace} from 'naive-ui';
import {api,ApiError,errorMessage} from '../../shared/api';
import DirectoryRulePicker from '../directory/DirectoryRulePicker.vue';
import {providerLabel,type ChannelAccessMode,type DirectoryAccess,type DirectoryAccessRule,type DirectoryConnection,type DirectoryIdentityEvidence} from '../directory/types';
const props=defineProps<{base:string;connection:DirectoryConnection;disabled?:boolean;canManage:boolean}>();
const emit=defineEmits<{dirtyChanged:[boolean];busyChanged:[boolean];changed:[];identityVerified:[evidence:DirectoryIdentityEvidence];sessionExpired:[]}>();
const rules=ref<DirectoryAccessRule[]>([]),denied=ref<DirectoryAccessRule[]>([]),allowGroupMembers=ref(false),revision=ref(0),baseline=ref('');
const loaded=ref(false),loading=ref(false),saving=ref(false),queries=ref({allow:false,deny:false}),unknown=ref(false),error=ref(''),notice=ref('');
const mode=ref<ChannelAccessMode>('all');
const wecom=computed(()=>props.connection.provider==='wecom');
const memberSearch=computed(()=>props.connection.directoryMode==='member_search');
const locallyVerified=ref<string[]>([]);
const verifiedUserIds=computed(()=>[...new Set([...(props.connection.memberSearchVerifiedUserIds??[]),...locallyVerified.value])]);
watch(()=>JSON.stringify([props.base,props.connection.id,props.connection.sourceId,props.connection.authRevision]),()=>{locallyVerified.value=[];},{flush:'sync'});
function markIdentityVerified(evidence:DirectoryIdentityEvidence){if(evidence.sourceId!==props.connection.sourceId||evidence.authRevision!==props.connection.authRevision)return;if(!locallyVerified.value.includes(evidence.userId))locallyVerified.value.push(evidence.userId);emit('identityVerified',evidence);emit('changed');}
const unresolvedPeople=computed(()=>[...(mode.value==='allowlist'?rules.value:[]),...denied.value].some(rule=>{
  try{return !verifiedUserIds.value.includes(JSON.parse(rule.subjectId)[3]);}catch{return true;}
}));
const value=()=>({mode:mode.value,allow:rules.value,deny:denied.value,allowGroupMembers:allowGroupMembers.value});
const dirty=computed(()=>loaded.value&&JSON.stringify(value())!==baseline.value),busy=computed(()=>saving.value||queries.value.allow||queries.value.deny);
const locked=computed(()=>!!props.disabled||loading.value||busy.value||unknown.value||!props.canManage);
const available=computed(()=>props.connection.enabled&&(memberSearch.value||props.connection.directoryStatus==='available'&&
  (props.connection.status==='verified'||props.connection.provider==='dingtalk'&&props.connection.status==='pending_verification')));
const restricted=ref(false);
const subjects=computed(()=>({sources:[{...props.connection,memberSearchVerifiedUserIds:verifiedUserIds.value}],users:[] as never[],departments:[] as never[]}));
let controller=new AbortController(),generation=0;
function apply(policy:DirectoryAccess,keep=false){
  const channel=policy.channelPolicies?.find(p=>p.sourceId===props.connection.sourceId);
  const selected=channel?.allow??policy.allow.filter(r=>r.sourceId===props.connection.sourceId),blocked=channel?.deny??policy.deny.filter(r=>r.sourceId===props.connection.sourceId);
  // The server projects legacy rules. The fallback preserves old responses without opening access.
  const next={mode:channel?.mode??(wecom.value?'all':'allowlist'),allow:selected,deny:blocked,allowGroupMembers:channel?.allowGroupMembers??(!wecom.value&&policy.allowGroupMembers===true)};
  const same=JSON.stringify(value())===JSON.stringify(next);revision.value=channel?.revision??(wecom.value?0:policy.revision);baseline.value=JSON.stringify(next);loaded.value=true;
  restricted.value=[...selected,...blocked].some(r=>r.conversationKinds.length!==2||!r.conversationKinds.includes('private')||!r.conversationKinds.includes('group'));
  if(!keep||same){rules.value=selected;denied.value=blocked;mode.value=next.mode;allowGroupMembers.value=next.allowGroupMembers;}
  else notice.value='已读取服务器配置，你的修改已保留，请核对后保存。';
}
async function load(){
  if(loading.value||busy.value)return;const signal=controller.signal,current=generation,keep=dirty.value;loading.value=true;error.value='';notice.value='';
  try{const result=await api<DirectoryAccess>(props.base+'/directory-access',signal);if(signal.aborted||current!==generation)return;apply(result,keep);unknown.value=false;}
  catch(cause){if(!signal.aborted&&current===generation){error.value=errorMessage(cause);if(cause instanceof ApiError&&cause.status===401)emit('sessionExpired');}}
  finally{if(current===generation)loading.value=false;}
}
function cancel(){if(loading.value||busy.value||unknown.value||!baseline.value)return;const old=JSON.parse(baseline.value);mode.value=old.mode??'all';rules.value=old.allow;denied.value=old.deny??[];allowGroupMembers.value=old.allowGroupMembers;error.value='';notice.value='';}
defineExpose({cancel});
async function save(){
  if(!loaded.value||locked.value||!dirty.value)return;const signal=controller.signal,current=generation;
  const body=JSON.parse(JSON.stringify({sourceId:props.connection.sourceId,...value(),expectedRevision:revision.value}));
  saving.value=true;error.value='';notice.value='';
  try{const result=await api<DirectoryAccess>(props.base+'/directory-access',signal,body,'PATCH');if(signal.aborted||current!==generation)return;apply(result);notice.value='已保存。';emit('changed');}
  catch(cause){if(!signal.aborted&&current===generation){unknown.value=!(cause instanceof ApiError)||cause.status>=500;error.value=errorMessage(cause);if(cause instanceof ApiError&&cause.status===401)emit('sessionExpired');}}
  finally{if(current===generation)saving.value=false;}
}
watch(dirty,v=>emit('dirtyChanged',v),{flush:'sync'});watch(busy,v=>emit('busyChanged',v),{flush:'sync'});
watch(()=>JSON.stringify([props.base,props.connection.sourceId]),()=>{generation++;controller.abort();controller=new AbortController();mode.value='all';rules.value=[];denied.value=[];allowGroupMembers.value=false;revision.value=0;baseline.value='';loaded.value=false;loading.value=false;saving.value=false;queries.value={allow:false,deny:false};unknown.value=false;error.value='';notice.value='';void load();},{immediate:true});
onUnmounted(()=>{generation++;controller.abort();emit('dirtyChanged',false);emit('busyChanged',false);});
</script>
<template>
<NCard class="channel-access-settings" :title="providerLabel(connection.provider)+'使用范围'" size="small" :aria-label="providerLabel(connection.provider)+'使用范围'">
  <p v-if="loading" role="status">正在读取本渠道使用范围…</p><NAlert v-if="error" type="error" role="alert">{{error}}</NAlert><NAlert v-if="notice" type="success" role="status">{{notice}}</NAlert>
  <NAlert v-if="unknown" type="warning">保存结果尚未确认，请先读取服务器配置核对。</NAlert>
  <template v-if="loaded"><p class="field-note">{{ wecom?'本范围仅适用于能向本机器人发送有效消息的使用者，不代表公司全量员工，也不按内外部联系人身份排除。':'选择可在本渠道使用员工的人员和部门。' }}</p>
    <NAlert v-if="mode!=='allowlist'" type="info">允许全部有效消息使用者，黑名单除外；无需先搜索成员或匹配白名单。</NAlert>
    <NAlert v-if="wecom && unresolvedPeople" type="info">名单中仍有人员身份待核验，请完成身份绑定。</NAlert>
    <NAlert v-if="!available" type="info">当前连接的目录不可用，暂不能新增人员或部门；已有规则保留，可移除。</NAlert><NAlert v-if="restricted" type="warning">已配置额外使用限制，仍会生效。本次保存不会改写已有会话范围。</NAlert>
    <NForm class="directory-access-form" @submit.prevent="save">
      <NRadioGroup :value="mode==='allowlist'?'allowlist':'denylist'" @update:value="v=>mode=v as ChannelAccessMode" :disabled="locked" :aria-label="providerLabel(connection.provider)+'使用范围模式'"><NSpace><NRadio value="allowlist">白名单</NRadio><NRadio value="denylist">全员 + 黑名单</NRadio></NSpace></NRadioGroup>
      <p class="field-note">新建数字员工首次接入默认全员 + 空黑名单；换绑或解绑后重新接入默认空白名单。切换模式保留两份名单；白名单仅在白名单模式生效，黑名单始终优先。</p>
      <div class="group-use"><NCheckbox v-model:checked="allowGroupMembers" :disabled="locked" aria-label="允许群成员在群内使用">允许群成员在群内使用</NCheckbox><p class="field-note">新建默认打开。群成员可在机器人所在群内按本渠道支持的触发方式使用，不授予私聊或网页使用权；黑名单始终优先。此开关不控制群消息上下文或内容共享。</p></div>
      <DirectoryRulePicker v-if="mode==='allowlist'" employee-scope fixed-source v-model:rules="rules" :subjects="subjects" hide-unavailable-notice :base="base" :label="memberSearch?'允许成员':'允许渠道用户或部门'" :disabled="locked" :readonly="!canManage" @identity-verified="markIdentityVerified" @busy-changed="v=>queries.allow=v" />
      <h4>黑名单（始终优先）</h4>
      <DirectoryRulePicker employee-scope fixed-source v-model:rules="denied" :subjects="subjects" hide-unavailable-notice :base="base" :label="memberSearch?'拒绝成员':'拒绝渠道用户或部门'" :disabled="locked" :readonly="!canManage" @identity-verified="markIdentityVerified" @busy-changed="v=>queries.deny=v" />
      <NSpace v-if="canManage" class="policy-actions"><NButton type="primary" attr-type="submit" aria-label="保存渠道使用策略" :disabled="locked||!dirty" :loading="saving">保存使用范围</NButton><NButton aria-label="取消渠道范围修改" :disabled="locked||!dirty" @click="cancel">取消范围修改</NButton><NButton :disabled="loading||busy" @click="load">读取服务器配置并核对</NButton></NSpace>
    </NForm>
  </template><NButton v-else-if="!loading" @click="load">重新读取渠道范围</NButton>
</NCard>
</template>
<style scoped>.channel-access-settings{min-width:0}.channel-access-settings :deep(.n-alert){margin-bottom:.75rem}.group-use,.policy-actions{margin:1rem 0}.channel-access-settings .field-note{line-height:1.6}</style>
