import{SourceMaterialTransfers,type OriginalSourceMaterial,type WorkItemMaterialPort}from'../business-resources/transfers.js';
import{receivedWorkItemResourceProof}from'../work-items/resource-lineage.js';
import{withExplicitResources}from'../business-resources/references.js';
import{isBusinessResource,businessResource,validGrant,sameGrant,type BusinessResourceAccess,type ResourceAuthorizationRequest,type ResourceGrant}from'../business-resources/authorization.js';
import{AssetJsonError}from'./json-text-stream.js';
import{createHash,randomUUID}from'node:crypto';
import{mkdir,lstat,realpath,open,rename,unlink,readFile}from'node:fs/promises';
import{createReadStream,unlinkSync,lstatSync,realpathSync,opendirSync,type Dir}from'node:fs';
import{Readable}from'node:stream';
import{join}from'node:path';
import{mapMessageAssets,messageAssets,renderMessageContent,type SharedMessageAsset,type ChannelMessageEvent,type MessageLoopBinding}from'@dentity/application';
import type{Store}from'../store.js';
export type AssetReadKind='content'|'summary'|'transcript';
export type AssetUnavailable={state:'pending'|'no_permission'|'not_available'|'failed';reason?:string};
export interface AssetSourceScope{workspaceId:string;entityId:string;provider:string;tenantId:string;applicationId:string;connectionId:string;bindingVersion:string;messageId:string;chatId:string;conversationKind?:'private'|'group'|'meeting';threadId?:string;requesterId?:string;requesterNamespace?:string}
export interface AssetRunScope{workspaceId:string;entityId:string;taskId:string;runId:string}
export interface AssetTransport{read(scope:AssetSourceScope,descriptor:SharedMessageAsset,kind:AssetReadKind):Promise<Response|AssetUnavailable>;readAlternative?(scope:AssetSourceScope,descriptor:SharedMessageAsset,kind:AssetReadKind):Promise<Response|AssetUnavailable>}
export type AssetResolution=AssetUnavailable|{state:'ready';assetId:string;kind:SharedMessageAsset['kind'];version:string;sha256:string;size:number;mediaType:string};
interface Row{id:string;scope_json:string;descriptor_json:string}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const conversationSourceKey=(s:Omit<AssetSourceScope,'messageId'>)=>digest([s.workspaceId,s.entityId,s.provider,s.tenantId,s.applicationId,s.connectionId,s.bindingVersion,s.chatId,s.threadId??'']);
const safeReason=(r:unknown)=>typeof r==='string'&&/^[a-z][a-z0-9_]{0,99}$/.test(r)?r:'asset_fetch_failed';
/** The platform owns source identities, vendor keys and bytes; model-visible IDs are never bearer tokens. */
export interface ArtifactAssetSource {
 listForRun(run:AssetRunScope):{assetId:string;kind:'image'|'file';name:string}[];
 owns(id:string):boolean;
 streamForRun(run:AssetRunScope,id:string,kind:AssetReadKind):Promise<Response|AssetUnavailable>;
}
export class PlatformAssetService{
 private artifactSource?:ArtifactAssetSource;
 private readonly transfers:SourceMaterialTransfers;
 workItemMaterials():WorkItemMaterialPort{return this.transfers;}
 setArtifactSource(source:ArtifactAssetSource){this.artifactSource=source;}
 private readonly active=new Map<string,Promise<AssetResolution>>();private cleanupCursor=0;private cacheScan:Dir|undefined;private cacheScanRoot='';
 constructor(private readonly store:Store,private readonly cacheRoot:string,private readonly transport:AssetTransport,private readonly options:{now?:()=>number;waitMs?:number;businessResources?:BusinessResourceAccess;assertSource?:(source:AssetSourceScope)=>void|Promise<void>}={}){
  store.db.exec(`CREATE TABLE IF NOT EXISTS business_resource_run_context(asset_id TEXT NOT NULL,run_id TEXT NOT NULL,request_json TEXT NOT NULL,PRIMARY KEY(asset_id,run_id));
   CREATE TABLE IF NOT EXISTS business_resource_authorizations(asset_id TEXT NOT NULL,run_id TEXT NOT NULL,read_kind TEXT NOT NULL,resource_key TEXT NOT NULL,request_json TEXT NOT NULL,grant_json TEXT NOT NULL,PRIMARY KEY(asset_id,run_id,read_kind,resource_key));
   CREATE TABLE IF NOT EXISTS business_resource_cache_authorizations(asset_id TEXT NOT NULL,read_kind TEXT NOT NULL,grant_json TEXT NOT NULL,PRIMARY KEY(asset_id,read_kind));
   CREATE TABLE IF NOT EXISTS message_assets(id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,scope_json TEXT NOT NULL,descriptor_json TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS message_asset_created ON message_assets(created_at);
   CREATE TABLE IF NOT EXISTS message_asset_versions(asset_id TEXT NOT NULL,read_kind TEXT NOT NULL,state TEXT NOT NULL,version TEXT,hash TEXT,size INTEGER,media_type TEXT,path TEXT,reason TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(asset_id,read_kind));
   CREATE TABLE IF NOT EXISTS message_asset_run_grants(asset_id TEXT NOT NULL,run_id TEXT NOT NULL,task_id TEXT NOT NULL,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(asset_id,run_id));
   CREATE TABLE IF NOT EXISTS message_asset_conversation_grants(asset_id TEXT NOT NULL REFERENCES message_assets(id) ON DELETE CASCADE,source_key TEXT NOT NULL,PRIMARY KEY(asset_id,source_key));
   CREATE TABLE IF NOT EXISTS message_asset_links(asset_id TEXT NOT NULL,owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(asset_id,owner_kind,owner_id));`);
  this.transfers=new SourceMaterialTransfers(store,{list:run=>this.originalMaterials(run),inspect:(run,id,kind)=>this.originalMaterial(run,id,kind),read:(run,id,kind)=>this.streamForRun(run,id,kind),assertSource:source=>{if(!this.options.assertSource)throw Error('source_material_live_guard_unavailable');return this.options.assertSource(source);},retain:(id,taskId)=>this.retain(id,'task',taskId)},()=>this.now());
 }
 private now(){return(this.options.now??Date.now)();}
 private source(b:MessageLoopBinding,e:ChannelMessageEvent):AssetSourceScope{if(!['feishu','dingtalk','wecom'].includes(b.provider)||e.message.conversation.provider!==b.provider||e.connectionId!==b.connectionId||e.tenantId!==b.connection.tenantId||e.message.conversation.externalId.length===0||e.message.conversation.connectionId!==b.connectionId||e.message.conversation.tenantId!==e.tenantId)throw Error('asset_source_scope_mismatch');return{workspaceId:b.workspaceId,entityId:b.entityId,provider:b.provider,tenantId:e.tenantId,applicationId:b.appId,connectionId:b.connectionId,bindingVersion:b.bindingVersion,...(e.message.author?.identityEvidence==='channel_verified'&&e.message.author.externalId&&e.message.author.idNamespace?{requesterId:e.message.author.externalId,requesterNamespace:e.message.author.idNamespace}:{}),messageId:e.message.id,chatId:e.message.conversation.externalId,...(e.message.conversationKind?{conversationKind:e.message.conversationKind}:{}),...(e.message.threadId?{threadId:e.message.threadId}:{})};}
 ingest(b:MessageLoopBinding,event:ChannelMessageEvent):ChannelMessageEvent{
  event=withExplicitResources(b.provider,event);if(!event.message.content)return event;const scope=this.source(b,event),content=mapMessageAssets(event.message.content,(descriptor,index)=>{const sourceKey=digest([scope,index]);const prior=this.store.one<Row>('SELECT * FROM message_assets WHERE source_key=?',sourceKey);let id=prior?.id;if(!id){id=randomUUID();this.store.run('INSERT INTO message_assets(id,source_key,scope_json,descriptor_json,created_at) VALUES(?,?,?,?,?)',id,sourceKey,JSON.stringify(scope),JSON.stringify(descriptor),this.now());}this.retain(id,'window',digest(scope));return{...descriptor,assetId:id};});
  return{...event,message:{...event.message,content,text:renderMessageContent(content),sharedAssets:messageAssets(content).map(a=>({assetId:a.assetId!,kind:a.kind,...(a.name?{name:a.name}:{})}))}};
 }
 async prefetch(b:MessageLoopBinding,event:ChannelMessageEvent){this.source(b,event);await Promise.allSettled((event.message.sharedAssets??[]).map(a=>{const row=this.store.one<Row>('SELECT * FROM message_assets WHERE id=?',a.assetId);return row&&isBusinessResource(JSON.parse(row.descriptor_json))?Promise.resolve():this.fetch(a.assetId,'content');}));}
 private originalMaterial(run:AssetRunScope,id:string,kind:AssetReadKind):OriginalSourceMaterial{
  this.authorized(run,id);const row=this.store.one<Row>('SELECT * FROM message_assets WHERE id=?',id),version=this.store.one<{version:string}>('SELECT version FROM message_asset_versions WHERE asset_id=? AND read_kind=? AND state=\'ready\'',id,kind);if(!row||!version?.version)throw Error('source_material_not_prepared');
  const descriptor=JSON.parse(row.descriptor_json)as SharedMessageAsset;
  if(isBusinessResource(descriptor)&&!this.store.one('SELECT asset_id FROM business_resource_authorizations WHERE asset_id=? AND run_id=? AND read_kind=?',id,run.runId,kind))throw Error('source_material_not_authorized');
  return{assetId:id,readKind:kind,version:version.version,name:descriptor.name??('Shared '+kind),source:JSON.parse(row.scope_json)as AssetSourceScope};
 }
 private originalMaterials(run:AssetRunScope){const rows=this.store.all<{asset_id:string;read_kind:AssetReadKind}>('SELECT v.asset_id,v.read_kind FROM message_asset_versions v JOIN message_asset_run_grants g ON g.asset_id=v.asset_id WHERE g.run_id=? AND g.task_id=? AND g.workspace_id=? AND g.entity_id=? AND v.state=\'ready\'',run.runId,run.taskId,run.workspaceId,run.entityId);const values:OriginalSourceMaterial[]=[];for(const row of rows){try{values.push(this.originalMaterial(run,row.asset_id,row.read_kind));}catch{/* No candidate without this run's own preparation/authorization. */}}return values;}
 /** Explicit source-bound handoff; a new context mode alone never calls this. */
 grantForRun(run:AssetRunScope,ids:readonly string[],source:Omit<AssetSourceScope,'messageId'>){this.store.transaction(()=>{for(const id of new Set(ids)){const row=this.store.one<Row>('SELECT * FROM message_assets WHERE id=?',id);if(!row)throw Error('asset_not_authorized');const own=JSON.parse(row.scope_json)as AssetSourceScope;this.assertForConversation(source,id);if(isBusinessResource(JSON.parse(row.descriptor_json))){this.assertBusinessRequester(own,source);this.store.run('INSERT INTO business_resource_run_context VALUES(?,?,?) ON CONFLICT(asset_id,run_id) DO NOTHING',id,run.runId,JSON.stringify({source:own,run,audience:conversationSourceKey(source),invocationActor:{requesterId:source.requesterId!,requesterNamespace:source.requesterNamespace!}}));}if(run.workspaceId!==own.workspaceId||run.entityId!==own.entityId)throw Error('asset_not_authorized');this.store.run('INSERT OR IGNORE INTO message_asset_run_grants VALUES(?,?,?,?,?,?)',id,run.runId,run.taskId,run.workspaceId,run.entityId,this.now());this.retain(id,'task',run.taskId);}});}
 listForRun(run:AssetRunScope){return this.store.all<{id:string;descriptor_json:string}>('SELECT a.id,a.descriptor_json FROM message_assets a JOIN message_asset_run_grants g ON g.asset_id=a.id WHERE g.run_id=? AND g.task_id=? AND g.workspace_id=? AND g.entity_id=?',run.runId,run.taskId,run.workspaceId,run.entityId).map(row=>{const a=JSON.parse(row.descriptor_json)as SharedMessageAsset;return{assetId:row.id,kind:a.kind,...(a.name?{name:a.name}:{})};}).concat(this.artifactSource?.listForRun(run)??[],this.transfers.listAssets(run));}
 private authorized(run:AssetRunScope,id:string){if(!this.store.one('SELECT asset_id FROM message_asset_run_grants WHERE asset_id=? AND run_id=? AND task_id=? AND workspace_id=? AND entity_id=?',id,run.runId,run.taskId,run.workspaceId,run.entityId))throw Error('asset_not_authorized');}
 /** Root material is shared only by the trusted topic-background batch builder. */
 allowTopicRootAssets(binding:MessageLoopBinding,event:ChannelMessageEvent,ids:readonly string[]){
  const source=this.source(binding,event);if(!source.threadId||!event.message.rootMessageId)return;
  for(const id of new Set(ids)){const row=this.store.one<Row>('SELECT * FROM message_assets WHERE id=?',id);if(!row)throw Error('asset_not_authorized');const own=JSON.parse(row.scope_json)as AssetSourceScope;
   for(const key of ['workspaceId','entityId','provider','tenantId','applicationId','connectionId','bindingVersion','chatId']as const)if(own[key]!==source[key])throw Error('asset_not_authorized');
   if(own.threadId===source.threadId)continue;if(own.threadId!==undefined||own.messageId!==event.message.rootMessageId)throw Error('asset_not_authorized');
   this.store.run('INSERT OR IGNORE INTO message_asset_conversation_grants VALUES(?,?)',id,conversationSourceKey(source));
  }
 }
 /** Called only with the task actor admitted by the existing channel policy, never tool input.
  * A group share is reusable by another admitted actor in that exact group/topic for application
  * reads. Keep the original sharer (and provider operator) intact. Old/private/user-token sources
  * retain the conservative same-actor rule. Conversation scope is checked separately below. */
 private assertBusinessRequester(own:AssetSourceScope,current:Omit<AssetSourceScope,'messageId'>){
  if(!own.requesterId||!own.requesterNamespace||!current.requesterId||!current.requesterNamespace)throw Error('business_resource_requester_mismatch');
  if(own.requesterId===current.requesterId&&own.requesterNamespace===current.requesterNamespace)return;
  if(this.options.businessResources?.identityKind==='application'&&own.conversationKind==='group'&&current.conversationKind==='group'&&own.threadId===current.threadId&&own.requesterNamespace===current.requesterNamespace)return;
  throw Error('business_resource_requester_mismatch');
 }
 /** Caller supplies trusted current conversation scope, never model arguments. */
 assertForConversation(source:Omit<AssetSourceScope,'messageId'>,id:string){
  const row=this.store.one<Row>('SELECT * FROM message_assets WHERE id=?',id);if(!row)throw Error('asset_not_authorized');const own=JSON.parse(row.scope_json)as AssetSourceScope;
  for(const key of ['workspaceId','entityId','provider','tenantId','applicationId','connectionId','bindingVersion','chatId']as const)if(own[key]!==source[key])throw Error('asset_not_authorized');
  if(isBusinessResource(JSON.parse(row.descriptor_json)))this.assertBusinessRequester(own,source);
  if(own.threadId!==source.threadId&&!this.store.one('SELECT asset_id FROM message_asset_conversation_grants WHERE asset_id=? AND source_key=?',id,conversationSourceKey(source)))throw Error('asset_not_authorized');return row;
 }
 private conversationAsset(source:Omit<AssetSourceScope,'messageId'>,id:string){const row=this.assertForConversation(source,id);if((JSON.parse(row.descriptor_json)as SharedMessageAsset).kind!=='image')throw Error('asset_not_image');return row;}
 authorizedImageIds(source:Omit<AssetSourceScope,'messageId'>,text:string){return [...new Set([...text.matchAll(/asset_id=([a-f0-9-]{36})\b/g)].map(m=>m[1]!))].filter(id=>{try{this.conversationAsset(source,id);return true;}catch{return false;}});}
 async imageReferences(source:Omit<AssetSourceScope,'messageId'>,text:string){
  const ids=this.authorizedImageIds(source,text),refs:{assetId:string;version:string}[]=[];
  for(const id of ids){try{this.conversationAsset(source,id);}catch{continue;}const value=await this.fetch(id,'content');if(value.state==='ready')refs.push({assetId:id,version:value.version});}
  return refs;
 }
 async imageContent(source:Omit<AssetSourceScope,'messageId'>,ref:{assetId:string;version:string},signal:AbortSignal){
  this.conversationAsset(source,ref.assetId);const value=await this.fetch(ref.assetId,'content');if(signal.aborted)throw Error('image_read_canceled');
  if(value.state!=='ready'||value.version!==ref.version)throw Error('image_version_unavailable');
  const row=this.store.one<{path:string}>('SELECT path FROM message_asset_versions WHERE asset_id=? AND read_kind=\'content\' AND state=\'ready\'',ref.assetId);if(!row)throw Error('image_version_unavailable');
  const info=await lstat(row.path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(info.mode&0o077)!==0||info.size!==value.size)throw Error('asset_cache_unsafe');
  const bytes=await readFile(row.path);if(signal.aborted)throw Error('image_read_canceled');if(createHash('sha256').update(bytes).digest('hex')!==ref.version)throw Error('image_integrity_mismatch');
  const mediaType=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':bytes.toString('ascii',0,3)==='GIF'?'image/gif':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':undefined;if(!mediaType)throw Error('image_encoding_unsupported');return{data:bytes.toString('base64'),mediaType};
 }
 retain(id:string,kind:'window'|'history'|'task',owner:string){this.store.run('INSERT OR IGNORE INTO message_asset_links VALUES(?,?,?,?)',id,kind,owner,this.now());}
 release(kind:'window'|'history'|'task',owner:string){this.store.run('DELETE FROM message_asset_links WHERE owner_kind=? AND owner_id=?',kind,owner);}
 async resolveForRun(run:AssetRunScope,id:string,kind:AssetReadKind='content'):Promise<AssetResolution>{if(this.transfers.owns(id))return this.transfers.resolveForRun(run,id,kind);this.authorized(run,id);const work=this.fetchForRun(run,id,kind);let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<AssetUnavailable>(r=>{timer=setTimeout(()=>r({state:'pending',reason:'asset_wait_timeout'}),this.options.waitMs??10000);})]);}finally{if(timer)clearTimeout(timer);}}
 async streamForRun(run:AssetRunScope,id:string,kind:AssetReadKind='content'):Promise<Response|AssetUnavailable>{if(this.transfers.owns(id))return this.transfers.streamForRun(run,id,kind);if(this.artifactSource?.owns(id))return this.artifactSource.streamForRun(run,id,kind);const result=await this.resolveForRun(run,id,kind);if(result.state!=='ready')return result;const row=this.store.one<{path:string}>('SELECT path FROM message_asset_versions WHERE asset_id=? AND read_kind=? AND state=\'ready\'',id,kind);if(!row)throw Error('asset_cache_unavailable');const info=await lstat(row.path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size!==result.size||(info.mode&0o077)!==0)throw Error('asset_cache_unsafe');return new Response(Readable.toWeb(createReadStream(row.path))as ReadableStream<Uint8Array>,{headers:{'content-type':result.mediaType,'content-length':String(result.size),'x-asset-id':id,'x-asset-sha256':result.sha256,'x-asset-version':result.version}});}
 async assertBusinessOutputTarget(run:AssetRunScope,targetJson:string):Promise<void>{
  let value:Record<string,unknown>={};try{value=JSON.parse(targetJson);}catch{}
  const target=value.conversation&&typeof value.conversation==='object'?value.conversation as Record<string,unknown>:{};
  await this.assertBusinessOutputForRun(run,{provider:typeof target.provider==='string'?target.provider:'',connectionId:typeof target.connectionId==='string'?target.connectionId:'',tenantId:typeof target.tenantId==='string'?target.tenantId:'',chatId:typeof target.externalId==='string'?target.externalId:'',...(typeof value.threadId==='string'?{threadId:value.threadId}:{})});
 }
 /** A resumed checkpoint carries parent resource provenance even if a copied asset list is empty. */
 async prepareBusinessContinuation(run:AssetRunScope,parentRunId:string):Promise<void>{
  await this.revalidateBusinessResourcesForRun({...run,runId:parentRunId});
  await this.transfers.prepareContinuation(run,parentRunId);
  const contexts=this.store.all<{asset_id:string;request_json:string}>('SELECT asset_id,request_json FROM business_resource_run_context WHERE run_id=?',parentRunId);
  for(const row of contexts){const context=JSON.parse(row.request_json)as ResourceAuthorizationRequest;if(context.run.taskId!==run.taskId||context.run.workspaceId!==run.workspaceId||context.run.entityId!==run.entityId)throw Error('business_resource_continuation_scope');
   await this.assertBusinessOutputForRun({...run,runId:parentRunId},context.source);
   this.store.run('INSERT INTO business_resource_run_context VALUES(?,?,?) ON CONFLICT(asset_id,run_id) DO NOTHING',row.asset_id,run.runId,JSON.stringify({...context,run}));
   const grants=this.store.all<{read_kind:AssetReadKind;request_json:string;grant_json:string;resource_key:string}>('SELECT read_kind,request_json,grant_json,resource_key FROM business_resource_authorizations WHERE asset_id=? AND run_id=?',row.asset_id,parentRunId);
   for(const old of grants){const request={...JSON.parse(old.request_json),run}as ResourceAuthorizationRequest,decision=await this.options.businessResources?.authorization.authorize(request);if(!decision||!validGrant(decision,this.now())||!sameGrant(JSON.parse(old.grant_json),decision))throw Error('business_resource_continuation_authorization_required');this.store.run('INSERT INTO business_resource_authorizations VALUES(?,?,?,?,?,?) ON CONFLICT(asset_id,run_id,read_kind,resource_key) DO NOTHING',row.asset_id,run.runId,old.read_kind,old.resource_key,JSON.stringify(request),JSON.stringify(decision));}
  }
 }
 /** Online source authorization only. It does not authorize a different recipient. */
 async revalidateBusinessResourcesForRun(run:AssetRunScope):Promise<void>{
  await this.validateBusinessRequests(run);await this.transfers.revalidateForRun(run);
  const task=this.store.one<{id:string;workspace_id:string;entity_id:string}>('SELECT id,workspace_id,entity_id FROM tasks WHERE id=?',run.taskId);
  if(task){if(task.workspace_id!==run.workspaceId||task.entity_id!==run.entityId)throw Error('business_resource_scope_mismatch');const proof=receivedWorkItemResourceProof(this.store,task);for(const origin of proof.runs)if(origin.runId!==run.runId)await this.validateBusinessRequests(origin);}
 }
 /** Output remains pinned to the original source audience, including selected snapshots and
  * summary-only work-item provenance. Receiving a task does not create broad channel rights. */
 async assertBusinessOutputForRun(run:AssetRunScope,target:Pick<AssetSourceScope,'provider'|'connectionId'|'tenantId'|'chatId'|'threadId'>):Promise<void>{
  await this.validateBusinessRequests(run,target);await this.transfers.revalidateForRun(run);
  for(const origin of this.transfers.origins(run)){for(const key of ['provider','connectionId','tenantId','chatId','threadId']as const)if(origin.source[key]!==target[key])throw Error('business_resource_output_audience_mismatch');await this.validateBusinessRequests(origin.run,target);}
  const task=this.store.one<{id:string;workspace_id:string;entity_id:string}>('SELECT id,workspace_id,entity_id FROM tasks WHERE id=?',run.taskId);
  if(task){if(task.workspace_id!==run.workspaceId||task.entity_id!==run.entityId)throw Error('business_resource_output_scope_mismatch');const proof=receivedWorkItemResourceProof(this.store,task);for(const origin of proof.runs)if(origin.runId!==run.runId)await this.validateBusinessRequests(origin,target);}
 }
 private async validateBusinessRequests(run:AssetRunScope,target?:Pick<AssetSourceScope,'provider'|'connectionId'|'tenantId'|'chatId'|'threadId'>):Promise<void>{
  const runIds=[run.runId];if(this.store.all<{name:string}>('PRAGMA table_info(runs)').some(x=>x.name==='parent_run_id')){let current=run.runId;for(let depth=0;depth<100;depth++){const parent=this.store.one<{parent_run_id:string|null}>('SELECT parent_run_id FROM runs WHERE id=? AND task_id=?',current,run.taskId)?.parent_run_id;if(!parent)break;if(runIds.includes(parent))throw Error('business_resource_lineage_invalid');runIds.push(parent);current=parent;if(depth===99)throw Error('business_resource_lineage_limit');}}
  for(const lineageRun of runIds){const rows=this.store.all<{asset_id:string;request_json:string;grant_json:string}>('SELECT asset_id,request_json,grant_json FROM business_resource_authorizations WHERE run_id=?',lineageRun);
   for(const row of rows){const request=JSON.parse(row.request_json)as ResourceAuthorizationRequest,old=JSON.parse(row.grant_json)as ResourceGrant;
    if(request.run.runId!==lineageRun||request.run.taskId!==run.taskId||request.run.workspaceId!==run.workspaceId||request.run.entityId!==run.entityId||!this.store.one('SELECT asset_id FROM message_asset_run_grants WHERE asset_id=? AND run_id=? AND task_id=? AND workspace_id=? AND entity_id=?',row.asset_id,lineageRun,run.taskId,run.workspaceId,run.entityId))throw Error('business_resource_source_grant_missing');
    if(target)for(const key of ['provider','connectionId','tenantId','chatId','threadId']as const)if(request.source[key]!==target[key])throw Error('business_resource_output_audience_mismatch');
    const decision=await this.options.businessResources?.authorization.authorize(request);if(!decision||!validGrant(decision,this.now())||!sameGrant(old,decision))throw Error('business_resource_output_authorization_required');
   }
  }
 }
 private async fetchForRun(run:AssetRunScope,id:string,kind:AssetReadKind):Promise<AssetResolution>{
  const row=this.store.one<Row>('SELECT * FROM message_assets WHERE id=?',id);if(!row)return{state:'failed',reason:'asset_missing'};
  const descriptor=JSON.parse(row.descriptor_json)as SharedMessageAsset;if(!isBusinessResource(descriptor))return this.fetch(id,kind);
  const access=this.options.businessResources,context=this.store.one<{request_json:string}>('SELECT request_json FROM business_resource_run_context WHERE asset_id=? AND run_id=?',id,run.runId);
  if(!access||!context)return{state:'no_permission',reason:'business_resource_authorization_required'};
  const request:ResourceAuthorizationRequest={...JSON.parse(context.request_json),resource:businessResource(descriptor),originResource:businessResource(descriptor),operation:kind};
  let denial:AssetUnavailable={state:'no_permission',reason:'business_resource_authorization_required'};
  const authorize=async(target:ResourceAuthorizationRequest)=>{const decision=await access.authorization.authorize(target);if(!validGrant(decision,this.now())){denial={state:decision.state==='unknown'?(decision.readState??'not_available'):'no_permission',reason:safeReason(decision.reason??'business_resource_reader_unverified')};return undefined;}
   const key=JSON.stringify(target.resource),prior=this.store.one<{grant_json:string}>('SELECT grant_json FROM business_resource_authorizations WHERE asset_id=? AND run_id=? AND read_kind=? AND resource_key=?',id,run.runId,kind,key);
   if(prior&&!sameGrant(JSON.parse(prior.grant_json),decision))return undefined;
   this.store.run('INSERT INTO business_resource_authorizations VALUES(?,?,?,?,?,?) ON CONFLICT(asset_id,run_id,read_kind,resource_key) DO UPDATE SET grant_json=excluded.grant_json',id,run.runId,kind,key,JSON.stringify(target),JSON.stringify(decision));return decision;};
  const grant=await authorize(request);if(!grant){this.state(id,kind,denial);return denial;}
  // Derived references are independently checked on every cache hit and output; parent permission is never inherited.
  await this.validateBusinessRequests(run,request.source);
  const cached=this.store.one<{grant_json:string}>('SELECT grant_json FROM business_resource_cache_authorizations WHERE asset_id=? AND read_kind=?',id,kind);
  if(cached&&!sameGrant(JSON.parse(cached.grant_json),grant))return{state:'no_permission',reason:'business_resource_version_changed'};
  const ready=this.store.one<{state:string}>('SELECT state FROM message_asset_versions WHERE asset_id=? AND read_kind=?',id,kind);
  if(ready?.state==='ready'&&cached){const derivatives=this.store.all<{request_json:string;grant_json:string}>('SELECT request_json,grant_json FROM business_resource_authorizations WHERE asset_id=? AND read_kind=?',id,kind);for(const entry of derivatives){const oldRequest=JSON.parse(entry.request_json)as ResourceAuthorizationRequest,oldGrant=JSON.parse(entry.grant_json)as ResourceGrant;if(JSON.stringify(oldRequest.resource)===JSON.stringify(request.resource))continue;const current=await authorize({...request,resource:oldRequest.resource});if(!current||!sameGrant(oldGrant,current))return{state:'no_permission',reason:'business_resource_derivative_authorization_required'};}return this.fetch(id,kind);}
  const key=id+':'+kind+':'+run.runId;const existing=this.active.get(key);if(existing)return existing;
  const work=(async()=>{const reader=(alternative=false)=>access.reader.read(request,grant,descriptor,async resource=>!!await authorize({...request,resource}),alternative);
   const result=await this.download(row,kind,false,undefined,reader);
   await this.validateBusinessRequests(run,request.source);
   if(result.state==='ready')this.store.run('INSERT INTO business_resource_cache_authorizations VALUES(?,?,?) ON CONFLICT(asset_id,read_kind) DO UPDATE SET grant_json=excluded.grant_json',id,kind,JSON.stringify(grant));
   return result;})().finally(()=>this.active.delete(key));this.active.set(key,work);return work;
 }
 private fetch(id:string,kind:AssetReadKind):Promise<AssetResolution>{const key=id+':'+kind;const prior=this.active.get(key);if(prior)return prior;const ready=this.store.one<{state:string;version:string;hash:string;size:number;media_type:string;updated_at:number;reason:string}>('SELECT * FROM message_asset_versions WHERE asset_id=? AND read_kind=?',id,kind),asset=this.store.one<Row>('SELECT * FROM message_assets WHERE id=?',id);if(!asset)return Promise.resolve({state:'failed',reason:'asset_missing'});const descriptor=JSON.parse(asset.descriptor_json)as SharedMessageAsset;if(isBusinessResource(descriptor)&&ready?.state!=='ready')return Promise.resolve({state:'no_permission',reason:'business_resource_authorization_required'});if(ready?.state==='ready')return Promise.resolve({state:'ready',assetId:id,kind:descriptor.kind,version:ready.version,sha256:ready.hash,size:ready.size,mediaType:ready.media_type});if(ready&&ready.state!=='ready'&&this.now()-ready.updated_at<(ready.state==='pending'?10000:30000))return Promise.resolve({state:ready.state as AssetUnavailable['state'],reason:ready.reason});const work=this.download(asset,kind).finally(()=>this.active.delete(key));this.active.set(key,work);return work;}
 private async download(row:Row,kind:AssetReadKind,alternative=false,previous?:AssetUnavailable,readBusiness?:(alternative?:boolean)=>Promise<Response|AssetUnavailable>):Promise<AssetResolution>{let temp:string|undefined;try{const source=JSON.parse(row.scope_json)as AssetSourceScope,descriptor=JSON.parse(row.descriptor_json)as SharedMessageAsset;const response=await(readBusiness?readBusiness(alternative):alternative&&this.transport.readAlternative?this.transport.readAlternative(source,descriptor,kind):this.transport.read(source,descriptor,kind));if(!(response instanceof Response)){const result=response.state==='not_available'&&previous?.state==='no_permission'?previous:response;this.state(row.id,kind,result);return result;}if(!response.ok){const state:AssetUnavailable=response.status===401||response.status===403?{state:'no_permission',reason:'provider_permission_denied'}:response.status===404?{state:'not_available',reason:'provider_resource_unavailable'}:{state:'failed',reason:'provider_http_failure'};this.state(row.id,kind,state);return state;}
   await mkdir(this.cacheRoot,{recursive:true,mode:0o700});const dir=await lstat(this.cacheRoot);if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0)throw Error('asset_cache_unsafe');const root=await realpath(this.cacheRoot);temp=join(root,randomUUID()+'.part');const file=await open(temp,'wx',0o600);let size=0;const hash=createHash('sha256');try{const reader=response.body?.getReader();if(!reader)throw Error('asset_empty_response');try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>25*1024*1024){await reader.cancel();throw Error('asset_size_limit');}hash.update(part.value);await file.writeFile(part.value);} }finally{reader.releaseLock();}await file.sync();}finally{await file.close();}const checksum=hash.digest('hex'),path=join(root,row.id+'-'+kind+'-'+checksum);await rename(temp,path);temp=undefined;const mime=response.headers.get('content-type')?.split(';')[0]??'application/octet-stream';const version=checksum;this.store.run('INSERT INTO message_asset_versions(asset_id,read_kind,state,version,hash,size,media_type,path,reason,updated_at) VALUES(?,?,\'ready\',?,?,?,?,?,NULL,?) ON CONFLICT(asset_id,read_kind) DO UPDATE SET state=excluded.state,version=excluded.version,hash=excluded.hash,size=excluded.size,media_type=excluded.media_type,path=excluded.path,reason=NULL,updated_at=excluded.updated_at',row.id,kind,version,checksum,size,mime,path,this.now());return{state:'ready',assetId:row.id,kind:descriptor.kind,version,sha256:checksum,size,mediaType:mime};
  }catch(error){if(!alternative&&error instanceof AssetJsonError&&(readBusiness||this.transport.readAlternative)){if(temp){await unlink(temp).catch(()=>{});temp=undefined;}return this.download(row,kind,true,{state:error.state,reason:error.reason},readBusiness);}const failure=error instanceof AssetJsonError?{state:error.state,reason:error.reason}:{state:'failed',reason:'asset_fetch_failed'}as const;this.state(row.id,kind,failure);return failure;}finally{if(temp)await unlink(temp).catch(()=>{});}}
 private state(id:string,kind:AssetReadKind,value:AssetUnavailable){this.store.run('INSERT INTO message_asset_versions(asset_id,read_kind,state,reason,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(asset_id,read_kind) DO UPDATE SET state=excluded.state,reason=excluded.reason,updated_at=excluded.updated_at',id,kind,value.state,safeReason(value.reason),this.now());}
 /** Bounded index-driven cleanup. References, not a window deletion, decide retention. */
 cleanup(now=this.now(),limit=100){const rows=this.store.all<Row&{rowId:number}>('SELECT rowid rowId,id,scope_json,descriptor_json FROM message_assets WHERE rowid>? AND created_at<? ORDER BY rowid LIMIT ?',this.cleanupCursor,now-86400000,limit);let deleted=0;
  const has=(name:string)=>!!this.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?",name);
  for(const row of rows){this.cleanupCursor=row.rowId;if([...this.active.keys()].some(k=>k.startsWith(row.id+':')))continue;const source=JSON.parse(row.scope_json)as AssetSourceScope;
   const inGroup=has('group_live_messages')&&!!this.store.one('SELECT sequence FROM group_live_messages WHERE connection_id=? AND chat_id=? AND message_id=? LIMIT 1',source.connectionId,source.chatId,source.messageId);
   const inInbox=has('channel_inbox')&&!!this.store.one("SELECT id FROM channel_inbox WHERE connection_id=? AND CASE WHEN json_valid(event_json) THEN json_extract(event_json,'$.message.id') END=? LIMIT 1",source.connectionId,source.messageId);
   const inBatch=has('group_live_batches')&&!!this.store.one("SELECT g.id FROM group_live_batches g,json_each(CASE WHEN json_valid(g.guard_json) THEN g.guard_json ELSE '{}' END,'$.assetIds') a WHERE a.value=? LIMIT 1",row.id);
   if(inGroup||inInbox||inBatch)continue;
   this.store.transaction(()=>{this.store.run("DELETE FROM message_asset_links WHERE asset_id=? AND owner_kind='window'",row.id);this.store.run("DELETE FROM message_asset_run_grants WHERE asset_id=? AND NOT EXISTS(SELECT id FROM tasks WHERE id=message_asset_run_grants.task_id)",row.id);this.store.run("DELETE FROM message_asset_links WHERE asset_id=? AND owner_kind='task' AND NOT EXISTS(SELECT id FROM tasks WHERE id=message_asset_links.owner_id)",row.id);
    if(this.store.one('SELECT asset_id FROM message_asset_links WHERE asset_id=? LIMIT 1',row.id)||this.store.one('SELECT asset_id FROM message_asset_run_grants WHERE asset_id=? LIMIT 1',row.id))return;
    const files=this.store.all<{path:string}>('SELECT path FROM message_asset_versions WHERE asset_id=? AND path IS NOT NULL',row.id);for(const f of files){try{const info=lstatSync(f.path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw Error('asset_cache_unsafe');unlinkSync(f.path);}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}}
    this.store.run('DELETE FROM message_asset_versions WHERE asset_id=?',row.id);this.store.run('DELETE FROM message_assets WHERE id=?',row.id);deleted++;
   });
  }
  if(rows.length<limit)this.cleanupCursor=0;return{deleted,more:rows.length===limit};
 }
 /** Incremental directory walk; no full-directory listing or content buffering. */
 cleanupCache(now=this.now(),limit=100){let deleted=0;if(!this.cacheScan){try{const root=lstatSync(this.cacheRoot);if(!root.isDirectory()||root.isSymbolicLink()||(root.mode&0o077)!==0)throw Error('asset_cache_unsafe');this.cacheScanRoot=realpathSync(this.cacheRoot);this.cacheScan=opendirSync(this.cacheScanRoot);}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT')return{deleted,more:false};throw error;}}
  for(let i=0;i<limit;i++){const entry=this.cacheScan.readSync();if(!entry){this.cacheScan.closeSync();this.cacheScan=undefined;return{deleted,more:false};}if(!/^[a-f0-9-]{36}(?:\.part|-(?:content|summary|transcript)-[a-f0-9]{64})$/.test(entry.name))continue;const path=join(this.cacheScanRoot,entry.name),info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||now-info.mtimeMs<86400000)continue;const id=entry.name.slice(0,36);if([...this.active.keys()].some(k=>k.startsWith(id+':'))||this.store.one('SELECT asset_id FROM message_asset_versions WHERE path=?',path))continue;unlinkSync(path);deleted++;}
  return{deleted,more:true};
 }
 close(){this.cacheScan?.closeSync();this.cacheScan=undefined;}
 /** Explicit platform retry after permission/config changes; model polling cannot bypass cached terminal failures. */
 invalidate(id:string,kind:AssetReadKind){this.store.run('DELETE FROM message_asset_versions WHERE asset_id=? AND read_kind=?',id,kind);}
 async waitForIdle(){await Promise.allSettled([...this.active.values()]);}
}
