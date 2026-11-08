import {receivedWorkItemResourceProof,workItemResourceLineage} from '../work-items/resource-lineage.js';
import {createHash,randomUUID} from 'node:crypto';
import {TaskError} from '@dentity/application';
import type {Store} from '../store.js';
import type {AssetReadKind,AssetRunScope,AssetSourceScope,AssetUnavailable,AssetResolution} from '../assets/service.js';

export interface SelectedMaterial {
 sourceRun:AssetRunScope;sourceAssetId:string;sourceReadKind:AssetReadKind;
 originRun:AssetRunScope;originAssetId:string;originReadKind:AssetReadKind;
 version:string;name:string;targetEmployeeId:string;
}
export interface WorkItemMaterialPort {
 list(run:AssetRunScope):unknown[];
 select(run:AssetRunScope,refs:unknown,targetEmployeeId:string):Promise<SelectedMaterial[]>;
 validate(run:AssetRunScope,selected:readonly SelectedMaterial[],targetEmployeeId:string):Promise<void>;
 grant(sourceRun:AssetRunScope,targetRun:AssetRunScope,selected:readonly SelectedMaterial[],proof:{intentId:string;assignmentId:string}):void;
 revalidateForRun(run:AssetRunScope):Promise<void>;
}
export interface OriginalSourceMaterial {assetId:string;readKind:AssetReadKind;version:string;name:string;source:AssetSourceScope}
interface TransferRow {id:string;workspace_id:string;source_task_id:string;source_run_id:string;origin_task_id:string;origin_run_id:string;target_task_id:string;target_run_id:string;target_entity_id:string;intent_id:string;assignment_id:string;descriptor_json:string;created_at:number}
interface SourceHost {
 list(run:AssetRunScope):OriginalSourceMaterial[];
 inspect(run:AssetRunScope,id:string,kind:AssetReadKind):OriginalSourceMaterial;
 read(run:AssetRunScope,id:string,kind:AssetReadKind):Promise<Response|AssetUnavailable>;
 assertSource(source:AssetSourceScope):void|Promise<void>;
 retain(id:string,targetTaskId:string):void;
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function fail(code:string):never{throw new TaskError(403,code);}
const kinds:readonly string[]=['content','summary','transcript'];
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** A transferred alias is one immutable prepared read, not a grant to the original asset or
 * conversation. Every hop keeps its immediate selection and original resource provenance. */
export class SourceMaterialTransfers implements WorkItemMaterialPort {
 private readonly validations=new Map<string,{expiresAt:number;fingerprint:string}>();
 constructor(private readonly store:Store,private readonly host:SourceHost,private readonly now:()=>number){
  store.db.exec(`CREATE TABLE IF NOT EXISTS source_material_transfers(
   id TEXT NOT NULL,workspace_id TEXT NOT NULL,source_task_id TEXT NOT NULL,source_run_id TEXT NOT NULL,
   origin_task_id TEXT NOT NULL,origin_run_id TEXT NOT NULL,target_task_id TEXT NOT NULL,target_run_id TEXT NOT NULL,
   target_entity_id TEXT NOT NULL,intent_id TEXT NOT NULL,assignment_id TEXT NOT NULL,descriptor_json TEXT NOT NULL,
   created_at INTEGER NOT NULL,PRIMARY KEY(id,target_run_id));
   CREATE INDEX IF NOT EXISTS source_material_transfer_target ON source_material_transfers(target_run_id,target_task_id);`);
 }
 private rows(run:AssetRunScope){return this.store.all<TransferRow>('SELECT * FROM source_material_transfers WHERE target_run_id=? AND target_task_id=? AND workspace_id=? AND target_entity_id=? ORDER BY id',run.runId,run.taskId,run.workspaceId,run.entityId);}
 owns(id:string){return !!this.store.one('SELECT id FROM source_material_transfers WHERE id=? LIMIT 1',id);}
 private row(run:AssetRunScope,id:string){return this.rows(run).find(row=>row.id===id)??fail('source_material_not_granted');}
 private task(run:AssetRunScope){const task=this.store.one<{id:string;workspace_id:string;entity_id:string;run_id:string;source_json:string}>('SELECT id,workspace_id,entity_id,run_id,source_json FROM tasks WHERE id=?',run.taskId);if(!task||task.workspace_id!==run.workspaceId||task.entity_id!==run.entityId||!this.store.one('SELECT id FROM runs WHERE id=? AND task_id=?',run.runId,run.taskId))return fail('source_material_task_changed');return task;}
 private selected(row:TransferRow){return JSON.parse(row.descriptor_json)as SelectedMaterial;}
 private assertTarget(sourceRun:AssetRunScope,targetRun:AssetRunScope,selected:readonly SelectedMaterial[],proof:{intentId:string;assignmentId:string},existing=false){
  const source=this.task(sourceRun),target=this.task(targetRun);
  if(sourceRun.workspaceId!==targetRun.workspaceId||(!existing&&source.run_id!==sourceRun.runId))fail('source_material_source_changed');
  const intent=this.store.one<{task_id:string;run_id:string;state:string;checkpoint_ref:string|null;prepared_json:string}>('SELECT task_id,run_id,state,checkpoint_ref,prepared_json FROM work_item_intents WHERE id=?',proof.intentId);
  const dispatch=this.store.one<{source_task_id:string;source_run_id:string;task_id:string|null;assignment_id:string;state:string}>('SELECT source_task_id,source_run_id,task_id,assignment_id,state FROM work_item_dispatches WHERE id=?',proof.intentId);
  const assignment=this.store.one<{employee_id:string;source_employee_id:string;grant_id:string;work_item_id:string}>('SELECT employee_id,source_employee_id,grant_id,work_item_id FROM work_item_assignments WHERE id=?',proof.assignmentId);
  const scope=JSON.parse(target.source_json)as{assignment?:{assignmentId?:string;targetEmployeeId?:string;sourceEmployeeId?:string;grantId?:string;workItemId?:string}};
  if(!intent||intent.state!=='committed'||!intent.checkpoint_ref||intent.task_id!==sourceRun.taskId||intent.run_id!==sourceRun.runId||!dispatch||dispatch.source_task_id!==sourceRun.taskId||dispatch.source_run_id!==sourceRun.runId||dispatch.task_id!==targetRun.taskId||dispatch.state!=='done'||dispatch.assignment_id!==proof.assignmentId||!assignment||assignment.employee_id!==targetRun.entityId||assignment.source_employee_id!==sourceRun.entityId||scope.assignment?.assignmentId!==proof.assignmentId||scope.assignment.targetEmployeeId!==targetRun.entityId||scope.assignment.sourceEmployeeId!==sourceRun.entityId||scope.assignment.grantId!==assignment.grant_id||scope.assignment.workItemId!==assignment.work_item_id)fail('source_material_target_not_authorized');
  const durable=this.store.one<{fingerprint:string;package_digest:string;source_run_id:string}>('SELECT fingerprint,package_digest,source_run_id FROM work_item_resource_transfers WHERE target_task_id=? AND source_task_id=? AND intent_id=? AND assignment_id=?',targetRun.taskId,sourceRun.taskId,proof.intentId,proof.assignmentId);
  if(!durable||durable.source_run_id!==sourceRun.runId||durable.package_digest!==createHash('sha256').update(intent.prepared_json).digest('hex')||durable.fingerprint!==workItemResourceLineage(this.store,source).fingerprint)fail('source_material_durable_proof_changed');
  receivedWorkItemResourceProof(this.store,target);
  const approved=(JSON.parse(intent.prepared_json)as{materials?:SelectedMaterial[]}).materials??[];
  if(existing){if(selected.some(item=>!approved.some(ref=>same(ref,item))))fail('source_material_selection_changed');}
  else if(!same(approved,selected))fail('source_material_selection_changed');
  if(selected.some(item=>!same(item.sourceRun,sourceRun)||item.targetEmployeeId!==targetRun.entityId))fail('source_material_target_not_authorized');
 }
 private assertRow(row:TransferRow,run:AssetRunScope){const selected=this.selected(row);if(row.workspace_id!==run.workspaceId||row.target_task_id!==run.taskId||row.target_run_id!==run.runId||row.target_entity_id!==run.entityId||row.source_task_id!==selected.sourceRun.taskId||row.source_run_id!==selected.sourceRun.runId||row.origin_task_id!==selected.originRun.taskId||row.origin_run_id!==selected.originRun.runId)fail('source_material_binding_changed');this.assertTarget(selected.sourceRun,run,[selected],{intentId:row.intent_id,assignmentId:row.assignment_id},true);return selected;}
 private origin(selected:SelectedMaterial,seen=new Set<string>()):OriginalSourceMaterial {
  if(selected.sourceRun.workspaceId!==selected.originRun.workspaceId||!/^([a-f0-9]{64})$/.test(selected.version))return fail('source_material_source_changed');
  const key=JSON.stringify([selected.sourceRun,selected.sourceAssetId]);if(seen.has(key)||seen.size>=100)return fail('source_material_lineage_invalid');seen.add(key);
  if(this.owns(selected.sourceAssetId)){
   if(selected.sourceReadKind!=='content')return fail('source_material_read_kind_not_granted');
   const row=this.row(selected.sourceRun,selected.sourceAssetId),prior=this.assertRow(row,selected.sourceRun);
   if(!same(prior.originRun,selected.originRun)||prior.originAssetId!==selected.originAssetId||prior.originReadKind!==selected.originReadKind||prior.version!==selected.version)return fail('source_material_selection_changed');
   return this.origin(prior,seen);
  }
  if(!same(selected.sourceRun,selected.originRun)||selected.sourceAssetId!==selected.originAssetId||selected.sourceReadKind!==selected.originReadKind)return fail('source_material_origin_changed');
  this.task(selected.originRun);
  const original=this.host.inspect(selected.originRun,selected.originAssetId,selected.originReadKind);
  if(original.version!==selected.version)return fail('source_material_version_changed');return original;
 }
 list(run:AssetRunScope){return [...this.host.list(run).map(value=>({name:value.name,materialRef:{kind:'source_asset',assetId:value.assetId,readKind:value.readKind,version:value.version}})),...this.rows(run).map(row=>{const selected=this.assertRow(row,run);this.origin(selected);return{name:selected.name,materialRef:{kind:'source_asset',assetId:row.id,readKind:'content',version:selected.version}};})];}
 listAssets(run:AssetRunScope){return this.rows(run).map(row=>{const selected=this.assertRow(row,run);this.origin(selected);return{assetId:row.id,kind:'file' as const,name:selected.name};});}
 async select(run:AssetRunScope,refs:unknown,targetEmployeeId:string):Promise<SelectedMaterial[]>{
  if(refs===undefined)return[];
  if(!Array.isArray(refs)||refs.length>32||!targetEmployeeId)return fail('invalid_source_material_selection');
  const seen=new Set<string>();const selected=refs.map(ref=>{
   if(!ref||typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).some(k=>!['kind','assetId','readKind','version'].includes(k))||ref.kind!=='source_asset'||typeof ref.assetId!=='string'||!kinds.includes(ref.readKind)||typeof ref.version!=='string'||!/^[a-f0-9]{64}$/.test(ref.version))return fail('invalid_source_material_selection');
   const key=JSON.stringify([ref.assetId,ref.readKind]);if(seen.has(key))return fail('invalid_source_material_selection');seen.add(key);
   if(this.owns(ref.assetId)){const row=this.row(run,ref.assetId),prior=this.assertRow(row,run);if(ref.readKind!=='content'||ref.version!==prior.version)return fail('source_material_read_kind_not_granted');return{sourceRun:run,sourceAssetId:ref.assetId,sourceReadKind:'content' as const,originRun:prior.originRun,originAssetId:prior.originAssetId,originReadKind:prior.originReadKind,version:prior.version,name:prior.name,targetEmployeeId};}
   const original=this.host.inspect(run,ref.assetId,ref.readKind);if(original.version!==ref.version)return fail('source_material_version_changed');return{sourceRun:run,sourceAssetId:ref.assetId,sourceReadKind:ref.readKind as AssetReadKind,originRun:run,originAssetId:ref.assetId,originReadKind:ref.readKind as AssetReadKind,version:ref.version,name:original.name,targetEmployeeId};
  });await this.validate(run,selected,targetEmployeeId);return selected;
 }
 private fingerprint(selected:readonly SelectedMaterial[]){return hash(selected.map(value=>[value,this.origin(value),this.store.all('SELECT request_json,grant_json FROM business_resource_authorizations WHERE asset_id=? AND run_id=? ORDER BY read_kind,resource_key',value.originAssetId,value.originRun.runId)]));}
 async validate(run:AssetRunScope,selected:readonly SelectedMaterial[],targetEmployeeId:string){
  if(selected.length>32||selected.some(value=>!same(value.sourceRun,run)||value.targetEmployeeId!==targetEmployeeId))fail('source_material_selection_changed');
  for(const value of selected)await this.validateOrigin(value);
  for(const[key,receipt]of this.validations)if(receipt.expiresAt<=this.now())this.validations.delete(key);
  this.validations.set(hash([run,selected,targetEmployeeId]),{expiresAt:this.now()+30000,fingerprint:this.fingerprint(selected)});
 }
 private async validateOrigin(value:SelectedMaterial){const original=this.origin(value);await this.host.assertSource(original.source);const response=await this.host.read(value.originRun,value.originAssetId,value.originReadKind);if(!(response instanceof Response))fail('source_material_authorization_required');try{if(!response.ok||response.headers.get('x-asset-version')!==value.version||response.headers.get('x-asset-sha256')!==value.version)fail('source_material_version_changed');}finally{await response.body?.cancel().catch(()=>{});}await this.host.assertSource(original.source);this.origin(value);}
 grant(sourceRun:AssetRunScope,targetRun:AssetRunScope,selected:readonly SelectedMaterial[],proof:{intentId:string;assignmentId:string}){
  if(!selected.length)return;
  this.assertTarget(sourceRun,targetRun,selected,proof);
  const key=hash([sourceRun,selected,targetRun.entityId]),receipt=this.validations.get(key);if(!receipt||receipt.expiresAt<=this.now()||receipt.fingerprint!==this.fingerprint(selected))fail('source_material_validation_required');
  for(const item of selected){const json=JSON.stringify(item),prior=this.store.one<TransferRow>('SELECT * FROM source_material_transfers WHERE intent_id=? AND target_run_id=? AND descriptor_json=?',proof.intentId,targetRun.runId,json);if(prior){this.assertRow(prior,targetRun);continue;}
   this.store.run('INSERT INTO source_material_transfers VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',randomUUID(),targetRun.workspaceId,sourceRun.taskId,sourceRun.runId,item.originRun.taskId,item.originRun.runId,targetRun.taskId,targetRun.runId,targetRun.entityId,proof.intentId,proof.assignmentId,json,this.now());this.host.retain(item.originAssetId,targetRun.taskId);
  }
  this.validations.delete(key);
 }
 async revalidateForRun(run:AssetRunScope){for(const row of this.rows(run)){const selected=this.assertRow(row,run);await this.validateOrigin(selected);}}
 async prepareContinuation(run:AssetRunScope,parentRunId:string){const parent={...run,runId:parentRunId};if(!this.rows(parent).length)return;this.task(run);await this.revalidateForRun(parent);for(const row of this.rows(parent)){this.store.run('INSERT OR IGNORE INTO source_material_transfers VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',row.id,row.workspace_id,row.source_task_id,row.source_run_id,row.origin_task_id,row.origin_run_id,run.taskId,run.runId,run.entityId,row.intent_id,row.assignment_id,row.descriptor_json,this.now());}}
 origins(run:AssetRunScope){return this.rows(run).map(row=>{const selected=this.assertRow(row,run);return{run:selected.originRun,source:this.origin(selected).source};});}
 async resolveForRun(run:AssetRunScope,id:string,kind:AssetReadKind):Promise<AssetResolution>{const response=await this.streamForRun(run,id,kind);if(!(response instanceof Response))return response;try{const version=response.headers.get('x-asset-version'),size=Number(response.headers.get('content-length'));if(!version||!Number.isSafeInteger(size)||size<0)fail('source_material_snapshot_invalid');return{state:'ready',assetId:id,kind:'file',version,sha256:version,size,mediaType:response.headers.get('content-type')??'application/octet-stream'};}finally{await response.body?.cancel().catch(()=>{});}}
 async streamForRun(run:AssetRunScope,id:string,kind:AssetReadKind):Promise<Response|AssetUnavailable>{
  const row=this.row(run,id),selected=this.assertRow(row,run);if(kind!=='content')return{state:'not_available',reason:'source_material_read_kind_not_granted'};
  await this.validateOrigin(selected);const response=await this.host.read(selected.originRun,selected.originAssetId,selected.originReadKind);if(!(response instanceof Response))return response;
  try{this.assertRow(this.row(run,id),run);if(response.headers.get('x-asset-version')!==selected.version)fail('source_material_version_changed');await this.host.assertSource(this.origin(selected).source);}catch(error){await response.body?.cancel().catch(()=>{});throw error;}
  const headers=new Headers(response.headers);headers.set('x-asset-id',id);return new Response(response.body,{status:response.status,headers});
 }
}
