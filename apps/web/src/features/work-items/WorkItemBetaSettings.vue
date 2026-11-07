<script setup lang="ts">
import{computed,onUnmounted,ref,watch}from'vue';
import{NAlert,NButton,NCard,NSpace,NTag}from'naive-ui';
import{api,ApiError,errorMessage,type Workspace}from'../../shared/api';
import InfoHint from '../../shared/ui/InfoHint.vue';
import{useWorkItemBeta}from'./useWorkItemBeta';
const props=defineProps<{workspace:Workspace}>(),emit=defineEmits<{busyChanged:[boolean];sessionExpired:[]}>(),base=()=>'/workspaces/'+encodeURIComponent(props.workspace.id),beta=useWorkItemBeta(base,()=>emit('sessionExpired'));
const busy=ref(false),error=ref(''),uncertain=ref(false),admin=computed(()=>['owner','admin'].includes(props.workspace.role));let controller=new AbortController();
let generation=0;
watch(()=>props.workspace.id,()=>{generation++;controller.abort();controller=new AbortController();busy.value=false;error.value='';uncertain.value=false;emit('busyChanged',false);},{flush:'sync'});
async function change(){
 if(!admin.value||busy.value||beta.pending.value||!beta.state.value.effective.available||uncertain.value)return;
 const version=generation,path=base(),signal=controller.signal,current=()=>version===generation&&!signal.aborted;
 busy.value=true;emit('busyChanged',true);error.value='';
 try{
  const target=!beta.state.value.effective.enabled,result=await api<{configured:{revision:number}}>(path+'/work-items/settings',signal,{expectedRevision:beta.state.value.configured.revision,enabled:target},'PUT');
  if(!current())return;
  for(let n=0;n<15;n++){await beta.refresh();if(!current())return;if((beta.state.value.effective.appliedRevision??0)>=result.configured.revision)break;await new Promise(r=>setTimeout(r,200));}
  if(beta.state.value.effective.error)error.value=beta.state.value.effective.error==='work_item_launch_gate_unavailable'?'尚未确认执行侧派发开关，请核对运行状态。':beta.state.value.effective.error;
  window.dispatchEvent(new Event('identity:work-items-beta-changed'));
 }catch(e){if(current()){error.value=errorMessage(e);uncertain.value=!(e instanceof ApiError)||e.status>=500;if(e instanceof ApiError&&e.status===401)emit('sessionExpired');}}
 finally{if(current()){busy.value=false;emit('busyChanged',false);}}
}
async function reconcile(){const version=generation;await beta.refresh();if(version===generation&&beta.state.value.effective.available)uncertain.value=false;}
onUnmounted(()=>{generation++;controller.abort();emit('busyChanged',false);});

</script>
<template><NCard title="事项协作 Beta" size="small" class="work-item-beta"><template #header-extra><InfoHint text="开启后，同工作区启用员工可直接交接事项；能力包的交接白黑名单独立生效。成员可见业务投影，不因此获得原私聊、群历史或文件权限。关闭后，新任务不再获得事项工具，下一交接等待派发；当前任务、人工确认和结束回告继续。重新开启后恢复待派发交接。" label="事项协作 Beta说明"/></template><NAlert v-if="error" type="error" role="alert">{{error}}</NAlert><NSpace align="center" justify="space-between"><NSpace align="center"><NTag :type="beta.enabled.value?'success':'default'">{{beta.enabled.value?'已开启':'未开启'}}</NTag><span v-if="beta.pending.value">等待运行侧应用</span><span v-else-if="!beta.state.value.effective.available">运行状态暂不可确认</span></NSpace><NButton v-if="admin" :loading="busy" :disabled="busy||beta.pending.value||beta.loading.value||!beta.state.value.effective.available||uncertain" @click="change">{{beta.state.value.effective.enabled?'关闭事项 Beta':'开启事项 Beta'}}</NButton></NSpace><NButton v-if="uncertain||!beta.state.value.effective.available" text @click="reconcile">核对运行状态</NButton><p v-if="!admin" class="field-note">工作区管理员可修改此设置。</p></NCard></template>
<style scoped>.work-item-beta{max-width:56rem;margin-top:1rem}.work-item-beta :deep(.n-alert){margin-bottom:1rem}.field-note{color:var(--id-text-secondary)}</style>
