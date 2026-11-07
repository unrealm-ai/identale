import {randomUUID} from 'node:crypto';
import {startSdkClient, type SdkFactories} from './sdk-client.js';
import {ChannelError, type SendChannelMessage, type ChannelIngressSession} from '@dentity/application';
import type {ChannelIngressCredentials} from '../../../channel-loop/ingress-types.js';

export function runSdkRunner(factories: SdkFactories = {}): void {
// This file is exclusively a fork entrypoint. Credentials travel over the
// private IPC channel, never argv, environment, stdout, or stderr.
let generation: string | undefined;
let session: ChannelIngressSession | undefined;
const sends = new Set<string>();
let client: ReturnType<typeof startSdkClient> | undefined;
let closing = false;
const pending = new Map<string, {resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>}>();
function send(message: unknown): void {
  if (!process.connected || !process.send) return shutdown();
  process.send(message as Parameters<NonNullable<typeof process.send>>[0], (error) => {if (error) shutdown();});
}
function shutdown(): void {
  if (closing) return;
  closing = true;
  for (const request of pending.values()) {clearTimeout(request.timer); request.reject(new Error('ingress_stopped'));}
  pending.clear();
  try {client?.stop();} catch { /* Never expose SDK errors. */ }
  process.exit(0);
}
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', () => {send({type: 'status', generation, status: {state: 'failed', changedAt: Date.now(), error: 'channel_transport_failed'}}); shutdown();});
process.on('unhandledRejection', () => {send({type: 'status', generation, status: {state: 'failed', changedAt: Date.now(), error: 'channel_transport_failed'}}); shutdown();});
process.on('message', (value: unknown) => {
  if (!value || typeof value !== 'object' || !('type' in value)) return;
  const message = value as {type: string; generation?: string; requestId?: string; ok?: boolean; session?: ChannelIngressSession; credentials?: ChannelIngressCredentials; request?: SendChannelMessage; revision?: number; authRevision?:number; connectionId?:string};
  if (message.type === 'stop') {shutdown(); return;}
  if (message.type === 'send') {
    if(closing||!session||!client?.send||message.generation!==generation||message.connectionId!==session.connectionId||message.revision!==session.revision||message.authRevision!==session.authRevision||!message.requestId||!message.request||sends.has(message.requestId))return;
    const requestId=message.requestId;
    if(sends.size>=128){send({type:'send_result',generation,requestId,error:'rate_limited'});return;}
    sends.add(requestId);
    void client.send(message.request).then(receipt=>send({type:'send_result',generation,requestId,receipt}),error=>send({type:'send_result',generation,requestId,error:error instanceof ChannelError?error.code:'delivery_unknown'})).finally(()=>sends.delete(requestId));
    return;
  }
  if (message.type === 'ack' && message.generation === generation && message.requestId) {
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId); clearTimeout(request.timer);
    if (message.ok === true) request.resolve(); else request.reject(new Error('ingress_not_accepted'));
    return;
  }
  if (message.type !== 'start' || generation || closing || !message.session || !message.credentials) return;
  session = message.session;
  generation = message.session.generation;
  client = startSdkClient(message.session, message.credentials, {
    onStatus: (status) => send({type: 'status', generation, status}),
    onEvent: async (envelope) => {
      if (closing || pending.size >= 128) throw new Error('ingress_overloaded');
      const requestId = randomUUID();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {pending.delete(requestId); reject(new Error('ingress_accept_timeout'));}, 20_000);
        pending.set(requestId, {resolve, reject, timer});
        send({type: 'event', generation, requestId, envelope});
      });
    },
  }, factories);
});
}
