import type {SendChannelMessage, ChannelSendReceipt} from './ports.js';
/** Server-internal ingress contract. A session value alone is not authentication. */
export interface ChannelIngressSession {
  connectionId: string;
  provider: 'feishu' | 'dingtalk' | 'wecom';
  appId: string;
  authRevision: number;
  revision: number;
  generation: string;
}
export interface ChannelIngressStatus {
  state: 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
  changedAt: number;
  error?: string;
}
export type ChannelIngressDisposition = 'accepted' | 'duplicate' | 'ignored';
/** Only wired to the actual child SDK instance by trusted composition code. */
export interface ChannelIngressSink {
  onEvent(envelope: unknown): Promise<ChannelIngressDisposition>;
  onStatus(status: ChannelIngressStatus): void;
}
export interface ChannelIngressPort {
  /** Resolves when startup is accepted, not when the network is ready. */
  start(session: ChannelIngressSession, sink: ChannelIngressSink): Promise<void>;
  /** Must terminate the SDK process after a bounded graceful shutdown. */
  stop(reason: string): Promise<void>;
  status(): ChannelIngressStatus;
  /** Optional same-session transport. Host guards never cross IPC. */
  send?(request: SendChannelMessage): Promise<ChannelSendReceipt>;
}
