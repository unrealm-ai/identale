<script setup lang="ts">
import { taskDisplayTitle } from '@dentity/contracts';
import { NButton } from 'naive-ui';
import StatusBadge from '../../shared/ui/StatusBadge.vue';
import type { ActivityTask } from './task-activity';
defineProps<{ task: ActivityTask; compact?:boolean }>();
defineEmits<{ select: [] }>();
</script>
<template>
  <li class="task-list-item" :class="{'task-list-item--compact':compact}" :data-task-id="task.id" :data-created-at="task.createdAt">
    <NButton text class="task-title" @click="$emit('select')"><span class="task-title-text">{{ taskDisplayTitle(task) }}</span></NButton>
    <span v-if="compact" class="task-employee">{{task.employeeName??'未提供员工名称'}}</span><div class="task-meta"><StatusBadge :status="task.status" v-bind="task.status === 'unknown' ? { label: '结果待核对' } : {}"/><time :datetime="new Date(task.createdAt).toISOString()">{{ new Date(task.createdAt).toLocaleString('zh-CN') }}</time></div>
  </li>
</template>
<style scoped>
.task-list-item{display:grid;gap:.625rem;padding:1rem 0;border-bottom:1px solid var(--subtle);min-width:0;list-style:none}.task-title{display:block;width:100%;height:auto;min-width:0;text-align:left;line-height:1.6}.task-title :deep(.n-button__content){display:block;min-width:0;width:100%}.task-title .task-title-text{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;white-space:normal;text-align:left}.task-meta{display:flex;align-items:center;justify-content:space-between;gap:.5rem;flex-wrap:wrap}.task-meta time{color:var(--muted);font-size:.75rem}@media(max-width:47.5rem){.task-title .task-title-text{-webkit-line-clamp:2}}
</style>

<style scoped>.task-list-item--compact{grid-template-columns:minmax(0,1fr) minmax(5rem,10rem) minmax(14rem,20rem);gap:1rem;align-items:center;padding:1.25rem 1rem}.task-list-item--compact:hover{background:var(--hoverBg,var(--tint))}.task-list-item--compact .task-meta{display:contents}.task-list-item--compact{grid-template-columns:minmax(0,1fr) minmax(5rem,10rem) 7rem 11rem}.task-employee{font-size:.875rem;overflow-wrap:anywhere;min-width:0}@media(max-width:68.75rem){.task-list-item--compact{grid-template-columns:minmax(0,1fr) 6rem}.task-list-item--compact .task-title{grid-column:1/-1}.task-list-item--compact .task-meta{display:flex;grid-column:1/-1}.task-list-item--compact .task-employee{grid-column:1/-1}.task-list-item--compact{gap:.625rem;padding:1rem}}</style>
