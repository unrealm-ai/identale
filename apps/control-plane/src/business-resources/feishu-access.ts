import {createHash} from 'node:crypto';
import type {SharedMessageAsset} from '@dentity/application';
import type {Store} from '../store.js';
import {FeishuAssetTransport} from '../assets/feishu.js';
import {AssetJsonError} from '../assets/json-text-stream.js';
import type {AssetSourceScope,AssetUnavailable} from '../assets/service.js';
import {BusinessAccountBindings,type FeishuUserTokenRegistry} from './accounts.js';
import type {BusinessResourceAccess,BusinessResourceRef,ResourceAuthorizationRequest,ResourceDecision,ResourceGrant} from './authorization.js';
export interface ScopedFeishuTokenRegistry extends FeishuUserTokenRegistry {
 resolveForRequest(request:ResourceAuthorizationRequest):ReturnType<FeishuUserTokenRegistry['resolve']>;
}
type Snapshot={bytes:Uint8Array;mediaType:string;version:string;accountId:string;revision:string;expiresAt:number;derived:BusinessResourceRef[]};
const MAX_BYTES=25*1024*1024;
/** Production user-token ACL proof and byte version share one fixed runtime snapshot, not an application-token guess.
 * Same-origin sharing follows the user's explicit instruction; it does not permit different output targets. */
export class FeishuResourceAccess implements BusinessResourceAccess {
 readonly authorization={authorize:(request:ResourceAuthorizationRequest)=>this.authorize(request)};
 readonly reader={read:(request:ResourceAuthorizationRequest,grant:ResourceGrant,_descriptor:SharedMessageAsset,authorizeDerived:(ref:BusinessResourceRef)=>Promise<boolean>)=>this.read(request,grant,authorizeDerived)};
 private readonly snapshots=new Map<string,Snapshot>();
 private snapshotBytes=0;
 constructor(private readonly store:Store,private readonly registry:ScopedFeishuTokenRegistry,private readonly options:{assertSource:(source:AssetSourceScope)=>void|Promise<void>;fetch?:typeof fetch;now?:()=>number}){}
 private now(){return(this.options.now??Date.now)();}
 private key(request:ResourceAuthorizationRequest){return JSON.stringify([request.source,request.run,request.resource,request.operation,request.audience,request.originResource]);}
 private drop(key:string){const entry=this.snapshots.get(key);if(entry){this.snapshotBytes-=entry.bytes.byteLength;this.snapshots.delete(key);}}
 private save(key:string,snapshot:Snapshot){for(const[k,v]of this.snapshots)if(v.expiresAt<=this.now())this.drop(k);this.drop(key);while(this.snapshots.size>=128||this.snapshotBytes+snapshot.bytes.byteLength>64*1024*1024){const oldest=this.snapshots.keys().next().value;if(!oldest)break;this.drop(oldest);}this.snapshots.set(key,snapshot);this.snapshotBytes+=snapshot.bytes.byteLength;}
 private async bytes(response:Response){const reader=response.body?.getReader();if(!reader)throw Error('empty_business_resource');let length=0;const chunks:Uint8Array[]=[];try{for(;;){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;if(length>MAX_BYTES){await reader.cancel();throw Error('business_resource_size_limit');}chunks.push(item.value);}}finally{reader.releaseLock();}return new Uint8Array(Buffer.concat(chunks));}
 async authorize(request:ResourceAuthorizationRequest):Promise<ResourceDecision>{
  this.drop(this.key(request));
  const denied={state:'authorization_required' as const,reason:'business_resource_authorization_required'};
  if(request.source.provider!=='feishu')return{state:'unknown',reason:request.source.provider==='wecom'?'wecom_cli_schema_unverified':'business_provider_authorization_unwired'};
  if(request.source.requesterNamespace!=='open_id'||!request.source.requesterId||!request.source.messageId||!request.source.chatId||!request.audience)return denied;
  try{
   await this.options.assertSource(request.source);const token=await this.registry.resolveForRequest(request);if(!token)return denied;
   // Verify the exact token subsequently used for resource requests; a registry rotation cannot swap subjects between checks.
   const accounts=new BusinessAccountBindings(this.store,{resolve:async()=>token},{...(this.options.fetch?{fetch:this.options.fetch}:{}),now:()=>this.now()});
   const identity=await accounts.verifyFeishu(request.source);if(!identity)return denied;
   const account={...identity,authorizationRevision:createHash('sha256').update(JSON.stringify([identity.authorizationRevision,token.authorizationRevision??'legacy-host-registry'])).digest('hex')};
   const derived:BusinessResourceRef[]=[];
   const transport=new FeishuAssetTransport({accessToken:async()=>token.accessToken,assertSource:scope=>this.options.assertSource(scope),...(this.options.fetch?{fetch:this.options.fetch}:{}),now:()=>this.now(),authorizeDerived:async ref=>{if(!derived.some(x=>x.kind===ref.kind&&x.externalId===ref.externalId))derived.push(ref);return true;}});
   let descriptor:SharedMessageAsset;
   const ref=request.resource;
   if(ref.kind==='document'||ref.kind==='minutes')descriptor={kind:ref.kind==='document'?'file':'meeting',businessResource:{kind:ref.kind,externalId:ref.externalId}};
   else if(ref.kind==='meeting'&&ref.externalId.startsWith('[')){
    const parts:unknown=JSON.parse(ref.externalId);if(!Array.isArray(parts)||parts.length!==3||!parts.every(x=>typeof x==='string'))return denied;
    descriptor={kind:'meeting',meetingNumber:parts[0]!,startAt:parts[1]!,endAt:parts[2]!};
   }else{
    // A returned meeting/note ID is only a derivative metadata proof, never a guessed standalone meeting number.
    if(!request.originResource||JSON.stringify(request.originResource)===JSON.stringify(ref)||!['meeting','note'].includes(ref.kind)||!/^[a-zA-Z0-9_-]{1,256}$/.test(ref.externalId))return{state:'unknown',reason:'meeting_instance_unresolved'};
    const url=`https://open.feishu.cn/open-apis/vc/v1/${ref.kind==='note'?'notes':'meetings'}/${encodeURIComponent(ref.externalId)}`;
    const response=await(this.options.fetch??fetch)(url,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:`Bearer ${token.accessToken}`}});if(!response.ok)return denied;
    const bytes=await this.bytes(response),envelope=JSON.parse(Buffer.from(bytes).toString('utf8'))as{code?:unknown};if(envelope.code!==0)return denied;
    await this.options.assertSource(request.source);return this.proof(request,account,bytes,'application/json',derived);
   }
   let response=await transport.read(request.source,descriptor,request.operation);if(!(response instanceof Response))return response.state==='no_permission'?denied:{state:'unknown',reason:response.reason??'business_material_unavailable'};
   let bytes:Uint8Array;try{bytes=await this.bytes(response);}catch(error){if(!(error instanceof AssetJsonError))throw error;response=await transport.readAlternative(request.source,descriptor,request.operation);if(!(response instanceof Response))return response.state==='no_permission'?denied:{state:'unknown',reason:response.reason??'business_material_unavailable'};bytes=await this.bytes(response);}
   await this.options.assertSource(request.source);
   return this.proof(request,account,bytes,response.headers.get('content-type')??'application/octet-stream',derived);
  }catch{return denied;}
 }
 private proof(request:ResourceAuthorizationRequest,account:{accountId:string;authorizationRevision:string;expiresAt:number},bytes:Uint8Array,mediaType:string,derived:BusinessResourceRef[]):ResourceGrant{
  const version=createHash('sha256').update(bytes).digest('hex'),expiresAt=Math.min(account.expiresAt,this.now()+60000);
  this.save(this.key(request),{bytes,mediaType,version,accountId:account.accountId,revision:account.authorizationRevision,expiresAt,derived});
  return{state:'authorized',accountId:account.accountId,authorizationRevision:account.authorizationRevision,resourceVersion:version,expiresAt,apiScopeVerified:true,userAclVerified:true,outputAudienceVerified:true};
 }
 private async read(request:ResourceAuthorizationRequest,grant:ResourceGrant,authorizeDerived:(ref:BusinessResourceRef)=>Promise<boolean>):Promise<Response|AssetUnavailable>{
  const snapshot=this.snapshots.get(this.key(request));if(!snapshot||snapshot.expiresAt<=this.now()||snapshot.version!==grant.resourceVersion||snapshot.accountId!==grant.accountId||snapshot.revision!==grant.authorizationRevision)return{state:'no_permission',reason:'business_snapshot_expired'};
  await this.options.assertSource(request.source);
  for(const ref of snapshot.derived){if(ref.kind===request.resource.kind&&ref.externalId===request.resource.externalId)continue;if(!await authorizeDerived(ref))return{state:'no_permission',reason:'business_resource_derivative_authorization_required'};}
  return new Response(Buffer.from(snapshot.bytes),{headers:{'content-type':snapshot.mediaType}});
 }
}
