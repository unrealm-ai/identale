import { computed, nextTick, onUnmounted, ref, watch, type Ref } from 'vue';
import { api, ApiError, errorMessage } from '../../shared/api';
import type { ActivityEntry } from './task-activity';
export interface RuntimeEntry extends ActivityEntry { source: 'runtime'; toolName?: string; toolCallId?: string; isError?: boolean; restricted?:boolean }
interface RecordPage { status: 'available' | 'unavailable' | 'changed'; reason?: string; records: { id: string; runId: string; type: string; createdAt: number; text: string; textLength: number; toolName?: string; toolCallId?: string; isError?: boolean;restricted?:boolean }[]; nextCursor: string | null; tailCursor: string | null }
export function useExecutionRecords(endpoint: Ref<string>, runId: Ref<string | null>, capture: () => unknown, restore: (anchor: unknown) => void, forbidden: (cause: unknown, signal: AbortSignal) => void) {
  const entries = ref<RuntimeEntry[]>([]), busy = ref(false), error = ref(''), status = ref<RecordPage['status']>('unavailable');
  const nextCursor = ref<string | null>(null), tailCursor = ref<string | null>(null);
  let controller = new AbortController(), generation = 0;
  const url = computed(() => endpoint.value.replace(/\/activity$/, '/records'));
  async function load(mode: 'initial' | 'more' | 'tail' = 'tail') {
    if (!runId.value || busy.value || controller.signal.aborted || mode === 'more' && !nextCursor.value || mode === 'tail' && (status.value === 'changed' || nextCursor.value)) return;
    const signal = controller.signal, expected = generation, anchor = capture();
    busy.value = true; error.value = '';
    const cursor = mode === 'more' ? nextCursor.value : mode === 'tail' ? tailCursor.value : null;
    try {
      const query = new URLSearchParams({ runId: runId.value }); if (cursor) query.set('cursor', cursor);
      const result = await api<RecordPage>(`${url.value}?${query}`, signal);
      if (signal.aborted || expected !== generation) return;
      status.value = result.status;
      if (result.status === 'changed') { entries.value = []; nextCursor.value = null; tailCursor.value = null; error.value = '执行记录已变化，请重新读取。'; }
      else if (result.status === 'available') {
        const records = result.records.map((r, sequence): RuntimeEntry => ({ ...r, source: 'runtime', sequence, status: null, inputRevision: null, inputStatus: null }));
        entries.value = [...new Map([...(mode === 'initial' ? [] : entries.value), ...records].map(r => [r.id, r])).values()];
        nextCursor.value = result.nextCursor; tailCursor.value = result.tailCursor;
      } else { entries.value=[]; nextCursor.value=null; tailCursor.value=null;if(result.reason==='record_entry_too_large')error.value='执行记录包含超出读取上限的条目，暂不能显示明细。';else if(result.reason==='record_format_unsupported')error.value='执行记录格式暂不支持。'; }
      await nextTick(); if (expected === generation) restore(anchor);
    } catch (cause) { if (!signal.aborted && expected === generation) { error.value = errorMessage(cause); if (cause instanceof ApiError && [401,403,404].includes(cause.status)) { entries.value = []; forbidden(cause, signal); controller.abort(); } } }
    finally { if (expected === generation) busy.value = false; }
  }
  function reset() { controller.abort(); controller = new AbortController(); generation++; entries.value = []; busy.value = false; error.value = ''; nextCursor.value = null; tailCursor.value = null; status.value = 'unavailable'; if (runId.value) void load('initial'); }
  function invalidate(){controller.abort();controller=new AbortController();generation++;entries.value=[];busy.value=false;nextCursor.value=null;tailCursor.value=null;status.value='changed';error.value='执行记录已变化或不可读，请重新读取。';}
  watch([endpoint, runId], reset);
  onUnmounted(() => { controller.abort(); generation++; });
  return { entries, busy, error, status, nextCursor, load, reset, invalidate, url };
}
