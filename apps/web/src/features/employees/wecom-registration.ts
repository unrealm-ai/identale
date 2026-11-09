// Protocol reference: TencentCloudADP/adp-chat-client, client/packages/wecom-aibot-sdk.
// Keep this adapter separate from the server-side @wecom/aibot-node-sdk transport.
export const WECOM_REGISTRATION_ORIGIN = 'https://work.weixin.qq.com';
export const WECOM_REGISTRATION_SOURCE = 'identale';
export const WECOM_REGISTRATION_TIMEOUT_MS = 5 * 60_000;

export type WeComRegistrationStatus = 'waiting' | 'ready' | 'received' | 'cancelled' | 'blocked' | 'expired' | 'failed';
export type WeComRegistrationCredentials = { botId: string; secret: string };
type Options = {
  host: Window;
  onStatus: (status: WeComRegistrationStatus) => void;
  onCredentials: (credentials: WeComRegistrationCredentials) => void;
  timeoutMs?: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function credential(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** No network request or persistence: credentials go only to the current unsaved form. */
export function beginWeComRegistration(options: Options): { cancel: () => void } {
  const { host, onStatus, onCredentials } = options;
  const timeoutMs = options.timeoutMs ?? WECOM_REGISTRATION_TIMEOUT_MS;
  let popup: Window | null = null;
  let stopped = false;
  let poll: number | undefined;
  let timeout: number | undefined;
  let state: string;
  const deadline = Date.now() + timeoutMs;

  function cleanup() {
    host.removeEventListener('message', receive);
    host.removeEventListener('pagehide', cancel);
    host.removeEventListener('popstate', cancel);
    host.clearInterval(poll);
    host.clearTimeout(timeout);
    const previous = popup;
    popup = null;
    try { previous?.close(); } catch { /* The attempt is still invalidated locally. */ }
  }
  function finish(status: WeComRegistrationStatus, credentials?: WeComRegistrationCredentials) {
    if (stopped) return;
    // Consume the attempt before callbacks, close events, or another message can run.
    stopped = true;
    cleanup();
    onStatus(status);
    if (credentials) onCredentials(credentials);
  }
  function cancel() { finish('cancelled'); }
  function receive(event: MessageEvent<unknown>) {
    if (stopped || !popup || event.origin !== WECOM_REGISTRATION_ORIGIN || event.source !== popup) return;
    if (Date.now() >= deadline) { finish('expired'); return; }
    const data = event.data;
    if (!record(data) || typeof data['type'] !== 'string') return;
    const payload = data['payload'];
    // Public BotInfo only promises botid/secret. Do not invent a mandatory state echo.
    // If either supported envelope position does carry state, it must match exactly.
    if (('state' in data && data['state'] !== state) || (record(payload) && 'state' in payload && payload['state'] !== state)) {
      finish('failed'); return;
    }
    switch (data['type']) {
      case 'QR_CODE_READY': onStatus('ready'); return;
      case 'AUTH_SUCCESS':
        if (!record(payload) || !credential(payload['botid'], 256) || !credential(payload['secret'], 8192)) { finish('failed'); return; }
        finish('received', { botId: payload['botid'], secret: payload['secret'] }); return;
      case 'AUTH_CANCEL':
      case 'WINDOW_CLOSE': finish('cancelled'); return;
      case 'AUTH_ERROR': finish('failed'); return;
    }
  }

  onStatus('waiting');
  try {
    state = host.crypto.randomUUID();
    const url = new URL('/ai/qc/gen', WECOM_REGISTRATION_ORIGIN);
    url.search = new URLSearchParams({ source: WECOM_REGISTRATION_SOURCE, state, timestamp: String(Date.now()) }).toString();
    host.addEventListener('message', receive);
    host.addEventListener('pagehide', cancel);
    host.addEventListener('popstate', cancel);
    // A fresh name prevents another tab or previous attempt from reusing this WindowProxy.
    // The official popup needs opener to post its result; never add noopener here.
    popup = host.open(url.href, `IdentaleWeCom_${state}`, 'width=950,height=640,resizable=yes,scrollbars=yes');
    if (!popup) { finish('blocked'); return { cancel }; }
    timeout = host.setTimeout(() => finish('expired'), timeoutMs);
    poll = host.setInterval(() => {
      if (popup?.closed) finish('cancelled');
      else if (Date.now() >= deadline) finish('expired');
    }, 500);
  } catch {
    // Never surface provider payloads or browser exceptions containing credentials/URLs.
    finish('failed');
  }
  return { cancel };
}
