import {ProviderInvocationError} from './types.js';
import { fork } from 'node:child_process';
import { invocationEnvironment } from './environment.js';
import {sanitizeModelDiagnostic,modelLifecycleDiagnostic}from'./model-diagnostics.js';
import type { PiDriver, DriverInvocation, DriverControl, DriverEvent, DriverSteeringInput } from './types.js';
/** New OS process for every invocation; not a sandbox. No ambient environment inheritance. */
export class WorkerPiDriver implements PiDriver {
  readonly supportsSteer = true;
  constructor(private readonly readAsset?:(input:DriverInvocation,id:string,kind:'content'|'summary'|'transcript')=>Promise<import('./asset-materializer.js').HostAssetResult>,private readonly readHistory?:(input:DriverInvocation,operation:import('@dentity/contracts').ContextHistoryOperation,query:unknown)=>Promise<unknown>,private readonly workItems?:(input:DriverInvocation,operation:import('@dentity/contracts').WorkItemOperation,query:unknown)=>Promise<unknown>,private readonly captureInvalidModelResponses=false,private readonly publishArtifact?:(input:DriverInvocation,path:string,operationId:string)=>Promise<unknown>){}
  start(input: DriverInvocation, emit: (event: DriverEvent) => void | Promise<void>): DriverControl {
    const child = fork(new URL('./pi-worker.js', import.meta.url), [], {
      env: { ...invocationEnvironment(input.context), PATH: '/usr/bin:/bin', HOME: input.sessionDirectory },
      execArgv: [], stdio: ['ignore','ignore','ignore','ipc'], serialization: 'json',
    });
    const startedAt=new Date().toISOString();let abortSource:'host_cancel'|'host_timeout'|undefined;
    let providerRejected:number|undefined;let waiting:string|undefined,itemBoundary:import('@dentity/contracts').WorkItemBoundary|undefined;
    let finished = false; let cancelRequested = false; let commandSequence = 0;
    let settleCancel: ((value: 'confirmed' | 'unknown') => void) | undefined;
    const steering = new Map<number, (status: 'queued' | 'closed' | 'unknown') => void>();
    const clearSteering = () => { for (const settle of steering.values()) settle('unknown'); steering.clear(); };
    const done = new Promise<Awaited<DriverControl['done']>>((resolve, reject) => {
      child.on('message', (raw: unknown) => {
        const m = raw as { type?: string; text?: string; id?: number; status?: string;assetId?:string;kind?:string } & Partial<DriverSteeringInput> & { requestId?: string; messageEntryId?: string };
        if(m.type==='artifact_publish'&&typeof m.id==='number'){const q=raw as {id:number;path:unknown;operationId:unknown};if(!input.spec.platformTools.includes('artifact.publish')||typeof q.path!=='string'||typeof q.operationId!=='string'||!this.publishArtifact){if(child.connected)child.send({type:'artifact_result',id:q.id,result:{error:'artifact_not_granted'}});return;}void this.publishArtifact(input,q.path,q.operationId).then(result=>{if(child.connected)child.send({type:'artifact_result',id:q.id,result});},()=>{if(child.connected)child.send({type:'artifact_result',id:q.id,result:{error:'artifact_publication_failed'}});});return;}
        if(m.type==='asset_read'&&typeof m.id==='number'){const id=m.id;const allowed=input.assets?.some(a=>a.assetId===m.assetId);if(!allowed||!this.readAsset||!['content','summary','transcript'].includes(m.kind??'')){if(child.connected)child.send({type:'asset_result',id,result:{state:'no_permission',reason:'asset_not_authorized'}});return;}void this.readAsset(input,m.assetId!,m.kind as 'content'|'summary'|'transcript').then(result=>{if(child.connected)child.send({type:'asset_result',id,result});},()=>{if(child.connected)child.send({type:'asset_result',id,result:{state:'failed',reason:'asset_read_failed'}});});return;}
        if(m.type==='group_history'&&typeof m.id==='number'){const raw= m as typeof m&{operation:import('@dentity/contracts').ContextHistoryOperation;query:unknown};if(!(input.spec.platformTools.includes('group.history')||input.spec.platformTools.includes('trigger.history'))||!this.readHistory||!['list','read','contexts','trigger_list','trigger_record'].includes(raw.operation)){if(child.connected)child.send({type:'group_history_result',id:m.id,result:{error:'history_not_granted'}});return;}void this.readHistory(input,raw.operation,raw.query).then(result=>{if(child.connected)child.send({type:'group_history_result',id:m.id,result});},()=>{if(child.connected)child.send({type:'group_history_result',id:m.id,result:{error:'history_unavailable'}});});return;}
        const receipt = m.type === 'input_queued' || m.type === 'input_applied';
        if(m.type==='work_item'&&typeof m.id==='number'){if(!input.spec.platformTools.includes('work.item')){if(child.connected)child.send({type:'work_item_result',id:m.id,result:{error:'work_item_tools_not_granted'}});return;}const operation=(raw as {operation:import('@dentity/contracts').WorkItemOperation}).operation;void Promise.resolve().then(()=>this.workItems?.(input,operation,(raw as {query:unknown}).query)??{error:'work_item_unavailable'}).then(result=>{if(child.connected)child.send({type:'work_item_result',id:m.id,result});},()=>{if(child.connected)child.send({type:'work_item_result',id:m.id,result:{error:'work_item_unavailable'}});});return;}
        const guarded = m.type==='model_diagnostic'||m.type==='human_request'||m.type === 'progress' || m.type === 'before_tool' || m.type === 'before_request' || m.type === 'tool_unknown';
        if (typeof m.id === 'number' && (receipt || guarded)) {
          const diagnostic=m.type==='model_diagnostic'?sanitizeModelDiagnostic((raw as {diagnostic:unknown}).diagnostic,[input.profile.apiKey]):undefined;
          if(m.type==='model_diagnostic'&&!diagnostic){if(child.connected)child.send({type:'progress_ack',id:m.id,ok:false});return;}
          const event = diagnostic?{type:'model_diagnostic',diagnostic}as DriverEvent:m.type==='human_request'?{type:'human_request',requestId:m.requestId,question:(raw as {question:unknown}).question} as DriverEvent:receipt ? { type: m.type, inputId: m.inputId, revision: m.revision, contentDigest: m.contentDigest, ...(m.type === 'input_applied' ? { requestId: m.requestId, messageEntryId: m.messageEntryId } : {}) } as DriverEvent : { type: m.type, text: m.text } as DriverEvent;
          void Promise.resolve().then(() => emit(event)).then(() => { if (child.connected) child.send({ type: 'progress_ack', id: m.id, ok: true }); }, () => { if (child.connected) child.send({ type: 'progress_ack', id: m.id, ok: false }); });
        }
        if (m.type === 'steer_result' && typeof m.id === 'number') { steering.get(m.id)?.(m.status === 'queued' || m.status === 'closed' ? m.status : 'unknown'); steering.delete(m.id); }
        if (m.type === 'output_delta' && typeof m.text === 'string') void Promise.resolve(emit({ type: 'output_delta', text: m.text })).catch(() => { child.kill(); reject(new Error('Event persistence failed')); });
        if(m.type==='work_item_boundary'){itemBoundary=(raw as{boundary:import('@dentity/contracts').WorkItemBoundary}).boundary;clearSteering();}
        if(m.type==='human_wait'&&typeof m.requestId==='string'){waiting=m.requestId;clearSteering();}
        if (m.type === 'result' && typeof m.text === 'string') { finished = true; clearSteering(); resolve(m.text); }
        if (m.type === 'canceled') { finished = true; clearSteering(); settleCancel?.('confirmed'); resolve(''); }
        if (m.type === 'failed') { clearSteering();const rejection=(raw as {providerRejected?:unknown}).providerRejected;if(Number.isInteger(rejection)&&Number(rejection)>=400&&Number(rejection)<=599)providerRejected=Number(rejection);else{finished=true;reject(new Error('Pi worker failed'));} }
      });
      child.on('error', () => { clearSteering(); settleCancel?.('unknown'); reject(new Error('Pi worker unavailable')); });
      child.on('exit', (code,signal) => {clearSteering();void Promise.resolve().then(()=>emit({type:'model_diagnostic',diagnostic:modelLifecycleDiagnostic('worker_exit',{startedAt,exitCode:code,exitSignal:signal as 'SIGTERM'|null,...(abortSource?{abortSource}:{}),timeoutObserved:abortSource==='host_timeout'})})).catch(()=>{}).finally(()=>{if(itemBoundary&&code===0&&!cancelRequested){finished=true;resolve({kind:'work_item_boundary',boundary:itemBoundary});}if(waiting&&code===0&&!cancelRequested){finished=true;resolve({kind:'needs_human',requestId:waiting});}if(providerRejected&&code===0&&!cancelRequested){finished=true;reject(new ProviderInvocationError(providerRejected));}if(!finished){settleCancel?.(cancelRequested?'confirmed':'unknown');reject(new Error('Pi worker exited without result'));}});});
    });
    child.send({ type: 'start', input:{...input,captureInvalidModelResponses:this.captureInvalidModelResponses} });
    return { done, steer: (value: DriverSteeringInput) => {
      if (finished || cancelRequested || !child.connected) return Promise.resolve('closed');
      return new Promise(resolve => {
        const id = ++commandSequence;
        const timer = setTimeout(() => { steering.delete(id); resolve('unknown'); }, 10_000).unref();
        steering.set(id, status => { clearTimeout(timer); resolve(status); });
        child.send({ type: 'append_input', id, input: value }, error => { if (error) { steering.get(id)?.('unknown'); steering.delete(id); } });
      });
    }, cancel: (reason='host_cancel') => {
      if (finished) return Promise.resolve('confirmed'); cancelRequested = true;abortSource=reason;void Promise.resolve().then(()=>emit({type:'model_diagnostic',diagnostic:modelLifecycleDiagnostic('cancel_requested',{startedAt,abortSource:reason,timeoutObserved:reason==='host_timeout'})})).catch(()=>{});
      return new Promise(resolve => { settleCancel = resolve; if (!child.connected) { resolve('unknown'); return; } child.send({ type: 'cancel' }); setTimeout(() => resolve('requested'), 1000).unref(); });
    } };
  }
}
