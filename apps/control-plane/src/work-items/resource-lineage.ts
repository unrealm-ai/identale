import {createHash} from 'node:crypto';
import {TaskError} from '@dentity/application';
import type {Store} from '../store.js';
import type {AssetRunScope} from '../assets/service.js';

type TaskScope={id:string;workspace_id:string;entity_id:string};
/** Host-only evidence for one synchronous operation after online source checks. */
export interface WorkItemResourceProof {root:TaskScope;fingerprint:string;taskIds:string[];runs:AssetRunScope[]}
const table=(store:Store,name:string)=>!!store.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?",name);
export function workItemResourceLineage(store:Store,task:TaskScope):WorkItemResourceProof {
 const pending=[task.id],seen=new Set<string>(),records:unknown[]=[],runs:AssetRunScope[]=[];
 while(pending.length){const id=pending.pop()!;if(seen.has(id))continue;seen.add(id);if(seen.size>1000)throw new TaskError(403,'business_resource_lineage_limit');
  const own=store.one<TaskScope>('SELECT id,workspace_id,entity_id FROM tasks WHERE id=?',id);if(!own||own.workspace_id!==task.workspace_id)throw new TaskError(403,'business_resource_lineage_invalid');
  if(table(store,'business_resource_authorizations'))for(const row of store.all<{run_id:string;asset_id:string;read_kind:string;resource_key:string;request_json:string;grant_json:string}>(`SELECT a.* FROM business_resource_authorizations a JOIN runs r ON r.id=a.run_id WHERE r.task_id=? ORDER BY a.run_id,a.asset_id,a.read_kind,a.resource_key`,id)){
   const binding=store.one('SELECT asset_id,run_id,task_id,workspace_id,entity_id FROM message_asset_run_grants WHERE asset_id=? AND run_id=?',row.asset_id,row.run_id);let grant:Record<string,unknown>;try{grant=JSON.parse(row.grant_json);delete grant.expiresAt;}catch{throw new TaskError(403,'business_resource_lineage_invalid');}records.push([id,{...row,grant_json:JSON.stringify(grant,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value)},binding??null]);if(!runs.some(r=>r.runId===row.run_id))runs.push({workspaceId:own.workspace_id,entityId:own.entity_id,taskId:id,runId:row.run_id});
  }
  if(table(store,'work_item_artifact_materials'))for(const row of store.all<{source_task_id:string}>(`SELECT DISTINCT a.source_task_id FROM work_item_artifact_materials a JOIN message_asset_run_grants g ON g.asset_id=a.id WHERE g.task_id=? AND g.workspace_id=? AND a.workspace_id=g.workspace_id`,id,task.workspace_id))pending.push(row.source_task_id);
  if(table(store,'work_item_dispatches'))for(const row of store.all<{source_task_id:string}>('SELECT source_task_id FROM work_item_dispatches WHERE task_id=?',id))pending.push(row.source_task_id);
 }
 records.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 return{root:task,fingerprint:createHash('sha256').update(JSON.stringify(records)).digest('hex'),taskIds:[...seen].sort(),runs};
}
export function assertWorkItemResourceTransfer(store:Store,task:TaskScope,proof?:WorkItemResourceProof):void {
 const lineage=workItemResourceLineage(store,task);if(!lineage.runs.length)return;
 if(!proof||proof.root.workspace_id!==task.workspace_id||!proof.taskIds.includes(task.id)||workItemResourceLineage(store,proof.root).fingerprint!==proof.fingerprint)throw new TaskError(403,'business_resource_transfer_authorization_required');
}
export async function prepareWorkItemResourceTransfer(store:Store,task:TaskScope,validate?: (run:AssetRunScope)=>Promise<void>):Promise<WorkItemResourceProof>{
 const before=receivedWorkItemResourceProof(store,task);if(before.runs.length&&!validate)throw new TaskError(403,'business_resource_transfer_authorization_required');
 for(const run of before.runs)await validate!(run);
 if(workItemResourceLineage(store,task).fingerprint!==before.fingerprint)throw new TaskError(409,'business_resource_lineage_changed');
 return before;
}

/** Persisted selection proves only the receiving task's chosen package, never live source ACL. */
export function receivedWorkItemResourceProof(store:Store,task:TaskScope):WorkItemResourceProof {
 const proof=workItemResourceLineage(store,task);
 for(const id of proof.taskIds){
  if(!table(store,'work_item_dispatches'))continue;
  for(const edge of store.all<{id:string;source_task_id:string;source_run_id:string;assignment_id:string;state:string}>('SELECT id,source_task_id,source_run_id,assignment_id,state FROM work_item_dispatches WHERE task_id=?',id)){
   const source=store.one<TaskScope>('SELECT id,workspace_id,entity_id FROM tasks WHERE id=?',edge.source_task_id);if(!source)throw new TaskError(403,'business_resource_lineage_invalid');
   const lineage=workItemResourceLineage(store,source);if(!lineage.runs.length)continue;
   const grant=table(store,'work_item_resource_transfers')?store.one<{fingerprint:string;package_digest:string;source_run_id:string}>('SELECT * FROM work_item_resource_transfers WHERE target_task_id=? AND source_task_id=? AND intent_id=? AND assignment_id=?',id,source.id,edge.id,edge.assignment_id):undefined;
   const intent=store.one<{state:string;task_id:string;run_id:string;prepared_json:string;checkpoint_ref:string|null}>('SELECT * FROM work_item_intents WHERE id=?',edge.id),assignment=store.one<{employee_id:string;summary:string;grant_id:string}>('SELECT * FROM work_item_assignments WHERE id=?',edge.assignment_id),receiver=store.one<{entity_id:string;source_json:string}>('SELECT entity_id,source_json FROM tasks WHERE id=?',id);
   let bound:Record<string,unknown>={};try{bound=JSON.parse(receiver?.source_json??'{}').assignment??{};}catch{}
   if(!grant||grant.fingerprint!==lineage.fingerprint||!intent||intent.state!=='committed'||!intent.checkpoint_ref||intent.task_id!==source.id||intent.run_id!==grant.source_run_id||edge.source_run_id!==grant.source_run_id||edge.state!=='done'||createHash('sha256').update(intent.prepared_json).digest('hex')!==grant.package_digest||!assignment||assignment.employee_id!==receiver?.entity_id||bound.assignmentId!==edge.assignment_id||bound.grantId!==assignment.grant_id||bound.sourceEmployeeId!==source.entity_id||bound.targetEmployeeId!==receiver.entity_id)throw new TaskError(403,'business_resource_transfer_authorization_required');
   const prepared=JSON.parse(intent.prepared_json);if(prepared.resourceFingerprint!==grant.fingerprint||prepared.summary!==assignment.summary)throw new TaskError(403,'business_resource_transfer_authorization_required');
  }
 }
 return proof;
}
