import { createHash } from 'node:crypto';
import type { RuntimeMaintenanceRequest, RuntimeMaintenanceReceipt, RuntimeContextInspection, RuntimeOutcome, SessionHandle } from '@dentity/contracts';
import type { BuiltinRuntimeOptions, ModelMessage } from './types.js';
import type { JournalRef, JournalScope } from './journal.js';
import { conservativeTokens, renderSummary, summarizeHistoryCandidate, validateMaintenancePolicy, type SummaryDocument } from './summary.js';
export interface MaintainedSession {handle:SessionHandle;binding:string;messageRefs:readonly JournalRef[];messageDates?:readonly number[];summaryRef?:JournalRef;pendingMaintenance?:string;closed:boolean;epoch:number;activeExecution?:string}
interface State {request:RuntimeMaintenanceRequest;fingerprint:string;status:RuntimeMaintenanceReceipt['status'];reason?:string;prefix:readonly JournalRef[];start:number;dates:readonly number[];sourceRecordIds:readonly string[];previousSummaryRef?:JournalRef;candidateRef?:JournalRef}
interface Publication {runKey:string;changes:readonly {key:string;expectedVersion:number|null;value:unknown}[]}
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}':JSON.stringify(value)??'null';
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const eq=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export class ContextMaintenance {
  private active=new Map<string,AbortController>();
  private jobs=new Set<Promise<unknown>>();
  constructor(private options:BuiltinRuntimeOptions,private sessionKey:(session:SessionHandle)=>string,private inputQueue=options.inputQueue){}
  private now(){return this.options.now?.()??Date.now();}
  private scope(r:RuntimeMaintenanceRequest):JournalScope{return {workspaceId:r.authorization.workspaceId,entityId:r.authorization.entityId,conversationId:r.authorization.conversationId};}
  private key(r:RuntimeMaintenanceRequest){return `builtin:maintenance:${digest([r.authorization.workspaceId,r.authorization.entityId,r.authorization.conversationId,r.authorization.jobRunId])}`;}
  private async auth(r:RuntimeMaintenanceRequest){const a=r.authorization,s=r.session;if(!a.jobRunId||!a.policyRevision||!a.leaseToken||!a.sessionId||Date.parse(a.expiresAt)<=this.now()||!Number.isFinite(Date.parse(a.expiresAt))||Date.parse(r.deadlineAt)<=this.now()||!Number.isFinite(Date.parse(r.deadlineAt))||s.runtime.workspaceId!==a.workspaceId||s.runtime.entityId!==a.entityId||s.sessionId!==a.sessionId||s.configRevision!==a.configRevision||s.scope.kind!=='interaction'||s.scope.conversationId!==a.conversationId||!await this.options.authorizeMaintenance?.(r))throw Error('Maintenance authorization denied');validateMaintenancePolicy(r.policy);}
  private async loadSession(r:RuntimeMaintenanceRequest){const record=await this.options.sessionStore.get(this.sessionKey(r.session));const s=record?.value as MaintainedSession|undefined;if(!record||!s||s.closed||!(eq(s.handle.runtime,r.session.runtime)&&s.handle.sessionId===r.session.sessionId&&s.handle.opaqueHandle===r.session.opaqueHandle&&eq(s.handle.scope,r.session.scope)))throw Error('Maintenance session unavailable');return {record,session:s};}
  private receipt(r:RuntimeMaintenanceRequest,s:Pick<State,'status'|'reason'>):RuntimeMaintenanceReceipt{return {runId:r.authorization.jobRunId,status:s.status,...(s.reason?{reason:s.reason}:{})};}
  private async guard<T>(r:RuntimeMaintenanceRequest,fn:()=>Promise<T>):Promise<RuntimeOutcome<T>>{try{return {ok:true,value:await fn()};}catch{let retryable=false;try{await this.auth(r);const stored=await this.options.sessionStore.get(this.key(r));retryable=['ready','applied'].includes((stored?.value as State|undefined)?.status??'');}catch{}return {ok:false,error:{code:retryable?'MAINTENANCE_RECONCILIATION_REQUIRED':'RUNTIME_UNAVAILABLE',operationId:r.operationId,retryable,safeMessage:'Context maintenance failed or authorization changed'}};}}
  private read(r:RuntimeMaintenanceRequest,refs:readonly JournalRef[]){return this.options.journal.readMany<ModelMessage>(this.scope(r),refs);}
  summary(scope:JournalScope,s:MaintainedSession):SummaryDocument|undefined {if(!s.summaryRef)return undefined;const document=this.options.journal.read<SummaryDocument>(scope,s.summaryRef);let current;try{current=this.options.journal.readSummary(scope);}catch{this.options.journal.writeSummary(scope,document.version,[...document.entries]);current=this.options.journal.readSummary(scope);}if(!current||current.version!==document.version||!eq(current.entries,document.entries))this.options.journal.writeSummary(scope,document.version,[...document.entries]);return document;}
  async shutdown(){for(const controller of this.active.values())controller.abort();await Promise.allSettled([...this.jobs]);}
  inspectContext(r:RuntimeMaintenanceRequest){return this.guard(r,async()=>{await this.auth(r);const {session}=await this.loadSession(r);const messages=this.read(r,session.messageRefs),summary=this.summary(this.scope(r),session);return {estimatedTokens:conservativeTokens([messages,summary?renderSummary(summary.entries):undefined]),historyRevision:digest([session.messageRefs,session.summaryRef]),hasModel:!!this.options.modelClient,active:!!session.activeExecution} satisfies RuntimeContextInspection;});}
  requestMaintenance(r:RuntimeMaintenanceRequest){const work=this.perform(r);this.jobs.add(work);void work.finally(()=>this.jobs.delete(work));return work;}
  private perform(r:RuntimeMaintenanceRequest){return this.guard(r,async()=>{
    await this.auth(r);const k=this.key(r),fingerprint=digest([r.session,r.policy,r.reason,r.idempotencyKey]);let old=await this.options.sessionStore.get(k);
    if(old){const s=old.value as State;if(s.fingerprint!==fingerprint)throw Error('Maintenance id reused');if(s.status==='summarizing'&&!this.active.has(k)){const failed={...s,status:'failed' as const,reason:'interrupted_summary_not_replayed'};await this.options.sessionStore.compareAndSet(k,old.version,failed);await this.clearPending(r,k);return this.receipt(r,failed);}return this.apply(r);}
    let {record,session}=await this.loadSession(r);if(session.pendingMaintenance){
      const pendingKey=session.pendingMaintenance,pending=await this.options.sessionStore.get(pendingKey);
      if(pending){const prior=pending.value as State;let abandoned=['failed','skipped','obsolete','applied'].includes(prior.status);
        if(!abandoned){
          const durable=this.options.journal.find<Publication>(this.scope(r),'maintenance_commit',v=>v.runKey===pendingKey);
          let replaceable=false;try{replaceable=!durable&&await this.options.authorizeMaintenanceReplacement?.(r,prior.request)===true;}catch{}
          if(replaceable){const {pendingMaintenance:_,...rest}=session;abandoned=await this.options.sessionStore.compareAndSetMany([{key:pendingKey,expectedVersion:pending.version,value:{...prior,status:'obsolete',reason:'superseded_terminal_maintenance'}},{key:this.sessionKey(r.session),expectedVersion:record.version,value:rest}]);}
        }
        if(abandoned){await this.clearPending(r,pendingKey);({record,session}=await this.loadSession(r));}}
      if(session.pendingMaintenance)throw Error('Another maintenance is pending');
    }
    const messages=this.read(r,session.messageRefs);let start=0;while(messages[start]?.role==='system')start++;
    let cut=messages.length,count=0;while(cut>start&&count<r.policy.retainMessages){cut--;const m=messages[cut]!;if((m.role==='user'||m.role==='assistant')&&m.content.trim())count++;}
    // Keep complete user turns and every tool call/result exchange. Never summarize an
    // unfinished assistant/tool tail independently of its initiating user message.
    while(cut>start&&messages[cut]?.role!=='user')cut--;
    while(cut>start&&messages[cut-1]?.role==='user')cut--;
    const previous=this.summary(this.scope(r),session);
    const below=r.reason==='context_threshold'&&conservativeTokens([messages,previous?renderSummary(previous.entries):undefined])<r.policy.contextTokenThreshold;
    const status:State['status']=!this.options.modelClient||cut<=start||below?'skipped':'summarizing';
    const state:State={request:structuredClone(r),fingerprint,status,...(status==='skipped'?{reason:!this.options.modelClient?'model_unavailable':below?'below_context_threshold':'insufficient_history'}:{}),prefix:session.messageRefs.slice(start,cut),start,dates:session.messageDates?.slice(start,cut)??Array(cut-start).fill(this.now()),sourceRecordIds:this.options.journal.capture(this.scope(r)).recordIds,...(session.summaryRef?{previousSummaryRef:session.summaryRef}:{})};
    if(!await this.options.sessionStore.compareAndSetMany([{key:k,expectedVersion:null,value:state},...(status==='summarizing'?[{key:this.sessionKey(r.session),expectedVersion:record.version,value:{...session,pendingMaintenance:k}}]:[])]))throw Error('Maintenance conflict');
    if(status==='skipped')return this.receipt(r,state);
    const controller=new AbortController();this.active.set(k,controller);const timeout=setTimeout(()=>controller.abort(),Math.max(1,Math.min(60000,Date.parse(r.deadlineAt)-this.now())));
    try{
      const provenance=this.options.journal.put(this.scope(r),'maintenance_source',{prefix:state.prefix,dates:state.dates,previousSummaryRef:state.previousSummaryRef});
      const work=summarizeHistoryCandidate({sourceCheckpoint:provenance.recordId,model:this.options.modelClient!,policy:r.policy,previous:previous?.entries??[],records:state.prefix.map((ref,i)=>({message:messages[start+i]!,at:state.dates[i]!,id:ref.recordId})).filter(record=>!record.message.platform&&record.message.contextSource?.kind!=='business_notice'),now:this.now(),beforeAttempt:()=>this.auth(r),signal:controller.signal});
      const {entries,archivedDaily}=await Promise.race([work,new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('Summary interrupted')),{once:true}))]);
      await this.auth(r);const candidateRef=this.options.journal.put(this.scope(r),'context_summary',{version:r.authorization.jobRunId,entries,...(archivedDaily.length?{archivedDaily}:{})} satisfies SummaryDocument);old=await this.options.sessionStore.get(k);if(!old||(old.value as State).status!=='summarizing'||!await this.options.sessionStore.compareAndSet(k,old.version,{...state,status:'ready',candidateRef}))throw Error('Maintenance state changed');
    }catch{old=await this.options.sessionStore.get(k);if(old&&(old.value as State).status==='summarizing')await this.options.sessionStore.compareAndSet(k,old.version,{...state,status:'failed',reason:'summary_unavailable_or_invalid'});await this.clearPending(r,k);return this.receipt(r,{status:'failed',reason:'summary_unavailable_or_invalid'});}
    finally{clearTimeout(timeout);this.active.delete(k);}
    return this.apply(r);
  });}
  private async clearPending(r:RuntimeMaintenanceRequest,k:string){for(let attempt=0;attempt<8;attempt++){const current=await this.options.sessionStore.get(this.sessionKey(r.session));if(!current||(current.value as MaintainedSession).pendingMaintenance!==k)return;const {pendingMaintenance:_,...rest}=current.value as MaintainedSession;if(await this.options.sessionStore.compareAndSet(this.sessionKey(r.session),current.version,rest))return;}}
  private async apply(r:RuntimeMaintenanceRequest):Promise<RuntimeMaintenanceReceipt>{
    await this.auth(r);const k=this.key(r),scope=this.scope(r);
    const commit=this.options.journal.find<Publication>(scope,'maintenance_commit',v=>v.runKey===k);if(commit)await this.publish(r,commit.changes);
    const current=await this.options.sessionStore.get(k);if(!current)throw Error('Unknown maintenance');const state=current.value as State;if(state.status!=='ready'){if(['failed','skipped','obsolete','applied'].includes(state.status))await this.clearPending(r,k);if(state.status==='applied'){const loaded=await this.loadSession(r);this.summary(scope,loaded.session);}return this.receipt(r,state);}
    const loaded=await this.loadSession(r),s=loaded.session;if(s.activeExecution||this.inputQueue?.busy(this.sessionKey(r.session)))return this.receipt(r,state);
    if(s.pendingMaintenance!==k||!eq(s.summaryRef,state.previousSummaryRef)||!eq(s.messageRefs.slice(state.start,state.start+state.prefix.length),state.prefix)){await this.options.sessionStore.compareAndSet(k,current.version,{...state,status:'obsolete',reason:'source_prefix_changed'});await this.clearPending(r,k);return this.receipt(r,{status:'obsolete',reason:'source_prefix_changed'});}
    const refs=[...s.messageRefs.slice(0,state.start),...s.messageRefs.slice(state.start+state.prefix.length)];const dates=[...(s.messageDates??[]).slice(0,state.start),...(s.messageDates??[]).slice(state.start+state.prefix.length)];
    const {pendingMaintenance:_,...rest}=s;const next:MaintainedSession={...rest,messageRefs:refs,messageDates:dates,summaryRef:state.candidateRef!};const document=this.options.journal.read<SummaryDocument>(scope,state.candidateRef!);
    await this.auth(r);
    // Preserve the exact daily inputs before their rollup becomes effective. The
    // durable candidate carries them across retries; no model call is replayed.
    this.options.journal.archiveDailySummaries(scope,r.authorization.jobRunId,r.policy.timezone,document.archivedDaily??[]);
    // Stable record IDs allow old SQL / nested journal references to read archives even
    // if the process stops before the metadata publication. Archive FIRST, never delete.
    this.options.journal.archive(scope,r.authorization.jobRunId,[...state.sourceRecordIds],refs.map(ref=>ref.recordId));
    this.options.journal.put(scope,'context_head',{runId:r.authorization.jobRunId,messageRefs:refs,messageDates:dates});
    const changes=[{key:this.sessionKey(r.session),expectedVersion:loaded.record.version,value:next},{key:k,expectedVersion:current.version,value:{...state,status:'applied'}}];
    this.options.journal.put(scope,'maintenance_commit',{runKey:k,changes} satisfies Publication);
    if(!await this.publish(r,changes))throw Error('Maintenance publication conflict');
    this.options.journal.writeSummary(scope,document.version,[...document.entries]);return this.receipt(r,{status:'applied'});
  }
  private publish(r:RuntimeMaintenanceRequest,changes:Publication['changes']){return this.options.publishMaintenance?this.options.publishMaintenance(r,changes):this.options.sessionStore.compareAndSetMany(changes);}
  getMaintenanceStatus(r:RuntimeMaintenanceRequest){return this.guard(r,()=>this.apply(r));}
  async applyPending(session:SessionHandle):Promise<void>{const loaded=await this.options.sessionStore.get(this.sessionKey(session));const pending=(loaded?.value as MaintainedSession|undefined)?.pendingMaintenance;if(!pending)return;const state=await this.options.sessionStore.get(pending);if(!state)return;try{await this.apply((state.value as State).request);}catch{/* Scheduler renews/reconciles expired maintenance leases. Chat does not acquire maintenance authority. */}}
}
