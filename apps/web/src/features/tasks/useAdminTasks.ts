import { computed, onUnmounted, ref, watch } from 'vue';
import { api, ApiError, errorMessage } from '../../shared/api';
import type { Entity, Workspace } from '../../shared/api';
import type { TaskFilter } from '../../phase2';
export interface Overview { employees: number; conversations: number; activeTasks: number; succeeded: number; failed: number; successRate: number | null }
export interface ManagedConversation { id: string; entityId: string; channel: string; mode: string; createdAt: number; taskCount: number }
export interface ManagedTask { id: string; title?: string | null; input: string; status: string; createdAt: number; inputRevision: number; run: { status: string; result: string | null; resultInputRevision: number | null } | null }
interface Page<T> { records: T[]; nextCursor: string | null }
interface Children { tasks: ManagedTask[]; cursor: string | null; loading: boolean; error: string; loaded: boolean }
export function useAdminTasks(props: { workspace: Workspace; entities: Entity[]; entityId?: string | undefined; conversationId?: string | undefined }, emit: { (event: 'sessionExpired'): void; (event: 'filtersChanged', entityId: string, conversationId?: string): void }) {
  const globalStats = ref<Overview | null>(null), employeeStats = ref<Overview | null>(null), entityId = ref(props.entityId || props.entities[0]?.id || '');
  const sessionFilter = ref(props.conversationId || ''), status = ref<TaskFilter>('all'), conversations = ref<ManagedConversation[]>([]), children = ref<Record<string, Children>>({}), expanded = ref<string[]>([]);
  const busy = ref(false), globalBusy = ref(false), error = ref(''), nextCursor = ref<string | null>(null), loaded = ref(false);
  const base = computed(() => `/workspaces/${encodeURIComponent(props.workspace.id)}/task-management`), canManage = computed(() => ['owner', 'admin'].includes(props.workspace.role));
  let controller = new AbortController(), globalController = new AbortController(), generation = 0;
  function report(cause: unknown, signal: AbortSignal) {
    if (signal.aborted) return; error.value = errorMessage(cause);
    if (cause instanceof ApiError && [401, 403].includes(cause.status)) { controller.abort(); globalController.abort(); generation++; busy.value = false; globalBusy.value = false; globalStats.value = null; employeeStats.value = null; conversations.value = []; children.value = {}; expanded.value = []; nextCursor.value = null; }
    if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired');
  }
  async function loadGlobal() {
    globalController.abort(); globalController = new AbortController(); const signal = globalController.signal; globalBusy.value = true;
    try { const result = await api<Overview>(`${base.value}/overview`, signal); if (!signal.aborted) globalStats.value = result; }
    catch (cause) { report(cause, signal); } finally { if (!signal.aborted) globalBusy.value = false; }
  }
  function filters() { return new URLSearchParams({ entityId: entityId.value, ...(sessionFilter.value.trim() ? { conversationId: sessionFilter.value.trim() } : {}) }); }
  async function loadConversations(more = false) {
    if (!canManage.value || !entityId.value || busy.value || (more && !nextCursor.value)) return;
    const signal = controller.signal, version = generation, query = filters(); query.set('limit', '25'); if (more && nextCursor.value) query.set('cursor', nextCursor.value);
    busy.value = true; error.value = '';
    try { const result = await api<Page<ManagedConversation>>(`${base.value}/conversations?${query}`, signal); if (signal.aborted || version !== generation) return; conversations.value = more ? [...conversations.value, ...result.records] : result.records; nextCursor.value = result.nextCursor; loaded.value = true; }
    catch (cause) { report(cause, signal); } finally { if (version === generation) busy.value = false; }
  }
  async function loadEmployee() {
    if (!canManage.value || !entityId.value) return;
    const signal = controller.signal, version = generation;
    try { const result = await api<Overview>(`${base.value}/overview?${new URLSearchParams({ entityId: entityId.value })}`, signal); if (!signal.aborted && version === generation) employeeStats.value = result; }
    catch (cause) { report(cause, signal); }
  }
  function reset() { controller.abort(); controller = new AbortController(); generation++; busy.value = false; employeeStats.value = null; conversations.value = []; children.value = {}; expanded.value = []; nextCursor.value = null; loaded.value = false; error.value = ''; }
  function chooseEntity(id: string) { if (id === entityId.value) return; entityId.value = id; sessionFilter.value = ''; emit('filtersChanged', id); reset(); void loadEmployee(); void loadConversations(); }
  function applySession() { emit('filtersChanged', entityId.value, sessionFilter.value.trim() || undefined); reset(); void loadEmployee(); void loadConversations(); }
  async function loadTasks(conversationId: string, more = false) {
    const current = children.value[conversationId]; if (!current || current.loading || (more && !current.cursor)) return;
    const signal = controller.signal, version = generation, query = new URLSearchParams({ entityId: entityId.value, conversationId, status: status.value, limit: '25' }); if (more && current.cursor) query.set('cursor', current.cursor);
    current.loading = true; current.error = '';
    try { const result = await api<Page<ManagedTask>>(`${base.value}/tasks?${query}`, signal); if (signal.aborted || version !== generation) return; current.tasks = more ? [...current.tasks, ...result.records] : result.records; current.cursor = result.nextCursor; current.loaded = true; }
    catch (cause) { if (!signal.aborted) { current.error = errorMessage(cause); report(cause, signal); } } finally { if (version === generation) current.loading = false; }
  }
  function toggle(id: string) { if (expanded.value.includes(id)) expanded.value = expanded.value.filter(value => value !== id); else { expanded.value.push(id); if (!children.value[id]) children.value[id] = { tasks: [], cursor: null, loading: false, error: '', loaded: false }; if (!children.value[id]!.loaded) void loadTasks(id); } }
  function refresh() { reset(); void loadGlobal(); void loadEmployee(); void loadConversations(); }
  watch(status, () => { controller.abort(); controller = new AbortController(); generation++; busy.value = false; if (!employeeStats.value) void loadEmployee(); if (!loaded.value) void loadConversations(); for (const id of expanded.value) { children.value[id] = { tasks: [], cursor: null, loading: false, error: '', loaded: false }; void loadTasks(id); } });
  watch(() => props.workspace.id, () => { reset(); globalStats.value = null; entityId.value = props.entityId || props.entities[0]?.id || ''; sessionFilter.value = props.conversationId || ''; if (canManage.value) { void loadGlobal(); void loadEmployee(); void loadConversations(); } }, { immediate: true });
  watch(() => [props.entityId, props.conversationId], () => { const id = props.entityId || props.entities[0]?.id || ''; if (id !== entityId.value || (props.conversationId || '') !== sessionFilter.value) { entityId.value = id; sessionFilter.value = props.conversationId || ''; reset(); void loadEmployee(); void loadConversations(); } });
  onUnmounted(() => { controller.abort(); globalController.abort(); generation++; });
  return { globalStats, employeeStats, entityId, sessionFilter, status, conversations, children, expanded, busy, globalBusy, error, nextCursor, loaded, canManage, chooseEntity, applySession, loadConversations, loadTasks, toggle, refresh };
}
