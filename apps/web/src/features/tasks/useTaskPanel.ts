import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, ApiError, errorMessage } from '../../shared/api';
import { statusLabel } from '../../phase2';
import type { Task, TaskFilter, TaskPage, TaskUpdates } from '../../phase2';

export function useTaskPanel(props: { base: string; conversationId: string; history: { id: string; role: string; text: string }[] }, emit: { (event: 'sessionExpired' | 'updated'): void }) {
const tasks = ref<Task[]>([]), selected = ref<Task | null>(null), details = ref<TaskUpdates | null>(null);
const title = ref(''), input = ref(''), addition = ref(''), contextMode = ref<'new' | 'fork'>('new'), historyIds = ref<string[]>([]);
const busy = ref(false), refreshing = ref(false), error = ref(''), notice = ref(''), loaded = ref(false);
const contextUnavailable = ref(false);
const filter = ref<TaskFilter>('all'), nextCursor = ref<string | null>(null);
let controller = new AbortController();
let timer: ReturnType<typeof setTimeout> | undefined;
let detailVersion = 0, listVersion = 0, disposed = false;
const operations = new Map<string, string>();
const pendingMutations = new Map<string, { operationId: string; expectedVersion: number; input?: string }>();
const conversationBase = computed(() => `${props.base}/conversations/${encodeURIComponent(props.conversationId)}`);
const taskBase = computed(() => `${conversationBase.value}/tasks`);
const currentTasks = computed(() => tasks.value.filter(t => t.conversationId === props.conversationId));
const canStart = computed(() => selected.value?.availableActions?.start?.available === true);
const canSupplement = computed(() => selected.value?.availableActions?.supplement?.available === true);
const canCancel = computed(() => selected.value?.availableActions?.cancel?.available === true);
function actionReason(reason?: string) {
  return ({platform_action_unsupported: '平台当前未实现此操作', permission_denied: '当前使用者没有操作权限', task_not_started: '待办尚未启动', runtime_state_unknown: '执行状态未知，等待核对', runtime_capability_unknown: '执行器能力尚未确认或确认已过期', runtime_action_unsupported: '绑定的执行器不支持此操作', runtime_not_bound: '执行器尚未完成任务绑定', runtime_not_configured: '尚未配置执行器', run_terminal: '当前执行已结束', task_terminal: '当前任务状态不允许此操作', cancel_already_requested: '已申请取消，等待执行器确认'} as Record<string,string>)[reason ?? ''] ?? (reason ? `当前不可用：${reason}` : '未获得平台明确可用声明，请刷新状态');
}
function operation(key: string) { if (!operations.has(key)) operations.set(key, crypto.randomUUID()); return operations.get(key)!; }
function report(cause: unknown, signal: AbortSignal) {
  if (signal.aborted) return;
  error.value = errorMessage(cause);
  if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
    tasks.value = []; selected.value = null; details.value = null; nextCursor.value = null;
    contextUnavailable.value = true; refreshing.value = false; busy.value = false;
    controller.abort(); detailVersion++; listVersion++;
  }
  if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired');
}
async function loadDetails(task: Task) {
  const version = ++detailVersion, signal = controller.signal, root = taskBase.value;
  try {
    const [record, updates] = await Promise.all([
      api<{ task: Task }>(`${root}/${encodeURIComponent(task.id)}`, signal),
      api<TaskUpdates>(`${root}/${encodeURIComponent(task.id)}/updates`, signal),
    ]);
    if (!signal.aborted && version === detailVersion && selected.value?.id === task.id) {
      if (record.task.conversationId !== props.conversationId) throw new ApiError('task_conversation_forbidden', 403);
      if (record.task.version >= selected.value.version) { selected.value = record.task; details.value = updates; }
    }
  } catch (cause) { if (version === detailVersion && selected.value?.id === task.id) report(cause, signal); }
}
async function refresh(more = false) {
  if (refreshing.value || controller.signal.aborted || !props.conversationId || (more && !nextCursor.value)) return;
  const signal = controller.signal, version = ++listVersion;
  const query = new URLSearchParams({ status: filter.value, limit: '25' });
  if (more && nextCursor.value) query.set('cursor', nextCursor.value);
  refreshing.value = true;
  try {
    const result = await api<TaskPage>(`${taskBase.value}?${query}`, signal);
    if (signal.aborted || version !== listVersion) return;
    const records = result.tasks.filter(task => task.conversationId === props.conversationId);
    tasks.value = more ? [...new Map([...tasks.value, ...records].map(task => [task.id, task])).values()] : records;
    nextCursor.value = result.nextCursor; loaded.value = true;
    if (selected.value) await loadDetails(selected.value);
    if (!signal.aborted) emit('updated');
  } catch (cause) { if (version === listVersion) report(cause, signal); }
  finally { if (version === listVersion) refreshing.value = false; }
}
async function select(task: Task) {
  if (busy.value || controller.signal.aborted || task.conversationId !== props.conversationId) return;
  selected.value = task; details.value = null; addition.value = ''; error.value = ''; notice.value = '';
  await loadDetails(task);
}
async function create(kind: 'todo' | 'immediate' = 'todo') {
  if (busy.value || controller.signal.aborted || !props.conversationId || !input.value.trim()) return;
  const signal = controller.signal;
  busy.value = true; error.value = ''; notice.value = '';
  const body = { ...(title.value.trim()?{title:title.value}:{}), input: input.value, contextMode: contextMode.value, historyMessageIds: contextMode.value === 'fork' ? [...historyIds.value] : [] };
  const key = JSON.stringify([conversationBase.value, kind, body]);
  try {
    const result = await api<{ task: Task }>(kind === 'todo' ? `${conversationBase.value}/todos` : taskBase.value, signal, { ...body, operationId: operation(key) });
    if (signal.aborted) return;
    operations.delete(key); title.value = ''; input.value = ''; historyIds.value = []; selected.value = result.task; details.value = null; detailVersion++;
    notice.value = kind === 'todo' ? '待办已保存，尚未启动执行。可继续补充要求后手动启动。' : `任务已记录：${statusLabel(result.task.status)}。创建不代表执行成功。`;
    listVersion++; refreshing.value = false; await refresh();
  } catch (cause) { report(cause, signal); }
  finally { if (signal === controller.signal) busy.value = false; }
}
async function mutate(kind: 'input' | 'cancel' | 'start') {
  const task = selected.value;
  if (!task || busy.value || controller.signal.aborted || (kind === 'input' && (!addition.value.trim() || !canSupplement.value)) || (kind === 'cancel' && !canCancel.value) || (kind === 'start' && !canStart.value)) return;
  const signal = controller.signal;
  busy.value = true; error.value = ''; notice.value = '';
  const key = JSON.stringify([task.id, kind, kind === 'input' ? addition.value : '']);
  if (!pendingMutations.has(key)) pendingMutations.set(key, { operationId: crypto.randomUUID(), expectedVersion: task.version, ...(kind === 'input' ? { input: addition.value } : {}) });
  try {
    const result = await api<{ task: Task }>(`${taskBase.value}/${encodeURIComponent(task.id)}/${kind}`, signal, pendingMutations.get(key)!);
    if (signal.aborted) return;
    pendingMutations.delete(key); selected.value = result.task; detailVersion++; details.value = null;
    if (kind === 'input') addition.value = '';
    notice.value = kind === 'start' ? '启动已受理，请查询实际执行状态；不代表任务成功。' : kind === 'cancel' ? (result.task.run ? '取消请求已提交。仅在状态为“已确认取消”时，才表示执行已取消。' : '待办已取消，未启动执行。') : task.availableActions?.supplement.application === 'on_start' ? '补充已保存到待办，启动时使用最新要求；当前未启动执行。' : result.task.actionReceipt?.deliveryMode === 'platform_record_only' ? '补充仅记录在平台，当前不保证交付执行器；不能视为已应用。' : '补充已保存，请查看输入回执；执行器已接收不等于已应用。';
    listVersion++; refreshing.value = false; await refresh();
  } catch (cause) {
    report(cause, signal);
    if (!signal.aborted && cause instanceof ApiError && cause.code === 'version_conflict') {
      pendingMutations.delete(key); listVersion++; refreshing.value = false; await refresh();
    }
  } finally { if (signal === controller.signal) busy.value = false; }
}
watch(() => [props.base, props.conversationId], () => {
  controller.abort(); controller = new AbortController(); detailVersion++; listVersion++;
  tasks.value = []; selected.value = null; details.value = null; title.value = ''; input.value = ''; addition.value = ''; contextMode.value = 'new'; historyIds.value = [];
  contextUnavailable.value = false; loaded.value = false; busy.value = false; refreshing.value = false; error.value = ''; notice.value = ''; nextCursor.value = null; filter.value = 'all';
  operations.clear(); pendingMutations.clear(); void refresh();
}, { immediate: true });
watch(filter, () => { listVersion++; detailVersion++; refreshing.value = false; tasks.value = []; nextCursor.value = null; selected.value = null; details.value = null; void refresh(); });
async function poll() {
  if (document.visibilityState === 'visible' && !busy.value) await refresh();
  if (!disposed) timer = setTimeout(poll, 5000);
}
onMounted(() => { timer = setTimeout(poll, 5000); });
onUnmounted(() => { disposed = true; controller.abort(); detailVersion++; listVersion++; if (timer) clearTimeout(timer); operations.clear(); pendingMutations.clear(); });
return { contextUnavailable, selected, details, title, input, addition, contextMode, historyIds, busy, refreshing, error, notice, loaded, currentTasks, canStart, canSupplement, canCancel, filter, nextCursor, actionReason, refresh, select, create, mutate };
}
