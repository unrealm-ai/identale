import{modelLifecycleDiagnostic,type ModelFailureDiagnostic}from'./model-diagnostics.js';
import { randomUUID } from 'node:crypto';
import { createPiSession } from './pi-session.js';
import { messageText, steeringText,requestContainsSteering } from './steering.js';
import type { DriverEvent, DriverInvocation, DriverSteeringInput } from './types.js';
let session: Awaited<ReturnType<typeof createPiSession>>['session'] | undefined;
let closeMcp: (() => Promise<void>) | undefined;
let reportId = 0;
const itemWaiters=new Map<number,{resolve:(v:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
function workItems(operation:import('@dentity/contracts').WorkItemOperation,query:unknown):Promise<unknown>{return new Promise(resolve=>{const id=++reportId,timer=setTimeout(()=>{itemWaiters.delete(id);resolve({error:'work_item_timeout'});},25000);itemWaiters.set(id,{resolve,timer});send({type:'work_item',id,operation,query});});}
const artifactWaiters=new Map<number,{resolve:(value:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
function publishArtifact(path:string,operationId:string):Promise<unknown>{return new Promise((resolve,reject)=>{const id=++reportId,timer=setTimeout(()=>{artifactWaiters.delete(id);reject(Error('Artifact publication outcome unknown'));},35000);artifactWaiters.set(id,{resolve,timer});send({type:'artifact_publish',id,path,operationId});});}
const historyWaiters=new Map<number,{resolve:(v:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
function readHistory(operation:import('@dentity/contracts').ContextHistoryOperation,query:unknown):Promise<unknown>{return new Promise(resolve=>{const id=++reportId,timer=setTimeout(()=>{historyWaiters.delete(id);resolve({error:'history_timeout'});},25000);historyWaiters.set(id,{resolve,timer});send({type:'group_history',id,operation,query});});}
const assetWaiters=new Map<number,{resolve:(value:import('./asset-materializer.js').HostAssetResult)=>void;timer:ReturnType<typeof setTimeout>}>();
function readAsset(assetId:string,kind:'content'|'summary'|'transcript'):Promise<import('./asset-materializer.js').HostAssetResult>{return new Promise(resolve=>{const id=++reportId,timer=setTimeout(()=>{assetWaiters.delete(id);resolve({state:'pending',reason:'asset_wait_timeout'});},35000);assetWaiters.set(id,{resolve,timer});send({type:'asset_read',id,assetId,kind});});}
const progressWaiters = new Map<number, { resolve(): void; reject(): void }>();
let started = false; let canceled = false; let accepting = true; let promptActive = false;
let readyResolve!: () => void; let readyReject!: () => void;
const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = () => reject(new Error('Session unavailable')); });
void ready.catch(() => {});
let steerTail = Promise.resolve();
const inputs = new Map<string, { input: DriverSteeringInput; text: string; queued: Promise<void>; applied: boolean }>();
const send = (message: unknown) => { if (process.connected) process.send?.(message); };
type GuardedEvent = Exclude<DriverEvent, { type: 'output_delta' }>;
function requestHost(event: GuardedEvent): Promise<void> { return new Promise<void>((resolve, reject) => { const id = ++reportId; const timer = setTimeout(() => { progressWaiters.delete(id); reject(new Error('Operation confirmation unavailable')); }, 10_000); progressWaiters.set(id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: () => { clearTimeout(timer); reject(new Error('Operation not permitted')); } }); send({ ...event, id }); }); }
process.on('message', (raw: unknown) => {
  const message = raw as { type?: string; input?: DriverInvocation | DriverSteeringInput; id?: number; ok?: boolean;result?:import('./asset-materializer.js').HostAssetResult };
  if(message.type==='artifact_result'&&typeof message.id==='number'){const w=artifactWaiters.get(message.id);if(w){clearTimeout(w.timer);artifactWaiters.delete(message.id);w.resolve(message.result);}return;}
  if(message.type==='work_item_result'&&typeof message.id==='number'){const w=itemWaiters.get(message.id);if(w){clearTimeout(w.timer);itemWaiters.delete(message.id);w.resolve(message.result);}return;}
  if(message.type==='group_history_result'&&typeof message.id==='number'){const w=historyWaiters.get(message.id);if(w){clearTimeout(w.timer);historyWaiters.delete(message.id);w.resolve(message.result);}return;}
  if(message.type==='asset_result'&&typeof message.id==='number'&&message.result){const waiter=assetWaiters.get(message.id);if(waiter){clearTimeout(waiter.timer);assetWaiters.delete(message.id);waiter.resolve(message.result);}return;}
  if (message.type === 'progress_ack' && message.id !== undefined) { const waiter = progressWaiters.get(message.id); progressWaiters.delete(message.id); if (message.ok) waiter?.resolve(); else waiter?.reject(); return; }
  if (message.type === 'cancel') { canceled = true; accepting = false; void session?.abort(); return; }
  if (message.type === 'append_input' && typeof message.id === 'number') {
    const id = message.id; const value = message.input as DriverSteeringInput;
    if (!accepting || canceled) { send({ type: 'steer_result', id, status: 'closed' }); return; }
    steerTail = steerTail.then(async () => {
      await ready;
      if (!accepting || !promptActive || canceled || !session) { send({ type: 'steer_result', id, status: 'closed' }); return; }
      if (inputs.has(value.inputId)) throw new Error('Duplicate steering IPC');
      const text = steeringText(value);
      let queueResolve!: () => void; let queueReject!: (error: Error) => void;
      const queued = new Promise<void>((resolve, reject) => { queueResolve = resolve; queueReject = reject; }); void queued.catch(() => {});
      // Register before SDK enqueues: its next request can race the queued receipt.
      const record = { input: value, text, queued, applied: false }; inputs.set(value.inputId, record);
      try {
        if (await session.steer(text) !== 'queued') throw new Error('Steering was handled without queueing');
        await requestHost({ type: 'input_queued', inputId: value.inputId, revision: value.revision, contentDigest: value.contentDigest });
        queueResolve(); send({ type: 'steer_result', id, status: 'queued' });
      } catch (error) { queueReject(new Error('Steering not acknowledged')); throw error; }
    }).catch(() => { send({ type: 'steer_result', id, status: 'unknown' }); });
    return;
  }
  if (message.type !== 'start' || started || !message.input) return;
  started = true; const input = message.input as DriverInvocation;
  void (async () => {
    try {
      let currentRequest:ModelFailureDiagnostic|undefined,firstOutput=false,providerRejected:number|undefined;
      let created: Awaited<ReturnType<typeof createPiSession>>;
      created = await createPiSession(input, text => requestHost({ type: 'progress', text: text.split(input.profile.apiKey).join('[redacted]') }), name => requestHost({ type: 'before_tool', text: name }), async name => { await requestHost({ type: 'tool_unknown', text: name }); canceled = true; accepting = false; void session?.abort(); }, async payload => {
        await requestHost({ type: 'before_request', text: '' });
        const requestMessages=input.profile.protocol==='openai_responses'?payload['input']:payload['messages'];
        if (!Array.isArray(requestMessages)) throw new Error('Provider messages unavailable');
        const requestId = randomUUID();
        for (const record of inputs.values()) {
          if (record.applied || !requestContainsSteering(payload,input.profile.protocol,record.text)) continue;
          await record.queued;
          const entry = created.manager.getBranch().find(e => e.type === 'message' && e.message.role === 'user' && messageText(e.message.content) === record.text);
          if (!entry) throw new Error('Native consumption entry unavailable');
          await requestHost({ type: 'input_applied', inputId: record.input.inputId, revision: record.input.revision, contentDigest: record.input.contentDigest, requestId, messageEntryId: entry.id });
          record.applied = true;
        }
      },readAsset,question=>requestHost({type:'human_request',requestId:input.humanRequestId!,question}),async diagnostic=>{if(diagnostic.phase==='response'&&diagnostic.httpStatus&&diagnostic.httpStatus>=400)providerRejected=diagnostic.httpStatus;await requestHost({type:'model_diagnostic',diagnostic});},async diagnostic=>{if(diagnostic.event==='request_start')providerRejected=undefined;currentRequest=diagnostic;if(diagnostic.event==='request_start')firstOutput=false;await requestHost({type:'model_diagnostic',diagnostic});},readHistory,workItems,publishArtifact); session = created.session; closeMcp = created.closeMcp;
      if (canceled) { readyReject(); send({ type: 'canceled' }); return; }
      let settled=false;
      session.subscribe(event => {if(event.type==='agent_settled'&&!event.aborted)settled=true; if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {if(!firstOutput){firstOutput=true;void requestHost({type:'model_diagnostic',diagnostic:modelLifecycleDiagnostic('first_output',{startedAt:currentRequest?.startedAt??new Date().toISOString(),...(currentRequest?.providerRequestId?{providerRequestId:currentRequest.providerRequestId}:{})},[input.profile.apiKey])}).catch(()=>{});}send({ type: 'output_delta', text: event.assistantMessageEvent.delta.split(input.profile.apiKey).join('[redacted]') });} });
      promptActive = true;
      const prompt = session.prompt(input.prompt); readyResolve();
      await prompt;
      promptActive = false; accepting = false; await steerTail;
      const last = session.messages.at(-1);
      if (canceled) send({ type: 'canceled' });
      else if (last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')) {await created.captureModelFailure();const messages=created.manager.getBranch().filter(e=>e.type==='message').map(e=>e.message),calls=messages.flatMap(m=>m.role==='assistant'?m.content.filter(c=>c.type==='toolCall').map(c=>c.id):[]),results=messages.flatMap(m=>m.role==='toolResult'?[m.toolCallId]:[]);send({type:'failed',...(last.stopReason==='error'&&settled&&providerRejected&&!created.workItems?.uncertain()&&calls.every(id=>results.includes(id))?{providerRejected}:{})});}
      else if(created.human?.pending()){if(!settled)throw Error('human_checkpoint_not_settled');const entries=created.manager.getBranch().filter(e=>e.type==='message');const calls=entries.flatMap(e=>e.message.role==='assistant'?e.message.content.filter(c=>c.type==='toolCall').map(c=>c.id):[]);const results=entries.flatMap(e=>e.message.role==='toolResult'?[e.message.toolCallId]:[]);if(calls.some(id=>!results.includes(id)))throw Error('human_checkpoint_unpaired_tools');session.dispose();session=undefined;await closeMcp?.();closeMcp=undefined;send({type:'human_wait',requestId:input.humanRequestId});}
      else if(created.workItems?.uncertain()){throw Error('work_item_outcome_unknown');}
      else if(created.workItems?.boundary()){if(!settled)throw Error('work_item_handoff_not_settled');const entries=created.manager.getBranch().filter(e=>e.type==='message'),calls=entries.flatMap(e=>e.message.role==='assistant'?e.message.content.filter(c=>c.type==='toolCall').map(c=>c.id):[]),results=entries.flatMap(e=>e.message.role==='toolResult'?[e.message.toolCallId]:[]);if(calls.some(id=>!results.includes(id)))throw Error('work_item_handoff_unpaired_tools');session.dispose();session=undefined;await closeMcp?.();closeMcp=undefined;send({type:'work_item_boundary',boundary:created.workItems.boundary()});}
      else if(input.replanOnly)throw Error('Replanning must ask a new human question before further execution');
      else send({ type: 'result', text: (session.getLastAssistantText() ?? '').split(input.profile.apiKey).join('[redacted]') });
    } catch { readyReject(); send({ type: 'failed' }); }
    finally { accepting = false; session?.dispose(); await closeMcp?.(); if (process.connected) process.disconnect(); }
  })();
});
process.on('disconnect', () => { canceled = true; accepting = false; for (const waiter of progressWaiters.values()) waiter.reject(); progressWaiters.clear(); void session?.abort(); });
