<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { api, errorMessage } from '../../shared/api';
import type { DirectorySyncStatus as SyncStatus } from './types';
const props = defineProps<{ endpoint: string; initial?: SyncStatus | undefined; connectionId?: string; disabled?: boolean; autoLoad?: boolean }>();
const emit = defineEmits<{ updated: [value: SyncStatus]; completed: [] }>();
class DirectorySourceError extends Error {}
const message = (cause: unknown) => cause instanceof DirectorySourceError ? cause.message : errorMessage(cause);
const task = ref<SyncStatus>(), busy = ref(false), error = ref('');
let controller = new AbortController(), timer: ReturnType<typeof setTimeout> | undefined, failures = 0, disposed = false, initialRevision = 0;
const progress = computed(() => task.value?.partSummary);
const lastUpdated = computed(() => task.value?.lastSuccessAt ? new Date(task.value.lastSuccessAt).toLocaleString() : '尚未完成同步');
function clearTimer() { if (timer) clearTimeout(timer); timer = undefined; }
function schedule() { clearTimer(); if (!disposed && !document.hidden && task.value?.running && failures < 3) timer = setTimeout(() => { void read(); }, 1500); }
function accept(value: SyncStatus, notify = true) {
  if (!value || typeof value.running !== 'boolean' || props.connectionId && value.connectionId !== props.connectionId) throw new DirectorySourceError('通讯录来源已改变，请刷新配置。');
  const previous = task.value; task.value = value; failures = 0; emit('updated', value);
  if (notify && previous && !value.running && (previous.running || previous.snapshotVersion !== value.snapshotVersion)) emit('completed');
  schedule();
}
async function read() {
  if (disposed || document.hidden || busy.value) return;
  const signal = controller.signal, revision = initialRevision; busy.value = true;
  try { const value = await api<SyncStatus>(props.endpoint + '/status', signal); if (!signal.aborted && revision === initialRevision) { error.value = ''; accept(value); } }
  catch (cause) { if (!signal.aborted) { error.value = message(cause); failures++; schedule(); } }
  finally { if (!signal.aborted) busy.value = false; }
}
async function sync() {
  if (disposed || document.hidden || busy.value || props.disabled || task.value?.running) return;
  clearTimer(); const signal = controller.signal; busy.value = true; error.value = '';
  try { const result = await api<{accepted: boolean; task: SyncStatus}>(props.endpoint + '/sync', signal, {}, 'POST'); if (!signal.aborted) accept(result.task); }
  catch (cause) { if (!signal.aborted) { error.value = message(cause); failures = 0; } }
  finally { if (!signal.aborted) busy.value = false; }
}
function visibility() { clearTimer(); if (document.hidden) { controller.abort(); controller = new AbortController(); busy.value = false; } else { failures = 0; void read(); } }
watch(() => [props.endpoint, props.connectionId], () => { clearTimer(); controller.abort(); controller = new AbortController(); busy.value = false; task.value = undefined; error.value = ''; failures = 0; if (props.initial) {try {accept(props.initial, false);} catch(cause){error.value=message(cause);}} else if (props.autoLoad) void read(); }, { immediate: true });
watch(() => props.initial, value => { initialRevision++; if (value) { try { accept(value); } catch (cause) { error.value = message(cause); } } });
onMounted(() => document.addEventListener('visibilitychange', visibility));
onBeforeUnmount(() => { disposed = true; clearTimer(); controller.abort(); document.removeEventListener('visibilitychange', visibility); });
</script>
<template>
  <div class="directory-sync-status">
    <div class="directory-sync-copy" role="status" aria-live="polite">
      <template v-if="task?.running"><strong>通讯录正在同步</strong><span v-if="task.progress">已发现 {{task.progress.userCount}} 人、{{task.progress.departmentCount}} 个部门</span><span v-else-if="progress">已完成 {{ progress.succeeded }} 项读取<template v-if="progress.running">，正在读取后续部门或人员</template></span><span v-else>正在读取授权范围内的部门和人员…</span></template>
      <template v-else><span>上次同步：{{ lastUpdated }}</span><span v-if="task?.lastResult==='success' && task.progress">{{task.progress.userCount}} 人、{{task.progress.departmentCount}} 个部门</span><span v-if="task?.lastResult==='failure'">同步未完成，{{task.hasSnapshot?'当前显示上次成功结果。':'请重试。'}}</span><span v-else-if="task?.stale && task.hasSnapshot">通讯录可能不是最新，可点击同步。</span></template>
      <span v-if="error" class="sync-error" role="alert">{{ error }}</span>
    </div>
    <div class="directory-sync-actions"><NButton v-if="error" size="small" :disabled="busy" @click="read">刷新状态</NButton><NButton size="small" :loading="busy" :disabled="disabled || busy || task?.running===true" @click="sync">{{task?.running?'同步中':'同步通讯录'}}</NButton></div>
  </div>
</template>
<style scoped>
.directory-sync-status{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.625rem .75rem;margin:.75rem 0;border:1px solid var(--subtle);border-radius:var(--id-radius-control);background:var(--id-bg-canvas,var(--background));font-size:.8125rem;color:var(--muted)}
.directory-sync-copy{display:grid;gap:.25rem;min-width:0;overflow-wrap:anywhere}.directory-sync-copy strong{font-weight:500;color:var(--foreground)}.directory-sync-actions{display:flex;gap:.5rem;flex-shrink:0}.sync-error{color:var(--danger)}
@media(max-width:30rem){.directory-sync-status{align-items:flex-start;flex-wrap:wrap}}
</style>
