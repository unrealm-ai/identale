import {ChannelError,type MeetingArtifactsPort} from '@dentity/application';
import {FeishuAssetTransport} from '../assets/feishu.js';
import type {AssetSourceScope} from '../assets/service.js';
import type {BusinessResourceReader,ResourceAuthorizationRequest,ResourceGrant} from './authorization.js';
/** Trusted factories must select the exact independently authorized account, not the IM application's identity.
 * The returned token/CLI adapter remains in the runtime process and is never included in task materials. */
export interface BusinessReaderAccounts {
 feishu?:{accessToken:(request:ResourceAuthorizationRequest,grant:ResourceGrant)=>Promise<string>;assertAccount:(request:ResourceAuthorizationRequest,grant:ResourceGrant)=>void|Promise<void>;fetch?:typeof fetch};
 /** Factory must verify the pinned CLI release, isolated profile and delegated account; no automatic login. */
 dingtalkMinutes?:(request:ResourceAuthorizationRequest,grant:ResourceGrant)=>Promise<MeetingArtifactsPort>;
}
export class ApprovedBusinessResourceReader implements BusinessResourceReader {
 constructor(private readonly accounts:BusinessReaderAccounts){}
 async read(request:ResourceAuthorizationRequest,grant:ResourceGrant,descriptor:Parameters<BusinessResourceReader['read']>[2],authorizeDerived:Parameters<BusinessResourceReader['read']>[3],alternative=false):ReturnType<BusinessResourceReader['read']>{
  const unavailable=(reason:string)=>({state:'not_available' as const,reason});
  if(request.source.provider==='feishu'){
   const account=this.accounts.feishu;if(!account)return{state:'no_permission',reason:'business_account_authorization_required'};
   const transport=new FeishuAssetTransport({accessToken:()=>account.accessToken(request,grant),assertSource:(_scope:AssetSourceScope)=>account.assertAccount(request,grant),authorizeDerived,...(account.fetch?{fetch:account.fetch}:{})});
   // The stream extraction fallback is performed inside this reader, never via an unguarded IM transport.
   return alternative?transport.readAlternative(request.source,descriptor,request.operation):transport.read(request.source,descriptor,request.operation);
  }
  if(request.source.provider==='dingtalk'&&request.resource.kind==='minutes'){
   const factory=this.accounts.dingtalkMinutes;if(!factory)return{state:'no_permission',reason:'business_account_authorization_required'};
   try{const adapter=await factory(request,grant),connection=adapter.connection;
    if(connection.provider!=='dingtalk'||connection.connectionId!==request.source.connectionId||connection.tenantId!==request.source.tenantId||connection.identity.kind!=='delegated_user'||connection.identity.externalId!==grant.accountId)return{state:'no_permission',reason:'business_account_identity_mismatch'};
    const ref={provider:'dingtalk' as const,connectionId:connection.connectionId,tenantId:connection.tenantId,externalId:request.resource.externalId};
    if(request.operation!=='transcript'){const result=await adapter.readSummary({...ref,kind:'summary'});return new Response(result.text,{headers:{'content-type':'text/markdown'}});}
    let cursor:string|undefined;const seen=new Set<string>(),texts:string[]=[];let size=0;
    for(let page=0;page<100;page++){if(!await authorizeDerived(request.resource))return{state:'no_permission',reason:'business_resource_authorization_required'};const result=await adapter.readTranscript({...ref,kind:'transcript'},cursor?{cursor}:{});
     for(const item of result.items){size+=Buffer.byteLength(item.text);if(size>25*1024*1024)return unavailable('business_resource_size_limit');texts.push(item.text);}
     if(result.exhausted)return new Response(texts.join('\n'),{headers:{'content-type':'text/plain'}});
     if(!result.nextCursor||seen.has(result.nextCursor))return unavailable('business_resource_partial_material');cursor=result.nextCursor;seen.add(cursor);
    }return unavailable('business_resource_page_limit');
   }catch(error){return{state:error instanceof ChannelError&&['forbidden','unauthenticated'].includes(error.code)?'no_permission':'not_available',reason:'business_resource_read_unavailable'};}
  }
  return unavailable(request.source.provider==='wecom'?'wecom_cli_schema_unverified':'business_resource_reader_unverified');
 }
}
