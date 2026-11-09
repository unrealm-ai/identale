import {initializeChannelSourceAccess,resetChannelSourceAccess} from '../capability-config.js';
import type {DirectorySyncSource,DirectorySnapshotReader} from '../directory-sync/service.js';
import {randomUUID,createHash} from 'node:crypto';
import {diagnosticFailure} from '@dentity/application';
import {DirectoryError,type DirectoryAccessRule,type DirectoryProvider,type DirectoryPort,type DirectoryPerson,type DirectoryDepartment,type ChannelActor,type ChannelSpeakerProfile,type ChannelAccessScope,type ChannelConnection,type ChannelIngressStatus,type SendChannelMessage,type ChannelSendReceipt,type TaskScope} from '@dentity/application';
import {WeComConversationAdapter} from '../adapters/channels/wecom.js';
import {DirectoryCursors,DirectoryRequestError} from '../adapters/directory/http.js';
import {DirectoryCredentialVault} from '../directory/secrets.js';
import {createDirectoryAdapter} from '../adapters/directory/index.js';
import {FeishuConversationAdapter,FeishuMinutesAdapter,DingTalkBotConversationAdapter} from '../adapters/channels/index.js';
import {EmployeeApplicationTransport} from './provider.js';
import {EmployeeChannelRepository,ChannelBindingConflict} from './repository.js';
import type {EmployeeChannelRecord,EmployeeChannelOptions,EmployeeChannelCredential,ResolvedEmployeeChannelBinding} from './types.js';
import {validationOf,wecomBotValidation,type ChannelValidation} from './validation.js';
import {resolveChannelConfigurationCapabilities} from './capabilities.js';
import type {ChannelIngressCandidate} from '../adapters/channels/ingress/normalize.js';
import {WeComMemberVerification,WeComMemberVerificationError} from './wecom-member-verification.js';
import {WeComBotMemberSearch} from '../adapters/directory/wecom-bot-search.js';
import {WeComBotContacts,usesWeComBotSearch,weComSearchIdentityVerified,weComCallbackUserId,weComSearchUserId,weComVerifiedUserIds} from './wecom-bot-contacts.js';
export class EmployeeChannelError extends Error {constructor(readonly status:number,readonly code:string,readonly validation?:ChannelValidation){super(code);}get statusCode(){return this.status;}}
const fail=(status:number,code:string):never=>{throw new EmployeeChannelError(status,code);};
const safe=(e:unknown)=>e instanceof DirectoryError?e.code:'channel_connection_unavailable';
const same=(a:EmployeeChannelRecord['identity'],b:EmployeeChannelRecord['identity'])=>a.appId===b.appId&&a.tenantId===b.tenantId&&a.tenantIdNamespace===b.tenantIdNamespace;
const defaultContext=(provider:DirectoryProvider):NonNullable<EmployeeChannelRecord['context']>=>({historyEnabled:false,...(provider==='feishu'?{groupListenEnabled:true,listenGeneration:0}:{}),meetingRefs:[]});
// Legacy callback-scoped DingTalk bot IDs cannot silently gain the new meaning.
const canonicalBot=(r:EmployeeChannelRecord)=>r.provider!=='dingtalk'||!!r.robotCode&&r.botId===r.robotCode;
const legacyDingtalkIdentity=(r:EmployeeChannelRecord)=>r.provider==='dingtalk'&&(r.botId!==undefined&&r.botId!==r.robotCode||r.status==='verified'&&!canonicalBot(r));
const validId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\u0000-\u001f]/.test(v);
export interface DirectoryEvaluation {deadline:number;remaining:number;users:Map<string,Promise<DirectoryPerson>>;departments:Map<string,Promise<DirectoryDepartment>>}
export const channelSubject=(kind:'channel_user'|'department',id:string,namespace:string,appId:string)=>JSON.stringify([kind,namespace,appId,id]);
/** Optional ordinary-message permission is evidence, never inferred from local settings. */
function groupMessagePermission(record:EmployeeChannelRecord):'granted'|'denied'|'unverified'{
 const rows=record.validation?.checks.filter(c=>c.id==='scope_inventory').flatMap(c=>c.scopeInventory??[]).filter(s=>s.scope==='im:message.group_msg'&&s.identity==='tenant')??[];
 return rows.length&&rows.every(s=>s.status==='granted')?'granted':rows.some(s=>s.status==='denied')?'denied':'unverified';
}
export function groupHistoryPermission(record:EmployeeChannelRecord):boolean{
 const rows=record.validation?.checks.filter(c=>c.id==='scope_inventory').flatMap(c=>c.scopeInventory??[]).filter(s=>s.identity==='tenant')??[];
 return groupMessagePermission(record)==='granted'&&['im:message:readonly','im:message','im:message.history:readonly'].some(scope=>{const found=rows.filter(r=>r.scope===scope);return found.length>0&&found.every(r=>r.status==='granted');});
}
export class EmployeeChannelService {
 readonly botContacts:WeComBotContacts;
 readonly memberVerification:WeComMemberVerification;
 private memberVerificationPersistence:((r:EmployeeChannelRecord,requestId:string,callbackUserId:string)=>Promise<boolean>)|undefined;
 setMemberVerificationPersistence(check:(r:EmployeeChannelRecord,requestId:string,callbackUserId:string)=>Promise<boolean>){this.memberVerificationPersistence=check;}
 async memberVerificationPersisted(id:string,callbackUserId:string){const r=this.repository.byId(id),mapping=r?.wecomContactMappings?.find(m=>m.callbackUserId===callbackUserId);if(!r||!mapping)return false;if(!this.memberVerificationPersistence)return true;let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([this.memberVerificationPersistence(r,mapping.requestId,callbackUserId),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),2000);})]);}finally{if(timer)clearTimeout(timer);}}
 private memberVerificationReceiver:((r:EmployeeChannelRecord,requestId:string)=>Promise<boolean>)|undefined;
 setMemberVerificationReceiver(check:(r:EmployeeChannelRecord,requestId:string)=>Promise<boolean>){this.memberVerificationReceiver=check;}
 memberVerificationReady(id:string,sourceId:string,authRevision:number,requestId:string,stateVersion:number){const r=this.repository.byId(id);return !!r&&r.sourceId===sourceId&&r.authRevision===authRevision&&r.stateVersion>=stateVersion&&this.memberVerification.ready(r,requestId)&&this.transportStatus?.(id).state==='connected';}
 private readonly botSearchClients=new Map<string,{key:string;client:WeComBotMemberSearch}>();
 private sessionSender:((connectionId:string,request:SendChannelMessage)=>Promise<ChannelSendReceipt>)|undefined;
 setSessionSender(sender:(connectionId:string,request:SendChannelMessage)=>Promise<ChannelSendReceipt>){this.sessionSender=sender;}
 private readonly vault:DirectoryCredentialVault;
 private readonly cursors=new DirectoryCursors();
 private readonly now:()=>number;
 private readonly active=new Map<string,{version:string;directory:DirectoryPort;transport:EmployeeApplicationTransport|undefined}>();
 private readonly speakerUsers=new Map<string,{expiresAt:number;user:DirectoryPerson}>();
 private speakerKey(r:EmployeeChannelRecord,namespace:string,id:string){return JSON.stringify([r.workspaceId,r.entityId,r.id,r.revision,r.authRevision,r.appId,r.eventTenantId,namespace,id]);}
 private rememberSpeaker(r:EmployeeChannelRecord,namespace:string,id:string,user:DirectoryPerson){
  for(const [key,value] of this.speakerUsers)if(value.expiresAt<=this.now())this.speakerUsers.delete(key);
  if(this.speakerUsers.size>=1024)this.speakerUsers.delete(this.speakerUsers.keys().next().value!);
  this.speakerUsers.set(this.speakerKey(r,namespace,id),{expiresAt:this.now()+15000,user});
 }
 private cleanupListener:((id:string)=>void)|undefined;
 setCleanupListener(listener:(id:string)=>void){this.cleanupListener=listener;}
 private changed(id:string){this.cleanupListener?.(id);this.changeListener?.(id);}
 private changeListener:((id:string)=>void)|undefined;
 private transportStatus:((id:string)=>ChannelIngressStatus)|undefined;
 setIngressHooks(onChange:(id:string)=>void,status:(id:string)=>ChannelIngressStatus){this.changeListener=onChange;this.transportStatus=status;}
 notifyCommitted(id:string){this.active.delete(id);this.changed(id);}
 /** Shared by employee editing and wizard commit. No network or precommit transport notification. */
 persistCreation(record:EmployeeChannelRecord,actor:string){this.entity(record.workspaceId,record.entityId);try{this.repository.store.transaction(()=>{if(!this.repository.save(record,undefined))fail(409,'channel_connection_conflict');initializeChannelSourceAccess(this.repository.store,record.workspaceId,record.entityId,record.sourceId);this.repository.audit(record,actor,'wizard_connection_created',this.now());});}catch(error){if(error instanceof EmployeeChannelError)throw error;fail(409,'channel_connection_conflict');}}
 /** Configuration reset only. Business conversations, tasks and audit are retained. */
 private resetSource(old:EmployeeChannelRecord,nextSourceId?:string){
  const store=this.repository.store;
  resetChannelSourceAccess(store,old.workspaceId,old.entityId,old.sourceId,nextSourceId);
  this.botContacts.remove(old.id);this.memberVerification.remove(old.id);
  if(store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='employee_group_sharing_rules'")){
   const saved=store.one<{revision:number;rules_json:string}>('SELECT revision,rules_json FROM employee_group_sharing_rules WHERE workspace_id=? AND entity_id=?',old.workspaceId,old.entityId);
   if(saved){const rules=JSON.parse(saved.rules_json) as {sources:{connectionId:string}[];targets:{connectionId:string}[]}[];const retained=rules.filter(rule=>![...rule.sources,...rule.targets].some(ref=>ref.connectionId===old.id));if(retained.length!==rules.length)store.run('UPDATE employee_group_sharing_rules SET revision=revision+1,rules_json=? WHERE workspace_id=? AND entity_id=?',JSON.stringify(retained),old.workspaceId,old.entityId);}
  }
 }
 unbind(w:string,e:string,p:DirectoryProvider,actor:string,input:{expectedRevision:number}){const old=this.require(w,e,p);if(old.revision!==input.expectedRevision)fail(409,'channel_configuration_changed');this.repository.store.transaction(()=>{const current=this.require(w,e,p);if(current.stateVersion!==old.stateVersion||current.revision!==input.expectedRevision)fail(409,'channel_configuration_changed');this.repository.audit(current,actor,'connection_unbound',this.now());this.resetSource(current);if(!this.repository.remove(current))fail(409,'channel_configuration_changed');this.repository.store.run('DELETE FROM employee_channel_verification_events WHERE connection_id=?',current.id);});this.active.delete(old.id);this.botSearchClients.delete(old.id);this.changed(old.id);return{ok:true};}
 ingressConfiguration(id:string){const r=this.repository.byId(id);if(!r||!r.enabled||!['verified','pending_verification'].includes(r.status)||legacyDingtalkIdentity(r)||r.provider==='wecom'&&!usesWeComBotSearch(r))return undefined;return{record:r,credentials:r.provider==='wecom'?{botSecret:this.secret(r).appSecret}:{appSecret:this.secret(r).appSecret}};}
 private accessCheck:((scope:ChannelAccessScope,connection:ChannelConnection,kind:'private'|'group'|'meeting')=>Promise<boolean>)|undefined;
 constructor(readonly repository:EmployeeChannelRepository,private readonly options:EmployeeChannelOptions={}){this.vault=new DirectoryCredentialVault(options.masterKey);this.now=options.now??Date.now;this.botContacts=new WeComBotContacts(repository.store,this.now);this.memberVerification=new WeComMemberVerification(repository,this.now,{secret:r=>this.secret(r).appSecret,vault:this.vault,...(options.masterKey?{collisionKey:options.masterKey}:{})});}
 setAccessCheck(fn:NonNullable<EmployeeChannelService['accessCheck']>){this.accessCheck=fn;}
 private snapshots:DirectorySnapshotReader|undefined;
 setDirectorySnapshots(value:DirectorySnapshotReader){this.snapshots=value;}
 private directoryRules(r:EmployeeChannelRecord):DirectoryAccessRule[]{const policy=this.repository.store.one<{allow_json:string;deny_json:string;channel_policies_json:string}>('SELECT allow_json,deny_json,channel_policies_json FROM entity_directory_policies WHERE workspace_id=? AND entity_id=?',r.workspaceId,r.entityId),rules:DirectoryAccessRule[]=[...JSON.parse(policy?.allow_json??'[]'),...JSON.parse(policy?.deny_json??'[]'),...(JSON.parse(policy?.channel_policies_json??'[]') as {allow:DirectoryAccessRule[];deny:DirectoryAccessRule[]}[]).flatMap(p=>[...p.allow,...p.deny])];for(const row of this.repository.store.all<{config_json:string}>('SELECT config_json FROM capability_packages WHERE workspace_id=? AND entity_id=?',r.workspaceId,r.entityId)){const p=JSON.parse(row.config_json) as{enabled:boolean;directoryAccess?:{allow:DirectoryAccessRule[];deny:DirectoryAccessRule[];channelPolicies?:{allow:DirectoryAccessRule[];deny:DirectoryAccessRule[]}[]}};if(p.enabled&&p.directoryAccess)rules.push(...p.directoryAccess.allow,...p.directoryAccess.deny,...(p.directoryAccess.channelPolicies??[]).flatMap(policy=>[...policy.allow,...policy.deny]));}return rules.filter(rule=>rule.sourceId===r.sourceId);}
 directorySources():DirectorySyncSource[]{return this.repository.store.all<{record_json:string;name:string}>('SELECT c.record_json,e.name FROM employee_channel_connections c JOIN entities e ON e.id=c.entity_id AND e.workspace_id=c.workspace_id').flatMap(({record_json,name})=>{const r=JSON.parse(record_json)as EmployeeChannelRecord;return r.provider==='wecom'?[]:[this.directorySourceFor(r,name)];});}
 directorySource(connectionId:string):DirectorySyncSource|undefined{const r=this.repository.byId(connectionId);if(!r||r.provider==='wecom')return;const entity=this.repository.store.one<{name:string}>('SELECT name FROM entities WHERE workspace_id=? AND id=?',r.workspaceId,r.entityId);return entity?this.directorySourceFor(r,entity.name):undefined;}
 private directorySourceFor(r:EmployeeChannelRecord,name:string):DirectorySyncSource{return{workspaceId:r.workspaceId,entityId:r.entityId,entityName:name,connectionId:r.id,provider:r.provider,appId:r.appId,sourceId:r.sourceId,sourceVersion:JSON.stringify([r.sourceId,r.appId,r.identity.tenantId,r.identity.tenantIdNamespace,r.provider==='dingtalk'?undefined:r.botId]),port:()=>this.clients(r).directory,rules:()=>this.directoryRules(r)};}

 private entity(w:string,e:string){if(!this.repository.store.one('SELECT id FROM entities WHERE id=? AND workspace_id=?',e,w))fail(404,'entity_not_found');}
 private scope(r:EmployeeChannelRecord){return[r.workspaceId,r.entityId,r.id,r.appId,r.authRevision];}
 private secret(r:EmployeeChannelRecord):EmployeeChannelCredential{return JSON.parse(this.vault.open(r.credential,this.scope(r)));}
 private makeDirectory(p:DirectoryProvider,appId:string,secret:EmployeeChannelCredential){return this.options.adapterFactory?.(p,{appId,appSecret:secret.appSecret})??createDirectoryAdapter(p,{appId,appSecret:secret.appSecret,...(this.options.fetch?{fetch:this.options.fetch}:{}),...(this.options.now?{now:this.options.now}:{})});}
 private clients(r:EmployeeChannelRecord){const version=String(r.revision),old=this.active.get(r.id);if(old?.version===version)return old;if(r.provider==='wecom')throw new DirectoryError('unsupported');const secret=this.secret(r),value={version,directory:this.makeDirectory(r.provider,r.appId,secret),transport:new EmployeeApplicationTransport(r.provider,r.appId,secret,this.options)};this.active.set(r.id,value);return value;}
 dto(r:EmployeeChannelRecord,_includeManagement=false){const legacyDing=r.enabled&&legacyDingtalkIdentity(r);const identity=r.provider==='dingtalk'&&r.inboundVerified&&r.eventTenantId?{tenantId:r.eventTenantId,tenantIdNamespace:'corp_id' as const}:r.identity;return{capabilities:resolveChannelConfigurationCapabilities(legacyDing?{...r,status:'invalid'}:r),id:r.id,sourceId:r.sourceId,entityId:r.entityId,provider:r.provider,appId:r.appId,tenantId:identity.tenantId,tenantIdNamespace:identity.tenantIdNamespace,...(r.provider==='dingtalk'?(r.robotCode?{botId:r.robotCode}:{}):r.botId?{botId:r.botId}:{}),revision:r.revision,authRevision:r.authRevision,status:legacyDing?'invalid' as const:r.status,enabled:r.enabled,identityEvidence:r.identityEvidence??'app_credentials_only',inboundVerified:r.inboundVerified===true,directoryStatus:r.directoryStatus,...(usesWeComBotSearch(r)?{directoryMode:'member_search' as const,memberSearchIdentityVerified:weComSearchIdentityVerified(r),memberSearchVerifiedUserIds:weComVerifiedUserIds(r)}:{}),...(r.validation?{validation:r.validation}:{}),lastError:legacyDing?'channel_identity_revalidation_required':r.lastError,groupListeningStatus:r.provider==='feishu'?{enabled:r.context?.groupListenEnabled===true,permission:groupMessagePermission(r),cachedMessages:this.repository.store.one("SELECT name FROM sqlite_master WHERE name='group_live_messages'")?this.repository.store.one<{n:number}>('SELECT count(*) n FROM group_live_messages WHERE connection_id=?',r.id)!.n:0}:undefined,context:r.context??{historyEnabled:false,meetingRefs:[]},transport:this.transportStatus?.(r.id)??{state:'stopped' as const,changedAt:this.now()}};}

 list(w:string,e:string,includeCallbackPath=false){this.entity(w,e);return this.repository.list(w,e).map(r=>this.dto(r,includeCallbackPath));}
 subjects(w:string,e:string){return{sources:this.list(w,e),users:[],departments:[]};}
 private require(w:string,e:string,p:DirectoryProvider){this.entity(w,e);return this.repository.byProvider(w,e,p)??fail(404,'channel_connection_not_found');}
 private write(r:EmployeeChannelRecord,old:EmployeeChannelRecord|undefined,actor:string,action:string){try{this.repository.store.transaction(()=>{if(!this.repository.save(r,old))fail(409,'channel_configuration_changed');if(!old)initializeChannelSourceAccess(this.repository.store,r.workspaceId,r.entityId,r.sourceId);else if(old.sourceId!==r.sourceId)this.resetSource(old,r.sourceId);else if(usesWeComBotSearch(old)&&old.authRevision!==r.authRevision)this.botContacts.remove(old.id);if(action==='verification_candidate_observed'&&r.verification?.candidate)this.repository.markVerificationEvent(r.id,r.verification.candidate.eventId,r.verification.candidate.messageId);this.repository.audit(r,actor,action,this.now());});this.active.delete(r.id);this.changed(r.id);}catch(error){if(error instanceof EmployeeChannelError)throw error;fail(409,'channel_connection_conflict');}}
 async save(w:string,e:string,p:DirectoryProvider,actor:string,input:{appId:string;appSecret:string;expectedRevision?:number;replaceSource?:boolean}){
  if(input.replaceSource!==undefined&&typeof input.replaceSource!=='boolean')fail(400,'invalid_channel_request');
  if(p==='wecom')return this.saveWecom(w,e,actor,input);
  this.entity(w,e);if(!this.vault.available)fail(503,'channel_secret_key_unconfigured');
  if(!validId(input.appId)||typeof input.appSecret!=='string'||!input.appSecret.trim()||input.appSecret.length>8192||/[\r\n\0]/.test(input.appSecret))fail(400,'invalid_channel_credentials');
  const old=this.repository.byProvider(w,e,p);if((old?.revision??0)!==(input.expectedRevision??0))fail(409,'channel_configuration_changed');
  try{this.repository.assertAvailable({provider:p,appId:input.appId,...(old?{id:old.id}:{}),...(old?.appId===input.appId&&old.robotCode?{robotCode:old.robotCode}:{})});}catch(error){if(error instanceof ChannelBindingConflict)fail(409,'channel_connection_conflict');throw error;}
  if(old&&old.appId!==input.appId&&!input.replaceSource)fail(409,'channel_unbind_required');
  // Candidate verification must not invalidate or partially overwrite the live connection.
  const secret:EmployeeChannelCredential={appSecret:input.appSecret};
  let verified;
  try{verified=this.options.verifyApplication?await this.options.verifyApplication(p,input.appId,secret):await new EmployeeApplicationTransport(p,input.appId,secret,this.options).verify(this.makeDirectory(p,input.appId,secret));if(verified.validation&&!verified.validation.canContinue)throw new EmployeeChannelError(400,'channel_validation_failed',verified.validation);if(p==='feishu'&&verified.directoryStatus!=='available')throw new EmployeeChannelError(400,'channel_directory_unavailable');if(verified.identity.appId!==input.appId||!validId(verified.identity.tenantId))throw new DirectoryError('invalid_response');}
  catch(error){if(error instanceof EmployeeChannelError)throw error;throw new EmployeeChannelError(400,validationOf(error)?'channel_validation_failed':safe(error),validationOf(error));}
  if(p==='dingtalk'&&old?.appId===input.appId&&old.identity.tenantIdNamespace==='corp_id'&&verified.identity.tenantIdNamespace==='app_id')verified={...verified,identity:old.identity};
  const compatibleIdentity=!!old&&old.appId===input.appId&&p==='dingtalk'&&old.identity.tenantIdNamespace==='app_id'&&verified.identity.tenantIdNamespace==='corp_id';
  const changed=!!old&&(old.appId!==input.appId||!compatibleIdentity&&!same(old.identity,verified.identity)||verified.botId!==undefined&&old.botId!==undefined&&verified.botId!==old.botId||verified.eventTenantId!==undefined&&old.eventTenantId!==undefined&&verified.eventTenantId!==old.eventTenantId);
  if(changed&&!input.replaceSource)fail(409,'channel_unbind_required');
  const preserve=!!old&&!changed,enabled=preserve?old.enabled:true;
  const r:EmployeeChannelRecord={id:old?.id??randomUUID(),sourceId:changed?randomUUID():old?.sourceId??randomUUID(),workspaceId:w,entityId:e,provider:p,appId:input.appId,identity:verified.identity,...(verified.botId?{botId:verified.botId}:{}),...(verified.eventTenantId?{eventTenantId:verified.eventTenantId}:{}),revision:(old?.revision??0)+1,authRevision:(old?.authRevision??0)+1,stateVersion:old?.stateVersion??0,status:!enabled?'disabled':verified.botId&&verified.eventTenantId?'verified':'pending_verification',enabled,identityEvidence:verified.botId&&verified.eventTenantId?'provider_api':'app_credentials_only',inboundVerified:false,directoryStatus:verified.directoryStatus,...(verified.validation?{validation:verified.validation}:{}),lastError:null,credential:{ciphertext:'',nonce:'',tag:''},...(preserve&&old.previousInstallation?{previousInstallation:old.previousInstallation}:preserve&&old.botId&&old.eventTenantId?{previousInstallation:{botId:old.botId,tenantId:old.eventTenantId}}:{}),context:preserve?(old.context??{historyEnabled:false,meetingRefs:[]}):defaultContext(p),createdBy:old?.createdBy??actor,updatedBy:actor};
  if(preserve&&old.robotCode)r.robotCode=old.robotCode;
  if(p==='dingtalk'){
   r.status=enabled?'pending_verification':'disabled';
   // Revalidation keeps the application robot, not a private/group account alias.
   delete r.botId;delete r.previousInstallation;
   if(preserve&&old.robotCode){r.botId=old.robotCode;if(old.eventTenantId)r.previousInstallation={botId:old.robotCode,tenantId:old.eventTenantId};}
   if(preserve&&old.eventTenantId)r.eventTenantId=old.eventTenantId;
  }
  r.credential=this.vault.seal(JSON.stringify(secret),this.scope(r));this.write(r,old,actor,changed?'source_replaced':old?'credentials_revalidated':'connection_created');return this.dto(r,true);
 }
 async revalidate(w:string,e:string,p:DirectoryProvider,actor:string,expectedRevision?:number){
  const r=this.require(w,e,p);if(expectedRevision!==undefined&&r.revision!==expectedRevision)fail(409,'channel_configuration_changed');
  if(p!=='wecom')return this.save(w,e,p,actor,{appId:r.appId,...this.secret(r),expectedRevision:r.revision});
  if(!usesWeComBotSearch(r))fail(409,'wecom_bot_reconfiguration_required');
  // Keep this bot source and its saved policy; fence the prior session evidence.
  const secret=this.secret(r),{verification:_verification,wecomContactIdentityRevision:_contacts,wecomVerifiedContactIds:_contactIds,wecomContactMappings:_contactMappings,wecomMemberChallenges:_memberChallenges,...base}=r;
  const next:EmployeeChannelRecord={...base,revision:r.revision+1,authRevision:r.authRevision+1,status:r.enabled?'pending_verification':'disabled',inboundVerified:false,lastError:null,updatedBy:actor};
  next.credential=this.vault.seal(JSON.stringify(secret),this.scope(next));
  this.write(next,r,actor,'wecom_robot_revalidation_started');return this.dto(next,true);
 }
 settings(w:string,e:string,p:DirectoryProvider,actor:string,input:{enabled:boolean;expectedRevision:number;historyEnabled?:boolean;groupListenEnabled?:boolean;groupTriggerKeywords?:string[];meetingRefs?:{kind:'minutes';externalId:string}[]}){const old=this.require(w,e,p);if(input.expectedRevision!==old.revision)fail(409,'channel_configuration_changed');if(typeof input.enabled!=='boolean')fail(400,'invalid_channel_settings');if(input.groupListenEnabled!==undefined&&typeof input.groupListenEnabled!=='boolean'||input.historyEnabled!==undefined&&typeof input.historyEnabled!=='boolean'||input.meetingRefs!==undefined&&(!Array.isArray(input.meetingRefs)||input.meetingRefs.length>20||input.meetingRefs.some(ref=>!ref||ref.kind!=='minutes'||!validId(ref.externalId)||Object.keys(ref).some(k=>!['kind','externalId'].includes(k)))))fail(400,'invalid_channel_context_settings');if(p!=='feishu'&&(input.groupListenEnabled===true||input.historyEnabled===true||(input.meetingRefs?.length??0)>0))fail(400,'channel_context_unsupported');if(input.groupTriggerKeywords!==undefined&&(!Array.isArray(input.groupTriggerKeywords)||input.groupTriggerKeywords.length>20||input.groupTriggerKeywords.some(word=>typeof word!=='string'||!word.trim()||word.trim().length>80||/[\u0000-\u001f]/.test(word))))fail(400,'invalid_group_trigger_keywords');if(p!=='feishu'&&(input.groupTriggerKeywords?.length??0)>0)fail(400,'channel_keywords_unsupported');const context={historyEnabled:false,groupTriggerKeywords:input.groupTriggerKeywords===undefined?old.context?.groupTriggerKeywords??[]:[...new Map(input.groupTriggerKeywords.map(word=>[word.trim().toLowerCase(),word.trim()])).values()],groupListenEnabled:input.groupListenEnabled??old.context?.groupListenEnabled??false,listenGeneration:(old.context?.listenGeneration??0)+(input.groupListenEnabled!==undefined&&input.groupListenEnabled!==!!old.context?.groupListenEnabled?1:0),meetingRefs:input.meetingRefs??old.context?.meetingRefs??[]};const enabling=input.enabled&&!old.enabled;const r={...old,context,enabled:input.enabled,status:!input.enabled?'disabled' as const:enabling?'invalid' as const:old.status,revision:old.revision+1,lastError:enabling?'revalidation_required':old.lastError,updatedBy:actor};this.write(r,old,actor,input.enabled?'revalidation_required':'disabled');return this.dto(r,true);}
 private bindingVersion(r:EmployeeChannelRecord){return createHash('sha256').update(JSON.stringify([r.sourceId,r.provider,r.appId,r.botId,r.eventTenantId,...(r.provider==='wecom'?[r.authRevision]:[])])).digest('hex');}
 currentBindingVersion(id:string){const r=this.repository.byId(id);if(!r||!r.enabled||r.status!=='verified'||!canonicalBot(r)||r.provider==='wecom'&&r.identity.tenantIdNamespace!=='app_id')return undefined;return this.bindingVersion(r);}
 /** Called under the active ingress owner fence. Keep the configuration revision
  * unchanged so the same authenticated runner can admit this message and reply. */
 observeFirstInbound(id:string,candidate:ChannelIngressCandidate):void{
  const old=this.repository.byId(id)??fail(404,'channel_connection_not_found');
  if(!old.enabled||old.status!=='pending_verification'||candidate.appId!==old.appId||
     !validId(candidate.botId)||!validId(candidate.tenantId))
   fail(403,'channel_verification_invalid');
  const expectedBot=old.botId??old.previousInstallation?.botId;
  const expectedTenant=old.eventTenantId??old.previousInstallation?.tenantId;
  if(expectedBot&&candidate.botId!==expectedBot||expectedTenant&&candidate.tenantId!==expectedTenant||
     old.robotCode&&candidate.robotCode!==old.robotCode)
   fail(403,'channel_verification_identity_conflict');
  if(old.provider==='feishu'){
   // The current credentials must already have established bot.open_id through
   // bot/v3/info. A live event can fill only the missing tenant_key.
   if(!old.botId||old.eventTenantId!==undefined||candidate.tenantNamespace!=='tenant_key'||
      old.identity.appId!==old.appId||!['display_id','tenant_key'].includes(old.identity.tenantIdNamespace))
    fail(403,'channel_verification_invalid');
   if(old.identity.tenantIdNamespace==='tenant_key'&&old.identity.tenantId!==candidate.tenantId||
      old.previousInstallation&&(old.previousInstallation.botId!==candidate.botId||old.previousInstallation.tenantId!==candidate.tenantId))
    fail(403,'channel_verification_identity_conflict');
  }else if(old.provider==='dingtalk'){
   if(candidate.tenantNamespace!=='corp_id'||!validId(candidate.robotCode)||candidate.botId!==candidate.robotCode||
      old.identity.tenantIdNamespace==='corp_id'&&old.identity.tenantId!==candidate.tenantId)
    fail(403,'channel_verification_invalid');
  }else if(candidate.botId!==old.appId||
    (candidate.tenantNamespace!=='app_id'||candidate.tenantId!==old.appId)){
   fail(403,'channel_verification_invalid');
  }
  const {verification:_verification,previousInstallation:_previous,...base}=old;
  const next:EmployeeChannelRecord={...base,botId:candidate.botId,eventTenantId:candidate.tenantId,
   ...(candidate.robotCode?{robotCode:candidate.robotCode}:{}),status:'verified',inboundVerified:true,
   identityEvidence:'authenticated_first_message',lastError:null};
  this.repository.store.transaction(()=>{
   if(!this.repository.save(next,old))fail(409,'channel_configuration_changed');
   this.repository.audit(next,'authenticated-ingress','first_inbound_confirmed',this.now());
  });
 }
 observeWeComContact(id:string,userId:string):void{
  const current=this.repository.byId(id);
  if(!current||current.status!=='verified'||!usesWeComBotSearch(current)||weComSearchIdentityVerified(current,userId)||
     !this.botContacts.selectable(current,userId)||weComSearchUserId(current,userId)!==undefined)return;
  const verified=current.wecomContactIdentityRevision===current.authRevision?current.wecomVerifiedContactIds??[]:[];
  if(weComVerifiedUserIds(current).length>=500)return;
  const next={...current,wecomContactIdentityRevision:current.authRevision,wecomVerifiedContactIds:[...verified,userId]};
  if(!this.repository.save(next,current))fail(409,'channel_configuration_changed');
 }
 private botSearch(r:EmployeeChannelRecord){
  const key=JSON.stringify([r.sourceId,r.authRevision]);
  const previous=this.botSearchClients.get(r.id);
  if(previous?.key===key)return previous.client;
  const client=new WeComBotMemberSearch({appId:r.appId,...this.secret(r),
   ...(this.options.fetch?{fetch:this.options.fetch}:{}),now:this.now});
  if(this.botSearchClients.size>=256)this.botSearchClients.delete(this.botSearchClients.keys().next().value!);
  this.botSearchClients.set(r.id,{key,client});
  return client;
 }
 async searchWeComMembers(w:string,e:string,input:unknown){
  const r=this.require(w,e,'wecom');
  this.current(r);
  if(!usesWeComBotSearch(r))fail(400,'channel_member_search_unsupported');
  if(!Array.isArray(input)||input.length===0||input.length>10||
     input.some(v=>typeof v!=='string'||!v.trim()||v.length>64||/[\x00-\x1f\x7f]/.test(v)))
   fail(400,'invalid_member_search_keywords');
  const keywords=[...new Set((input as string[]).map(k=>k.trim()))];
  let result;
  try{result=await this.botSearch(r).search(keywords);}
  catch(error){
   if(error instanceof DirectoryRequestError&&error.details.reason==='timeout')throw new EmployeeChannelError(504,'channel_member_search_timeout');
   throw new EmployeeChannelError(502,safe(error));
  }
  this.repository.store.transaction(()=>{
   const current=this.current(r);
   if(current.sourceId!==r.sourceId||current.authRevision!==r.authRevision)fail(409,'channel_configuration_changed');
   this.botContacts.remember(current,result.members);
  });
  return {sourceId:r.sourceId,provider:r.provider,appId:r.appId,exhausted:true,limited:result.limited,
   items:result.members.map(member=>({kind:'channel_user' as const,subjectId:channelSubject('channel_user',member.id,'user_id',r.appId),
    externalId:member.id,displayName:member.displayName,departmentPaths:member.departmentPaths,identityVerified:weComSearchIdentityVerified(this.current(r),member.id)}))};
 }
 memberVerificationStatus(w:string,e:string,input:{userId?:unknown;sourceId?:unknown}){
  const r=this.require(w,e,'wecom');this.current(r);
  if(!validId(input.userId)||input.sourceId!==r.sourceId)fail(400,'invalid_member_verification_request');
  return this.memberVerification.status(r,input.userId as string);
 }
 async startMemberVerification(w:string,e:string,actor:string,input:{userId?:unknown;sourceId?:unknown;requestId?:unknown;replace?:unknown}){
  const r=this.require(w,e,'wecom');this.current(r);
  if(input.replace!==undefined&&typeof input.replace!=='boolean'||!validId(input.userId)||input.sourceId!==r.sourceId||typeof input.requestId!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.requestId))fail(400,'invalid_member_verification_request');
  const userId=input.userId as string,requestId=input.requestId as string;
  if(!this.botContacts.get(r,userId)&&!r.wecomMemberChallenges?.some(c=>c.requestId===requestId&&c.userId===userId))fail(400,'invalid_member_search_candidate');
  try{const io={ready:async(record:EmployeeChannelRecord,id:string)=>this.memberVerificationReceiver?this.memberVerificationReceiver(record,id):this.memberVerificationReady(record.id,record.sourceId,record.authRevision,id,record.stateVersion)};return await this.memberVerification.start(r,userId,requestId,actor,io,input.replace===true);}
  catch(error){if(error instanceof WeComMemberVerificationError)throw new EmployeeChannelError(error.status,error.code);throw error;}
 }
 async assertWeComPrivateRecipient(id:string,userId:string):Promise<void>{
  const r=this.repository.byId(id);
  if(!r||!usesWeComBotSearch(r))return;
  try{await this.botContacts.verifyRecipient(r,userId,this.botSearch(r));}
  catch(error){throw new EmployeeChannelError(403,safe(error));}
  this.current(r);
 }
 private current(r:EmployeeChannelRecord){const current=this.repository.byId(r.id);if(!current||current.revision!==r.revision||!current.enabled||current.status==='invalid'||current.status==='disabled')return fail(403,'channel_configuration_changed');return current;}
 private invalidate(r:EmployeeChannelRecord,error:unknown){
  if(error instanceof DirectoryError&&['authentication_failed','authorization_denied'].includes(error.code)){const current=this.repository.byId(r.id);if(current?.revision===r.revision){const next={...current,directoryStatus:'unavailable' as const,lastError:error.code,revision:current.revision+1,...(error.code==='authentication_failed'?{status:'invalid' as const}:{})};this.write(next,current,'system','authorization_invalidated');}}
 }
 async discovery(w:string,e:string,p:DirectoryProvider,input:{kind:string;parentId?:string;cursor?:string}){
  const r=this.require(w,e,p);this.current(r);if(r.provider==='wecom')fail(400,'channel_directory_unsupported');if(r.directoryStatus!=='available')fail(403,'channel_directory_unavailable');const port=this.clients(r).directory;
  try{
   if(!['departments','users'].includes(input.kind)||input.parentId!==undefined&&!validId(input.parentId))fail(400,'invalid_directory_query');
   if(!input.parentId){const scope=await port.getAuthorizedScope();const ids=input.kind==='departments'?scope.departmentIds:scope.userIds;const cursorScope=JSON.stringify([r.id,r.revision,input.kind,scope.revision]);const offset=input.cursor?Number(this.cursors.decode(cursorScope,input.cursor)):0;if(!Number.isSafeInteger(offset)||offset<0)fail(400,'invalid_directory_cursor');
    if(ids.length>1000)fail(400,'directory_scope_requires_department_query');
    // Root scope IDs are only hints; hydrate a bounded page, never all organization members.
    const root=input.kind==='departments'?(scope.entireOrganization?[p==='feishu'?'0':'1']:scope.departmentIds):[];
    const items=input.kind==='departments'?await Promise.all(root.slice(offset,offset+50).map(async id=>{const d=await port.getDepartment(id);return{kind:'department',subjectId:channelSubject('department',d.id,d.namespace,r.appId),displayName:d.displayName,externalId:d.id};})):await Promise.all(scope.userIds.slice(offset,offset+50).map(async id=>{const u=await port.getUser(id);this.current(r);this.snapshots?.rememberUsers?.(r.id,[u]);return{kind:'channel_user',subjectId:channelSubject('channel_user',u.id.id,u.id.namespace,r.appId),displayName:u.displayName,externalId:u.id.id};}));
    this.current(r);return{sourceId:r.sourceId,provider:r.provider,appId:r.appId,items,exhausted:offset+50>=ids.length,...(offset+50<ids.length?{nextCursor:this.cursors.encode(cursorScope,String(offset+50))}:{})};
   }
   const page=input.kind==='departments'?await port.listChildDepartments(input.parentId,input.cursor):await port.listDepartmentMembers(input.parentId,input.cursor);this.current(r);
   return{sourceId:r.sourceId,provider:r.provider,appId:r.appId,items:page.items.map(value=>{if('departmentIds'in value)return{kind:'channel_user',subjectId:channelSubject('channel_user',value.id.id,value.id.namespace,r.appId),displayName:value.displayName,externalId:value.id.id};return{kind:'department',subjectId:channelSubject('department',value.id,value.namespace,r.appId),displayName:value.displayName,externalId:value.id};}),...(page.nextCursor?{nextCursor:page.nextCursor}:{}),exhausted:page.exhausted};
  }catch(error){this.invalidate(r,error);if(error instanceof EmployeeChannelError)throw error;throw new EmployeeChannelError(502,safe(error));}
 }
 validateRules(w:string,e:string,value:unknown,retainedRules:readonly DirectoryAccessRule[]=[]):DirectoryAccessRule[]{if(!Array.isArray(value)||value.length>100)fail(400,'invalid_directory_access_rule');const sources=this.repository.list(w,e);return (value as any[]).map((r:any)=>{if(!r||Object.keys(r).some(k=>!['sourceId','kind','subjectId','includeDescendants','conversationKinds'].includes(k))||!['channel_user','department'].includes(r.kind)||typeof r.subjectId!=='string'||!Array.isArray(r.conversationKinds)||!r.conversationKinds.length||r.conversationKinds.some((k:string)=>!['private','group','meeting'].includes(k))||r.includeDescendants!==undefined&&typeof r.includeDescendants!=='boolean'||r.kind==='channel_user'&&r.includeDescendants)fail(400,'invalid_directory_access_rule');const source=sources.find(s=>s.sourceId===r.sourceId);if(!source)fail(400,'directory_source_not_found');let parts;try{parts=JSON.parse(r.subjectId);}catch{fail(400,'invalid_directory_subject');}if(!Array.isArray(parts)||parts.length!==4||parts[0]!==r.kind||parts[2]!==source!.appId||!validId(parts[3])||!(r.kind==='channel_user'?(source!.provider!=='feishu'?['user_id']:['open_id','user_id','union_id']):(source!.provider!=='feishu'?['department_id']:['open_department_id'])).includes(parts[1]))fail(400,'invalid_directory_subject');
   if(usesWeComBotSearch(source!)){
    if(r.kind!=='channel_user'||r.conversationKinds.includes('meeting'))fail(400,'channel_directory_rule_unsupported');
    const retained=retainedRules.some(rule=>rule.sourceId===r.sourceId&&rule.kind===r.kind&&rule.subjectId===r.subjectId&&JSON.stringify(rule.conversationKinds)===JSON.stringify(r.conversationKinds));
    if(!retained&&!this.botContacts.selectable(source!,parts[3]))fail(400,'invalid_member_search_candidate');
   }
   return{sourceId:r.sourceId,kind:r.kind,subjectId:r.subjectId,...(r.kind==='department'?{includeDescendants:r.includeDescendants===true}:{}),conversationKinds:[...new Set(r.conversationKinds)] as ('private'|'group'|'meeting')[]};});}
 /** Instant local binding guard runs even on a permission-cache hit; no directory/policy read. */
 admissionGuard(scope:ChannelAccessScope,connection:ChannelConnection):string|undefined{const r=this.repository.byId(connection.connectionId);if(scope.groupContext&&(scope.conversationKind!=='group'||!r||!scope.groupContext.conversationId||scope.groupContext.bindingVersion!==this.currentBindingVersion(connection.connectionId)))return;if(!r||r.workspaceId!==scope.workspaceId||r.entityId!==scope.entityId||connection.workspaceId!==r.workspaceId||connection.provider!==r.provider||connection.tenantId!==r.eventTenantId||connection.identity.externalId!==r.botId||scope.requesterKind!=='channel_user'||scope.requesterIdentity?.applicationId!==r.appId||!scope.requesterIdentity?.idNamespace||scope.requesterIdentity.idNamespace==='unknown'||!r.enabled||r.status!=='verified'||r.provider==='wecom'&&!usesWeComBotSearch(r)||(usesWeComBotSearch(r)?scope.requesterIdentity.idNamespace!=='user_id':r.directoryStatus!=='available'))return;return JSON.stringify([r.sourceId,r.appId,r.eventTenantId,r.revision,r.authRevision,r.wecomContactIdentityRevision,r.wecomVerifiedContactIds,r.wecomContactMappings]);}
 async validateCachedAdmission(scope:ChannelAccessScope,connection:ChannelConnection):Promise<boolean>{return !!this.admissionGuard(scope,connection);}
 beginEvaluation():DirectoryEvaluation{return{deadline:this.now()+15000,remaining:64,users:new Map(),departments:new Map()};}
 private queried<T>(evaluation:DirectoryEvaluation,map:Map<string,Promise<T>>,key:string,query:()=>Promise<T>):Promise<T>{if(this.now()>evaluation.deadline)throw new DirectoryError('limit_exceeded');const previous=map.get(key);if(previous)return previous;if(evaluation.remaining--<=0)throw new DirectoryError('limit_exceeded');const result=query();map.set(key,result);return result;}
 async matches(w:string,rule:DirectoryAccessRule,scope:ChannelAccessScope,connection:ChannelConnection,kind:'private'|'group'|'meeting',evaluation:DirectoryEvaluation=this.beginEvaluation()):Promise<boolean|'unknown'>{
  if(!rule.conversationKinds.includes(kind))return false;const r=this.repository.byId(connection.connectionId);if(!r||r.sourceId!==rule.sourceId||r.workspaceId!==w||scope.workspaceId!==w||connection.workspaceId!==w||connection.provider!==r.provider||connection.identity.externalId!==r.botId||r.entityId!==scope.entityId)return false;
  if(usesWeComBotSearch(r)){
   if(!this.admissionGuard(scope,connection))return 'unknown';
   let target:unknown;try{target=JSON.parse(rule.subjectId);}catch{return 'unknown';}
   if(rule.kind!=='channel_user'||!Array.isArray(target)||target.length!==4||target[0]!=='channel_user'||target[1]!=='user_id'||target[2]!==r.appId||typeof target[3]!=='string')return 'unknown';
   // An observed member proves only their own ID. An unresolved deny target must
   // stay unknown even when another member has established exact-ID evidence.
   if(!weComSearchIdentityVerified(r,target[3]))return 'unknown';
   return weComCallbackUserId(r,target[3])===scope.requesterId;
  }
  if(!r.enabled||r.status!=='verified'||r.directoryStatus!=='available'||scope.requesterKind!=='channel_user'||scope.requesterIdentity?.applicationId!==r.appId||connection.tenantId!==r.eventTenantId)return'unknown';
  const ns=scope.requesterIdentity?.idNamespace;if(!ns||ns==='unknown'||r.provider!=='feishu'&&ns!=='user_id')return'unknown';
  try{const parts=JSON.parse(rule.subjectId) as string[];if(parts[2]!==r.appId||rule.kind==='department'&&parts[1]!== (r.provider==='feishu'?'open_department_id':'department_id'))return false;const port=this.snapshots?this.snapshots.directory(r.id):this.clients(r).directory;const user=await this.queried(evaluation,evaluation.users,JSON.stringify([r.id,r.revision,ns,scope.requesterId]),()=>port.getUser({id:scope.requesterId,namespace:ns,...(r.provider==='feishu'&&ns!=='user_id'?{applicationId:r.appId}:{})}));if(this.now()>evaluation.deadline)return'unknown';this.current(r);if(user.status!=='active')return user.status==='inactive'?false:'unknown';
   const aliases=[user.id,...user.aliases];if(!aliases.some(id=>id.id===scope.requesterId&&id.namespace===ns&&(id.applicationId===undefined||id.applicationId===r.appId)))return'unknown';
   this.rememberSpeaker(r,ns,scope.requesterId,user);
   if(rule.kind==='channel_user')return aliases.some(id=>id.id===parts[3]&&id.namespace===parts[1]&&(id.applicationId===undefined||id.applicationId===r.appId));
   if(!user.departmentMembershipsKnown)return'unknown';if(user.departmentIds.includes(parts[3]!))return true;if(!rule.includeDescendants)return false;
   for(const id of user.departmentIds){let next:string|null=id;const seen=new Set<string>();for(let depth=0;next!==null;depth++){if(depth>=100||seen.has(next))return'unknown';seen.add(next);if(next===parts[3])return true;const departmentId:string=next;const dept=await this.queried(evaluation,evaluation.departments,JSON.stringify([r.id,r.revision,departmentId]),()=>port.getDepartment(departmentId));if(this.now()>evaluation.deadline)return'unknown';this.current(r);if(dept.parentId.status==='unknown')return'unknown';next=dept.parentId.value;}}
   return false;
  }catch(error){this.options.diagnostics?.event({stage:'authorization',phase:'point',outcome:'failure',...diagnosticFailure(error)});this.invalidate(r,error);return'unknown';}
 }
 /** Legacy DingTalk compatibility helper; public onboarding uses first inbound. */
 startVerification(w:string,e:string,p:DirectoryProvider,actor:string,input:{expectedRevision:number}){
  const old=this.require(w,e,p);
  if(p!=='dingtalk')fail(409,'channel_verification_automatic');if(old.revision!==input.expectedRevision)fail(409,'channel_configuration_changed');if(!old.enabled||old.status!=='pending_verification')fail(409,'channel_verification_not_pending');
  const challengeId=randomUUID(),verification={challengeId,challengeText:`identity-verify-${randomUUID()}`,expiresAt:this.now()+600000};
  const r={...old,verification,revision:old.revision+1,updatedBy:actor};this.write(r,old,actor,'verification_started');return{...verification,revision:r.revision};
 }
 verification(w:string,e:string,p:DirectoryProvider){const r=this.require(w,e,p),v=r.verification;if(!v||v.expiresAt<=this.now())return{status:'not_started'};return{status:v.candidate?'observed':'waiting',challengeId:v.challengeId,challengeText:v.challengeText,expiresAt:v.expiresAt,revision:r.revision,...(v.candidate?{candidateId:v.candidate.id,botId:v.candidate.botId,tenantId:v.candidate.tenantId,robotCode:v.candidate.robotCode}:{})};}
 /** Legacy server-only candidate handling. Feishu no longer accepts candidates. */
 recordVerifiedCandidate(id:string,expectedVersion:string,input:{appId:string;botId:string;tenantId:string;robotCode?:string;challengeText:string;eventId:string;messageId:string}){
  const old=this.repository.byId(id)??fail(404,'channel_connection_not_found');const v=old.verification;
  if(old.provider==='feishu'||String(old.revision)!==expectedVersion||!old.enabled||old.status==='invalid'||old.status==='disabled'||!v||v.expiresAt<=this.now()||input.appId!==old.appId||input.challengeText!==v.challengeText||!validId(input.eventId)||!validId(input.messageId)||!validId(input.botId)||!validId(input.tenantId)||(old.botId!==undefined&&old.botId!==input.botId)||input.robotCode!==undefined&&!validId(input.robotCode)||old.provider==='dingtalk'&&(!validId(input.robotCode)||input.botId!==input.robotCode))fail(403,'channel_verification_invalid');
  if(v!.candidate){if(v!.candidate.botId!==input.botId||v!.candidate.tenantId!==input.tenantId||v!.candidate.robotCode!==input.robotCode)fail(409,'channel_verification_candidate_conflict');this.repository.markVerificationEvent(old.id,input.eventId,input.messageId);return;}
  const r={...old,verification:{...v!,candidate:{id:randomUUID(),eventId:input.eventId,messageId:input.messageId,appId:input.appId,botId:input.botId,tenantId:input.tenantId,...(input.robotCode?{robotCode:input.robotCode}:{})}}};this.write(r,old,'authenticated-ingress','verification_candidate_observed');
 }
 confirmVerification(w:string,e:string,p:DirectoryProvider,actor:string,input:{expectedRevision:number;candidateId:string}){
  if(p!=='dingtalk')fail(409,'channel_verification_automatic');
  const old=this.require(w,e,p),v=old.verification,c=v?.candidate;if(old.revision!==input.expectedRevision)fail(409,'channel_configuration_changed');if(!old.enabled||old.status==='invalid'||old.status==='disabled'||!v||v.expiresAt<=this.now()||!c||c.id!==input.candidateId)fail(409,'channel_verification_required');
  if(p==='dingtalk'&&old.robotCode&&c!.robotCode&&old.robotCode!==c!.robotCode)fail(409,'channel_unbind_required');
  const {verification:_verification,previousInstallation:_previous,...base}=old;const moved=!!old.previousInstallation&&(old.previousInstallation.botId!==c!.botId||old.previousInstallation.tenantId!==c!.tenantId);const r:EmployeeChannelRecord={...base,...(moved?{sourceId:randomUUID(),context:{historyEnabled:false,meetingRefs:[]}}:{}),botId:c!.botId,eventTenantId:c!.tenantId,...(c!.robotCode?{robotCode:c!.robotCode}:{}),revision:old.revision+1,status:'verified',identityEvidence:'authenticated_event_confirmed',inboundVerified:true,lastError:null,updatedBy:actor};this.write(r,old,actor,'verification_confirmed');return this.dto(r,true);
 }
 isVerificationEvent(id:string,eventId:string,messageId?:string){return this.repository.verificationEvent(id,eventId,messageId);}
 getVerificationIngress(id:string){const r=this.repository.byId(id),v=r?.verification;if(!r||!r.enabled||r.status==='invalid'||r.status==='disabled'||!v||v.expiresAt<=this.now())return undefined;return{provider:r.provider,bindingVersion:String(r.revision),appId:r.appId,...(r.botId?{botId:r.botId}:{}),challengeText:v.challengeText,expiresAt:v.expiresAt};}
 assertAssetSource(scope:import('../assets/service.js').AssetSourceScope){const r=this.repository.byId(scope.connectionId);if(!r||r.provider!==scope.provider||!r.enabled||r.status!=='verified'||r.workspaceId!==scope.workspaceId||r.entityId!==scope.entityId||r.appId!==scope.applicationId||(r.eventTenantId??r.identity.tenantId)!==scope.tenantId||this.currentBindingVersion(r.id)!==scope.bindingVersion)fail(403,'asset_source_binding_changed');}
 /** Server-only OAuth exchange dependency. Never serialize or pass to an execution Runtime. */
 businessOAuthApplication(scope:import('../assets/service.js').AssetSourceScope){this.assertAssetSource(scope);if(scope.provider!=='feishu'||scope.requesterNamespace!=='open_id'||!scope.requesterId)fail(403,'business_oauth_identity_unsupported');const r=this.repository.byId(scope.connectionId)!;return{applicationId:r.appId,clientSecret:this.secret(r).appSecret};}
 /** Runtime-only application identity. A token proves no resource ACL and never enters a DTO or task material. */
 async businessResourceApplication(scope:import('../assets/service.js').AssetSourceScope){
  this.assertAssetSource(scope);
  if(!['feishu','dingtalk'].includes(scope.provider)||!scope.requesterId||scope.requesterNamespace!==(scope.provider==='feishu'?'open_id':'user_id'))fail(403,'business_application_identity_unsupported');
  const before=this.repository.byId(scope.connectionId)!,accessToken=await this.assetAccessToken(scope);
  this.assertAssetSource(scope);const current=this.repository.byId(scope.connectionId)!;
  if(current.authRevision!==before.authRevision||current.sourceId!==before.sourceId)fail(403,'business_application_credentials_changed');
  const accountId=JSON.stringify(['application',current.provider,scope.tenantId,current.appId]);
  const authorizationRevision=createHash('sha256').update(JSON.stringify([accountId,current.id,current.sourceId,current.authRevision,scope.bindingVersion])).digest('hex');
  return{accountId,authorizationRevision,expiresAt:this.now()+60000,accessToken};
 }
 assetRobotCode(scope:import('../assets/service.js').AssetSourceScope){this.assertAssetSource(scope);const r=this.repository.byId(scope.connectionId)!;if(!r.robotCode)fail(403,'channel_robot_identity_unavailable');return r.robotCode!;}
 async assetAccessToken(scope:import('../assets/service.js').AssetSourceScope){this.assertAssetSource(scope);const r=this.repository.byId(scope.connectionId)!;const transport=this.clients(r).transport;if(!transport)fail(403,'channel_token_unsupported');const token=await transport!.accessToken();this.assertAssetSource(scope);return token;}
 async resolveBinding(id:string):Promise<ResolvedEmployeeChannelBinding|undefined>{return this.binding(id);}
 async resolveHistoryBinding(id:string):Promise<ResolvedEmployeeChannelBinding|undefined>{return this.binding(id,true);}
 private async binding(id:string,history=false):Promise<ResolvedEmployeeChannelBinding|undefined>{const r=this.repository.byId(id);if(!r||!r.enabled||!r.botId||r.status!=='verified'||!this.currentBindingVersion(id))return undefined;const transport=r.provider==='wecom'?undefined:this.clients(r).transport,connection:ChannelConnection={workspaceId:r.workspaceId,connectionId:r.id,provider:r.provider,tenantId:r.eventTenantId??r.identity.tenantId,identity:{kind:'bot',externalId:r.botId},credentialRef:`employee-channel:${r.id}:${r.authRevision}`};
  const resolveCredential=async(_c:ChannelConnection,purpose:'access_token'|'webhook_encrypt_key'|'webhook_verification_token'|'webhook_app_secret')=>{this.current(r);if(purpose==='access_token')return transport?transport.accessToken():fail(403,'channel_token_unsupported');return fail(403,'channel_http_ingress_disabled');};
  const options={resolveCredential,...(this.options.diagnostics?{diagnostics:this.options.diagnostics}:{}),...(this.options.fetch?{fetch:this.options.fetch}:{}),...(this.options.now?{now:this.options.now}:{})};
  const conversation=r.provider==='wecom'?new WeComConversationAdapter(connection,{send:async (request:SendChannelMessage)=>{this.current(r);if(!this.sessionSender)fail(503,'channel_transport_not_ready');return this.sessionSender!(r.id,request);}}):r.provider==='feishu'?new FeishuConversationAdapter(connection,{...options,appId:r.appId,expectedTenantNamespace:r.eventTenantId?'tenant_key':r.identity.tenantIdNamespace,grants:{mentionEvents:true,ordinaryMessageEvents:groupMessagePermission(r)==='granted',privateMessageEvents:true,proactiveSend:true,replyToMessage:true,historyRead:history&&groupHistoryPermission(r)}}):new DingTalkBotConversationAdapter(connection,{...options,appId:r.appId,robotCode:r.robotCode!,mentionEventsGranted:true,privateMessageEventsGranted:true,proactiveSendGranted:true,streamIngress:true});
  return{connectionId:r.id,workspaceId:r.workspaceId,entityId:r.entityId,provider:r.provider,appId:r.appId,bindingVersion:r.status==='verified'?this.bindingVersion(r):String(r.revision),enabled:true,identity:r.identity,connection,conversation,...(r.provider==='feishu'?{meetingArtifacts:new FeishuMinutesAdapter(connection,{...options,appId:r.appId,grants:{transcriptRead:(r.context?.meetingRefs.length??0)>0,officialSummaryRead:(r.context?.meetingRefs.length??0)>0}})}:{}),policy:{entityMentionId:r.botId,ownSenderIds:r.provider==='dingtalk'?[]:[r.botId],...(r.provider==='feishu'?{groupTriggerKeywords:r.context?.groupTriggerKeywords??[]}:{})},context:{historyEnabled:false,groupListenEnabled:r.context?.groupListenEnabled===true,listenGeneration:r.context?.listenGeneration??0,meetingRefs:(r.context?.meetingRefs??[]).map(ref=>({provider:r.provider,connectionId:r.id,tenantId:r.eventTenantId??r.identity.tenantId,kind:ref.kind,externalId:ref.externalId}))}};
 }
 private async saveWecom(w:string,e:string,actor:string,input:{appId:string;appSecret:string;expectedRevision?:number;replaceSource?:boolean}){
  this.entity(w,e);if(!this.vault.available)fail(503,'channel_secret_key_unconfigured');if(!validId(input.appId)||typeof input.appSecret!=='string'||!input.appSecret.trim()||input.appSecret.length>8192||/[\r\n\0]/.test(input.appSecret))fail(400,'invalid_channel_credentials');
  const old=this.repository.byProvider(w,e,'wecom');if((old?.revision??0)!==(input.expectedRevision??0))fail(409,'channel_configuration_changed');
  try{this.repository.assertAvailable({provider:'wecom',appId:input.appId,...(old?{id:old.id}:{})});}catch(error){if(error instanceof ChannelBindingConflict)fail(409,'channel_connection_conflict');throw error;}
  const changed=!!old&&(old.appId!==input.appId||!usesWeComBotSearch(old));if(changed&&!input.replaceSource)fail(409,'channel_unbind_required');const enabled=old&&!changed?old.enabled:true;
  const next:EmployeeChannelRecord={id:old?.id??randomUUID(),sourceId:changed?randomUUID():old?.sourceId??randomUUID(),workspaceId:w,entityId:e,provider:'wecom',appId:input.appId,botId:input.appId,identity:{appId:input.appId,tenantId:input.appId,tenantIdNamespace:'app_id'},revision:(old?.revision??0)+1,authRevision:(old?.authRevision??0)+1,stateVersion:old?.stateVersion??0,status:enabled?'pending_verification':'disabled',enabled,identityEvidence:'app_credentials_only',inboundVerified:false,directoryStatus:'unavailable',validation:wecomBotValidation(this.now),lastError:null,credential:{ciphertext:'',nonce:'',tag:''},context:old&&!changed?(old.context??defaultContext('wecom')):defaultContext('wecom'),createdBy:old?.createdBy??actor,updatedBy:actor};
  next.credential=this.vault.seal(JSON.stringify({appSecret:input.appSecret}),this.scope(next));this.write(next,old,actor,changed?'source_replaced':'wecom_robot_credentials_saved');return this.dto(next,true);
 }

 /** Optional readable metadata; the caller must still authorize the invocation separately. */
 private async describeActorLegacy(binding:ResolvedEmployeeChannelBinding,actor:ChannelActor):Promise<ChannelSpeakerProfile>{
  const r=this.repository.byId(binding.connectionId),ns=actor.idNamespace;
  if(!r||r.workspaceId!==binding.workspaceId||r.entityId!==binding.entityId||r.appId!==binding.appId||r.provider!==binding.provider||binding.connection.tenantId!==r.eventTenantId||actor.applicationId!==r.appId||actor.kind!=='human'||actor.identityEvidence!=='channel_verified'||!actor.externalId||!ns||ns==='unknown'||r.provider!=='feishu'&&ns!=='user_id')return{};
  const current=()=>this.repository.byId(r.id)?.revision===r.revision&&this.currentBindingVersion(r.id)===binding.bindingVersion;
  if(!current()||r.directoryStatus!=='available')return{};
  const deadline=Date.now()+3000;
  const bounded=async<T>(work:Promise<T>):Promise<T>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new DirectoryError('unavailable')),Math.max(0,deadline-Date.now()));})]);}finally{if(timer)clearTimeout(timer);}};
  let profile:ChannelSpeakerProfile={};
  try{
   const port=this.clients(r).directory,cached=this.speakerUsers.get(this.speakerKey(r,ns,actor.externalId));
   const user=cached&&cached.expiresAt>this.now()?cached.user:await bounded(port.getUser({id:actor.externalId,namespace:ns,...(r.provider==='feishu'&&ns!=='user_id'?{applicationId:r.appId}:{})}));
   if(!current()||user.status!=='active'||![user.id,...user.aliases].some(id=>id.id===actor.externalId&&id.namespace===ns&&(ns==='user_id'||id.applicationId===r.appId)))return{};
   this.rememberSpeaker(r,ns,actor.externalId,user);
   profile={...(user.displayName.trim()?{displayName:user.displayName}:{}),...(user.jobTitle?.trim()?{jobTitle:user.jobTitle}:{})};
   const ids=user.primaryDepartmentId.status==='known'&&user.primaryDepartmentId.value?[user.primaryDepartmentId.value]:user.departmentMembershipsKnown?[...new Set(user.departmentIds)].slice(0,4):[];
   const departments=await bounded(Promise.all(ids.map(async id=>{try{const department=await port.getDepartment(id);return department.id===id?department.displayName:undefined;}catch{return undefined;}})));
   const names=departments.filter((name):name is string=>typeof name==='string'&&!!name.trim());if(names.length)profile={...profile,departmentNames:names};
  }catch{ /* Optional metadata failure must not change the separate authorization decision. */ }
  return current()?profile:{};
 }
 async describeActor(binding:ResolvedEmployeeChannelBinding,actor:ChannelActor):Promise<ChannelSpeakerProfile>{
  const r=this.repository.byId(binding.connectionId),ns=actor.idNamespace;
  if(r&&usesWeComBotSearch(r)){
   if(!weComSearchUserId(r,actor.externalId??'')||ns!=='user_id'||actor.applicationId!==r.appId||
      actor.kind!=='human'||actor.identityEvidence!=='channel_verified'||!actor.externalId||
      binding.bindingVersion!==this.currentBindingVersion(r.id)||binding.workspaceId!==r.workspaceId||
      binding.entityId!==r.entityId||binding.connection.tenantId!==r.eventTenantId)return {};
   const member=this.botContacts.get(r,weComSearchUserId(r,actor.externalId)!);
   return member?{displayName:member.display_name}:{};
  }
  if(!this.snapshots)return this.describeActorLegacy(binding,actor);if(!r||!ns||ns==='unknown'||!actor.externalId||actor.applicationId!==r.appId||r.workspaceId!==binding.workspaceId||r.entityId!==binding.entityId||r.provider!==binding.provider||binding.connection.tenantId!==r.eventTenantId||this.currentBindingVersion(r.id)!==binding.bindingVersion||actor.kind!=='human'||actor.identityEvidence!=='channel_verified')return{};
  const id={id:actor.externalId,namespace:ns,...(r.provider==='feishu'&&ns!=='user_id'?{applicationId:r.appId}:{})};
  const snapshots=this.snapshots;
  const user=snapshots?.peekUser(r.id,id)??this.speakerUsers.get(this.speakerKey(r,ns,actor.externalId))?.user;
  if(!user){snapshots?.requestUser(r.id,id);return{};}
  if(user.status!=='active')return{};
  const ids=user.primaryDepartmentId.status==='known'&&user.primaryDepartmentId.value?[user.primaryDepartmentId.value]:user.departmentMembershipsKnown?[...new Set(user.departmentIds)].slice(0,4):[];
  const names:string[]=[];for(const departmentId of ids){const department=snapshots?.peekDepartment(r.id,departmentId);if(department?.displayName.trim())names.push(department.displayName);else snapshots?.requestDepartment(r.id,departmentId);}
  return{...(user.displayName.trim()?{displayName:user.displayName}:{}),...(user.jobTitle?.trim()?{jobTitle:user.jobTitle}:{}),...(names.length?{departmentNames:names}:{})};
 }
 async authorizeInvocation(binding:ResolvedEmployeeChannelBinding,actor:ChannelActor,kind:'private'|'group'|'meeting',source?:TaskScope['source']):Promise<void>{if(source&&(source.connectionId!==binding.connectionId||source.applicationId!==binding.appId||source.tenantId!==binding.connection.tenantId||source.channelType!==binding.provider||source.bindingVersion!==binding.bindingVersion||source.conversationKind!==kind||!source.conversationId))fail(403,'channel_use_forbidden');if(this.currentBindingVersion(binding.connectionId)!==binding.bindingVersion||actor.kind!=='human'||actor.identityEvidence!=='channel_verified'||!actor.externalId||actor.applicationId!==binding.appId||!actor.idNamespace||actor.idNamespace==='unknown'||!this.accessCheck)fail(403,'channel_use_forbidden');const scope:ChannelAccessScope={workspaceId:binding.workspaceId,entityId:binding.entityId,requesterId:actor.externalId!,requesterKind:'channel_user',requesterIdentity:{idNamespace:actor.idNamespace!,applicationId:binding.appId},conversationKind:kind,...(source&&kind==='group'?{groupContext:{conversationId:source.conversationId,bindingVersion:source.bindingVersion}}:{})};if(!await this.accessCheck!(scope,binding.connection,kind)||this.currentBindingVersion(binding.connectionId)!==binding.bindingVersion)fail(403,'channel_use_forbidden');}
}
