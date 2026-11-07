<script setup lang="ts">
import {ref,watch} from 'vue';
import {NRadioGroup,NRadio} from 'naive-ui';
import type {EmployeeChannelDraft} from './useEmployeeWizard';
import type {DirectoryAccessRule} from '../directory/types';
const props=defineProps<{base:string;disabled:boolean;channel:EmployeeChannelDraft|null;selfMemberId:string}>();
const emit=defineEmits<{change:[value:{webAccess:{allowMemberIds:string[];denyMemberIds:string[];allowWorkspaceMembers:boolean};directoryAccess:{allow:DirectoryAccessRule[];deny:DirectoryAccessRule[];allowGroupMembers:boolean}}];busyChanged:[value:boolean];sessionExpired:[]}>();
const scope=ref<'self'|'workspace'>('self');
watch([scope,()=>props.selfMemberId],()=>emit('change',{webAccess:{allowMemberIds:[props.selfMemberId],denyMemberIds:[],allowWorkspaceMembers:scope.value==='workspace'},directoryAccess:{allow:[],deny:[],allowGroupMembers:false}}),{immediate:true});
</script>
<template><div class="employee-access-draft"><NRadioGroup v-model:value="scope" :disabled="disabled" aria-label="创建员工可用范围"><NRadio value="self">我自己</NRadio><NRadio value="workspace">工作区</NRadio></NRadioGroup><p class="field-note">{{scope==='workspace'?'当前及以后加入工作区的活跃成员都可在网页中使用。':'先由你在网页中试用，创建后可调整权限。'}}</p></div></template>
