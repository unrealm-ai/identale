import {startWeComClient} from './wecom.js';
import type {WSClient as WeComClient} from '@wecom/aibot-node-sdk';
import {EventDispatcher, WSClient} from '@larksuiteoapi/node-sdk';
import {DWClient, TOPIC_ROBOT} from 'dingtalk-stream';
import type {ChannelIngressSession, ChannelIngressStatus} from '@dentity/application';
import type {ChannelIngressCredentials} from '../../../channel-loop/ingress-types.js';

const silentLogger = {error() {}, warn() {}, info() {}, debug() {}, trace() {}};
const MAX_ENVELOPE_BYTES = 1024 * 1024;
export interface SdkBridge {
  onEvent(envelope: unknown): Promise<unknown>;
  onStatus(status: ChannelIngressStatus): void;
}
/** Test-only injection seam, never populated from persisted config or IPC. */
export interface SdkFactories {
  lark?: (options: ConstructorParameters<typeof WSClient>[0]) => WSClient;
  wecom?: (options: ConstructorParameters<typeof WeComClient>[0]) => WeComClient;
  ding?: (options: ConstructorParameters<typeof DWClient>[0]) => DWClient;
}
class RawEventDispatcher extends EventDispatcher {
  constructor(private readonly receive: (envelope: unknown) => Promise<unknown>) { super({logger: silentLogger}); }
  override async invoke(data: unknown): Promise<unknown> {
    // WSClient passes the parsed assembled event envelope. Do not use SDK's default
    // flattened dispatcher: event fields could overwrite authoritative header.
    if (!data || typeof data !== 'object' || Buffer.byteLength(JSON.stringify(data)) > MAX_ENVELOPE_BYTES) throw new Error('ingress_invalid_envelope');
    await this.receive(data);
    return undefined;
  }
}

export function startSdkClient(session: ChannelIngressSession, credentials: ChannelIngressCredentials, bridge: SdkBridge, factories: SdkFactories = {}): {stop(): void; send?: import('@dentity/application').ChannelIngressPort['send']} {
  if (session.provider === 'wecom') return startWeComClient(session, credentials, bridge, factories.wecom);
  if (!credentials.appSecret) throw new Error('invalid_ingress_credentials');
  let stopped = false;
  let lastState: ChannelIngressStatus['state'] | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const status = (state: ChannelIngressStatus['state'], error?: string) => {
    if (stopped || lastState === state) return;
    lastState = state;
    bridge.onStatus({state, changedAt: Date.now(), ...(error ? {error} : {})});
  };
  const receive = async (envelope: unknown) => {
    if (stopped) throw new Error('ingress_stopped');
    if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_ENVELOPE_BYTES) throw new Error('ingress_invalid_envelope');
    await bridge.onEvent(envelope);
    if (stopped) throw new Error('ingress_stopped');
  };
  status('connecting');
  if (session.provider === 'feishu') {
    const options: ConstructorParameters<typeof WSClient>[0] = {
      appId: session.appId, appSecret: credentials.appSecret, logger: silentLogger,
      autoReconnect: true, handshakeTimeoutMs: 15_000,
      onReady: () => status('connected'), onReconnected: () => status('connected'),
      onReconnecting: () => status('reconnecting'),
      // Locked 1.76.0 formats its typed ErrorCode.auth_failed/forbidden
      // as this exact prefix; never forward the provider's raw message.
      onError: (error) => status('failed', /^pullConnectConfig failed: code=(514|403),/.test(error.message) ? 'channel_authentication_failed' : 'channel_transport_failed'),
    };
    const client = factories.lark ? factories.lark(options) : new WSClient(options);
    void Promise.resolve(client.start({eventDispatcher: new RawEventDispatcher(receive)})).catch(() => status('failed', 'ingress_connect_failed'));
    return {stop() {if (stopped) return; stopped = true; client.close({force: true});}};
  }
  const options = {clientId: session.appId, clientSecret: credentials.appSecret, debug: false, keepAlive: true};
  const client = factories.ding ? factories.ding(options) : new DWClient(options);
  // SDK defaultConfig holds a shared EVENT '*' subscriptions array. Replace,
  // never mutate it; callbacks and event ACK have different semantics.
  client.config.subscriptions = [];
  client.config.autoReconnect = false;
  const getEndpoint = client.getEndpoint.bind(client);
  client.getEndpoint = async () => {
    try {return await getEndpoint();} catch (error) {
      // Official authenticated discovery uses Axios. Inspect only structured
      // HTTP auth status, before connect() swallows the exception.
      const response = error && typeof error === 'object' && 'response' in error ? error.response : undefined;
      if (response && typeof response === 'object' && 'status' in response && (response.status === 401 || response.status === 403)) status('failed', 'channel_authentication_failed');
      throw error;
    }
  };
  client.registerCallbackListener(TOPIC_ROBOT, (envelope) => {
    if (stopped || !client.connected || envelope.type !== 'CALLBACK' || envelope.headers?.topic !== TOPIC_ROBOT) return;
    void receive(envelope).then(() => {
      if (!stopped && client.connected) client.socketCallBackResponse(envelope.headers.messageId, {status: 'SUCCESS'});
    }).catch(() => {
      // No success response on persistence failure. CALLBACK delivery/retry is
      // the provider's responsibility, not an EVENT acknowledgement contract.
    });
  });
  // Even an unexpected server EVENT must never reach the SDK's auto-success
  // handler: only robot CALLBACK is subscribed and admitted.
  client.onEvent = () => {};
  let connectedOnce = false;
  poll = setInterval(() => {
    if (client.connected) {connectedOnce = true; status('connected');}
    else if (connectedOnce) status('failed', 'ingress_disconnected');
  }, 100);
  void client.connect().then(() => {
    if (stopped) {client.disconnect(); return;}
    if (client.connected) {connectedOnce = true; status('connected');}
    else status('failed', 'ingress_connect_failed');
  }).catch(() => status('failed', 'ingress_connect_failed'));
  return {stop() {if (stopped) return; stopped = true; if (poll) clearInterval(poll); client.disconnect();}};
}
