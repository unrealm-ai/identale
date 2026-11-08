import {decodeSend,wireHash,type SendWire} from './media-wire.js';
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
const commits=new Map<string,{nonce:string;hash:string;deadline:number;resolve():void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
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
  for(const commit of commits.values()){clearTimeout(commit.timer);commit.reject(new ChannelError('not_ready'));}commits.clear();
  try {client?.stop();} catch { /* Never expose SDK errors. */ }
  process.exit(0);
}
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', () => {send({type: 'status', generation, status: {state: 'failed', changedAt: Date.now(), error: 'channel_transport_failed'}}); shutdown();});
process.on('unhandledRejection', () => {send({type: 'status', generation, status: {state: 'failed', changedAt: Date.now(), error: 'channel_transport_failed'}}); shutdown();});
process.on('message', (value: unknown) => {
  if (!value || typeof value !== 'object' || !('type' in value)) return;
  const message = value as {type: string; generation?: string; requestId?: string; ok?: boolean; session?: ChannelIngressSession; credentials?: ChannelIngressCredentials; request?: SendWire; hash?:string; deadline?:number; nonce?:string; revision?: number; authRevision?:number; connectionId?:string};
  if (message.type === 'stop') {shutdown(); return;}
  if(message.type==='send_commit'){
    const commit=message.requestId?commits.get(message.requestId):undefined;
    if(!commit||closing||message.generation!==generation||message.nonce!==commit.nonce||message.hash!==commit.hash||message.deadline!==commit.deadline||Date.now()>=commit.deadline)return;
    commits.delete(message.requestId!);clearTimeout(commit.timer);commit.resolve();return;
  }
  if (message.type === 'send') {
    if(closing||!session||!client?.send||message.generation!==generation||message.connectionId!==session.connectionId||message.revision!==session.revision||message.authRevision!==session.authRevision||!message.requestId||!message.request||sends.has(message.requestId))return;
    const requestId=message.requestId;
    if(sends.size>=128){send({type:'send_result',generation,requestId,error:'rate_limited'});return;}
    sends.add(requestId);
    const wire=message.request;
    let request:SendChannelMessage;
    try{request=decodeSend(wire);}catch{send({type:'send_result',generation,requestId,error:'invalid_request'});sends.delete(requestId);return;}
    if(request.attachment){
      const deadline=message.deadline,hash=message.hash;
      if(typeof deadline!=='number'||!Number.isSafeInteger(deadline)||deadline<=Date.now()||deadline>Date.now()+15_000||hash!==wireHash(wire)){send({type:'send_result',generation,requestId,error:'invalid_request'});sends.delete(requestId);return;}
      request.beforeSend=()=>new Promise<void>((resolve,reject)=>{
        if(closing){reject(new ChannelError('not_ready'));return;}
        if(Date.now()>=deadline){reject(new ChannelError('temporarily_unavailable','channel_send_timeout'));return;}
        const nonce=randomUUID(),timer=setTimeout(()=>{commits.delete(requestId);reject(new ChannelError('temporarily_unavailable','channel_send_timeout'));},Math.max(1,deadline-Date.now()));
        commits.set(requestId,{nonce,hash,deadline,resolve,reject,timer});
        send({type:'send_prepared',generation,requestId,nonce,hash,deadline});
      });
      request.assertSendAllowed=()=>{if(closing)throw new ChannelError('not_ready');if(Date.now()>=deadline)throw new ChannelError('temporarily_unavailable','channel_send_timeout');};
    }
    void client.send(request).then(receipt=>send({type:'send_result',generation,requestId,receipt}),error=>send({type:'send_result',generation,requestId,error:error instanceof ChannelError?error.code:'delivery_unknown'})).finally(()=>sends.delete(requestId));
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
