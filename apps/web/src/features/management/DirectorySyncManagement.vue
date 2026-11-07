<script setup lang="ts">
import {NAlert} from 'naive-ui';
import type {Workspace} from '../../shared/api';
import DirectorySyncTasks from './DirectorySyncTasks.vue';
import {useDirectorySync} from './useDirectorySync';
const props=defineProps<{workspace:Workspace;connectionId?:string}>();
const emit=defineEmits<{busyChanged:[value:boolean];sessionExpired:[]}>();
const {canManage,taskRows,historyRows,loadState,error,notice,pendingTaskId,selectedTaskId,historyLoading,historyError,nextCursor,refresh,loadHistory,toggle,interval,sync}=useDirectorySync(props,emit);
</script>
<template><div class="directory-sync-management"><NAlert v-if="notice" type="info" role="status">{{ notice }}</NAlert><DirectorySyncTasks :can-manage="canManage" :load-state="loadState" :tasks="taskRows" :error="error" :pending-task-id="pendingTaskId" :selected-task-id="selectedTaskId" :history="historyRows" :history-loading="historyLoading" :history-error="historyError" :history-has-more="nextCursor!==null" @refresh="refresh()" @select="loadHistory" @history-refresh="id=>loadHistory(id)" @history-more="id=>loadHistory(id,true)" @toggle="toggle" @interval="interval" @sync="sync" /></div></template>
<style scoped>.directory-sync-management{display:grid;gap:1rem}</style>
