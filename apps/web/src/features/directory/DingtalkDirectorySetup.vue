<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import DirectorySyncStatus from './DirectorySyncStatus.vue';
import type { DirectorySyncStatus as SyncStatus } from './types';
defineProps<{base:string;connectionId:string;disabled?:boolean}>();
const status=ref<SyncStatus>();
const scopes=computed(()=> (status.value?.lastError?.missingScopes ?? []).filter(scope=>/^[a-z][a-z0-9_.-]*(?::[a-z0-9_.-]+)*$/.test(scope)).slice(0,30));
</script>
<template>
  <section class="form-section" aria-label="钉钉通讯录设置">
    <h3>通讯录设置</h3>
    <p>机器人配置已保存。通讯录权限与消息收发权限独立；需要选择人员或部门时，请完成以下设置。</p>
    <ol>
      <li>在钉钉后台开通通讯录部门、部门成员及成员信息的读取 API 权限。</li>
      <li>设置应用可访问的通讯录部门和人员范围，并按后台要求确认生效。开通 API 不等于全企业可读。</li>
      <li>返回此处点击「检查并同步通讯录」，查看同步结果后再选择人员或部门。</li>
    </ol>
    <a href="https://open-dev.dingtalk.com/" target="_blank" rel="noopener noreferrer">打开钉钉开发者后台 ↗</a>
    <p v-if="status?.lastError?.category==='permission'" role="status">钉钉拒绝通讯录读取，请检查 API 权限和可访问范围。<span v-if="scopes.length">缺少权限：{{scopes.join('、')}}</span></p>
    <p v-else-if="status?.lastError" role="status">上次同步错误：{{status.lastError.code}}<span v-if="status.lastError.providerCode!==undefined">（钉钉代码 {{status.lastError.providerCode}}）</span>。请检查后重试。</p>
    <DirectorySyncStatus :endpoint="base+'/channels/dingtalk/directory'" :connection-id="connectionId" :disabled="disabled" :auto-load="true" sync-label="检查并同步通讯录" @updated="status=$event"/>
  </section>
</template>
