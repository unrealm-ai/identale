import type {HumanConfirmation,HumanActor} from '../human-confirmation.js';
import { createHash, randomUUID } from 'node:crypto';
import { BuiltinInteractionRuntime,BuiltinInputQueue,BUILTIN_THINKING_POLICY_VERSION, type JsonlJournal, type ModelClientPort, type ModelMessage, type BuiltinTool, type BuiltinInvocationContext, type ToolSchema, type BuiltinRuntimeOptions } from '@dentity/runtime-builtin';
import type { RuntimeMaintenanceRequest } from '@dentity/contracts';
import type { AuthorizationContext, InvocationContext, RuntimeAuthorizationContext } from '@dentity/domain';
import { TaskError, TaskMutationVersionConflict, taskString, scopeFromJson, scopeRequester, scopeActorKey, type TaskScope, type TaskService, type Conversation, type ConversationRepository, type InteractionEntityPort, type InteractionRuntimeProvider } from '@dentity/application';
import { interactionPrompt, INTERACTION_PROMPT_VERSION } from '../interaction-prompt.js';
import { taskModelView } from './task-model-view.js';
import type {DiagnosticPort} from '@dentity/application';
import { createBuiltinStores, purgeBuiltinRecords, compareBuiltinRecords } from './sqlite/builtin-stores.js';
import type { Store } from '../store.js';
export interface InteractionOptions {
  artifacts?:import('../task-artifacts.js').TaskArtifacts;
  imageHistory?:(messages:readonly ModelMessage[],scope:TaskScope)=>Promise<readonly ModelMessage[]>;
  inputImageAssets?:(c:AuthorizationContext)=>readonly string[];
  notificationContext?:(c:AuthorizationContext)=>{scope:TaskScope;conv:Conversation}|undefined;
  authorizeBusinessEvent?:(event:import('@dentity/contracts').RuntimeInteractionEvent,c:AuthorizationContext)=>boolean;
  businessHistoryVisible?:(eventId:string,conversationId:string)=>boolean;
  human?:HumanConfirmation;
  workItems?:import('../work-items/service.js').WorkItemsService;
  previousOwnerUnavailable?:()=>boolean;
  assertRuntimeOwner?:()=>void;
  readAdmittedInput?:(inputId:string)=>string;
  authorizeHistoryBatch?:(batchId:string,context:AuthorizationContext)=>boolean;
  diagnostics?:DiagnosticPort;
  journal?: JsonlJournal;
  /** Already-authorized package projection; contains no host roots or credentials. */
  /** Explicit dependency injection for deterministic tests or a configured production client. No default fake. */
  modelClient?: ModelClientPort;
  modelClientForScope?: (scope: TaskScope) => Promise<{client: ModelClientPort; revision: string}>;
  /** Synchronous version lookup is required for atomic maintenance publication with a custom resolver. */
  modelRevisionForScope?: (scope:TaskScope)=>string|undefined;
  /** Channel conversation service authority, independent of any sender. Must check live binding and workspace state. */
  authorizeConversationMaintenance?: (conversation:Conversation)=>boolean;
  modelClientForMaintenance?: (conversation:Conversation)=>Promise<{client:ModelClientPort;revision:string}>;
  modelRevisionForMaintenance?: (conversation:Conversation)=>string|undefined;
  conversationTtlMs?: number;
  authorizeMaintenance?: (request:RuntimeMaintenanceRequest)=>boolean;
}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const object=(properties:Record<string,ToolSchema>,required=Object.keys(properties)):ToolSchema=>({type:'object',additionalProperties:false,properties,required});
const string:ToolSchema={type:'string',minLength:1,maxLength:8000};
const taskInputBoundaries = 'Preserve every explicit user prohibition, source/action boundary, approval condition and output requirement, including no work item creation or no history reads. Do not weaken restrictions or infer permission from tool availability. Include only necessary authorized context, never whole conversations, unrelated private history or unauthorized material.';
const newTaskInput:ToolSchema={...string,description:`Accurate executable goal and complete requirements for this task. ${taskInputBoundaries} Do not expand the user request or assume the executor knows omitted conversation context.`};
function mutationVersionRejection(taskId:string,action:'supplement'|'cancel') {
  return {status:'rejected' as const,taskId,action,error:{code:'version_conflict' as const,applied:false as const,
    message:'This operation was not applied because the task version changed.'},
    nextAction:{tool:'task_query' as const,arguments:{taskId},
      instruction:'Query the current status, version and availableActions, then decide whether the user intent still requires a new operation. Do not blindly retry or claim success.'}};
}

function fail(status:number,code:string):never {throw new TaskError(status,code);}

export function createBuiltinInteractionProvider(store:Store,repository:ConversationRepository,tasks:TaskService,now:()=>number,entities:InteractionEntityPort,options:InteractionOptions={}):InteractionRuntimeProvider {
  if(!options.journal)throw new Error('Builtin journal is required');
  const journal=options.journal;
  const inputQueue=new BuiltinInputQueue(),eventScopes=new Map<string,TaskScope>(),listeners=new Set<()=>void>();const onInteractionEvent=()=>{for(const listener of listeners)try{listener();}catch{}};
  const stores=createBuiltinStores(store,now,options.assertRuntimeOwner,journal),adapters=new Map<string,BuiltinInteractionRuntime>();
  const conversation=(scope:TaskScope,id:string)=>{tasks.conversation(scope,id);const row=repository.get(id)!;if(row.expires_at>0&&row.expires_at<=now())fail(410,'conversation_expired');return row;};
  const scopeOf=(c:RuntimeAuthorizationContext):TaskScope=>{
    const auth=c as AuthorizationContext;
    if(auth.trigger?.kind!=='human_request')return fail(403,'trusted_identity_required');
    const p=auth.trigger.requester;
    if(p.channelType==='web'){
      if(p.tenantId!==auth.workspaceId||p.identityNamespace!=='platform-user')return fail(403,'trusted_identity_required');
      return {workspaceId:c.workspaceId,entityId:c.entityId,userId:p.externalUserId};
    }
    const turn=repository.turn(auth.triggerId,auth.conversation?.conversationId);
    const savedScope=turn?.scope_json?scopeFromJson(turn.scope_json):eventScopes.get(auth.triggerId);if(!savedScope)return fail(403,'trusted_channel_invocation_required');
    const scope=savedScope,expected=scopeRequester(scope);
    if(!scope.source||scope.workspaceId!==c.workspaceId||scope.entityId!==c.entityId||expected.channelType!==p.channelType||expected.tenantId!==p.tenantId||expected.identityNamespace!==p.identityNamespace||expected.externalUserId!==p.externalUserId||auth.sourceChannel?.installationId!==scope.source.installationId||auth.conversation?.kind!==scope.source.conversationKind)return fail(403,'trusted_identity_mismatch');
    return scope;
  };
  const admitted=(c:RuntimeAuthorizationContext)=>{const a=c as AuthorizationContext;const t=repository.turn(a.triggerId,a.conversation?.conversationId);if(!t?.request_json)return false;try{const r=JSON.parse(t.request_json);return r.admissionAuthorized===true||r.payload?.input?.admissionAuthorized===true;}catch{return false;}};
  // This trusted per-input grant is local metadata, never accepted from model arguments.
  const ordinaryAdmission=(c:RuntimeAuthorizationContext):boolean|undefined=>{const a=c as AuthorizationContext,t=repository.turn(a.triggerId,a.conversation?.conversationId);try{const r=JSON.parse(t?.request_json??'{}');return typeof r.employeeUseAdmitted==='boolean'?r.employeeUseAdmitted:undefined;}catch{return undefined;}};
  const preauthorize=async(c:RuntimeAuthorizationContext)=>{if((c as AuthorizationContext).trigger?.kind==='business_notification'){if(!options.notificationContext?.(c as AuthorizationContext))fail(403,'notification_context_invalid');return;}if(!admitted(c))tasks.authorizeLocal(scopeOf(c));};

  const authorized=(c:RuntimeAuthorizationContext)=>{if((c as AuthorizationContext).trigger?.kind==='business_notification'){const n=options.notificationContext?.(c as AuthorizationContext);if(!n)fail(403,'notification_context_invalid');tasks.assertActive(n.scope);if(entities.getRuntimeDefinition(n.conv.workspace_id,n.conv.entity_id)?.interactionRuntime!=='builtin-interaction')fail(403,'runtime_binding_changed');return{scope:{...n.scope,conversationId:n.conv.id},conv:n.conv};}const scope=scopeOf(c);tasks.assertActive(scope);if(!admitted(c))tasks.authorizeLocal(scope);if(entities.getRuntimeDefinition(scope.workspaceId,scope.entityId)?.interactionRuntime!=='builtin-interaction')fail(403,'runtime_binding_changed');const auth=c as AuthorizationContext;const conv=admitted(c)?repository.get(auth.conversation?.conversationId??''):conversation(scope,auth.conversation?.conversationId??'');if(!conv||!repository.findConversation(conv.id,scope,now()))fail(403,'trusted_conversation_mismatch');if(conv.mode!=='real')fail(403,'historical_demo_read_only');return{scope:{...scope,conversationId:conv.id},conv};};
  const contextualTask=async(c:InvocationContext,id:unknown)=>{const {scope}=authorized(c);const row=await tasks.refreshTaskContext(scope,taskString(id,160));return{scope,row};};
  const employee=(scope:Pick<TaskScope,'workspaceId'|'entityId'>)=>((definition)=>definition?{name:definition.name,description:definition.description}:undefined)(entities.getRuntimeDefinition(scope.workspaceId,scope.entityId))??fail(404,'entity_not_found');
  const configRevision=(scope:Pick<TaskScope,'workspaceId'|'entityId'>,modelRevision:string)=>digest([modelRevision,INTERACTION_PROMPT_VERSION,BUILTIN_THINKING_POLICY_VERSION,employee(scope)]);
  // These are durable platform notices, not generated claims. Persist intent BEFORE the outbox can dispatch.
  const taskNotice=(conv:Conversation,operationId:string,stage:string,text:string)=>repository.notice(`task-notice:${operationId}:${stage}`,conv,text,now());
  const acceptedNotice=(conv:Conversation,operationId:string,taskId:string)=>taskNotice(conv,operationId,'accepted',`后台任务已受理并记录（${taskId}），请查询当前进度；这不是完成通知。你可以继续对话或查询进度；补充、取消等操作以任务当前可用能力为准。`);
  const humanActor=(c:BuiltinInvocationContext):HumanActor=>{const{scope,conv}=authorized(c),id=c.consumedTurnIds?.at(-1)??c.triggerId,turn=repository.turn(id,conv.id);if(!turn||turn.scope_json&&scopeActorKey(scopeFromJson(turn.scope_json))!==scopeActorKey(scope))fail(403,'human_reply_source_missing');const received=scope.source?turn.canonicalInputId?store.one<{created_at:number}>('SELECT created_at FROM channel_inbox WHERE id=?',turn.canonicalInputId)?.created_at:undefined:turn.created_at;if(received===undefined)fail(403,'human_reply_source_missing');let quotedMessageId:string|undefined,messageText=turn.text;if(scope.source&&turn.canonicalInputId){const inbound=store.one<{event_json:string}>('SELECT event_json FROM channel_inbox WHERE id=?',turn.canonicalInputId);if(!inbound?.event_json)fail(403,'human_reply_source_missing');{const message=JSON.parse(inbound.event_json)?.message;if(typeof message?.text!=='string')fail(403,'human_reply_source_missing');messageText=message.text;const parent=message.replyToMessageId;if(typeof parent==='string')quotedMessageId=parent;}}return{scope,conversationId:conv.id,messageId:turn.id,messageText,createdAt:received,...(quotedMessageId?{quotedMessageId}:{})};};
  const humanTools:BuiltinTool[]=options.human?[
    {name:'human_list',kind:'task',description:'Read human questions assigned to this exact person/conversation, their frozen version/criteria, and the current trusted message ID. Use before interpreting a human answer; never create another task for an answer. Pagination counts only requests visible here. Use quotedRequest/referencedRequests or requestId lookup for a referenced question beyond page one. Never assume the page is the whole pending list.',parameters:object({page:{type:'integer',minimum:1},pageSize:{type:'integer',minimum:1,maximum:50},requestId:{type:'string',description:'Optional exact requestId or stable displayCode, including beyond the current page.'}},[]),async execute(args,c){return{...options.human!.list(humanActor(c),args as Record<string,unknown>),conversationAccess:ordinaryAdmission(c)===true?'normal':'confirmation_only'};}},
    {name:'human_propose_response',kind:'task',description:'Propose answers for a specific human request. The trusted host binds the current inbound message as evidence; do not choose or copy a message ID. Legacy evidenceMessageIds is ignored, not a history selector. not_recorded is a definite rejection with message/nextAction, not employee-use denial; explain it and keep waiting. Missing, conditional or ambiguous answers remain waiting. The service verifies identity, version and explicit decision, then durably queues one continuation only after a safe checkpoint. Acceptance is not completion. Multiple requests require clear semantic association, a stable request marker or trusted quote; a bare approval without a unique trusted clarification context must clarify. Supply association explicitly; text length is not semantic proof. For a known-question clarification, needs_more plus clarificationText records intent; your final reply must contain that exact question. Submit each request separately and report any partial rejection accurately.',parameters:object({requestId:string,contentVersion:{type:'integer',minimum:1},questionDigest:string,decision:{type:'string',enum:['approve','information','reject','needs_more','revise']},answers:{type:'array',items:object({questionId:string,value:string})},evidenceMessageIds:{type:'array',items:string,description:'Deprecated compatibility field. Ignored: current evidence is injected from the actual trusted turn. Does not select historical evidence.'},missingFields:{type:'array',items:string},summary:string,association:{type:'string',enum:['current_message','clarification','unclear'],description:'LLM semantic judgment: current_message only when the CURRENT answer clearly identifies this question; clarification only for a unique valid trusted clarificationFocus or quotedRequest; unclear never approves.'},clarificationText:{type:'string',minLength:1,maxLength:2000,description:'For needs_more on a KNOWN question: the exact question you will ask in your final reply. Repeat this text verbatim. Focus becomes valid only after the actual assistant reply is persisted and sent; no invented message ID.'},evidenceSegmentIds:{type:'array',items:string,description:'Optional currentMessage.segments IDs returned by human_list. Select whole actual clauses for this request; never invent text, choose an earlier message, or infer requests by order.'}},['requestId','contentVersion','questionDigest','decision','answers']),async execute(args,c,control){return options.human!.proposeResponse(humanActor(c),args,control.operationId);},async reconcile(id,c){return options.human!.reconcile(humanActor(c),id);}},
  ]:[];
  const workItemTools:BuiltinTool[]=options.workItems?[
    {name:'work_item_get_current',kind:'task',description:'Read the business item linked to an exact accessible taskId in this conversation. If several tasks could match, clarify which one; never select the most recent implicitly. No item writes or additional source access. Beta does not revoke existing readable items.',parameters:object({taskId:string,after:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},['taskId']),async execute(args,c){await preauthorize(c);const{row}=await contextualTask(c,args['taskId']);return options.workItems!.readForTask(row,{...(args['after']!==undefined?{after:args['after']}:{}),...(args['limit']!==undefined?{limit:args['limit']}:{})});}},
  ]:[];
  const taskAssets=(args:Readonly<Record<string,unknown>>,c:AuthorizationContext)=>{const selected=args['assetIds'];if(selected!==undefined&&!Array.isArray(selected))return selected;return [...new Set([...(selected??[]),...(options.inputImageAssets?.(c)??[])])];};
  const tools:BuiltinTool[]=[
    ...humanTools,...workItemTools,
    ...(options.artifacts?[{name:'artifact_select',kind:'task' as const,description:'Select exact published task artifact resourceIds for native attachment delivery with this reply. Query results for candidates first. Selection is not sending; do not claim delivery. Never supply filesystem paths, arbitrary URLs or vendor keys.',parameters:object({taskId:string,artifactIds:{type:'array',items:{type:'string'}}}),async execute(args:Readonly<Record<string,unknown>>,c:BuiltinInvocationContext,control:{operationId:string}){await preauthorize(c);const{conv,scope}=authorized(c);if(conv.channel!=='feishu')return fail(409,'native_attachments_unavailable');const taskId=taskString(args['taskId'],160);if(c.trigger.kind==='business_notification'){const notice=store.one<{task_id:string;turn_id:string}>('SELECT task_id,turn_id FROM business_notification_jobs WHERE id=?',c.trigger.eventId);if(!notice||notice.task_id!==taskId||notice.turn_id!==c.triggerId)fail(403,'artifact_notification_mismatch');}else await tasks.refreshTaskContext(scope,taskId);const ids=args['artifactIds'];if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))return fail(400,'invalid_artifact_selection');return options.artifacts!.select(conv.id,c.triggerId,taskId,ids,control.operationId,c.consumedTurnIds);},async reconcile(operationId:string,c:InvocationContext){await preauthorize(c);authorized(c);return options.artifacts!.reconcile(operationId);}}]:[]),
    {name:'task_list',kind:'task',description:'List accessible tasks in this conversation. Filter by planned, active, succeeded, failed or canceled. Acceptance does not mean completion.',parameters:object({status:{type:'string',enum:['all','planned','active','queued','running','succeeded','failed','canceled']},limit:{type:'integer',minimum:1,maximum:100},cursor:{type:'string',maxLength:2000}},[]),async execute(args,c){await preauthorize(c);return tasks.listPage(authorized(c).scope,args);}},
    {name:'task_create_todo',kind:'task',description:'Save a clearly requested future todo without starting it. The input must contain the executable business goal and all real constraints, not scheduling instructions such as save only/do not start yet; planned state records deferred scheduling. Do not relabel waiting for this todo start as a business precondition. Example: save for later, then return OK => input: return OK. Preserve independent business/human approval requirements and explicit prohibitions; these are not scheduling instructions. Start later only when the user explicitly asks.',parameters:object({title:{type:'string',description:'Concise task title, ideally 20–30 characters and at most 60 visible characters; put complete requirements in input.'},input:newTaskInput,assetIds:{type:'array',items:{type:'string'},description:'Explicitly selected allowed assets shared in this conversation; optional references, not automatic dependencies.'}},['input']),async execute(args,c,control){
      await preauthorize(c);const{scope,conv}=authorized(c);
      const task=tasks.createTodo(scope,{operationId:control.operationId,input:args['input'],title:args['title'],contextMode:'new',assetIds:taskAssets(args,c)});
      taskNotice(conv,control.operationId,'todo_saved',`待办已保存（${task.id}），尚未启动执行。`);return task;
    },async reconcile(operationId,c){await preauthorize(c);const{scope}=authorized(c);const found=tasks.findByOperation(scope,operationId);if(!found)return{status:'unknown'};return{status:'completed',result:tasks.dto((await contextualTask(c,found.id)).row)};}},
    ...(['task_start','task_cancel_todo'] as const).map(name=>({name,kind:'task' as const,description:name==='task_start'?'Explicitly start this conversation’s planned task only when the user asks to execute it. Use the current version. Returns queued execution acceptance, never completion.':'Cancel only an unstarted todo. already_started means execution was NOT stopped; query and explicitly use task_cancel if the user wants to stop that running task.',parameters:object({taskId:{type:'string' as const,minLength:1,maxLength:160},expectedVersion:{type:'integer' as const,minimum:1}}),async execute(args:Readonly<Record<string,unknown>>,c:InvocationContext,control:{operationId:string;signal?:AbortSignal}){
      await preauthorize(c);const{scope,row}=await contextualTask(c,args['taskId']);const body={operationId:control.operationId,expectedVersion:args['expectedVersion']};
      return name==='task_start'?tasks.startTodo(scope,row.id,body,true,control.signal):tasks.cancelTodo(scope,row.id,body);
    },async reconcile(operationId:string,c:InvocationContext){await preauthorize(c);const{scope}=authorized(c);const found=tasks.findMutationTaskId(operationId,scope);if(!found)return{status:'unknown' as const};return{status:'completed' as const,result:tasks.dto((await contextualTask(c,found)).row,operationId)};}})),
    {name:'task_create',kind:'task',description:'Create a new task when the user requests work requiring information lookup, file reading, business tools or lengthy processing that cannot be completed directly. Information lookup, reading and explanation requests are read-only unless an action is explicitly requested. Include the goal, necessary authorized context, every explicit prohibition and boundary, and expected result. Do not create if the user forbids task creation. Not for updates, status queries, cancellation or pause of an existing task. Clarify missing essential information first. Returns acceptance, not completion: acknowledge briefly and end the reply without polling for completion.',parameters:object({title:{type:'string',description:'Concise task title, ideally 20–30 characters and at most 60 visible characters; put complete requirements in input.'},input:newTaskInput,assetIds:{type:'array',items:{type:'string'},description:'Explicitly selected allowed assets shared in this conversation; references are optional, not automatic inheritance or required dependencies.'}},['input']),async execute(args,c,control){
      await preauthorize(c);const{scope,conv}=authorized(c);
      taskNotice(conv,control.operationId,'preparing',`准备交给后台处理：${String(args['input']).slice(0,500)}${String(args['input']).length>500?'…':''}`);
      try {
        const task=await tasks.create(scope,{operationId:control.operationId,conversationId:conv.id,input:args['input'],title:args['title'],contextMode:'new',assetIds:taskAssets(args,c)},true,control.signal);
        acceptedNotice(conv,control.operationId,task.id);return task;
      } catch(error) {
        const accepted=tasks.findByOperation(scope,control.operationId);
        taskNotice(conv,control.operationId,'error',accepted?'任务记录已存在，但受理反馈异常；请查询任务状态，不要重复提交。':'后台任务未创建成功，请检查配置或权限后再试。');
        throw error;
      }
    },async reconcile(operationId,c){await preauthorize(c);const{scope,conv}=authorized(c);const row=tasks.findByOperation(scope,operationId);if(!row)return{status:'unknown'};const task=tasks.dto((await contextualTask(c,row.id)).row);acceptedNotice(conv,operationId,task.id);return{status:'completed',result:task};}},
    ...(['task_query','task_query_results'] as const).map(name=>({name,kind:'task' as const,description:'Read an accessible task’s status, version, availableActions, progress, results, requirement receipts and result delivery status. availableActions specifies permitted operations. Use the latest version before changing a task. queued, unknown and cancel_requested do not mean completion; an absent result is not success.',parameters:object({taskId:{...string,description:'Exact existing task ID from this conversation; never invent or use another conversation’s task.'}}),async execute(args:Readonly<Record<string,unknown>>,c:InvocationContext){await preauthorize(c);const {scope,row}=await contextualTask(c,args['taskId']);return {...tasks.dto(row),...tasks.getUpdates(scope,row.id),...(options.artifacts?{artifacts:options.artifacts.list(row.id),artifactDeliveries:options.artifacts.deliveryViews(row.id)}:{})};}})),
    ...(['task_supplement','task_cancel'] as const).map(name=>({name,kind:'task' as const,description:name==='task_cancel'?'Request cancellation only when the user explicitly intends to cancel this existing task and current availableActions allows cancel. Not pause/resume. A requested or unknown receipt is NOT confirmed stopping; inspect authoritative status. A version_conflict with applied=false means this operation was not applied: use task_query and decide, never blindly retry.':'Add or modify requirements for this existing task, not a new task. Require availableActions.supplement.available. effect=on_start means use when started; recorded_only means saved without confirmed use; pending means awaiting receipt. Report the observed effectStatus: received is not applied. Use an observed task version. If version_conflict reports applied=false, query current state with task_query and decide; do not blindly retry. Clarify an ambiguous task or intent first.',parameters:object({taskId:{...string,description:'Exact authorized task ID in the current conversation.'},expectedVersion:{type:'integer',minimum:1,description:'Observed task version (for example from task_create or task_query). On a confirmed unapplied version conflict, query current state and decide; never guess or blindly retry.'},...(name==='task_supplement'?{input:{...string,description:`Only the user’s new or revised requirements for this existing task. ${taskInputBoundaries} Earlier restrictions remain in force unless the user explicitly changes them; supplementing or starting a task does not revoke them.`}}:{})}),async execute(args:Readonly<Record<string,unknown>>,c:InvocationContext,control:{operationId:string;signal?:AbortSignal}){await preauthorize(c);const{scope,row}=await contextualTask(c,args['taskId']);const kind=name==='task_cancel'?'cancel':'input';
      try{return await tasks.mutate(scope,row.id,kind,{expectedVersion:args['expectedVersion'],...(name==='task_supplement'?{input:args['input']}:{}),operationId:control.operationId});}
      catch(error){
        // Only the authoritative pre-write guard is safe to return to the model loop.
        // A matching error code, missing receipt or transport failure is not proof.
        if(error instanceof TaskMutationVersionConflict&&error.taskId===row.id&&error.operationId===control.operationId&&error.kind===kind)
          return mutationVersionRejection(row.id,name==='task_cancel'?'cancel':'supplement');
        throw error;
      }},async reconcile(operationId:string,c:InvocationContext){await preauthorize(c);const{scope}=authorized(c);const op=tasks.findMutationTaskId(operationId,scope);if(!op)return{status:'unknown' as const};return{status:'completed' as const,result:tasks.dto((await contextualTask(c,op)).row,operationId)};}})),
  ];
  const readText=(id:string,c:AuthorizationContext)=>{const{scope,conv}=authorized(c);if(id.startsWith('channel-input:')){const turn=repository.turn(c.triggerId,conv.id);const saved=JSON.parse(turn?.request_json??'{}');const input=saved.payload?.input;if(!input?.admissionAuthorized||id!=='channel-input:'+input.inputId||!options.readAdmittedInput)fail(403,'admitted_input_forbidden');return options.readAdmittedInput(input.inputId);}if(id==='builtin:instructions')return interactionPrompt(employee(scope));if(id==='builtin:empty')return '';const row=repository.content(id,conv.id,now());if(!row)fail(403,'context_unavailable');return row.text;};
  async function platformHistory(messages:readonly ModelMessage[],c:AuthorizationContext){
    const {scope,conv}=authorized(c);if(c.trigger.kind==='business_notification')return messages.map(({images:_,...message})=>message);messages=messages.filter(m=>m.contextSource?.kind!=='business_notice'||options.businessHistoryVisible?.(m.contextSource.id,conv.id));const access=new Map<string,boolean>();
    for(const m of messages)if(m.platform&&!access.has(m.platform.taskId)){
      try{await tasks.refreshTaskContext(scope,m.platform.taskId);access.set(m.platform.taskId,true);}catch{access.set(m.platform.taskId,false);}
    }
    const filtered=messages.filter(m=>!m.platform||access.get(m.platform.taskId));return options.imageHistory?options.imageHistory(filtered,scope):filtered;
  }
  const entityScope=(conv:Conversation)=>({workspaceId:conv.workspace_id,entityId:conv.entity_id});
  function maintenanceConversation(request:RuntimeMaintenanceRequest):Conversation {
    if(!options.authorizeMaintenance?.(request))return fail(403,'maintenance_lease_forbidden');
    const a=request.authorization,conv=repository.get(a.conversationId);
    if(!conv||conv.mode!=='real'||conv.workspace_id!==a.workspaceId||conv.entity_id!==a.entityId||conv.expires_at>0&&conv.expires_at<=now())return fail(403,'maintenance_conversation_forbidden');
    checkMaintenanceAuthority(conv);
    if(a.sessionId!==conv.id)return fail(403,'maintenance_session_forbidden');
    return conv;
  }
  function checkMaintenanceAuthority(conv:Conversation):void {
    tasks.assertActive({...entityScope(conv),...(conv.user_id?{userId:conv.user_id}:{})});
    if(entities.getRuntimeDefinition(conv.workspace_id,conv.entity_id)?.interactionRuntime!=='builtin-interaction')return fail(403,'runtime_binding_changed');
    if(conv.user_id){tasks.authorizeLocal({...entityScope(conv),userId:conv.user_id});}
    else if(!options.authorizeConversationMaintenance?.(conv))return fail(403,'maintenance_service_forbidden');
  }
  function maintenanceRevision(conv:Conversation):string|undefined {
    if(conv.user_id)return options.modelClientForScope?options.modelRevisionForScope?.({...entityScope(conv),userId:conv.user_id}):options.modelClient?'injected-v1':undefined;
    return options.modelClientForMaintenance?options.modelRevisionForMaintenance?.(conv):options.modelClient?'injected-v1':undefined;
  }
  async function maintenanceModel(conv:Conversation){
    if(conv.user_id)return options.modelClientForScope?options.modelClientForScope({...entityScope(conv),userId:conv.user_id}):options.modelClient?{client:options.modelClient,revision:'injected-v1'}:undefined;
    return options.modelClientForMaintenance?options.modelClientForMaintenance(conv):options.modelClient?{client:options.modelClient,revision:'injected-v1'}:undefined;
  }
  const maintenanceHooks:Pick<BuiltinRuntimeOptions,'authorizeMaintenance'|'authorizeMaintenanceReplacement'|'publishMaintenance'>={
    async authorizeMaintenance(request){try{
      const conv=maintenanceConversation(request),current=await maintenanceModel(conv);
      const fresh=maintenanceConversation(request),revision=maintenanceRevision(fresh);
      return !!current&&!!revision&&current.revision===revision&&request.authorization.configRevision===configRevision(entityScope(fresh),revision);
    }catch{return false;}},
    async authorizeMaintenanceReplacement(currentRequest,previousRequest){return store.transaction(()=>{try{
      const conv=maintenanceConversation(currentRequest),a=currentRequest.authorization,b=previousRequest.authorization,revision=maintenanceRevision(conv);
      if(!revision||a.configRevision!==configRevision(entityScope(conv),revision)||a.jobRunId===b.jobRunId||a.workspaceId!==b.workspaceId||a.entityId!==b.entityId||a.conversationId!==b.conversationId||a.sessionId!==b.sessionId)return false;
      const old=store.one<{status:string;lease_until:number;payload_json:string}>('SELECT status,lease_until,payload_json FROM scheduled_jobs WHERE id=?',b.jobRunId);
      if(!old||!['succeeded','skipped','failed'].includes(old.status)||old.lease_until>now())return false;
      const payload=JSON.parse(old.payload_json);return payload.session?.sessionId===a.sessionId&&payload.session?.runtime?.workspaceId===a.workspaceId&&payload.session?.runtime?.entityId===a.entityId&&payload.session?.scope?.conversationId===a.conversationId;
    }catch{return false;}});},
    async publishMaintenance(request,changes){return store.transaction(()=>{try{
      const conv=maintenanceConversation(request),revision=maintenanceRevision(conv);
      if(!revision||request.authorization.configRevision!==configRevision(entityScope(conv),revision))return false;
      return compareBuiltinRecords(store,changes,now,options.assertRuntimeOwner,journal);
    }catch{return false;}});},
  };
  async function maintenanceAdapter(conv:Conversation){
    // Reload canonical metadata; a caller cannot substitute another binding or source tuple.
    const current=repository.get(conv.id);if(!current||current.user_id||current.mode!=='real'||current.expires_at>0&&current.expires_at<=now())return fail(403,'maintenance_conversation_forbidden');
    checkMaintenanceAuthority(current);const resolved=await maintenanceModel(current);
    const fresh=repository.get(conv.id);if(!fresh)return fail(403,'maintenance_conversation_forbidden');checkMaintenanceAuthority(fresh);
    const modelRevision=maintenanceRevision(fresh);if(!resolved||!modelRevision||resolved.revision!==modelRevision)return fail(409,'maintenance_model_unavailable');
    const revision=configRevision(entityScope(fresh),modelRevision),cacheKey=`maintenance:${fresh.id}:${revision}`;let runtime=adapters.get(cacheKey);
    if(!runtime){runtime=new BuiltinInteractionRuntime({...(resolved.client?{modelClient:resolved.client}:{}),...stores,journal,tools:[],now,...(options.diagnostics?{diagnostics:options.diagnostics}:{}),...maintenanceHooks,
      async authorize(){return false;},async readContent(){return fail(403,'maintenance_only');},async writeOutput(){return fail(403,'maintenance_only');},async filterHistory(){return fail(403,'maintenance_only');},async filterToolResult(){return fail(403,'maintenance_only');},
    });adapters.set(cacheKey,runtime);}
    // Return only the maintenance surface, not provisioning, submit, tools or arbitrary reads.
    return {revision,runtime:{inspectContext:runtime.inspectContext.bind(runtime),requestMaintenance:runtime.requestMaintenance.bind(runtime),getMaintenanceStatus:runtime.getMaintenanceStatus.bind(runtime)}};
  }
  async function adapter(scope:TaskScope,conv:Conversation,recordedRevision?:string,serviceEvent=false) {
    tasks.assertActive(scope);
    const saved=repository.activeTurns(conv.id).some(t=>{try{const r=JSON.parse(t.request_json??'{}');return (r.admissionAuthorized===true||r.payload?.input?.admissionAuthorized===true)&&scopeActorKey(scopeFromJson(t.scope_json??'{}'))===scopeActorKey(scope);}catch{return false;}});if(!saved&&!recordedRevision&&!serviceEvent)tasks.authorizeLocal(scope);
    if(entities.getRuntimeDefinition(scope.workspaceId,scope.entityId)?.interactionRuntime!=='builtin-interaction')return fail(409,'interaction_runtime_unavailable');
    let current:{client:ModelClientPort;revision:string}|undefined;try{current=options.modelClientForScope?await options.modelClientForScope(scope):options.modelClient?{client:options.modelClient,revision:'injected-v1'}:undefined;}catch(error){if(!recordedRevision)throw error;}const resolved=recordedRevision?{client:current&&configRevision(scope,current.revision)===recordedRevision?current.client:undefined,revision:recordedRevision}:current;
    if(!resolved)return fail(409,'model_not_configured');const revision=recordedRevision??configRevision(scope,resolved.revision),cacheKey=`${recordedRevision?'recorded:':''}${conv.id}:${revision}:${scopeActorKey(scope)}`;let runtime=adapters.get(cacheKey);
    if(!runtime){runtime=new BuiltinInteractionRuntime({...(resolved.client?{modelClient:resolved.client}:{}),...stores,journal,tools,now,inputQueue,onInteractionEvent,...(options.assertRuntimeOwner?{assertOwner:options.assertRuntimeOwner}:{}),...(options.previousOwnerUnavailable?{previousOwnerUnavailable:options.previousOwnerUnavailable}:{}),...(options.authorizeHistoryBatch?{authorizeHistoryBatch:options.authorizeHistoryBatch}:{}),...(options.diagnostics?{diagnostics:options.diagnostics}:{}),
      sessionScopeBinding(c){const{conv}=authorized(c);return digest([conv.workspace_id,conv.entity_id,conv.id,conv.owner_key]);},
      async authorize(c,action){try{options.assertRuntimeOwner?.();if((c as AuthorizationContext).trigger?.kind==='business_notification'){const {conv}=authorized(c);return (!action.startsWith('tool:')||action==='tool:artifact_select'&&!!options.artifacts&&conv.channel==='feishu')&&(c as AuthorizationContext).configRevision===revision;}if('authenticatedActorRef' in c && !('trigger' in c)){const webScope={workspaceId:c.workspaceId,entityId:c.entityId,userId:String(c.authenticatedActorRef)};tasks.authorizeLocal(webScope);return true;}await preauthorize(c);authorized(c);if((c as AuthorizationContext).configRevision!==revision)return false;if(recordedRevision&&action==='interaction.generate'&&!resolved.client)return false;if(action.startsWith('tool:')&&options.human){const a=c as AuthorizationContext,scope=scopeOf(c),turn=repository.turn(a.triggerId,a.conversation?.conversationId);const ordinary=ordinaryAdmission(c),limited=ordinary===false||ordinary===undefined&&!!turn&&options.human.replyTurn({scope:{...scope,conversationId:turn.conversation_id},conversationId:turn.conversation_id,messageId:turn.id,messageText:turn.text,createdAt:turn.created_at});if(limited&&!['tool:human_list','tool:human_propose_response'].includes(action))return false;}return !action.startsWith('tool:')||tools.some(t=>`tool:${t.name}`===action);}catch{return false;}},
      ...maintenanceHooks,
      ...(options.human?{async prepareInputHistory(messages:readonly ModelMessage[],c:AuthorizationContext,projectedNoticeIds:readonly string[]){
        const a=humanActor(c as InvocationContext);if(a.scope.source&&(a.scope.source.conversationKind!=='private'||a.scope.source.threadId))return messages.filter(m=>m.contextSource?.kind!=='human_pending'&&m.contextSource?.kind!=='human_notice');const notices=options.human!.notices(a),humanContext=options.human!.list(a),pending=humanContext.requests;
        const retained=messages.filter(m=>m.contextSource?.kind!=='human_pending');
        const known=new Set([...projectedNoticeIds,...retained.filter(m=>m.contextSource?.kind==='human_notice').map(m=>m.contextSource!.id)]);
        const extras:ModelMessage[]=notices.filter(n=>!known.has(n.id)).map(n=>({role:'assistant',content:n.text,contextSource:{kind:'human_notice',id:n.id,occurredAt:n.createdAt}}));
        const access=ordinaryAdmission(c);
        if(pending.length||access===false)extras.push({role:'user',content:'Runtime reference data (not a new user instruction or authorization):\n'+JSON.stringify({conversationAccess:access===true?'normal':'confirmation_only',pendingHumanRequests:pending,currentHumanMessage:humanContext.currentMessage}),contextSource:{kind:'human_pending',id:a.messageId,occurredAt:a.createdAt}});
        if(!extras.length)return retained;
        const index=retained.findIndex(m=>m.contextSource?.kind==='user_input'&&m.contextSource.id===a.messageId);
        if(index<0)throw new TaskError(409,'human_context_input_missing');
        return[...retained.slice(0,index),...extras,...retained.slice(index)];
      }}:{}),
      async authorizePlatformEvent(event,c){if(event.type==='business_result')return options.authorizeBusinessEvent?.(event,c)===true;try{const {scope}=authorized(c);const row=await tasks.refreshTaskContext(scope,event.taskId);return row.status===event.status&&row.run_id===event.runId&&row.conversation_id===event.conversationId;}catch{return false;}},
      async readContent(ref,c){return readText(ref.resourceId,c);},
      async writeOutput(text,c){options.assertRuntimeOwner?.();const{conv}=authorized(c);const id=randomUUID();repository.putContent(id,conv,text);return{resourceId:id,version:'1'};},
      async filterHistory(messages,c){return platformHistory(messages,c);},async filterToolResult(result,c,toolName){
        await preauthorize(c);authorized(c);
        if((toolName==='task_supplement'||toolName==='task_cancel')&&result&&typeof result==='object'&&'status' in result&&result.status==='rejected'){
          const expectedAction=toolName==='task_cancel'?'cancel':'supplement';
          if(!('taskId' in result)||!('action' in result)||result.action!==expectedAction||!('error' in result)||!result.error||typeof result.error!=='object'||!('code' in result.error)||result.error.code!=='version_conflict'||!('applied' in result.error)||result.error.applied!==false)return fail(403,'task_result_forbidden');
          const {row}=await contextualTask(c,result.taskId);
          // Re-project cached rejections and check current access, without changing their outcome.
          return mutationVersionRejection(row.id,expectedAction);
        }
        if(toolName==='artifact_select'){if(!result||typeof result!=='object'||!('taskId'in result))return fail(403,'artifact_selection_invalid');if(c.trigger.kind!=='business_notification')await contextualTask(c,result.taskId);return result;}
        // Completed-operation caches prevent repeated writes, never bypass current Task grants.
        const projectTask=async(value:unknown)=>{
          if(!value||typeof value!=='object'||!('id' in value))return fail(403,'task_result_forbidden');
          const {row}=await contextualTask(c,value.id);
          const receipt='actionReceipt' in value?value.actionReceipt:undefined;
          const operationId=receipt&&typeof receipt==='object'&&'operationId' in receipt?taskString(receipt.operationId,160):undefined;
          return{...taskModelView(tasks.dto(row,operationId),toolName==='task_query'||toolName==='task_query_results'?tasks.getUpdates(authorized(c).scope,row.id):undefined),...(options.artifacts?{artifacts:options.artifacts.list(row.id),artifactDeliveries:options.artifacts.deliveryViews(row.id)}:{})};
        };
        if(toolName==='task_list'){
          if(!result||typeof result!=='object'||!('tasks' in result)||!Array.isArray(result.tasks))return fail(403,'task_result_forbidden');
          const projected=[];for(const value of result.tasks)projected.push(await projectTask(value));
          return {tasks:projected,nextCursor:'nextCursor' in result?result.nextCursor:null};
        }
        return toolName.startsWith('task_')?projectTask(result):result;
      },
    });adapters.set(cacheKey,runtime);}return{runtime,revision,runtimeRef:{workspaceId:scope.workspaceId,entityId:scope.entityId,runtimeId:'builtin-interaction'}};
  }

  async function prepareSession(scope:TaskScope,conv:Conversation,request:import('@dentity/contracts').RuntimeRequest<Record<string,never>>,at:number,serviceEvent=false){
    eventScopes.set(request.authorizationContext.triggerId,scope);
    const {runtime,revision,runtimeRef}=await adapter(scope,conv,undefined,serviceEvent),c=request.authorizationContext;
    const offeredTools=tools.filter(t=>(t.name!=='artifact_select'||conv.channel==='feishu')&&(!t.name.startsWith('human_')||!scope.source||scope.source.conversationKind==='private'&&!scope.source.threadId));
    const envelope={...request,authorizationContext:c},ref=(resourceId:string)=>({resourceId,version:'1'}),prompt=interactionPrompt(employee(scope)),instructionId=`builtin:instructions:${conv.id}:${digest(prompt)}`,specHash=digest([scope.entityId,conv.owner_key,conv.id,revision,prompt,offeredTools.map(({name,description,parameters})=>({name,description,parameters}))]);repository.putContent(instructionId,conv,prompt);
    const prepared=await runtime.prepareAgent({...envelope,authorizationContext:{...c,authenticatedActorRef:scopeActorKey(scope)},payload:{runtime:runtimeRef,idempotencyKey:specHash,spec:{specVersion:1,specId:`builtin:${scope.entityId}`,specHash,workspaceId:scope.workspaceId,entityId:scope.entityId,agentBindingId:conv.channel==='web'?'builtin-web':'builtin-channel',role:'interaction',thinkingLevel:'none',sourceVersions:{definition:'1',entityConfig:revision,profile:revision},instructions:ref(instructionId),modelProfileRef:ref(revision),skills:[],mcpServers:[],cliRequirements:[],platformTools:offeredTools.map(t=>t.name),knowledgeScopes:[],contextPolicyRef:'conversation-maintenance',authorizationRef:`conversation:${conv.id}`,limits:{timeoutSeconds:60,maxConcurrentTools:1},requiredCapabilities:['interactionTurn','toolAllowlist','trustedInvocationContext'],optionalCapabilities:[]},policy:{policyRef:'builtin-web',allowedOptionalDegradations:[],secretDelivery:'protected_only'}}});if(!prepared.ok)return fail(409,prepared.error.code);
    const sessionId=conv.id,session=await runtime.createSession({...envelope,payload:{handle:prepared.value,sessionId,idempotencyKey:sessionId,contextBootstrap:{scope:{kind:'interaction',conversationId:conv.id},mode:'new',snapshotId:sessionId,bundleRef:ref('builtin:empty'),inputRefs:[],knowledgeScopes:[],workStateViewRef:ref('builtin:empty'),budget:{maxTokens:32000,maxBytes:128000},provenance:{sourceRefs:[],authorizationDecisionRef:c.authorizationRef,createdAt:new Date(at).toISOString()}}}});if(!session.ok)return fail(409,session.error.code);return session.value;
  }
  async function acceptBusinessEvent(scope:TaskScope,conversationId:string,operationId:string,event:import('@dentity/contracts').RuntimeInteractionEvent){const conv=repository.get(conversationId);if(!conv||event.type!=='business_result')return fail(403,'notification_conversation_invalid');const{runtime,revision}=await adapter(scope,conv,undefined,true);
    const source=store.one<{target_json:string}>('SELECT target_json FROM business_notification_jobs WHERE id=?',event.eventId);if(!source)return fail(403,'notification_event_missing');const target=JSON.parse(source.target_json),rawSource=target.conversation;const c:AuthorizationContext={workspaceId:conv.workspace_id,entityId:conv.entity_id,authorizationRef:'business-notification:'+event.eventId,grantRef:event.eventId,triggerId:operationId,sourceEventRef:event.eventId,configRevision:revision,expiresAt:new Date(now()+60000).toISOString(),trigger:{kind:'business_notification',eventId:event.eventId},sourceChannel:{channelType:conv.channel,tenantId:rawSource?.tenantId??conv.workspace_id,installationId:rawSource?.connectionId??'web'},conversation:{conversationId:conv.id,kind:rawSource?.conversationKind??'private',...(target.threadId?{threadId:target.threadId}:{})}};authorized(c);if(!options.authorizeBusinessEvent?.(event,c))return fail(403,'notification_event_invalid');const request={schemaVersion:1 as const,operationId,correlationId:operationId,causationId:operationId,deadlineAt:new Date(now()+60000).toISOString(),authorizationContext:c},session=await prepareSession(scope,conv,{...request,payload:{}},now(),true);if(!runtime.acceptInteractionEvent)return{receipt:{eventId:event.eventId,status:'unsupported' as const}};const receipt=await runtime.acceptInteractionEvent({...request,payload:{session,event,idempotencyKey:operationId}});return{receipt,...(receipt.status==='processed'&&receipt.outputRef?{text:readText(receipt.outputRef.resourceId,c)}:{})};}
  return {acceptBusinessEvent,onWork(listener){listeners.add(listener);return()=>listeners.delete(listener);},prepareSession,resolve:adapter,resolveRecorded:(scope,conv,revision)=>adapter(scope,conv,revision),resolveMaintenance:maintenanceAdapter,readOutput:readText,toolNames:tools.map(t=>t.name),
    async shutdown(){await Promise.all([...adapters.values()].map(adapter=>adapter.shutdown()));},
    purgeExpired(conversationIds){store.transaction(()=>purgeBuiltinRecords(store,conversationIds));for(const id of conversationIds){const c=repository.get(id);if(c&&c.expires_at>0&&c.expires_at<=now())journal.remove({workspaceId:c.workspace_id,entityId:c.entity_id,conversationId:c.id});}},
  };
}
