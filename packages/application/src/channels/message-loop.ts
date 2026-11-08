import{workItemNotificationScope}from'./work-item-notification.js';
import {humanNotificationScope} from './human-notification.js';
import {triggerResultScope} from './trigger-result.js';
import {channelIngressFingerprint} from './ingress-fingerprint.js';
import {renderMessageContent} from './message-content.js';
import {createHash,randomUUID} from 'node:crypto';
import {channelQuickReplies,quickReplyScope,type ChannelReplyRoute,type ChannelQuickReplyKind} from './quick-reply.js';
import {ChannelInteractionController,matchesGroupKeyword} from './controller.js';
import {channelLabel as label,channelTag as tag,groupMentionText} from './message-text.js';
import {ChannelError,assertChannelResource,requireChannelCapability,type ChannelActor,type ChannelConnection,type ChannelMessageEvent,type ChannelResourceRef,type ChannelSendReceipt,type ConversationPort,type MeetingArtifactsPort} from './ports.js';
import {conversationOwnerKey,scopeFromJson,type TaskScope,type TaskService} from '../tasks/index.js';
import type {InteractionService} from '../interaction/service.js';
import {nullDiagnostics,diagnosticFailure,type DiagnosticPort,type DiagnosticContext} from '../diagnostics.js';
export interface MessageLoopBinding {
 connectionId:string;workspaceId:string;entityId:string;provider:'feishu'|'dingtalk'|'wecom';appId:string;bindingVersion:string;enabled:boolean;
 connection:ChannelConnection;conversation:ConversationPort;meetingArtifacts?:MeetingArtifactsPort;
 assets?:{ingest(binding:MessageLoopBinding,event:ChannelMessageEvent):ChannelMessageEvent;prefetch(binding:MessageLoopBinding,event:ChannelMessageEvent):Promise<void>};
 policy:{entityMentionId:string;ownSenderIds:readonly string[];groupTriggerKeywords?:readonly string[]};context?:{historyEnabled:boolean;groupListenEnabled?:boolean;listenGeneration?:number;meetingRefs:ChannelResourceRef[]};
}
export interface GroupContextPort {
 assetIds?(batchId:string):readonly string[];
 allowed(b:MessageLoopBinding,e:ChannelMessageEvent):boolean;
 busy(b:MessageLoopBinding,e:ChannelMessageEvent,batchId:string):boolean;
 recovery(b:MessageLoopBinding,e:ChannelMessageEvent,batchId:string):{batchId:string;scopeJson:string;conversationId:string;turnId:string}|undefined;
 finish(batchId:string):void;
 membership(connectionId:string,chatId:string,present:boolean,at:number,verifiedCurrent?:boolean):void;
 canSend(connectionId:string,chatId:string):boolean;
 collect(b:MessageLoopBinding,e:ChannelMessageEvent,formatted:string):'created'|'duplicate'|'ignored';
 reserve(b:MessageLoopBinding,e:ChannelMessageEvent,batchId:string,current:string):string|undefined;
 receipt(batchId:string,status:'committed'|'accepted'|'unknown'):void;
}
export interface MessageLoopConnections {
 queueAttachments?(base:ChannelDeliveryRow,conversationId:string,turnId:string,at:number):void;
 readAttachment?(row:ChannelDeliveryRow):Promise<NonNullable<import('./ports.js').SendChannelMessage['attachment']>>;
 retainCommittedAssets?(conversationId:string,assetIds:readonly string[]):void;
 resolveBinding(id:string):Promise<MessageLoopBinding|undefined>;
 isVerificationEvent?(id:string,eventId:string,messageId?:string):boolean;
 currentBindingVersion(id:string):string|undefined;
 allowHumanReply?(scope:TaskScope,text:string):boolean;
 authorizeInvocation(binding:MessageLoopBinding,actor:ChannelActor,kind:'private'|'group'|'meeting',source?:TaskScope['source']):Promise<void>;
 /** Presentation only, bound to the authenticated actor. Cannot grant permissions. */
 describeActor?(binding:MessageLoopBinding,actor:ChannelActor):Promise<ChannelSpeakerProfile>;
}
export interface ChannelSpeakerProfile {displayName?:string;departmentNames?:readonly string[];jobTitle?:string}
export interface ChannelInboxRow {id:string;lane:string;connectionId:string;bindingVersion:string;scopeJson:string;eventJson:string;status:string;conversationId:string|null;turnId:string|null;leaseToken:string|null;createdAt:number;employeeUseAdmitted?:boolean;sourceKey?:string;payloadHash?:string;inputText?:string;historyBatchId?:string}
export interface ChannelDeliveryRow {id:string;scopeJson:string;targetJson:string;text:string;status:string;taskDeliveryId:string|null;leaseToken:string|null;correlation?:DiagnosticContext}
export interface MessageLoopRepository {
 /** Returns original task scope only after checking persisted task/delivery provenance. */
 originatingTaskScope?(row:ChannelDeliveryRow):TaskScope|undefined;
 onWork?(wake:()=>void):void;
 seenInbox?(id:string):boolean;
 checkDuplicate?(id:string,identity:{sourceKey:string;payloadHash:string}):boolean;
 beginSubmission?(id:string,token:string):{inputId:string;deadlineAt:number}|undefined;
 prepareInput?(id:string,token:string,text:string,historyBatchId?:string):void;
 prepareInputAtomically?(id:string,token:string,build:()=>{text:string;historyBatchId?:string}):{text:string;historyBatchId?:string}|undefined;
 markAccepted?(id:string,token:string):void;
 pendingReceipts?(limit?:number,includeUnknown?:boolean):ChannelInboxRow[];
 applyInputReceipt?(id:string,state:'accepted'|'committed'):void;
 markTerminal?(id:string,status:string):void;
 eventCursor?(id:string):string|undefined;
 advanceEventCursor?(id:string,cursor:string):void;
 deferDelivery?(id:string,token:string,options:{safeToRetry:boolean;retryAfterMs?:number}):void;
 reconcileDelivery?(id:string,status:'sent'|'failed',messageId?:string):void;
 close?():void;
 /** Durable conversation-local numbering, including collection before the first RT turn. */
 speakerAlias(conversation:string|TaskScope,actorKey:string):string;
 accept(row:ChannelInboxRow):'created'|'duplicate';
 claimInbox(now:number,leaseUntil:number,token:string):ChannelInboxRow|undefined;
 ownsInbox(id:string,token:string):boolean;
 ownsDelivery(id:string,token:string):boolean;
 renewInbox(id:string,token:string,until:number):void;
 renewDelivery?(id:string,token:string,until:number):void;
 bindTurn(id:string,token:string,conversationId:string,turnId:string):void;
 finishInbox(id:string,token:string,status:string,error?:string,delayMs?:number):void;
 enqueueDelivery(row:ChannelDeliveryRow,at:number):'created'|'duplicate'|void;
 replyCorrelation?(turnId:string):DiagnosticContext|undefined;
 claimDelivery(now:number,leaseUntil:number,token:string):ChannelDeliveryRow|undefined;
 finishDelivery(id:string,token:string,status:string,error?:string,messageId?:string,providerRequestId?:string):void;
 taskDeliveries():{id:string;taskId:string;text:string;sourceJson:string;workspaceId:string;entityId:string;userId:string|null;conversationId?:string}[];
 refreshDeliveryAuthorization?(row:ChannelDeliveryRow):Promise<void>;
 assertDeliveryAuthorization?(row:ChannelDeliveryRow):void;
 cleanup(at:number):void;
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const repliesInPlace=(conversation:ChannelResourceRef,threadId?:string)=>conversation.provider==='wecom'||conversation.conversationKind==='group'||!!threadId;
const safeError=(error:unknown)=>error instanceof ChannelError?error.code:error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[a-zA-Z0-9_]{1,100}$/.test(error.code)?error.code:'channel_processing_failed';
export function channelInvocationScope(binding:MessageLoopBinding,event:ChannelMessageEvent):TaskScope {
 const m=event.message,a=m.author,kind=m.conversationKind;
 if((kind!=='private'&&kind!=='group')||a.identityEvidence!=='channel_verified'||a.kind!=='human'||!a.externalId||!a.idNamespace||a.idNamespace==='unknown'||a.applicationId!==binding.appId||event.connectionId!==binding.connectionId||event.tenantId!==binding.connection.tenantId||event.origin!=='live')throw new ChannelError('forbidden','channel_event_scope_mismatch');
 assertChannelResource(binding.connection,m.conversation);
 return{workspaceId:binding.workspaceId,entityId:binding.entityId,principal:{kind:'channel',channelType:binding.provider,tenantId:event.tenantId,identityNamespace:a.idNamespace,externalUserId:a.externalId},source:{channelType:binding.provider,tenantId:event.tenantId,installationId:binding.connectionId,applicationId:binding.appId,connectionId:binding.connectionId,bindingVersion:binding.bindingVersion,conversationId:m.conversation.externalId,conversationKind:kind,sourceEventId:event.eventId,replyToMessageId:m.id,...(m.threadId?{threadId:m.threadId}:{})}};
}
export function channelMessageText(event:ChannelMessageEvent,profile:ChannelSpeakerProfile={},alias?:string):string {
 if(event.message.content)event={...event,message:{...event.message,text:renderMessageContent(event.message.content)}};
 const a=event.message.author,name=label(profile.displayName??'')||label(a.displayName??'');
 const member=label(alias??''),speaker=name&&name!==a.externalId?name:member||'当前用户';
 const departments=label([...new Set((profile.departmentNames??[]).map(label).filter(Boolean))].join('、')),title=label(profile.jobTitle??'');
 if(event.message.conversationKind==='group'&&event.message.conversation.provider==='feishu'){
  const group=groupMentionText(event.message);
  return tag('说话人',speaker)+tag('部门',departments)+tag('被@人',group.names.join(','))+group.text;
 }
 return tag('说话人',speaker)+tag('成员',speaker!==member?member:'')+tag('部门',departments)+tag('职位',title)+event.message.text;
}
export class ChannelMessageLoop {
 private busy=false;private stopping=false;private scheduled=false;private pendingWake=false;private reconcileRequested=true;private nextReconcile=0;private lateReconcile=false;private unsubscribe:(()=>void)|undefined;
 private readonly incoming=new Set<Promise<void>>();private readonly outgoing=new Set<Promise<void>>();private readonly controller=new ChannelInteractionController();
 constructor(private readonly repository:MessageLoopRepository,private readonly connections:MessageLoopConnections,private readonly interaction:InteractionService,_tasks:TaskService,private readonly now:()=>number,private readonly diagnostics:DiagnosticPort=nullDiagnostics,private readonly groups?:GroupContextPort){
  this.repository.onWork?.(()=>this.requestTick());this.unsubscribe=this.interaction.onWork?.(()=>{this.reconcileRequested=true;this.lateReconcile=true;this.requestTick();});
 }
 private requestTick(){if(this.stopping)return;if(this.busy){this.pendingWake=true;return;}if(this.scheduled)return;this.scheduled=true;setImmediate(()=>{this.scheduled=false;void this.tick().catch(()=>{});});}
 /** Internal trusted ingress only. Callers must bind this to an authenticated transport. */
 async acceptAuthenticatedEvent(connectionId:string,event:ChannelMessageEvent,commit:(write:()=> 'created'|'duplicate')=>'created'|'duplicate'=write=>write()){
  const binding=await this.connections.resolveBinding(connectionId);
  if(!binding?.enabled)throw new ChannelError('forbidden','channel_ingress_unavailable');
  if(this.connections.isVerificationEvent?.(connectionId,event.eventId,event.message.id))return{kind:'ignored' as const};
  if(event.tenantId!==binding.connection.tenantId)throw new ChannelError('forbidden');
  const preliminaryId=hash([binding.workspaceId,binding.entityId,connectionId,binding.bindingVersion,event.tenantId,event.message.conversation.externalId,event.message.id,event.revision??'initial']);
  const sourceIdentity=channelIngressFingerprint(binding,event);
  if((this.repository.checkDuplicate?this.repository.checkDuplicate(preliminaryId,sourceIdentity):this.repository.seenInbox?.(preliminaryId))){this.diagnostics.run({traceId:preliminaryId,messageId:preliminaryId,providerEventRef:hash(['provider-event',event.eventId])},()=>this.diagnostics.event({stage:'ingress',phase:'point',outcome:'duplicate'}));return{kind:'accepted' as const,status:'duplicate' as const};}
  let materialized=false;const adoptAssets=(prefetch:boolean)=>{if(!binding.assets)return;if(!materialized){event=binding.assets.ingest(binding,event);materialized=true;}if(prefetch)void binding.assets.prefetch(binding,event).catch(()=>{});};
  const route:ChannelReplyRoute={workspaceId:binding.workspaceId,entityId:binding.entityId,connectionId,bindingVersion:binding.bindingVersion,appId:binding.appId,...sourceIdentity,conversation:event.message.conversation,messageId:event.message.id,eventId:event.eventId,...(event.message.threadId?{threadId:event.message.threadId}:{})};
  try{
   if(binding.provider==='feishu'&&event.message.conversationKind==='group'){
    if(event.origin!=='live')return{kind:'ignored' as const};
    if(event.message.author.kind!=='human'||binding.policy.ownSenderIds.includes(event.message.author.externalId??''))return{kind:'ignored' as const};
    channelInvocationScope(binding,event);
    if(this.groups&&!this.groups.allowed(binding,event))return{kind:'ignored' as const};
    if(binding.context?.groupListenEnabled&&this.groups){
     adoptAssets(!event.message.mentions.includes(binding.policy.entityMentionId));
     const profile=await this.speakerProfile(binding,event.message.author);
     const latest=await this.connections.resolveBinding(connectionId);if(!latest?.context?.groupListenEnabled||latest.context.listenGeneration!==binding.context.listenGeneration)return{kind:'ignored' as const};
     const collected=commit(()=>{const value=this.groups!.collect(binding,event,channelMessageText(event,profile,this.alias(binding,event)));return value==='duplicate'?'duplicate':'created';});
     if(!event.message.mentions.includes(binding.policy.entityMentionId)&&!matchesGroupKeyword(event,binding.policy.groupTriggerKeywords))return{kind:'accepted' as const,status:collected};
    }
   }
   const caps=await binding.conversation.inspectCapabilities(event.message.conversation);
   const decision=this.controller.decide(event,{...binding.policy,mode:'mentions_only'},caps);
   if(decision.action!=='invoke')return {kind:'ignored' as const};
   if(decision.reason==='keyword'&&(!caps.ordinaryMessageEvents.supported||caps.ordinaryMessageEvents.availability!=='available'))return{kind:'ignored' as const};
   requireChannelCapability(event.message.conversationKind==='private'?caps.privateMessageEvents??{supported:false,availability:'unsupported'}:decision.reason==='provider_directed_bot'?caps.directedBotMessageEvents??{supported:false,availability:'unsupported'}:decision.reason==='keyword'?caps.ordinaryMessageEvents:caps.mentionEvents);
   if(event.message.author.kind==='bot'){
    // Robots are never recast as directory people or admitted to model/tools.
    const status=await this.rejectAuthenticatedEvent(route,'permission',commit);return{kind:'accepted' as const,status};
   }
   let scope:TaskScope;
   try{scope=channelInvocationScope(binding,event);}catch(error){await this.rejectAuthenticatedEvent(route,'identity',commit);throw error;}
   if(binding.provider==='feishu'&&event.message.conversationKind==='group'&&this.groups&&!this.groups.allowed(binding,event))return{kind:'ignored' as const};
   const id=preliminaryId;
   let employeeUseAdmitted=true;
   try{await this.connections.authorizeInvocation(binding,event.message.author,event.message.conversationKind!,scope.source);}catch{if(this.connections.allowHumanReply?.(scope,event.message.text))employeeUseAdmitted=false;else{if(decision.reason==='keyword')return{kind:'ignored' as const};const status=await this.rejectAuthenticatedEvent(route,'permission',commit);return{kind:'accepted' as const,status};}}
   adoptAssets(true);

   return this.diagnostics.run({traceId:id,messageId:id,providerEventRef:hash(['provider-event',event.eventId])},()=>{const status=commit(()=>this.repository.accept({id,lane:hash([binding.workspaceId,binding.entityId,conversationOwnerKey(scope)]),connectionId,bindingVersion:binding.bindingVersion,scopeJson:JSON.stringify(scope),eventJson:JSON.stringify(event),status:'queued',conversationId:null,turnId:null,leaseToken:null,createdAt:this.now(),employeeUseAdmitted,...sourceIdentity}));this.diagnostics.event({stage:'ingress',phase:'point',outcome:status==='duplicate'?'duplicate':'success',sourceAt:event.message.occurredAt,receivedAt:event.receivedAt});this.diagnostics.event({stage:'inbox.queued',phase:'point',outcome:status==='duplicate'?'duplicate':'queued'});return{kind:'accepted' as const,status};});
  }catch(error){
   // Parsing/identity failures use their earlier fixed response; other admission failures use service text.
   if(!(error instanceof ChannelError&&error.message==='channel_event_scope_mismatch'))await this.rejectAuthenticatedEvent(route,'service',commit);
   throw error;
  }
 }
 membership(connectionId:string,chatId:string,present:boolean,at:number,verifiedCurrent=false){this.groups?.membership(connectionId,chatId,present,at,verifiedCurrent);}
 /** Fixed text only. Its minimal route grants neither conversation access nor tool authority. */
 async rejectAuthenticatedEvent(route:ChannelReplyRoute,kind:ChannelQuickReplyKind,commit:(write:()=> 'created'|'duplicate')=>'created'|'duplicate'=write=>write()):Promise<'created'|'duplicate'>{
  const parent=hash([route.workspaceId,route.entityId,route.connectionId,route.bindingVersion,route.conversation.tenantId,route.conversation.externalId,route.messageId,'initial']);
  const id=hash(['quick-reply',parent]),text=channelQuickReplies[kind],reason=kind==='identity'?'identity_invalid':kind==='permission'?'usage_denied':'platform_failure';
  const correlation={traceId:parent,messageId:id,causationId:parent};
  return this.diagnostics.run(correlation,async()=>{
   try{
    const b=await this.connections.resolveBinding(route.connectionId);
    if(!b||!b.enabled||b.bindingVersion!==route.bindingVersion||b.workspaceId!==route.workspaceId||b.entityId!==route.entityId||b.appId!==route.appId||this.connections.currentBindingVersion(route.connectionId)!==route.bindingVersion)throw new ChannelError('forbidden','channel_binding_changed');
    assertChannelResource(b.connection,route.conversation);
    if(b.provider==='feishu'&&route.conversation.conversationKind==='group'&&this.groups&&!this.groups.canSend(b.connectionId,route.conversation.externalId))throw new ChannelError('forbidden','bot_left_group');
    if(!route.messageId||!route.eventId)throw new ChannelError('invalid_request');
    const scope={kind:'channel_quick_reply',route,replyKind:kind,source:{connectionId:route.connectionId}};
    const target={conversation:route.conversation,...(repliesInPlace(route.conversation,route.threadId)?{replyToMessageId:route.messageId}:{}),...(route.threadId?{threadId:route.threadId}:{})};
    const result=commit(()=>this.repository.enqueueDelivery({id,scopeJson:JSON.stringify(scope),targetJson:JSON.stringify(target),text,status:'queued',taskDeliveryId:null,leaseToken:null,correlation},this.now())??'created');
    if(result==='created')this.diagnostics.event({stage:'reply.generated',phase:'point',outcome:'success',status:'generated',reason,text});
    return result;
   }catch(error){this.diagnostics.event({stage:'outbox.send',phase:'point',outcome:'failure',status:'failed',reason:'reply_target_unavailable',text,...diagnosticFailure(error)});return'duplicate';}
  });
 }

 private async binding(scope:TaskScope){
  if(!scope.source)throw new ChannelError('forbidden');
  const b=await this.connections.resolveBinding(scope.source.connectionId);
  if(!b)throw new ChannelError('temporarily_unavailable','channel_binding_unavailable');
  if(b.bindingVersion!==scope.source.bindingVersion||b.entityId!==scope.entityId||b.workspaceId!==scope.workspaceId||b.appId!==scope.source.applicationId||b.connection.tenantId!==scope.source.tenantId)throw new ChannelError('forbidden','channel_binding_changed');
  if(this.connections.currentBindingVersion(b.connectionId)!==b.bindingVersion)throw new ChannelError('forbidden','channel_binding_changed');
  return b;
 }
 private alias(b:MessageLoopBinding,event:ChannelMessageEvent){
  const actor=event.message.author;
  return this.repository.speakerAlias(channelInvocationScope(b,event),hash([b.provider,b.connection.tenantId,b.appId,actor.idNamespace??'unknown',actor.externalId??'unknown',actor.kind]));
 }
 private async speakerProfile(b:MessageLoopBinding,actor:ChannelActor):Promise<ChannelSpeakerProfile>{
  try{return await this.connections.describeActor?.(b,actor)??{};}catch{return {}; /* Presentation lookup cannot grant or revoke usage. */}
 }
 private async messageText(b:MessageLoopBinding,event:ChannelMessageEvent){
  const profile=await this.speakerProfile(b,event.message.author);
  return channelMessageText(event,profile,event.message.conversationKind==='group'?this.alias(b,event):undefined);
 }
 private async consume(row:ChannelInboxRow,token:string){
  return this.diagnostics.run({traceId:row.id,messageId:row.id,attemptId:token,...(row.conversationId?{conversationId:row.conversationId}:{}),...(row.turnId?{turnId:row.turnId}:{})},async()=>{const start=this.now();this.diagnostics.event({stage:'inbox.consume',phase:'start',...(!row.turnId?{queueMs:Math.max(0,start-row.createdAt)}:{})});try{return await this.consumeAuthorized(row,token);}finally{this.diagnostics.event({stage:'inbox.consume',phase:'end',durationMs:this.now()-start});}});
 }
 private async consumeAuthorized(row:ChannelInboxRow,token:string){
  let handoffStarted=false;
  try{
   const scope=scopeFromJson(row.scopeJson),b=await this.binding(scope),event=JSON.parse(row.eventJson) as ChannelMessageEvent;
   if(!this.repository.ownsInbox(row.id,token))return;
   const conversationId=row.conversationId??this.interaction.create(scope,{operationId:`channel:${row.lane}`},true).conversation.id;
   const turnId=row.turnId??hash([conversationId,`channel:${row.id}`]);this.repository.bindTurn(row.id,token,conversationId,turnId);
   const formatted=row.inputText??await this.messageText(b,event);
   const build=()=>{let text=formatted,batch=row.historyBatchId;if(row.inputText===undefined&&b.provider==='feishu'&&event.message.conversationKind==='group'&&b.context?.groupListenEnabled&&this.groups){batch=row.id;const reserved=this.groups.reserve(b,event,batch,text);if(reserved===undefined)throw new ChannelError('not_ready','group_batch_reconciliation_required');text=reserved;}return{text,...(batch?{historyBatchId:batch}:{})};};
   const prepared=this.repository.prepareInputAtomically?this.repository.prepareInputAtomically(row.id,token,build):build();if(!prepared)return;const text=prepared.text,batch=prepared.historyBatchId;
   this.repository.prepareInput?.(row.id,token,text,batch);const confirmation=this.repository.beginSubmission?.(row.id,token);
   let timedOut=false;let timeout:ReturnType<typeof setTimeout>|undefined;
   handoffStarted=true;const submission=this.interaction.createTurn(scope,conversationId,{operationId:`channel:${row.id}`,text},undefined,batch,{inputId:row.id,authorized:true,...(row.employeeUseAdmitted!==undefined?{employeeUseAdmitted:row.employeeUseAdmitted}:{})});
   void submission.then(()=>{if(timedOut){this.repository.applyInputReceipt?.(row.id,'accepted');this.reconcileRequested=true;this.lateReconcile=true;this.requestTick();}},()=>{});
   const result=await Promise.race([submission,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{timedOut=true;reject(new ChannelError('temporarily_unavailable','input_handoff_unknown'));},Math.min(30000,Math.max(1,(confirmation?.deadlineAt??this.now()+30000)-this.now())));})]).finally(()=>{if(timeout)clearTimeout(timeout);});
   if(result.turn.status==='unknown'){this.repository.finishInbox(row.id,token,'unknown','input_handoff_unknown');return;}
   if(this.repository.markAccepted)this.repository.markAccepted(row.id,token);else this.repository.finishInbox(row.id,token,'waiting');
   this.reconcileRequested=true;this.requestTick();
   // Compatibility for adapters without durable event capability: only final
   // explicit observations may publish output; no repeated synthetic waiting reply.
   if(!this.interaction.events)await this.legacyResult({...row,conversationId,turnId},result);
  }catch(error){
   this.diagnostics.event({stage:'inbox.consume',phase:'point',outcome:'failure',...diagnosticFailure(error)});
   const code=safeError(error);if(!handoffStarted&&code==='temporarily_unavailable'){if(this.repository.ownsInbox(row.id,token))this.repository.finishInbox(row.id,token,'blocked',code);return;}const uncertain=['temporarily_unavailable','not_ready','interaction_unknown'].includes(code);
   if(!uncertain)await this.quickForInbox(row,token,'service');
   if(this.repository.ownsInbox(row.id,token))this.repository.finishInbox(row.id,token,uncertain?'unknown':'failed',code);
  }
 }
 private async legacyResult(row:ChannelInboxRow,result:Awaited<ReturnType<InteractionService['getTurn']>>){
  if(result.turn.status==='succeeded'){this.queueOutput(row,`turn:${result.turn.replyId??row.turnId}`,result.turn.text??'');this.repository.applyInputReceipt?.(row.id,'committed');this.repository.markTerminal?.(row.id,'succeeded');}
  else if(['failed','canceled'].includes(result.turn.status))this.repository.markTerminal?.(row.id,result.turn.status);
 }
 private queueOutput(row:ChannelInboxRow,outputId:string,text:string){
  const event=JSON.parse(row.eventJson) as ChannelMessageEvent,target={conversation:event.message.conversation,...(repliesInPlace(event.message.conversation,event.message.threadId)?{replyToMessageId:event.message.id}:{}),...(event.message.threadId?{threadId:event.message.threadId}:{})};
  const correlation={traceId:row.id,messageId:outputId,causationId:row.id,...(row.conversationId?{conversationId:row.conversationId}:{}),...(row.turnId?{turnId:row.turnId}:{})};
  this.repository.enqueueDelivery({id:outputId,scopeJson:row.scopeJson,targetJson:JSON.stringify(target),text,status:'pending',taskDeliveryId:null,leaseToken:null,correlation},this.now());
  if(row.conversationId&&row.turnId)this.connections.queueAttachments?.({id:outputId,scopeJson:row.scopeJson,targetJson:JSON.stringify(target),text,status:'queued',taskDeliveryId:null,leaseToken:null,correlation},row.conversationId,row.turnId,this.now());
  this.diagnostics.run(correlation,()=>this.diagnostics.event({stage:'outbox.queued',phase:'point',outcome:'queued'}));
 }
 private async reconcileInputs(includeUnknown=false){
  for(const row of this.repository.pendingReceipts?.(100,includeUnknown)??[]){
   if(!row.conversationId||!row.turnId)continue;try{
    const scope=scopeFromJson(row.scopeJson);
    if(!this.interaction.events){await this.legacyResult(row,await this.interaction.getTurn(scope,row.conversationId,row.turnId));continue;}
    const result=await this.diagnostics.run({traceId:row.id,messageId:row.id,conversationId:row.conversationId,turnId:row.turnId},()=>this.interaction.events(scope,row.conversationId!,row.turnId!,this.repository.eventCursor?.(row.id)));
    for(const event of result.events){
     if(event.type==='input_committed'&&event.inputId===row.id){this.repository.applyInputReceipt?.(row.id,'committed');this.groups?.receipt(row.id,'committed');this.groups?.finish(row.id);const original=JSON.parse(row.eventJson) as ChannelMessageEvent;this.connections.retainCommittedAssets?.(row.conversationId!,row.historyBatchId?(this.groups?.assetIds?.(row.historyBatchId)??[]):(original.message.sharedAssets??[]).map(a=>a.assetId));this.diagnostics.event({stage:'inbox.consume',phase:'point',state:'succeeded',outcome:'success',traceId:row.id,messageId:row.id});}
     if(event.type==='output'&&event.inputIds.at(-1)===row.id)this.queueOutput(row,event.outputId,event.text);
     if(event.type==='terminal'){if(event.status==='failed')await this.terminalFailure(row);this.repository.markTerminal?.(row.id,event.status);this.groups?.finish(row.id);}
    }
    this.repository.advanceEventCursor?.(row.id,result.cursor);
   }catch(error){this.diagnostics.event({stage:'interaction.poll',phase:'point',outcome:'failure',...diagnosticFailure(error)});}
  }
 }
 private async terminalFailure(row:ChannelInboxRow){
  try{const s=scopeFromJson(row.scopeJson),source=s.source!,event=JSON.parse(row.eventJson) as ChannelMessageEvent;await this.rejectAuthenticatedEvent({workspaceId:s.workspaceId,entityId:s.entityId,connectionId:row.connectionId,bindingVersion:row.bindingVersion,appId:source.applicationId,conversation:event.message.conversation,messageId:event.message.id,eventId:event.eventId,lane:row.lane,...(event.message.threadId?{threadId:event.message.threadId}:{})},'service');}catch{/* A missing original target cannot be substituted. */}
 }
 private async quickForInbox(row:ChannelInboxRow,token:string,kind:ChannelQuickReplyKind){
  if(!this.repository.ownsInbox(row.id,token))return;
  try{const s=scopeFromJson(row.scopeJson),source=s.source!,event=JSON.parse(row.eventJson) as ChannelMessageEvent;
   await this.rejectAuthenticatedEvent({workspaceId:s.workspaceId,entityId:s.entityId,connectionId:row.connectionId,bindingVersion:row.bindingVersion,appId:source.applicationId,conversation:event.message.conversation,messageId:event.message.id,eventId:event.eventId,lane:row.lane,...(event.message.threadId?{threadId:event.message.threadId}:{})},kind,write=>{if(!this.repository.ownsInbox(row.id,token))throw new ChannelError('forbidden','delivery_lease_lost');return write();});
  }catch(error){this.diagnostics.event({stage:'outbox.send',phase:'point',outcome:'failure',status:'failed',reason:'reply_target_unavailable',...diagnosticFailure(error)});}
 }
 private async confirmedSend(row:ChannelDeliveryRow,token:string,send:()=>Promise<ChannelSendReceipt>):Promise<ChannelSendReceipt|undefined>{
  let expired=false;let timer:ReturnType<typeof setTimeout>|undefined;const pending=send();
  void pending.then(receipt=>{if(expired&&receipt.status==='sent')this.repository.reconcileDelivery?.(row.id,'sent',receipt.messageId);},()=>{});
  const result=await Promise.race([pending,new Promise<undefined>(resolve=>{timer=setTimeout(()=>{expired=true;this.repository.finishDelivery(row.id,token,'unknown','send_confirmation_timeout');this.diagnostics.event({stage:'outbox.send',phase:'point',status:'unknown',outcome:'unknown',reason:'delivery_unknown',messageId:row.id});resolve(undefined);},30000);})]).finally(()=>{if(timer)clearTimeout(timer);});return result;
 }
 private async sendQuickReply(row:ChannelDeliveryRow,token:string){
  const quick=quickReplyScope(row.scopeJson)!;const {route,replyKind}=quick;
  const guard=async()=>{const b=await this.connections.resolveBinding(route.connectionId);if(!b||!b.enabled||b.bindingVersion!==route.bindingVersion||b.workspaceId!==route.workspaceId||b.entityId!==route.entityId||b.appId!==route.appId||!this.repository.ownsDelivery(row.id,token)||this.connections.currentBindingVersion(route.connectionId)!==route.bindingVersion)throw new ChannelError('forbidden','channel_binding_changed');assertChannelResource(b.connection,route.conversation);return b;};
  const renew=setInterval(()=>this.repository.renewDelivery?.(row.id,token,this.now()+60_000),15_000);renew.unref();
  let attempted=false;
  try{
   if(row.taskDeliveryId!==null||row.text!==channelQuickReplies[replyKind])throw new ChannelError('forbidden','invalid_quick_reply');
   const b=await guard(),caps=await b.conversation.inspectCapabilities(route.conversation),reply=repliesInPlace(route.conversation,route.threadId);
   if(route.threadId&&!reply)throw new ChannelError('unsupported','thread_reply_target_unavailable');
   requireChannelCapability(reply?caps.replyToMessage:caps.proactiveSend);
   attempted=true;
   const receipt=await this.confirmedSend(row,token,()=>b.conversation.sendMessage({conversation:route.conversation,text:row.text,operationId:hash(row.id).slice(0,40),...(reply?{replyToMessageId:route.messageId}:{}),...(route.threadId?{threadId:route.threadId}:{}),beforeSend:async()=>{await guard();},assertSendAllowed:()=>{if(b.provider==='feishu'&&route.conversation.conversationKind==='group'&&this.groups&&!this.groups.canSend(b.connectionId,route.conversation.externalId))throw new ChannelError('forbidden','bot_left_group');if(!this.repository.ownsDelivery(row.id,token)||this.connections.currentBindingVersion(route.connectionId)!==route.bindingVersion)throw new ChannelError('forbidden','channel_binding_changed');}}));if(!receipt)return;
   this.repository.finishDelivery(row.id,token,receipt.status,undefined,receipt.messageId,receipt.providerRequestId);
   this.diagnostics.event({stage:'outbox.send',phase:'point',outcome:receipt.status==='sent'?'success':'unknown',status:receipt.status,...(receipt.status==='unknown'?{reason:'delivery_unknown'}:{}),text:row.text});
  }catch(error){const status=!attempted||error instanceof ChannelError&&['forbidden','unauthenticated','invalid_request','unsupported'].includes(error.code)?'failed':'unknown';
   this.diagnostics.event({stage:'outbox.send',phase:'point',outcome:status==='unknown'?'unknown':'failure',status,reason:status==='unknown'?'delivery_unknown':'send_failed',text:row.text,...diagnosticFailure(error)});
   if(!attempted&&error instanceof ChannelError&&error.code==='temporarily_unavailable')this.repository.finishDelivery(row.id,token,'blocked',safeError(error));else if(this.repository.deferDelivery&&(error instanceof ChannelError&&['rate_limited','temporarily_unavailable'].includes(error.code)||typeof error==='object'&&error!==null&&'details'in error&&[429,503].includes(Number((error as {details?:{httpStatus?:number}}).details?.httpStatus))))this.repository.deferDelivery(row.id,token,{safeToRetry:true,...(error instanceof ChannelError&&error.retryAfterMs!==undefined?{retryAfterMs:error.retryAfterMs}:{})});else this.repository.finishDelivery(row.id,token,status,safeError(error));
  }finally{clearInterval(renew);}
 }
 private async send(row:ChannelDeliveryRow,token:string){
  const correlation={...row.correlation,traceId:row.correlation?.traceId??hash(['outbox',row.id]),messageId:row.id,attemptId:token};
  return this.diagnostics.run(correlation,async()=>{const start=this.now();this.diagnostics.event({stage:'outbox.send',phase:'start'});try{return quickReplyScope(row.scopeJson)?await this.sendQuickReply(row,token):await this.sendAuthorized(row,token);}catch(error){this.diagnostics.event({stage:'outbox.send',phase:'point',outcome:'failure',status:'failed',reason:'platform_failure',text:row.text,...diagnosticFailure(error)});if(this.repository.ownsDelivery(row.id,token))this.repository.finishDelivery(row.id,token,'failed',safeError(error));}finally{this.diagnostics.event({stage:'outbox.send',phase:'end',durationMs:this.now()-start});}});
 }
 private async sendAuthorized(row:ChannelDeliveryRow,token:string){
  const renew=setInterval(()=>this.repository.renewDelivery?.(row.id,token,this.now()+60_000),15_000);renew.unref();
  let attempted=false;
  try{
   const automation=triggerResultScope(row.scopeJson)??humanNotificationScope(row.scopeJson)??workItemNotificationScope(row.scopeJson),scope=automation??scopeFromJson(row.scopeJson);
   const resolve=async()=>{if(!automation)return this.binding(scope as TaskScope);if(!this.repository.assertDeliveryAuthorization)throw new ChannelError('forbidden','notification_policy_missing');this.repository.assertDeliveryAuthorization(row);const live=await this.connections.resolveBinding(automation.source.connectionId);if(!live||!live.enabled||live.workspaceId!==automation.workspaceId||live.entityId!==automation.entityId||live.appId!==automation.source.appId||live.provider!==automation.source.channelType||live.connection.tenantId!==automation.source.tenantId||live.bindingVersion!==automation.source.bindingVersion)throw new ChannelError('forbidden','channel_binding_changed');return live;};
   const b=await resolve(),target=JSON.parse(row.targetJson) as {conversation:ChannelResourceRef;replyToMessageId?:string;threadId?:string};
   assertChannelResource(b.connection,target.conversation);
   if(b.provider==='feishu'&&target.conversation.conversationKind==='group'&&this.groups&&!this.groups.canSend(b.connectionId,target.conversation.externalId))throw new ChannelError('forbidden','bot_left_group');
   if(target.conversation.externalId!==scope.source!.conversationId||target.threadId!==scope.source!.threadId)throw new ChannelError('forbidden','reply_target_scope_mismatch');
   const caps=await b.conversation.inspectCapabilities(target.conversation);
   // Interactive WeCom replies stay on the original callback, never proactive fallback.
   const replyId=target.replyToMessageId;
   const reply=replyId&&(b.provider==='wecom'||caps.replyToMessage.supported&&caps.replyToMessage.availability==='available');
   const originalTask=!automation&&b.provider==='wecom'&&target.conversation.conversationKind==='private'&&!replyId?this.repository.originatingTaskScope?.(row):undefined;
   if(target.threadId&&!reply)throw new ChannelError('unsupported','thread_reply_target_unavailable');
   requireChannelCapability(reply?caps.replyToMessage:caps.proactiveSend);
   const attachment='artifact'in target?await this.connections.readAttachment?.(row):undefined;if('artifact'in target&&!attachment)throw new ChannelError('unsupported','artifact_reader_missing');
   attempted=true;
   const receipt=await this.confirmedSend(row,token,()=>b.conversation.sendMessage({conversation:target.conversation,text:row.text,...(attachment?{attachment}:{}),operationId:hash(row.id).slice(0,40),...(originalTask?{originatingTaskScope:()=>{if(!this.repository.ownsDelivery(row.id,token))throw new ChannelError('forbidden','delivery_lease_lost');this.repository.assertDeliveryAuthorization?.(row);const current=this.repository.originatingTaskScope?.(row);if(!current)throw new ChannelError('forbidden','task_delivery_origin_changed');return current;}}:{}),assertSendAllowed:()=>{try{if(b.provider==='feishu'&&target.conversation.conversationKind==='group'&&this.groups&&!this.groups.canSend(b.connectionId,target.conversation.externalId))throw new ChannelError('forbidden','bot_left_group');this.repository.assertDeliveryAuthorization?.(row);if(this.connections.currentBindingVersion(scope.source!.connectionId)!==scope.source!.bindingVersion||!this.repository.ownsDelivery(row.id,token))throw new Error();}catch{attempted=false;throw new ChannelError('forbidden','delivery_authorization_changed');}},beforeSend:async()=>{try{await resolve();if(!this.repository.ownsDelivery(row.id,token))throw new ChannelError('forbidden','delivery_lease_lost');}catch(error){attempted=false;throw error;}},...(reply?{replyToMessageId:replyId}:{}),...(target.threadId?{threadId:target.threadId}:{})}));if(!receipt)return;
   this.repository.finishDelivery(row.id,token,receipt.status,undefined,receipt.messageId,receipt.providerRequestId);
   this.diagnostics.event({stage:'outbox.send',phase:'point',outcome:receipt.status==='sent'?'success':'unknown',status:receipt.status,...(receipt.status==='unknown'?{reason:'delivery_unknown'}:{}),text:row.text});
  }catch(error){const status=!attempted?(error instanceof ChannelError&&error.code==='temporarily_unavailable'?'blocked':'failed'):error instanceof ChannelError&&['forbidden','unauthenticated','invalid_request','unsupported'].includes(error.code)?'failed':'unknown';this.diagnostics.event({stage:'outbox.send',phase:'point',outcome:status==='unknown'?'unknown':'failure',status,reason:status==='unknown'?'delivery_unknown':'send_failed',text:row.text,...diagnosticFailure(error)});if(!attempted&&error instanceof ChannelError&&error.code==='temporarily_unavailable')this.repository.finishDelivery(row.id,token,'blocked',safeError(error));else if(this.repository.deferDelivery&&(error instanceof ChannelError&&['rate_limited','temporarily_unavailable'].includes(error.code)||typeof error==='object'&&error!==null&&'details'in error&&[429,503].includes(Number((error as {details?:{httpStatus?:number}}).details?.httpStatus))))this.repository.deferDelivery(row.id,token,{safeToRetry:true,...(error instanceof ChannelError&&error.retryAfterMs!==undefined?{retryAfterMs:error.retryAfterMs}:{})});else this.repository.finishDelivery(row.id,token,status,safeError(error));}finally{clearInterval(renew);}
 }
 async tick(){
  if(this.busy||this.stopping)return;this.busy=true;
  try{
   if(this.reconcileRequested||this.now()>=this.nextReconcile){this.reconcileRequested=false;this.nextReconcile=this.now()+30000;const late=this.lateReconcile;this.lateReconcile=false;await this.reconcileInputs(late);}
   while(this.incoming.size<32&&!this.stopping){const token=randomUUID(),row=this.repository.claimInbox(this.now(),this.now()+60_000,token);if(!row)break;const work=this.consume(row,token).finally(()=>this.incoming.delete(work));this.incoming.add(work);void work.catch(()=>{});}
   for(const d of this.repository.taskDeliveries()){
    try{const scope=scopeFromJson(d.sourceJson,{workspaceId:d.workspaceId,entityId:d.entityId,userId:d.userId});if(!scope.source)continue;
     const source=scope.source,target={conversation:{provider:source.channelType,connectionId:source.connectionId,tenantId:source.tenantId,kind:'conversation',externalId:source.conversationId,conversationKind:source.conversationKind,...(source.conversationKind==='private'?{privateRecipientId:scope.principal.externalUserId}:{})},...((source.conversationKind==='group'||source.threadId)&&source.replyToMessageId?{replyToMessageId:source.replyToMessageId}:{}),...(source.threadId?{threadId:source.threadId}:{})};
     const correlation={traceId:hash(['task-delivery',d.id]),messageId:`task-delivery:${d.id}`,taskId:d.taskId,...(d.conversationId?{conversationId:d.conversationId}:{})};
     this.repository.enqueueDelivery({id:correlation.messageId,scopeJson:JSON.stringify(scope),targetJson:JSON.stringify(target),text:d.text,status:'queued',taskDeliveryId:d.id,leaseToken:null,correlation},this.now());
     this.diagnostics.run(correlation,()=>this.diagnostics.event({stage:'outbox.queued',phase:'point',outcome:'queued'}));
    }catch{/* Invalid persisted source cannot be routed or repaired with a guessed identity. */}
   }
   while(this.outgoing.size<32&&!this.stopping){const token=randomUUID(),row=this.repository.claimDelivery(this.now(),this.now()+60_000,token);if(!row)break;const work=this.send(row,token).finally(()=>this.outgoing.delete(work));this.outgoing.add(work);void work.catch(()=>{});}
  }finally{this.busy=false;if(this.pendingWake){this.pendingWake=false;this.requestTick();}}
 }
 async waitForWork(){while(this.incoming.size||this.outgoing.size)await Promise.allSettled([...this.incoming,...this.outgoing]);}
 async stop(){this.stopping=true;this.unsubscribe?.();await this.waitForWork();this.repository.close?.();}
}
