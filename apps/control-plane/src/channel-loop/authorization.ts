import {TaskError,scopeActorKey,type TaskScope,type TaskAuthorizationPort,type ChannelActor} from '@dentity/application';
import type {Store} from '../store.js';
import {CapabilityConfigService,CapabilityConfigError,executionCapabilityResources,type CapabilitySnapshot} from '../capability-config.js';
import type {EmployeeChannelService} from '../employee-channels/service.js';
import {nullDiagnostics,type DiagnosticPort} from '@dentity/application';

/** Input admission, local association checks and new execution snapshots are separate boundaries. */
export class ChannelTaskAuthorization implements TaskAuthorizationPort {
 private assignments:{authorize:(s:TaskScope)=>void;snapshot:(s:TaskScope)=>CapabilitySnapshot}|undefined;
 setAssignments(value:NonNullable<ChannelTaskAuthorization['assignments']>){this.assignments=value;}
 private assignment(s:TaskScope){if(!this.assignments)throw new TaskError(403,'work_item_grant_unavailable');this.assignments.authorize(s);return this.assignments;}
 private readonly receipts=new Map<string,{expiresAt:number;version:string;policyRevision:number}>();
 private readonly refreshing=new Map<string,Promise<void>>();
 constructor(private readonly store:Store,private readonly web:CapabilityConfigService,private readonly connections:EmployeeChannelService,private readonly now:()=>number,private readonly diagnostics:DiagnosticPort=nullDiagnostics,private readonly sharing?:import('../group-sharing/configuration.js').GroupSharingConfiguration){}
 private key(s:TaskScope){return JSON.stringify([s.workspaceId,s.entityId,scopeActorKey(s),s.source?.bindingVersion,s.source?.conversationKind,s.source?.conversationId,s.source?.threadId,s.source?.sourceEventId]);}
 private packageVersion(s:TaskScope){return JSON.stringify(this.web.list(s.workspaceId,s.entityId).map(p=>[p.id,p.version]));}
 actor(s:TaskScope):ChannelActor {if(!s.principal||!s.source)throw new TaskError(403,'channel_identity_required');return{externalId:s.principal.externalUserId,idNamespace:s.principal.identityNamespace as NonNullable<ChannelActor['idNamespace']>,applicationId:s.source.applicationId,kind:'human',identityEvidence:'channel_verified'};}
 authorizeLocal(s:TaskScope){
  if(s.assignment){this.assignment(s);return;}
  if(s.business){if(!this.store.one("SELECT b.id FROM trigger_bindings b JOIN entities e ON e.id=b.entity_id JOIN workspaces w ON w.id=b.workspace_id WHERE b.id=? AND b.workspace_id=? AND b.entity_id=? AND w.status='active'",s.business.triggerId,s.workspaceId,s.entityId))throw new TaskError(403,'trigger_binding_changed');return;}
  if(!s.source)return this.web.authorizeLocal(s);
  if(!s.principal||s.principal.channelType!==s.source.channelType||s.principal.tenantId!==s.source.tenantId||!s.principal.externalUserId||(!s.principal.identityNamespace||s.principal.identityNamespace==='unknown')||!s.source.applicationId||!s.source.connectionId||!s.source.conversationId||!this.store.one("SELECT e.id FROM entities e JOIN workspaces w ON w.id=e.workspace_id WHERE e.id=? AND e.workspace_id=? AND w.status='active'",s.entityId,s.workspaceId))throw new TaskError(403,'channel_identity_required');
 }
 private async binding(s:TaskScope&{source:NonNullable<TaskScope['source']>}){
  this.authorizeLocal(s);const b=await this.connections.resolveBinding(s.source.connectionId);
  if(!b||b.bindingVersion!==s.source.bindingVersion||b.workspaceId!==s.workspaceId||b.entityId!==s.entityId||b.appId!==s.source.applicationId||b.connection.tenantId!==s.principal.tenantId)throw new TaskError(403,'channel_binding_changed');return b;
 }
 async refreshAuthorization(s:TaskScope){
  if(s.assignment){this.assignment(s);return;}
  if(s.business){this.authorizeLocal(s);this.web.resolveForTrigger({...s,triggerId:s.business.triggerId,bindingVersion:s.business.bindingVersion});return;}
  if(!s.source){this.web.authorizeEntity(s);return;}
  const key=this.key(s),pending=this.refreshing.get(key);if(pending)return pending;
  const refresh=this.diagnostics.span('authorization',async()=>{
   for(const [key,receipt]of this.receipts)if(receipt.expiresAt<=this.now())this.receipts.delete(key);
   const b=await this.binding(s);await this.connections.authorizeInvocation(b,this.actor(s),s.source!.conversationKind,s.source);
   if(this.connections.currentBindingVersion(b.connectionId)!==b.bindingVersion)throw new TaskError(403,'channel_binding_changed');
   this.receipts.set(key,{expiresAt:this.now()+15000,version:b.bindingVersion,policyRevision:this.web.getDirectoryAccess(s.workspaceId,s.entityId).revision});
  }).catch(error=>{this.receipts.delete(key);throw error;}).finally(()=>this.refreshing.delete(key));this.refreshing.set(key,refresh);return refresh;
 }
 assertActive(s:TaskScope){this.web.assertActive(s);}
 authorizeEntity(s:TaskScope){
  if(s.assignment){this.assignment(s);return;}
  if(s.business){this.authorizeLocal(s);return;}
  if(!s.source)return this.web.authorizeEntity(s);this.authorizeLocal(s);const receipt=this.receipts.get(this.key(s));
  if(!receipt||receipt.expiresAt<=this.now()||this.connections.currentBindingVersion(s.source.connectionId)!==receipt.version||this.web.getDirectoryAccess(s.workspaceId,s.entityId).revision!==receipt.policyRevision)throw new TaskError(403,'channel_authorization_required');
 }
 async resolveForTask(s:TaskScope){
  this.assertActive(s);this.authorizeLocal(s);if(s.assignment)return this.assignment(s).snapshot(s);if(s.business)return this.web.resolveForTrigger({...s,triggerId:s.business.triggerId,bindingVersion:s.business.bindingVersion});if(!s.source)return this.web.resolveForAdmittedTask(s);
  const b=await this.binding(s),actor=this.actor(s),version=this.packageVersion(s);
  const packages=await this.web.executionPackages({workspaceId:s.workspaceId,entityId:s.entityId,requesterKind:'channel_user',requesterId:actor.externalId!,requesterIdentity:{idNamespace:actor.idNamespace!,applicationId:actor.applicationId!},conversationKind:s.source.conversationKind},b.connection,s.source.conversationKind);
  if(version!==this.packageVersion(s)||this.connections.currentBindingVersion(b.connectionId)!==b.bindingVersion)throw new TaskError(409,'capability_configuration_changed');
  const resources=this.web.resourceSelection(s.workspaceId,packages);
  return{...(this.sharing?.snapshot(s)?{groupSharing:this.sharing.snapshot(s)}:{}),kind:'channel',workspaceId:s.workspaceId,entityId:s.entityId,principalKey:scopeActorKey(s),bindingVersion:b.bindingVersion,policy:version,packages:packages.map(p=>({id:p.id,version:p.version})),resources,...executionCapabilityResources(resources)};
 }
 validatePreparedSnapshot(s:TaskScope,snapshot:unknown){
  this.authorizeLocal(s);if(s.assignment){if(JSON.stringify(snapshot)!==JSON.stringify(this.assignment(s).snapshot(s)))throw new TaskError(409,'work_item_grant_changed');return;}if(s.business){const value=snapshot as CapabilitySnapshot,current=this.web.resolveForTrigger({...s,triggerId:s.business.triggerId,bindingVersion:s.business.bindingVersion});if(JSON.stringify(value)!==JSON.stringify(current))throw new TaskError(409,'capability_configuration_changed');return;}if(!s.source)return this.web.validatePreparedSnapshot(s,snapshot as CapabilitySnapshot);
  const value=snapshot as Awaited<ReturnType<ChannelTaskAuthorization['resolveForTask']>>;
  if(!value||!('kind'in value)||value.kind!=='channel'||value.workspaceId!==s.workspaceId||value.entityId!==s.entityId||value.principalKey!==scopeActorKey(s)||value.bindingVersion!==s.source.bindingVersion||value.policy!==this.packageVersion(s)||this.connections.currentBindingVersion(s.source.connectionId)!==value.bindingVersion)throw new TaskError(409,'capability_configuration_changed');
  if(this.sharing&&JSON.stringify(value.groupSharing)!==JSON.stringify(this.sharing.snapshot(s)))throw new TaskError(409,'sharing_rules_changed');
  const catalog=this.web.resources(s.workspaceId);for(const r of value.resources)if(JSON.stringify(catalog.find(v=>v.id===r.resource.id))!==JSON.stringify(r.resource))throw new TaskError(409,'capability_configuration_changed');
 }
 isAuthorizationError(e:unknown){return e instanceof TaskError||e instanceof CapabilityConfigError||!!(e&&typeof e==='object'&&'status'in e&&(e.status===401||e.status===403));}
}
