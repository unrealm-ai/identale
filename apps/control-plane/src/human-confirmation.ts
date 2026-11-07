import{renderHumanNotice,humanNoticeVersion}from'./human-notice.js';
import{humanClarification}from'./human-clarification.js';
import{humanDisplayCode,humanEvidenceSegments}from'./human-evidence.js';
import{recipientCandidate,type RecipientRouting}from'./human-recipient-router.js';
import{createHash,randomUUID}from'node:crypto';
import{validateHumanQuestion,type HumanCheckpoint,type HumanContinuation}from'@dentity/contracts';
import{TaskError,taskBody,scopeFromJson,type TaskHumanCoordinator,type TaskRuntimeEvent,type TaskRow,type TaskScope,type TaskRequestContext,type ConversationRepository}from'@dentity/application';
import type{Store}from'./store.js';
export interface HumanActor{scope:TaskRequestContext;conversationId:string;messageId:string;/** Runtime-resolved inbound parent message, never a model argument. */quotedMessageId?:string;messageText:string;createdAt:number}
export type HumanTarget={kind:'web';userId:string}|{kind:'channel';connectionId:string;userId:string;identityNamespace:'open_id'|'user_id';provider:'feishu'|'dingtalk'|'wecom';appId:string;tenantId:string};
interface Row{request_id:string;workspace_id:string;entity_id:string;task_id:string;source_run_id:string;session_id:string;question_json:string;question_digest:string;content_version:number;input_revision:number;safe:number;checkpoint_ref:string|null;status:string;target_json:string|null;target_conversation_id:string|null;response_json:string|null;response_digest:string|null;continuation_run_id:string|null;notification_status:string;notification_error:string|null;created_at:number;updated_at:number}
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x:unknown)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
function fail(status:number,code:string):never{throw new TaskError(status,code);}
/** Known transaction-rejected proposals are not employee-use denials or unknown effects. */
const proposalProblems:Record<string,{message:string;nextAction:'refresh_question'|'clarify'|'stop'}>={
 human_evidence_invalid:{message:'本次选取的答复片段不属于当前真实消息，尚未记录。请重新核对。',nextAction:'refresh_question'},
 human_answer_scope_mismatch:{message:'请在这个数字员工的主私聊回复人工确认，话题中的答复不会批准执行。',nextAction:'stop'},
 human_evidence_required:{message:'当前答复未能关联到本轮确认，尚未记录批准。请核对最新问题。',nextAction:'refresh_question'},
 human_question_changed:{message:'确认问题已更新，本次答复未记录。请先核对最新问题。',nextAction:'refresh_question'},
 human_request_ambiguous:{message:'有多个待确认问题，请明确本次回答的是哪一个。',nextAction:'clarify'},
 human_request_mismatch:{message:'答复中的请求编号与本次确认不一致，尚未记录批准。',nextAction:'clarify'},
 human_answer_predates_request:{message:'这条答复早于当前确认问题，不能用作本轮批准。',nextAction:'clarify'},
 human_task_input_changed:{message:'任务内容已变化，本次答复未记录。请重新核对确认范围。',nextAction:'refresh_question'},
 human_task_closed:{message:'任务已经结束，本次未执行新的确认或继续操作。',nextAction:'stop'},
 human_request_closed:{message:'这个确认请求已经结束，本次未继续执行。',nextAction:'stop'},
 human_answer_conflict:{message:'该问题已记录另一份答复，本次没有覆盖原决定。',nextAction:'clarify'},
 human_answer_forbidden:{message:'你不是此问题的指定确认人，本次答复未被记录。',nextAction:'stop'},
 invalid_human_answers:{message:'答复内容不符合当前问题要求，尚未记录批准。请核对必答项。',nextAction:'clarify'},
 invalid_human_decision:{message:'未能识别本轮确认的决定，请明确批准、拒绝或补充信息。',nextAction:'clarify'},
 invalid_human_response:{message:'本轮答复格式无法关联，尚未记录批准。请核对最新问题。',nextAction:'refresh_question'},
};
export interface HumanChannelDelivery{prepare(row:{workspaceId:string;entityId:string;requestId:string;target:Extract<HumanTarget,{kind:'channel'}>;text:string}):Promise<{conversationId:string;status:'queued'|'unknown'|'failed';reason?:string}>}
/** Runtime-owned persistent coordinator. Network delivery is outside transactions. */
export class HumanConfirmation implements TaskHumanCoordinator{
 private routing:RecipientRouting|undefined;
 private busy=false;private channels:HumanChannelDelivery|undefined;
 constructor(readonly store:Store,private readonly conversations:ConversationRepository,readonly now:()=>number=Date.now){}
 setRecipientRouting(value:RecipientRouting){if(this.routing)throw Error('recipient_router_already_set');this.routing=value;this.store.run("UPDATE human_requests SET notification_status='unknown',notification_error='human_recipient_selection_outcome_unknown',selection_json=json_set(coalesce(selection_json,'{}'),'$.status','unknown') WHERE notification_status='selecting'");}
 setChannels(value:HumanChannelDelivery){this.channels=value;}
 onEvent(task:TaskRow,event:TaskRuntimeEvent){const h=event.human;if(!h||h.taskId!==task.id||h.runId!==event.runId||h.contentVersion!==1||!h.requestId||!h.sessionId||!Number.isSafeInteger(h.inputRevision)||h.inputRevision<1||h.inputRevision>task.input_revision)fail(400,'invalid_human_event');validateHumanQuestion(h.question);if(sha(JSON.stringify(h.question))!==h.questionDigest)fail(400,'human_question_digest_mismatch');
  const source=this.store.one<{task_id:string;session_id:string}>('SELECT task_id,session_id FROM runs WHERE id=?',h.runId);if(!source||source.task_id!==task.id||source.session_id!==h.sessionId)fail(400,'human_session_mismatch');
  const old=this.store.one<Row>('SELECT * FROM human_requests WHERE request_id=?',h.requestId);
  if(old&&(old.source_run_id!==h.runId||old.input_revision!==h.inputRevision||old.question_digest!==h.questionDigest||old.session_id!==h.sessionId||old.task_id!==task.id||old.checkpoint_ref!==null&&h.safe&&old.checkpoint_ref!==h.checkpointRef))fail(409,'human_request_conflict');
  if(!old)this.store.run('INSERT INTO human_requests(request_id,workspace_id,entity_id,task_id,source_run_id,session_id,question_json,question_digest,input_revision,content_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)',h.requestId,task.workspace_id,task.entity_id,task.id,h.runId,h.sessionId,JSON.stringify(h.question),h.questionDigest,h.inputRevision,this.now(),this.now());
  if(event.type==='human_safe'){if(!h.safe||!h.checkpointRef)fail(400,'human_checkpoint_not_safe');this.store.run('UPDATE human_requests SET safe=1,checkpoint_ref=?,updated_at=? WHERE request_id=?',h.checkpointRef,this.now(),h.requestId);this.store.run("UPDATE runs SET status='needs_human',end_reason='needs_human_input',terminal_at=coalesce(terminal_at,?) WHERE id=?",this.now(),h.runId);if(task.run_id===h.runId)this.store.run("UPDATE tasks SET status='waiting_human',version=version+1,updated_at=? WHERE id=? AND run_id=? AND status NOT IN('canceled','failed','succeeded','cancel_requested')",this.now(),task.id,h.runId);if(task.status==='cancel_requested')this.cancelTask(task.id);}
 }
 private selectTarget(row:Row):HumanTarget{
  const question=JSON.parse(row.question_json)as HumanCheckpoint['question'];const rules=JSON.parse(this.store.one<{rules_json:string}>('SELECT rules_json FROM employee_human_rules WHERE workspace_id=? AND entity_id=?',row.workspace_id,row.entity_id)?.rules_json??'[]')as {questionScope:string;target:HumanTarget}[];
  const selected=rules.find(r=>r.questionScope===question.questionScope)??rules.find(r=>r.questionScope==='*');if(selected)return selected.target;
  if(this.store.one('SELECT id FROM employee_channel_connections WHERE workspace_id=? AND entity_id=? LIMIT 1',row.workspace_id,row.entity_id))return fail(409,'human_recipient_not_configured');
  const creator=this.store.one<{user_id:string}>('SELECT m.user_id FROM entities e JOIN members m ON m.id=e.created_by_member_id WHERE e.workspace_id=? AND e.id=?',row.workspace_id,row.entity_id);if(!creator)return fail(409,'human_creator_unavailable');return{kind:'web',userId:creator.user_id};
 }
 private async routeTarget(row:Row):Promise<HumanTarget>{
  if(!this.routing)return this.selectTarget(row); // Pure coordinator fixtures; production always installs the model router.
  const rulesJson=this.store.one<{rules_json:string}>('SELECT rules_json FROM employee_human_rules WHERE workspace_id=? AND entity_id=?',row.workspace_id,row.entity_id)?.rules_json??'[]';
  const rules=JSON.parse(rulesJson)as{questionScope:string;target:HumanTarget}[];
  if(!rules.length)rules.push({questionScope:'*',target:this.selectTarget(row)});
  const candidates=[];for(const r of rules)if(await this.routing.authorize(row.workspace_id,row.entity_id,r.target))candidates.push(recipientCandidate(r.questionScope,r.target));
  if(!candidates.length)fail(403,'human_recipient_use_forbidden');
  const configDigest=sha(rulesJson),startedAt=this.now();
  this.store.run("UPDATE human_requests SET notification_status='selecting',selection_json=? WHERE request_id=? AND target_json IS NULL",JSON.stringify({version:1,status:'started',configDigest,candidateIds:candidates.map(c=>c.candidateId),startedAt}),row.request_id);
  const task=this.store.one<TaskRow>('SELECT * FROM tasks WHERE id=?',row.task_id);if(!task)fail(404,'task_not_found');
  const unique=[...new Map(candidates.map(c=>[JSON.stringify(c.target),c])).values()];
  let choice:Awaited<ReturnType<RecipientRouting['choose']>>|undefined,selected:typeof candidates[number]|undefined,reason='single_authorized_recipient',fallback=false;
  if(unique.length===1)selected=unique[0];
  else{
   try{choice=await this.routing.choose(scopeFromJson(task.source_json,{workspaceId:task.workspace_id,entityId:task.entity_id,userId:task.user_id}),validateHumanQuestion(JSON.parse(row.question_json)),candidates,{requestId:row.request_id,taskId:row.task_id,runId:row.source_run_id,sessionId:row.session_id});selected=choice.candidateId==='none'?undefined:candidates.find(c=>c.candidateId===choice!.candidateId);reason=choice.candidateId==='none'?'model_uncertain':'model_selected';}
   catch{reason='model_selection_failed';}
   if(!selected){selected=candidates.find(c=>c.questionScope==='*');fallback=!!selected;}
  }
  if(!selected)fail(409,'human_recipient_ambiguous');
  if(!await this.routing.authorize(row.workspace_id,row.entity_id,selected.target))fail(403,'human_recipient_use_forbidden');
  return this.store.transaction(()=>{const current=this.store.one<{rules_json:string}>('SELECT rules_json FROM employee_human_rules WHERE workspace_id=? AND entity_id=?',row.workspace_id,row.entity_id)?.rules_json??'[]';if(current!==rulesJson)fail(409,'human_recipient_configuration_changed');
   const active=this.store.one<{status:string;notification_status:string;target_json:string|null}>('SELECT status,notification_status,target_json FROM human_requests WHERE request_id=?',row.request_id);if(!active||active.status!=='waiting'||active.notification_status!=='selecting'||active.target_json)fail(409,'human_request_changed');
   this.store.run("UPDATE human_requests SET target_json=?,notification_status='pending',selection_json=?,updated_at=? WHERE request_id=? AND target_json IS NULL AND notification_status='selecting'",JSON.stringify(selected!.target),JSON.stringify({version:1,status:'selected',configDigest,candidateId:selected!.candidateId,fallback,reason,...(choice?{model:choice.model,revision:choice.revision,usage:choice.usage}:{}),startedAt,completedAt:this.now()}),this.now(),row.request_id);return selected!.target;});
 }
 /** No reset after an uncertain/queued delivery. The same request/question survives retry. */
 canRetryRecipient(requestId:string){const row=this.store.one<Row>('SELECT * FROM human_requests WHERE request_id=?',requestId);return !!row&&row.status==='waiting'&&['blocked','failed'].includes(row.notification_status)&&!row.notification_error?.includes('unknown')&&!this.hasNotice(requestId);}
 private hasNotice(requestId:string){return !!(this.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='human_channel_notices'")&&this.store.one('SELECT id FROM human_channel_notices WHERE request_id=?',requestId));}
 retryRecipient(workspaceId:string,requestId:string,body:unknown){const b=taskBody(body,['expectedUpdatedAt','expectedNotificationStatus']);return this.store.transaction(()=>{
  const row=this.store.one<Row>('SELECT * FROM human_requests WHERE request_id=? AND workspace_id=?',requestId,workspaceId);if(!row)fail(404,'human_request_not_found');
  if(['selecting','unknown','sending','queued'].includes(row.notification_status))fail(409,'human_notification_requires_reconciliation');
  if(!this.canRetryRecipient(requestId))fail(409,'human_recipient_retry_unavailable');
  if(b.expectedUpdatedAt!==row.updated_at||b.expectedNotificationStatus!==row.notification_status)fail(409,'human_request_changed');
  const task=this.store.one<TaskRow>('SELECT * FROM tasks WHERE id=?',row.task_id);if(!task||task.run_id!==row.source_run_id||!['running','queued','waiting_human'].includes(task.status))fail(409,'human_request_closed');
  this.store.run("UPDATE human_requests SET target_json=NULL,target_conversation_id=NULL,notification_status='pending',notification_error=NULL,selection_json=NULL,updated_at=? WHERE request_id=? AND notification_status=?",this.now(),requestId,row.notification_status);return{requestId,status:'pending'};
 });}

 private render(row:Row){const q=JSON.parse(row.question_json)as HumanCheckpoint['question'];const saved=this.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='human_channel_notices'")?this.store.one<{text:string;scope_json:string}>('SELECT text,scope_json FROM human_channel_notices WHERE request_id=?',row.request_id):undefined;if(saved&&humanNoticeVersion(row.request_id,saved.text,saved.scope_json)===row.content_version)return saved.text;return renderHumanNotice(row.request_id,q);}
 private quote(a:HumanActor){const clarification=this.clarification(a,true);if(clarification?.requests.length===1)return clarification.requests[0];if(!a.quotedMessageId||!a.scope.source||a.scope.source.threadId||a.scope.source.conversationKind!=='private'||!this.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='human_channel_notices'"))return;const rows=this.store.all<Row&{notice_text:string;notice_scope:string;notice_target:string}>("SELECT r.*,n.text AS notice_text,n.scope_json AS notice_scope,n.target_json AS notice_target FROM human_requests r JOIN human_channel_notices n ON n.request_id=r.request_id JOIN channel_message_receipts c ON c.id=n.id AND c.kind='outbox' AND c.status='sent' WHERE c.message_id=? AND c.connection_id=? AND r.workspace_id=? AND r.entity_id=?",a.quotedMessageId,a.scope.source.connectionId,a.scope.workspaceId,a.scope.entityId).filter(r=>{if(!this.actorMatches(r,a))return false;try{const t=JSON.parse(r.target_json!)as Extract<HumanTarget,{kind:'channel'}>,n=JSON.parse(r.notice_scope),target=JSON.parse(r.notice_target),c=target.conversation;return n.kind==='human_confirmation_notification'&&n.requestId===r.request_id&&n.workspaceId===r.workspace_id&&n.entityId===r.entity_id&&n.source?.connectionId===t.connectionId&&n.source?.appId===t.appId&&n.source?.tenantId===t.tenantId&&!n.source?.threadId&&!target.threadId&&c?.externalId==='human-user:'+t.identityNamespace+':'+t.userId&&c.conversationKind==='private'&&c.provider===t.provider&&c.connectionId===t.connectionId&&c.tenantId===t.tenantId&&c.privateRecipientId===t.userId&&c.privateRecipientNamespace===t.identityNamespace;}catch{return false;}});if(rows.length!==1)return;const r=rows[0]!,version=humanNoticeVersion(r.request_id,r.notice_text,r.notice_scope);return{requestId:r.request_id,contentVersion:version,currentContentVersion:r.content_version,stale:version!==r.content_version};}
 private clarification(a:HumanActor,quoted=false){if(quoted&&!a.quotedMessageId)return;const rows=this.store.all<Row>('SELECT * FROM human_requests WHERE workspace_id=? AND entity_id=?',a.scope.workspaceId,a.scope.entityId).filter(r=>this.actorMatches(r,a));return humanClarification(this.store,this.conversations,a,rows,quoted?a.quotedMessageId:undefined);}
 referencedDelivery(id:string){if(id.startsWith('human-question:'))return !!this.store.one("SELECT 1 FROM human_requests WHERE request_id=? AND status IN('waiting','confirmed')",id.slice('human-question:'.length));return !!this.store.one("SELECT 1 FROM channel_deliveries d JOIN human_response_messages m ON m.message_id=json_extract(d.correlation_json,'$.turnId') JOIN human_requests r ON r.request_id=m.request_id WHERE d.id=? AND r.status IN('waiting','confirmed') AND json_extract(m.candidate_json,'$.decision')='needs_more' AND json_extract(m.candidate_json,'$.association') IN('current_message','clarification') AND length(json_extract(m.candidate_json,'$.clarificationText'))>0 AND json_extract(m.candidate_json,'$.contentVersion')=r.content_version LIMIT 1",id);}
 private mentioned(row:Row,text:string){return text.includes(row.request_id)||text.toUpperCase().includes(humanDisplayCode(row.request_id));}
 private requestView(r:Row){return{requestId:r.request_id,displayCode:humanDisplayCode(r.request_id),title:(JSON.parse(r.question_json)as HumanCheckpoint['question']).goal,contentVersion:r.content_version,questionDigest:r.question_digest,inputRevision:r.input_revision,question:JSON.parse(r.question_json),safe:r.safe===1,status:r.status,continuationRunId:r.continuation_run_id};}
 private actorMatches(row:Row,a:HumanActor){const t=row.target_json?JSON.parse(row.target_json)as HumanTarget:undefined;if(!t||a.scope.workspaceId!==row.workspace_id||a.scope.entityId!==row.entity_id)return false;return t.kind==='web'?!a.scope.source&&a.scope.userId===t.userId&&row.target_conversation_id===a.conversationId&&!!this.store.one("SELECT m.id FROM members m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND m.status='active' AND u.status='active' AND w.status='active'",row.workspace_id,t.userId):!!a.scope.source&&a.scope.source.conversationKind==='private'&&!a.scope.source.threadId&&a.scope.source.connectionId===t.connectionId&&a.scope.source.applicationId===t.appId&&a.scope.source.tenantId===t.tenantId&&a.scope.principal?.channelType===t.provider&&a.scope.principal.identityNamespace===t.identityNamespace&&a.scope.principal.externalUserId===t.userId;}
 canReply(scope:TaskScope&{conversationId?:string|null},text?:string){if(scope.source&&(scope.source.conversationKind!=='private'||!!scope.source.threadId))return false;return this.store.all<Row>("SELECT * FROM human_requests WHERE workspace_id=? AND entity_id=? AND target_json IS NOT NULL AND status IN('waiting','confirmed','continued')",scope.workspaceId,scope.entityId).some(row=>this.actorMatches(row,{scope:{...scope,conversationId:scope.conversationId??null},conversationId:scope.conversationId??(!scope.source?row.target_conversation_id??'':''),messageId:'',messageText:'',createdAt:this.now()})&&(row.status!=='continued'||!!text?.includes(row.request_id)));}
 replyTurn(a:HumanActor){return this.canReply({...a.scope,conversationId:a.conversationId},a.messageText)||this.store.all<Row>('SELECT r.* FROM human_requests r JOIN human_response_messages m ON m.request_id=r.request_id WHERE m.message_id=?',a.messageId).some(row=>this.actorMatches(row,a));}
 list(a:HumanActor,parameters:Record<string,unknown>={}){if(a.scope.source&&(a.scope.source.conversationKind!=='private'||a.scope.source.threadId))fail(403,'human_confirmation_main_private_required');const page=parameters.page??1,pageSize=parameters.pageSize??20;if(Object.keys(parameters).some(k=>!['page','pageSize','requestId'].includes(k))||!Number.isSafeInteger(page)||Number(page)<1||!Number.isSafeInteger(pageSize)||Number(pageSize)<1||Number(pageSize)>50||parameters.requestId!==undefined&&typeof parameters.requestId!=='string')fail(400,'invalid_human_list_page');const quote=this.quote(a),focus=this.clarification(a),quoted=this.clarification(a,true),all=this.store.all<Row>("SELECT * FROM human_requests WHERE workspace_id=? AND entity_id=? AND status IN('waiting','confirmed','continued') ORDER BY created_at,request_id",a.scope.workspaceId,a.scope.entityId).filter(r=>this.actorMatches(r,a)&&(r.status!=='continued'||this.mentioned(r,a.messageText)||quote?.requestId===r.request_id)),rows=parameters.requestId===undefined?all:all.filter(r=>r.request_id===parameters.requestId||humanDisplayCode(r.request_id)===String(parameters.requestId).toUpperCase()),total=rows.length,offset=(Number(page)-1)*Number(pageSize),hasMore=offset+Number(pageSize)<total;return{page:Number(page),pageSize:Number(pageSize),total,totalPages:Math.ceil(total/Number(pageSize)),hasMore,truncated:hasMore||offset>0,currentMessage:{id:a.messageId,text:a.messageText,segments:humanEvidenceSegments(a.messageId,a.messageText),...(quote?{quotedRequest:quote}:{}),...(a.quotedMessageId?{quotePresent:true,quotedRequests:quoted?.requests??(quote?[quote]:[])}:{}),...(focus?{clarificationFocus:focus}:{})},requests:rows.slice(offset,offset+Number(pageSize)).map(r=>this.requestView(r)),referencedRequests:all.filter(r=>this.mentioned(r,a.messageText)||quote?.requestId===r.request_id||focus?.requests.some(f=>f.requestId===r.request_id)||quoted?.requests.some(f=>f.requestId===r.request_id)).slice(0,20).map(r=>this.requestView(r)),pagination:'Live authorized list ordered by createdAt/requestId; new/closed requests can shift pages. Explicit requestId/displayCode lookup or trusted quote is independent of the current page.'};}
 /** Original, durably sent notices only; no model call or channel send occurs here. */
 notices(a:HumanActor):{id:string;text:string;createdAt:number}[]{
  if(a.scope.source&&a.scope.source.conversationKind!=='private')return[];
  const rows=this.store.all<Row>('SELECT * FROM human_requests WHERE workspace_id=? AND entity_id=? AND target_json IS NOT NULL ORDER BY created_at DESC LIMIT 200',a.scope.workspaceId,a.scope.entityId).filter(r=>this.actorMatches(r,a));
  const webMessages=!a.scope.source?this.conversations.messages(a.conversationId,this.now()):[];
  const channelTable=!!this.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='human_channel_notices'");
  const result:{id:string;text:string;createdAt:number}[]=[];
  for(const r of rows){
   const id='human-notice:'+r.request_id;
   if(!a.scope.source){const m=webMessages.find(m=>m.id==='human-request:'+r.request_id&&m.role==='assistant');if(m&&m.createdAt<=a.createdAt)result.push({id,text:m.text,createdAt:m.createdAt});continue;}
   if(!channelTable)continue;
   const n=this.store.one<{text:string;scope_json:string;target_json:string;sent_at:number}>("SELECT n.text,n.scope_json,n.target_json,c.updated_at AS sent_at FROM human_channel_notices n JOIN channel_message_receipts c ON c.id=n.id AND c.kind='outbox' AND c.status='sent' WHERE n.request_id=?",r.request_id);
   if(!n||n.sent_at>a.createdAt)continue;
   const target=JSON.parse(r.target_json!)as Extract<HumanTarget,{kind:'channel'}>,route=JSON.parse(n.target_json).conversation,source=JSON.parse(n.scope_json);
   if(source.kind!=='human_confirmation_notification'||source.workspaceId!==r.workspace_id||source.entityId!==r.entity_id||source.requestId!==r.request_id||source.taskId!==r.task_id||source.runId!==r.source_run_id||source.source?.connectionId!==target.connectionId||source.source?.appId!==target.appId||source.source?.tenantId!==target.tenantId||route?.externalId!=='human-user:'+target.identityNamespace+':'+target.userId||route?.conversationKind!=='private'||route.provider!==target.provider||route.connectionId!==target.connectionId||route.tenantId!==target.tenantId||route.privateRecipientId!==target.userId||route.privateRecipientNamespace!==target.identityNamespace)continue;
   result.push({id,text:n.text,createdAt:n.sent_at});
  }
  return result.sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id)).slice(-20);
 }
 /** Model boundary: current evidence is always the actual trusted turn, never a model ID.
  * Legacy evidenceMessageIds is accepted only for old tool histories and is NOT used as
  * current or historical evidence. There is no model-selectable history-evidence port.
  */
 proposeResponse(a:HumanActor,proposal:Record<string,unknown>,operationId?:string){
  const candidate:Record<string,unknown>={...proposal,evidenceMessageIds:[a.messageId]};
  const id=operationId??'human:'+sha(canonical([a.conversationId,a.messageId,candidate]));
  try{return this.respond(a,candidate,id);}catch(error){
   if(!(error instanceof TaskError)||![400,403,409].includes(error.status)||!Object.hasOwn(proposalProblems,error.code))throw error;
   // respond's transaction has rolled back. Persist a definite no-effect receipt so a
   // crash before the builtin operation commit can reconcile without replaying a vote.
   return this.store.transaction(()=>{
    const actor=sha(canonical([a.scope,a.conversationId,a.messageId])),requestHash=sha(canonical(candidate));
    const old=this.store.one<{actor_digest:string;request_hash:string;result_json:string}>('SELECT * FROM human_response_operations WHERE operation_id=?',id);
    if(old){
     if(old.actor_digest!==actor||old.request_hash!==requestHash)fail(409,'human_operation_conflict');
     return this.currentReceipt(JSON.parse(old.result_json)as Record<string,unknown>);
    }
    const problem=proposalProblems[error.code]!;
    const result={status:'not_recorded',...(typeof candidate.requestId==='string'?{requestId:candidate.requestId}:{}),reason:error.code,message:problem.message,nextAction:problem.nextAction};
    this.store.run('INSERT INTO human_response_operations VALUES(?,?,?,?)',id,actor,requestHash,JSON.stringify(result));
    return result;
   });
  }
 }
 respond(a:HumanActor,candidate:Record<string,unknown>,operationId='human:'+sha(canonical([a.conversationId,a.messageId,candidate]))){return this.store.transaction(()=>{
  const actor=sha(canonical([a.scope,a.conversationId,a.messageId])),requestHash=sha(canonical(candidate)),old=this.store.one<{actor_digest:string;request_hash:string;result_json:string}>('SELECT * FROM human_response_operations WHERE operation_id=?',operationId);
  if(old){if(old.actor_digest!==actor||old.request_hash!==requestHash)fail(409,'human_operation_conflict');return this.currentReceipt(JSON.parse(old.result_json)as Record<string,unknown>);}
  const result=this.respondCandidate(a,candidate);this.store.run('INSERT INTO human_response_operations VALUES(?,?,?,?)',operationId,actor,requestHash,JSON.stringify(result));return this.currentReceipt(result);
 });}
 hasOpenRequest(taskId:string){return!!this.store.one("SELECT request_id FROM human_requests WHERE task_id=? AND status IN('waiting','confirmed')",taskId);}
 view(taskId:string){return this.store.all<{request_id:string;status:string;safe:number;notification_status:string;notification_error:string|null;continuation_run_id:string|null;question_json:string}>('SELECT request_id,status,safe,notification_status,notification_error,continuation_run_id,question_json FROM human_requests WHERE task_id=? ORDER BY created_at',taskId).map(r=>({requestId:r.request_id,status:r.status,safe:r.safe===1,notificationStatus:r.notification_status,notificationError:r.notification_error,continuationRunId:r.continuation_run_id,question:JSON.parse(r.question_json)as HumanCheckpoint['question']}));}
 private currentReceipt(result:Record<string,unknown>){if(['confirmed_waiting','continued'].includes(String(result.status))&&typeof result.requestId==='string'){const r=this.store.one<{continuation_run_id:string|null;status:string}>('SELECT continuation_run_id,status FROM human_requests WHERE request_id=?',result.requestId);if(r&&['canceled','rejected'].includes(r.status))return{...result,status:r.status};if(r?.continuation_run_id)return{...result,status:'continued',continuationRunId:r.continuation_run_id};}return result;}
 reconcile(a:HumanActor,operationId:string){const row=this.store.one<{actor_digest:string;result_json:string}>('SELECT * FROM human_response_operations WHERE operation_id=?',operationId);if(!row)return{status:'unknown' as const};if(row.actor_digest!==sha(canonical([a.scope,a.conversationId,a.messageId])))fail(403,'human_operation_forbidden');return{status:'completed' as const,result:this.currentReceipt(JSON.parse(row.result_json)as Record<string,unknown>)};}
 private respondCandidate(a:HumanActor,candidate:Record<string,unknown>){return this.store.transaction(()=>{
  if(Object.keys(candidate).some(k=>!['requestId','contentVersion','questionDigest','decision','answers','evidenceMessageIds','evidenceSegmentIds','missingFields','summary','association','clarificationText'].includes(k)))fail(400,'invalid_human_response');
  const row=this.store.one<Row>('SELECT * FROM human_requests WHERE request_id=?',String(candidate.requestId));if(row&&a.scope.source?.threadId){const{threadId,...source}=a.scope.source;if(this.actorMatches(row,{...a,scope:{...a.scope,source}}))fail(409,'human_answer_scope_mismatch');}if(!row||!this.actorMatches(row,a))fail(403,'human_answer_forbidden');
  const taskState=this.store.one<{status:string}>('SELECT status FROM tasks WHERE id=?',row.task_id)?.status;
  if(candidate.contentVersion!==row.content_version||candidate.questionDigest!==row.question_digest)fail(409,'human_question_changed');
  const evidence=candidate.evidenceMessageIds;if(!Array.isArray(evidence)||evidence.length>16||!evidence.includes(a.messageId)||evidence.some(id=>typeof id!=='string'||!this.conversations.turn(id,a.conversationId)))fail(400,'human_evidence_required');
  const active=this.store.all<Row>("SELECT * FROM human_requests WHERE workspace_id=? AND entity_id=? AND status IN('waiting','confirmed')",a.scope.workspaceId,a.scope.entityId).filter(r=>this.actorMatches(r,a)),segments=humanEvidenceSegments(a.messageId,a.messageText),selected=candidate.evidenceSegmentIds;
  if(selected!==undefined&&(!Array.isArray(selected)||!selected.length||selected.length>20||new Set(selected).size!==selected.length||selected.some(id=>typeof id!=='string'||!segments.some(s=>s.id===id))))fail(409,'human_evidence_invalid');
  const selectedSegments=Array.isArray(selected)?segments.filter(s=>selected.includes(s.id)):segments,selectedText=selectedSegments.map(s=>s.text).join(' '),quote=this.quote(a),known=this.store.all<Row>('SELECT * FROM human_requests WHERE workspace_id=? AND entity_id=? AND target_json IS NOT NULL',a.scope.workspaceId,a.scope.entityId).filter(r=>this.actorMatches(r,a)),bodyMarkers=known.filter(r=>this.mentioned(r,a.messageText)),selectedMarkers=known.filter(r=>this.mentioned(r,selectedText));
  if(quote?.stale)fail(409,'human_question_changed');
  if(quote&&quote.requestId!==row.request_id&&!(bodyMarkers.some(r=>r.request_id===quote.requestId)&&selectedMarkers.some(r=>r.request_id===row.request_id)))fail(409,'human_request_mismatch');
  if(selectedMarkers.length&&!selectedMarkers.some(r=>r.request_id===row.request_id))fail(409,'human_request_mismatch');
  const uuids:string[]=selectedText.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi)??[];if(uuids.length&&!uuids.includes(row.request_id))fail(409,'human_request_mismatch');
  if(active.filter(r=>humanDisplayCode(r.request_id)===humanDisplayCode(row.request_id)).length>1&&!selectedText.includes(row.request_id)&&quote?.requestId!==row.request_id)fail(409,'human_request_ambiguous');
  const association=candidate.association;if(association!==undefined&&!['current_message','clarification','unclear'].includes(String(association)))fail(400,'invalid_human_response');
  if(candidate.clarificationText!==undefined&&(typeof candidate.clarificationText!=='string'||!candidate.clarificationText.trim()||candidate.clarificationText.length>2000||candidate.decision!=='needs_more'))fail(400,'invalid_human_response');
  const direct=this.mentioned(row,selectedText)||quote?.requestId===row.request_id,focus=this.clarification(a),focusRefs=a.quotedMessageId?(this.clarification(a,true)?.requests??(quote?[quote]:[])):focus?.requests;
  if(association==='clarification'&&candidate.decision!=='needs_more'&&(!focusRefs||focusRefs.length!==1||focusRefs[0]!.requestId!==row.request_id))fail(409,'human_request_ambiguous');
  if(association==='clarification'&&focusRefs?.some(f=>f.stale))fail(409,'human_question_changed');
  if(candidate.decision!=='needs_more'&&(association==='unclear'||active.length>1&&!direct&&association!=='current_message'&&association!=='clarification'))fail(409,'human_request_ambiguous');
  if(a.createdAt<row.created_at)fail(409,'human_answer_predates_request');
  const decision=candidate.decision;if(!['approve','information','reject','needs_more','revise'].includes(String(decision)))fail(400,'invalid_human_decision');
  this.store.run('INSERT OR IGNORE INTO human_response_messages VALUES(?,?,?,?,?,?)',row.request_id,a.messageId,JSON.stringify(a.scope),a.messageText,JSON.stringify(candidate),this.now());
  const q=validateHumanQuestion(JSON.parse(row.question_json)),answers=candidate.answers;
  if(decision==='needs_more'){if(!['waiting','confirmed'].includes(row.status))fail(409,'human_request_closed');return{status:'needs_more',requestId:row.request_id,missingFields:candidate.missingFields??[],...(candidate.clarificationText?{clarificationText:candidate.clarificationText,association:'Only the actual persisted and delivered assistant message containing this question can establish clarification focus; this receipt is not approval.'}:{})};}
  if(!Array.isArray(answers)||answers.length>12||answers.some(x=>!x||typeof x!=='object'||Object.keys(x).some(k=>!['questionId','value'].includes(k))||typeof x.questionId!=='string'||!['string','number','boolean'].includes(typeof x.value)))fail(400,'invalid_human_answers');
  if(new Set(answers.map(x=>x.questionId)).size!==answers.length||answers.some(a=>!q.questions.some(x=>x.id===a.questionId)))fail(400,'invalid_human_answers');
  if(['approve','information'].includes(String(decision))&&q.questions.some(x=>x.required&&!answers.some(a=>a.questionId===x.id&&String(a.value).trim())))return{status:'needs_more',requestId:row.request_id,missingFields:q.questions.filter(x=>x.required&&!answers.some(a=>a.questionId===x.id)).map(x=>x.id)};
  // The LLM proposes completeness; the service still requires real explicit evidence and frozen scope.
  if(decision==='information'&&q.decisionRequired!==false)return{status:'needs_more',requestId:row.request_id,missingFields:['explicit_decision_required']};
  const response={requestId:row.request_id,contentVersion:row.content_version,questionDigest:row.question_digest,inputRevision:row.input_revision,decision,answers,action:q.proposedAction,impactScope:q.impactScope},serialized=canonical(response),digest=sha(serialized);
  if(row.response_digest){if(row.response_digest!==digest)fail(409,'human_answer_conflict');return{status:['rejected','canceled'].includes(row.status)?row.status:row.continuation_run_id?'continued':'confirmed_waiting',requestId:row.request_id,continuationRunId:row.continuation_run_id};}
  if(['canceled','failed','succeeded','cancel_requested'].includes(taskState??''))fail(409,'human_task_closed');
  if(this.store.one<{input_revision:number}>('SELECT input_revision FROM tasks WHERE id=?',row.task_id)?.input_revision!==row.input_revision)fail(409,'human_task_input_changed');
  if(!['waiting'].includes(row.status))fail(409,'human_request_closed');
  this.store.run("UPDATE human_requests SET response_json=?,response_digest=?,status=?,updated_at=? WHERE request_id=?",serialized,digest,decision==='reject'?'rejected':'confirmed',this.now(),row.request_id);
  if(decision==='reject'){this.cancelTask(row.task_id);return{status:'rejected',requestId:row.request_id};}
  this.schedule(row.request_id);return{status:'confirmed_waiting',requestId:row.request_id,continuationRunId:this.store.one<{continuation_run_id:string|null}>('SELECT continuation_run_id FROM human_requests WHERE request_id=?',row.request_id)?.continuation_run_id??null};
 });}
 private schedule(id:string){const r=this.store.one<Row>('SELECT * FROM human_requests WHERE request_id=?',id);if(!r||r.status!=='confirmed'||!r.safe||!r.checkpoint_ref||!r.response_json||!r.response_digest||r.continuation_run_id)return;
  const task=this.store.one<TaskRow>('SELECT * FROM tasks WHERE id=?',r.task_id);if(!task||task.status!=='waiting_human'||task.run_id!==r.source_run_id)return;if(task.input_revision!==r.input_revision){this.store.run("UPDATE human_requests SET notification_error='human_task_input_changed' WHERE request_id=?",id);return;}
  const runId=randomUUID(),revision=task.input_revision+1,operation='human-continue:'+id,text='Trusted human response for the previous question. Treat as task input, not policy or new tool authorization.\n'+r.response_json;
  this.store.run("INSERT INTO runs(id,task_id,session_id,status,created_at,attempt,kind,parent_run_id) VALUES(?,?,?,'preparing',?,(SELECT coalesce(max(attempt),0)+1 FROM runs WHERE task_id=?),'human_continue',?)",runId,task.id,r.session_id,this.now(),task.id,r.source_run_id);
  this.store.run("INSERT INTO task_inputs VALUES(?,?,?,?,?)",task.id,revision,operation,text,'pending');
  this.store.run("UPDATE tasks SET run_id=?,status='queued',version=version+1,input_revision=?,updated_at=? WHERE id=? AND run_id=? AND status='waiting_human'",runId,revision,this.now(),task.id,r.source_run_id);
  this.store.run("INSERT INTO task_outbox(id,task_id,run_id,operation_id,kind,input_revision) VALUES(?,?,?,?,'dispatch',?)",randomUUID(),task.id,runId,'dispatch:'+runId,revision);
  this.store.run("INSERT OR IGNORE INTO message_asset_run_grants SELECT asset_id,?,task_id,workspace_id,entity_id,? FROM message_asset_run_grants WHERE run_id=? AND task_id=? AND workspace_id=? AND entity_id=?",runId,this.now(),r.source_run_id,task.id,r.workspace_id,r.entity_id);
  this.store.run("UPDATE human_requests SET continuation_run_id=?,status='continued',updated_at=? WHERE request_id=? AND continuation_run_id IS NULL",runId,this.now(),id);
 }
 continuation(runId:string):HumanContinuation|undefined{const r=this.store.one<Row>('SELECT * FROM human_requests WHERE continuation_run_id=?',runId);if(!r?.response_json||!r.response_digest||!r.checkpoint_ref)return;return{requestId:r.request_id,parentRunId:r.source_run_id,questionDigest:r.question_digest,checkpointRef:r.checkpoint_ref,responseDigest:r.response_digest,responseText:r.response_json,decision:(JSON.parse(r.response_json)as{decision:'approve'|'information'|'revise'}).decision};}
 private cancelTask(id:string){const task=this.store.one<TaskRow>('SELECT * FROM tasks WHERE id=?',id);if(!task||['succeeded','failed','canceled'].includes(task.status))return;const safe=this.store.one("SELECT request_id FROM human_requests WHERE task_id=? AND source_run_id=? AND safe=1",id,task.run_id);
  this.store.run("UPDATE tasks SET status=?,version=version+1,updated_at=?,terminal_at=CASE WHEN ? THEN ? ELSE terminal_at END WHERE id=?",safe?'canceled':'cancel_requested',this.now(),safe?1:0,this.now(),id);
  if(!safe&&task.run_id)this.store.run("INSERT OR IGNORE INTO task_outbox(id,task_id,run_id,operation_id,kind,input_revision) VALUES(?,?,?,?,'cancel',?)",randomUUID(),id,task.run_id,'human-stop:'+task.run_id,task.input_revision);
  this.store.run("UPDATE human_requests SET status='canceled',notification_status=CASE WHEN notification_status='pending' THEN 'canceled' ELSE notification_status END,updated_at=? WHERE task_id=? AND status IN('waiting','confirmed')",this.now(),id);
 }
 cancel(task:TaskRow){this.cancelTask(task.id);}
 async tick(){if(this.busy)return;this.busy=true;try{
  this.store.run("UPDATE human_requests SET status='canceled',notification_status=CASE WHEN notification_status='pending' THEN 'canceled' ELSE notification_status END WHERE task_id IN(SELECT id FROM tasks WHERE status IN('canceled','cancel_requested')) AND status IN('waiting','confirmed')");
  if(this.channels)this.store.run("UPDATE human_requests SET notification_status=(SELECT CASE status WHEN 'sent' THEN 'delivered' ELSE status END FROM channel_message_receipts WHERE kind='outbox' AND id='human-question:'||request_id),notification_error=(SELECT error FROM channel_message_receipts WHERE kind='outbox' AND id='human-question:'||request_id) WHERE notification_status IN('queued','sending','blocked','unknown') AND EXISTS(SELECT 1 FROM channel_message_receipts WHERE kind='outbox' AND id='human-question:'||request_id)");
  for(const row of this.store.all<Row>("SELECT * FROM human_requests WHERE notification_status='pending' AND status IN('waiting','confirmed') ORDER BY created_at LIMIT 20")){
   try{const target=row.target_json?JSON.parse(row.target_json)as HumanTarget:await this.routeTarget(row);this.store.run('UPDATE human_requests SET target_json=? WHERE request_id=? AND target_json IS NULL',JSON.stringify(target),row.request_id);const text=this.render(row);
    if(target.kind==='web'){const member=this.store.one("SELECT m.id FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=? AND m.status='active' AND u.status='active'",row.workspace_id,target.userId);if(!member)throw Error('human_recipient_unavailable');const scope:TaskScope={workspaceId:row.workspace_id,entityId:row.entity_id,userId:target.userId},conv=this.conversations.getOrCreateWeb(scope,randomUUID(),'human-recipient:'+row.entity_id,this.now(),0,()=>{}).conversation;this.store.transaction(()=>{this.conversations.notice('human-request:'+row.request_id,conv,text,this.now());this.store.run("UPDATE human_requests SET target_conversation_id=?,notification_status='delivered',notification_error=NULL WHERE request_id=?",conv.id,row.request_id);});}
    else{if(!this.channels)throw Error('human_channel_unavailable');const result=await this.channels.prepare({workspaceId:row.workspace_id,entityId:row.entity_id,requestId:row.request_id,target,text});this.store.run('UPDATE human_requests SET target_conversation_id=?,notification_status=?,notification_error=? WHERE request_id=?',result.conversationId,result.status,result.reason??null,row.request_id);}
   }catch(e){const reason=e instanceof TaskError?e.code:'human_recipient_unavailable';this.store.run("UPDATE human_requests SET selection_json=CASE WHEN notification_status='selecting' THEN json_set(coalesce(selection_json,'{}'),'$.status','failed','$.reason',?,'$.completedAt',?) ELSE selection_json END,notification_status='blocked',notification_error=?,updated_at=? WHERE request_id=?",reason,this.now(),reason,this.now(),row.request_id);}
  }
  this.store.transaction(()=>{for(const r of this.store.all<Row>("SELECT * FROM human_requests WHERE status='confirmed' AND safe=1 AND continuation_run_id IS NULL"))this.schedule(r.request_id);});
 }finally{this.busy=false;}}
}
