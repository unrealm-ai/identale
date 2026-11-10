// Modified for Identale; see the root NOTICE.
import { onUnmounted, ref, watch } from 'vue';
import { api, ApiError } from '../../shared/api';
import type { DirectoryConnection } from '../directory/types';

type RuntimeChannel = Pick<DirectoryConnection, 'id' | 'appId' | 'provider' | 'revision' | 'authRevision' | 'transport'>;
export type RuntimeSnapshot = { observedAt: number | null; employee: { channels: RuntimeChannel[] } | null };
export const connectionObservationKey = (item: RuntimeChannel) => JSON.stringify([item.id, item.provider, item.appId, item.revision, item.authRevision]);

/** Read-only observations: never refresh configuration or mutate an editor's draft. */
export function useChannelRuntimeStatus(options: {
  base: () => string; active: () => boolean; connections: () => DirectoryConnection[];
  onSessionExpired: () => void;
}) {
  const snapshot = ref<RuntimeSnapshot | null>(null);
  const unavailable = ref(false);
  // Only these presentation fields may leave the observation path. Never retain
  // configuration, capabilities, access rules or credential fields here.
  const identity = ref<Partial<DirectoryConnection>[]>([]);
  const identityUnavailable = ref(false);
  const identityLoaded = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let generation = 0, disposed = false;
  const visible = () => !disposed && options.active() && document.visibilityState !== 'hidden';
  function cancel() { generation++; clearTimeout(timer); timer = undefined; request?.abort(); request = undefined; }
  async function refresh() {
    cancel();
    if (!visible() || !options.connections().length) return;
    const current = generation, base = options.base();
    const expected = options.connections().map(connectionObservationKey).join('|');
    const controller = new AbortController(); request = controller;
    const currentRequest = () => current === generation && !controller.signal.aborted && visible() && options.base() === base && options.connections().map(connectionObservationKey).join('|') === expected;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
      await Promise.all([
        api<RuntimeSnapshot>(`${base}/runtime-status`, signal).then(result => {
          if (!currentRequest()) return;
          snapshot.value = result; unavailable.value = !result?.employee;
        }).catch(cause => {
          if (!currentRequest()) return;
          snapshot.value = null; unavailable.value = true;
          if (cause instanceof ApiError && cause.status === 401) options.onSessionExpired();
        }),
        api<DirectoryConnection[]>(`${base}/channels`, signal).then(result => {
          if (!currentRequest()) return;
          identityLoaded.value = true;
          if (result.some(item => identity.value.some(old => old.id === item.id && old.appId === item.appId && ((old.revision ?? 0) > item.revision || (old.authRevision ?? 0) > item.authRevision)))) {
            identityUnavailable.value = true; return;
          }
          identity.value = result.map(({ id, sourceId, provider, appId, revision, authRevision,
            status, botId, tenantId, tenantIdNamespace, identityEvidence, inboundVerified, directoryStatus, lastError, enabled }) =>
            ({ id, sourceId, provider, appId, revision, authRevision, status, botId: botId ?? '', tenantId,
              tenantIdNamespace, identityEvidence, inboundVerified, directoryStatus, lastError: lastError ?? null, enabled }));
          identityUnavailable.value = false;
        }).catch(cause => {
          if (!currentRequest()) return;
          identityUnavailable.value = true;
          if (cause instanceof ApiError && cause.status === 401) options.onSessionExpired();
        }),
      ]);
    } catch (cause) {
      if (!currentRequest()) return;
      snapshot.value = null; unavailable.value = true;
      if (cause instanceof ApiError && cause.status === 401) options.onSessionExpired();
    } finally {
      if (current === generation && visible()) { request = undefined; timer = setTimeout(() => { void refresh(); }, 5000); }
    }
  }
  function visibilityChanged() { cancel(); snapshot.value = null; if (visible()) void refresh(); }
  document.addEventListener('visibilitychange', visibilityChanged);
  window.addEventListener('pagehide', cancel);
  window.addEventListener('pageshow', visibilityChanged);
  watch(() => [options.base(), options.active(), options.connections().map(connectionObservationKey).join('|')], () => {
    cancel(); snapshot.value = null; identity.value = []; identityLoaded.value = false; identityUnavailable.value = false; unavailable.value = false;
    if (visible()) void refresh();
  }, { immediate: true, flush: 'post' });
  onUnmounted(() => {
    disposed = true; cancel();
    document.removeEventListener('visibilitychange', visibilityChanged);
    window.removeEventListener('pagehide', cancel);
    window.removeEventListener('pageshow', visibilityChanged);
  });
  return { snapshot, unavailable, identity, identityUnavailable, identityLoaded, refresh };
}
