import { computed, onUnmounted, ref, watch } from 'vue';
import { api, ApiError, errorMessage } from '../../shared/api';
import type { Entity, Workspace } from '../../shared/api';

interface Conversation { id: string; mode: 'real' | 'demo'; simulated: boolean; createdAt: number }
export function useEmployeeTasks(props: { entity: Entity; workspace: Workspace; conversationId?: string | undefined }, emit: { (event: 'sessionExpired'): void; (event: 'conversationSelected', id: string): void }) {
  const conversations = ref<Conversation[]>([]), busy = ref(false), loaded = ref(false), error = ref('');
  const base = computed(() => `/workspaces/${encodeURIComponent(props.workspace.id)}/entities/${encodeURIComponent(props.entity.id)}`);
  const selected = computed(() => conversations.value.find(record => record.id === props.conversationId));
  let controller = new AbortController();
  async function refresh() {
    if (busy.value || controller.signal.aborted) return;
    const signal = controller.signal; busy.value = true; error.value = '';
    try {
      const result = await api<{ conversations: Conversation[] }>(`${base.value}/conversations`, signal);
      if (!signal.aborted) { conversations.value = result.conversations; loaded.value = true; }
    } catch (cause) {
      if (signal.aborted) return;
      error.value = errorMessage(cause); conversations.value = [];
      if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired');
    } finally { if (signal === controller.signal) busy.value = false; }
  }
  function choose(id: string) { if (conversations.value.some(record => record.id === id)) emit('conversationSelected', id); }
  watch(() => [props.workspace.id, props.entity.id], () => {
    controller.abort(); controller = new AbortController(); conversations.value = []; loaded.value = false; busy.value = false; void refresh();
  }, { immediate: true });
  onUnmounted(() => controller.abort());
  return { base, selected, conversations, busy, loaded, error, refresh, choose };
}
