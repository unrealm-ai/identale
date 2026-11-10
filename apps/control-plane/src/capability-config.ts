import type {HandoffUsageScope,EmployeeHandoffPolicy,HandoffUsageMode} from '@dentity/contracts';
import {handoffPackageAllowed} from '@dentity/application';
import {AdmissionDecisionCache} from './channel-loop/admission-cache.js';
import type {McpResources} from './mcp-resources.js';
import type {SkillResources} from './skill-resources.js';
import type {DirectoryPackageChannelPolicy,DirectoryChannelPolicy,DirectoryAccessConfig,DirectoryAccessRule,ChannelAccessScope,ChannelConnection} from '@dentity/application';
import type {EmployeeChannelService,DirectoryEvaluation} from './employee-channels/service.js';
import { randomUUID } from 'node:crypto';
import { evaluateEntityAccess, evaluatePackageAccess, projectRoleResources } from '@dentity/domain';
import type { AccessRequest, AccessRule, EntityAccessPolicy, RoleResource } from '@dentity/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from './store.js';

export class CapabilityConfigError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
  get statusCode() { return this.status; }
}
const fail = (status: number, code: string): never => { throw new CapabilityConfigError(status, code); };
export type ResourceVisibility = { readonly shared: true; readonly workspaceIds?: never } | { readonly shared?: never; readonly workspaceIds: readonly string[] };
export type ApprovedResource = ResourceVisibility & {readonly name?:string;readonly enabled?:boolean} & (
  | { readonly id: string; readonly kind: 'skill'; readonly resourceId: string; readonly version: string; readonly digest: string }
  | { readonly id: string; readonly kind: 'mcp'; readonly serverRef: string; readonly version?:string; readonly allowedTools: readonly string[] }
  | { readonly id: string; readonly kind: 'execution'; readonly resourceId: string; readonly version: string; readonly tools: readonly ('read'|'write'|'edit'|'bash')[] });
export interface CapabilityScope { workspaceId: string; entityId: string; userId: string }
export interface WebAccessConfig { allowWorkspaceMembers?: boolean; allowMemberIds: string[]; denyMemberIds: string[]; revision: number }
export interface TriggerUsageScope {mode:'all'|'allowlist';selectionMode?:'all'|'allowlist'|'denylist';allowTriggerIds:string[];denyTriggerIds:string[]}
export interface CapabilityPackageInput { name: string; description?: string; enabled: boolean; userPolicyMode?:'inherit'|'allowlist'|'denylist'; handoffUsageScope?:HandoffUsageScope;handoffUsageMode?:HandoffUsageMode; triggerUsageScope?:TriggerUsageScope; mode: 'inherit'|'restrict'; allowMemberIds: string[]; denyMemberIds: string[]; resourceIds: string[]; conversationKinds?:('private'|'group'|'meeting')[]; directoryAccess?:{allow:DirectoryAccessRule[];deny:DirectoryAccessRule[];channelPolicies?:DirectoryPackageChannelPolicy[]} }
export interface CapabilityPackage extends CapabilityPackageInput { id: string; workspaceId: string; entityId: string; version: number }
export interface CapabilitySnapshot {
  readonly groupSharing?:import("@dentity/contracts").GroupSharingSnapshot;
  /** New-session preparation fence only; never used to revoke an existing Session. */
  readonly packagePolicyVersion?:string;
  readonly workspaceId: string; readonly entityId: string; readonly userId?: string; readonly triggerId?:string; readonly entityPolicyRevision: number;
  readonly packages: readonly { readonly id: string; readonly version: number }[];
  readonly resources: readonly { readonly packageId: string; readonly resource: ApprovedResource }[];
  readonly skills: readonly { readonly resourceId: string; readonly version: string; readonly digest: string }[];
  readonly mcpServers: readonly { readonly serverRef: string; readonly version?:string; readonly allowedTools: readonly string[] }[];
  readonly executionResources?: readonly { readonly resourceId: string; readonly version: string; readonly tools: readonly ('read'|'write'|'edit'|'bash')[] }[];
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,199}$/.test(v) && !v.includes('://');
function strings(v: unknown): string[] { if (!Array.isArray(v) || v.length > 100 || !v.every(id) || new Set(v).size !== v.length) return fail(400,'invalid_configuration_ids'); return [...v]; }
function object(v: unknown, keys: string[]): asserts v is Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k=>!keys.includes(k))) fail(400,'invalid_capability_configuration'); }
const packageFields = ['name','description','enabled','mode','userPolicyMode','allowMemberIds','denyMemberIds','resourceIds','directoryAccess','conversationKinds','triggerUsageScope','handoffUsageScope','handoffUsageMode','expectedVersion'];
/** Keep inactive lists persisted; expose only the selected rules to the existing authorization engine. */
export function activeUserPolicy<T extends CapabilityPackageInput>(p:T):T{
  const selected=p.userPolicyMode;
  if(!selected)return p;
  return{...p,mode:selected==='allowlist'?'restrict' as const:'inherit' as const,allowMemberIds:selected==='allowlist'?p.allowMemberIds:[],denyMemberIds:selected==='denylist'?p.denyMemberIds:[],directoryAccess:{...(p.directoryAccess?.channelPolicies?{channelPolicies:p.directoryAccess.channelPolicies}:{}),allow:selected==='allowlist'?p.directoryAccess?.allow??[]:[],deny:selected==='denylist'?p.directoryAccess?.deny??[]:[]}};
}
function selectionMode(value:unknown):'all'|'allowlist'|'denylist'|undefined{
  if(value===undefined)return undefined;
  if(!['all','allowlist','denylist'].includes(String(value)))return fail(400,'invalid_list_selection_mode');
  return value as 'all'|'allowlist'|'denylist';
}

/** Shared lifecycle writes are local and nest safely inside the channel binding transaction. */
function ensureDirectoryPolicySchema(store:Store){
  store.db.exec('CREATE TABLE IF NOT EXISTS entity_directory_policies(entity_id TEXT PRIMARY KEY REFERENCES entities(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),revision INTEGER NOT NULL,allow_json TEXT NOT NULL,deny_json TEXT NOT NULL)');
  const columns=store.all<{name:string}>('PRAGMA table_info(entity_directory_policies)');
  if(!columns.some(c=>c.name==='channel_policies_json'))store.db.exec("ALTER TABLE entity_directory_policies ADD COLUMN channel_policies_json TEXT NOT NULL DEFAULT '[]'");
  if(!columns.some(c=>c.name==='allow_group_members'))store.db.exec('ALTER TABLE entity_directory_policies ADD COLUMN allow_group_members INTEGER NOT NULL DEFAULT 0 CHECK(allow_group_members IN (0,1))');
}
function sourceAccessWrite(store:Store,workspaceId:string,entityId:string,oldSourceId:string|undefined,newSourceId:string|undefined){
  return store.transaction(()=>{
    ensureDirectoryPolicySchema(store);
    const row=store.one<{revision:number;allow_json:string;deny_json:string;allow_group_members:number;channel_policies_json:string}>('SELECT * FROM entity_directory_policies WHERE workspace_id=? AND entity_id=?',workspaceId,entityId);
    const saved:DirectoryChannelPolicy[]=JSON.parse(row?.channel_policies_json??'[]');
    if(!oldSourceId&&newSourceId&&saved.some(p=>p.sourceId===newSourceId))return;
    const keep=(r:DirectoryAccessRule)=>r.sourceId!==oldSourceId;
    const policies=saved.filter(p=>p.sourceId!==oldSourceId&&p.sourceId!==newSourceId);
    let initialMode:DirectoryChannelPolicy['mode']='allowlist';
    if(!oldSourceId&&newSourceId){
      const connection=store.one<{provider:string}>("SELECT provider FROM employee_channel_connections WHERE workspace_id=? AND entity_id=? AND json_extract(record_json,'$.sourceId')=?",workspaceId,entityId,newSourceId);
      const defaults=JSON.parse(store.one<{initial_channel_defaults_json:string}>('SELECT initial_channel_defaults_json FROM entities WHERE workspace_id=? AND id=?',workspaceId,entityId)?.initial_channel_defaults_json??'{}') as Record<string,string>;
      if(connection&&defaults[connection.provider]==='denylist'){
        initialMode='denylist';delete defaults[connection.provider];
        store.run('UPDATE entities SET initial_channel_defaults_json=? WHERE workspace_id=? AND id=?',JSON.stringify(defaults),workspaceId,entityId);
      }
    }
    if(newSourceId)policies.push({sourceId:newSourceId,mode:initialMode,allow:[],deny:[],allowGroupMembers:true,revision:1});
    store.run('INSERT INTO entity_directory_policies(entity_id,workspace_id,revision,allow_json,deny_json,allow_group_members,channel_policies_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(entity_id) DO UPDATE SET revision=excluded.revision,allow_json=excluded.allow_json,deny_json=excluded.deny_json,channel_policies_json=excluded.channel_policies_json',entityId,workspaceId,(row?.revision??0)+1,JSON.stringify((JSON.parse(row?.allow_json??'[]') as DirectoryAccessRule[]).filter(keep)),JSON.stringify((JSON.parse(row?.deny_json??'[]') as DirectoryAccessRule[]).filter(keep)),row?.allow_group_members??0,JSON.stringify(policies));
    if(!store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='capability_packages'"))return;
    for(const row of store.all<{id:string;config_json:string}>('SELECT id,config_json FROM capability_packages WHERE workspace_id=? AND entity_id=?',workspaceId,entityId)){
      const config=JSON.parse(row.config_json) as CapabilityPackageInput,previous=config.directoryAccess;
      if(!newSourceId&&!previous?.allow.some(r=>r.sourceId===oldSourceId)&&!previous?.deny.some(r=>r.sourceId===oldSourceId)&&!previous?.channelPolicies?.some(p=>p.sourceId===oldSourceId))continue;
      const channelPolicies=(previous?.channelPolicies??[]).filter(p=>p.sourceId!==oldSourceId&&p.sourceId!==newSourceId);
      if(newSourceId)channelPolicies.push({sourceId:newSourceId,mode:'inherit',allow:[],deny:[]});
      const directoryAccess={allow:(previous?.allow??[]).filter(keep),deny:(previous?.deny??[]).filter(keep),channelPolicies};
      if(JSON.stringify(directoryAccess)===JSON.stringify(previous)||!newSourceId&&!previous)continue;
      store.run('UPDATE capability_packages SET version=version+1,config_json=? WHERE id=?',JSON.stringify({...config,directoryAccess}),row.id);
    }
  });
}
/** Call only for a newly created source; existing implicit policies must not be reinitialized. */
export function initializeChannelSourceAccess(store:Store,workspaceId:string,entityId:string,sourceId:string){return sourceAccessWrite(store,workspaceId,entityId,undefined,sourceId);}
/** Remove old source rules without touching Web, other sources or package resource selections. */
export function resetChannelSourceAccess(store:Store,workspaceId:string,entityId:string,oldSourceId:string,newSourceId?:string){return sourceAccessWrite(store,workspaceId,entityId,oldSourceId,newSourceId);}

/** Merge only deployment-approved resources; package provenance stays in the snapshot. */
export function executionCapabilityResources(resources:readonly {packageId:string;resource:ApprovedResource}[]){
  const skills=new Map<string,{resourceId:string;version:string;digest:string}>(),mcp=new Map<string,Set<string>>(),mcpVersions=new Map<string,string>(),execution=new Map<string,{resourceId:string;version:string;tools:readonly ('read'|'write'|'edit'|'bash')[]}>();
  for(const {resource:r}of resources){
    if(r.kind==='skill'){const ref={resourceId:r.resourceId,version:r.version,digest:r.digest},old=skills.get(r.resourceId);if(old&&JSON.stringify(old)!==JSON.stringify(ref))fail(409,'capability_resource_conflict');skills.set(r.resourceId,ref);}
    else if(r.kind==='mcp'){if(r.version){const prior=mcpVersions.get(r.serverRef);if(prior&&prior!==r.version)fail(409,'capability_resource_conflict');mcpVersions.set(r.serverRef,r.version);}const tools=mcp.get(r.serverRef)??new Set<string>();for(const name of r.allowedTools)tools.add(name);mcp.set(r.serverRef,tools);}
    else{const ref={resourceId:r.resourceId,version:r.version,tools:[...r.tools]},key=JSON.stringify(ref);execution.set(key,ref);}
  }
  if(execution.size>1)fail(409,'execution_resource_conflict');
  return{skills:[...skills.values()],mcpServers:[...mcp].map(([serverRef,tools])=>({serverRef,allowedTools:[...tools],...(mcpVersions.has(serverRef)?{version:mcpVersions.get(serverRef)!}:{})})),...(execution.size?{executionResources:[...execution.values()]}:{})};
}

/** Web-private policy adapter. Catalog is deployment-owned, never supplied by browser/model arguments. */
export class CapabilityConfigService {
  private readonly admissionCache:AdmissionDecisionCache;
  invalidateAdmission(workspaceId:string,entityId:string){this.admissionCache.invalidate(JSON.stringify([workspaceId,entityId]));}
  close(){this.admissionCache.close();}
  private readonly catalog: Map<string, ApprovedResource>;
  constructor(private readonly store: Store, resources: readonly ApprovedResource[] = [], private readonly directory?:EmployeeChannelService,readonly uploadedSkills?:SkillResources,readonly mcpResources?:McpResources,private diagnostics?:import('@dentity/application').DiagnosticPort,now:()=>number=Date.now) {
    this.admissionCache=new AdmissionDecisionCache(now);
    this.catalog = new Map();
    this.replaceApprovedResources(resources);
    store.db.exec(`CREATE TABLE IF NOT EXISTS entity_web_policies (entity_id TEXT PRIMARY KEY REFERENCES entities(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),revision INTEGER NOT NULL,allow_json TEXT NOT NULL,deny_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entity_directory_policies(entity_id TEXT PRIMARY KEY REFERENCES entities(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),revision INTEGER NOT NULL,allow_json TEXT NOT NULL,deny_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capability_packages (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),entity_id TEXT NOT NULL REFERENCES entities(id),version INTEGER NOT NULL,config_json TEXT NOT NULL)`);
    store.db.exec('CREATE TABLE IF NOT EXISTS employee_handoff_policies(entity_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,version INTEGER NOT NULL,allow_all INTEGER NOT NULL CHECK(allow_all IN(0,1)),scope_json TEXT NOT NULL)');
    if(!store.all<{name:string}>('PRAGMA table_info(entity_web_policies)').some(c=>c.name==='allow_workspace_members'))store.db.exec('ALTER TABLE entity_web_policies ADD COLUMN allow_workspace_members INTEGER NOT NULL DEFAULT 0 CHECK(allow_workspace_members IN (0,1))');
    if(!store.all<{name:string}>('PRAGMA table_info(entity_directory_policies)').some(c=>c.name==='channel_policies_json'))store.db.exec("ALTER TABLE entity_directory_policies ADD COLUMN channel_policies_json TEXT NOT NULL DEFAULT '[]'");
    if(!store.all<{name:string}>('PRAGMA table_info(entity_directory_policies)').some(c=>c.name==='allow_group_members'))store.db.exec('ALTER TABLE entity_directory_policies ADD COLUMN allow_group_members INTEGER NOT NULL DEFAULT 0 CHECK(allow_group_members IN (0,1))');
  }
  /** Validated deployment resource catalog; swapped only with a coherent configuration snapshot. */
  replaceApprovedResources(resources:readonly ApprovedResource[]){
    const next=new Map<string,ApprovedResource>();
    for (const resource of resources) {
      if (!resource || typeof resource !== 'object' || !id(resource.id) || next.has(resource.id)) fail(500,'invalid_approved_resource_catalog');
      const visibilityKeys = Object.keys(resource);
      const shared = resource.shared === true && !visibilityKeys.includes('workspaceIds');
      const scoped = !visibilityKeys.includes('shared') && Array.isArray(resource.workspaceIds) && resource.workspaceIds.length > 0 && resource.workspaceIds.every(id) && new Set(resource.workspaceIds).size === resource.workspaceIds.length;
      if (!shared && !scoped) fail(500,'invalid_approved_resource_visibility');
      if (resource.kind === 'skill') {
        object(resource,['id','kind','resourceId','version','digest','shared','workspaceIds']);
        if (!id(resource.resourceId) || !id(resource.version) || typeof resource.digest !== 'string' || !/^(sha256:)?[a-f0-9]{64}$/.test(resource.digest)) fail(500,'invalid_approved_resource_catalog');
      } else if (resource.kind === 'mcp') {
        object(resource,['id','kind','serverRef','allowedTools','shared','workspaceIds']);
        if (!id(resource.serverRef) || !Array.isArray(resource.allowedTools) || resource.allowedTools.length === 0 || resource.allowedTools.some(t=>!id(t)) || new Set(resource.allowedTools).size !== resource.allowedTools.length) fail(500,'invalid_approved_resource_catalog');
      } else if (resource.kind === 'execution') {
        object(resource,['id','kind','resourceId','version','tools','shared','workspaceIds']);
        if(!id(resource.resourceId)||!id(resource.version)||!Array.isArray(resource.tools)||!resource.tools.length||resource.tools.some(t=>!['read','write','edit','bash'].includes(t))||new Set(resource.tools).size!==resource.tools.length)fail(500,'invalid_approved_resource_catalog');
      } else fail(500,'invalid_approved_resource_catalog');
      next.set(resource.id,freeze(clone(resource)));
    }
    this.catalog.clear();for(const [key,value]of next)this.catalog.set(key,value);
  }
  private visible(resource: ApprovedResource, workspaceId: string): boolean { return resource.shared === true || resource.workspaceIds?.includes(workspaceId) === true; }
  resources(workspaceId: string): ApprovedResource[] { return [...this.catalog.values(),...(this.uploadedSkills?.resources(workspaceId)??[]),...(this.mcpResources?.resources(workspaceId)??[])].filter(r=>this.visible(r,workspaceId)).map(clone); }
  resourceSelection(workspaceId:string,packages:readonly {id:string;resourceIds:readonly string[]}[]){return packages.flatMap(p=>p.resourceIds.flatMap(id=>{const r=this.approved(id,workspaceId);if(!r)return fail(409,'approved_resource_unavailable');if(r.enabled===false&&(r.kind==='skill'||r.kind==='mcp')){this.filtered(workspaceId,p.id,r);return [];}return[{packageId:p.id,resource:r}];}));}
  private filtered(workspaceId:string,packageId:string,r:ApprovedResource,entityId?:string,packageDisabled=false){if(r.kind==='skill'||r.kind==='mcp')this.diagnostics?.event({stage:'capability.filtered',phase:'point',outcome:'success',workspaceId,...(entityId?{entityId}:{}),packageId,resourceId:r.id,resourceKind:r.kind,filterReason:packageDisabled?'package_disabled':'resource_disabled'});}
  filterStartup(workspaceId:string,entityId:string,snapshot:CapabilitySnapshot):CapabilitySnapshot{const packages=this.list(workspaceId,entityId),enabled=new Set(snapshot.packages.filter(p=>{const current=packages.find(c=>c.id===p.id);if(!current)return fail(409,'capability_configuration_changed');return current.enabled;}).map(p=>p.id));const resources=snapshot.resources.filter(entry=>{const current=this.approved(entry.resource.id,workspaceId);if(!current)return fail(409,'approved_resource_unavailable');if(!enabled.has(entry.packageId)||current.enabled===false&&(current.kind==='skill'||current.kind==='mcp')){this.filtered(workspaceId,entry.packageId,current,entityId,!enabled.has(entry.packageId));return false;}return true;});return{...snapshot,packages:snapshot.packages.filter(p=>enabled.has(p.id)),resources,...executionCapabilityResources(resources)};}

  private approved(resourceId: string, workspaceId: string): ApprovedResource | undefined { return this.resources(workspaceId).find(r=>r.id===resourceId); }
  private entity(workspaceId: string, entityId: string) {
    return this.store.one<{own_web_use:number;web_use_user_id:string}>('SELECT own_web_use,web_use_user_id FROM entities WHERE id=? AND workspace_id=?',entityId,workspaceId) ?? fail(404,'entity_not_found');
  }
  members(workspaceId: string) {
    return this.store.all<{id:string;userId:string;displayName:string;role:string}>(`SELECT m.id,m.user_id AS userId,u.display_name AS displayName,m.role FROM members m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.status='active' AND u.status='active' AND w.status='active' ORDER BY u.display_name`,workspaceId);
  }
  private validateMembers(workspaceId: string, ids: string[]) {
    const active = new Set(this.members(workspaceId).map(m=>m.id));
    if (ids.some(memberId=>!active.has(memberId))) fail(400,'invalid_workspace_member');
  }
  getWebAccess(workspaceId: string, entityId: string): WebAccessConfig {
    const entity = this.entity(workspaceId,entityId);
    const row = this.store.one<{revision:number;allow_json:string;deny_json:string;allow_workspace_members:number}>('SELECT revision,allow_json,deny_json,allow_workspace_members FROM entity_web_policies WHERE workspace_id=? AND entity_id=?',workspaceId,entityId);
    if (row) return {revision:row.revision,allowMemberIds:JSON.parse(row.allow_json),denyMemberIds:JSON.parse(row.deny_json),...(row.allow_workspace_members===1?{allowWorkspaceMembers:true}:{})};
    return {revision:0,allowMemberIds:entity.own_web_use===1?this.members(workspaceId).filter(m=>m.userId===entity.web_use_user_id).map(m=>m.id):[],denyMemberIds:[]};
  }
  saveWebAccess(workspaceId: string, entityId: string, input: unknown): WebAccessConfig {
    object(input,['allowMemberIds','denyMemberIds','allowWorkspaceMembers']);
    if(input.allowWorkspaceMembers!==undefined&&typeof input.allowWorkspaceMembers!=='boolean')fail(400,'invalid_capability_configuration');
    const allowMemberIds=strings(input.allowMemberIds),denyMemberIds=strings(input.denyMemberIds);
    return this.store.transaction(()=>{
      this.entity(workspaceId,entityId); this.validateMembers(workspaceId,[...allowMemberIds,...denyMemberIds]);
      const previous=this.getWebAccess(workspaceId,entityId),revision=previous.revision+1,allowWorkspaceMembers=input.allowWorkspaceMembers===undefined?previous.allowWorkspaceMembers===true:input.allowWorkspaceMembers===true;
      this.store.run(`INSERT INTO entity_web_policies(entity_id,workspace_id,revision,allow_json,deny_json,allow_workspace_members) VALUES(?,?,?,?,?,?) ON CONFLICT(entity_id) DO UPDATE SET revision=excluded.revision,allow_json=excluded.allow_json,deny_json=excluded.deny_json,allow_workspace_members=excluded.allow_workspace_members`,entityId,workspaceId,revision,JSON.stringify(allowMemberIds),JSON.stringify(denyMemberIds),allowWorkspaceMembers?1:0);
      this.invalidateAdmission(workspaceId,entityId);return {allowMemberIds,denyMemberIds,revision,...(allowWorkspaceMembers?{allowWorkspaceMembers:true}:{})};
    });
  }
  /** All read and mutation responses expose the same effective source policy projection. */
  private packageDto(workspaceId:string,entityId:string,packageId:string,version:number,config:CapabilityPackageInput):CapabilityPackage {
    const active=activeUserPolicy(config),saved=config.directoryAccess?.channelPolicies??[];
    const channelPolicies=(this.directory?.list?.(workspaceId,entityId)??[]).map(c=>saved.find(p=>p.sourceId===c.sourceId)??{
      sourceId:c.sourceId,mode:active.mode==='restrict'?'allowlist' as const:active.directoryAccess?.deny.length?'denylist' as const:'inherit' as const,
      allow:active.directoryAccess?.allow.filter(r=>r.sourceId===c.sourceId)??[],deny:active.directoryAccess?.deny.filter(r=>r.sourceId===c.sourceId)??[],
      ...(active.mode==='inherit'&&active.directoryAccess?.allow.some(r=>r.sourceId===c.sourceId)?{legacyAllowCheck:true as const}:{}),
    });
    return {...config,...(channelPolicies.length?{directoryAccess:{allow:config.directoryAccess?.allow??[],deny:config.directoryAccess?.deny??[],channelPolicies}}:{}),
      ...(config.handoffUsageScope&&!config.handoffUsageMode?{handoffUsageMode:'custom' as const}:{}),id:packageId,workspaceId,entityId,version};
  }
  list(workspaceId: string, entityId: string): CapabilityPackage[] {
    this.entity(workspaceId,entityId);
    return this.store.all<{id:string;version:number;config_json:string}>('SELECT id,version,config_json FROM capability_packages WHERE workspace_id=? AND entity_id=? ORDER BY id',workspaceId,entityId)
      .map(row=>this.packageDto(workspaceId,entityId,row.id,row.version,JSON.parse(row.config_json) as CapabilityPackageInput));
  }
  save(workspaceId: string, entityId: string, input: unknown, packageId?: string): CapabilityPackage {
    object(input,packageFields);
    if(input.description!==undefined&&(typeof input.description!=='string'||input.description.length>4000))fail(400,'invalid_capability_configuration');
    if(input.userPolicyMode!==undefined&&!['inherit','allowlist','denylist'].includes(String(input.userPolicyMode)))fail(400,'invalid_user_policy_mode');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length>120 || typeof input.enabled!=='boolean' || input.mode!==undefined&&!['inherit','restrict'].includes(input.mode as string)) fail(400,'invalid_capability_configuration');
    if(input.handoffUsageMode!==undefined&&!['inherit','custom'].includes(String(input.handoffUsageMode)))fail(400,'invalid_handoff_usage_mode');
    if(input.conversationKinds!==undefined&&(!Array.isArray(input.conversationKinds)||input.conversationKinds.length>100||input.conversationKinds.some(k=>!['private','group','meeting'].includes(k))))fail(400,'invalid_capability_configuration');
    const config: CapabilityPackageInput={...(input.handoffUsageMode!==undefined?{handoffUsageMode:input.handoffUsageMode as HandoffUsageMode}:{}),name:(input.name as string).trim(),enabled:input.enabled as boolean,mode:(input.mode??'inherit') as 'inherit'|'restrict',allowMemberIds:strings(input.allowMemberIds),denyMemberIds:strings(input.denyMemberIds),resourceIds:strings(input.resourceIds),...(input.conversationKinds!==undefined?{conversationKinds:[...new Set(input.conversationKinds as ('private'|'group'|'meeting')[])]}:{}),...(input.triggerUsageScope!==undefined?{triggerUsageScope:this.triggerRules(workspaceId,entityId,input.triggerUsageScope)}:{}),...(input.handoffUsageScope!==undefined?{handoffUsageScope:this.handoffRules(workspaceId,input.handoffUsageScope)}:{})};
    if (config.resourceIds.some(r=>!this.approved(r,workspaceId))) fail(400,'unknown_approved_resource');
    return this.store.transaction(()=>{
      this.entity(workspaceId,entityId); this.validateMembers(workspaceId,[...config.allowMemberIds,...config.denyMemberIds]);
      const stored=packageId?this.store.one<{version:number;config_json:string}>('SELECT version,config_json FROM capability_packages WHERE workspace_id=? AND entity_id=? AND id=?',workspaceId,entityId,packageId):undefined;
      const previous=stored?{...JSON.parse(stored.config_json),version:stored.version} as CapabilityPackage:undefined;
      if(input.mode===undefined&&previous)config.mode=previous.mode;
      if(input.directoryAccess!==undefined)config.directoryAccess=this.directoryRules(workspaceId,entityId,input.directoryAccess,previous?.directoryAccess);
      else if(!previous&&input.mode!=='restrict'&&(!input.userPolicyMode||input.userPolicyMode==='inherit'))config.directoryAccess={allow:[],deny:[],channelPolicies:(this.directory?.list?.(workspaceId,entityId)??[]).map(c=>({sourceId:c.sourceId,mode:'inherit',allow:[],deny:[]}))};
      if(input.description!==undefined)config.description=(input.description as string).trim();
      else if(previous?.description!==undefined)config.description=previous.description;
      if(input.userPolicyMode!==undefined)config.userPolicyMode=input.userPolicyMode as NonNullable<CapabilityPackageInput['userPolicyMode']>;
      else if(previous?.userPolicyMode)config.userPolicyMode=previous.userPolicyMode;
      if(config.userPolicyMode)config.mode=config.userPolicyMode==='allowlist'?'restrict':'inherit';
      if(input.conversationKinds===undefined&&previous?.conversationKinds!==undefined)config.conversationKinds=[...previous.conversationKinds];
      if(input.triggerUsageScope===undefined&&previous?.triggerUsageScope!==undefined)config.triggerUsageScope=clone(previous.triggerUsageScope);
      if(input.handoffUsageScope===undefined&&previous?.handoffUsageScope!==undefined)config.handoffUsageScope=clone(previous.handoffUsageScope);
      // Older clients echo the two lists but do not know the selected-mode field.
      for(const key of ['triggerUsageScope','handoffUsageScope'] as const){const selected=previous?.[key]?.selectionMode,current=config[key];if(selected&&current&&!current.selectionMode){current.selectionMode=selected;current.mode=selected==='allowlist'?'allowlist':'all';}}
      if(input.handoffUsageMode===undefined){if(previous?.handoffUsageMode)config.handoffUsageMode=previous.handoffUsageMode;else if(config.handoffUsageScope)config.handoffUsageMode='custom';}
      if(input.directoryAccess===undefined&&previous?.directoryAccess!==undefined)config.directoryAccess=clone(previous.directoryAccess);
      if (packageId && !previous) fail(404,'capability_package_not_found');
      if(input.expectedVersion!==undefined&&(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion!==previous?.version))fail(409,'capability_version_conflict');
      const value={...config,id:packageId??randomUUID(),workspaceId,entityId,version:(previous?.version??0)+1};
      this.store.run(`INSERT INTO capability_packages(id,workspace_id,entity_id,version,config_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,config_json=excluded.config_json`,value.id,workspaceId,entityId,value.version,JSON.stringify(config));
      return this.packageDto(workspaceId,entityId,value.id,value.version,config);
    });
  }
  private handoffRules(workspaceId:string,value:unknown):HandoffUsageScope {
    object(value,['mode','selectionMode','allowEmployeeIds','denyEmployeeIds']);if(!['all','allowlist'].includes(String(value.mode)))return fail(400,'invalid_handoff_usage_scope');
    const allowEmployeeIds=strings(value.allowEmployeeIds),denyEmployeeIds=strings(value.denyEmployeeIds);
    for(const employeeId of [...allowEmployeeIds,...denyEmployeeIds])if(!this.store.one('SELECT id FROM entities WHERE workspace_id=? AND id=?',workspaceId,employeeId))fail(400,'invalid_handoff_employee_id');
    const selected=selectionMode(value.selectionMode);return{mode:selected?(selected==='allowlist'?'allowlist':'all'):value.mode as HandoffUsageScope['mode'],...(selected?{selectionMode:selected}:{}),allowEmployeeIds,denyEmployeeIds};
  }
  handoffOptions(workspaceId:string,entityId:string){this.entity(workspaceId,entityId);return this.store.all<{id:string;name:string;lifecycle_enabled:number}>('SELECT id,name,lifecycle_enabled FROM entities WHERE workspace_id=? ORDER BY name,id',workspaceId).map(e=>({id:e.id,name:e.name,enabled:!!e.lifecycle_enabled}));}
  getHandoffAccess(workspaceId:string,entityId:string):EmployeeHandoffPolicy{this.entity(workspaceId,entityId);const row=this.store.one<{version:number;allow_all:number;scope_json:string}>('SELECT * FROM employee_handoff_policies WHERE workspace_id=? AND entity_id=?',workspaceId,entityId);return row?{version:row.version,allowAll:row.allow_all===1,scope:JSON.parse(row.scope_json)}:{version:0,allowAll:true,scope:{mode:'all',allowEmployeeIds:[],denyEmployeeIds:[]}};}
  saveHandoffAccess(workspaceId:string,entityId:string,input:unknown){object(input,['expectedVersion','allowAll','scope']);if(!Number.isSafeInteger(input.expectedVersion)||typeof input.allowAll!=='boolean')fail(400,'invalid_employee_handoff_policy');const scope=this.handoffRules(workspaceId,input.scope);return this.store.transaction(()=>{const old=this.getHandoffAccess(workspaceId,entityId);if(old.version!==input.expectedVersion)fail(409,'employee_handoff_version_conflict');if(old.scope.selectionMode&&!scope.selectionMode){scope.selectionMode=old.scope.selectionMode;scope.mode=scope.selectionMode==='allowlist'?'allowlist':'all';}const version=old.version+1;this.store.run('INSERT INTO employee_handoff_policies VALUES(?,?,?,?,?) ON CONFLICT(entity_id) DO UPDATE SET version=excluded.version,allow_all=excluded.allow_all,scope_json=excluded.scope_json',entityId,workspaceId,version,Number(input.allowAll),JSON.stringify(scope));this.invalidateAdmission(workspaceId,entityId);return{version,allowAll:input.allowAll as boolean,scope};});}
  assertHandoffReceiver(scope:{workspaceId:string;entityId:string;sourceEmployeeId:string}){this.assertActive(scope);this.assertActive({workspaceId:scope.workspaceId,entityId:scope.sourceEmployeeId});const policy=this.getHandoffAccess(scope.workspaceId,scope.entityId);if(!policy.allowAll&&!handoffPackageAllowed(policy.scope,scope.sourceEmployeeId))fail(403,'employee_handoff_forbidden');return policy;}
  resolveForHandoff(scope:{workspaceId:string;entityId:string;sourceEmployeeId:string}):CapabilitySnapshot {
    const policy=this.assertHandoffReceiver(scope),all=this.list(scope.workspaceId,scope.entityId),packages=all.filter(p=>p.enabled&&(p.handoffUsageMode==='inherit'||!p.handoffUsageMode&&!p.handoffUsageScope||handoffPackageAllowed(p.handoffUsageScope,scope.sourceEmployeeId))),resources=this.resourceSelection(scope.workspaceId,packages);
    return freeze(clone({workspaceId:scope.workspaceId,entityId:scope.entityId,entityPolicyRevision:policy.version,packagePolicyVersion:JSON.stringify(all.map(p=>[p.id,p.version])),packages:packages.map(p=>({id:p.id,version:p.version})),resources,...executionCapabilityResources(resources)}));
  }
  /** System acceptance reuses only the original A resource ceiling, never C's handoff authority or source grants. */
  prepareAcceptanceSnapshot(workspaceId:string,entityId:string,root:CapabilitySnapshot):CapabilitySnapshot {
    this.assertActive({workspaceId,entityId});
    if(root.workspaceId!==workspaceId||root.entityId!==entityId)fail(403,'acceptance_resource_scope_mismatch');
    const current=this.list(workspaceId,entityId);
    for(const p of root.packages)if(!current.some(x=>x.id===p.id&&x.version===p.version&&x.enabled))fail(409,'acceptance_resources_changed');
    for(const r of root.resources)if(JSON.stringify(this.approved(r.resource.id,workspaceId))!==JSON.stringify(r.resource))fail(409,'acceptance_resources_changed');
    return freeze(clone({workspaceId,entityId,entityPolicyRevision:root.entityPolicyRevision,packagePolicyVersion:JSON.stringify(current.map(p=>[p.id,p.version])),packages:root.packages,resources:root.resources,...executionCapabilityResources(root.resources)}));
  }
  private triggerRules(workspaceId:string,entityId:string,value:unknown):TriggerUsageScope {object(value,['mode','selectionMode','allowTriggerIds','denyTriggerIds']);if(!['all','allowlist'].includes(String(value.mode)))return fail(400,'invalid_trigger_usage_scope');const allowTriggerIds=strings(value.allowTriggerIds),denyTriggerIds=strings(value.denyTriggerIds);for(const triggerId of [...allowTriggerIds,...denyTriggerIds])if(!this.store.one('SELECT id FROM trigger_bindings WHERE id=? AND workspace_id=? AND entity_id=?',triggerId,workspaceId,entityId))return fail(400,'invalid_trigger_scope_id');const selected=selectionMode(value.selectionMode);return{mode:selected?(selected==='allowlist'?'allowlist':'all'):value.mode as TriggerUsageScope['mode'],...(selected?{selectionMode:selected}:{}),allowTriggerIds,denyTriggerIds};}
  triggerOptions(workspaceId:string,entityId:string){this.entity(workspaceId,entityId);if(!this.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='trigger_bindings'"))return [];return this.store.all<{id:string;name:string;enabled:number}>('SELECT id,name,enabled FROM trigger_bindings WHERE workspace_id=? AND entity_id=? ORDER BY created_at,id',workspaceId,entityId).map(row=>({...row,enabled:!!row.enabled}));}
  resolveForTrigger(scope:{workspaceId:string;entityId:string;triggerId:string;bindingVersion:number}):CapabilitySnapshot {
    this.assertActive(scope);const binding=this.store.one<{version:number;enabled:number}>('SELECT version,enabled FROM trigger_bindings WHERE id=? AND workspace_id=? AND entity_id=?',scope.triggerId,scope.workspaceId,scope.entityId);if(!binding||!binding.enabled||binding.version!==scope.bindingVersion)return fail(403,'trigger_binding_changed');
    const all=this.list(scope.workspaceId,scope.entityId),packages=all.filter(p=>{const rule=p.triggerUsageScope;if(!rule)return p.enabled;const selected=rule.selectionMode,allowed=selected==='all'?true:selected==='allowlist'?rule.allowTriggerIds.includes(scope.triggerId):selected==='denylist'?!rule.denyTriggerIds.includes(scope.triggerId):!rule.denyTriggerIds.includes(scope.triggerId)&&(rule.mode==='all'||rule.allowTriggerIds.includes(scope.triggerId));return p.enabled&&allowed;}),resources=this.resourceSelection(scope.workspaceId,packages);
    return freeze(clone({workspaceId:scope.workspaceId,entityId:scope.entityId,triggerId:scope.triggerId,entityPolicyRevision:binding.version,packagePolicyVersion:JSON.stringify(all.map(p=>[p.id,p.version])),packages:packages.map(p=>({id:p.id,version:p.version})),resources,...executionCapabilityResources(resources)}));
  }
  setEnabled(scope:CapabilityScope,packageId:string,input:unknown){
    object(input,['enabled','expectedVersion']);if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.expectedVersion))fail(400,'invalid_capability_configuration');
    return this.store.transaction(()=>{this.entity(scope.workspaceId,scope.entityId);const row=this.store.one<{version:number;config_json:string}>('SELECT version,config_json FROM capability_packages WHERE workspace_id=? AND entity_id=? AND id=?',scope.workspaceId,scope.entityId,packageId);if(!row)fail(404,'capability_package_not_found');if(row!.version!==input.expectedVersion)fail(409,'capability_version_conflict');const config={...JSON.parse(row!.config_json),enabled:input.enabled};if(!this.store.run('UPDATE capability_packages SET version=version+1,config_json=? WHERE id=? AND version=?',JSON.stringify(config),packageId,row!.version).changes)fail(409,'capability_version_conflict');return this.packageDto(scope.workspaceId,scope.entityId,packageId,row!.version+1,config);});
  }
  getDirectoryAccess(workspaceId:string,entityId:string):DirectoryAccessConfig {
    this.entity(workspaceId,entityId);
    const row=this.store.one<{revision:number;allow_json:string;deny_json:string;allow_group_members:number;channel_policies_json:string}>('SELECT * FROM entity_directory_policies WHERE workspace_id=? AND entity_id=?',workspaceId,entityId);
    const saved:DirectoryChannelPolicy[]=row?JSON.parse(row.channel_policies_json):[];
    const allow:DirectoryAccessRule[]=JSON.parse(row?.allow_json??'[]'),deny:DirectoryAccessRule[]=JSON.parse(row?.deny_json??'[]'),allowGroupMembers=row?.allow_group_members===1;
    // Project legacy behavior without rewriting data or changing an existing implicit all policy.
    const channelPolicies=(this.directory?.list?.(workspaceId,entityId)??[]).map(c=>{
      const policy=saved.find(p=>p.sourceId===c.sourceId);
      return policy?{...policy,allowGroupMembers:policy.allowGroupMembers??(c.provider==='wecom'?false:allowGroupMembers)}:{sourceId:c.sourceId,mode:c.provider==='wecom'?'all' as const:'allowlist' as const,allow:allow.filter(r=>r.sourceId===c.sourceId),deny:deny.filter(r=>r.sourceId===c.sourceId),allowGroupMembers:c.provider==='wecom'?false:allowGroupMembers,revision:row?.revision??0};
    });
    return {revision:row?.revision??0,allow,deny,allowGroupMembers,channelPolicies};
  }
  private writeDirectoryAccess(workspaceId:string,entityId:string,value:DirectoryAccessConfig){
    this.store.run('INSERT INTO entity_directory_policies(entity_id,workspace_id,revision,allow_json,deny_json,allow_group_members,channel_policies_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(entity_id) DO UPDATE SET revision=excluded.revision,allow_json=excluded.allow_json,deny_json=excluded.deny_json,allow_group_members=excluded.allow_group_members,channel_policies_json=excluded.channel_policies_json',entityId,workspaceId,value.revision,JSON.stringify(value.allow),JSON.stringify(value.deny),Number(value.allowGroupMembers===true),JSON.stringify(value.channelPolicies??[]));
    this.invalidateAdmission(workspaceId,entityId);return this.getDirectoryAccess(workspaceId,entityId);
  }
  private channelPolicy(workspaceId:string,entityId:string,input:unknown,previous:DirectoryAccessConfig):DirectoryChannelPolicy{
    object(input,['sourceId','mode','allow','deny','allowGroupMembers','expectedRevision']);
    const old=previous.channelPolicies?.find(p=>p.sourceId===input.sourceId);
    if(!old)fail(400,'directory_source_not_found');
    if(input.mode!==undefined&&!['all','allowlist','denylist'].includes(String(input.mode))||input.allowGroupMembers!==undefined&&typeof input.allowGroupMembers!=='boolean')fail(400,'invalid_capability_configuration');
    if(input.expectedRevision!==undefined&&(!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<0))fail(400,'invalid_capability_configuration');
    if(input.expectedRevision!==undefined&&input.expectedRevision!==old!.revision)fail(409,'directory_policy_changed');
    const validate=(key:'allow'|'deny')=>{const rules=input[key]??old![key];if(!Array.isArray(rules)||rules.some(r=>!r||r.sourceId!==input.sourceId))fail(400,'invalid_directory_access_rule');return this.directory!.validateRules(workspaceId,entityId,rules,old![key]);};
    return {sourceId:old!.sourceId,mode:(input.mode??old!.mode) as DirectoryChannelPolicy['mode'],allow:validate('allow'),deny:validate('deny'),allowGroupMembers:(input.allowGroupMembers??old!.allowGroupMembers)===true,revision:old!.revision+1};
  }
  private directoryRules(workspaceId:string,entityId:string,input:unknown,retained?:CapabilityPackageInput['directoryAccess']):NonNullable<CapabilityPackageInput['directoryAccess']> {
    if(!this.directory)fail(503,'directory_unavailable');object(input,['allow','deny','channelPolicies']);
    const value:NonNullable<CapabilityPackageInput['directoryAccess']>={allow:this.directory!.validateRules(workspaceId,entityId,input.allow??[],retained?.allow),deny:this.directory!.validateRules(workspaceId,entityId,input.deny??[],retained?.deny)};
    if(input.channelPolicies===undefined){if(retained?.channelPolicies)value.channelPolicies=clone(retained.channelPolicies);return value;}
    if(!Array.isArray(input.channelPolicies)||input.channelPolicies.length>20)fail(400,'invalid_capability_configuration');
    const sources=this.directory!.list(workspaceId,entityId),seen=new Set<string>();
    value.channelPolicies=(input.channelPolicies as unknown[]).map(input=>{
      object(input,['sourceId','mode','allow','deny','legacyAllowCheck']);
      if(input.legacyAllowCheck!==undefined&&input.legacyAllowCheck!==true)fail(400,'invalid_capability_configuration');
      if(typeof input.sourceId!=='string'||!sources.some(c=>c.sourceId===input.sourceId))return fail(400,'directory_source_not_found');
      if(seen.has(input.sourceId)||!['inherit','allowlist','denylist'].includes(String(input.mode)))fail(400,'invalid_capability_configuration');seen.add(input.sourceId);
      const old=retained?.channelPolicies?.find(p=>p.sourceId===input.sourceId);
      const validate=(key:'allow'|'deny')=>{const rules=input[key]??[];if(!Array.isArray(rules)||rules.some(r=>!r||r.sourceId!==input.sourceId))fail(400,'invalid_directory_access_rule');return this.directory!.validateRules(workspaceId,entityId,rules,old?.[key]??retained?.[key]);};
      return {sourceId:input.sourceId,mode:input.mode as DirectoryPackageChannelPolicy['mode'],allow:validate('allow'),deny:validate('deny'),...(input.legacyAllowCheck===true?{legacyAllowCheck:true as const}:{})};
    });return value;
  }
  saveDirectoryAccess(workspaceId:string,entityId:string,input:unknown):DirectoryAccessConfig {
    this.entity(workspaceId,entityId);object(input,['allow','deny','allowGroupMembers','expectedRevision','channelPolicies']);
    if(!this.directory)fail(503,'directory_unavailable');
    if(input.allowGroupMembers!==undefined&&typeof input.allowGroupMembers!=='boolean'||input.expectedRevision!==undefined&&!Number.isSafeInteger(input.expectedRevision))fail(400,'invalid_capability_configuration');
    return this.store.transaction(()=>{const previous=this.getDirectoryAccess(workspaceId,entityId);if(input.expectedRevision!==undefined&&previous.revision!==input.expectedRevision)fail(409,'directory_policy_changed');
      const value={allow:input.allow===undefined?previous.allow:this.directory!.validateRules(workspaceId,entityId,input.allow,previous.allow),deny:input.deny===undefined?previous.deny:this.directory!.validateRules(workspaceId,entityId,input.deny,previous.deny)};
      let channelPolicies=[...previous.channelPolicies??[]];
      // Legacy whole-employee writes remain supported, but are translated into source-local policies.
      if(input.allow!==undefined||input.deny!==undefined||input.allowGroupMembers!==undefined)channelPolicies=channelPolicies.map(p=>({...p,...(input.allow!==undefined?{allow:value.allow.filter(r=>r.sourceId===p.sourceId)}:{}),...(input.deny!==undefined?{deny:value.deny.filter(r=>r.sourceId===p.sourceId)}:{}),...(input.allowGroupMembers!==undefined?{allowGroupMembers:input.allowGroupMembers===true}:{}),revision:p.revision+1}));
      if(input.channelPolicies!==undefined){if(!Array.isArray(input.channelPolicies)||input.channelPolicies.length>20)fail(400,'invalid_capability_configuration');const changed=(input.channelPolicies as unknown[]).map(p=>this.channelPolicy(workspaceId,entityId,p,previous));if(new Set(changed.map(p=>p.sourceId)).size!==changed.length)fail(400,'invalid_capability_configuration');channelPolicies=channelPolicies.map(p=>changed.find(c=>c.sourceId===p.sourceId)??p);}
      return this.writeDirectoryAccess(workspaceId,entityId,{...value,channelPolicies,revision:previous.revision+1,allowGroupMembers:(input.allowGroupMembers??previous.allowGroupMembers)===true});});
  }
  patchDirectoryAccess(workspaceId:string,entityId:string,input:unknown):DirectoryAccessConfig {
    this.entity(workspaceId,entityId);object(input,['sourceId','mode','allow','deny','expectedRevision','allowGroupMembers']);
    if(!this.directory)fail(503,'directory_unavailable');
    if(typeof input.sourceId!=='string'||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<0)fail(400,'invalid_capability_configuration');
    return this.store.transaction(()=>{const previous=this.getDirectoryAccess(workspaceId,entityId),changed=this.channelPolicy(workspaceId,entityId,input,previous);
      const allow=[...previous.allow.filter(r=>r.sourceId!==changed.sourceId),...changed.allow],deny=[...previous.deny.filter(r=>r.sourceId!==changed.sourceId),...changed.deny];
      return this.writeDirectoryAccess(workspaceId,entityId,{...previous,allow,deny,revision:previous.revision+1,channelPolicies:previous.channelPolicies!.map(p=>p.sourceId===changed.sourceId?changed:p)});
    });
  }
  private channelSource(scope:ChannelAccessScope,connection:ChannelConnection){return this.directory?.list(scope.workspaceId,scope.entityId).find(c=>c.id===connection.connectionId);}
  private async channelPolicyDecision(scope:ChannelAccessScope,connection:ChannelConnection,kind:'private'|'group'|'meeting',policy:DirectoryAccessConfig,evaluation?:DirectoryEvaluation){
    const source=this.channelSource(scope,connection),p=policy.channelPolicies?.find(p=>p.sourceId===source?.sourceId);
    if(!p)return {allowed:false,cacheable:false};
    const groupMemberAccess=p.allowGroupMembers===true&&kind==='group'&&!!scope.groupContext;
    const rules={allow:p.mode==='allowlist'?p.allow:[],deny:p.deny};
    // Matching deny rules win; the directory adapter fails closed on unknown identity mappings.
    return this.directoryDecisionResult(scope,connection,kind,rules,p.mode!=='allowlist',evaluation,groupMemberAccess);
  }
  private async packageChannelDecision(scope:ChannelAccessScope,connection:ChannelConnection,kind:'private'|'group'|'meeting',p:CapabilityPackage,evaluation?:DirectoryEvaluation){
    const source=this.channelSource(scope,connection),saved=p.directoryAccess??{allow:[],deny:[]},policy=saved.channelPolicies?.find(p=>p.sourceId===source?.sourceId);
    const rules=policy?{allow:policy.mode==='allowlist'||policy.legacyAllowCheck===true?policy.allow:[],deny:policy.deny}:{allow:saved.allow.filter(r=>r.sourceId===source?.sourceId),deny:saved.deny.filter(r=>r.sourceId===source?.sourceId)};
    return this.directoryDecision(scope,connection,kind,rules,policy?policy.mode!=='allowlist':p.mode==='inherit',evaluation);
  }

  private async directoryDecisionResult(scope:ChannelAccessScope,connection:ChannelConnection,kind:'private'|'group'|'meeting',rules:{allow:readonly DirectoryAccessRule[];deny:readonly DirectoryAccessRule[]},inherit=false,evaluation:DirectoryEvaluation|undefined=this.directory?.beginEvaluation(),groupMemberAccess=false):Promise<{allowed:boolean;cacheable:boolean}> {
    if(!this.directory||!evaluation||scope.workspaceId!==connection.workspaceId)return{allowed:false,cacheable:false};
    const deny=await Promise.all(rules.deny.map(rule=>this.directory!.matches(scope.workspaceId,rule,scope,connection,kind,evaluation)));if(deny.some(v=>v!==false))return{allowed:false,cacheable:!deny.includes('unknown')};
    if(groupMemberAccess)return{allowed:true,cacheable:true};
    const allow=await Promise.all(rules.allow.map(rule=>this.directory!.matches(scope.workspaceId,rule,scope,connection,kind,evaluation))),unknown=allow.includes('unknown');
    // A proven whitelist match does not depend on other pending identities.
    // Preserve legacy inheritance's fail-closed positive-list dependency.
    return{allowed:inherit?!unknown:allow.includes(true),cacheable:!unknown};
  }
  private async directoryDecision(scope:ChannelAccessScope,connection:ChannelConnection,kind:'private'|'group'|'meeting',rules:{allow:readonly DirectoryAccessRule[];deny:readonly DirectoryAccessRule[]},inherit=false,evaluation?:DirectoryEvaluation):Promise<boolean>{return(await this.directoryDecisionResult(scope,connection,kind,rules,inherit,evaluation)).allowed;}
  /** Host ingress supplies authenticated actor identity; not a public user-id authorization API. */
  async authorizeChannel(scope:ChannelAccessScope,connection:ChannelConnection,kind:'private'|'group'|'meeting',evaluation?:DirectoryEvaluation):Promise<boolean> {
    const directory=this.directory;if(!directory)return false;
    const group=JSON.stringify([scope.workspaceId,scope.entityId]),key=JSON.stringify([scope.workspaceId,scope.entityId,scope.requesterKind,scope.requesterId,scope.requesterIdentity?.idNamespace,scope.requesterIdentity?.applicationId,connection.provider,connection.tenantId,connection.connectionId,connection.identity.kind,connection.identity.externalId,kind,scope.groupContext?.conversationId??null,scope.groupContext!==undefined]);
    for(let attempt=0;attempt<2;attempt++){
      const binding=directory.admissionGuard(scope,connection);if(!binding)return false;
      this.assertActive(scope);const generation=this.admissionCache.generation(group);if(generation===undefined)return false;
      const cached=this.admissionCache.get(group,key,binding);if(cached){
        if(connection.provider==='wecom'){if(!await directory.validateCachedAdmission(scope,connection))return false;this.assertActive(scope);if(directory.admissionGuard(scope,connection)!==binding)return false;if(!this.admissionCache.current(group,generation)||this.admissionCache.get(group,key,binding)!==cached)continue;}
        return cached.allowed;
      }
      const policy=this.getDirectoryAccess(scope.workspaceId,scope.entityId),decision=await this.channelPolicyDecision(scope,connection,kind,policy,attempt===0?evaluation:undefined);
      this.assertActive(scope);if(directory.admissionGuard(scope,connection)!==binding)return false;
      if(!this.admissionCache.current(group,generation))continue;
      if(this.getDirectoryAccess(scope.workspaceId,scope.entityId).revision!==policy.revision){this.invalidateAdmission(scope.workspaceId,scope.entityId);continue;}
      // Unknown rules prevent reuse, not a separately proven current grant.
      if(!decision.cacheable)return decision.allowed;
      if(this.admissionCache.put(group,key,generation,binding,decision.allowed))return decision.allowed;
    }
    return false;
  }
  async usableChannel(scope:ChannelAccessScope,connection:ChannelConnection,kind:'private'|'group'|'meeting') {
    const policyRevision=this.getDirectoryAccess(scope.workspaceId,scope.entityId).revision,evaluation=this.directory?.beginEvaluation();
    if(!await this.authorizeChannel(scope,connection,kind,evaluation))fail(403,'entity_use_forbidden');
    const packages=this.list(scope.workspaceId,scope.entityId);
    const result:CapabilityPackage[]=[];
    for(const p of packages.map(activeUserPolicy))if(p.enabled&&(!p.conversationKinds||p.conversationKinds.includes(kind))&&await this.packageChannelDecision(scope,connection,kind,p,evaluation))result.push(p);
    if(this.getDirectoryAccess(scope.workspaceId,scope.entityId).revision!==policyRevision||JSON.stringify(this.list(scope.workspaceId,scope.entityId))!==JSON.stringify(packages))fail(409,'capability_configuration_changed');
    return result;
  }
  /** Only an internal host admission receipt skips employee policy; packages and bindings stay current. */
  async executionPackages(scope:ChannelAccessScope,connection:ChannelConnection,kind:'private'|'group'|'meeting',admission?:{employeeUseAdmitted:true}){
    const policyRevision=this.getDirectoryAccess(scope.workspaceId,scope.entityId).revision;
    if(admission?.employeeUseAdmitted!==true&&!await this.authorizeChannel(scope,connection,kind))fail(403,'entity_use_forbidden');
    const evaluation=this.directory?.beginEvaluation(),packages=this.list(scope.workspaceId,scope.entityId),result:CapabilityPackage[]=[];
    for(const p of packages.map(activeUserPolicy))if(p.enabled&&(!p.conversationKinds||p.conversationKinds.includes(kind))&&await this.packageChannelDecision(scope,connection,kind,p,evaluation))result.push(p);
    if(admission?.employeeUseAdmitted!==true&&this.getDirectoryAccess(scope.workspaceId,scope.entityId).revision!==policyRevision||JSON.stringify(this.list(scope.workspaceId,scope.entityId))!==JSON.stringify(packages))fail(409,'capability_configuration_changed');
    return result;
  }
  private facts(scope: CapabilityScope): {entity:EntityAccessPolicy;request:AccessRequest;revision:number} {
    const entity=this.entity(scope.workspaceId,scope.entityId),member=this.members(scope.workspaceId).find(m=>m.userId===scope.userId),policy=this.getWebAccess(scope.workspaceId,scope.entityId);
    if (!member) return fail(403,'entity_use_forbidden');
    const channel={channelType:'web',tenantId:scope.workspaceId,installationId:'platform-web'};
    const request:AccessRequest={workspaceId:scope.workspaceId,principal:{status:'known',value:{channelType:'web',tenantId:scope.workspaceId,identityNamespace:'platform-user',externalUserId:scope.userId}},channel,conversation:{id:'web-private',kind:'private'},workspaceMemberIds:{status:'known',value:[member.id]},verifiedGroupIds:{status:'known',value:[]},identifiedInWorkspace:{status:'known',value:true}};
    return {entity:{workspaceId:scope.workspaceId,enabled:policy.revision>0 || entity.own_web_use===1,allow:[this.rule(scope.workspaceId,policy.allowWorkspaceMembers?[...new Set([...policy.allowMemberIds,member.id])]:policy.allowMemberIds)],deny:[this.rule(scope.workspaceId,policy.denyMemberIds)]},request,revision:policy.revision};
  }
  private rule(workspaceId:string,ids:readonly string[]):AccessRule { return {requester:{kind:'workspace_members',ids},channel:{channel:{channelType:'web',tenantId:workspaceId,installationId:'platform-web'},kinds:['private']}}; }
  assertActive(scope:{workspaceId:string;entityId:string}):void {const e=this.store.one<{lifecycle_enabled:number}>('SELECT lifecycle_enabled FROM entities WHERE workspace_id=? AND id=?',scope.workspaceId,scope.entityId);if(!e)return fail(404,'entity_not_found');if(!e.lifecycle_enabled)fail(409,'employee_disabled');}
  authorizeEntity(scope:CapabilityScope):void { const f=this.facts(scope); if (!evaluateEntityAccess(f.entity,f.request).allowed) fail(403,'entity_use_forbidden'); }
  authorizeLocal(scope:CapabilityScope):void {this.entity(scope.workspaceId,scope.entityId);if(!this.store.one("SELECT m.id FROM members m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND m.status='active' AND u.status='active' AND w.status='active'",scope.workspaceId,scope.userId))fail(403,'workspace_member_required');}
  resolveForAdmittedTask(scope:CapabilityScope):CapabilitySnapshot {
    this.authorizeLocal(scope);const f=this.facts(scope),member=this.members(scope.workspaceId).find(m=>m.userId===scope.userId)!;
    const admitted:EntityAccessPolicy={workspaceId:scope.workspaceId,enabled:true,allow:[this.rule(scope.workspaceId,[member.id])],deny:[]};
    const available=this.list(scope.workspaceId,scope.entityId),packages=available.map(activeUserPolicy).filter(p=>(!p.conversationKinds||p.conversationKinds.includes('private'))&&evaluatePackageAccess(admitted,{enabled:p.enabled,mode:p.mode,allow:[this.rule(scope.workspaceId,p.allowMemberIds)],deny:[this.rule(scope.workspaceId,p.denyMemberIds)]},f.request).allowed);
    return this.webSnapshot(scope,f.revision,available,packages);
  }
  validatePreparedSnapshot(scope:CapabilityScope,snapshot:CapabilitySnapshot):void {
    this.authorizeLocal(scope);if(!snapshot||snapshot.workspaceId!==scope.workspaceId||snapshot.entityId!==scope.entityId||snapshot.userId!==scope.userId)fail(403,'capability_snapshot_scope_mismatch');
    const packages=this.list(scope.workspaceId,scope.entityId);
    if(snapshot.packagePolicyVersion!==JSON.stringify(packages.map(p=>[p.id,p.version])))fail(409,'capability_configuration_changed');
    for(const p of snapshot.packages)if(!packages.some(current=>current.id===p.id&&current.version===p.version&&current.enabled))fail(409,'capability_configuration_changed');
    for(const r of snapshot.resources)if(JSON.stringify(this.approved(r.resource.id,scope.workspaceId))!==JSON.stringify(r.resource))fail(409,'capability_configuration_changed');
  }
  usable(scope:CapabilityScope) {
    const f=this.facts(scope); this.authorizeEntity(scope);
    const packages=this.list(scope.workspaceId,scope.entityId).map(activeUserPolicy).filter(p=>(!p.conversationKinds||p.conversationKinds.includes('private'))&&evaluatePackageAccess(f.entity,{enabled:p.enabled,mode:p.mode,allow:[this.rule(scope.workspaceId,p.allowMemberIds)],deny:[this.rule(scope.workspaceId,p.denyMemberIds)]},f.request).allowed);
    const selected=new Set(packages.flatMap(p=>p.resourceIds));
    return {packages,resources:this.resources(scope.workspaceId).filter(r=>selected.has(r.id))};
  }
  resolveForTask(scope:CapabilityScope):CapabilitySnapshot {return this.snapshotForPackages(scope,this.usable(scope).packages.map(p=>p.id));}
  private snapshotForPackages(scope:CapabilityScope,packageIds:readonly string[]):CapabilitySnapshot {
    if(!Array.isArray(packageIds)||!packageIds.every(id)||new Set(packageIds).size!==packageIds.length)fail(400,'invalid_configuration_ids');
    const ids=[...packageIds],f=this.facts(scope),usable=this.usable(scope);
    const packages=ids.map(packageId=>usable.packages.find(p=>p.id===packageId)??fail(403,'capability_package_forbidden'));
    return this.webSnapshot(scope,f.revision,this.list(scope.workspaceId,scope.entityId),packages);
  }
  private webSnapshot(scope:CapabilityScope,revision:number,available:readonly CapabilityPackage[],packages:readonly CapabilityPackage[]):CapabilitySnapshot {
    const resources=this.resourceSelection(scope.workspaceId,packages);
    const projected:RoleResource[]=resources.flatMap(({packageId,resource}):RoleResource[]=>resource.kind==='skill'?[{kind:'skill',id:resource.id,packageId}]:resource.kind==='execution'?[]:resource.allowedTools.map(toolName=>({kind:'mcp_tool',id:resource.id+':'+toolName,packageId,connectionId:resource.serverRef,toolName})));
    if(!projectRoleResources('execution',projected,projected).valid)fail(403,'role_resource_forbidden');
    return freeze(clone({workspaceId:scope.workspaceId,entityId:scope.entityId,userId:scope.userId,entityPolicyRevision:revision,packagePolicyVersion:JSON.stringify(available.map(p=>[p.id,p.version])),packages:packages.map(p=>({id:p.id,version:p.version})),resources,...executionCapabilityResources(resources)}));
  }

  revalidateCurrent(scope:CapabilityScope,snapshot:CapabilitySnapshot):void {
    if (!snapshot || snapshot.workspaceId!==scope.workspaceId || snapshot.entityId!==scope.entityId || snapshot.userId!==scope.userId) fail(403,'capability_snapshot_scope_mismatch');
    const current=this.snapshotForPackages(scope,snapshot.packages.map(p=>p.id));
    // Preparation fences cover the catalog at one commit point; a later unrelated grant is not a dependency of this selected snapshot.
    const {packagePolicyVersion:_currentFence,...currentFacts}=current,{packagePolicyVersion:_savedFence,...savedFacts}=snapshot;
    if (JSON.stringify(currentFacts)!==JSON.stringify(savedFacts)) fail(409,'capability_configuration_changed');
  }
}
export async function registerCapabilityConfigRoutes(app:FastifyInstance,service:CapabilityConfigService,auth:{requireManager:(request:FastifyRequest,workspaceId:string,entityId:string)=>void|Promise<void>;requireWorkspaceManager?:(request:FastifyRequest,workspaceId:string)=>void|Promise<void>;currentUser:(request:FastifyRequest)=>{id:string}|Promise<{id:string}>}) {
  const base='/api/workspaces/:workspaceId/entities/:entityId';
  const route=(method:'GET'|'POST'|'PUT'|'PATCH',suffix:string,manager:boolean,fn:(scope:CapabilityScope,request:FastifyRequest)=>unknown)=>app.route({method,url:base+suffix,handler:async(request,reply)=>{
    const {workspaceId,entityId}=request.params as {workspaceId:string;entityId:string};
    const user=await auth.currentUser(request); if(manager) await auth.requireManager(request,workspaceId,entityId);
    try{return fn({workspaceId,entityId,userId:user.id},request);}catch(error){if(error instanceof CapabilityConfigError)return reply.code(error.status).send({error:error.code});throw error;}
  }});
  route('GET','/web-access',true,s=>service.getWebAccess(s.workspaceId,s.entityId));
  route('PUT','/web-access',true,(s,r)=>service.saveWebAccess(s.workspaceId,s.entityId,r.body));
  route('GET','/directory-access',true,s=>service.getDirectoryAccess(s.workspaceId,s.entityId));
  route('PUT','/directory-access',true,(s,r)=>service.saveDirectoryAccess(s.workspaceId,s.entityId,r.body));
  route('PATCH','/directory-access',true,(s,r)=>service.patchDirectoryAccess(s.workspaceId,s.entityId,r.body));
  route('GET','/trigger-options',true,s=>service.triggerOptions(s.workspaceId,s.entityId));
  route('GET','/handoff-access',true,s=>service.getHandoffAccess(s.workspaceId,s.entityId));
  route('PUT','/handoff-access',true,(s,r)=>service.saveHandoffAccess(s.workspaceId,s.entityId,r.body));
  route('GET','/handoff-options',true,s=>service.handoffOptions(s.workspaceId,s.entityId));
  route('GET','/configuration-members',true,s=>service.members(s.workspaceId));
  route('GET','/resource-catalog',true,s=>service.resources(s.workspaceId));
  const workspaceBase='/api/workspaces/:workspaceId';
  app.get(workspaceBase+'/resource-catalog',async request=>{const {workspaceId}=request.params as {workspaceId:string};await auth.currentUser(request);if(!auth.requireWorkspaceManager)fail(403,'role_forbidden');await auth.requireWorkspaceManager!(request,workspaceId);return service.resources(workspaceId);});
  for(const root of [base,workspaceBase])app.post(root+'/skill-resources',{bodyLimit:400000},async(request,reply)=>{const {workspaceId,entityId}=request.params as {workspaceId:string;entityId?:string};await auth.currentUser(request);if(entityId)return reply.code(400).send({error:'employee_resource_creation_forbidden'});else{if(!auth.requireWorkspaceManager)fail(403,'role_forbidden');await auth.requireWorkspaceManager!(request,workspaceId);}if(!service.uploadedSkills)return reply.code(503).send({error:'skill_upload_unavailable'});try{return service.uploadedSkills.upload(workspaceId,request.body);}catch(error){if(error instanceof CapabilityConfigError)return reply.code(error.status).send({error:error.code});throw error;}});
  route('GET','/capability-packages',true,s=>service.list(s.workspaceId,s.entityId));
  route('POST','/capability-packages',true,(s,r)=>service.save(s.workspaceId,s.entityId,r.body));
  route('PUT','/capability-packages/:packageId',true,(s,r)=>service.save(s.workspaceId,s.entityId,r.body,(r.params as {packageId:string}).packageId));
  route('PUT','/capability-packages/:packageId/status',true,(s,r)=>service.setEnabled(s,(r.params as {packageId:string}).packageId,r.body));
  route('GET','/usable-capabilities',false,s=>service.usable(s));
}
