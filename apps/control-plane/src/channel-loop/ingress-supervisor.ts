import type {InboundAssetLocator} from '../adapters/channels/ingress/media.js';
import {FeishuGroupLifecycle} from './feishu-group-lifecycle.js';
import type {DiscoveredGroups} from './discovered-groups.js';
import {createHash,randomUUID} from 'node:crypto';
import {ChannelError,nullDiagnostics,diagnosticFailure,type DiagnosticPort,type ChannelIngressSession,type ChannelIngressPort,type ChannelIngressStatus,type ChannelIngressDisposition,type ChannelMessageLoop,type SendChannelMessage,type ChannelSendReceipt,type MessageLoopBinding,type ChannelMessageEvent} from '@dentity/application';
import type {EmployeeChannelService} from '../employee-channels/service.js';
import type {ChannelIngressFactory} from './ingress-types.js';
import {IngressOwner} from './ingress-owner.js';
import {normalizeChannelIngressEvent,ingressMessageText,ingressReplyTarget} from '../adapters/channels/ingress/normalize.js';
import {redactMessageJson} from '../adapters/message-json.js';

type Live={session:ChannelIngressSession;port:ChannelIngressPort};
type Health=ChannelIngressStatus & {lastConnectedAt?:number;lastDisconnectedAt?:number};
/** No model-visible entrypoint. Every sink is bound to one actual child runner. */
export class ChannelIngressSupervisor {
 private readonly active=new Map<string,Live>();
 private readonly health=new Map<string,Health>();
 private readonly chains=new Map<string,Promise<void>>();
 private readonly retry=new Map<string,{at:number;attempt:number;revision:number;authRevision:number}>();
 private timer:ReturnType<typeof setInterval>|undefined;
 private stopped=true;
 private owned=false;
 private tickPromise:Promise<void>|undefined;
 private stopPromise:Promise<void>|undefined;
 private readonly owner:IngressOwner;
 private readonly groupLifecycle:FeishuGroupLifecycle|undefined;
 constructor(private readonly connections:EmployeeChannelService,private readonly loop:ChannelMessageLoop,private readonly factory:ChannelIngressFactory,private readonly now:()=>number,private readonly diagnostics:DiagnosticPort=nullDiagnostics,private readonly groups?:DiscoveredGroups,private readonly captureAssets?:(binding:MessageLoopBinding,event:ChannelMessageEvent,media:readonly InboundAssetLocator[])=>void){this.owner=new IngressOwner(connections.repository.store,now);this.groupLifecycle=groups?new FeishuGroupLifecycle(connections.repository.store,groups,loop,now):undefined;}
 status(id:string):Health{return this.health.get(id)??{state:'stopped',changedAt:this.now()};}
 private setStatus(id:string,status:ChannelIngressStatus){const previous=this.health.get(id);const {error:_oldError,...history}=previous??{};this.health.set(id,{...history,state:status.state,changedAt:this.now(),...(status.error?{error:/^[a-z0-9_]{1,100}$/.test(status.error)?status.error:'channel_transport_failed'}:{}),...(status.state==='connected'?{lastConnectedAt:this.now()}:previous?.state==='connected'?{lastDisconnectedAt:this.now()}:{})});}
 async start(){if(!this.stopped)return;this.stopped=false;this.stopPromise=undefined;this.connections.setSessionSender((id,request)=>this.send(id,request));this.connections.setIngressHooks(id=>this.changed(id),id=>this.status(id));this.timer=setInterval(()=>{void this.tick().catch(()=>this.stop());},5_000);this.timer.unref();await this.tick();}
 async tick():Promise<void>{if(this.tickPromise)return this.tickPromise;const work=this.runTick();this.tickPromise=work;void work.then(()=>{this.tickPromise=undefined;},()=>{this.tickPromise=undefined;});return work;}
 private async runTick(){
  if(this.stopped)return;
  if(this.owned&&!this.owner.renew()){this.owned=false;await this.closeActive('owner_lost');this.owner.release();}
  if(this.stopped)return;
  if(!this.owned){try{this.owner.acquire();this.owned=true;}catch(error){if(!(error instanceof ChannelError)||error.message!=='channel_ingress_owner_busy')throw error;for(const r of this.connections.repository.all())this.setStatus(r.id,{state:'stopped',changedAt:this.now(),error:'channel_ingress_standby'});return;}}
  for(const r of this.connections.repository.all())this.changed(r.id);
  await Promise.all([...this.chains.values()]);
  for(const connectionId of this.active.keys())for(const pending of this.groupLifecycle?.pending(connectionId)??[]){const live=this.active.get(pending.connection_id);if(!live||!this.current(live))continue;if(this.connections.currentBindingVersion(pending.connection_id)!==pending.binding_version){this.commit(live,()=>this.groupLifecycle!.obsolete(pending.id));continue;}try{await this.applyNormalized(live,JSON.parse(pending.payload));}catch{/* Persisted pending evidence remains eligible for a later owner tick. */}}
 }
 /** Synchronous revocation precedes asynchronous SDK close. */
 private changed(id:string){const pending=this.retry.get(id),record=this.connections.repository.byId(id);if(pending&&(pending.at===Infinity?record?.authRevision!==pending.authRevision:record?.revision!==pending.revision))this.retry.delete(id);const live=this.active.get(id),r=this.connections.repository.byId(id);if(!live&&(!r||!r.enabled||!['verified','pending_verification'].includes(r.status)))this.setStatus(id,{state:'stopped',changedAt:this.now()});if(live&&(!r||!r.enabled||!['verified','pending_verification'].includes(r.status)||r.revision!==live.session.revision||r.authRevision!==live.session.authRevision)){this.active.delete(id);this.setStatus(id,{state:'stopped',changedAt:this.now()});const previous=this.chains.get(id)??Promise.resolve();this.chains.set(id,previous.catch(()=>{}).then(()=>live.port.stop('configuration_changed')));}void this.reconcile(id);}
 private reconcile(id:string):Promise<void>{const previous=this.chains.get(id)??Promise.resolve();const next=previous.catch(()=>{}).then(async()=>{if(this.stopped||!this.owned||this.active.has(id)||(this.retry.get(id)?.at??0)>this.now())return;this.owner.assert();let config;try{config=this.connections.ingressConfiguration(id);}catch{this.setStatus(id,{state:'failed',changedAt:this.now(),error:'channel_credentials_unavailable'});return;}if(!config){this.setStatus(id,{state:'stopped',changedAt:this.now()});return;}const r=config.record,session:ChannelIngressSession={connectionId:r.id,provider:r.provider,appId:r.appId,revision:r.revision,authRevision:r.authRevision,generation:randomUUID()};if(r.provider==='wecom'&&[...this.active.values()].some(other=>other.session.provider==='wecom'&&other.session.appId===r.appId)){this.setStatus(id,{state:'failed',changedAt:this.now(),error:'channel_duplicate_live_bot'});return;}const port=this.factory(session,config.credentials),live={session,port};this.active.set(id,live);this.setStatus(id,{state:'connecting',changedAt:this.now()});try{await port.start(session,{onEvent:envelope=>this.receive(live,envelope),onStatus:status=>{if(this.current(live)){this.setStatus(id,status);if(status.state==='failed')this.failed(live,status.error);else if(status.state==='connected')this.retry.delete(id);}}});}catch{if(this.active.get(id)===live){this.setStatus(id,{state:'failed',changedAt:this.now(),error:'channel_transport_start_failed'});this.failed(live);}await port.stop('startup_failed');}});this.chains.set(id,next);void next.catch(()=>{if(!this.stopped)this.setStatus(id,{state:'failed',changedAt:this.now(),error:'channel_ingress_unavailable'});});return next;}
 private failed(live:Live,error?:string){const id=live.session.connectionId;if(this.active.get(id)!==live)return;this.active.delete(id);const attempt=(this.retry.get(id)?.attempt??0)+1;this.retry.set(id,{at:['channel_authentication_failed','channel_connection_taken_over'].includes(error??'')?Infinity:this.now()+Math.min(30_000,1000*2**Math.min(attempt-1,5))+Math.floor(Math.random()*500),attempt,revision:live.session.revision,authRevision:live.session.authRevision});const previous=this.chains.get(id)??Promise.resolve();this.chains.set(id,previous.catch(()=>{}).then(()=>live.port.stop('transport_failed')));}
 private current(live:Live){const s=live.session,r=this.connections.repository.byId(s.connectionId);return !this.stopped&&this.owned&&this.active.get(s.connectionId)===live&&!!r&&r.enabled&&['verified','pending_verification'].includes(r.status)&&r.revision===s.revision&&r.authRevision===s.authRevision;}
 private assert(live:Live){this.owner.assert();if(!this.current(live))throw new ChannelError('forbidden','channel_ingress_generation_expired');}
 private commit<T>(live:Live,write:()=>T):T{return this.owner.commit(()=>{this.assert(live);return write();});}
 private async receive(live:Live,envelope:unknown):Promise<ChannelIngressDisposition>{
  this.assert(live);const r=this.connections.repository.byId(live.session.connectionId)!;
  const tenantHints=r.provider==='wecom'
   ? {tenantId:r.appId,tenantNamespace:'app_id' as const}
   : r.eventTenantId?{tenantId:r.eventTenantId,tenantNamespace:r.provider==='feishu'?'tenant_key' as const:'corp_id' as const}:{};
  const hints={...(r.botId?{botId:r.botId}:{}),...tenantHints,...(r.robotCode?{robotCode:r.robotCode}:{})};
  const target=ingressReplyTarget(live.session,envelope,hints),bindingVersion=this.connections.currentBindingVersion(r.id),text=ingressMessageText(r.provider,envelope);
  let fingerprint:string;try{fingerprint=JSON.stringify(envelope);}catch{fingerprint=randomUUID();}
  const traceId=createHash('sha256').update(JSON.stringify(target&&bindingVersion?[r.workspaceId,r.entityId,r.id,bindingVersion,target.conversation.tenantId,target.conversation.externalId,target.messageId,'initial']:[r.id,fingerprint])).digest('hex');
  const correlation={traceId,messageId:traceId};
  // Raw SDK message fields are logged before business parsing; credentials are redacted at the adapter boundary.
  let payload:{json?:unknown;text?:string}={...(text!==undefined?{text}:{})};
  if(r.provider==='feishu')try{payload=redactMessageJson({json:envelope,...payload}) as typeof payload;}catch{/* Invalid JSON cannot break the existing rejection/ACK path. */}
  this.diagnostics.event({stage:'ingress.received',phase:'point',...correlation,status:'received',receivedAt:this.now(),...payload,...(r.provider==='feishu'&&payload.json!==undefined?{messageKind:'receive' as const}:{})});
  let normalized:ReturnType<typeof normalizeChannelIngressEvent>;
  try{normalized=normalizeChannelIngressEvent(live.session,envelope,hints,this.now());}
  catch(error){
   this.diagnostics.event({stage:'ingress.received',phase:'point',...correlation,outcome:'failure',status:'failed',reason:'identity_invalid',...diagnosticFailure(error)});
   if(r.status==='verified'&&target&&bindingVersion)await this.loop.rejectAuthenticatedEvent({workspaceId:r.workspaceId,entityId:r.entityId,connectionId:r.id,bindingVersion,appId:r.appId,...target},'identity',write=>this.commit(live,write));
   else this.diagnostics.event({stage:'outbox.send',phase:'point',...correlation,outcome:'failure',status:'failed',reason:'reply_target_unavailable'});
   throw error;
  }
  return this.applyNormalized(live,normalized);
 }
 private async applyNormalized(live:Live,normalized:ReturnType<typeof normalizeChannelIngressEvent>):Promise<ChannelIngressDisposition>{
  this.assert(live);const r=this.connections.repository.byId(live.session.connectionId)!;
  const event=normalized.kind==='message'||normalized.kind==='group_record'?normalized.event:undefined;
  const bindingVersion=this.connections.currentBindingVersion(r.id);
  const target=event?{conversation:event.message.conversation,messageId:event.message.id,eventId:event.eventId,...(event.message.threadId?{threadId:event.message.threadId}:{})}:undefined;
  const correlation={traceId:createHash('sha256').update(JSON.stringify([r.id,event?.eventId,normalized.kind])).digest('hex')};
  const binding=r.provider==='feishu'&&r.status==='verified'&&this.groupLifecycle?await this.connections.resolveBinding(r.id):undefined;
  const apply=()=>this.applyNormalizedCore(live,normalized,target,bindingVersion,correlation);
  return binding&&this.groupLifecycle?this.groupLifecycle.handle(binding,normalized,fn=>this.commit(live,fn),apply):apply();
 }
 private async applyNormalizedCore(live:Live,normalized:ReturnType<typeof normalizeChannelIngressEvent>,target:ReturnType<typeof ingressReplyTarget>,bindingVersion:string|undefined,correlation:{traceId:string}):Promise<ChannelIngressDisposition>{
  this.assert(live);const r=this.connections.repository.byId(live.session.connectionId)!;
  if(normalized.kind==='ignored'){this.diagnostics.event({stage:'ingress.received',phase:'point',...correlation,status:'ignored',reason:normalized.reason==='self_message'?'self_message':'unsupported_message'});return this.commit(live,()=> 'ignored');}
  if(normalized.kind==='membership')return this.commit(live,()=>{if(r.status==='verified'){this.loop.membership(r.id,normalized.chatId,normalized.present,normalized.occurredAt);this.groups?.membership(r.id,normalized.chatId,normalized.present,normalized.occurredAt);}return 'accepted';});
  const {event}=normalized;
  if(event.origin!=='live')return this.commit(live,()=> 'ignored');
  if(normalized.kind==='group_record'){
   if(r.status!=='verified'||!this.groups)return this.commit(live,()=> 'ignored');
   const binding=await this.connections.resolveBinding(r.id);if(!binding)return this.commit(live,()=> 'ignored');
   return this.commit(live,()=>{this.groups!.record(binding,event);return'accepted';});
  }
  if(this.connections.isVerificationEvent(r.id,event.eventId,event.message.id))return this.commit(live,()=> 'duplicate');
  if(r.provider!=='feishu'&&(normalized.verificationText===r.verification?.challengeText||
     /^identity-verify-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(normalized.verificationText)))
   return this.commit(live,()=> 'ignored');
  if(r.status==='pending_verification'&&r.provider!=='feishu'){
   const isHuman=event.message.author.kind==='human'&&!!event.message.author.externalId;
   const directed=event.message.conversationKind==='private'||(r.provider==='wecom'
    ? event.message.providerDirectedBot===true
    : event.message.mentions.includes(normalized.candidate.botId));
   if(!isHuman||!directed)return this.commit(live,()=> 'ignored');
   this.commit(live,()=>this.connections.observeFirstInbound(r.id,normalized.candidate));
   bindingVersion=this.connections.currentBindingVersion(r.id);
  }else if(r.status==='pending_verification'){
   const v=r.verification;
   if(!v||v.expiresAt<=this.now())return this.commit(live,()=> 'ignored');
   if(normalized.verificationText!==v.challengeText) return this.commit(live,()=> 'ignored');
   const botId=normalized.candidate.botId;
   if(!botId||event.message.author.kind!=='human'||!event.message.author.externalId||event.message.author.externalId===botId||(event.message.conversationKind==='group'&&!event.message.mentions.includes(botId)&&!(r.provider==='wecom'&&event.message.providerDirectedBot===true)))throw new ChannelError('forbidden','channel_verification_invalid');
   return this.commit(live,()=>{this.connections.recordVerifiedCandidate(r.id,String(r.revision),{appId:r.appId,botId,tenantId:event.tenantId,...(normalized.candidate.robotCode?{robotCode:normalized.candidate.robotCode}:{}),challengeText:v.challengeText,eventId:event.eventId,messageId:event.message.id});return 'accepted';});
  }
  if(r.provider==='wecom'&&event.message.author.kind==='human'&&event.message.author.externalId&&
     (event.message.conversationKind==='private'||event.message.providerDirectedBot===true))
   this.commit(live,()=>this.connections.observeWeComContact(r.id,event.message.author.externalId!));
  if(this.groups){const binding=await this.connections.resolveBinding(r.id);if(binding)this.commit(live,()=>this.groups!.record(binding,event));}
  try{
   if(normalized.media?.length&&this.captureAssets){const binding=await this.connections.resolveBinding(r.id);this.assert(live);if(binding)this.captureAssets(binding,event,normalized.media);}
   const result=await this.loop.acceptAuthenticatedEvent(r.id,event,write=>this.commit(live,write));
   return this.commit(live,()=>result.kind==='ignored'?'ignored':result.status==='created'?'accepted':'duplicate');
  }catch(error){
   this.diagnostics.event({stage:'ingress',phase:'point',...correlation,outcome:'failure',...diagnosticFailure(error)});
   if(target&&bindingVersion)await this.loop.rejectAuthenticatedEvent({workspaceId:r.workspaceId,entityId:r.entityId,connectionId:r.id,bindingVersion,appId:r.appId,...target},'service',write=>this.commit(live,write));
   throw error;
  }
 }
 /** Used before claiming owner-only inbox/delivery jobs. Never claim on standby. */
 canDispatch(connectionId:string):boolean {
  const r=this.connections.repository.byId(connectionId);if(r?.provider!=='wecom')return true;
  const live=this.active.get(connectionId);if(!live||!this.current(live)||this.status(connectionId).state!=='connected')return false;
  try{this.owner.assert();return true;}catch{return false;}
 }
 async send(connectionId:string,request:SendChannelMessage):Promise<ChannelSendReceipt>{
  const live=this.active.get(connectionId);
  if(!live?.port.send)throw new ChannelError('not_ready','channel_session_unavailable');
  const guard=()=>{
   this.assert(live);const r=this.connections.repository.byId(connectionId)!;
   if(r.inboundVerified!==true||!this.connections.currentBindingVersion(connectionId)||r.provider!=='wecom'||request.conversation.connectionId!==connectionId||request.conversation.provider!=='wecom'||request.conversation.tenantId!==r.eventTenantId||this.status(connectionId).state!=='connected')throw new ChannelError('forbidden','channel_send_binding_expired');
  };
  const authorizeRecipient=async()=>{
   guard();
   if(request.conversation.conversationKind!=='private'||request.replyToMessageId)return;
   const recipient=request.conversation.privateRecipientId;
   if(!recipient)throw new ChannelError('forbidden','channel_send_recipient_unverified');
   try{
    if(request.originatingTaskScope!==undefined){
     if(typeof request.originatingTaskScope!=='function')throw new ChannelError('forbidden');
     const scope=request.originatingTaskScope(),source=scope.source,principal=scope.principal;
     const binding=await this.connections.resolveBinding(connectionId);
     if(!binding||scope.workspaceId!==binding.workspaceId||scope.entityId!==binding.entityId||!source||principal?.kind!=='channel'||
        source.channelType!=='wecom'||source.applicationId!==binding.appId||source.connectionId!==connectionId||source.installationId!==connectionId||
        source.tenantId!==binding.connection.tenantId||source.bindingVersion!==binding.bindingVersion||source.conversationKind!=='private'||source.threadId||
        !source.sourceEventId||!source.replyToMessageId||source.conversationId!==recipient||request.conversation.externalId!==recipient||
        principal.channelType!=='wecom'||principal.tenantId!==source.tenantId||principal.identityNamespace!=='user_id'||principal.externalUserId!==recipient)
      throw new ChannelError('forbidden','channel_task_recipient_mismatch');
     await this.connections.authorizeInvocation(binding,{kind:'human',externalId:recipient,idNamespace:'user_id',applicationId:binding.appId,identityEvidence:'channel_verified'},'private',source);
    }else await this.connections.assertWeComPrivateRecipient(connectionId,recipient);
   }catch{throw new ChannelError('forbidden','channel_send_recipient_unverified');}
   guard();
  };
  await authorizeRecipient();await request.beforeSend?.();guard();
  return live.port.send({...request,beforeSend:async()=>{await authorizeRecipient();guard();},assertSendAllowed:()=>{guard();request.assertSendAllowed?.();guard();}});
 }
 async stop(){if(this.stopPromise)return this.stopPromise;this.stopPromise=this.stopAll();return this.stopPromise;}
 private async closeActive(reason:string){const live=[...this.active.values()];this.active.clear();for(const item of live)this.setStatus(item.session.connectionId,{state:'stopped',changedAt:this.now()});await Promise.allSettled([...this.chains.values()]);await Promise.allSettled(live.map(item=>item.port.stop(reason)));}
 private async stopAll(){if(this.stopped)return;this.stopped=true;this.owned=false;if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.closeActive('supervisor_stopped');
  // A lease-loss tick may already own the old runners after clearing active.
  // Drain that tick before callers may close SQLite. runTick never awaits stop().
  await this.tickPromise?.catch(()=>{});this.owner.release();}
}
