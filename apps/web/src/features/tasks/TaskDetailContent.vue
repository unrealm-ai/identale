<script setup lang="ts">
import { taskDisplayTitle } from '@dentity/contracts';
import TaskMaterialAuthorization from '../business-resources/TaskMaterialAuthorization.vue';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NEmpty, NSelect, NSkeleton } from 'naive-ui';
import { api, ApiError, errorMessage } from '../../shared/api';
import{notificationStatus}from'../../shared/notification-status';
import { statusLabel } from '../../phase2';
import StatusBadge from '../../shared/ui/StatusBadge.vue';
import { activityLabel, replyEntry, type ActivityEntry, type ActivityPage, type ActivityTask } from './task-activity';
import { useExecutionRecords, type RuntimeEntry } from './useExecutionRecords';

const props = withDefaults(defineProps<{ task: ActivityTask; endpoint: string; active?: boolean; back?: boolean }>(), { active: true });
const emit = defineEmits<{ back: []; sessionExpired: []; unavailable: []; refreshed: [] }>();
const page = ref<ActivityPage | null>(null), loading = ref(false), error = ref(''), viewport = ref<HTMLElement>();
const expanded = ref<Record<string, boolean>>({}), full = ref<Record<string, { text: string; nextOffset: number | null }>>({}), reading = ref<Record<string, boolean>>({});
const contentErrors = ref<Record<string, string>>({});
const states = new Map<string, { expanded: Record<string, boolean>; scroll: number }>();
let controller = new AbortController(), generation = 0, pages = 1, timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
const selectedRun = computed(() => page.value?.runs.find(run => run.id === page.value?.runId));
const currentTask = computed(() => page.value?.task ?? props.task);
const runtime = useExecutionRecords(computed(() => props.endpoint), computed(() => page.value?.runId ?? null), captureAnchor, value => restoreAnchor(value), report);
const timeline = computed(() => [...(page.value?.entries ?? []), ...runtime.entries.value].sort((a,b) => a.createdAt-b.createdAt || a.sequence-b.sequence));
const isRuntime = (entry: ActivityEntry): entry is RuntimeEntry => 'source' in entry && entry.source === 'runtime';
function captureAnchor() {
  const root=viewport.value,top=root?.getBoundingClientRect().top??0;
  const row=[...(root?.querySelectorAll<HTMLElement>('[data-entry-id]')??[])].find(row=>row.getBoundingClientRect().bottom>top+48);
  return {id:row?.dataset.entryId,top:row?.getBoundingClientRect().top,scroll:root?.scrollTop??0};
}
function restoreAnchor(value:unknown) {
  const anchor=value as ReturnType<typeof captureAnchor>,root=viewport.value;if(!root)return;
  const row=[...root.querySelectorAll<HTMLElement>('[data-entry-id]')].find(row=>row.dataset.entryId===anchor.id);
  root.scrollTop=row&&anchor.top!==undefined?root.scrollTop+row.getBoundingClientRect().top-anchor.top:anchor.scroll;
}
const stateKey = () => `${props.endpoint}:${page.value?.runId ?? ''}`;
function remember(key = stateKey()) { states.set(key, { expanded: { ...expanded.value }, scroll: viewport.value?.scrollTop ?? 0 }); }
function report(cause: unknown, signal: AbortSignal) {
  if (signal.aborted) return;
  error.value = errorMessage(cause);
  if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
    page.value = null; full.value = {}; expanded.value = {}; states.clear(); controller.abort();
    if (cause.status === 401) emit('sessionExpired');
    emit('unavailable');
  }
}
async function load(more = false, runId?: string) {
  if (loading.value || controller.signal.aborted || (more && page.value?.nextAfter == null)) return;
  const expected = generation, signal = controller.signal, anchor = captureAnchor();
  loading.value = true; error.value = '';
  try {
    let after = more ? page.value!.nextAfter : null;
    let result: ActivityPage | null = null;
    let entries: ActivityEntry[] = more ? [...page.value!.entries] : [];
    const count = more ? 1 : pages;
    for (let n = 0; n < count; n++) {
      const query = new URLSearchParams();
      const requestedRun = runId ?? page.value?.runId;
      if (requestedRun) query.set('runId', requestedRun);
      if (after != null) query.set('after', String(after));
      result = await api<ActivityPage>(`${props.endpoint}?${query}`, signal);
      if (signal.aborted || expected !== generation) return;
      entries.push(...result.entries); after = result.nextAfter;
      if (after == null) break;
    }
    if (!result) return;
    const previous = new Map(page.value?.entries.map(entry => [entry.id, entry]));
    for (const entry of entries) {
      const old = previous.get(entry.id);
      if (old && (old.textLength !== entry.textLength || old.text !== entry.text)) delete full.value[entry.id];
    }
    page.value = { ...result, entries };
    if (more) pages++;
    await nextTick();
    if (expected === generation) restoreAnchor(anchor);
    if (expected === generation) emit('refreshed');
  } catch (cause) { if (expected === generation) report(cause, signal); }
  finally { if (expected === generation) loading.value = false; }
}
async function chooseRun(id: string) {
  remember(); controller.abort(); controller = new AbortController(); generation++; loading.value = false; pages = 1;
  full.value = {}; contentErrors.value = {}; reading.value = {}; page.value = null;
  const saved = states.get(`${props.endpoint}:${id}`); expanded.value = { ...saved?.expanded };
  await load(false, id); await nextTick(); if (viewport.value) viewport.value.scrollTop = saved?.scroll ?? 0;
}
async function readMore(entry: ActivityEntry) {
  if (reading.value[entry.id]) return;
  const expected = generation, signal = controller.signal, previous = full.value[entry.id];
  reading.value[entry.id] = true; delete contentErrors.value[entry.id];
  try {
    const query = new URLSearchParams({ runId: entry.runId, entryId: entry.id, offset: String(previous?.nextOffset ?? 0) });
    const result = await api<{ text: string; nextOffset: number | null; status?: string }>(`${isRuntime(entry) ? runtime.url.value : props.endpoint}?${query}`, signal);
    if(signal.aborted||expected!==generation)return;
    if (result.status) {if(isRuntime(entry))runtime.invalidate();throw new Error('执行记录已变化，请重新读取。');}
    if (!signal.aborted && expected === generation) full.value[entry.id] = { text: (previous?.text ?? '') + result.text, nextOffset: result.nextOffset };
  } catch (cause) {
    if (!signal.aborted && expected === generation) { contentErrors.value[entry.id] = errorMessage(cause); if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) report(cause, signal); }
  } finally { if (expected === generation) delete reading.value[entry.id]; }
}
function toggle(entry: ActivityEntry, event: Event) { const open=(event.target as HTMLDetailsElement).open;expanded.value[entry.id]=open;if(open&&isRuntime(entry)&&!entry.restricted&&entry.type!=='reply'&&!full.value[entry.id])void readMore(entry); }
function fullToggle(entry:ActivityEntry,event:Event){if((event.target as HTMLDetailsElement).open&&!full.value[entry.id])void readMore(entry);}
function bodyScroll(entry:ActivityEntry,event:Event){const body=event.target as HTMLElement;if(body.scrollHeight-body.scrollTop-body.clientHeight<120&&full.value[entry.id]?.nextOffset!=null&&!contentErrors.value[entry.id])void readMore(entry);}
async function edge(){const root=viewport.value;if(!root||props.active===false||root.scrollHeight-root.scrollTop-root.clientHeight>160)return;if(page.value?.nextAfter!=null&&!error.value)await load(true);else if(runtime.nextCursor.value&&!runtime.error.value)await runtime.load('more');}
async function refreshDetails(){await load();await runtime.load();}
watch(() => props.endpoint, (_value, previous) => {
  if (previous) remember(`${previous}:${page.value?.runId ?? ''}`);
  controller.abort(); controller = new AbortController(); generation++; pages = 1; page.value = null; loading.value = false;
  expanded.value = {}; full.value = {}; contentErrors.value = {}; reading.value = {}; error.value = '';
  void load().then(async () => { const saved = states.get(stateKey()); if (saved) { expanded.value = { ...saved.expanded }; await nextTick(); if (viewport.value) viewport.value.scrollTop = saved.scroll; } });
}, { immediate: true });
watch(() => props.active, active => { if (active && page.value) void load(); });
watch(() => [page.value?.nextAfter,runtime.nextCursor.value,loading.value,runtime.busy.value],async()=>{await nextTick();if(viewport.value?.clientHeight)void edge();});
async function poll() { if (disposed) return; if (props.active !== false && document.visibilityState === 'visible') {await load();await runtime.load();} if (!disposed) timer = setTimeout(poll, 5000); }
timer = setTimeout(poll, 5000);
onUnmounted(() => { disposed = true; controller.abort(); generation++; if (timer) clearTimeout(timer); });
</script>
<template>
  <section ref="viewport" class="task-detail-content" aria-label="任务详情" tabindex="0" @scroll.passive="edge">
    <div class="detail-toolbar"><NButton v-if="back" @click="emit('back')">← 返回任务列表</NButton><NButton size="small" :loading="loading || runtime.busy.value" :disabled="loading || runtime.busy.value" @click="refreshDetails">刷新详情</NButton></div>
    <header><h2>{{ taskDisplayTitle(currentTask) }}</h2><div class="detail-meta"><StatusBadge :status="currentTask.status"/><time :datetime="new Date(currentTask.createdAt).toISOString()">{{ new Date(currentTask.createdAt).toLocaleString('zh-CN') }}</time></div></header>
    <details :key="currentTask.id" class="task-description"><summary>任务说明</summary><p class="selectable">{{ currentTask.input }}</p></details>
    <details class="task-identifiers"><summary>任务信息</summary><h3>任务（Task）</h3><p class="selectable">{{ currentTask.id }}</p><p>输入修订 r{{ currentTask.inputRevision }}</p></details>
    <TaskMaterialAuthorization v-if="page" :task-id="currentTask.id" :run-id="page.runId" @session-expired="emit('sessionExpired')"/>
    <NAlert v-if="error" type="error">{{ error }} <NButton :disabled="loading" @click="load()">重新读取</NButton></NAlert>
    <NSkeleton v-if="loading && !page" text :repeat="4"/>
    <div v-if="page" class="status-lanes" aria-label="任务、执行与投递状态"><section><h3>任务 TASK</h3><StatusBadge :status="currentTask.status"/></section><section><h3>执行 RUN</h3><StatusBadge v-if="selectedRun" domain="run" :status="selectedRun.status"/><span v-else class="field-note">尚未开始执行</span></section><section><h3>投递 DELIVERY</h3><StatusBadge v-for="delivery in page.deliveries" :key="delivery.id" domain="delivery" :status="delivery.status"/><span v-if="!page.deliveries.length" class="field-note">未提供投递记录</span></section></div>
    <section v-if="page?.notifications?.length" aria-label="结果回告"><h3>结果回告</h3><p v-for="notice in page.notifications" :key="notice.id">{{ notice.sourceKind==='work_item'?'事项回告':'任务回告' }} · {{ notificationStatus(notice) }}<span v-if="notice.generationState==='unknown'||notice.deliveryState==='unknown'" class="field-note">，请勿重复发起</span></p></section>
    <section v-if="currentTask.humanRequests?.length" aria-label="人工确认状态"><h3>人工确认</h3><div v-for="r in currentTask.humanRequests" :key="r.requestId"><p>{{r.question.goal}} · {{r.status==='continued'?'已继续':r.status==='confirmed'?'已确认，等待继续':r.status==='rejected'?'已拒绝':r.status==='canceled'?'已停止':'等待答复'}}</p><p v-if="r.notificationError==='human_task_input_changed'" role="alert">任务要求已变化，当前确认不能继续执行。请取消并重新布置任务。</p><p v-if="['failed','blocked'].includes(r.notificationStatus)" role="alert">确认请求未发送成功，请核对员工的确认人及渠道配置。</p><p v-else-if="r.notificationStatus==='unknown'" role="status">请求送达结果待核对，请勿重复发送。</p><p v-if="!r.safe" class="field-note">执行段正在安全收尾，已收到的答复会保存，待收尾后继续。</p><details><summary>问题及范围</summary><p v-for="q in r.question.questions" :key="q.id">{{q.text}}</p><p>{{r.question.proposedAction}}</p><p class="selectable">{{r.requestId}}</p></details></div></section>
    <template v-if="page">
      <label v-if="page.runs.length > 1" class="run-picker">执行记录<NSelect :virtual-scroll="false" :value="page.runId" :options="page.runs.map(run => ({ value: run.id, label: `第 ${run.attempt} 段${run.kind==='human_continue'?' · 人工继续':''} · ${statusLabel(run.status)} · ${new Date(run.createdAt).toLocaleString('zh-CN')}` }))" aria-label="选择执行记录" @update:value="chooseRun"/></label>
      <section class="execution-record"><h3>执行（Run）</h3>
        <NEmpty v-if="!selectedRun" description="尚未启动，无执行记录。"/>
        <template v-else>
          <div class="run-status"><StatusBadge domain="run" :status="selectedRun.status"/><time>{{ new Date(selectedRun.createdAt).toLocaleString('zh-CN') }}</time></div>
          <p v-if="currentTask.status==='waiting_human'" class="field-note">执行已安全停在人工确认点，等待指定人员回复；确认后将沿用上下文开始下一段执行。</p><NAlert v-if="selectedRun.status === 'unknown'" type="warning">执行结果尚未确认，请等待核对。</NAlert>
          <NAlert v-if="currentTask.status === 'cancel_requested'" type="warning">已申请取消，等待执行器确认。</NAlert>
          <NAlert v-if="selectedRun.resultInputRevision !== null && selectedRun.resultInputRevision < currentTask.inputRevision" type="warning">结果未覆盖最新输入修订。</NAlert>
          <p v-if="runtime.status.value === 'unavailable'" class="field-note">执行器明细暂不可读。下方显示已保存的任务进展与回复。</p>
          <p v-if="!timeline.length" class="muted">尚无已保存的进展或回复。</p>
          <ol class="activity-timeline"><li v-for="entry in timeline" :key="`${entry.runId}:${entry.id}`" :data-entry-id="entry.id" :class="{ 'final-entry': entry.type === 'final_result' }">
            <details :open="expanded[entry.id] ?? replyEntry(entry)" @toggle="toggle(entry, $event)">
              <summary><span>{{ entry.type === 'tool_call' ? `工具调用 · ${isRuntime(entry) ? entry.toolName : ''}` : entry.type === 'tool_result' ? `工具结果 · ${isRuntime(entry) ? entry.toolName : ''}${isRuntime(entry) && entry.isError ? ' · 失败' : ''}` : activityLabel(entry) }}</span><time :datetime="new Date(entry.createdAt).toISOString()">{{ new Date(entry.createdAt).toLocaleTimeString('zh-CN') }}</time></summary>
              <div class="activity-body"><p v-if="entry.status">{{ statusLabel(entry.status) }}</p><p v-if="entry.inputStatus">输入 r{{ entry.inputRevision }}：{{ statusLabel(entry.inputStatus) }}</p><p v-if="entry.text" class="activity-text">{{ entry.text }}</p><p v-if="entry.type === 'final_result' && entry.inputRevision !== null" class="field-note">采用输入 r{{ entry.inputRevision }}</p>
                <p v-if="isRuntime(entry) && entry.restricted" class="field-note">该工具结果包含受限上下文，未在此展示。</p><div v-else-if="isRuntime(entry) && entry.type !== 'reply'" class="record-body" tabindex="0" aria-label="工具参数或结果内容，滚动读取更多" @scroll.passive="bodyScroll(entry,$event)"><p class="activity-text">{{ full[entry.id]?.text }}</p><p v-if="full[entry.id] && !full[entry.id]!.text && !reading[entry.id]" class="muted">没有可展示的文本内容。</p><p v-if="reading[entry.id]" role="status">正在读取内容…</p><p v-else-if="full[entry.id]?.nextOffset != null" role="status">继续向下滚动读取更多内容</p><NButton v-if="contentErrors[entry.id]" @click="readMore(entry)">重试读取内容</NButton></div>
                <details v-else-if="entry.textLength > 1200" class="full-content" @toggle="fullToggle(entry,$event)"><summary>展开完整内容</summary><div class="record-body" tabindex="0" aria-label="完整回复，滚动读取更多" @scroll.passive="bodyScroll(entry,$event)"><p class="activity-text">{{ full[entry.id]?.text }}</p><p v-if="full[entry.id] && !full[entry.id]!.text && !reading[entry.id]" class="muted">没有可展示的文本内容。</p><p v-if="reading[entry.id]" role="status">正在读取内容…</p><p v-else-if="full[entry.id]?.nextOffset != null" role="status">继续向下滚动读取更多内容</p><NButton v-if="contentErrors[entry.id]" @click="readMore(entry)">重试读取内容</NButton></div></details><p v-if="contentErrors[entry.id]" role="alert">{{ contentErrors[entry.id] }}</p>
              </div>
            </details>
          </li></ol>
          <p v-if="loading || runtime.busy.value" role="status">正在读取执行记录…</p><p v-else-if="page.nextAfter !== null || runtime.nextCursor.value" class="field-note">继续向下滚动读取更多记录</p>
          <NAlert v-if="runtime.error.value" type="warning">{{ runtime.error.value }} <NButton @click="runtime.status.value === 'changed' ? runtime.reset() : runtime.load(runtime.nextCursor.value ? 'more' : 'tail')">{{ runtime.status.value === 'changed' ? '重新读取记录' : '重试读取记录' }}</NButton></NAlert>
        </template>
      </section>
      <details class="delivery-record"><summary>投递（Delivery）<span>{{ page.deliveries.length }} 条</span></summary><p v-if="!page.deliveries.length" class="field-note">未提供投递记录；任务完成不代表消息已送达。</p><p v-for="delivery in page.deliveries" :key="delivery.id" class="field-note"><StatusBadge domain="delivery" :status="delivery.status"/> · {{ new Date(delivery.createdAt).toLocaleString('zh-CN') }}</p></details>
      <slot/>
    </template>
  </section>
</template>
<style scoped>
.task-detail-content{display:grid;gap:1rem;min-width:0;max-height:72vh;overflow:auto;overscroll-behavior:contain;padding:0 .25rem .5rem;scrollbar-gutter:stable}.detail-toolbar{display:flex;flex-wrap:wrap;gap:.5rem;justify-content:space-between;position:sticky;top:0;background:var(--surface);padding:.25rem 0;z-index:1}header{display:grid;gap:.75rem}h2{font-size:1rem;line-height:1.65;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}h3{font-size:.875rem;margin:0 0 .75rem}p{margin:.5rem 0}.detail-meta,.run-status{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap}time{font-size:.75rem;color:var(--muted)}.task-description,.task-identifiers,.delivery-record{border:1px solid var(--subtle);border-radius:.5rem;padding:.75rem}.selectable,.activity-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.75}.run-picker{display:grid;gap:.5rem}.execution-record{min-width:0}.activity-timeline{list-style:none;margin:1rem 0;padding:0;border-left:1px solid var(--subtle)}.activity-timeline>li{margin:0 0 .75rem .75rem;min-width:0}.activity-timeline details{border:1px solid var(--subtle);border-radius:.5rem;overflow:hidden}.activity-timeline summary{padding:.75rem;display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:space-between;list-style:revert}.activity-timeline summary:before{content:'›';font-size:1.1rem;color:var(--muted)}.activity-timeline details[open]>summary:before{transform:rotate(90deg)}.activity-timeline summary span{margin-right:auto}.activity-body{padding:0 .75rem .75rem;min-width:0}.final-entry details{border-color:var(--primary)}.final-entry summary{font-weight:600}.delivery-record summary{display:flex;justify-content:space-between}.task-detail-content summary{cursor:pointer}.task-detail-content summary:focus-visible{outline:2px solid var(--primary);outline-offset:2px}.field-note{color:var(--muted);font-size:.75rem;line-height:1.6}@media(max-width:47.5rem){.task-detail-content{max-height:calc(100dvh - 10rem)}}
</style>
<style scoped>.task-detail-content>*{min-width:0;max-width:100%}.run-picker{min-width:0;grid-template-columns:minmax(0,1fr)}.record-body{max-height:24rem;overflow:auto;overscroll-behavior:contain;overflow-wrap:anywhere;outline-offset:2px}.record-body:focus-visible{outline:2px solid var(--focus)}.full-content{margin-top:.75rem}.activity-timeline .full-content>summary{font-size:.8125rem;padding:.5rem}.full-content .activity-text{padding:.5rem}</style>
<style scoped>.activity-timeline summary span{min-width:0;overflow-wrap:anywhere}</style>

<style scoped>.status-lanes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--subtle);border-radius:12px;background:var(--background);overflow:hidden}.status-lanes section{padding:16px;border-right:1px solid var(--subtle);display:flex;flex-wrap:wrap;gap:6px;align-content:start}.status-lanes section:last-child{border-right:0}.status-lanes h3{width:100%;font-size:11px;color:var(--muted);letter-spacing:.04em;margin:0 0 6px}@media(max-width:500px){.status-lanes{grid-template-columns:1fr}.status-lanes section{border:0;border-bottom:1px solid var(--subtle)}}</style>
