<script setup lang="ts">
import InfoHint from '../../shared/ui/InfoHint.vue';
import {computed} from 'vue';
import {NAlert,NButton,NCard,NCheckbox,NForm,NFormItem,NSelect,NSpace} from 'naive-ui';
import type {WebChatAccessState} from './useWebChatAccess';
const props=defineProps<{state:WebChatAccessState;disabled?:boolean}>();
const locked=computed(()=>!!props.disabled||props.state.loading||props.state.saving||props.state.unknown);
const options=computed(()=>props.state.members.map(m=>({label:m.displayName,value:m.id})));
</script>
<template>
<NCard class="web-chat-access" title="Web 私聊" size="small" aria-label="Web 私聊使用范围">
  <p class="field-note">选择可在网页中与这位员工私聊的人员。<InfoHint label="网页使用范围说明">与渠道使用范围分别保存，不自动授予渠道权限。</InfoHint></p>
  <p v-if="state.loading" role="status">正在读取 Web 私聊范围…</p>
  <NAlert v-if="state.error" type="error" role="alert">{{state.error}}</NAlert><NAlert v-if="state.notice" type="success" role="status">{{state.notice}}</NAlert>
  <NAlert v-if="state.unknown" type="warning">保存结果尚未确认，请先读取服务器配置核对。</NAlert>
  <template v-if="state.loaded">
    <NAlert v-if="state.policy.denyMemberIds.length" type="warning">已配置额外使用限制，仍会生效。本次保存不会移除这些限制。</NAlert>
    <NForm class="settings-form" @submit.prevent="state.save">
      <NFormItem label="使用范围"><NCheckbox v-model:checked="state.policy.allowWorkspaceMembers" :disabled="locked" aria-label="允许工作区成员使用">工作区内可用</NCheckbox></NFormItem>
      <p v-if="state.policy.allowWorkspaceMembers" class="field-note" id="web-members-disabled">当前及以后加入的活跃成员可使用。已选人员保留，取消勾选可继续编辑。</p>
      <NFormItem label="添加人员"><NSelect v-model:value="state.policy.allowMemberIds" aria-label="允许成员" :input-props="{'aria-label':'允许成员'}" :aria-describedby="state.policy.allowWorkspaceMembers?'web-members-disabled':undefined" multiple filterable :disabled="locked||state.policy.allowWorkspaceMembers===true" :options="options" placeholder="搜索并选择工作区人员" /></NFormItem>
      <NSpace><NButton type="primary" attr-type="submit" aria-label="保存 Web 使用策略" :disabled="locked||!state.dirty" :loading="state.saving">保存</NButton><NButton aria-label="取消 Web 范围修改" :disabled="locked||!state.dirty" @click="state.cancel">取消</NButton><NButton :disabled="state.loading||state.saving" @click="state.load">读取服务器配置并核对</NButton></NSpace>
    </NForm>
  </template>
  <NButton v-else-if="!state.loading" @click="state.load">重新读取 Web 范围</NButton>
</NCard>
</template>
<style scoped>.web-chat-access{min-width:0}.web-chat-access .n-form{margin-top:1rem}.web-chat-access .field-note{margin:.5rem 0 1rem}.web-chat-access :deep(.n-alert){margin-bottom:.75rem}</style>
