import {encodeSend,wireHash} from './media-wire.js';
import {randomUUID} from 'node:crypto';
import {fork, type ChildProcess} from 'node:child_process';
import {ChannelError, type ChannelSendReceipt, type SendChannelMessage, type ChannelIngressPort, type ChannelIngressSession, type ChannelIngressSink, type ChannelIngressStatus} from '@dentity/application';
import type {ChannelIngressCredentials} from '../../../channel-loop/ingress-types.js';

const states = new Set(['stopped', 'connecting', 'connected', 'reconnecting', 'failed']);
const errors = new Set(['ingress_connect_failed', 'ingress_disconnected', 'channel_transport_failed', 'channel_authentication_failed', 'channel_connection_taken_over', 'channel_ingress_persistence_failed']);
/** Internal construction seam for process lifecycle tests. Not user config. */
export interface SdkIngressProcessOptions {
  forkRunner?: () => ChildProcess;
  stopTimeoutMs?: number;
  startupTimeoutMs?: number;
}
export function createSdkIngress(session: ChannelIngressSession, credentials: ChannelIngressCredentials): ChannelIngressPort {
  return new SdkIngress(session, credentials);
}
export class SdkIngress implements ChannelIngressPort {
  private child: ChildProcess | undefined;
  private sink: ChannelIngressSink | undefined;
  private current: ChannelIngressStatus = {state: 'stopped', changedAt: Date.now()};
  private stopPromise: Promise<void> | undefined;
  private started = false;
  private stopped = false;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private exited = false;
  private readonly sends = new Map<string,{resolve:(receipt:ChannelSendReceipt)=>void;reject:(error:ChannelError)=>void;timer:ReturnType<typeof setTimeout>;committed:boolean;hash:string;deadline:number;request:SendChannelMessage}>();
  private rejectSends(){for(const pending of this.sends.values()){clearTimeout(pending.timer);pending.reject(new ChannelError(pending.committed?'delivery_unknown':'temporarily_unavailable',pending.committed?'channel_send_outcome_unknown':'channel_send_not_dispatched'));}this.sends.clear();}
  private readonly requests = new Set<string>();
  constructor(private readonly session: ChannelIngressSession, private readonly credentials: ChannelIngressCredentials, private readonly options: SdkIngressProcessOptions = {}) {}
  status(): ChannelIngressStatus {return {...this.current};}
  private update(status: ChannelIngressStatus): void {this.current = status; this.sink?.onStatus({...status});}
  async start(session: ChannelIngressSession, sink: ChannelIngressSink): Promise<void> {
    if (JSON.stringify(session) !== JSON.stringify(this.session)) throw new Error('ingress_session_mismatch');
    if (this.stopped) throw new Error('ingress_stopped');
    if (this.started) return;
    this.started = true;
    this.sink = sink;
    this.update({state: 'connecting', changedAt: Date.now()});
    // No inherited NODE_OPTIONS, preload hooks, proxy credentials or unrelated
    // secrets. stdout/stderr are intentionally discarded, including Ding SDK's
    // unconditional console.warn(error), which can contain ticket URLs.
    const child = this.options.forkRunner?.() ?? fork(new URL('./sdk-runner.js', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
      env: {PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? {SystemRoot: process.env.SystemRoot} : {})},
      serialization: 'json',
    });
    this.child = child;
    const fail = () => {
      if (this.stopped || this.child !== child) return;
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.rejectSends();
      this.update({state: 'failed', changedAt: Date.now(), error: 'channel_transport_failed'});
    };
    child.on('error', fail);
    child.on('exit', () => {this.exited = true; fail();});
    child.on('close', () => {this.exited = true; fail();});
    child.on('message', (value: unknown) => {
      if (this.stopped || this.child !== child || !value || typeof value !== 'object') return;
      const message = value as {type?: string; generation?: string; requestId?: string; envelope?: unknown; status?: ChannelIngressStatus; receipt?:ChannelSendReceipt; error?:string;nonce?:string;hash?:string;deadline?:number};
      if (message.generation !== this.session.generation) return;
      if(message.type==='send_prepared'&&message.requestId){
        const requestId=message.requestId,pending=this.sends.get(requestId);
        if(!pending||pending.committed||message.hash!==pending.hash||message.deadline!==pending.deadline||typeof message.nonce!=='string'||message.nonce.length>100)return;
        const nonce=message.nonce;
        void Promise.resolve().then(async()=>{
          await pending.request.beforeSend?.();
          if(pending.committed)return;
          if(this.sends.get(requestId)!==pending||this.stopped||this.child!==child||this.current.state!=='connected'||!child.connected||Date.now()>=pending.deadline)throw new ChannelError('not_ready');
          pending.request.assertSendAllowed?.();
          pending.committed=true;
          child.send({type:'send_commit',generation:this.session.generation,requestId,nonce,hash:pending.hash,deadline:pending.deadline},()=>{});
        }).catch(()=>{
          if(this.sends.get(requestId)!==pending)return;
          this.sends.delete(requestId);clearTimeout(pending.timer);pending.reject(new ChannelError('forbidden','channel_send_authorization_revoked'));
        });
        return;
      }
      if(message.type==='send_result'&&message.requestId){
        const pending=this.sends.get(message.requestId);if(!pending)return;this.sends.delete(message.requestId);clearTimeout(pending.timer);
        if(message.receipt&&message.receipt.status==='accepted'&&message.receipt.idempotent===false)pending.resolve({status:'accepted',idempotent:false,...(typeof message.receipt.providerRequestId==='string'&&message.receipt.providerRequestId.length<=256?{providerRequestId:message.receipt.providerRequestId}:{})});
        else pending.reject(new ChannelError(message.error==='not_ready'?'not_ready':message.error==='invalid_request'?'invalid_request':message.error==='rate_limited'?'rate_limited':message.error==='temporarily_unavailable'?'temporarily_unavailable':message.error==='forbidden'?'forbidden':'delivery_unknown'));
        return;
      }
      if (message.type === 'status' && message.status && states.has(message.status.state)) {
        if (message.status.state === 'connected' || message.status.state === 'failed') {
          if (this.startupTimer) clearTimeout(this.startupTimer);
        }
        if(message.status.state!=='connected')this.rejectSends();
        const error = message.status.error && errors.has(message.status.error) ? message.status.error : undefined;
        this.update({state: message.status.state, changedAt: Date.now(), ...(error ? {error} : {})});
      } else if (message.type === 'event' && typeof message.requestId === 'string' && message.requestId.length <= 100 && !this.requests.has(message.requestId)) {
        if (this.requests.size >= 128) return;
        const requestId = message.requestId;
        this.requests.add(requestId);
        const reply = (ok: boolean) => {
          this.requests.delete(requestId);
          // Both sides fence in-flight commits. Parent sink additionally checks
          // persistent generation/owner atomically with durable acceptance.
          if (this.stopped || this.child !== child || !child.connected) return;
          child.send({type: 'ack', generation: this.session.generation, requestId, ok}, () => {});
        };
        void Promise.resolve().then(() => {
          if (this.stopped || this.child !== child || !this.sink) throw new Error('ingress_stopped');
          return this.sink.onEvent(message.envelope);
        }).then(() => reply(true), () => reply(false));
      }
    });
    this.startupTimer = setTimeout(() => {fail(); void this.stop('startup_timeout');}, this.options.startupTimeoutMs ?? 45_000);
    child.send({type: 'start', session: this.session, credentials: this.credentials}, (error) => {if (error) fail();});
  }
  async send(request:SendChannelMessage):Promise<ChannelSendReceipt> {
    if(request.attachment&&this.session.provider!=='wecom')throw new ChannelError('unsupported');
    await request.beforeSend?.();
    const child=this.child;
    if(this.stopped||this.current.state!=='connected'||!child?.connected)throw new ChannelError('not_ready','channel_session_unavailable');
    if(request.attachment&&[...this.sends.values()].reduce((bytes,pending)=>bytes+(pending.request.attachment?.bytes.byteLength??0),request.attachment.bytes.byteLength)>40_000_000)throw new ChannelError('rate_limited','channel_media_busy');
    if(this.sends.size>=128)throw new ChannelError('rate_limited','channel_send_busy');
    request.assertSendAllowed?.();
    const requestId=randomUUID();
    // Explicit whitelist: functions and unrelated user properties cannot enter IPC.
    const wire=encodeSend(request),hash=wireHash(wire),deadline=Date.now()+15_000;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{const pending=this.sends.get(requestId);this.sends.delete(requestId);reject(new ChannelError(pending?.committed?'delivery_unknown':'temporarily_unavailable','channel_send_timeout'));},15_000);
      this.sends.set(requestId,{resolve,reject,timer,committed:!request.attachment,hash,deadline,request});
      child.send({type:'send',generation:this.session.generation,revision:this.session.revision,authRevision:this.session.authRevision,connectionId:this.session.connectionId,requestId,request:wire,hash,deadline},error=>{if(error){const pending=this.sends.get(requestId);if(pending){this.sends.delete(requestId);clearTimeout(timer);reject(new ChannelError(pending.committed?'delivery_unknown':'temporarily_unavailable'));}}});
    });
  }
  stop(_reason: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.rejectSends();
    if (this.startupTimer) clearTimeout(this.startupTimer);
    const sink = this.sink;
    this.sink = undefined;
    this.current = {state: 'stopped', changedAt: Date.now()};
    sink?.onStatus({...this.current});
    const child = this.child;
    this.stopPromise = new Promise<void>((resolve) => {
      if (!child || this.exited || child.exitCode !== null || child.signalCode !== null) {resolve(); return;}
      const timer = setTimeout(() => {child.kill('SIGKILL');}, this.options.stopTimeoutMs ?? 1_000);
      const done = () => {clearTimeout(timer); child.off('exit', done); child.off('close', done); resolve();};
      child.once('exit', done);
      child.once('close', done);
      if (child.connected) child.send({type: 'stop'}, () => {}); else child.kill('SIGTERM');
    });
    return this.stopPromise;
  }
}
