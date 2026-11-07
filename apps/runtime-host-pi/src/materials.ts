import {MAX_RUNTIME_MATERIAL_BYTES} from '@dentity/contracts';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,lstatSync,openSync,closeSync,fstatSync,constants,unlinkSync,type BigIntStats} from 'node:fs';
import {join} from 'node:path';
import type {ContentRef,RuntimeAuthorizationContext,InvocationContext} from '@dentity/domain';
import {MODEL_PROTOCOLS}from'@dentity/contracts';
import type {RuntimeBlobRef,RuntimeConfigurationPackage,RuntimeRunMaterials,RuntimeRequest} from '@dentity/contracts';
import type {TrustedResolver,ResolvedModelProfile} from './types.js';
import type {RegisteredMcpServer} from './resources.js';
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x:unknown)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const scope=(c:RuntimeAuthorizationContext)=>{const {expiresAt,...rest}=c as RuntimeAuthorizationContext&{authenticatedActorRef?:string};delete rest.authenticatedActorRef;return rest;};
const key=(v:unknown)=>digest(v);
/** Passive, private CAS and per-Run manifests. No business HTTP client or database access. */
export class PassiveMaterials implements TrustedResolver {
 constructor(readonly root:string){mkdirSync(root,{recursive:true,mode:0o700});const s=lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0||process.getuid&&s.uid!==process.getuid())throw Error('unsafe_materials_directory');}
 private path(kind:string,id:string){if(!/^[a-f0-9]{64}$/.test(id))throw Error('invalid_material_digest');return join(this.root,kind+'-'+id);}
 private read<T>(kind:string,id:string):T{const p=this.path(kind,id),s=lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0||process.getuid&&s.uid!==process.getuid())throw Error('unsafe_material_file');return JSON.parse(readFileSync(p,'utf8')) as T;}
 private immutable(kind:string,id:string,value:unknown){const p=this.path(kind,id),bytes=canonical(value);if(existsSync(p)){if(canonical(this.read(kind,id))!==bytes)throw Error('material_version_conflict');return;}writeFileSync(p,bytes,{mode:0o600,flag:'wx'});}
 private checkedBlobs=new Map<string,string>();
 private fingerprint(s:BigIntStats){return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');}
 private safeBlob(s:BigIntStats){if(!s.isFile()||(s.mode&0o077n)!==0n||process.getuid&&s.uid!==BigInt(process.getuid()))throw Error('unsafe_material_file');}
 private blob(ref:RuntimeBlobRef,checkOnly=false):Buffer|undefined {
  if(!Number.isSafeInteger(ref?.byteLength)||ref.byteLength<0||ref.byteLength>MAX_RUNTIME_MATERIAL_BYTES)throw Error('invalid_material_length');
  const fd=openSync(this.path('blob',ref.sha256),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const before=fstatSync(fd,{bigint:true});this.safeBlob(before);const stamp=this.fingerprint(before);
   if(before.size!==BigInt(ref.byteLength))throw Error('material_integrity_mismatch');
   // Repeated prepare/status checks need only stat unchanged, previously hashed bytes.
   // Actual resource consumption always hashes the same opened buffer it returns.
   if(checkOnly&&this.checkedBlobs.get(ref.sha256)===stamp)return;
   const bytes=readFileSync(fd),after=fstatSync(fd,{bigint:true});this.safeBlob(after);
   if(this.fingerprint(after)!==stamp||bytes.length!==ref.byteLength||createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw Error('material_integrity_mismatch');
   this.checkedBlobs.set(ref.sha256,stamp);return bytes;
  }finally{closeSync(fd);}
 }
 putBlob(bytes:Buffer,sha:string){
  if(bytes.length>MAX_RUNTIME_MATERIAL_BYTES||createHash('sha256').update(bytes).digest('hex')!==sha)throw Error('material_integrity_mismatch');
  const p=this.path('blob',sha),existing=lstatSync(p,{bigint:true,throwIfNoEntry:false});if(existing)this.safeBlob(existing);if(existing){try{this.blob({sha256:sha,byteLength:bytes.length},true);return;}catch(e){if(!(e instanceof Error)||e.message!=='material_integrity_mismatch')throw e;}}
  // Repair only a missing or safely owned corrupted CAS file, never an unsafe path.
  if(existsSync(p)){const s=lstatSync(p,{bigint:true});this.safeBlob(s);if(s.isSymbolicLink())throw Error('unsafe_material_file');}
  const tmp=p+'.'+randomUUID()+'.tmp';try{writeFileSync(tmp,bytes,{mode:0o600,flag:'wx'});renameSync(tmp,p);this.checkedBlobs.delete(sha);}finally{if(existsSync(tmp))unlinkSync(tmp);}
 }
 missing(refs:readonly RuntimeBlobRef[]){if(!Array.isArray(refs)||refs.length>2048)throw Error('invalid_material_manifest');return refs.filter(r=>{try{this.blob(r,true);return false;}catch{return true;}});}
 private bytes(ref:RuntimeBlobRef){return this.blob(ref)!;}
 private configuration(id:string){const cfg=this.read<RuntimeConfigurationPackage>('config',id),{configurationId,...body}=cfg;if(cfg.version!==1||configurationId!==id||digest(body)!==id)throw Error('configuration_digest_mismatch');return cfg;}
 putConfiguration(v:RuntimeConfigurationPackage){if(v?.model?.protocol!==undefined&&!(MODEL_PROTOCOLS as readonly unknown[]).includes(v.model.protocol))throw Error('model_protocol_unsupported');if(v?.version!==1||!v.model||!v.model.apiKey||!v.model.provider||!v.model.modelId||v.skills.length>256||v.mcp.length>256)throw Error('invalid_configuration_package');for(const r of [...v.skills,...v.mcp])this.bytes(r.blob);const {configurationId,...body}=v;if(digest(body)!==configurationId)throw Error('configuration_digest_mismatch');this.immutable('config',configurationId,v);return this.inspect(configurationId);}
 inspect(id:string){const cfg=this.configuration(id),missing=this.missing([...cfg.skills,...cfg.mcp].map(x=>x.blob));return{version:1,configurationId:id,modelProtocol:cfg.model.protocol??'chat_completions',fetched:id,prepared:missing.length?null:id,resources:missing.length?'not_ready':'ready',sdk:'initializes_on_submit',modelInput:cfg.model.inputCapabilities?.image==='passed'?['text','image']:['text'],...(missing.length?{missing,reason:'configuration_materials_missing_or_corrupt'}:{})};}
 putRun(v:RuntimeRunMaterials){if(v?.version!==1||v.context.authorizationRef!==v.execution.executionId||v.spec.workspaceId!==v.context.workspaceId||v.spec.entityId!==v.context.entityId||v.spec.authorizationRef!==v.context.authorizationRef||v.execution.runtime.workspaceId!==v.context.workspaceId||v.execution.runtime.entityId!==v.context.entityId)throw Error('material_scope_mismatch');if(this.inspect(v.configurationId).prepared!==v.configurationId)throw Error('configuration_materials_not_ready');if((v.context as InvocationContext).sessionId!==v.execution.sessionId||(v.context as InvocationContext).invocationId!==v.execution.invocationId||canonical((v.context as InvocationContext).target)!==canonical(v.execution.target))throw Error('material_execution_mismatch');for(const r of v.contents)this.bytes(r.blob);for(const a of v.assets)for(const r of Object.values(a.reads))if(r&&'sha256'in r)this.bytes(r);const id=key(v.context.authorizationRef),p=this.path('run',id);const prior=existsSync(p)?this.read<RuntimeRunMaterials>('run',id):undefined;
 if((v.context as InvocationContext).trigger?.kind==='work_item_assignment'&&!v.continuation&&!v.workItemLaunchGate)throw Error('work_item_launch_gate_required');
 if(v.workItemLaunchGate&&(v.workItemLaunchGate.version!==1||v.workItemLaunchGate.workspaceId!==v.context.workspaceId||(v.context as InvocationContext).trigger?.kind!=='work_item_assignment'||v.continuation))throw Error('work_item_launch_gate_scope');
 if(v.workItems&&(v.workItems.version!==1||v.workItems.runId!==v.execution.executionId||!v.workItems.hostId||!v.workItems.credential))throw Error('work_item_material_scope_mismatch');
 if(v.triggerHistory&&(v.triggerHistory.version!==1||v.triggerHistory.runId!==v.context.authorizationRef||!v.triggerHistory.hostId||(v.context as InvocationContext).trigger?.kind!=='configured_event'))throw Error('trigger_history_material_mismatch');
 if(v.groupHistory&&(v.groupHistory.version!==1||v.groupHistory.runId!==v.context.authorizationRef||!v.groupHistory.hostId))throw Error('group_history_material_mismatch');
 if(prior){if(canonical(prior.triggerHistory??null)!==canonical(v.triggerHistory??null))throw Error('trigger_history_material_conflict');if(canonical(prior.workItemLaunchGate??null)!==canonical(v.workItemLaunchGate??null))throw Error('work_item_launch_gate_conflict');if(canonical(prior.workItems??null)!==canonical(v.workItems??null)||canonical(prior.groupHistory??null)!==canonical(v.groupHistory??null))throw Error('group_history_material_conflict');if(canonical(prior.continuation??null)!==canonical(v.continuation??null))throw Error('continuation_material_conflict');if(prior.configurationId!==v.configurationId||canonical(prior.spec)!==canonical(v.spec)||canonical(prior.execution)!==canonical(v.execution)||canonical(scope(prior.context))!==canonical(scope(v.context)))throw Error('run_material_conflict');for(const old of prior.contents)if(!v.contents.some(x=>canonical(x)===canonical(old)))throw Error('immutable_input_changed');for(const old of prior.assets)for(const [kind,read]of Object.entries(old.reads))if(read&&'sha256'in read&&canonical(v.assets.find(a=>a.assetId===old.assetId)?.reads[kind as 'content'])!==canonical(read))throw Error('immutable_asset_changed');}
 const tmp=p+'.'+randomUUID()+'.tmp';writeFileSync(tmp,canonical(v),{mode:0o600,flag:'wx'});renameSync(tmp,p);return{version:1,status:'prepared',configurationId:v.configurationId};}
 workItemLaunchGate(c:RuntimeAuthorizationContext){return this.run(c).workItemLaunchGate;}
 workItems(c:RuntimeAuthorizationContext){return this.run(c).workItems;}
 triggerHistory(c:RuntimeAuthorizationContext){return this.run(c).triggerHistory;}
 groupHistory(c:RuntimeAuthorizationContext){return this.run(c).groupHistory;}
 configurationId(c:RuntimeAuthorizationContext){return this.run(c).configurationId;}
 continuation(c:RuntimeAuthorizationContext){return this.run(c).continuation;}
 has(c:RuntimeAuthorizationContext){return !!c&&existsSync(this.path('run',key(c.authorizationRef)));}
 private run(c:RuntimeAuthorizationContext){const r=this.read<RuntimeRunMaterials>('run',key(c.authorizationRef));if(canonical(scope(r.context))!==canonical(scope(c)))throw Error('material_scope_mismatch');return r;}
 async verify(q:RuntimeRequest<unknown,RuntimeAuthorizationContext>){try{if(q.schemaVersion!==1||!['operationId','correlationId','causationId'].every(k=>typeof q[k as keyof typeof q]==='string'&&(q[k as keyof typeof q] as string).length>0)||!Number.isFinite(Date.parse(q.authorizationContext.expiresAt))||!Number.isFinite(Date.parse(q.deadlineAt))||Date.parse(q.deadlineAt)<=Date.now()||Date.parse(q.authorizationContext.expiresAt)<=Date.now())return false;const r=this.run(q.authorizationContext);if(q.correlationId!==r.execution.executionId)return false;const p=q.payload as Record<string,unknown>;
 if(p['spec']&&canonical(p['spec'])!==canonical(r.spec))return false;const h=p['handle'] as {specHash?:string;specId?:string;isolationScope?:{authorizationRef?:string}}|undefined;if(h&&(h.specHash!==r.spec.specHash||h.specId!==r.spec.specId||h.isolationScope?.authorizationRef!==r.context.authorizationRef))return false;if(p['execution']&&canonical(p['execution'])!==canonical(r.execution))return false;if(p['sessionId']&&p['sessionId']!==r.execution.sessionId)return false;const session=p['session'] as {sessionId?:string;specHash?:string}|undefined;if(session&&(session.sessionId!==r.execution.sessionId||session.specHash!==r.spec.specHash))return false;
 const actor=(q.authorizationContext as RuntimeAuthorizationContext&{authenticatedActorRef?:string}).authenticatedActorRef;
 return actor===undefined||actor===`task-service:${r.execution.executionId}`||!!(p['viewer']&&actor===`task-record-read:${digest(p['viewer'])}`);
 }catch{return false;}}
 async content(ref:ContentRef,c:RuntimeAuthorizationContext){const r=this.run(c);if(ref.resourceId.startsWith('host-output:'))return this.readOutput(ref,c);const config=this.configuration(r.configurationId);const x=[...r.contents,...config.skills].find(x=>canonical(x.ref)===canonical(ref));if(!x)throw Error('content_not_granted');return this.bytes(x.blob).toString('utf8');}
 async model(_ref:ContentRef,c:RuntimeAuthorizationContext):Promise<ResolvedModelProfile>{const r=this.run(c);if(canonical(_ref)!==canonical(r.spec.modelProfileRef))throw Error('model_not_granted');return this.configuration(r.configurationId).model;}
 async modelAvailable(c:RuntimeAuthorizationContext){this.run(c);return true;}
 async mcp(ref:ContentRef,c:RuntimeAuthorizationContext):Promise<RegisteredMcpServer>{const r=this.run(c),cfg=this.configuration(r.configurationId);const x=cfg.mcp.find(x=>canonical(x.ref)===canonical(ref));if(!x)throw Error('mcp_not_granted');return JSON.parse(this.bytes(x.blob).toString('utf8')) as RegisteredMcpServer;}
 async history(c:RuntimeAuthorizationContext){return this.run(c).history as Awaited<ReturnType<NonNullable<TrustedResolver['history']>>>;}
 async assets(c:RuntimeAuthorizationContext){return this.run(c).assets.map(({reads,...a})=>a);}
 async asset(id:string,kind:'content'|'summary'|'transcript',c:RuntimeAuthorizationContext){const a=this.run(c).assets.find(a=>a.assetId===id),r=a?.reads[kind];if(!r)return{state:'no_permission' as const,reason:'asset_not_granted'};if(!('sha256'in r))return r;return new Response(new Uint8Array(this.bytes(r)),{headers:{'content-type':r.mediaType,'content-length':String(r.byteLength),'x-asset-id':id,'x-asset-sha256':r.sha256,'x-asset-version':r.sha256}});}
 async storeOutput(text:string,c:RuntimeAuthorizationContext){this.run(c);if(Buffer.byteLength(text)>256000)throw Error('output_budget_exceeded');const bytes=Buffer.from(text),sha=createHash('sha256').update(bytes).digest('hex');this.putBlob(bytes,sha);const id=digest([c.authorizationRef,sha]);this.immutable('output',id,{run:c.authorizationRef,sha256:sha,byteLength:bytes.length});return{resourceId:'host-output:'+id,version:'1'};}
 readOutput(ref:ContentRef,c:RuntimeAuthorizationContext){this.run(c);if(ref.version!=='1'||!ref.resourceId.startsWith('host-output:'))throw Error('invalid_output_ref');const x=this.read<RuntimeBlobRef&{run:string}>('output',ref.resourceId.slice(12));if(x.run!==c.authorizationRef)throw Error('output_scope_mismatch');return this.bytes(x).toString('utf8');}
}
export {digest as materialDigest};
