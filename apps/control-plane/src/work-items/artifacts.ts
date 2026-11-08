import {assertWorkItemResourceTransfer,prepareWorkItemResourceTransfer,receivedWorkItemResourceProof,type WorkItemResourceProof} from './resource-lineage.js';
import {createHash, randomUUID} from 'node:crypto';
import {TaskError, type TaskArtifactReadPort, type TaskRow} from '@dentity/application';
import type {ArtifactDescriptor} from '@dentity/contracts';
import type {Store} from '../store.js';
import type {AssetReadKind, AssetRunScope, AssetUnavailable} from '../assets/service.js';

export interface WorkItemArtifact {
  sourceTaskId: string;
  sourceRunId: string;
  sourceEmployeeId: string;
  artifact: ArtifactDescriptor;
}
interface MaterialRow {id:string;workspace_id:string;source_task_id:string;source_run_id:string;source_entity_id:string;artifact_json:string}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Explicit immutable output references, not arbitrary paths or access to predecessor sessions. */
export class WorkItemArtifacts {
  private resourceValidator?:(run:AssetRunScope)=>Promise<void>;
  setResourceValidator(validate:(run:AssetRunScope)=>Promise<void>){this.resourceValidator=validate;}
  private receiver(run:AssetRunScope){const task=this.store.one<TaskRow>('SELECT * FROM tasks WHERE id=? AND workspace_id=? AND entity_id=?',run.taskId,run.workspaceId,run.entityId);if(!task||!this.store.one('SELECT id FROM runs WHERE id=? AND task_id=?',run.runId,run.taskId))throw new TaskError(403,'asset_not_authorized');return task;}

  constructor(private readonly store:Store, private readonly runtime:TaskArtifactReadPort, private readonly now:()=>number) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS work_item_artifact_materials(
      id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,source_task_id TEXT NOT NULL,source_run_id TEXT NOT NULL,
      source_entity_id TEXT NOT NULL,resource_id TEXT NOT NULL,version TEXT NOT NULL,artifact_json TEXT NOT NULL,
      UNIQUE(workspace_id,source_run_id,resource_id,version));`);
  }
  select(task:TaskRow,value:unknown,allowGranted:boolean):WorkItemArtifact[] {
    if(value===undefined)return [];
    if(!Array.isArray(value)||value.length>32)throw new TaskError(400,'invalid_work_item_artifacts');
    const seen=new Set<string>();
    return value.map(ref=>{
      if(!ref||typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).some(k=>!['resourceId','version'].includes(k))||
        typeof ref.resourceId!=='string'||!/^artifact:[a-f0-9]{64}$/.test(ref.resourceId)||typeof ref.version!=='string'||! /^[a-f0-9]{64}$/.test(ref.version)||seen.has(ref.resourceId))throw new TaskError(400,'invalid_work_item_artifacts');
      seen.add(ref.resourceId);
      const artifact=task.run_id?this.runtime.artifacts(task.run_id).find(a=>a.content.resourceId===ref.resourceId&&a.content.version===ref.version&&a.availability==='available'):undefined;
      if(artifact)return {sourceTaskId:task.id,sourceRunId:task.run_id!,sourceEmployeeId:task.entity_id,artifact};
      const row=allowGranted&&task.run_id?this.granted({workspaceId:task.workspace_id,entityId:task.entity_id,taskId:task.id,runId:task.run_id}).find(r=>{
        const a=JSON.parse(r.artifact_json) as ArtifactDescriptor;return a.content.resourceId===ref.resourceId&&a.content.version===ref.version;
      }):undefined;
      if(!row)throw new TaskError(403,'work_item_artifact_not_authorized');
      return this.source(row);
    });
  }
  private source(row:MaterialRow):WorkItemArtifact {return {sourceTaskId:row.source_task_id,sourceRunId:row.source_run_id,sourceEmployeeId:row.source_entity_id,artifact:JSON.parse(row.artifact_json) as ArtifactDescriptor};}
  private assertSource(workspaceId:string,source:WorkItemArtifact,proof?:WorkItemResourceProof) {
    const task=this.store.one<TaskRow>('SELECT * FROM tasks WHERE id=?',source.sourceTaskId);
    // A human continuation may leave an immutable publication on an older Run of the same Task.
    if(!task||task.workspace_id!==workspaceId||task.entity_id!==source.sourceEmployeeId||!this.store.one('SELECT id FROM runs WHERE id=? AND task_id=?',source.sourceRunId,source.sourceTaskId)||
      !this.runtime.artifacts(source.sourceRunId).some(a=>same(a,source.artifact)))throw new TaskError(403,'work_item_artifact_source_changed');
    assertWorkItemResourceTransfer(this.store,task,proof);
  }
  validate(task:TaskRow,selected:readonly WorkItemArtifact[],proof?:WorkItemResourceProof) {
    for(const source of selected){this.assertSource(task.workspace_id,source,proof);if(source.sourceTaskId===task.id&&source.sourceRunId===task.run_id)continue;
      if(!task.run_id||!this.granted({workspaceId:task.workspace_id,entityId:task.entity_id,taskId:task.id,runId:task.run_id}).some(row=>same(this.source(row),source)))throw new TaskError(403,'work_item_artifact_not_authorized');}
  }
  grant(sourceTask:TaskRow,target:TaskRow,selected:readonly WorkItemArtifact[],proof?:WorkItemResourceProof) {
    assertWorkItemResourceTransfer(this.store,sourceTask,proof);this.validate(sourceTask,selected,proof);
    if(target.workspace_id!==sourceTask.workspace_id||!target.run_id)throw new TaskError(403,'work_item_artifact_target_mismatch');
    for(const source of selected){const a=source.artifact,prior=this.store.one<MaterialRow>('SELECT * FROM work_item_artifact_materials WHERE workspace_id=? AND source_run_id=? AND resource_id=? AND version=?',target.workspace_id,source.sourceRunId,a.content.resourceId,a.content.version),id=prior?.id??randomUUID();
      if(prior&&!same(this.source(prior),source))throw new TaskError(409,'work_item_artifact_material_conflict');
      this.store.run('INSERT OR IGNORE INTO work_item_artifact_materials VALUES(?,?,?,?,?,?,?,?)',id,target.workspace_id,source.sourceTaskId,source.sourceRunId,source.sourceEmployeeId,a.content.resourceId,a.content.version,JSON.stringify(a));
      this.store.run('INSERT OR IGNORE INTO message_asset_run_grants VALUES(?,?,?,?,?,?)',id,target.run_id,target.id,target.workspace_id,target.entity_id,this.now());
    }
  }
  private granted(run:AssetRunScope) {return this.store.all<MaterialRow>('SELECT a.* FROM work_item_artifact_materials a JOIN message_asset_run_grants g ON g.asset_id=a.id WHERE g.run_id=? AND g.task_id=? AND g.workspace_id=? AND g.entity_id=? AND a.workspace_id=g.workspace_id',run.runId,run.taskId,run.workspaceId,run.entityId);}
  listForRun(run:AssetRunScope) {const rows=this.granted(run);if(!rows.length)return [];const proof=receivedWorkItemResourceProof(this.store,this.receiver(run));return rows.map(row=>{const source=this.source(row);this.assertSource(run.workspaceId,source,proof);return {assetId:row.id,kind:source.artifact.kind,name:source.artifact.name,content:source.artifact.content};});}
  owns(id:string) {return !!this.store.one('SELECT id FROM work_item_artifact_materials WHERE id=?',id);}
  async streamForRun(run:AssetRunScope,id:string,kind:AssetReadKind):Promise<Response|AssetUnavailable> {
    const row=this.granted(run).find(r=>r.id===id);if(!row)throw new TaskError(403,'asset_not_authorized');
    if(kind!=='content')return {state:'not_available',reason:'artifact_read_kind_unavailable'};
    const proof=await prepareWorkItemResourceTransfer(this.store,this.receiver(run),this.resourceValidator),source=this.source(row);this.assertSource(run.workspaceId,source,proof);
    const result=await this.runtime.artifactContent(source.sourceRunId,source.artifact.content.resourceId),a=source.artifact;
    if(result.bytes.byteLength!==a.size||createHash('sha256').update(result.bytes).digest('hex')!==a.content.version||result.kind!==a.kind||result.name!==a.name||result.mediaType!==a.mediaType)throw new TaskError(409,'work_item_artifact_integrity_mismatch');
    // Recheck the receiver grant after the asynchronous source read.
    await prepareWorkItemResourceTransfer(this.store,this.receiver(run),this.resourceValidator);this.assertSource(run.workspaceId,source,proof);
    if(!this.granted(run).some(r=>r.id===id))throw new TaskError(403,'asset_not_authorized');
    return new Response(new Uint8Array(result.bytes),{headers:{'content-type':a.mediaType,'content-length':String(a.size),'x-asset-id':id,'x-asset-version':a.content.version,'x-asset-sha256':a.content.version}});
  }
}
