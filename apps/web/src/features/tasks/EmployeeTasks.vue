<script setup lang="ts">
import { NAlert, NButton, NEmpty, NSelect } from 'naive-ui';
import type { Entity, Workspace } from '../../shared/api';
import PageHeader from '../../shared/ui/PageHeader.vue';
import TaskPanel from './TaskPanel.vue';
import { useEmployeeTasks } from './useEmployeeTasks';
const props = defineProps<{ entity: Entity; workspace: Workspace; conversationId?: string | undefined; embedded?:boolean }>();
const emit = defineEmits<{ (event: 'sessionExpired'): void; (event: 'openConversation', id: string): void; (event: 'conversationSelected', id: string): void }>();
const { base, selected, conversations, busy, loaded, error, refresh, choose } = useEmployeeTasks(props, emit);
</script>
<template>
  <section class="employee-tasks">
    <PageHeader :level="embedded?2:1" :title="`${entity.name} · 当前会话任务`" description="选择一个会话，查看其中的任务。"><NButton :disabled="busy" :loading="busy" @click="refresh">刷新会话</NButton></PageHeader>
    <label>任务来源会话<NSelect filterable aria-label="任务来源会话" :value="conversationId ?? null" :options="conversations.map(record => ({ label: `${record.mode === 'demo' || record.simulated ? '历史演示 · 只读' : '对话'} · ${new Date(record.createdAt).toLocaleString('zh-CN')} · ${record.id.slice(0, 8)}`, value: record.id }))" :disabled="busy" placeholder="请选择已授权会话" :input-props="{ 'aria-label': '任务来源会话' }" @update:value="choose" /></label>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <template v-if="selected"><NButton @click="emit('openConversation', selected.id)">返回当前对话</NButton><TaskPanel v-if="selected.mode === 'real' && !selected.simulated" :key="`${base}:${selected.id}`" :base="base" :conversation-id="selected.id" :history="[]" @session-expired="emit('sessionExpired')" /><NAlert v-else type="warning">历史演示记录仅可在来源对话只读查看，不提供任务操作。</NAlert></template>
    <NEmpty v-else :description="loaded && conversationId ? '此会话不存在或未获授权，请重新选择会话或返回对话。' : '请先选择已授权会话，或返回对话查看本会话任务。'" />
  </section>
</template>
<style scoped>
.employee-tasks { display: grid; gap: 1.25rem; min-width: 0; }.employee-tasks > label { display: grid; gap: 0.5rem; }


</style>
