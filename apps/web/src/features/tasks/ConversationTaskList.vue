<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NEmpty } from 'naive-ui';
import { api, ApiError, errorMessage } from '../../shared/api';
import type { Task, TaskPage } from '../../phase2';
import TaskListItem from './TaskListItem.vue';
import TaskDetailContent from './TaskDetailContent.vue';
const props = defineProps<{ base: string; conversationId: string; embedded?:boolean }>();
const emit = defineEmits<{ sessionExpired: []; updated: [] }>();
type Context = { mode: 'new' | 'fork'; status: 'available' | 'not_started' | 'expired' | 'unavailable'; messages: { id: string; role: string; text: string }[] };
const tasks = ref<Task[]>([]), selected = ref<Task | null>(null), detailOpen = ref(false), context = ref<Context | null>(null);
const loading = ref(false), error = ref(''), contextError = ref(''), cursor = ref<string | null>(null), listViewport = ref<HTMLElement>();
let controller = new AbortController(), version = 0, detailVersion = 0, pages = 1, disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
const root = () => `${props.base}/conversations/${encodeURIComponent(props.conversationId)}/tasks`;
function unavailable() { tasks.value = []; selected.value = null; context.value = null; cursor.value = null; detailOpen.value = false; error.value = '任务记录不可访问，请重新打开会话核对权限。'; controller.abort(); }
function report(cause: unknown, signal: AbortSignal) {
  if (signal.aborted) return;
  error.value = errorMessage(cause);
  if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) { unavailable(); if (cause.status === 401) emit('sessionExpired'); }
}
async function readContext(task: Task) {
  const expected = ++detailVersion, signal = controller.signal, base = root();
  try {
    const result = await api<Context>(`${base}/${encodeURIComponent(task.id)}/context`, signal);
    if (!signal.aborted && expected === detailVersion && selected.value?.id === task.id) { context.value = result; contextError.value = ''; }
  } catch (cause) { if (expected === detailVersion && selected.value?.id === task.id && !signal.aborted) { contextError.value = errorMessage(cause); if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) report(cause, signal); } }
}
async function refresh(more = false) {
  if (loading.value || controller.signal.aborted || more && !cursor.value) return;
  const expected = version, signal = controller.signal, base = root(), scroll = listViewport.value?.scrollTop ?? 0;
  loading.value = true; error.value = '';
  try {
    let next = more ? cursor.value : null, records: Task[] = more ? [...tasks.value] : [];
    for (let n = 0; n < (more ? 1 : pages); n++) {
      const result: TaskPage = await api<TaskPage>(`${base}?limit=25&summary=true${next ? `&cursor=${encodeURIComponent(next)}` : ''}`, signal);
      if (signal.aborted || expected !== version) return;
      records.push(...result.tasks.filter(task => task.conversationId === props.conversationId)); next = result.nextCursor;
      if (!next) break;
    }
    tasks.value = [...new Map(records.map(task => [task.id, task])).values()]; cursor.value = next; if (more) pages++;
    if (selected.value) { const current = records.find(task => task.id === selected.value?.id); if (current) selected.value = current; }
    await nextTick(); if (listViewport.value) listViewport.value.scrollTop = scroll;
    if (!signal.aborted) emit('updated');
  } catch (cause) { report(cause, signal); }
  finally { if (expected === version) loading.value = false; }
}
const orderedTasks = computed(() => [...tasks.value].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)));
function select(task: Task) { if (selected.value?.id !== task.id) { detailVersion++; context.value = null; contextError.value = ''; } selected.value = task; detailOpen.value = true; }
async function back() { detailOpen.value = false; await nextTick(); const row = [...(listViewport.value?.querySelectorAll<HTMLElement>('[data-task-id]') ?? [])].find(row => row.dataset.taskId === selected.value?.id); row?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true }); }
function listEdge(){const list=listViewport.value;if(!detailOpen.value&&list&&cursor.value&&!error.value&&list.scrollHeight-list.scrollTop-list.clientHeight<160)void refresh(true);}
watch(() => [props.base, props.conversationId], () => {
  controller.abort(); controller = new AbortController(); version++; detailVersion++; pages = 1;
  tasks.value = []; selected.value = null; detailOpen.value = false; context.value = null; cursor.value = null; loading.value = false; error.value = ''; contextError.value = ''; void refresh();
}, { immediate: true });
async function poll() { if (disposed) return; if (document.visibilityState === 'visible') await refresh(); if (!disposed) timer = setTimeout(poll, 5000); }
timer = setTimeout(poll, 5000); onUnmounted(() => { disposed = true; controller.abort(); detailVersion++; if (timer) clearTimeout(timer); });
</script>
<template>
  <NCard class="conversation-task-list" v-bind="{...(!detailOpen&&!embedded?{title:'本会话任务'}:{}),...(embedded?{contentStyle:'padding:0'}:{})}" :bordered="!embedded" size="small">
    <NAlert v-if="error" type="error">{{ error }}</NAlert>
    <div v-show="!detailOpen" ref="listViewport" class="task-list-view" tabindex="0" aria-label="本会话任务列表，滚动读取更多" @scroll.passive="listEdge">
      <div class="task-list-toolbar"><NButton size="small" :loading="loading" :disabled="loading" @click="refresh()">刷新状态</NButton></div>
      <NEmpty v-if="!loading && !tasks.length && !error" description="本会话暂无任务"/>
      <p v-if="loading && !tasks.length" role="status">正在读取任务…</p>
      <ul class="task-list"><TaskListItem v-for="task in orderedTasks" :key="task.id" :task="task" @select="select(task)"/></ul>
      <p v-if="cursor" class="field-note" role="status">{{loading?'正在读取任务…':'继续向下滚动读取更多任务'}}</p>
    </div>
    <TaskDetailContent v-if="selected" v-show="detailOpen" :task="selected" :endpoint="`${root()}/${encodeURIComponent(selected.id)}/activity`" :active="detailOpen" back @back="back" @unavailable="unavailable" @session-expired="emit('sessionExpired')" @refreshed="detailOpen && selected && readContext(selected)">
      <details class="saved-context"><summary>已有执行上下文</summary><NAlert v-if="contextError" type="error">{{ contextError }} <NButton @click="readContext(selected!)">重新读取上下文</NButton></NAlert><p v-else-if="!context">正在读取已有上下文…</p>
        <template v-if="context"><p>{{ context.mode === 'new' ? '新上下文 · 仅任务说明' : '已保存的会话原文' }}</p><p v-if="context.status !== 'available'">{{ context.status === 'not_started' ? '尚未启动，未生成执行上下文。' : context.status === 'expired' ? '原执行上下文已过期。' : '原执行上下文不可用。' }}</p><p v-else-if="!context.messages.length">没有附带会话原文。</p><article v-for="message in context.messages" :key="message.id"><small>{{ message.role === 'user' ? '用户' : '助手' }}</small><p class="context-text">{{ message.text }}</p></article></template>
      </details>
    </TaskDetailContent>
  </NCard>
</template>
<style scoped>
.conversation-task-list{min-width:0}.task-list-view{max-height:70vh;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.task-list{list-style:none;padding:0;margin:.5rem 0}.task-list-toolbar{display:flex;justify-content:flex-end}.context-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}.saved-context{padding:.75rem;border:1px solid var(--subtle);border-radius:.5rem}.saved-context summary{cursor:pointer}.saved-context summary:focus-visible{outline:2px solid var(--primary)}
</style>
