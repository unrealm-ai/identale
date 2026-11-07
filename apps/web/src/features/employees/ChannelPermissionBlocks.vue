<script setup lang="ts">
import { computed } from 'vue';
import { NTag } from 'naive-ui';
import type { DirectoryProvider } from '../directory/types';
import type { ChannelValidation } from './channel-validation';
import {checkTone,permissionState,scopeState,tagTone,type ValidationTone} from './channel-validation-state';
const props = defineProps<{ provider: DirectoryProvider; report?: ChannelValidation | null }>();
interface PermissionBlock { id:'directory'|'group'|'meeting';title:string;required:boolean;purpose:string;groups:{title:string;codes:string[]}[];requirements?:string[][] }
const blocks:PermissionBlock[] = [
  { id: 'directory', title: '通讯录权限', required: true, purpose: '用于读取可见人员、部门和真实姓名，选择谁可以使用数字员工。', groups: [
    { title: '按实际接口补充；已有广义权限覆盖时无需重复申请这些细粒度项。', codes: ['tenant:tenant:readonly', 'contact:user.base:readonly', 'contact:user.department:readonly', 'contact:department.base:readonly', 'contact:department.organize:readonly'] },
  ] },
  { id: 'group', title: '群上下文权限', required: false, purpose: '按需读取机器人所在群的历史讨论，补充未 @机器人的上下文。', groups: [
    { title: '基础消息读取：以下满足任一（OR），不要求同时申请。', codes: ['im:message:readonly', 'im:message', 'im:message.history:readonly'] },
    { title: '读取群历史还需此项，并确保机器人已在目标群中。', codes: ['im:message.group_msg'] },
  ],requirements:[['im:message:readonly','im:message','im:message.history:readonly'],['im:message.group_msg']] },
  { id: 'meeting', title: '会议材料权限', required: false, purpose: '按需读取明确指定的妙记逐字稿或现有纪要，不会自动生成或发现会议材料。', groups: [
    { title: '逐字稿与现有纪要分别检查；授权不代表材料已读取。', codes: ['minutes:minutes.transcript:export', 'minutes:minutes.artifacts:read'] },
  ],requirements:[['minutes:minutes.transcript:export'],['minutes:minutes.artifacts:read']] },
];
const matching = computed(() => props.report?.provider === props.provider ? props.report : undefined);
const evidence = computed(() => matching.value?.checks ?? []);
function state(code:string) { return scopeState(evidence.value,code); }
const scopeTone=(code:string):ValidationTone=>!matching.value?'idle':state(code)==='granted'?'success':'warning';
const scopeLabel=(code:string)=>!matching.value?'待校验':state(code)==='granted'?'已授权':state(code)==='denied'?'未授权':'未核验';
function result(block:PermissionBlock):{tone:ValidationTone;label:string}{
  if(!matching.value)return{tone:'idle',label:'待校验'};
  if(block.id==='directory'){
    const ids=['directory_identity','directory_scope','user_name'];
    const department=evidence.value.find(c=>c.id==='department_read');if(department?.required)ids.push('department_read');
    const passed=ids.every(id=>checkTone(evidence.value.find(c=>c.id===id))==='success');
    return{tone:passed?'success':'error',label:passed?'必要读取已验证':'必要读取未确认'};
  }
  if(props.provider!=='feishu')return{tone:'warning',label:'当前不支持'};
  const resource=evidence.value.find(c=>c.id===(block.id==='group'?'group_history':'meeting_materials'));
  if(resource&&checkTone(resource)==='success')return{tone:'success',label:'资源读取已验证'};
  const status=permissionState(evidence.value,block.requirements!);
  return{tone:status==='pass'?'success':'warning',label:status==='pass'?'权限已授权':status==='missing'?'存在未授权项':'权限待核验'};
}
</script>
<template>
  <div class="channel-permission-blocks" aria-label="按功能配置权限">
    <section v-for="block in blocks" :key="block.id" class="permission-block channel-status-block" :data-capability="block.id" :data-tone="result(block).tone">
      <h4>{{ block.title }} <span class="category">{{ block.required ? '必需' : '可选' }}</span><NTag size="small" :type="tagTone(result(block).tone)" :data-tone="result(block).tone">{{ result(block).label }}</NTag></h4>
      <p>{{ block.purpose }}</p>
      <p v-if="!block.required && result(block).label === '权限已授权'">权限授权已确认；具体群或会议材料的读取尚未验证，以资源读取检查为准。</p>
      <details v-if="provider === 'feishu'"><summary>查看权限码与核验依据</summary>
        <div v-for="group in block.groups" :key="group.title" class="permission-code-group"><p>{{ group.title }}</p><ul><li v-for="code in group.codes" :key="code"><code>{{ code }}</code><NTag size="small" :type="tagTone(scopeTone(code))" :data-scope="code" :data-tone="scopeTone(code)">{{ scopeLabel(code) }}</NTag></li></ul></div>
      </details>
      <p v-else>{{ block.required ? '在当前渠道后台配置目录读取、可见范围和必要字段；当前接入未提供可核验的完整权限码清单，不套用其他平台的权限码。' : '当前渠道接入不支持此能力，无需申请额外权限。' }}</p>
    </section>
    <p class="permission-evidence-note">权限码为配置参考；状态仅依据本次应用身份验证结果，用户身份授权不代替应用身份。未核验不等于缺权限，必要能力仍以实际读取及数据范围校验为准。</p>
  </div>
</template>
<style scoped>
.channel-permission-blocks { display:grid; gap:0.75rem; margin:1rem 0; }.permission-block h4 { display:flex; align-items:center; gap:0.625rem; flex-wrap:wrap; margin:0 0 0.5rem; }.category { font-size:0.875rem; font-weight:400; color:var(--muted); }.permission-block p,.permission-evidence-note { margin:0.375rem 0; color:var(--muted); line-height:1.7; }.permission-code-group ul { margin:0.5rem 0; padding:0; list-style:none; }.permission-code-group li { display:flex; gap:0.75rem; align-items:baseline; justify-content:space-between; margin:0.4375rem 0; flex-wrap:wrap; }.permission-code-group code { overflow-wrap:anywhere; font-size:0.75rem; }.permission-evidence-note { font-size:0.875rem; }
</style>
