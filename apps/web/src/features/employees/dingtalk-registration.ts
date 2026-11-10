// Modified for Identale; see the root NOTICE.
import { computed, onUnmounted, ref, watch, type Ref } from 'vue';
import { api, ApiError } from '../../shared/api';
import type { DirectoryConnection } from '../directory/types';

interface RegistrationSession {
  sessionId: string;
  status: 'starting' | 'waiting' | 'ready' | 'failed' | 'expired' | 'cancelled' | 'consumed';
  expiresAt: number;
  pollAfterMs: number;
  verificationUrl?: string;
  clientId?: string;
  error?: string;
}
const messages: Record<string, string> = {
  source_invalid: '钉钉来源标识不可用，请联系管理员核对配置，或手动关联已有应用。',
  secret_key_unconfigured: '服务器尚未配置密钥加密存储，请联系管理员配置，或使用手动入口。',
  expired: '扫码会话已过期。如已完成创建，请绑定已有应用，避免重复创建。',
  cancelled: '扫码会话已取消，可重新开始或手动关联已有应用。',
  consumed: '扫码会话已使用，请刷新渠道状态核对绑定。',
  channel_unbind_required: '当前员工已有不同机器人，请核对换绑重置提示并明确确认替换。',
  channel_connection_conflict: '此机器人可能已被其他员工绑定，请核对并先解除原绑定，或选择其他应用。',
  channel_validation_failed: '机器人凭据验证未通过，请核对应用配置，或手动关联已有应用。',
  role_forbidden: '当前没有管理员权限，请联系工作区管理员。',
  busy: '扫码注册正在处理中，请稍后重新检查配置。',
  rejected: '钉钉未批准本次注册，请稍后重试，或关联已有应用。',
  channel_configuration_changed: '当前绑定已变化，请刷新渠道状态后重新开始。',
};
const safeMessage = (code?: string) => messages[(code ?? '').replace(/^dingtalk_registration_/, '')] ?? '扫码注册未完成，请核对渠道状态后重试，或手动关联已有应用。';

export function useDingtalkRegistration(options: {
  base: () => string; revision: () => number; appId: () => string | undefined;
  active: () => boolean; locked: () => boolean;
  onBound: (result: DirectoryConnection, replaced: boolean) => void;
  onSessionExpired: () => void;
}) {
  const open = ref(false), available = ref(false), checking = ref(false), requesting = ref(false), binding = ref(false);
  const uncertain = ref(false), now = ref(Date.now());
  const secondsLeft = computed(() => Math.max(0, Math.ceil(((session.value?.expiresAt ?? now.value) - now.value) / 1000)));
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  let autoAttempted = '';
  const session: Ref<RegistrationSession | null> = ref(null), message = ref(''), replaceSource = ref(false);
  const replacing = computed(() => !!options.appId() && !!session.value?.clientId && options.appId() !== session.value.clientId);
  let generation = 0, controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let owner: { path: string; id: string } | undefined;
  const path = () => `${options.base()}/channels/dingtalk/registration`;
  function clearTimer() { if (timer) clearTimeout(timer); timer = undefined; }
  function cleanup(keepalive = false) {
    generation++; clearTimer(); clearInterval(clockTimer); clockTimer = undefined; controller?.abort(); controller = undefined;
    const previous = owner; owner = undefined;
    open.value = false; available.value = false; checking.value = false; requesting.value = false; binding.value = false;
    session.value = null; message.value = ''; replaceSource.value = false; uncertain.value = false; autoAttempted = '';
    // The client-generated ID also fences a start that has not returned yet.
    if (previous) {
      const endpoint = `${previous.path}/${encodeURIComponent(previous.id)}`;
      if (keepalive) {
        // Unload delivery is best-effort. Capability lookup can recover a surviving session.
        void fetch(`/api${endpoint}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store', keepalive: true,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
      } else void api(endpoint, AbortSignal.timeout(8000), {}, 'DELETE').catch(() => {});
    }
  }
  function cancel() { cleanup(); }
  function pageHidden() { cleanup(true); }
  function fail(cause: unknown) {
    message.value = safeMessage(cause instanceof ApiError ? cause.code : undefined);
    if (cause instanceof ApiError && cause.status === 401) options.onSessionExpired();
  }
  async function show() {
    if (open.value || !options.active() || options.locked()) return;
    cancel(); open.value = true; checking.value = true;
    const token = generation, signal = (controller = new AbortController()).signal;
    try {
      const capability = await api<{ available: boolean; reason?: string; session?: RegistrationSession }>(path(), signal);
      if (token !== generation || signal.aborted) return;
      available.value = capability.available === true;
      if (!available.value) message.value = safeMessage(capability.reason);
      if (capability.session) {
        owner = { path: path(), id: capability.session.sessionId };
        accept(capability.session);
      }
    } catch (cause) { if (token === generation && !signal.aborted) fail(cause); }
    finally { if (token === generation) { checking.value = false; autoBind(); } }
  }
  async function begin() {
    if (checking.value || requesting.value || binding.value || options.locked()) return;
    const shown = show(), token = generation;
    await shown;
    if (token === generation && !message.value && !session.value) await start();
  }
  function schedule() {
    clearTimer();
    const current = session.value;
    if (!current || !['starting', 'waiting', 'ready'].includes(current.status)) return;
    const remaining = current.expiresAt - Date.now();
    if (remaining <= 0) {
      const keepOpen = open.value; cancel(); open.value = keepOpen;
      message.value = safeMessage('expired'); return;
    }
    if (uncertain.value) return;
    timer = setTimeout(() => {
      if (Date.now() >= current.expiresAt) schedule();
      else if (current.status !== 'ready' && document.visibilityState !== 'hidden') void poll();
      else schedule();
    }, Math.min(remaining, Math.max(1000, current.pollAfterMs || 1000)));
  }
  function accept(result: RegistrationSession) {
    if (typeof result.sessionId !== 'string' || !result.sessionId || result.sessionId !== owner?.id || !Number.isFinite(result.expiresAt) || !Number.isFinite(result.pollAfterMs)) throw new Error('invalid_session');
    if (result.verificationUrl) {
      const url = new URL(result.verificationUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !(url.hostname === 'dingtalk.com' || url.hostname.endsWith('.dingtalk.com'))) throw new Error('invalid_verification_url');
    }
    now.value = Date.now();
    if (!clockTimer) clockTimer = setInterval(() => { now.value = Date.now(); if (session.value && now.value >= session.value.expiresAt) schedule(); }, 1000);
    // Keep only the public DTO fields; credentials and device codes never enter reactive state.
    session.value = { sessionId: result.sessionId, status: result.status, expiresAt: result.expiresAt, pollAfterMs: result.pollAfterMs,
      ...(result.verificationUrl ? { verificationUrl: result.verificationUrl } : {}),
      ...(result.clientId ? { clientId: result.clientId } : {}), ...(result.error ? { error: result.error } : {}) };
    if (['failed', 'expired', 'cancelled', 'consumed'].includes(result.status)) { message.value = safeMessage(result.error ?? result.status); clearInterval(clockTimer); clockTimer = undefined; }
    schedule();
  }
  function autoBind() {
    if (uncertain.value || !open.value || options.appId() || session.value?.status !== 'ready' || autoAttempted === session.value.sessionId) return;
    autoAttempted = session.value.sessionId; void bind();
  }
  async function recover() {
    if (requesting.value || binding.value) return;
    const token = generation;
    uncertain.value = false; message.value = '';
    await poll();
    if (token === generation && !uncertain.value && session.value?.status === 'ready') await bind();
  }
  async function start() {
    if (!open.value || !available.value || checking.value || requesting.value || session.value || !options.active() || options.locked()) return;
    const token = generation, signal = controller!.signal;
    const id = crypto.randomUUID(); owner = { path: path(), id };
    requesting.value = true; message.value = '';
    try {
      const result = await api<RegistrationSession>(`${owner.path}/start`, signal, { sessionId: id, expectedRevision: options.revision() });
      if (token === generation && !signal.aborted) accept(result);
    } catch (cause) { if (token === generation && !signal.aborted) {
      // The start may have reached the server even if its response was lost.
      session.value = { sessionId: id, status: 'starting', expiresAt: Date.now() + 600000, pollAfterMs: 1000 };
      uncertain.value = true; fail(cause);
    } }
    finally { if (token === generation) { requesting.value = false; autoBind(); } }
  }
  async function poll() {
    if (!owner || !session.value || !options.active() || requesting.value || binding.value || document.visibilityState === 'hidden') return;
    const token = generation, signal = controller!.signal, current = owner;
    requesting.value = true;
    try {
      const result = await api<RegistrationSession>(`${current.path}/${current.id}/poll`, signal, {});
      if (token === generation && !signal.aborted) accept(result);
    } catch (cause) { if (token === generation && !signal.aborted) { clearTimer(); uncertain.value = true; fail(cause); } }
    finally { if (token === generation) { requesting.value = false; autoBind(); } }
  }
  async function bind() {
    if (!owner || session.value?.status !== 'ready' || binding.value || requesting.value || options.locked() || !options.active() || replacing.value && !replaceSource.value) return;
    if (session.value.expiresAt <= Date.now()) { schedule(); return; }
    const token = generation, signal = controller!.signal, current = owner, replaced = replacing.value;
    binding.value = true; clearTimer(); message.value = '';
    try {
      const result = await api<DirectoryConnection>(`${current.path}/${current.id}/bind`, signal, { replaceSource: replaced && replaceSource.value });
      if (token !== generation || signal.aborted) return;
      owner = undefined; cancel(); options.onBound(result, replaced);
    } catch (cause) {
      if (token === generation && !signal.aborted) {
        // Retain the session for an explicit state check, never create a second robot.
        uncertain.value = true; fail(cause);
      }
    } finally { if (token === generation) binding.value = false; }
  }
  function visibilityChanged() { if (document.visibilityState !== 'hidden') schedule(); }
  document.addEventListener('visibilitychange', visibilityChanged);
  window.addEventListener('pagehide', pageHidden);
  watch(() => [options.base(), options.revision(), options.appId(), options.active()], cancel, { flush: 'sync' });
  onUnmounted(() => { cancel(); document.removeEventListener('visibilitychange', visibilityChanged); window.removeEventListener('pagehide', pageHidden); });
  return { secondsLeft, begin, uncertain, recover, open, available, checking, requesting, binding, session, message, replaceSource, replacing, show, cancel, start, bind };
}
