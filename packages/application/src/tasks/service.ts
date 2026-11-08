import {normalizeTaskTitle,taskTitleLength,taskDisplayTitle,timedTaskTitle,TASK_TITLE_LIMIT} from '@dentity/contracts';
import type { TaskAvailableActions, TaskActionReason, TaskActionReceipt } from '@dentity/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type { TaskRepository, TaskAuthorizationPort, TaskContextRetentionPort, TaskConversationReadPort } from './ports.js';
import type { TaskCommand, TaskRuntimeClient, TaskRuntimeEvent } from './runtime.js';
import { readTaskActivity } from './activity.js';
import { executionRecordQuery, unavailableExecutionRecords, type TaskExecutionRecordsReadPort } from './execution-records.js';

export class TaskError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
/** Positive evidence that this mutation was rejected at its pre-write version guard.
 * Other failures, including errors after a write, do not carry this evidence. */
export class TaskMutationVersionConflict extends TaskError {
  constructor(readonly taskId:string, readonly operationId:string, readonly kind:'input'|'cancel') {
    super(409,'version_conflict');
  }
}
const fail = (status: number, code: string): never => { throw new TaskError(status, code); };
export function taskBody(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) return fail(400, 'invalid_input');
  return value as Record<string, unknown>;
}
export function taskString(value: unknown, max = 8000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail(400, 'invalid_input');
  return value.trim();
}
function providedTitle(value:unknown):string|undefined {
  if(value===undefined)return undefined;
  if(typeof value!=='string'||/[\ud800-\udfff]/u.test(value)||value.length>4096||/[\u0000-\u0008\u000e-\u001f\u007f]/u.test(value))return fail(400,'invalid_task_title');
  const title=normalizeTaskTitle(value);
  if(taskTitleLength(title)>TASK_TITLE_LIMIT)return fail(400,'invalid_task_title');
  return title||undefined;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = (status: string) => ['succeeded', 'failed', 'canceled'].includes(status);
export type {TaskScope,TaskRequestContext} from './principal.js';
import {scopeFromJson,scopeActorKey,scopeRequester,conversationOwnerKey,type TaskScope,type TaskRequestContext} from './principal.js';
export interface TaskRow { title?:string|null; id: string; workspace_id: string; entity_id: string; user_id: string|null; actor_key:string; owner_key:string; conversation_id: string|null; operation_id: string; request_hash: string; input: string; context_mode: 'new'|'fork'; snapshot_id: string; snapshot_json: string; snapshot_expires_at:number|null; source_json: string; config_snapshot_json: string|null; status: string; version: number; input_revision: number; run_id: string|null; created_at: number; updated_at: number; planned_history_ids_json:string; planned_package_ids_json:string }
export class TaskService {
  private assetPolicy:{bind:(scope:TaskRequestContext,taskId:string,runId:string|null,ids?:readonly string[])=>void}|undefined;
  setAssetPolicy(policy:NonNullable<TaskService['assetPolicy']>){this.assetPolicy=policy;}
  private human:import('./runtime.js').TaskHumanCoordinator|undefined;
  setHumanCoordinator(value:NonNullable<TaskService['human']>){this.human=value;}
  private eventObserver:((value:{taskId:string;runId:string;sessionId:string|undefined;eventId:string;sequence:number;type:string;status:string})=>void)|undefined;
  setEventObserver(value:(value:{taskId:string;runId:string;sessionId:string|undefined;eventId:string;sequence:number;type:string;status:string})=>void){this.eventObserver=value;}
  private workItems:{tick:()=>Promise<void>;canDispatch:(taskId:string,runId?:string)=>boolean;taskCreated?:(taskId:string,workspaceId:string)=>void;onEvent?:(task:TaskRow,event:TaskRuntimeEvent)=>void;isManaged?:(taskId:string)=>boolean}|undefined;
  setWorkItemCoordinator(value:NonNullable<TaskService['workItems']>){this.workItems=value;}
  private busy = false;
  private stopping = false;
  private idleWaiters: (()=>void)[] = [];
  constructor(private readonly repository: TaskRepository, readonly now: () => number, readonly runtime?: TaskRuntimeClient, readonly capabilities?: TaskAuthorizationPort, private readonly retention?: TaskContextRetentionPort, private readonly conversations?: TaskConversationReadPort, private readonly assertCreationModel?: (scope:TaskScope)=>void) {}
  private requestContext(scope:TaskRequestContext){if(scope?.business||scope?.assignment){if(scope.conversationId!==null)return fail(400,'business_task_has_no_conversation');return;}if(!scope||typeof scope.conversationId!=='string'||!scope.conversationId.trim()||scope.conversationId.length>160)return fail(400,'task_context_required');}
  private runId(task:TaskRow):string{return task.run_id??fail(409,'task_not_started');}
  contextOfTask(task:TaskRow):TaskRequestContext{return {...this.scope(task),conversationId:task.conversation_id};}
  async refreshTaskContext(scope:TaskRequestContext,id:string){
    this.requestContext(scope);this.authorizeLocal(scope);
    const row=this.repository.findScopedTask(id,scope)??fail(404,'task_not_found');
    this.authorizeLocal(this.scope(row));
    return this.task(scope,id);
  }
  assertActive(scope:TaskScope){this.capabilities?.assertActive?.(scope);}
  authorize(scope: TaskScope) {
    if (!this.capabilities) return fail(403, 'entity_use_forbidden');
    this.capabilities.authorizeEntity(scope);
  }
  authorizeLocal(scope:TaskScope){if(!this.capabilities)return fail(403,'entity_use_forbidden');if(this.capabilities.authorizeLocal)this.capabilities.authorizeLocal(scope);else this.authorize(scope);}
  conversation(scope: TaskScope, id: string|null) {
    if(scope.business||scope.assignment||id===null)return fail(403,'business_task_has_no_conversation');
    this.authorizeLocal(scope);
    return this.conversations?.findConversation(id, scope, this.now()) ?? fail(404, 'conversation_not_found');
  }
  task(scope: TaskRequestContext, id: string): TaskRow {
    this.requestContext(scope);
    this.authorizeLocal(scope);
    const task = this.repository.findScopedTask(id, scope) ?? fail(404, 'task_not_found');
    this.authorizeTask(task); return task;
  }
  authorizeTask(task: TaskRow) { this.authorizeLocal(this.scope(task)); }
  findByOperation(scope: TaskRequestContext, operationId: string) {
    this.requestContext(scope);
    this.authorizeLocal(scope);
    const row = this.repository.findCreatedTask(scope, operationId);
    // Existence reconciliation must survive a revoked task configuration; content reads
    // still go through task()/dto() and revalidate the saved capability snapshot.
    return row?.workspace_id === scope.workspaceId ? {id: row.id} : undefined;
  }
  getOperationReceipt(scope: TaskRequestContext, taskId: string, operationId: string) {
    return this.actionReceipt(this.task(scope, taskId), operationId);
  }
  findMutationTaskId(operationId: string,scope:TaskRequestContext) { this.requestContext(scope);this.authorizeLocal(scope);return this.repository.findMutationTask(operationId,scope)?.task_id; }
  getRuntimeTask(taskId: string): TaskRow {
    const task = this.repository.findTask(taskId) ?? fail(404, 'task_not_found');
    this.authorizeTask(task);this.assertActive(this.scope(task));this.runId(task);
    return task;
  }
  getContext(scope:TaskRequestContext,id:string){
    const row=this.task(scope,id),base={mode:row.context_mode,snapshotId:row.snapshot_id};
    if(row.status==='planned')return {...base,status:'not_started' as const,messages:[]};
    if(row.snapshot_expires_at!==null&&row.snapshot_expires_at<=this.now())return {...base,status:'expired' as const,messages:[]};
    let stored:unknown;try{stored=JSON.parse(row.snapshot_json);}catch{return {...base,status:'unavailable' as const,messages:[]};}
    if(!Array.isArray(stored)||stored.length>40)return {...base,status:'unavailable' as const,messages:[]};
    if(stored.some(m=>m&&typeof m.expiresAt==='number'&&m.expiresAt>0&&m.expiresAt<=this.now()))return {...base,status:'expired' as const,messages:[]};
    if(stored.some(m=>!m||typeof m.id!=='string'||!['user','assistant'].includes(m.role)||typeof m.text!=='string'))return {...base,status:'unavailable' as const,messages:[]};
    return {...base,status:'available' as const,messages:stored.map(m=>({id:m.id as string,role:m.role as string,text:m.text as string}))};
  }
  getRuntimeInput(taskId: string, revision: number) {
    this.getRuntimeTask(taskId);
    return this.repository.inputText(taskId, revision)?.text;
  }
  getRuntimeTodoStartFact(taskId:string,runId:string):import('./runtime.js').TodoStartFact|undefined {
    this.getRuntimeTask(taskId);
    const fact=this.repository.todoStartFact(taskId,runId);
    return fact?{kind:'explicit_todo_start',taskId,runId,...fact}:undefined;
  }
  list(scope: TaskRequestContext) {
    this.requestContext(scope);
    this.authorizeLocal(scope);
    return this.repository.listTasks(scope).map(row => this.dto(row));
  }
  async listPage(scope:TaskRequestContext,value:unknown={}){
    this.authorizeLocal(scope);
    this.requestContext(scope);this.conversation(scope,scope.conversationId);
    const body=taskBody(value,['status','limit','cursor','summary']),status=body['status']??'all',limit=body['limit']??25;
    if(body['summary']!==undefined&&body['summary']!=='true')return fail(400,'invalid_task_query');
    if(!['all','planned','active','queued','running','waiting_input','waiting_approval','waiting_human','cancel_requested','unknown','succeeded','failed','canceled'].includes(status as string)||!Number.isSafeInteger(limit)||(limit as number)<1||(limit as number)>100)return fail(400,'invalid_task_query');
    const fingerprint=hash([scope.workspaceId,scope.entityId,scopeActorKey(scope),conversationOwnerKey(scope),scope.conversationId,status]);
    let cursor={ceiling:this.repository.taskListCeiling(scope),createdAt:Number.MAX_SAFE_INTEGER,id:'\uffff'};
    if(body['cursor']!==undefined){
      try{
        if(typeof body['cursor']!=='string'||body['cursor'].length>2000)throw Error();
        const c=JSON.parse(Buffer.from(body['cursor'],'base64url').toString('utf8')) as typeof cursor&{fingerprint:string};
        if(c.fingerprint!==fingerprint||!Number.isSafeInteger(c.ceiling)||c.ceiling<0||!Number.isSafeInteger(c.createdAt)||c.createdAt<0||typeof c.id!=='string'||!c.id||c.id.length>160)throw Error();
        cursor=c;
      }catch{return fail(400,'invalid_task_cursor');}
    }
    const rows=this.repository.listTaskPage(scope,{status:status as string,limit:(limit as number)+1,cursor}),page=rows.slice(0,limit as number),last=page.at(-1);
    for(const row of page)await this.refreshTaskContext(scope,row.id);
    return {tasks:page.map(row=>{const task=this.dto(row);return body['summary']==='true'?{...task,run:task.run?{...task.run,result:null}:null}:task;}),nextCursor:rows.length>(limit as number)&&last?Buffer.from(JSON.stringify({ceiling:cursor.ceiling,createdAt:last.created_at,id:last.id,fingerprint})).toString('base64url'):null};
  }
  /** Read projection of durable delivery facts, with current task authorization on every read. */
  conversationDeliveries(scope:TaskScope,conversationId:string){
    this.conversation(scope,conversationId);
    return this.repository.listConversationTasks(scope,conversationId).flatMap(task=>{
      try{this.authorizeTask(task);}catch{return [];}
      return this.repository.listDeliveries(task.id).map(delivery=>({id:`task-delivery:${delivery.id}`,role:'assistant' as const,text:`后台任务反馈（${task.id}）：${delivery.text}`,simulated:false,createdAt:delivery.createdAt,source:'task_delivery' as const,taskId:task.id}));
    });
  }
  getUpdates(scope: TaskRequestContext, taskId: string) {
    const task = this.task(scope, taskId);
    return {
      updates: this.repository.listUpdates(task.id).map(row => ({id:row.id, ...JSON.parse(row.payload_json)})),
      inputs: this.repository.listInputs(task.id),
      deliveries: this.repository.listDeliveries(task.id),
    };
  }
  activity(scope: TaskRequestContext, taskId: string, query: unknown) {
    const task=this.task(scope, taskId),humanRequests=this.human?.view?.(taskId)??[],result=readTaskActivity(this.repository, taskId, query);
    return 'entries' in result?{...result,task:{...(humanRequests.length?{humanRequests}:{}),id:task.id,title:taskDisplayTitle(task),input:task.input,status:task.status,createdAt:task.created_at,inputRevision:task.input_revision}}:result;
  }
  async executionRecords(scope: TaskRequestContext, taskId: string, value: unknown, reader?: TaskExecutionRecordsReadPort) {
    const task=this.task(scope,taskId),query=executionRecordQuery(value),body=value as Record<string,unknown>;
    const runs=this.repository.activityRuns(task.id),runId=body['runId']===undefined?runs[0]?.id:taskString(body['runId'],160);
    if(runId&&!runs.some(run=>run.id===runId))return fail(404,'run_not_found');
    if(!runId||!reader)return unavailableExecutionRecords();
    if(!scope.userId)return fail(403,'task_records_forbidden');
    const result=await reader.readRecords(task.id,runId,{kind:'conversation',userId:scope.userId,workspaceId:scope.workspaceId,entityId:scope.entityId,conversationId:scope.conversationId!},query);
    this.task(scope,taskId);return result;
  }
  availableActions(task: TaskRow): TaskAvailableActions {
    this.authorizeTask(task);
    if(!task.run_id){
      const pending=task.status==='planned',reason:TaskActionReason=pending?'task_not_started':'task_terminal';
      return {query:{available:true,mode:'read'},start:{available:pending,...(!pending?{reason:'task_terminal' as const}:{}),mode:'start_planned'},supplement:{available:pending,...(!pending?{reason}:{}),mode:'platform_record_only',runtimeDelivery:{support:'unknown',reason},application:pending?'on_start':'not_guaranteed'},cancel:{available:pending,...(!pending?{reason:'task_terminal' as const}:{}),mode:'cancel_planned',confirmation:'platform_confirmed'},pause:{available:false,reason:'platform_action_unsupported'},resume:{available:false,reason:'platform_action_unsupported'}};
    }
    const run=this.repository.runStatus(this.runId(task))!;
    if(task.status==='waiting_human'&&this.human)return{query:{available:true,mode:'read'},start:{available:false,reason:'task_terminal',mode:'start_planned'},supplement:{available:false,reason:'run_terminal',mode:'platform_record_only',runtimeDelivery:{support:'unsupported',reason:'run_terminal'},application:'not_guaranteed'},cancel:{available:true,mode:'request_cancel',confirmation:'platform_confirmed'},pause:{available:false,reason:'platform_action_unsupported'},resume:{available:false,reason:'platform_action_unsupported'}};
    const candidate=this.runtime?.capabilities?.(this.runId(task));
    const evidence=candidate?.runId===this.runId(task) && candidate.expiresAt>this.now() ? candidate : undefined;
    const common:TaskActionReason|undefined=terminal(task.status)?'task_terminal':task.status==='cancel_requested'?'cancel_already_requested':undefined;
    const queuedInput=task.status==='queued'&&run.status==='preparing'&&this.repository.outboxStatus(task.id,`dispatch:${this.runId(task)}`)?.status==='pending';
    const runtimeReason:TaskActionReason|undefined=!this.runtime?'runtime_not_configured':terminal(run.status)||run.status==='needs_human'?'run_terminal':run.status==='preparing'?'runtime_not_bound':undefined;
    const inputStateReason=runtimeReason??(run.status==='unknown'?'runtime_state_unknown':undefined);
    const inputSupport=inputStateReason?'unknown':evidence?.appendInput??'unknown';
    const cancelSupport=evidence?.cancel??'unknown';
    const inputReason=this.human?.hasOpenRequest?.(task.id)?'run_terminal':inputStateReason??(inputSupport==='supported'?undefined:inputSupport==='unsupported'?'runtime_action_unsupported':'runtime_capability_unknown');
    const cancelReason=common??runtimeReason??(cancelSupport==='supported'?undefined:cancelSupport==='unsupported'?'runtime_action_unsupported':'runtime_capability_unknown');
    return {
      query:{available:true,mode:'read'},
      start:{available:false,reason:'task_terminal',mode:'start_planned'},
      supplement:{available:!common&&!this.human?.hasOpenRequest?.(task.id),...((common??(this.human?.hasOpenRequest?.(task.id)?'run_terminal':undefined))?{reason:common??'run_terminal'}:{}),mode:queuedInput?'dispatch_input':!common&&!inputReason?'runtime_input':'platform_record_only',runtimeDelivery:{support:queuedInput?'supported':inputSupport,...(!queuedInput&&inputReason?{reason:inputReason}:{})},application:'not_guaranteed'},
      cancel:{available:!cancelReason,...(cancelReason?{reason:cancelReason}:{}),mode:'request_cancel',confirmation:'runtime_required'},
      pause:{available:false,reason:'platform_action_unsupported'},resume:{available:false,reason:'platform_action_unsupported'},
    };
  }
  private actionReceipt(task:TaskRow,operationId:string):TaskActionReceipt|undefined {
    const op=this.repository.operationReceipt(task.id,operationId);
    if(!op?.receipt_json)return undefined;
    const receipt=JSON.parse(op.receipt_json) as TaskActionReceipt;
    if(!task.run_id){receipt.runtimeStatus='not_started';return receipt;}
    const cancelOutbox=this.repository.outboxStatus(task.id,`cancel:${task.id}:${operationId}`);
    receipt.runtimeStatus=receipt.action==='cancel'&&cancelOutbox?.status==='unknown'?'unknown':receipt.action==='supplement'?this.repository.inputStatus(task.id,receipt.inputRevision!)!.status:this.repository.runStatus(this.runId(task))!.status;
    return receipt;
  }
  dto(row: TaskRow,operationId?:string) {
    const run = row.run_id?this.repository.runView(row.run_id):null;
    operationId??=this.repository.latestOperation(row.id)?.operation_id;
    const availableActions=this.availableActions(row),evidence=row.run_id?this.runtime?.capabilities?.(row.run_id):undefined;
    const actionCapabilities=evidence?.runId===row.run_id&&evidence.expiresAt>this.now()?{status:'known',runId:row.run_id,runtimeId:evidence.runtimeId,runtimeVersion:evidence.runtimeVersion,bindingVersion:evidence.bindingVersion,observedAt:evidence.observedAt,expiresAt:evidence.expiresAt}:{status:'unknown',runId:row.run_id};
    return { availableActions,actionCapabilities,...(operationId?{actionReceipt:this.actionReceipt(row,operationId)}:{}),id: row.id, entityId: row.entity_id, conversationId: row.conversation_id, title:taskDisplayTitle(row), input: row.input, contextMode: row.context_mode, status: row.status, version: row.version, inputRevision: row.input_revision, run:run??null, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  async create(scope:TaskRequestContext,body:Record<string,unknown>,admitted=false,signal?:AbortSignal){
    this.requestContext(scope);this.conversation(scope,scope.conversationId);const operationId=taskString(body['operationId'],160);
    const existing=this.repository.findCreatedTask(scope,operationId);if(existing)return this.createTask(scope,body,false);
    if(signal?.aborted)return fail(409,'task_creation_interrupted');
    if(!admitted)await this.refreshAuthorization(scope);
    let snapshot:unknown;try{snapshot=await this.capabilities?.resolveForTask?.(scope,{employeeUseAdmitted:true});}catch(error){if(this.repository.findCreatedTask(scope,operationId))return this.createTask(scope,body,false);throw error;}
    if(signal?.aborted)return fail(409,'task_creation_interrupted');
    return this.createTask(scope,body,false,snapshot);
  }
  createBusiness(scope:TaskRequestContext,body:{operationId:string;input:string;title?:string;titleTimeZone?:string},preparedSnapshot:unknown,group:{namespace:string;key:string;policyRevision:number}){
    this.requestContext(scope);if(!scope.business||scope.conversationId!==null)return fail(400,'business_task_context_required');this.authorizeLocal(scope);
    const operationId=taskString(body.operationId,160),input=taskString(body.input),requestHash=hash({business:scope.business.triggerId,input,group});
    return this.repository.transaction(()=>{const old=this.repository.findCreatedTask(scope,operationId);if(old){if(old.request_hash!==requestHash)return fail(409,'operation_conflict');return this.dto(old);}
      this.assertActive(scope);this.capabilities?.validatePreparedSnapshot?.(scope,preparedSnapshot);this.assertCreationModel?.(scope);if(!this.runtime)return fail(503,'runtime_not_configured');
      const id=randomUUID(),runId=randomUUID(),snapshotId=randomUUID(),at=this.now(),{conversationId:_conversationId,...source}=scope;void _conversationId;
      this.repository.insertTask(id,scope,null,operationId,requestHash,input,'new',snapshotId,'[]',JSON.stringify(source),runId,at,at);
      this.workItems?.taskCreated?.(id,scope.workspaceId);
      this.repository.setTaskTitle(id,body.titleTimeZone?timedTaskTitle(body.title??input,at,body.titleTimeZone):taskDisplayTitle({title:body.title,input}));
      this.repository.setTriggerOrigin(id,scope.business!.triggerId,scope.business!.eventRecordId,group.namespace,group.key,group.policyRevision);
      this.repository.setTaskSnapshot(JSON.stringify(preparedSnapshot),null,id);this.repository.insertRun(runId,id,randomUUID(),at);this.repository.insertInitialInput(id,1,operationId,input);this.enqueue(id,runId,'dispatch',1,`dispatch:${runId}`);return this.dto(this.task(scope,id));
    });
  }
  createAssignment(scope:TaskRequestContext,body:{operationId:string;input:string;title?:string},snapshot:unknown){
    this.requestContext(scope);if(!scope.assignment||scope.conversationId!==null)return fail(400,'assignment_task_context_required');
    this.authorizeLocal(scope);const operationId=taskString(body.operationId,160),input=taskString(body.input),requestHash=hash({assignment:scope.assignment,input});
    return this.repository.transaction(()=>{const old=this.repository.findCreatedTask(scope,operationId);if(old){if(old.request_hash!==requestHash)return fail(409,'operation_conflict');return this.dto(old);}
      this.assertActive(scope);this.capabilities?.validatePreparedSnapshot?.(scope,snapshot);this.assertCreationModel?.(scope);if(!this.runtime)return fail(503,'runtime_not_configured');
      const id=randomUUID(),runId=randomUUID(),at=this.now();this.repository.insertTask(id,scope,null,operationId,requestHash,input,'new',randomUUID(),'[]',JSON.stringify(scope),runId,at,at);this.repository.setTaskTitle(id,taskDisplayTitle({title:body.title,input}));this.workItems?.taskCreated?.(id,scope.workspaceId);this.repository.setTaskSnapshot(JSON.stringify(snapshot),null,id);this.repository.insertRun(runId,id,randomUUID(),at);this.repository.insertInitialInput(id,1,operationId,input);this.enqueue(id,runId,'dispatch',1,`dispatch:${runId}`);return this.dto(this.task(scope,id));
    });
  }
  createTodo(scope:TaskRequestContext,body:Record<string,unknown>){return this.createTask(scope,body,true);}
  private createTask(scope:TaskRequestContext,body:Record<string,unknown>,planned:boolean,preparedSnapshot?:unknown){
    this.requestContext(scope);
    const operationId = taskString(body['operationId'], 160), conversationId = scope.conversationId, input = taskString(body['input']);
    if(conversationId===null||scope.business)return fail(400,'human_task_context_required');
    if(body['conversationId']!==undefined&&body['conversationId']!==conversationId)return fail(403,'task_conversation_forbidden');
    const mode = body['contextMode'] ?? 'new';
    if (!['new','fork'].includes(mode as string)) return fail(400, 'invalid_context_mode');
    const assetIds=body['assetIds']??[];if(!Array.isArray(assetIds)||assetIds.some(id=>typeof id!=='string'||!id))return fail(400,'invalid_asset_refs');
    const ids = body['historyMessageIds'] ?? [];
    if (!Array.isArray(ids) || ids.length > 40 || ids.some(id => typeof id !== 'string') || (mode === 'new' && ids.length)) return fail(400, 'invalid_history');
    this.conversation(scope, conversationId);
    if (this.conversations?.conversationMode(conversationId)?.mode !== 'real') return fail(409,'demo_task_forbidden');
    // Deprecated HTTP package IDs are ignored: only trusted current policy selects resources.
    const title=providedTitle(body['title']);
    const requestHash = hash({...planned?{planned:true}:{},conversationId,input,mode,ids,assetIds,packageIds:[],...(title?{title}:{})});
    return this.repository.transaction(() => {
      const old = this.repository.findCreatedTask(scope, operationId);
      if (old) { if (old.request_hash !== requestHash) return fail(409, 'operation_conflict'); this.authorizeTask(old); return this.dto(old); }
      this.assertActive(scope);
      const capabilitySnapshot=planned?undefined:preparedSnapshot;
      if(!planned)this.capabilities?.validatePreparedSnapshot?.(scope,capabilitySnapshot);
      if(planned){
        const id=randomUUID();
        this.repository.insertPlannedTask(id,scope,operationId,requestHash,input,mode as string,JSON.stringify(ids),'[]',capabilitySnapshot?JSON.stringify(capabilitySnapshot):null,this.now());this.assetPolicy?.bind(scope,id,null,assetIds);
        this.repository.setTaskTitle(id,taskDisplayTitle({title,input}));
        this.workItems?.taskCreated?.(id,scope.workspaceId);
        return this.dto(this.task(scope,id));
      }
      this.assertCreationModel?.(scope);
      if (!this.runtime) return fail(503, 'runtime_not_configured');
      const messages = ids.map(id => this.conversations?.findHistoryMessage( id as string, conversationId, this.now()) ?? fail(403, 'history_forbidden'));
      if (Buffer.byteLength(JSON.stringify(messages),'utf8') > 64000) return fail(400,'context_too_large');
      const id = randomUUID(), runId = randomUUID(), snapshotId = randomUUID(), at = this.now();
      const {conversationId:logicalConversationId,...source}=scope;void logicalConversationId;
      this.repository.insertTask(id, scope, conversationId, operationId, requestHash, input, mode as string, snapshotId, JSON.stringify(messages), JSON.stringify(source), runId, at, at);
      this.workItems?.taskCreated?.(id,scope.workspaceId);
      this.repository.setTaskTitle(id,taskDisplayTitle({title,input}));
      this.repository.setTaskSnapshot(capabilitySnapshot ? JSON.stringify(capabilitySnapshot) : null,messages.length ? Math.min(...messages.map(message=>message.expiresAt)) : null,id);
      this.repository.insertRun( runId, id, randomUUID(), at);this.assetPolicy?.bind(scope,id,runId,assetIds);
      this.repository.insertInitialInput( id, 1, operationId, input);
      this.enqueue(id, runId, 'dispatch', 1, `dispatch:${runId}`);
      return this.dto(this.task(scope,id));
    });
  }
  private enqueue(taskId: string, runId: string, kind: string, revision: number, operationId: string) {
    this.repository.enqueue( randomUUID(), taskId, runId, operationId, kind, revision);
  }
  async startTodo(scope:TaskRequestContext,id:string,body:Record<string,unknown>,admitted=false,signal?:AbortSignal){
    const operationId=taskString(body['operationId'],160),requestHash=hash({kind:'start',expectedVersion:body['expectedVersion']});
    const initial=await this.refreshTaskContext(scope,id),priorOperation=this.repository.operationHash(id,operationId);
    if(priorOperation){if(priorOperation.request_hash!==requestHash)return fail(409,'operation_conflict');return this.dto(initial,operationId);}
    if(!Number.isSafeInteger(body['expectedVersion'])||body['expectedVersion']!==initial.version)return fail(409,'version_conflict');
    if(initial.run_id)return fail(409,'already_started');if(initial.status!=='planned')return fail(409,'task_terminal');
    if(!admitted)await this.refreshAuthorization(scope);
    if(signal?.aborted)return fail(409,'task_creation_interrupted');
    const preparedSnapshot=await this.capabilities?.resolveForTask?.(this.contextOfTask(initial),{employeeUseAdmitted:true});
    if(signal?.aborted)return fail(409,'task_creation_interrupted');
    return this.repository.transaction(()=>{
      const task=this.task(scope,id),prior=this.repository.operationHash(id,operationId);
      if(prior){if(prior.request_hash!==requestHash)return fail(409,'operation_conflict');return this.dto(task,operationId);}
      if(!Number.isSafeInteger(body['expectedVersion'])||body['expectedVersion']!==task.version)return fail(409,'version_conflict');
      if(task.run_id)return fail(409,'already_started');
      if(task.status!=='planned')return fail(409,'task_terminal');
      const original=this.contextOfTask(task);this.authorizeTask(task);
      const capabilitySnapshot=preparedSnapshot;this.capabilities?.validatePreparedSnapshot?.(original,capabilitySnapshot);
      this.assertActive(original);this.assertCreationModel?.(original);if(!this.runtime)return fail(503,'runtime_not_configured');
      if(task.conversation_id===null)return fail(409,'human_task_context_required');
      if(!this.conversations?.findConversation(task.conversation_id,original,this.now())||this.conversations.conversationMode(task.conversation_id)?.mode!=='real')return fail(409,'context_unavailable');
      const ids=JSON.parse(task.planned_history_ids_json) as string[];
      const messages=ids.map(messageId=>{
        try{return this.conversations?.findHistoryMessage(messageId,scope.conversationId??fail(409,'human_task_context_required'),this.now())??fail(409,'context_unavailable');}
        catch{return fail(409,'context_unavailable');}
      });
      const snapshotJson=JSON.stringify(messages);if(Buffer.byteLength(snapshotJson,'utf8')>64000)return fail(400,'context_too_large');
      const runId=randomUUID(),at=this.now(),revision=task.input_revision+1;
      if(!this.repository.startPlannedTask(id,task.version,runId,randomUUID(),snapshotJson,messages.length?Math.min(...messages.map(m=>m.expiresAt)):null,revision,at).changes)return fail(409,'version_conflict');
      this.repository.setTaskSnapshot(capabilitySnapshot?JSON.stringify(capabilitySnapshot):null,messages.length?Math.min(...messages.map(m=>m.expiresAt)):null,id);
      this.repository.insertRun(runId,id,randomUUID(),at);this.assetPolicy?.bind(this.contextOfTask(task),id,runId);
      this.repository.insertInitialInput(id,revision,operationId,task.input);
      this.enqueue(id,runId,'dispatch',revision,`dispatch:${runId}`);
      const receipt:TaskActionReceipt={action:'start',operationId,status:'queued',inputRevision:revision,runtimeStatus:'preparing'};
      this.repository.insertOperation(id,operationId,'start',requestHash,JSON.stringify(receipt));
      return this.dto(this.task(scope,id),operationId);
    });
  }
  async cancelTodo(scope:TaskRequestContext,id:string,body:Record<string,unknown>){
    return this.cancelPlanned(scope,id,body,'cancel_todo');
  }
  private async cancelPlanned(scope:TaskRequestContext,id:string,body:Record<string,unknown>,kind:'cancel'|'cancel_todo'){
    const operationId=taskString(body['operationId'],160),requestHash=hash({kind,input:'',expectedVersion:body['expectedVersion']});
    await this.refreshTaskContext(scope,id);
    return this.repository.transaction(()=>{
      const task=this.task(scope,id),prior=this.repository.operationHash(id,operationId);
      if(prior){if(prior.request_hash!==requestHash)return fail(409,'operation_conflict');return this.dto(task,operationId);}
      if(!Number.isSafeInteger(body['expectedVersion'])||body['expectedVersion']!==task.version){
        if(kind==='cancel')throw new TaskMutationVersionConflict(id,operationId,kind);
        return fail(409,'version_conflict');
      }
      if(task.run_id){
        const receipt:TaskActionReceipt={action:'cancel',operationId,status:'already_started',runtimeStatus:this.repository.runStatus(task.run_id)?.status??'unknown'};
        this.repository.insertOperation(id,operationId,'cancel_todo',requestHash,JSON.stringify(receipt));return this.dto(task,operationId);
      }
      if(task.status!=='planned')return fail(409,'task_terminal');
      if(!this.repository.cancelPlannedTask(id,task.version,this.now()).changes)return fail(409,'version_conflict');
      const receipt:TaskActionReceipt={action:'cancel',operationId,status:'canceled',runtimeStatus:'not_started'};
      this.repository.insertOperation(id,operationId,kind,requestHash,JSON.stringify(receipt));
      return this.dto(this.task(scope,id),operationId);
    });
  }
  async mutate(scope: TaskRequestContext, id: string, kind: 'input'|'cancel', body: Record<string,unknown>) {
    const operationId = taskString(body['operationId'],160), input = kind === 'input' ? taskString(body['input']) : '';
    const requestHash = hash({kind,input,expectedVersion:body['expectedVersion']});
    const initial=await this.refreshTaskContext(scope,id);
    const prior=this.repository.operationHash(id,operationId);
    if(prior){if(prior.request_hash!==requestHash)return fail(409,'operation_conflict');return this.dto(initial,operationId);}
    if(!initial.run_id){
      if(kind==='cancel')return this.cancelPlanned(scope,id,body,'cancel');
      return this.repository.transaction(()=>{
        const task=this.task(scope,id),old=this.repository.operationHash(id,operationId);
        if(old){if(old.request_hash!==requestHash)return fail(409,'operation_conflict');return this.dto(task,operationId);}
        if(!Number.isSafeInteger(body['expectedVersion'])||body['expectedVersion']!==task.version)throw new TaskMutationVersionConflict(id,operationId,kind);
        if(task.run_id||task.status!=='planned')return fail(409,'task_terminal');
        const revision=task.input_revision+1,combined=this.combinedInput(task.input,input);
        if(!this.repository.appendPlannedInput(id,task.version,revision,combined,this.now()).changes)return fail(409,'version_conflict');
        this.repository.insertInput(id,revision,operationId,input,'recorded');
        const receipt:TaskActionReceipt={action:'supplement',operationId,status:'recorded',inputRevision:revision,deliveryMode:'platform_record_only',runtimeStatus:'recorded'};
        this.repository.insertOperation(id,operationId,'input',requestHash,JSON.stringify(receipt));
        return this.dto(this.task(scope,id),operationId);
      });
    }
    await this.refreshTaskContext(scope,id);
    return this.mutateActive(scope,id,kind,body,operationId,input,requestHash);
  }
  mutateBusiness(scope:TaskRequestContext,id:string,kind:'input'|'cancel',body:Record<string,unknown>){if(!scope.business)return fail(403,'business_task_context_required');const operationId=taskString(body.operationId,160),input=kind==='input'?taskString(body.input):'';return this.mutateActive(scope,id,kind,body,operationId,input,hash({kind,input,expectedVersion:body.expectedVersion}),true);}
  private mutateActive(scope:TaskRequestContext,id:string,kind:'input'|'cancel',body:Record<string,unknown>,operationId:string,input:string,requestHash:string,requireRuntime=false){
    return this.repository.transaction(() => {
      const task = this.task(scope,id);
      const old = this.repository.operationHash(id,operationId);
      if (old) { if (old.request_hash !== requestHash) return fail(409,'operation_conflict'); return this.dto(task,operationId); }
      if (!Number.isSafeInteger(body['expectedVersion']) || body['expectedVersion'] !== task.version) throw new TaskMutationVersionConflict(id,operationId,kind);
      if (terminal(task.status)) return fail(409,'task_terminal');
      if(kind==='input'&&this.human?.hasOpenRequest?.(task.id))return fail(409,'human_response_required');
      if(task.status==='waiting_human'&&this.human){if(kind==='input')return fail(409,'human_response_required');this.human.cancel(task);const receipt:TaskActionReceipt={action:'cancel',operationId,status:'canceled',runtimeStatus:'confirmed'};this.repository.insertOperation(id,operationId,'cancel',requestHash,JSON.stringify(receipt));return this.dto(this.repository.findTask(id)!,operationId);}
      const actions=this.availableActions(task),action=kind==='input'?actions.supplement:actions.cancel;
      if(!action.available)return fail(409,action.reason??'runtime_capability_unknown');
      if(requireRuntime&&kind==='input'&&actions.supplement.mode==='platform_record_only')return fail(409,'runtime_input_unsupported');
      const revision = task.input_revision + (kind === 'input' ? 1 : 0);
      const dispatchInput=kind==='input'&&actions.supplement.mode==='dispatch_input',acceptedInput=dispatchInput?this.combinedInput(task.input,input):input;
      if (kind === 'input') this.repository.insertInput(id,revision,operationId,acceptedInput,actions.supplement.mode==='platform_record_only'?'recorded':'pending');
      const receipt:TaskActionReceipt=kind==='input'?{action:'supplement',operationId,status:'recorded',inputRevision:revision,deliveryMode:actions.supplement.mode,runtimeStatus:actions.supplement.mode==='platform_record_only'?'recorded':'pending'}:{action:'cancel',operationId,status:'requested',runtimeStatus:'not_confirmed'};
      this.repository.insertOperation(id,operationId,kind,requestHash,JSON.stringify(receipt));
      this.repository.mutateTaskVersion(kind === 'cancel' ? 'cancel_requested' : task.status,revision,this.now(),id,task.version);
      if(dispatchInput){
        if(!this.repository.replaceQueuedInput(id,revision,acceptedInput).changes||!this.repository.retargetDispatch(id,revision).changes)return fail(409,'version_conflict');
      }
      if(kind==='cancel'||actions.supplement.mode==='runtime_input')this.enqueue(id,this.runId(task),kind,revision,`${kind}:${id}:${operationId}`);
      return this.dto(this.task(scope,id),operationId);
    });
  }
  private combinedInput(original:string,addition:string){const combined=`${original}\n\n补充要求：\n${addition}`;if(Buffer.byteLength(combined,'utf8')>64000)return fail(400,'task_input_too_large');return combined;}
  scope(row: TaskRow): TaskScope { const scope=scopeFromJson(row.source_json,{userId:row.user_id,workspaceId:row.workspace_id,entityId:row.entity_id}); if(scope.workspaceId!==row.workspace_id||scope.entityId!==row.entity_id||scopeActorKey(scope)!==row.actor_key||conversationOwnerKey(scope)!==row.owner_key)throw new TaskError(403,'task_actor_mismatch'); return scope; }
  scopeOfTask(row:TaskRow):TaskScope{return this.scope(row);}
  async refreshAuthorization(scope:TaskScope):Promise<void>{await this.capabilities?.refreshAuthorization?.(scope);this.authorizeLocal(scope);}
  scrubExpiredContexts() {
    const expired=this.repository.expiredContexts(this.now());
    if(!expired.length)return;
    this.repository.transaction(()=>{
      for(const task of expired){
        const scrub=(messages:{id:string;role:string}[])=>messages.map(message=>({id:message.id,role:message.role,text:'',expired:true}));
        this.repository.scrubContext(JSON.stringify(scrub(JSON.parse(task.snapshot_json))),task.id);
        this.retention?.scrubContext(task.run_id);
      }
    });
  }
  private command(task: TaskRow, operationId: string, revision: number): TaskCommand {
    if(task.snapshot_expires_at!==null && task.snapshot_expires_at<=this.now())return fail(410,'task_context_expired');
    const run = this.repository.runSession(this.runId(task))!;
    const input = this.repository.inputText(task.id,revision)!;
    return {...(this.human?.continuation(this.runId(task))?{continuation:this.human.continuation(this.runId(task))!}:{}),operationId,runId:this.runId(task),taskId:task.id,workspaceId:task.workspace_id,entityId:task.entity_id,...(this.scope(task).assignment?{assignment:this.scope(task).assignment!}:this.scope(task).business?{triggerEvent:this.scope(task).business!}:{requester:scopeRequester(this.scope(task))}),sessionId:run.session_id,inputRevision:revision,input:input.text,context:{mode:task.context_mode,snapshotId:task.snapshot_id,messages:JSON.parse(task.snapshot_json)}};
  }
  /** Bounded candidate scan, fair command lanes; only claimed work consumes the
   * 20-command budget. Input dependency ordering remains a repository CAS guard. */
  private *outboxCandidates(canContinue:()=>boolean){
    const kinds=['cancel','input','dispatch'] as const,queues=new Map<string,ReturnType<TaskRepository['pendingOutbox']>>(),ended=new Set<string>(),seen=new Set<string>(),opened=new Set<string>();
    for(let scanned=0;scanned<100&&ended.size<kinds.length&&canContinue();){
      for(const kind of kinds){if(scanned>=100||!canContinue())break;if(ended.has(kind))continue;
        let queue=queues.get(kind);if(!queue?.length){queue=this.repository.pendingOutbox(this.now(),kind,!opened.has(kind));opened.add(kind);queues.set(kind,queue);if(!queue.length){ended.add(kind);continue;}}
        const row=queue.shift()!;if(seen.has(row.id)){ended.add(kind);continue;}seen.add(row.id);scanned++;
        if(row.scan)this.repository.advanceOutboxScan?.(row.scan);yield row;
      }
    }
  }
  async tick() {
    if (this.busy || this.stopping) return;
    this.scrubExpiredContexts();
    if (!this.runtime) return;
    this.busy = true;
    try {
      // Recovery never assumes an expired lease means the remote operation did not happen.
      for (const kind of ['dispatch','input','cancel'] as const) this.repository.recoverExpiredLeases(this.canReplay(kind) ? 'pending' : 'unknown',kind,this.now());
      // Revalidate only known-not-sent channel operations blocked by authorization.
      // The immutable persisted binding must still authorize; unknown deliveries are never replayed here.
      if(this.repository.requeueAuthorizedOutbox&&this.repository.deferBlockedAuthorization){
        for(const blocked of this.repository.blockedAuthorizationOutbox?.(this.now())??[]){
          try{
            const task=this.repository.findTask(blocked.task_id);if(!task)continue;
            const scope=this.scope(task);if(!scope.principal)continue;
            this.authorizeLocal(scope);this.authorizeTask(task);
            this.repository.requeueAuthorizedOutbox(blocked.id);
          }catch{this.repository.deferBlockedAuthorization(blocked.id,this.now()+5000);}
        }
      }
      await this.workItems?.tick();
      await this.human?.tick();
      let handled=0;
      for (const row of this.outboxCandidates(()=>handled<20)) {
        if(row.kind==='dispatch'&&this.workItems&&!this.workItems.canDispatch(row.task_id,row.run_id))continue;
        const leaseToken = randomUUID();
        const claimed = this.repository.claimOutbox(this.now()+30000,leaseToken,row.id,this.now());
        if (!claimed.changes) continue;
        handled++;
        const leased=this.repository.leasedOutboxRevision(row.id,leaseToken);if(!leased)continue;
        // Another task's awaited dispatch may have allowed this pending command to be retargeted.
        row.input_revision=leased.input_revision;
        const task = this.repository.findTask(row.task_id)!;
        if(row.run_id&&row.run_id!==task.run_id){this.repository.supersedeOutbox(row.id);continue;}
        try {
          this.authorizeLocal(this.scope(task));
          this.authorizeTask(task);
          if (terminal(task.status)) { this.repository.supersedeOutbox(row.id); continue; }
          if(row.kind!=='dispatch'){
            if(!this.repository.renewOutboxLease(this.now()+30000,row.id,leaseToken).changes)continue;
            this.authorizeLocal(this.scope(task));
            const current=this.task(this.contextOfTask(task),task.id);
            const cap=this.runtime.capabilities?.(this.runId(task));
            const support=cap?.runId===this.runId(task)&&cap.expiresAt>this.now()?(row.kind==='input'?cap.appendInput:cap.cancel):'unknown';
            const runStatus=this.repository.runStatus(this.runId(task))!.status;
            if(terminal(current.status)||terminal(runStatus)||(row.kind==='input'&&(current.status==='cancel_requested'||(runStatus==='unknown'&&!this.canReplay('input'))))||support!=='supported'){
              const blocked=this.repository.blockUnavailableOutbox(row.id,leaseToken);
              if(blocked.changes&&row.kind==='input')this.repository.recordUnappliedInput(task.id,row.input_revision);
              continue;
            }
          }
          if(!this.repository.ownsOutboxLease(row.id,leaseToken))continue;
          const result = await this.runtime[row.kind](this.command(task,row.operation_id,row.input_revision));
          this.repository.transaction(() => {
            if (!this.repository.ownsOutboxLease(row.id,leaseToken)) return;
            this.repository.completeOutbox(result.status === 'unknown' ? 'unknown' : 'done',result.status === 'unknown' ? 'remote_unknown' : null,row.id);
            if (row.kind === 'dispatch') {
              const status = result.status === 'accepted' ? 'running' : result.status === 'rejected' ? 'failed' : 'unknown';
              this.repository.acknowledgeRunDispatch(status,this.runId(task),this.now());
              this.repository.acknowledgeTaskDispatch(status === 'unknown' ? 'queued' : status,this.now(),task.id);
              this.repository.setInputStatus(result.status==='accepted'?'received':result.status,task.id,row.input_revision);
            } else if (row.kind === 'input') this.repository.setInputStatus(result.status,task.id,row.input_revision);
            else if (result.status === 'confirmed') this.finish(task,'canceled');
          });
        } catch (error) {
          if (!this.repository.ownsOutboxLease(row.id,leaseToken)) continue;
          const denied = error instanceof TaskError || this.capabilities?.isAuthorizationError?.(error) === true;
          this.repository.retryOutbox(denied ? 'blocked' : this.canReplay(row.kind) ? 'pending' : 'unknown',this.now()+5000,denied ? 'authorization_revoked' : 'transport_unknown',row.id);
          if (!denied) this.repository.markRunUnknown(this.runId(task));
        }
      }
      const active = this.repository.activeTasks();
      for (const task of active) {
        try {
          this.authorizeLocal(this.scope(task));
          this.authorizeTask(task);
          // Repair projections from durable facts even when the event cursor was already
          // committed by an older process. Never infer success from an absent result,
          // replay an execution, or project an old segment onto a new active Run.
          this.repository.transaction(()=>{
            const current=this.repository.findTask(task.id),run=this.repository.runStatus(this.runId(task));
            if(!current||current.run_id!==task.run_id||terminal(current.status)||!run)return;
            if(run.status==='succeeded')this.confirmSuccess(current);
            else if(['failed','canceled'].includes(run.status))this.finish(current,run.status);
            else if(run.status==='unknown'&&!['unknown','cancel_requested'].includes(current.status))this.repository.setTaskStatus('unknown',this.now(),current.id);
          });
          const run = this.repository.runSequence(this.runId(task))!;
          const events=await this.runtime.events(this.runId(task),run.sequence);
          this.authorizeLocal(this.scope(task));
          for (const event of events) this.ingest(this.runId(task),event);
        } catch { /* Poll failure is not business failure; next bounded tick reconciles. */ }
      }
    } finally { this.busy = false; for (const resolve of this.idleWaiters.splice(0)) resolve(); }
  }
  async stop() { this.stopping = true; if (this.busy) await new Promise<void>(resolve=>this.idleWaiters.push(resolve)); }
  private canReplay(kind: 'dispatch'|'input'|'cancel') { return kind === 'dispatch' ? this.runtime?.idempotentDispatch === true : kind === 'input' ? this.runtime?.idempotentInput === true : this.runtime?.idempotentCancel === true; }
  private confirmSuccess(task: TaskRow) {
    const run = this.repository.runResult(this.runId(task))!;
    if (run.status !== 'succeeded' || run.result === null) return;
    const current = this.repository.findTask(task.id)!;
    if (terminal(current.status)) return;
    if (run.result_revision !== current.input_revision) { if(current.status!=='waiting_input')this.repository.waitForInput(this.now(),task.id); return; }
    this.finish(current,'succeeded');
  }
  private finish(task: TaskRow, status: string) {
    if(this.repository.findTask(task.id)?.run_id!==task.run_id)return;
    if (terminal(this.repository.taskStatus(task.id)!.status)) return;
    this.repository.setRunStatus(status,this.runId(task),this.now());
    this.repository.setTaskStatus(status,this.now(),task.id);
  }
  /** Only the trusted runtime client calls this method. There is deliberately no public event POST. */
  ingest(runId: string, event: TaskRuntimeEvent) {
    if (event.runId !== runId || !event.eventId || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !['work_item_safe','human_request','human_safe','status','progress','output_delta','partial_result','final_result','input_receipt'].includes(event.type) || (event.text !== undefined && (typeof event.text !== 'string' || event.text.length > 64000))) return fail(400,'invalid_runtime_event');
    let observedTaskId:string|undefined;
    this.repository.transaction(() => {
      const run = this.repository.runEventState(runId) ?? fail(404,'run_not_found');
      const task = this.repository.findTask(run.task_id)!;
      this.authorizeTask(task);
      if (this.repository.findEvent(runId,event.eventId)) return;
      // Missing earlier events are polled again; never jump cursor and lose durable progress.
      if (event.sequence !== run.sequence+1) return;
      if (event.type === 'final_result' && (!Number.isSafeInteger(event.inputRevision) || !this.repository.findInputRevision(task.id,event.inputRevision!))) return fail(400,'invalid_result_revision');
      if (event.type === 'status' && !['queued','running','waiting_input','waiting_approval','needs_human','succeeded','failed','canceled','unknown'].includes(event.status ?? '')) return fail(400,'invalid_runtime_event');
      if (event.type === 'input_receipt' && (!Number.isSafeInteger(event.inputRevision) || !['received','applied'].includes(event.inputStatus ?? '') || !this.repository.findInputRevision(task.id,event.inputRevision!))) return fail(400,'invalid_runtime_event');
      this.repository.insertUpdate(task.id,runId,event.eventId,event.sequence,event.type,JSON.stringify(event),this.now());
      this.repository.setRunSequence(event.sequence,runId);observedTaskId=task.id;
      this.workItems?.onEvent?.(task,event);
      if(event.type==='work_item_safe')return;
      if(event.type==='human_request'||event.type==='human_safe'){if(!event.human||event.human.runId!==runId||event.human.taskId!==task.id)throw new TaskError(400,'invalid_human_event');this.human?.onEvent(task,event);return;}
      if(run.status==='needs_human'&&!(event.type==='status'&&event.status==='needs_human'))return;
      if(task.run_id!==runId){if(event.type==='final_result')this.repository.setRunResult(event.text??'',event.inputRevision!,runId,event.inputRevision!);return;}
      if (event.type === 'status' && !terminal(task.status) && (!terminal(run.status) || run.status === event.status)) {
        if (event.status === 'succeeded') { this.repository.markRunSucceeded(runId,this.now()); this.confirmSuccess(task); }
        else if (terminal(event.status!)) this.finish(task,event.status!);
        else { this.repository.setRunStatus(event.status!,runId,this.now()); if (task.status !== 'cancel_requested') this.repository.setTaskStatus(event.status==='needs_human'?'waiting_human':event.status!,this.now(),task.id); }
      }
      if (event.type === 'input_receipt') {
        this.repository.setUnappliedInputStatus(event.inputStatus!,task.id,event.inputRevision!);
        this.repository.confirmInputDelivery(task.id,runId,event.inputRevision!);
      }
      if (event.type === 'final_result') {
        this.repository.setRunResult(event.text ?? '',event.inputRevision!,runId,event.inputRevision!);
        this.repository.markInputApplied(task.id,event.inputRevision!);
        this.repository.confirmInputDelivery(task.id,runId,event.inputRevision!);
        this.confirmSuccess(task);
      }
      if (!this.workItems?.isManaged?.(task.id)&&task.conversation_id!==null&&event.text && ['progress','partial_result','final_result'].includes(event.type)) this.repository.insertDelivery(randomUUID(),task.id,task.conversation_id,event.eventId,event.text,this.now());
    });
    if(observedTaskId)try{this.eventObserver?.({taskId:observedTaskId,runId,sessionId:this.repository.runSession(runId)?.session_id,eventId:event.eventId,sequence:event.sequence,type:event.type,status:this.repository.findTask(observedTaskId)?.status??'unknown'});}catch{/* Observability must not change a committed business result. */}
  }
}
