import {createHash} from 'node:crypto';
import {Scheduler, type AgentSessionMaintenancePort, type ConversationRepository, type InteractionRuntimeProvider, type ScheduledJob} from '@dentity/application';
import type {ContextMaintenancePolicy, RuntimeMaintenanceRequest, SessionHandle} from '@dentity/contracts';
import type {Store} from './store.js';
import {SqliteScheduleRepository} from './adapters/sqlite/schedule-repository.js';
export interface ContextMaintenanceOptions {
  enabled?:boolean;
  intervalMs?:number;
  policy?:Partial<ContextMaintenancePolicy>;
}
export const defaultMaintenancePolicy:ContextMaintenancePolicy={retainMessages:60,recentDays:30,maxSummaryTokens:8192,maxDailySummaryTokens:2048,contextTokenThreshold:12000,timezone:'UTC'};
interface Payload {session:SessionHandle;policy:ContextMaintenancePolicy;policyRevision:string;reason:'schedule'|'context_threshold'}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
// Journal references are immutable content identities. Session CAS versions also
// change for leases/pending-maintenance bookkeeping and are not history versions.
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v)??'null';
const historyFingerprint=(value:{handle:SessionHandle;messageRefs?:unknown;summaryRef?:unknown})=>createHash('sha256').update(canonical([value.handle.configRevision,value.messageRefs??[],value.summaryRef??null])).digest('hex');
/** Platform only selects scope and invokes an adapter; it does not parse model history. */
export class ContextMaintenanceService {
  readonly scheduler:Scheduler;
  private readonly policy:ContextMaintenancePolicy;
  private readonly revision:string;
  private readonly interval:number;
  private scanAfter='';
  constructor(private readonly store:Store,readonly repository:SqliteScheduleRepository,private readonly conversations:ConversationRepository,private readonly provider:InteractionRuntimeProvider,private readonly now:()=>number,private readonly options:ContextMaintenanceOptions={}){
    this.policy={...defaultMaintenancePolicy,...options.policy};this.interval=options.intervalMs??24*60*60*1000;
    if(!Number.isSafeInteger(this.interval)||this.interval<1000)throw new Error('Maintenance intervalMs must be >= 1000');
    for(const [name,value]of Object.entries(this.policy))if(name!=='timezone'&&(!Number.isSafeInteger(value)||Number(value)<=0))throw new Error('Maintenance limits must be positive integers');
    if(this.policy.recentDays>366||this.policy.retainMessages>500||this.policy.maxSummaryTokens>32000)throw new Error('Maintenance policy exceeds supported bounds');
    new Intl.DateTimeFormat('en',{timeZone:this.policy.timezone}).format(0);
    this.revision=hash([this.policy,this.interval]);
    this.scheduler=new Scheduler(repository,{'context.compact':job=>this.run(job)},now);
  }
  authorize(request:RuntimeMaintenanceRequest):boolean{
    const a=request.authorization,job=this.repository.get(a.jobRunId);if(!job||!this.repository.owns(a.jobRunId,a.leaseToken,this.now()))return false;
    const p=job.payload as Payload;
    return job.handler==='context.compact'&&job.id===request.operationId&&job.key===request.idempotencyKey&&p.reason===request.reason&&Date.parse(request.deadlineAt)<=Date.parse(a.expiresAt)&&Date.parse(a.expiresAt)<=job.leaseUntil&&p.policyRevision===this.revision&&a.policyRevision===p.policyRevision&&p.session.sessionId===a.sessionId&&p.session.runtime.workspaceId===a.workspaceId&&p.session.runtime.entityId===a.entityId&&p.session.scope.kind==='interaction'&&p.session.scope.conversationId===a.conversationId&&hash(p.policy)===hash(request.policy)&&hash({...p.session,configRevision:a.configRevision})===hash(request.session)&&Date.parse(a.expiresAt)>this.now();
  }
  private async run(job:ScheduledJob){
    if(this.options.enabled===false)return{status:'skipped' as const,reason:'maintenance_disabled'};
    const payload=job.payload as Payload;let session=payload.session;if(payload.policyRevision!==this.revision)return{status:'skipped' as const,reason:'policy_changed'};
    if(session.scope.kind!=='interaction')return{status:'skipped' as const,reason:'unsupported_scope'};
    const conv=this.conversations.get(session.scope.conversationId);if(!conv||conv.mode!=='real'||conv.expires_at>0&&conv.expires_at<=this.now())return{status:'skipped' as const,reason:'conversation_unavailable'};
    // Channel sessions are maintained under scheduler/service authority, never a speaker identity.
    let resolved:{runtime:object;revision:string};
    try{
      if(conv.user_id)resolved=await this.provider.resolve({workspaceId:conv.workspace_id,entityId:conv.entity_id,userId:conv.user_id},conv);
      else if(this.provider.resolveMaintenance)resolved=await this.provider.resolveMaintenance(conv);
      else return{status:'skipped' as const,reason:'channel_maintenance_authorization_unavailable'};
    }catch{return{status:'skipped' as const,reason:'runtime_unavailable'};}
    if(session.sessionId!==conv.id)return{status:'skipped' as const,reason:'legacy_session_superseded'};session={...session,configRevision:resolved.revision};
    const runtime=resolved.runtime as typeof resolved.runtime & Partial<AgentSessionMaintenancePort>;
    if(!runtime.inspectContext||!runtime.requestMaintenance||!runtime.getMaintenanceStatus)return{status:'skipped' as const,reason:'unsupported_capability'};
    const deadline=Math.min(job.leaseUntil,this.now()+90_000),request:RuntimeMaintenanceRequest={operationId:job.id,deadlineAt:new Date(deadline).toISOString(),authorization:{workspaceId:conv.workspace_id,entityId:conv.entity_id,conversationId:conv.id,sessionId:session.sessionId,configRevision:session.configRevision,policyRevision:payload.policyRevision,jobRunId:job.id,leaseToken:job.leaseToken!,expiresAt:new Date(deadline).toISOString()},session,reason:payload.reason,policy:payload.policy,idempotencyKey:job.key};
    const result=await runtime.requestMaintenance(request);
    if(!result.ok)return{status:result.error.retryable?(result.error.code==='MAINTENANCE_RECONCILIATION_REQUIRED'?'waiting' as const:'retry' as const):'failed' as const,reason:result.error.code};
    switch(result.value.status){case'applied':return{status:'succeeded' as const};case'skipped':case'obsolete':return{status:'skipped' as const,reason:result.value.reason??result.value.status};case'failed':return{status:'failed' as const,reason:result.value.reason??result.value.status};default:return{status:'waiting' as const,reason:result.value.status};}
  }
  async tick(){
    if(this.options.enabled===false)return;
    const now=this.now();
    // Persistent runtime records contain handles/status only. No native transcript parsing.
    const records=this.store.all<{key:string;version:number;json:string}>("SELECT key,version,json FROM builtin_records WHERE key LIKE 'builtin:session:%' AND key>? ORDER BY key LIMIT 500",this.scanAfter);
    this.scanAfter=records.length===500?records[records.length-1]!.key:'';
    this.store.transaction(()=>{for(const record of records){const value=JSON.parse(record.json) as {handle:SessionHandle;closed:boolean;messageRefs?:unknown;summaryRef?:unknown};if(value.closed||value.handle.scope.kind!=='interaction'||value.handle.sessionId!==value.handle.scope.conversationId)continue;const session=value.handle,conv=this.conversations.get(value.handle.scope.conversationId);if(!conv||conv.mode!=='real'||conv.expires_at>0&&conv.expires_at<=now)continue;
      if(this.store.one("SELECT id FROM scheduled_jobs WHERE status IN ('queued','running') AND json_extract(payload_json,'$.session.sessionId')=?",session.sessionId))continue;
      const schedule=this.repository.ensureSchedule(session.sessionId,this.revision,now,this.interval);const timed=schedule.next_due_at<=now;
      const fingerprint=historyFingerprint(value);
      if(timed||schedule.last_context_fingerprint!==fingerprint){const reason=timed?'schedule':'context_threshold';const key=`context:${session.sessionId}:${this.revision}:${timed?`due:${schedule.next_due_at}`:`history:${fingerprint}`}`;this.scheduler.enqueue(key,'context.compact',{session,policy:this.policy,policyRevision:this.revision,reason} satisfies Payload);this.repository.observe(session.sessionId,record.version,timed?now+this.interval:schedule.next_due_at,fingerprint);}
    }});
    await this.scheduler.tick();
  }
  async stop(){await this.scheduler.stop();}
}
