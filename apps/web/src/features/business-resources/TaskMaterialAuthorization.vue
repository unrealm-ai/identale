<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { NButton, NTag } from 'naive-ui';
import { api, ApiError } from '../../shared/api';
import {resourceKind,type BusinessMaterial as Material,type BusinessResourceConfiguration} from './types';
const props=defineProps<{taskId:string;runId:string|null}>();
const emit=defineEmits<{sessionExpired:[]}>();
const materials=ref<{taskId:string;runId:string|null;items:Material[]}|null>(null),supported=ref<string[]>([]),busy=ref(false),error=ref('');
const showOAuth=ref(false);
const readLabels:Record<string,string>={ready:'已预下载',pending:'资料生成或准备中',no_permission:'读取权限不足',not_available:'资料暂不可用或当前未支持',failed:'读取失败',unknown:'尚无准备结果'};
const reasonLabels:Record<string,string>={provider_permission_denied:'上游拒绝访问；具体 API 权限或对象访问原因尚未确认',business_resource_authorization_required:'应用 API 权限或具体资料访问权尚未确认，不能据此区分缺少哪一项',wecom_application_resource_unverified:'企微应用资料读取协议尚未核验',business_snapshot_expired:'准备结果已过期，需要在获准读取时重新检查'};
const readReason=(value:string)=>reasonLabels[value]??value;
const link=ref<{assetId:string;url:string;expiresAt:number}|null>(null);
let controller=new AbortController(),generation=0;
function report(cause:unknown){error.value=cause instanceof ApiError&&cause.status===403?'当前账号没有管理此任务材料授权的权限，或可信来源上下文已失效。':'暂时无法确认材料授权状态，请重试。';if(cause instanceof ApiError&&cause.status===401)emit('sessionExpired');}
async function load(){
 if(busy.value)return;const expected=generation,signal=controller.signal;busy.value=true;error.value='';link.value=null;showOAuth.value=false;
 try{
  const [result,config]=await Promise.all([api<{taskId:string;runId:string|null;items:Material[]}>(`/business-resources/materials?${new URLSearchParams({taskId:props.taskId})}`,signal),api<BusinessResourceConfiguration>('/business-resources/configuration',signal)]);
  if(signal.aborted||expected!==generation)return;
  if(result.taskId!==props.taskId||result.runId!==props.runId){materials.value=null;error.value='任务运行记录已变化，或正在查看历史执行段。请切换到当前运行并重新查看材料。';return;}
  materials.value=result;supported.value=config.configured?config.providers?.find(item=>item.provider==='feishu')?.supportedResources??[]:[];
 }catch(cause){if(!signal.aborted&&expected===generation){materials.value=null;report(cause);}}finally{if(expected===generation)busy.value=false;}
}
async function authorize(item:Material){
 const runId=materials.value?.runId;if(!showOAuth.value||busy.value||!runId||runId!==props.runId||item.provider!=='feishu'||!supported.value.includes(item.kind))return;
 const expected=generation,signal=controller.signal;busy.value=true;error.value='';link.value=null;
 try{
  const result=await api<{authorizationUrl:string;expiresAt:number}>('/business-resources/feishu/authorize',signal,{assetId:item.assetId,runId});
  if(signal.aborted||expected!==generation)return;
  const url=new URL(result.authorizationUrl);
  if(url.protocol!=='https:'||url.hostname!=='accounts.feishu.cn'||url.port||url.username||url.password||url.pathname!=='/open-apis/authen/v1/authorize'||!Number.isFinite(result.expiresAt)||result.expiresAt<=Date.now())throw Error('invalid_authorization_link');
  link.value={assetId:item.assetId,url:url.toString(),expiresAt:result.expiresAt};
 }catch(cause){if(!signal.aborted&&expected===generation)report(cause);}finally{if(expected===generation)busy.value=false;}
}
function openLink(event:MouseEvent){if(!link.value||link.value.expiresAt<=Date.now()){event.preventDefault();link.value=null;error.value='授权链接已过期，请重新准备授权。';}}
watch(()=>[props.taskId,props.runId],()=>{controller.abort();controller=new AbortController();generation++;showOAuth.value=false;materials.value=null;link.value=null;supported.value=[];busy.value=false;error.value='';});
onUnmounted(()=>{controller.abort();generation++;});
</script>
<template>
 <section class="task-material-auth" aria-label="任务材料读取状态">
  <div class="material-header"><h3>任务材料</h3><NButton size="small" :loading="busy" :disabled="busy||!runId" @click="load">{{materials?'刷新材料准备状态':'查看任务材料'}}</NButton></div>
  <p class="field-note">优先使用应用身份读取当前运行中明确提供的资料。以下仅为已保存的预下载结果，刷新不会重新读取资料，也不代表当前权限复验通过。</p>
  <p v-if="error" role="alert">{{error}}</p>
  <p v-if="materials&&!materials.items.length" class="field-note">当前运行没有绑定的来源消息材料。</p>
  <ul v-if="materials" class="material-items"><li v-for="item in materials.items" :key="item.assetId"><strong>{{item.name||resourceKind(item.kind)}}</strong><NTag size="small">{{item.accessMode==='application'?'应用身份读取':'读取身份尚未声明'}}</NTag>
    <div v-if="item.reads?.length" class="material-reads"><p v-for="read in item.reads" :key="read.kind"><strong>{{resourceKind(read.kind)}}：</strong>{{readLabels[read.state]??'尚未核验'}}<span v-if="read.reason"> · {{readReason(read.reason)}}</span></p></div><p v-else class="field-note">尚无持久化的材料准备结果。</p>
    <template v-if="showOAuth"><NTag size="small">{{item.authorizationState==='authorized'?'可选用户身份已授权':item.authorizationState==='authorization_required'?'可选用户身份需要授权':'可选用户身份尚未核验'}}</NTag>
      <NButton v-if="item.authorizationState!=='authorized'&&item.provider==='feishu'&&supported.includes(item.kind)" size="small" :disabled="busy" @click="authorize(item)">准备飞书账号授权</NButton>
      <p v-else-if="item.authorizationState!=='authorized'" class="field-note">此资料没有已配置的可选个人授权入口；不影响应用身份按其自身权限读取。</p>
      <template v-if="link?.assetId===item.assetId"><a :href="link.url" target="_blank" rel="noopener noreferrer" @click="openLink">前往飞书官方页面授权 ↗</a><p class="field-note">此可选路径核对原消息发送人的账号。链接有效至 {{new Date(link.expiresAt).toLocaleString('zh-CN')}}；完成后返回刷新状态，不自动执行任务。</p></template>
    </template>
  </li></ul>
  <NButton v-if="materials&&supported.length" size="small" :disabled="busy" @click="showOAuth=!showOAuth;link=null">{{showOAuth?'收起可选个人授权':'查看可选个人授权（非必需）'}}</NButton>
  <p v-if="showOAuth" class="field-note">个人 OAuth 是主动选择的可选路径，不是应用读取失败后的自动回退。账号授权不代表资料读取成功。</p>
  <p class="field-note">不会自动重跑任务或补发消息。群内资料仅在原群回复，私聊仅原私聊，不授权转发到其他会话。</p>
 </section>
</template>
<style scoped>
.task-material-auth{display:grid;gap:12px;padding:16px 0;border-top:1px solid var(--subtle)}.material-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.material-header h3,.task-material-auth p{margin:0}.material-items{list-style:none;padding:0;margin:0;display:grid;gap:12px}.material-items li{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.material-items p{width:100%}
</style>
