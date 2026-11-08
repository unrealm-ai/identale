import {taskExecutionInstructions,taskExecutionInput} from './task-execution-instructions.js';
import{JsonlJournal}from'@dentity/runtime-builtin';
import {mkdirSync,existsSync,readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {join,dirname} from 'node:path';
import type {RuntimeBlobRef,RuntimeConfigurationPackage,RuntimeRunMaterials} from '@dentity/contracts';
import type {PlatformAssetService} from './assets/service.js';
import {Readable} from 'node:stream';
import {TriggerHistory} from './triggers/history.js';
import{TriggerContextHistory}from'./triggers/context-history.js';
import type {TriggerHistoryItem} from '@dentity/application';
import { unavailableExecutionRecords, type TaskExecutionRecordsReadPort, type ExecutionRecordViewer, type ExecutionRecordQuery, type ExecutionRecordPage, type ExecutionRecordContent } from '@dentity/application';
import {scopeFromJson,scopeRequester,scopeSource} from '@dentity/application';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ContentRef, InvocationContext, RuntimeAuthorizationContext } from '@dentity/domain';
import { resolvedThinkingLevel, type ThinkingLevel } from '@dentity/contracts';
import type { ExecutionRef, PreparedAgentHandle, ResolvedAgentSpec, RuntimeEvent, RuntimeOutcome, RuntimeCapabilities, SessionHandle } from '@dentity/contracts';
import type { CapabilitySnapshot } from './capability-config.js';
import type { TaskCommand, TaskRuntimeClient, TaskRuntimeEvent, TaskRuntimeCapabilities } from './task-runtime.js';
import { TaskError, taskBody, type TaskRow, type TaskService } from './tasks.js';
import type { Store } from './store.js';
import { ModelProfileService } from './model-profiles.js';

/** Trusted internal reads, provided by application services rather than private SQL tables. */
export interface RuntimeTaskAccess {
  eventTrace?(value:{taskId:string;runId:string;sessionId:string;cursor:number;returnedThrough:number;count:number;ok:boolean}):void;
  task(taskId: string): TaskRow;
  todoStartFact?(taskId:string,runId:string):import('@dentity/application').TodoStartFact|undefined;
  executionThinkingLevel(workspaceId: string, entityId: string): ThinkingLevel;
  filterCapabilities?(workspaceId:string,entityId:string,snapshot:CapabilitySnapshot):CapabilitySnapshot;
  skill?(workspaceId:string,ref:ContentRef):unknown;
  mcp?(workspaceId:string,ref:ContentRef):unknown;
  input(taskId: string, revision: number): {text: string} | undefined;
  preparationResources?(workspaceId:string,entityId:string):Pick<CapabilitySnapshot,'skills'|'mcpServers'>;
  retainedMessage(conversationId: string, messageId: string): {text: string} | undefined;
}
export interface RuntimeHostConfig { url: string; token: string; resolverToken?: string; groupHistoryUrl?:string;workItemUrl?:string }
type Binding = { run_id:string; task_id:string; command_json:string; profile_id:string; revision:number; profile_source:string|null; binding_revision:string|null; session_json:string|null; spec_json:string; host_url:string|null; configuration_id:string|null; material_pending_revision:number|null; host_instance_id:string|null; materials_json:string|null };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item);
const fail = (status:number,code:string):never=>{throw new TaskError(status,code);};
/** HTTP transport maps the existing provisioning/session/execution DTOs, not a vendor SDK. */
export class HttpTaskRuntime implements TaskRuntimeClient, TaskExecutionRecordsReadPort {
  readonly idempotentDispatch = true;
  readonly history:TriggerHistory;
  readonly triggerContext:TriggerContextHistory;
  private assetsService?:PlatformAssetService;
  private groupHistoryService?:import("./group-sharing/history.js").GroupHistoryService;
  setGroupHistoryService(service:import("./group-sharing/history.js").GroupHistoryService){this.groupHistoryService=service;}
  private workItemsService?:import('./work-items/service.js').WorkItemsService;
  setWorkItemsService(service:import('./work-items/service.js').WorkItemsService){this.workItemsService=service;}
  async applyWorkItemGate(gate:import('@dentity/contracts').WorkItemLaunchGate){const response=await this.materialCall<import('@dentity/contracts').WorkItemLaunchGate>('work-item-launch-gate',gate);if(canonical(response)!==canonical(gate))throw Error('work_item_gate_conflict');return response;}
  private materialRefreshAt=new Map<string,number>();
  private materialRefreshes=new Map<string,Promise<void>>();
  private materialsClosing=false;
  async drainMaterials(){this.materialsClosing=true;await Promise.all(this.materialRefreshes.values());}
  private preparedConfigurations=new Map<string,{desired:string;fetched:string|null;prepared:string|null;reason:string|null;observedAt:number}>();
  private readonly configurationCache=new Map<string,RuntimeConfigurationPackage>();
  setAssetService(service:PlatformAssetService){this.assetsService=service;}
  preparation(workspaceId:string,entityId:string){return this.preparedConfigurations.get(workspaceId+':'+entityId)??{desired:this.profiles.revisionKey(workspaceId,entityId),fetched:null,prepared:null,reason:'configuration_not_prepared',observedAt:this.now()};}
  async prepareConfigured(){for(const r of this.store.all<{workspace_id:string;id:string}>('SELECT workspace_id,id FROM entities WHERE lifecycle_enabled=1')){
    const p=this.profiles.effective(r.workspace_id,r.id),desired=this.profiles.revisionKey(r.workspace_id,r.id)??'missing';
    const state={desired,fetched:null as string|null,prepared:null as string|null,reason:null as string|null,observedAt:this.now()};
    try{if(!p?.enabled||!p.secretRef)throw Error('model_not_configured');
      const resourceSet=this.tasks.preparationResources?.(r.workspace_id,r.id)??{skills:[],mcpServers:[]};
      state.desired=canonical([desired,resourceSet]);
      const cacheKey=canonical([r.workspace_id,r.id,state.desired]);let cfg=this.configurationCache.get(cacheKey);
      if(!cfg){const model=await this.profiles.resolve({workspaceId:r.workspace_id,entityId:r.id,profileId:p.id,configRevision:p.configRevision,source:p.source,...(p.bindingRevision?{bindingRevision:p.bindingRevision}:{}),purpose:'model-inference'},()=>true);const resources=await this.resourceMaterials(r.workspace_id,resourceSet);cfg=this.configuration({...((model.protocol)?{protocol:model.protocol}:{}),provider:model.provider,modelId:model.modelId,apiKey:model.apiKey,baseUrl:model.endpoint,...(model.inputCapabilities?{inputCapabilities:model.inputCapabilities}:{})},resources.skills,resources.mcp);this.configurationCache.set(cacheKey,cfg);}
      state.fetched=state.desired;await this.ensureConfiguration(cfg);state.prepared=cfg.configurationId;
    }catch(e){state.reason=e instanceof TaskError?e.code:'runtime_preparation_unavailable';}this.preparedConfigurations.set(r.workspace_id+':'+r.id,state);
  }}
  private configuration(model:RuntimeConfigurationPackage['model'],skills:RuntimeConfigurationPackage['skills'],mcp:RuntimeConfigurationPackage['mcp']):RuntimeConfigurationPackage{const body={version:1 as const,model,skills,mcp};return {...body,configurationId:createHash('sha256').update(canonical(body)).digest('hex')};}
  private async materialCall<T=unknown>(name:string,body:unknown):Promise<T>{const r=await fetch(this.config.url.replace(/\/$/,'')+'/v2/materials/'+name,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+this.config.token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('passive_materials_unavailable');return await r.json() as T;}
  private async upload(bytes:Buffer):Promise<RuntimeBlobRef>{const ref={sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length};const root=join(dirname(this.store.databasePath),'host-materials');mkdirSync(root,{recursive:true,mode:0o700});const info=lstatSync(root);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw Error('unsafe_material_cache');const path=join(root,ref.sha256);if(!existsSync(path))writeFileSync(path,bytes,{mode:0o600,flag:'wx'});else this.readMaterialBlob(ref);const missing=await this.materialCall<{missing:RuntimeBlobRef[]}>('missing',[ref]);if(missing.missing.length){const r=await fetch(this.config.url.replace(/\/$/,'')+'/v2/materials/blobs/'+ref.sha256,{method:'PUT',redirect:'error',headers:{authorization:'Bearer '+this.config.token,'content-type':'application/octet-stream'},body:new Uint8Array(bytes),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('material_upload_failed');}return ref;}
  private resourceCache=new Map<string,RuntimeBlobRef>();
  private async resourceMaterials(workspaceId:string,refs:Pick<CapabilitySnapshot,'skills'|'mcpServers'>){
    const skills:RuntimeConfigurationPackage['skills'][number][]=[],mcp:RuntimeConfigurationPackage['mcp'][number][]=[];
    for(const ref of refs.skills){if(!ref.resourceId.startsWith('uploaded-skill-'))continue;const fixed={resourceId:ref.resourceId,version:ref.version,digest:ref.digest},key=canonical(['skill',workspaceId,fixed]);let blob=this.resourceCache.get(key);if(!blob){if(!this.tasks.skill)throw Error('skill_material_unavailable');blob=await this.upload(Buffer.from(JSON.stringify(await this.tasks.skill(workspaceId,{resourceId:ref.resourceId,version:ref.version}))));this.resourceCache.set(key,blob);}skills.push({ref:fixed,blob});}
    for(const ref of refs.mcpServers){if(!ref.version)continue;const fixed={resourceId:ref.serverRef,version:ref.version},key=canonical(['mcp',workspaceId,fixed]);let blob=this.resourceCache.get(key);if(!blob){if(!this.tasks.mcp)throw Error('mcp_material_unavailable');blob=await this.upload(Buffer.from(JSON.stringify(await this.tasks.mcp(workspaceId,fixed))));this.resourceCache.set(key,blob);}mcp.push({ref:fixed,blob});}
    return{skills,mcp};
  }
  private readMaterialBlob(ref:RuntimeBlobRef){const p=join(dirname(this.store.databasePath),'host-materials',ref.sha256);if(!/^[a-f0-9]{64}$/.test(ref.sha256))throw Error('invalid_material_reference');const info=lstatSync(p);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||process.getuid&&info.uid!==process.getuid())throw Error('unsafe_material_cache');const bytes=readFileSync(p);if(bytes.length!==ref.byteLength||createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw Error('material_integrity_mismatch');return bytes;}
  private async inspectConfiguration(id:string,expectedHost?:string){
    type Inspection={version:number;configurationId?:string;prepared:string|null;hostId:string;missing?:RuntimeBlobRef[];modelInput?:string[];modelProtocol?:string};
    let status=await this.materialCall<Inspection>('inspect',{configurationId:id});
    const validate=()=>{if(status.version!==1||!status.hostId)throw Error('passive_protocol_unsupported');if(expectedHost&&status.hostId!==expectedHost)throw new TaskError(409,'runtime_host_replaced_unknown');};validate();
    if(status.prepared!==id&&status.missing?.length){
      // Recover only the exact retained digests, without resolving current model/Skill versions.
      for(const ref of status.missing)await this.upload(this.readMaterialBlob(ref));
      status=await this.materialCall<Inspection>('inspect',{configurationId:id});validate();
    }
    if(status.prepared!==id)throw Error('configuration_materials_not_ready');return status;
  }
  private async ensureConfiguration(cfg:RuntimeConfigurationPackage){
    const verifyInput=(value:{modelInput?:string[];modelProtocol?:string})=>{if(cfg.model.protocol&&cfg.model.protocol!=='chat_completions'&&value.modelProtocol!==cfg.model.protocol)throw Error('host_model_protocol_unsupported');if(cfg.model.inputCapabilities?.image==='passed'&&!value.modelInput?.includes('image'))throw Error('host_image_input_protocol_unsupported');};
    try{const status=await this.inspectConfiguration(cfg.configurationId);verifyInput(status);return status;}catch{/* New configuration/cache loss requires exact materialization. */}
    for(const r of [...cfg.skills,...cfg.mcp])await this.upload(this.readMaterialBlob(r.blob));
    const status=await this.materialCall<{version:number;prepared:string|null;hostId:string;modelInput?:string[];modelProtocol?:string}>('configuration',cfg);verifyInput(status);if(status.version!==1||status.prepared!==cfg.configurationId||typeof status.hostId!=='string'||!status.hostId)throw Error('passive_protocol_unsupported');return status;
  }
  private async prepareMaterials(binding:Binding,revision:number){
    const c=this.context(binding),spec=JSON.parse(binding.spec_json) as ResolvedAgentSpec,command=JSON.parse(binding.command_json) as TaskCommand;
    const resourceScope={workspaceId:c.workspaceId,entityId:c.entityId,taskId:binding.task_id,runId:binding.run_id};
    await this.assetsService?.revalidateBusinessResourcesForRun(resourceScope);
    const configKey=canonical([binding.run_id,spec.specHash]);let cfg=this.configurationCache.get(configKey),preparedId:string|undefined;
    if(binding.configuration_id){try{const status=await this.inspectConfiguration(binding.configuration_id,binding.host_instance_id??undefined);preparedId=binding.configuration_id;if(!binding.host_instance_id)this.store.run('UPDATE task_host_bindings SET host_instance_id=? WHERE run_id=?',status.hostId,binding.run_id);}catch(e){if(e instanceof TaskError)throw e;/* Reconstruct only the fixed version; no execution replay. */}}
    if(!preparedId){
      if(!cfg){const model=await this.profiles.resolve({workspaceId:c.workspaceId,entityId:c.entityId,profileId:binding.profile_id,configRevision:binding.revision,...(binding.profile_source?{source:binding.profile_source as 'selection'|'workspace_default'}:{}),...(binding.binding_revision?{bindingRevision:binding.binding_revision}:{}),purpose:'model-inference'},()=>true);
        const resources=await this.resourceMaterials(c.workspaceId,spec);cfg=this.configuration({...((model.protocol)?{protocol:model.protocol}:{}),provider:model.provider,modelId:model.modelId,apiKey:model.apiKey,baseUrl:model.endpoint,...(model.inputCapabilities?{inputCapabilities:model.inputCapabilities}:{})},resources.skills,resources.mcp);this.configurationCache.set(configKey,cfg);
      }
      const prepared=await this.ensureConfiguration(cfg);if(binding.host_instance_id&&prepared.hostId!==binding.host_instance_id)throw new TaskError(409,'runtime_host_replaced_unknown');preparedId=cfg.configurationId;
      this.store.run('UPDATE task_host_bindings SET host_instance_id=? WHERE run_id=?',prepared.hostId,binding.run_id);
      this.store.run('UPDATE task_host_bindings SET configuration_id=? WHERE run_id=?',preparedId,binding.run_id);
    }
    const retained=binding.materials_json?JSON.parse(binding.materials_json) as {inputRevision:number;packet:RuntimeRunMaterials}:undefined;
    const refs=[spec.instructions,{resourceId:`context:${binding.run_id}`,version:'1'},...Array.from({length:revision},(_,i)=>({resourceId:`input:${binding.run_id}:${i+1}`,version:String(i+1)}))];
    const contents=[...(retained?.packet.contents??[])];for(const ref of refs){const old=contents.find(x=>canonical(x.ref)===canonical(ref));if(old)await this.upload(this.readMaterialBlob(old.blob));else contents.push({ref,blob:await this.upload(Buffer.from(await this.content(ref,c)))});}
    const assets:RuntimeRunMaterials['assets'][number][]=[];
    if(this.assetsService){const scope={workspaceId:c.workspaceId,entityId:c.entityId,taskId:binding.task_id,runId:binding.run_id};await this.assetsService.revalidateBusinessResourcesForRun(scope);for(const asset of this.assetsService.listForRun(scope)){
      const reads:RuntimeRunMaterials['assets'][number]['reads']={};for(const kind of ['content','summary','transcript'] as const){const response=await this.assetsService.streamForRun(scope,asset.assetId,kind);if(response instanceof Response){if(!response.ok)throw Error('asset_prepare_failed');const data=Buffer.from(await response.arrayBuffer());const expected=response.headers.get('x-asset-sha256');const blob=await this.upload(data);if(expected!==blob.sha256)throw Error('asset_prepare_integrity');reads[kind]={...blob,mediaType:response.headers.get('content-type')??'application/octet-stream'};}else reads[kind]=response;}assets.push({...asset,reads});}}
    const workItems=spec.platformTools.includes('work.item')&&this.workItemsService?.toolsEnabled(command.taskId)&&this.config.workItemUrl?this.workItemsService.access(binding.run_id,this.binding(binding.run_id).host_instance_id!,this.config.workItemUrl):undefined;
    const groupHistory=spec.platformTools.includes('group.history')&&this.groupHistoryService&&this.config.groupHistoryUrl?this.groupHistoryService.access(binding.run_id,this.binding(binding.run_id).host_instance_id!,this.config.groupHistoryUrl,retained?.packet.groupHistory):undefined;
    const triggerHistory=spec.platformTools.includes('trigger.history')&&this.config.groupHistoryUrl?this.triggerContext.access(binding.run_id,this.binding(binding.run_id).host_instance_id!,this.config.groupHistoryUrl.replace(/group-history$/,'trigger-history'),retained?.packet.triggerHistory):undefined;
    const packet:RuntimeRunMaterials={...(triggerHistory?{triggerHistory}:{}),...(command.assignment&&!command.continuation?{workItemLaunchGate:{version:1 as const,workspaceId:command.workspaceId}}:{}),...(groupHistory?{groupHistory}:{}),...(workItems?{workItems}:{}),version:1,configurationId:preparedId,context:c,spec,execution:this.execution(binding),contents,assets,history:retained?retained.packet.history:triggerHistory?{version:2,mode:'on_demand'}:command.triggerEvent?this.history.read(binding.run_id):null,...(command.continuation?{continuation:command.continuation}:{})};
    await this.assetsService?.revalidateBusinessResourcesForRun(resourceScope);
    const ready=await this.materialCall<{version:number;status:string;configurationId:string}>('run',packet);if(ready.version!==1||ready.status!=='prepared'||ready.configurationId!==preparedId)throw Error('run_materials_not_ready');
    const pending=assets.some(a=>Object.values(a.reads).some(r=>r&&'state'in r&&r.state==='pending'));const keptRevision=Math.max(retained?.inputRevision??0,revision);this.store.run("UPDATE task_host_bindings SET material_pending_revision=?,materials_json=? WHERE run_id=? AND (materials_json IS NULL OR json_extract(materials_json,'$.inputRevision')<=?)",pending?keptRevision:null,JSON.stringify({inputRevision:keptRevision,packet}),binding.run_id,keptRevision);
    this.preparedConfigurations.set(c.workspaceId+':'+c.entityId,{desired:spec.sourceVersions.entityConfig,fetched:spec.sourceVersions.entityConfig,prepared:preparedId,reason:null,observedAt:this.now()});
  }

  constructor(readonly store:Store,readonly profiles:ModelProfileService,readonly config:RuntimeHostConfig,readonly now:()=>number, readonly tasks:RuntimeTaskAccess) {
    store.db.exec('CREATE TABLE IF NOT EXISTS task_artifact_manifests(run_id TEXT PRIMARY KEY,refs_json TEXT NOT NULL)');
    this.history=new TriggerHistory(store,now);this.triggerContext=new TriggerContextHistory(store,new JsonlJournal({root:join(dirname(store.databasePath),'trigger-context-journal'),ownerId:store.databaseId,serialize:fn=>store.transaction(fn)}),now,r=>this.rawRecords(r),r=>this.exportRawRecord(r));
    const url=new URL(config.url);
    if (!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||config.token.length<32||(config.resolverToken!==undefined&&config.resolverToken.length<32)) throw new Error('Runtime requires loopback URL and distinct high-entropy bearer configuration');
    if(config.resolverToken&&config.token===config.resolverToken)throw new Error('Runtime and resolver tokens must be distinct');
    store.db.exec(`CREATE TABLE IF NOT EXISTS task_host_bindings(run_id TEXT PRIMARY KEY REFERENCES runs(id),task_id TEXT NOT NULL REFERENCES tasks(id),command_json TEXT NOT NULL,profile_id TEXT NOT NULL,revision INTEGER NOT NULL,session_json TEXT,spec_json TEXT NOT NULL,host_url TEXT);
      CREATE TABLE IF NOT EXISTS task_runtime_capabilities(run_id TEXT PRIMARY KEY REFERENCES runs(id),binding_hash TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_outputs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),text TEXT NOT NULL);`);
    if(!store.all<{name:string}>('PRAGMA table_info(task_host_bindings)').some(column=>column.name==='binding_revision'))store.db.exec('ALTER TABLE task_host_bindings ADD COLUMN binding_revision TEXT');
    if(!store.all<{name:string}>('PRAGMA table_info(task_host_bindings)').some(column=>column.name==='materials_json'))store.db.exec('ALTER TABLE task_host_bindings ADD COLUMN materials_json TEXT');
    if(!store.all<{name:string}>('PRAGMA table_info(task_host_bindings)').some(column=>column.name==='host_instance_id'))store.db.exec('ALTER TABLE task_host_bindings ADD COLUMN host_instance_id TEXT');
    if(!store.all<{name:string}>('PRAGMA table_info(task_host_bindings)').some(column=>column.name==='material_pending_revision'))store.db.exec('ALTER TABLE task_host_bindings ADD COLUMN material_pending_revision INTEGER');
    if(!store.all<{name:string}>('PRAGMA table_info(task_host_bindings)').some(column=>column.name==='configuration_id'))store.db.exec('ALTER TABLE task_host_bindings ADD COLUMN configuration_id TEXT');
    if(!store.all<{name:string}>('PRAGMA table_info(task_host_bindings)').some(column=>column.name==='profile_source'))store.db.exec('ALTER TABLE task_host_bindings ADD COLUMN profile_source TEXT');
    if(!store.all<{name:string}>('PRAGMA table_info(task_host_bindings)').some(column=>column.name==='host_url'))store.db.exec('ALTER TABLE task_host_bindings ADD COLUMN host_url TEXT');
  }
  storeOutput(runId:string,text:string) {
    const id=randomUUID();
    this.store.run('INSERT INTO runtime_outputs VALUES(?,?,?)',id,runId,text);
    return {resourceId:id,version:'1'};
  }
  private async call<T>(method:string,request:unknown):Promise<T> {
    const response=await fetch(`${this.config.url.replace(/\/$/,'')}/v1/${method}`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${this.config.token}`,'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Runtime transport unavailable');
    return await response.json() as T;
  }
  private binding(runId:string) {const binding=this.store.one<Binding>('SELECT * FROM task_host_bindings WHERE run_id=?',runId)??fail(404,'runtime_binding_not_found');if(binding.host_url!==this.config.url)return fail(409,'runtime_binding_changed');return binding;}
  private capabilityBinding(binding:Binding) { return createHash('sha256').update(canonical({url:this.config.url,boundUrl:binding.host_url,runId:binding.run_id,profileId:binding.profile_id,source:binding.profile_source,revision:binding.revision,bindingRevision:binding.binding_revision,spec:binding.spec_json})).digest('hex'); }
  capabilities(runId:string):TaskRuntimeCapabilities|undefined {
    const binding=this.store.one<Binding>('SELECT * FROM task_host_bindings WHERE run_id=?',runId);
    if(!binding||binding.host_url!==this.config.url)return undefined;
    const row=this.store.one<{binding_hash:string;json:string}>('SELECT * FROM task_runtime_capabilities WHERE run_id=?',runId);
    if(!row||row.binding_hash!==this.capabilityBinding(binding))return undefined;
    try{const value=JSON.parse(row.json) as TaskRuntimeCapabilities;return value.runId===runId&&value.expiresAt>this.now()?value:undefined;}catch{return undefined;}
  }
  async refreshCapabilities(runId:string):Promise<void> {
    const binding=this.store.one<Binding>('SELECT * FROM task_host_bindings WHERE run_id=?',runId);
    if(!binding||binding.host_url!==this.config.url)return;
    try{
      const response=await this.call<RuntimeOutcome<RuntimeCapabilities>>('capabilities',this.request(binding,`capabilities:${runId}`,{runtime:this.execution(binding).runtime},true));
      if(!response.ok||canonical(response.value.runtime)!==canonical(this.execution(binding).runtime)||!response.value.runtimeVersion||response.value.available.status!=='supported')throw new Error('Unverified capabilities');
      const role=response.value.roles.find(role=>role.role==='execution');
      if(!role||role.support.status!=='supported')throw new Error('Execution capabilities unavailable');
      const support=(name:'appendInput'|'cancel')=>{const state=role.capabilities[name]?.status;return state==='supported'||state==='unsupported'?state:'unknown';};
      const value:TaskRuntimeCapabilities={runId,runtimeId:response.value.runtime.runtimeId,runtimeVersion:response.value.runtimeVersion,bindingVersion:this.capabilityBinding(binding),observedAt:this.now(),expiresAt:this.now()+60000,appendInput:support('appendInput'),cancel:support('cancel'),thinkingLevels:Object.fromEntries((['none','low','medium','high'] as const).map(level=>[level,role.thinkingLevels?.[level]?.status??'unknown']))};
      this.store.run('INSERT INTO task_runtime_capabilities VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET binding_hash=excluded.binding_hash,json=excluded.json',runId,value.bindingVersion,JSON.stringify(value));
    }catch{this.store.run('DELETE FROM task_runtime_capabilities WHERE run_id=?',runId);}
  }
  context(binding:Binding,records=false):InvocationContext {
    const command=JSON.parse(binding.command_json) as TaskCommand;
    const task=records?(this.store.one<TaskRow>('SELECT * FROM tasks WHERE id=?',binding.task_id)??fail(404,'task_not_found')):this.tasks.task(binding.task_id);
    const spec=JSON.parse(binding.spec_json) as ResolvedAgentSpec;
    const scope=scopeFromJson(task.source_json,{workspaceId:task.workspace_id,entityId:task.entity_id,userId:task.user_id});
    if(command.workspaceId!==task.workspace_id||command.entityId!==task.entity_id||command.taskId!==task.id||(!records&&command.runId!==task.run_id))return fail(403,'runtime_actor_mismatch');
    if(records&&!this.store.one('SELECT 1 FROM runs WHERE id=? AND task_id=? AND session_id=?',command.runId,task.id,command.sessionId))return fail(403,'runtime_actor_mismatch');
    if(records){
      let session:SessionHandle|null;try{session=JSON.parse(binding.session_json??'null') as SessionHandle|null;}catch{return fail(403,'runtime_actor_mismatch');}
      if(!session||session.role!=='execution'||session.sessionId!==command.sessionId||session.scope.kind!=='execution'||session.scope.taskId!==task.id||session.scope.runId!==command.runId||canonical(session.runtime)!==canonical(this.execution(binding).runtime))return fail(403,'runtime_actor_mismatch');
    }
    const common={workspaceId:command.workspaceId,entityId:command.entityId,authorizationRef:command.runId,expiresAt:new Date(this.now()+360000).toISOString(),grantRef:command.runId,triggerId:scope.business?.triggerId??task.operation_id,sourceEventRef:scope.business?.eventRecordId??scope.source?.sourceEventId??task.operation_id,configRevision:spec.thinkingLevel!==undefined?spec.sourceVersions.entityConfig:binding.profile_source?JSON.stringify([binding.profile_source,binding.profile_id,binding.revision,binding.binding_revision]):String(binding.revision),invocationId:command.runId,sessionId:command.sessionId,target:{kind:'task_run' as const,taskId:command.taskId,runId:command.runId}};
    if(scope.assignment){if(command.requester||command.triggerEvent||canonical(command.assignment)!==canonical(scope.assignment)||task.conversation_id!==null)return fail(403,'runtime_actor_mismatch');return{...common,trigger:{kind:'work_item_assignment',workItemId:scope.assignment.workItemId,assignmentId:scope.assignment.assignmentId,grantRef:scope.assignment.grantId}};}
    if(scope.business){if(command.requester||canonical(command.triggerEvent)!==canonical(scope.business)||task.conversation_id!==null)return fail(403,'runtime_actor_mismatch');return{...common,trigger:{kind:'configured_event',triggerBindingId:scope.business.triggerId}};}
    if(command.triggerEvent||!command.requester||canonical(command.requester)!==canonical(scopeRequester(scope))||task.conversation_id===null)return fail(403,'runtime_actor_mismatch');const source=scopeSource(scope);
    return{...common,trigger:{kind:'human_request',requester:command.requester},sourceChannel:{channelType:source.channelType,tenantId:source.tenantId,installationId:scope.source?source.installationId:'platform-web'},conversation:{conversationId:task.conversation_id,kind:source.conversationKind,...(scope.source?.threadId?{threadId:scope.source.threadId}:{})}};
  }

  private request(binding:Binding,operationId:string,payload:unknown,management=false,records=false) {
    const context=this.context(binding,records);
    return {schemaVersion:1,operationId,correlationId:binding.run_id,causationId:operationId,deadlineAt:new Date(this.now()+30000).toISOString(),authorizationContext:management?{...context,authenticatedActorRef:`task-service:${binding.run_id}`}:context,payload};
  }
  private execution(binding:Binding):ExecutionRef {
    const command=JSON.parse(binding.command_json) as TaskCommand;
    return {runtime:{runtimeId:'local-pi',workspaceId:command.workspaceId,entityId:command.entityId},executionId:command.runId,sessionId:command.sessionId,invocationId:command.runId,target:{kind:'task_run',taskId:command.taskId,runId:command.runId}};
  }
  async dispatch(command:TaskCommand):Promise<{status:'accepted'|'rejected'|'unknown'}> {
    let binding=this.store.one<Binding>('SELECT * FROM task_host_bindings WHERE run_id=?',command.runId);
    if(binding&&binding.host_url!==this.config.url)return {status:'unknown'};
    if(!command.continuation){if((binding&&!JSON.parse(binding.spec_json).platformTools.includes('trigger.history'))||!binding&&!this.config.groupHistoryUrl)await this.history.prepare(command.taskId,command.runId,run=>this.rawRecords(run));else this.triggerContext.freeze(command.taskId);}
    if(command.continuation)await this.assetsService?.prepareBusinessContinuation({workspaceId:command.workspaceId,entityId:command.entityId,taskId:command.taskId,runId:command.runId},command.continuation.parentRunId);
    if(!binding&&command.continuation){
      const parent=this.store.one<Binding>('SELECT * FROM task_host_bindings WHERE run_id=? AND task_id=?',command.continuation.parentRunId,command.taskId);
      if(!parent?.configuration_id||!parent.materials_json||parent.host_url!==this.config.url)throw new TaskError(409,'human_parent_materials_unavailable');
      const original=JSON.parse(parent.command_json)as TaskCommand;if(original.sessionId!==command.sessionId||original.workspaceId!==command.workspaceId||original.entityId!==command.entityId)throw new TaskError(403,'human_continuation_scope');
      const previous=JSON.parse(parent.spec_json)as ResolvedAgentSpec,spec={...previous,specId:`execution:${command.runId}`,authorizationRef:command.runId,instructions:{resourceId:`instructions:${command.runId}`,version:'1'}};
      const retained=JSON.parse(parent.materials_json)as{inputRevision:number;packet:RuntimeRunMaterials};const contents=retained.packet.contents.map(x=>({ref:{...x.ref,resourceId:x.ref.resourceId.replace(':'+parent.run_id,':'+command.runId)},blob:x.blob}));
      const history=retained.packet.history&&typeof retained.packet.history==='object'?{...retained.packet.history,runId:command.runId}:retained.packet.history;
      this.store.run('INSERT INTO task_host_bindings(run_id,task_id,command_json,profile_id,revision,session_json,spec_json,host_url,profile_source,binding_revision,configuration_id,host_instance_id,materials_json) VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?,?)',command.runId,command.taskId,JSON.stringify(command),parent.profile_id,parent.revision,JSON.stringify(spec),parent.host_url,parent.profile_source,parent.binding_revision,parent.configuration_id,parent.host_instance_id,JSON.stringify({inputRevision:retained.inputRevision,packet:{...retained.packet,contents,history}}));
      binding=this.binding(command.runId);
    }
    if(!binding) {
      const profile=this.profiles.effective(command.workspaceId,command.entityId);
      if(!profile?.enabled||!profile.secretRef)return {status:'rejected'};
      const thinkingLevel=this.tasks.executionThinkingLevel(command.workspaceId,command.entityId);
      const task=this.tasks.task(command.taskId);
      const admittedSnapshot=task.config_snapshot_json?JSON.parse(task.config_snapshot_json) as CapabilitySnapshot:undefined;
      const capabilitySnapshot=admittedSnapshot&&this.tasks.filterCapabilities?this.tasks.filterCapabilities(command.workspaceId,command.entityId,admittedSnapshot):admittedSnapshot;
      if(capabilitySnapshot&&admittedSnapshot)this.store.run('UPDATE tasks SET config_snapshot_json=? WHERE id=? AND run_id=? AND config_snapshot_json=?',JSON.stringify(capabilitySnapshot),command.taskId,command.runId,task.config_snapshot_json);
      const spec:ResolvedAgentSpec={specVersion:1,workspaceId:command.workspaceId,entityId:command.entityId,specId:`execution:${command.runId}`,specHash:createHash('sha256').update(canonical({profile:profile.id,source:profile.source,revision:profile.configRevision,bindingRevision:profile.bindingRevision,capabilitySnapshot:capabilitySnapshot??null,workItemTools:this.workItemsService?.toolSnapshot(command.taskId)??null,thinkingLevel,definition:'execution-v5'})).digest('hex'),agentBindingId:'execution-assets-v5',role:'execution',thinkingLevel,sourceVersions:{definition:'5',entityConfig:JSON.stringify([profile.source,profile.id,profile.configRevision,profile.bindingRevision,thinkingLevel]),profile:JSON.stringify([profile.source,profile.id,profile.configRevision,profile.bindingRevision])},instructions:{resourceId:`instructions:${command.runId}`,version:'1'},modelProfileRef:{resourceId:profile.id,version:String(profile.configRevision)},skills:capabilitySnapshot?.skills??[],mcpServers:capabilitySnapshot?.mcpServers??[],...(capabilitySnapshot?.executionResources?.length?{executionResources:capabilitySnapshot.executionResources}:{}),cliRequirements:[],platformTools:['context.read','progress.report','asset.read','artifact.publish','human.ask',...(command.triggerEvent&&this.config.groupHistoryUrl?['trigger.history']:[]),...(this.workItemsService?.toolsEnabled(command.taskId)?['work.item']:[]),...(capabilitySnapshot?.groupSharing&&this.groupHistoryService&&this.config.groupHistoryUrl?['group.history']:[])],knowledgeScopes:[],contextPolicyRef:'private-web-selected-history-v1',authorizationRef:command.runId,limits:{timeoutSeconds:300,maxConcurrentTools:1},requiredCapabilities:['taskRun','createSession','idempotentSubmit','trustedInvocationContext',...(capabilitySnapshot?.executionResources?.length?['blockingBeforeInvokeHook'] as const:[])],optionalCapabilities:[]};
      this.store.run('INSERT INTO task_host_bindings(run_id,task_id,command_json,profile_id,revision,session_json,spec_json,host_url,profile_source,binding_revision) VALUES(?,?,?,?,?,NULL,?,?,?,?)',command.runId,command.taskId,JSON.stringify(command),profile.id,profile.configRevision,JSON.stringify(spec),this.config.url,profile.source,profile.bindingRevision??null);
      binding=this.binding(command.runId);
    }
    const effective=this.profiles.effective(command.workspaceId,command.entityId);
    if(!binding.configuration_id&&(!effective?.enabled||!effective.secretRef||effective.id!==binding.profile_id||effective.configRevision!==binding.revision||(binding.profile_source&&effective.source!==binding.profile_source)||(binding.binding_revision&&effective.bindingRevision!==binding.binding_revision)))return {status:'rejected'};
    await this.prepareMaterials(binding,command.inputRevision);
    await this.refreshCapabilities(command.runId);
    const boundSpec=JSON.parse(binding.spec_json) as ResolvedAgentSpec;
    if(boundSpec.thinkingLevel!==undefined&&this.capabilities(command.runId)?.thinkingLevels?.[resolvedThinkingLevel(boundSpec)]!=='supported')return {status:'rejected'};
    let session:SessionHandle;
    if(binding.session_json)session=JSON.parse(binding.session_json) as SessionHandle;
    else {
      const prepared=await this.call<RuntimeOutcome<PreparedAgentHandle>>('prepareAgent',this.request(binding,`${command.operationId}:prepare`,{runtime:this.execution(binding).runtime,spec:JSON.parse(binding.spec_json),policy:{policyRef:'text-only-v1',allowedOptionalDegradations:[],secretDelivery:'protected_only'},idempotencyKey:`${command.operationId}:prepare`},true));
      if(!prepared.ok)return {status:'rejected'};
      const created=await this.call<RuntimeOutcome<SessionHandle>>('createSession',this.request(binding,`${command.operationId}:session`,{handle:prepared.value,sessionId:command.sessionId,idempotencyKey:`${command.operationId}:session`,contextBootstrap:{scope:{kind:'execution',taskId:command.taskId,runId:command.runId},mode:command.context.mode,snapshotId:command.context.snapshotId,bundleRef:{resourceId:`context:${command.runId}`,version:'1'},inputRefs:[],knowledgeScopes:[],workStateViewRef:{resourceId:`context:${command.runId}`,version:'1'},budget:{maxTokens:8000,maxBytes:64000},provenance:{sourceRefs:[],authorizationDecisionRef:command.runId,createdAt:new Date(this.tasks.task(command.taskId).created_at).toISOString()}}}));
      if(!created.ok)return {status:'rejected'};
      session=created.value;this.store.run('UPDATE task_host_bindings SET session_json=? WHERE run_id=?',JSON.stringify(session),command.runId);
    }
    await this.assetsService?.revalidateBusinessResourcesForRun({workspaceId:command.workspaceId,entityId:command.entityId,taskId:command.taskId,runId:command.runId});
    const receipt=await this.call<{status:'accepted'|'rejected'|'unknown'}>('submit',this.request(binding,command.operationId,{session,execution:this.execution(binding),input:{kind:'task_run',taskId:command.taskId,runId:command.runId,taskInput:{taskId:command.taskId,revision:command.inputRevision,inputRef:{resourceId:`input:${command.runId}:${command.inputRevision}`,version:String(command.inputRevision)},snapshotId:command.context.snapshotId}},idempotencyKey:command.operationId}));
    return {status:receipt.status};
  }
  async exportRawRecord(runId:string){const b=this.binding(runId);if(b.host_url!==this.config.url)throw Error('record_host_unavailable');return this.materialCall<{hostId:string;resourceId:string;sha256:string;byteLength:number;data:string;format:string}>('record',{request:this.request(b,'record-export:'+runId,{execution:this.execution(b)},true,true)});}
  /** Explicit publication is already durable while the producing Run is still active. */
  async refreshArtifacts(runId:string){
    const binding=this.binding(runId);if(binding.host_url!==this.config.url)throw new TaskError(409,'artifact_host_unavailable');
    const value=await this.materialCall<{artifacts:unknown}>('artifacts',{request:this.request(binding,'artifact-list:'+runId,{execution:this.execution(binding)},true,true)});
    this.recordArtifacts(runId,value.artifacts);
  }
  /** Publications are append-only. A delayed live snapshot cannot erase a newer final manifest. */
  private recordArtifacts(runId:string,refs:unknown){
    this.store.transaction(()=>{const previous=this.artifacts(runId);this.store.run('INSERT INTO task_artifact_manifests(run_id,refs_json) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET refs_json=excluded.refs_json',runId,JSON.stringify(refs??null));const incoming=this.artifacts(runId),merged=new Map(previous.map(a=>[a.content.resourceId,a]));for(const artifact of incoming){const old=merged.get(artifact.content.resourceId);if(old&&canonical(old)!==canonical(artifact))throw new TaskError(409,'artifact_manifest_conflict');merged.set(artifact.content.resourceId,artifact);}this.store.run('UPDATE task_artifact_manifests SET refs_json=? WHERE run_id=?',JSON.stringify([...merged.values()]),runId);});
  }
  artifacts(runId:string):import('@dentity/contracts').ArtifactDescriptor[]{
    const row=this.store.one<{refs_json:string}>('SELECT refs_json FROM task_artifact_manifests WHERE run_id=?',runId);if(!row)return[];const refs:unknown=JSON.parse(row.refs_json);if(!Array.isArray(refs))throw Error('invalid_artifact_manifest');
    return refs.map(value=>{if(!value||typeof value!=='object'||!value.content||!/^artifact:[a-f0-9]{64}$/.test(value.content.resourceId)||!/^([a-f0-9]{64})$/.test(value.content.version)||value.availability!=='available'||!['image','file'].includes(value.kind)||typeof value.name!=='string'||/[\\/\u0000-\u001f]/.test(value.name)||!value.name||typeof value.mediaType!=='string'||!Number.isSafeInteger(value.size)||value.size<0)throw Error('invalid_artifact_manifest');return{content:{resourceId:value.content.resourceId,version:value.content.version},availability:'available' as const,name:value.name,mediaType:value.mediaType,size:value.size,kind:value.kind as 'image'|'file'};});
  }
  async artifactContent(runId:string,artifactId:string){
    const artifact=this.artifacts(runId).find(a=>a.content.resourceId===artifactId);if(!artifact)throw new TaskError(403,'artifact_not_authorized');const binding=this.binding(runId),request=this.request(binding,'artifact-read:'+artifactId,{ref:artifact.content},true,true);
    const response=await fetch(this.config.url.replace(/\/$/,'')+'/v2/materials/artifact',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+this.config.token,'content-type':'application/json'},body:JSON.stringify({request}),signal:AbortSignal.timeout(30000)});
    if(!response.ok||response.headers.get('x-artifact-sha256')!==artifact.content.version)throw Error('artifact_read_failed');const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length!==artifact.size||createHash('sha256').update(bytes).digest('hex')!==artifact.content.version)throw Error('artifact_integrity_mismatch');return{kind:artifact.kind,name:artifact.name,mediaType:artifact.mediaType,bytes};
  }
  async rawRecords(runId:string):Promise<TriggerHistoryItem['records']>{const b=this.binding(runId);const response=await this.call<RuntimeOutcome<TriggerHistoryItem['records']>>('executionRecords',this.request(b,'records:'+runId,{execution:this.execution(b)},true,true));if(!response.ok)throw Error('Native records unavailable');return response.value;}
  async readRecords(taskId:string,runId:string,viewer:ExecutionRecordViewer,query:ExecutionRecordQuery):Promise<ExecutionRecordPage|ExecutionRecordContent>{
    const b=this.store.one<Binding>('SELECT * FROM task_host_bindings WHERE run_id=? AND task_id=?',runId,taskId);
    if(!b||!b.session_json||b.host_url!==this.config.url)return unavailableExecutionRecords();
    const context=this.context(b,true);
    const request={schemaVersion:1,operationId:'record-read:'+randomUUID(),correlationId:runId,causationId:'task-record-read',deadlineAt:new Date(this.now()+30000).toISOString(),authorizationContext:{...context,authenticatedActorRef:'task-record-read:'+createHash('sha256').update(canonical(viewer)).digest('hex')},payload:{execution:this.execution(b),viewer,query}};
    try{const response=await this.call<RuntimeOutcome<ExecutionRecordPage|ExecutionRecordContent>>('readExecutionRecords',request);if(!response.ok){if(response.error.code==='POLICY_DENIED')return fail(403,'task_records_forbidden');return unavailableExecutionRecords();}return response.value;}
    catch(error){if(error instanceof TaskError)throw error;return unavailableExecutionRecords();}
  }
  verifyRecordRequest(value:unknown,service:TaskService,admin:(scope:{workspaceId:string;userId:string},id:string)=>void){
    const r=taskBody(value,['schemaVersion','operationId','correlationId','causationId','deadlineAt','authorizationContext','payload']);
    const p=taskBody(r['payload'],['execution','viewer','query']),v=taskBody(p['viewer'],['kind','workspaceId','userId','entityId','conversationId']);
    const c=r['authorizationContext'] as RuntimeAuthorizationContext&{authenticatedActorRef?:string};
    if(!c||r['schemaVersion']!==1||typeof c.authorizationRef!=='string'||Date.parse(c.expiresAt)<=this.now()||!Number.isFinite(Date.parse(c.expiresAt))||typeof r['deadlineAt']!=='string'||Date.parse(r['deadlineAt'])<=this.now()||!Number.isFinite(Date.parse(r['deadlineAt'])))return fail(403,'runtime_request_forbidden');
    const b=this.binding(c.authorizationRef),expected={...this.context(b,true),authenticatedActorRef:'task-record-read:'+createHash('sha256').update(canonical(v)).digest('hex')};
    if(r['correlationId']!==b.run_id||typeof r['operationId']!=='string'||!r['operationId']||canonical(p['execution'])!==canonical(this.execution(b)))return fail(403,'runtime_request_forbidden');
    const actual=c as unknown as Record<string,unknown>;
    for(const [key,val]of Object.entries(expected))if(key!=='expiresAt'&&canonical(actual[key])!==canonical(val))return fail(403,'runtime_context_forbidden');
    if(Object.keys(actual).some(key=>!(key in expected))||v['workspaceId']!==c.workspaceId||typeof v['userId']!=='string')return fail(403,'runtime_context_forbidden');
    if(v['kind']==='admin')admin({workspaceId:c.workspaceId,userId:v['userId']},b.task_id);
    else if(v['kind']==='conversation'&&typeof v['entityId']==='string'&&typeof v['conversationId']==='string'&&v['entityId']===c.entityId)service.task({workspaceId:c.workspaceId,entityId:c.entityId,userId:v['userId'],conversationId:v['conversationId']},b.task_id);
    else return fail(403,'runtime_context_forbidden');
  }
  async input(command:TaskCommand):Promise<{status:'received'|'applied'|'unsupported'|'unknown'}> {
    const b=this.binding(command.runId);
    await this.prepareMaterials(b,command.inputRevision);
    await this.assetsService?.revalidateBusinessResourcesForRun({workspaceId:command.workspaceId,entityId:command.entityId,taskId:command.taskId,runId:command.runId});
    const result=await this.call<{status:string}>('appendInput',this.request(b,command.operationId,{execution:this.execution(b),inputId:command.operationId,input:{kind:'task_run',taskInput:{taskId:command.taskId,revision:command.inputRevision,inputRef:{resourceId:`input:${command.runId}:${command.inputRevision}`,version:String(command.inputRevision)},snapshotId:command.context.snapshotId}},idempotencyKey:command.operationId}));
    return {status:['received','applied','unsupported'].includes(result.status)?result.status as 'received'|'applied'|'unsupported':'unknown'};
  }
  async cancel(command:TaskCommand):Promise<{status:'requested'|'confirmed'|'unsupported'|'unknown'}> {
    const b=this.binding(command.runId);
    const result=await this.call<RuntimeOutcome<{status:'requested'|'confirmed'|'unsupported'|'unknown'}>>('cancel',this.request(b,command.operationId,{execution:this.execution(b),reason:'User requested cancellation'}));
    if (!result.ok) return {status:'unknown'};
    if (result.value.status === 'confirmed') {
      const state=await this.call<RuntimeOutcome<{status:string}>>('getStatus',this.request(b,`${command.operationId}:confirm`,{execution:this.execution(b)}));
      return {status:state.ok && state.value.status === 'canceled' ? 'confirmed' : 'unknown'};
    }
    return {status:result.value.status};
  }
  async events(runId:string,afterSequence:number):Promise<TaskRuntimeEvent[]> {
    if(!this.capabilities(runId))await this.refreshCapabilities(runId);
    const b=this.binding(runId);
    if(!this.materialsClosing&&b.material_pending_revision!==null&&!this.materialRefreshes.has(runId)&&(this.materialRefreshAt.get(runId)??0)<=this.now()){this.materialRefreshAt.set(runId,this.now()+5000);const work=this.prepareMaterials(b,b.material_pending_revision).catch(()=>{/* Keep pending facts; never replay execution. */}).finally(()=>{this.materialRefreshes.delete(runId);});this.materialRefreshes.set(runId,work);}
    let result:RuntimeOutcome<RuntimeEvent[]>;try{result=await this.call<RuntimeOutcome<RuntimeEvent[]>>('events',this.request(b,`poll:${runId}:${afterSequence}`,{execution:this.execution(b),cursor:String(afterSequence)}));}catch(error){this.tasks.eventTrace?.({taskId:b.task_id,runId,sessionId:this.execution(b).sessionId,cursor:afterSequence,returnedThrough:afterSequence,count:0,ok:false});throw error;}
    this.tasks.eventTrace?.({taskId:b.task_id,runId,sessionId:this.execution(b).sessionId,cursor:afterSequence,returnedThrough:result.ok?result.value.at(-1)?.sequence??afterSequence:afterSequence,count:result.ok?result.value.length:0,ok:result.ok});
    if(!result.ok)return [];
    return Promise.all(result.value.map(async event=>{
      if(event.schemaVersion!==1||event.producer.runtimeId!=='local-pi'||canonical(event.execution)!==canonical(this.execution(b)))throw new Error('Runtime event scope mismatch');
      const base={eventId:event.eventId,runId,sequence:event.sequence};
      switch(event.eventType){
        case 'work_item_safe':return {...base,type:'work_item_safe' as const,workItemSafe:event.payload};
        case 'human_request':case 'human_safe':return {...base,type:event.eventType,human:event.payload};
        case 'status_changed':return {...base,type:'status' as const,status:['accepted','queued'].includes(event.payload.status)?'queued':event.payload.status==='cancel_requested'?'unknown':event.payload.status as Exclude<typeof event.payload.status,'queued'|'accepted'|'cancel_requested'>};
        case 'input_receipt': {const p=event.payload;return p.input.kind==='task_run'&&['received','applied'].includes(p.status)?{...base,type:'input_receipt' as const,inputRevision:p.input.inputRevision,inputStatus:p.status as 'received'|'applied'}:{...base,type:'progress' as const,text:'Input receipt unavailable'};}
        case 'final_result':case 'partial_result': {const result=event.payload.result;this.recordArtifacts(runId,result.artifactRefs);return {...base,type:event.eventType,text:await this.content(result.outputRef,this.context(b)),...(result.kind==='task_run'?{inputRevision:result.basedOnInputRevision}:{})};}
        case 'output_delta':return {...base,type:'output_delta' as const,text:event.payload.text};
        default:return {...base,type:'progress' as const,text:await this.content(event.payload.contentRef,this.context(b))};
      }
    }));
  }
  async refreshAuthorization(context:RuntimeAuthorizationContext,service:TaskService):Promise<void>{
    if(!context||typeof context.authorizationRef!=='string'||!Number.isFinite(Date.parse(context.expiresAt))||Date.parse(context.expiresAt)<=this.now())return fail(403,'runtime_context_forbidden');
    const binding=this.binding(context.authorizationRef),task=this.store.one<TaskRow>('SELECT * FROM tasks WHERE id=?',binding.task_id)??fail(404,'task_not_found');
    if(context.workspaceId!==task.workspace_id||context.entityId!==task.entity_id)return fail(403,'runtime_context_forbidden');
    service.authorizeLocal(service.scopeOfTask(task));
  }
  verify(context:RuntimeAuthorizationContext,service:TaskService):Binding {
    if(!context||typeof context.authorizationRef!=='string'||Date.parse(context.expiresAt)<=this.now()||!Number.isFinite(Date.parse(context.expiresAt)))return fail(403,'runtime_context_forbidden');
    const b=this.binding(context.authorizationRef),command=JSON.parse(b.command_json) as TaskCommand;
    if(context.workspaceId!==command.workspaceId||context.entityId!==command.entityId)return fail(403,'runtime_context_forbidden');
    const task=service.getRuntimeTask(command.taskId);
    service.task(service.contextOfTask(task),command.taskId);
    const expected = this.context(b);
    const actual = context as unknown as Record<string,unknown>;
    for (const [key,value] of Object.entries(expected)) if (key !== 'expiresAt' && canonical(actual[key]) !== canonical(value)) return fail(403,'runtime_context_forbidden');
    if (Object.keys(actual).some(key => !(key in expected) && key !== 'authenticatedActorRef')) return fail(403,'runtime_context_forbidden');
    if (actual['authenticatedActorRef'] !== undefined && actual['authenticatedActorRef'] !== `task-service:${b.run_id}`) return fail(403,'runtime_context_forbidden');
    return b;
  }
  verifyRequest(value:unknown,service:TaskService) {
    if(!value||typeof value!=='object')return fail(403,'runtime_request_forbidden');
    const request=value as {schemaVersion:number;authorizationContext:RuntimeAuthorizationContext;operationId:string;correlationId:string;deadlineAt:string;payload:Record<string,unknown>};
    const b=this.verify(request.authorizationContext,service);
    if(request.schemaVersion!==1||request.correlationId!==b.run_id||typeof request.operationId!=='string'||!request.operationId||Date.parse(request.deadlineAt)<=this.now()||!Number.isFinite(Date.parse(request.deadlineAt))||!request.payload||typeof request.payload!=='object')return fail(403,'runtime_request_forbidden');
    const payload=request.payload,execution=this.execution(b),spec=JSON.parse(b.spec_json) as ResolvedAgentSpec;
    if(payload['runtime']!==undefined&&canonical(payload['runtime'])!==canonical(execution.runtime))return fail(403,'runtime_request_forbidden');
    if(payload['execution']!==undefined&&canonical(payload['execution'])!==canonical(execution))return fail(403,'runtime_request_forbidden');
    if(payload['spec']!==undefined&&canonical(payload['spec'])!==canonical(spec))return fail(403,'runtime_request_forbidden');
    if(payload['sessionId']!==undefined&&payload['sessionId']!==execution.sessionId)return fail(403,'runtime_request_forbidden');
    const session=payload['session'] as SessionHandle|undefined;
    if(session&&(!b.session_json||canonical(session)!==canonical(JSON.parse(b.session_json))))return fail(403,'runtime_request_forbidden');
    const handle=payload['handle'] as PreparedAgentHandle|undefined;
    if(handle&&(handle.specId!==spec.specId||handle.specHash!==spec.specHash||handle.role!=='execution'||canonical(handle.runtime)!==canonical(execution.runtime)))return fail(403,'runtime_request_forbidden');
    return b;
  }
  mcp(ref:ContentRef,context:RuntimeAuthorizationContext){const b=this.binding(context.authorizationRef),spec=JSON.parse(b.spec_json) as ResolvedAgentSpec;if(!ref||!spec.mcpServers.some(s=>s.serverRef===ref.resourceId&&s.version===ref.version)||!this.tasks.mcp)return fail(403,'mcp_forbidden');return this.tasks.mcp(context.workspaceId,ref);}
  private todoStartFact(taskId:string,runId:string) {
    const fact=this.tasks.todoStartFact?.(taskId,runId);
    if(fact&&(fact.kind!=='explicit_todo_start'||fact.taskId!==taskId||fact.runId!==runId||!fact.operationId||!Number.isSafeInteger(fact.inputRevision)||fact.inputRevision<1))return fail(409,'todo_start_fact_mismatch');
    return fact;
  }
  content(ref:ContentRef,context:RuntimeAuthorizationContext):string|Promise<string> {
    const b=this.binding(context.authorizationRef),command=JSON.parse(b.command_json) as TaskCommand;
    if(!ref||typeof ref.resourceId!=='string')return fail(403,'content_forbidden');
    if(ref.resourceId.startsWith('host-output:'))return this.materialCall<{text:string}>('output',{request:this.request(b,'output:'+ref.resourceId,{ref})}).then(v=>v.text);
    if(ref.resourceId.startsWith('uploaded-skill-')){const spec=JSON.parse(b.spec_json) as ResolvedAgentSpec;if(!spec.skills.some(s=>s.resourceId===ref.resourceId&&s.version===ref.version)||!this.tasks.skill)return fail(403,'skill_forbidden');const skill=this.tasks.skill(context.workspaceId,ref);return skill instanceof Promise?skill.then(value=>JSON.stringify(value)):JSON.stringify(skill);}
    if(ref.resourceId===`instructions:${b.run_id}`&&ref.version==='1') {
      const fact=this.todoStartFact(b.task_id,b.run_id);
      return taskExecutionInstructions(fact);
    }
    if(ref.resourceId===`context:${b.run_id}`&&ref.version==='1') {
      const task=this.tasks.task(b.task_id);
      if(task.snapshot_expires_at!==null && task.snapshot_expires_at<=this.now())return fail(410,'task_context_expired');
      for(const message of command.context.messages) {
        const current=this.tasks.retainedMessage(task.conversation_id??fail(403,'business_task_has_no_conversation'),message.id);
        if(!current||current.text!==message.text)return fail(403,'context_expired_or_changed');
      }
      return JSON.stringify(command.context.messages.map(({role,text})=>({role,text})));
    }
    const match=/^input:([^:]+):(\d+)$/.exec(ref.resourceId);
    if(match&&match[1]===b.run_id&&ref.version===match[2]) {
      const text=this.tasks.input(b.task_id,Number(match[2]))?.text??fail(404,'content_not_found');
      const fact=this.todoStartFact(b.task_id,b.run_id);
      return taskExecutionInput(text,fact?.inputRevision===Number(match[2])?fact:undefined);
    }
    const output=this.store.one<{text:string}>('SELECT text FROM runtime_outputs WHERE id=? AND run_id=?',ref.resourceId,b.run_id);
    return output&&ref.version==='1'?output.text:fail(403,'content_forbidden');
  }
}
export function registerRuntimeResolver(server:FastifyInstance,runtime:HttpTaskRuntime,service:TaskService,assets?:PlatformAssetService) {
  server.decorate('taskExecutionRecordsReader',runtime);
  if(!runtime.config.resolverToken)return; // Explicit legacy compatibility only; passive runtime entry omits this token.
  const authorize=(header:unknown)=>{const expected=Buffer.from(`Bearer ${runtime.config.resolverToken??''}`),actual=Buffer.from(typeof header==='string'?header:'');if(expected.length!==actual.length||!timingSafeEqual(expected,actual))fail(401,'runtime_unauthenticated');};
  for(const name of ['verify','content','model','output','mcp','model-status','history','assets','asset'])server.post(`/internal/runtime/${name}`,{bodyLimit:128000},async (request,reply)=>{
    authorize(request.headers.authorization);
    const body=taskBody(request.body,name==='verify'?['request']:name==='output'?['text','context']:['ref','context']);
    if(name==='verify') {try{const request=body['request'] as {authorizationContext?:{authenticatedActorRef?:string}};if(request?.authorizationContext?.authenticatedActorRef?.startsWith('task-record-read:'))runtime.verifyRecordRequest(request,service,server.getDecorator('authorizeManagedTaskRecordRead'));else{await runtime.refreshAuthorization((body['request'] as {authorizationContext:RuntimeAuthorizationContext})?.authorizationContext,service);runtime.verifyRequest(body['request'],service);}return {verified:true};}catch{return {verified:false};}}
    const context=body['context'] as RuntimeAuthorizationContext;
    await runtime.refreshAuthorization(context,service);
    const binding=runtime.verify(context,service);
    if(name==='assets'||name==='asset'){
      if(!assets)return name==='assets'?[]:{state:'not_available',reason:'asset_service_unavailable'};
      const run={workspaceId:context.workspaceId,entityId:context.entityId,taskId:binding.task_id,runId:binding.run_id};
      if(name==='assets')return assets.listForRun(run);
      const ref=taskBody(body['ref'],['assetId','kind']);if(typeof ref['assetId']!=='string'||!['content','summary','transcript'].includes(String(ref['kind'])))return fail(400,'invalid_asset_ref');
      const data=await assets.streamForRun(run,ref['assetId'],ref['kind'] as 'content'|'summary'|'transcript');
      if(!(data instanceof Response))return data;
      for(const key of ['content-type','content-length','x-asset-id','x-asset-sha256','x-asset-version']){const value=data.headers.get(key);if(value)reply.header(key,value);}
      return reply.send(data.body?Readable.fromWeb(data.body as import('node:stream/web').ReadableStream):null);
    }
    if(name==='history'){const task=runtime.tasks.task(binding.task_id);if(!scopeFromJson(task.source_json).business)return null;return runtime.history.read(binding.run_id)??fail(409,'history_manifest_not_ready');}
    if(name==='model-status'){runtime.profiles.assertEnabledProfile(context.workspaceId,binding.profile_id);return{available:true};}
    if(name==='mcp')return runtime.mcp(body['ref'] as ContentRef,context);
    if(name==='content')return {text:await runtime.content(body['ref'] as ContentRef,context)};
    if(name==='output') {const text=body['text'];if(typeof text!=='string'||text.length>64000)return fail(400,'invalid_output');return {ref:runtime.storeOutput(binding.run_id,text)};}
    if (runtime.tasks.task(binding.task_id).status === 'canceled') return fail(403,'model_credential_forbidden');
    const ref=body['ref'] as ContentRef;
    if(!ref||ref.resourceId!==binding.profile_id||ref.version!==String(binding.revision))return fail(403,'model_credential_forbidden');
    const resolved=await runtime.profiles.resolve({workspaceId:context.workspaceId,entityId:context.entityId,profileId:binding.profile_id,configRevision:binding.revision,...(binding.profile_source?{source:binding.profile_source as 'selection'|'workspace_default'}:{}),...(binding.binding_revision?{bindingRevision:binding.binding_revision}:{}),purpose:'model-inference'},()=>{runtime.verify(context,service);return true;});
    await runtime.refreshAuthorization(context,service);
    runtime.verify(context,service);
    return {provider:resolved.provider,modelId:resolved.modelId,apiKey:resolved.apiKey,baseUrl:resolved.endpoint};
  });
}
