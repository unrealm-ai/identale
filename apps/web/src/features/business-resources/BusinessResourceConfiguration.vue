<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { NButton, NTag } from 'naive-ui';
import { api, ApiError } from '../../shared/api';
import type { DirectoryProvider } from '../directory/types';
import {resourceKind,type BusinessResourceConfiguration as Configuration} from './types';
const props=defineProps<{provider:DirectoryProvider}>();
const emit=defineEmits<{sessionExpired:[]}>();
const configuration=ref<Configuration|null>(null),busy=ref(false),failed=ref(false);
const controller=new AbortController();
const selected=computed(()=>configuration.value?.providers?.find(item=>item.provider===props.provider));
const application=computed(()=>configuration.value?.application?.providers.find(item=>item.provider===props.provider));
const reasons:Record<string,string>={business_oauth_not_configured:'现有可选用户 OAuth 原型未启用；三家授权方案待研究确认，暂不需要部署或登录此原型。',verified_user_oauth_mapping_required:'现有用户 OAuth 原型中的钉钉可信身份关联尚未接通；不代表钉钉只支持此授权路线。',verified_human_identity_contract_required:'现有用户 OAuth 原型中的企微身份验证尚未接通；不代表企微只支持此授权路线。'};
const reason=(value:string)=>reasons[value]??value;
const limitations:Record<string,string>={provider_scope_and_resource_acl_required:'应用 API 权限与具体对象访问权必须分别满足。',meeting_metadata_scopes_not_fully_verified:'会议卡片涉及的会议、录制和笔记 API 权限仍需按官方后台和实际接口核验。',unified_note_transcript_user_only:'统一纪要逐字稿接口仅支持用户身份，本应用身份路径不开放，也不会自动切换用户。',exact_meeting_instance_required:'会议读取需要明确的具体会议实例，不能仅凭会议号猜测场次。',verified_operator_required:'钉钉读取需要从可信消息发送人解析 operator；不能手填或由模型指定。',meeting_transcript_only:'钉钉会议当前仅接入云录制逐字稿。',ai_minutes_unsupported:'AI 听记不在当前应用身份接入范围。',wecom_application_resource_unverified:'企微应用资料读取接口契约尚未核验；当前不可用不代表厂商全局不支持。'};
async function load(){
 if(busy.value)return;busy.value=true;failed.value=false;configuration.value=null;
 try{const value=await api<Configuration>('/business-resources/configuration',controller.signal);if(!controller.signal.aborted)configuration.value=value;}
 catch(error){if(!controller.signal.aborted){failed.value=true;if(error instanceof ApiError&&error.status===401)emit('sessionExpired');}}
 finally{if(!controller.signal.aborted)busy.value=false;}
}
onMounted(load);onUnmounted(()=>controller.abort());
</script>
<template>
 <section class="business-configuration" aria-label="业务资料应用读取状态">
  <div class="configuration-title"><h4>应用身份读取</h4><NButton size="small" :loading="busy" :disabled="busy" @click="load">刷新资料读取配置</NButton></div>
  <p v-if="busy" role="status">正在读取服务端资料读取配置。</p>
  <p v-else-if="failed" role="status">暂时无法读取配置，请稍后重试；不能据此判断资料已授权。</p>
  <template v-else-if="configuration">
   <NTag size="small">{{application?.availability==='available'?'应用读取适配已接入':application?.availability==='unsupported'?'当前应用读取未支持':'应用读取尚未核验'}}</NTag>
   <p v-if="application?.supportedResources.length" class="field-note">适配资料类型：{{application.supportedResources.map(resourceKind).join('、')}}</p>
   <p v-if="application?.appScopes.length" class="field-note">所需应用 API 权限：{{application.appScopes.join('、')}}。此处为权限要求，不表示当前应用已获授权。</p>
   <p class="field-note">具体资料访问权（对象 ACL）在读取该资料时单独核验。适配已接入只代表实现可以请求，不代表 API 权限、对象访问权或资料已生成。</p>
   <p v-for="limitation in application?.limitations??[]" :key="limitation" class="field-note">{{limitations[limitation]??'此读取路径还有尚未核验的限制，请结合官方权限要求与实际读取结果确认。'}}</p>
   <details v-if="configuration.configured" class="optional-oauth"><summary>可选个人 OAuth 原型（非前置条件）</summary>
    <p class="field-note">仅供主动选择的独立用户身份路径；应用读取失败不会自动切换到个人身份。</p>
    <p v-if="configuration.redirectUri" class="field-note">原型回调 URL（仅状态展示）：<span class="callback-uri">{{configuration.redirectUri}}</span></p>
    <p v-if="selected?.scopes?.length" class="field-note">原型声明的只读权限：{{selected.scopes.join('、')}}</p>
    <p v-if="selected?.reason" class="field-note">{{reason(selected.reason)}}</p>
    <p v-for="blocker in [...(configuration.blockers??[]),...(selected?.blockers??[])]" :key="blocker" class="field-note">{{reason(blocker)}}</p>
    <p class="field-note">原型已配置不代表账号已授权，也不替代应用权限和资料访问检查。</p>
   </details>
  </template>
  <p class="field-note">用户在会话中明确提供资料后，由运行层使用应用身份读取并预下载。个人账号登录不是前置条件；无权限、生成中或未支持会分别报告，不自动切换其他身份。</p>
  <p class="field-note">群内分享的资料仅在原群回复，私聊仅原私聊；不授权转发到其他群或会话，不自动恢复任务执行。</p>
 </section>
</template>
<style scoped>
.business-configuration{display:grid;gap:10px;border-top:1px solid var(--subtle);padding-top:12px}.configuration-title{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.configuration-title h4,.business-configuration p{margin:0}.callback-uri{overflow-wrap:anywhere}
</style>
