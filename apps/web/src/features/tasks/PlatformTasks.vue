<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NCollapse, NCollapseItem, NDrawer, NDrawerContent, NFormItem, NInput, NSelect } from 'naive-ui';
import { api, ApiError, errorMessage, type Entity, type Workspace } from '../../shared/api';
import AsyncState from '../../shared/ui/AsyncState.vue';
import { statusLabel } from '../../phase2';
import TaskListItem from './TaskListItem.vue';
import TaskDetailContent from './TaskDetailContent.vue';
import type { ActivityTask } from './task-activity';
const props = defineProps<{ workspace: Workspace; entities: Entity[]; entityId?: string | undefined; conversationId?: string | undefined }>();
const emit = defineEmits<{ filtersChanged: [string, string?]; sessionExpired: [] }>();
const params = new URLSearchParams(location.search), entity = ref(props.entityId ?? ''), conversation = ref(props.conversationId ?? '');
const channel = ref(params.get('channel') ?? ''), status = ref(params.get('status') ?? 'all'), rows = ref<ActivityTask[]>([]);
const cursor = ref<string | null>(null), busy = ref(false), loaded = ref(false), error = ref(''), selected = ref<ActivityTask | null>(null), detailOpen = ref(false), fullDetail=ref(false), fullLoading=ref(false), fullError=ref('');
const sentinel=ref<HTMLElement>();let observer:IntersectionObserver|undefined;
function edge(){if(cursor.value&&!error.value&&!detailOpen.value&&sentinel.value&&sentinel.value.getBoundingClientRect().top<=window.innerHeight+160)void load(true);}
let controller = new AbortController(), generation = 0;
const canManage = computed(() => ['owner', 'admin'].includes(props.workspace.role));
const searchedEmployees = ref<Entity[]>([]);
const entityOptions = computed(() => [{ label: '全部员工', value: '' }, ...[...new Map([...props.entities, ...searchedEmployees.value].map(employee => [employee.id, employee])).values()].map(employee => ({ label: employee.name, value: employee.id }))]);
const base = computed(() => `/workspaces/${encodeURIComponent(props.workspace.id)}/task-management/task-list`);
const states = ['all', 'planned', 'active', 'queued', 'running', 'waiting_input', 'waiting_approval', 'waiting_human', 'cancel_requested', 'unknown', 'succeeded', 'failed', 'canceled'];
async function searchEmployees(query: string) {
  const signal = controller.signal;
  try { const result = await api<{ records: Entity[] }>(`/workspaces/${encodeURIComponent(props.workspace.id)}/employee-summaries?limit=25${query ? '&q=' + encodeURIComponent(query) : ''}`, signal); if (!signal.aborted) searchedEmployees.value = result.records; } catch { /* Existing filter and list remain usable. */ }
}
function unavailable() { fullDetail.value=false; selected.value = null; detailOpen.value = false; rows.value = []; cursor.value = null; error.value = '任务记录不可访问，请刷新列表核对权限。'; }
async function load(more = false) {
  if (!canManage.value || busy.value) return;
  const expected = generation, signal = controller.signal; busy.value = true; error.value = '';
  const query = new URLSearchParams({ limit: '25', summary: 'true', status: status.value, ...(entity.value ? { entityId: entity.value } : {}), ...(conversation.value.trim() ? { conversationId: conversation.value.trim() } : {}), ...(channel.value ? { channel: channel.value } : {}), ...(more && cursor.value ? { cursor: cursor.value } : {}) });
  try {
    const result = await api<{ records: ActivityTask[]; nextCursor: string | null }>(base.value + '?' + query, signal);
    if (!signal.aborted && expected === generation) { rows.value = more ? [...rows.value, ...result.records] : result.records; cursor.value = result.nextCursor; loaded.value = true; if (selected.value) selected.value = rows.value.find(task => task.id === selected.value?.id) ?? selected.value; }
  } catch (cause) {
    if (!signal.aborted) { error.value = errorMessage(cause); if (cause instanceof ApiError && [401, 403].includes(cause.status)) { unavailable(); controller.abort(); if (cause.status === 401) emit('sessionExpired'); } }
  } finally { if (expected === generation) busy.value = false; }
}
function filters() {
  controller.abort(); controller = new AbortController(); generation++; busy.value = false; rows.value = []; cursor.value = null; loaded.value = false;
  emit('filtersChanged', entity.value, conversation.value || undefined);
  const url = new URL(location.href);
  for (const [key, value] of [['status', status.value], ['channel', channel.value]]) { if (value && value !== 'all') url.searchParams.set(key!, value); else url.searchParams.delete(key!); }
  history.replaceState(null, '', url.pathname + url.search); void load();
}
function open(task: ActivityTask) { selected.value = task; detailOpen.value = true; }
function fullRoute(id?:string){const url=new URL(location.href);if(id)url.searchParams.set('task',id);else url.searchParams.delete('task');history.pushState(null,'',url.pathname+url.search);}
function showFull(){if(!selected.value)return;detailOpen.value=false;fullDetail.value=true;fullError.value='';fullRoute(selected.value.id);window.scrollTo({top:0});}
function closeFull(){fullDetail.value=false;fullError.value='';fullRoute();}
async function restoreFull(){const url=new URL(location.href),id=url.searchParams.get('task');if(!id||!canManage.value||!['workbench','tasks'].includes(url.searchParams.get('view')??'')){fullDetail.value=false;fullError.value='';return;}fullDetail.value=true;detailOpen.value=false;fullLoading.value=true;fullError.value='';const expected=generation,signal=controller.signal;selected.value=null;try{const task=await api<ActivityTask>(`${base.value}/${encodeURIComponent(id)}`,signal);if(!signal.aborted&&expected===generation)selected.value=task;}catch(cause){if(!signal.aborted&&expected===generation){fullError.value=errorMessage(cause);if(cause instanceof ApiError&&cause.status===401)emit('sessionExpired');}}finally{if(expected===generation)fullLoading.value=false;}}
watch(() => [props.entityId, props.conversationId], () => { if (entity.value !== (props.entityId ?? '') || conversation.value !== (props.conversationId ?? '')) { entity.value = props.entityId ?? ''; conversation.value = props.conversationId ?? ''; filters(); } });
watch(() => props.workspace.id, () => { unavailable(); filters(); });
watch(canManage, value => { if (!value) { controller.abort(); unavailable(); } });
void load();onMounted(()=>{void restoreFull();window.addEventListener('popstate',restoreFull);if(typeof IntersectionObserver!=='undefined'){observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))edge();},{rootMargin:'160px'});if(sentinel.value)observer.observe(sentinel.value);}window.addEventListener('scroll',edge,{passive:true});});onUnmounted(() => { controller.abort(); generation++;observer?.disconnect();window.removeEventListener('scroll',edge);window.removeEventListener('popstate',restoreFull); });
</script>
<template>
  <section class="platform-tasks">
    <NAlert v-if="!canManage" type="warning">只有工作区所有者和管理员可以查看全局任务。</NAlert>
    <section v-if="canManage&&fullDetail" class="full-task-page"><NButton @click="closeFull">← 返回任务列表</NButton><p v-if="fullLoading" role="status">正在读取任务详情…</p><NAlert v-else-if="fullError" type="error" role="alert">{{fullError}}<NButton @click="restoreFull">重试详情</NButton></NAlert><TaskDetailContent v-else-if="selected" :key="selected.id" :task="selected" :endpoint="`${base}/${encodeURIComponent(selected.id)}/activity`" @unavailable="()=>{selected=null;fullError='任务记录不可访问，请返回列表核对权限。'}" @session-expired="emit('sessionExpired')"/></section>
    <template v-else-if="canManage">
      <div class="task-filters"><div class="task-filter-field"><NSelect :virtual-scroll="false" v-model:value="entity" :options="entityOptions" filterable remote @search="searchEmployees" aria-label="筛选数字员工" @update:value="filters"/></div><div class="task-filter-field"><NSelect :virtual-scroll="false" v-model:value="channel" :options="[{label:'全部渠道',value:''},{label:'Web',value:'web'},{label:'飞书',value:'feishu'},{label:'钉钉',value:'dingtalk'},{label:'企业微信',value:'wecom'},{label:'自动运行',value:'trigger'}]" aria-label="筛选渠道" @update:value="filters"/></div><div class="task-filter-field"><NSelect :virtual-scroll="false" v-model:value="status" :options="states.map(value => ({value,label:value === 'all' ? '全部状态' : value === 'active' ? '进行中' : statusLabel(value)}))" aria-label="任务状态" @update:value="filters"/></div><NButton :loading="busy" @click="filters">刷新任务</NButton><NCollapse class="advanced-task-filters"><NCollapseItem title="高级筛选" name="advanced"><form @submit.prevent="filters"><NFormItem label="会话 ID"><NInput v-model:value="conversation" :input-props="{'aria-label':'会话 ID 筛选'}" clearable/></NFormItem><NButton attr-type="submit">应用会话筛选</NButton></form></NCollapseItem></NCollapse></div>

      <AsyncState :loading="busy && !loaded" :error="error" :empty="loaded && !rows.length" :filtered="!!entity || !!channel || status !== 'all' || !!conversation" @retry="filters"><div class="task-column-labels" aria-hidden="true"><span>任务</span><span>数字员工</span><span>状态</span><span>创建时间</span></div><ul class="task-records"><TaskListItem v-for="task in rows" :key="task.id" :task="task" compact @select="open(task)"/></ul></AsyncState><p ref="sentinel" tabindex="0" role="status" aria-label="任务列表末尾，滚动读取更多">{{cursor?(busy?'正在读取任务…':'继续向下滚动读取更多任务'):''}}</p>
    </template>
    <NDrawer v-model:show="detailOpen" :width="'min(680px,100vw)'" :auto-focus="true"><NDrawerContent title="任务详情" closable><template #header><div class="task-drawer-heading"><span>任务详情</span><NButton size="small" @click="showFull">打开完整详情</NButton></div></template><TaskDetailContent v-if="selected" :task="selected" :endpoint="`${base}/${encodeURIComponent(selected.id)}/activity`" :active="detailOpen" @unavailable="unavailable" @session-expired="emit('sessionExpired')"/></NDrawerContent></NDrawer>
  </section>
</template>
<style scoped>
.platform-tasks{display:grid;gap:1rem;min-width:0}.task-filters{display:grid;grid-template-columns:repeat(3,minmax(9rem,14rem)) auto minmax(8rem,1fr);gap:1rem;align-items:center}.task-filter-field{min-width:0}.task-filters :deep(.n-form-item-feedback-wrapper){display:none}.advanced-task-filters{justify-self:end;max-width:25rem;min-width:8rem}.advanced-task-filters:has(.n-collapse-item__content-wrapper){grid-column:1/-1;width:100%;max-width:none;justify-self:stretch}.task-records{list-style:none;padding:0;margin:0;border:1px solid var(--subtle);border-radius:var(--id-radius-card,.75rem);overflow:hidden}.task-column-labels{display:grid;grid-template-columns:minmax(0,1fr) minmax(5rem,10rem) 7rem 11rem;gap:1rem;padding:.75rem 1rem;background:var(--background);color:var(--muted);font-size:.875rem;border-radius:var(--id-radius-card,.75rem) var(--id-radius-card,.75rem) 0 0}.full-task-page{display:grid;gap:1.25rem;min-width:0}.full-task-page>button{justify-self:start}.full-task-page :deep(.task-detail-content){max-height:none;overflow:visible;padding:1.5rem;border:1px solid var(--subtle);border-radius:var(--id-radius-card,.75rem)}.full-task-page :deep(.detail-toolbar){position:static}.task-drawer-heading{display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
@media(max-width:68.75rem){.task-filters{grid-template-columns:repeat(3,minmax(0,1fr)) auto}.advanced-task-filters{grid-column:1/-1}.task-column-labels{display:none}}@media(max-width:47.5rem){.task-filters{grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem}.task-filters>:first-child{grid-column:1/-1}.advanced-task-filters{justify-self:start}}
</style>
