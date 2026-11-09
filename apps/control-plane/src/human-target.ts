import {TaskError} from '@dentity/application';
import type {EmployeeChannelService} from './employee-channels/service.js';
import {usesWeComBotSearch,weComCallbackUserId,weComSearchUserId} from './employee-channels/wecom-bot-contacts.js';
import type {CapabilityConfigService} from './capability-config.js';
import type {HumanTarget,ResolvedHumanTarget} from './human-confirmation.js';

/** Read-only, credential-scoped resolution. A search ID is never an outbound ID. */
export function resolveHumanTarget(channels:EmployeeChannelService,workspaceId:string,entityId:string,target:HumanTarget):ResolvedHumanTarget|undefined {
 const reference=target.kind==='wecom_directory'?{sourceId:target.sourceId,authRevision:target.authRevision,directoryUserId:target.directoryUserId}:target.kind==='channel'?target.directoryReference:undefined;
 if(!reference)return target.kind==='wecom_directory'?undefined:target;
 if(target.kind==='web')throw new TaskError(409,'human_recipient_configuration_changed');
 const current=channels.repository.byId(target.connectionId);
 if(!current||!usesWeComBotSearch(current)||!current.enabled||current.status!=='verified'||current.workspaceId!==workspaceId||current.entityId!==entityId||current.appId!==target.appId||target.provider!=='wecom'||target.identityNamespace!=='user_id'||current.eventTenantId!==target.tenantId||current.sourceId!==reference.sourceId||current.authRevision!==reference.authRevision)throw new TaskError(409,'human_recipient_configuration_changed');
 const callback=weComCallbackUserId(current,reference.directoryUserId),userId=callback&&weComSearchUserId(current,callback)===reference.directoryUserId?callback:undefined;
 if(!userId){if(target.kind==='channel')throw new TaskError(409,'human_recipient_configuration_changed');return;}
 if(target.kind==='channel'){if(target.userId!==userId)throw new TaskError(409,'human_recipient_configuration_changed');return target;}
 return {kind:'channel',connectionId:target.connectionId,userId,identityNamespace:'user_id',provider:'wecom',appId:target.appId,tenantId:target.tenantId,directoryReference:reference};
}

/** Recheck normal employee use after resolution and fence async authorization against rebinding. */
export async function authorizeHumanTarget(channels:EmployeeChannelService,usage:Pick<CapabilityConfigService,'authorizeEntity'|'authorizeChannel'>,workspaceId:string,entityId:string,target:HumanTarget):Promise<boolean>{
 try{
  const resolved=resolveHumanTarget(channels,workspaceId,entityId,target);if(!resolved)return false;
  if(resolved.kind==='web'){usage.authorizeEntity({workspaceId,entityId,userId:resolved.userId});return true;}
  const binding=await channels.resolveBinding(resolved.connectionId);
  if(!binding||!binding.enabled||binding.workspaceId!==workspaceId||binding.entityId!==entityId||binding.appId!==resolved.appId||binding.provider!==resolved.provider||binding.connection.tenantId!==resolved.tenantId)return false;
  if(!await usage.authorizeChannel({workspaceId,entityId,requesterKind:'channel_user',requesterId:resolved.userId,requesterIdentity:{idNamespace:resolved.identityNamespace,applicationId:resolved.appId},conversationKind:'private'},binding.connection,'private'))return false;
  return channels.currentBindingVersion(resolved.connectionId)===binding.bindingVersion&&!!resolveHumanTarget(channels,workspaceId,entityId,resolved);
 }catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='entity_use_forbidden')return false;throw error;}
}
