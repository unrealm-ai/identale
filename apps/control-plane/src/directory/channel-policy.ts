import type {ChannelAccessPolicy} from '@dentity/application';
import type {CapabilityConfigService} from '../capability-config.js';
/** Intersects host-owned resource/connection ACL with current platform usage rules.
 * Caller identity still comes from the authenticated channel adapter, never directory lookup.
 */
export function withDirectoryAccessPolicy(host:ChannelAccessPolicy,capabilities:CapabilityConfigService):ChannelAccessPolicy {
  return{async authorize(scope,connection,operation,resource){
    if(!await host.authorize(scope,connection,operation,resource))return false;
    try{
      if(scope.requesterKind==='channel_user'){
        const kind=scope.conversationKind;if(!kind||!scope.requesterIdentity)return false;
        if(resource&&resource.kind!=='conversation'&&kind!=='meeting')return false;
        return capabilities.authorizeChannel(scope,connection,kind);
      }
      if(scope.requesterKind==='platform_user'){
        capabilities.authorizeEntity({workspaceId:scope.workspaceId,entityId:scope.entityId,userId:scope.requesterId});return true;
      }
      // Host policy is the explicit authorization boundary for configured system events.
      return scope.requesterKind==='system';
    }catch{return false;}
  }};
}
