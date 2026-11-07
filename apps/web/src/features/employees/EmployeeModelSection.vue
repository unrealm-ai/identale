<script setup lang="ts">
import { NButton, NSpace } from 'naive-ui';
import ModelSettings from './ModelSettings.vue';
import EmployeeThinkingLevel from './EmployeeThinkingLevel.vue';
import type { EmployeeModelDraft } from './useModelSettings';
import type { ExecutionThinkingLevel } from './thinking-options';
defineProps<{ base: string;initialProfileId?:string|null|undefined; draft?: boolean; disabled?: boolean; canManage: boolean }>();
const thinking = defineModel<ExecutionThinkingLevel>('thinking', { required: true });
const emit = defineEmits<{ draftChanged: [value: EmployeeModelDraft]; busyChanged: [value: boolean]; saveThinking: []; cancelThinking: []; dirtyChanged: [value: boolean]; sessionExpired: [] }>();
</script>
<template>
  <section class="employee-model-section">
    <h2>模型与思考强度</h2>

    <div :inert="disabled"><ModelSettings :initial-profile-id="initialProfileId" :base="base" :draft="draft" :can-manage="canManage" :can-manage-workspace="false" @draft-changed="emit('draftChanged', $event)" @busy-changed="emit('busyChanged', $event)" @dirty-changed="emit('dirtyChanged', $event)" @session-expired="emit('sessionExpired')">
      <template #employee-options><EmployeeThinkingLevel v-model:value="thinking" :disabled="disabled" /><NSpace v-if="!draft"><NButton :disabled="disabled" @click="emit('saveThinking')">保存思考强度</NButton><NButton :disabled="disabled" @click="emit('cancelThinking')">取消思考强度修改</NButton></NSpace></template>
    </ModelSettings></div>
  </section>
</template>
<style scoped>.employee-model-section{margin-top:1.5rem}.employee-model-section h2{font-size:1.125rem}</style>
