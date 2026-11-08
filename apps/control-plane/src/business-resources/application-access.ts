import {createHash} from 'node:crypto';
import type {SharedMessageAsset} from '@dentity/application';
import type {Store} from '../store.js';
import {FeishuAssetTransport} from '../assets/feishu.js';
import {AssetJsonError} from '../assets/json-text-stream.js';
import type {AssetSourceScope,AssetUnavailable} from '../assets/service.js';
import type {AssetTransport} from '../assets/service.js';
import {businessResource} from './authorization.js';
import type {BusinessResourceAccess,BusinessResourceRef,ResourceAuthorizationRequest,ResourceDecision,ResourceGrant} from './authorization.js';
export interface ApplicationResourceIdentity {accessToken:string;accountId:string;authorizationRevision:string;expiresAt:number}
export interface ApplicationTransportOptions {accessToken:(source:AssetSourceScope)=>Promise<string>;assertSource:(source:AssetSourceScope)=>void|Promise<void>;fetch?:typeof fetch;now?:()=>number;authorizeDerived:(ref:BusinessResourceRef)=>Promise<boolean>}
type Snapshot={bytes:Uint8Array;mediaType:string;version:string;accountId:string;revision:string;expiresAt:number;derived:BusinessResourceRef[]};
const MAX_BYTES=25*1024*1024;
/** Official application read proves API scope and the calling application's actual resource ACL.
 * Source consent and fixed task/audience are checked separately against persisted trusted ingestion.
 * Tokens stay in runtime memory; only a bounded content snapshot reaches the asset service. */
export class ApplicationResourceAccess implements BusinessResourceAccess {
 readonly identityKind='application' as const;
 readonly authorization={authorize:(request:ResourceAuthorizationRequest)=>this.authorize(request)};
 readonly reader={read:(request:ResourceAuthorizationRequest,grant:ResourceGrant,_descriptor:SharedMessageAsset,authorizeDerived:(ref:BusinessResourceRef)=>Promise<boolean>)=>this.read(request,grant,authorizeDerived)};
 private readonly snapshots=new Map<string,Snapshot>();
 private snapshotBytes=0;
 constructor(private readonly store:Store,private readonly options:{resolveApplication:(request:ResourceAuthorizationRequest)=>Promise<ApplicationResourceIdentity|undefined>;transport?:(provider:string,options:ApplicationTransportOptions)=>AssetTransport|undefined;assertSource:(source:AssetSourceScope)=>void|Promise<void>;fetch?:typeof fetch;now?:()=>number}){}
 private trustedContext(request:ResourceAuthorizationRequest){
  const rows=this.store.all<{request_json:string;descriptor_json:string;scope_json:string}>('SELECT c.request_json,a.descriptor_json,a.scope_json FROM business_resource_run_context c JOIN message_assets a ON a.id=c.asset_id WHERE c.run_id=?',request.run.runId);
  const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
  const row=rows.find(row=>{const stored=JSON.parse(row.request_json)as ResourceAuthorizationRequest;return equal(stored.source,request.source)&&equal(stored.invocationActor,request.invocationActor)&&equal(stored.run,request.run)&&stored.audience===request.audience&&equal(businessResource(JSON.parse(row.descriptor_json)),request.originResource??request.resource);});
  if(!row)return false;
  if(equal(request.resource,request.originResource??request.resource))return true;
  const root={...request,resource:request.originResource!};
  const snapshot=this.snapshots.get(this.key(root));
  if(snapshot?.derived.some(ref=>equal(ref,request.resource)))return true;
  // Persisted derivative provenance can be revalidated after process restart. It was written only
  // by the asset service after a successful provider-derived read, never by model tool parameters.
  return this.store.all<{request_json:string}>('SELECT request_json FROM business_resource_authorizations WHERE run_id=?',request.run.runId).some(row=>{const old=JSON.parse(row.request_json)as ResourceAuthorizationRequest;return equal(old,request);});
 }
 private now(){return(this.options.now??Date.now)();}
 private key(request:ResourceAuthorizationRequest){return JSON.stringify([request.source,request.run,request.resource,request.operation,request.audience,request.originResource,request.invocationActor]);}
 private drop(key:string){const entry=this.snapshots.get(key);if(entry){this.snapshotBytes-=entry.bytes.byteLength;this.snapshots.delete(key);}}
 private save(key:string,snapshot:Snapshot){for(const[k,v]of this.snapshots)if(v.expiresAt<=this.now())this.drop(k);this.drop(key);while(this.snapshots.size>=128||this.snapshotBytes+snapshot.bytes.byteLength>64*1024*1024){const oldest=this.snapshots.keys().next().value;if(!oldest)break;this.drop(oldest);}this.snapshots.set(key,snapshot);this.snapshotBytes+=snapshot.bytes.byteLength;}
 private async bytes(response:Response){const reader=response.body?.getReader();if(!reader)throw Error('empty_business_resource');let length=0;const chunks:Uint8Array[]=[];try{for(;;){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;if(length>MAX_BYTES){await reader.cancel();throw Error('business_resource_size_limit');}chunks.push(item.value);}}finally{reader.releaseLock();}return new Uint8Array(Buffer.concat(chunks));}
 async authorize(request:ResourceAuthorizationRequest):Promise<ResourceDecision>{
  this.drop(this.key(request));
  const denied={state:'authorization_required' as const,reason:'business_resource_authorization_required'};
  if(!['feishu','dingtalk'].includes(request.source.provider))return{state:'unknown',reason:request.source.provider==='wecom'?'wecom_application_resource_unverified':'business_provider_authorization_unwired'};
  const namespace=request.source.provider==='feishu'?'open_id':'user_id';
  if(request.source.requesterNamespace!==namespace||!request.source.requesterId||!request.source.messageId||!request.source.chatId||!request.audience)return denied;
  let applicationResolved=false;
  try{
   if(!this.trustedContext(request))return denied;
   await this.options.assertSource(request.source);const token=await this.options.resolveApplication(request);if(!token||token.expiresAt<=this.now())return denied;
   const account=token;applicationResolved=true;
   const derived:BusinessResourceRef[]=[];
   const transportOptions:ApplicationTransportOptions={accessToken:async()=>token.accessToken,assertSource:scope=>this.options.assertSource(scope),...(this.options.fetch?{fetch:this.options.fetch}:{}),now:()=>this.now(),authorizeDerived:async ref=>{if(!derived.some(x=>x.kind===ref.kind&&x.externalId===ref.externalId))derived.push(ref);return true;}};
   const transport=this.options.transport?.(request.source.provider,transportOptions)??(request.source.provider==='feishu'?new FeishuAssetTransport({...transportOptions,authorizeDerived:async()=>true,onResourceRead:ref=>{if(!derived.some(x=>x.kind===ref.kind&&x.externalId===ref.externalId))derived.push(ref);}}):undefined);
   if(!transport)return{state:'unknown',reason:'business_application_reader_unverified'};
   let descriptor:SharedMessageAsset;
   const ref=request.resource;
   if(ref.kind==='document'&&request.operation!=='content'&&JSON.stringify(request.originResource??ref)===JSON.stringify(ref))return{state:'unknown',reason:'asset_content_kind_unavailable',readState:'not_available'};
   if(ref.kind==='document'||ref.kind==='minutes'||request.source.provider==='dingtalk'&&ref.kind==='meeting')descriptor={kind:ref.kind==='document'?'file':'meeting',businessResource:{kind:ref.kind,externalId:ref.externalId}};
   else if(ref.kind==='meeting'&&ref.externalId.startsWith('[')){
    const parts:unknown=JSON.parse(ref.externalId);if(!Array.isArray(parts)||parts.length!==3||!parts.every(x=>typeof x==='string'))return denied;
    descriptor={kind:'meeting',meetingNumber:parts[0]!,startAt:parts[1]!,endAt:parts[2]!};
   }else{
    // A returned meeting/note ID is only a derivative metadata proof, never a guessed standalone meeting number.
    if(!request.originResource||JSON.stringify(request.originResource)===JSON.stringify(ref)||!['meeting','note'].includes(ref.kind)||!/^[a-zA-Z0-9_-]{1,256}$/.test(ref.externalId))return{state:'unknown',reason:'meeting_instance_unresolved'};
    const url=`https://open.feishu.cn/open-apis/vc/v1/${ref.kind==='note'?'notes':'meetings'}/${encodeURIComponent(ref.externalId)}`;
    const response=await(this.options.fetch??fetch)(url,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:`Bearer ${token.accessToken}`}});if(!response.ok)return denied;
    const bytes=await this.bytes(response),envelope=JSON.parse(Buffer.from(bytes).toString('utf8'))as{code?:unknown};if(envelope.code!==0)return denied;
    await this.options.assertSource(request.source);const latest=await this.options.resolveApplication(request);if(!latest||latest.accountId!==account.accountId||latest.authorizationRevision!==account.authorizationRevision||latest.expiresAt<=this.now())return denied;return this.proof(request,account,bytes,'application/json',derived);
   }
   let response=await transport.read(request.source,descriptor,ref.kind==='document'?'content':request.operation);if(!(response instanceof Response))return response.state==='no_permission'?{...denied,reason:response.reason??denied.reason}:{state:'unknown',readState:response.state,reason:response.reason??'business_material_unavailable'};
   if(!response.ok)return denied;
   let bytes:Uint8Array;try{bytes=await this.bytes(response);}catch(error){if(!(error instanceof AssetJsonError)||!transport.readAlternative||descriptor.kind!=='meeting'||descriptor.businessResource)throw error;derived.length=0;response=await transport.readAlternative(request.source,descriptor,request.operation);if(!(response instanceof Response)&&response.state==='not_available'&&error.state==='no_permission')return{...denied,reason:error.reason};if(!(response instanceof Response))return response.state==='no_permission'?{...denied,reason:response.reason??denied.reason}:{state:'unknown',readState:response.state,reason:response.reason??'business_material_unavailable'};bytes=await this.bytes(response);}
   if(bytes.byteLength===0)return{state:'unknown',reason:'provider_material_empty'};
   await this.options.assertSource(request.source);
   const latest=await this.options.resolveApplication(request);if(!latest||latest.accountId!==account.accountId||latest.authorizationRevision!==account.authorizationRevision||latest.expiresAt<=this.now())return denied;
   return this.proof(request,account,bytes,response.headers.get('content-type')??'application/octet-stream',derived);
  }catch(error){if(error instanceof AssetJsonError)return error.state==='no_permission'?{...denied,reason:error.reason}:{state:'unknown',readState:error.state,reason:error.reason};if(applicationResolved){try{await this.options.assertSource(request.source);}catch{return denied;}return{state:'unknown',readState:'failed',reason:'business_resource_read_failed'};}return denied;}
 }
 private proof(request:ResourceAuthorizationRequest,account:{accountId:string;authorizationRevision:string;expiresAt:number},bytes:Uint8Array,mediaType:string,derived:BusinessResourceRef[]):ResourceGrant{
  const version=createHash('sha256').update(bytes).digest('hex'),expiresAt=Math.min(account.expiresAt,this.now()+60000);
  this.save(this.key(request),{bytes,mediaType,version,accountId:account.accountId,revision:account.authorizationRevision,expiresAt,derived});
  return{state:'authorized',accountId:account.accountId,authorizationRevision:account.authorizationRevision,resourceVersion:version,expiresAt,identityKind:'application',apiScopeVerified:true,resourceAclVerified:true,outputAudienceVerified:true};
 }
 private async read(request:ResourceAuthorizationRequest,grant:ResourceGrant,authorizeDerived:(ref:BusinessResourceRef)=>Promise<boolean>):Promise<Response|AssetUnavailable>{
  const snapshot=this.snapshots.get(this.key(request));if(!snapshot||snapshot.expiresAt<=this.now()||snapshot.version!==grant.resourceVersion||snapshot.accountId!==grant.accountId||snapshot.revision!==grant.authorizationRevision)return{state:'no_permission',reason:'business_snapshot_expired'};
  await this.options.assertSource(request.source);
  if(!this.trustedContext(request))return{state:'no_permission',reason:'business_resource_source_invalid'};
  const identity=await this.options.resolveApplication(request);
  if(!identity||identity.expiresAt<=this.now()||identity.accountId!==grant.accountId||identity.authorizationRevision!==grant.authorizationRevision)return{state:'no_permission',reason:'business_application_identity_changed'};
  for(const ref of snapshot.derived){if(ref.kind===request.resource.kind&&ref.externalId===request.resource.externalId)continue;if(!await authorizeDerived(ref))return{state:'no_permission',reason:'business_resource_derivative_authorization_required'};}
  return new Response(Buffer.from(snapshot.bytes),{headers:{'content-type':snapshot.mediaType}});
 }
}
