import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import type {TriggerHistoryItem,TriggerHistoryManifest} from '@dentity/application';
import type {Store} from '../store.js';
import {TriggerError} from './protocol.js';
const digest=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
/** Local private storage adapter. First selection is durable before any awaited Host call. */
export class TriggerHistory {
  private readonly root:string;private readonly pending=new Map<string,Promise<void>>();
  constructor(private readonly db:Store,private readonly now:()=>number){this.root=join(dirname(db.databasePath),'trigger-history');mkdirSync(this.root,{recursive:true,mode:0o700});if(lstatSync(this.root).isSymbolicLink())throw Error('Unsafe history root');}
  private path(runId:string){if(!/^[a-zA-Z0-9_-]+$/.test(runId))throw new TriggerError(400,'invalid_history_run');return join(this.root,runId+'.json');}
  read(runId:string):TriggerHistoryManifest|null{const row=this.db.one<{history_manifest_ref:string|null}>('SELECT history_manifest_ref FROM runs WHERE id=?',runId);if(!row?.history_manifest_ref)return null;const path=this.path(runId);if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw Error('Unsafe manifest');const bytes=readFileSync(path);if(row.history_manifest_ref!==digest(bytes))throw Error('Manifest changed');const value=JSON.parse(bytes.toString()) as TriggerHistoryManifest;if(value.runId!==runId)throw Error('Manifest binding changed');return value;}
  async prepare(taskId:string,runId:string,records:(runId:string)=>Promise<TriggerHistoryItem['records']>){const existing=this.pending.get(runId);if(existing)return existing;const work=this.prepareOnce(taskId,runId,records);this.pending.set(runId,work);try{await work;}finally{this.pending.delete(runId);}}
  private async prepareOnce(taskId:string,runId:string,records:(runId:string)=>Promise<TriggerHistoryItem['records']>){
    const task=this.db.one<{origin_kind:string;workspace_id:string;entity_id:string;context_namespace:TriggerHistoryManifest['contextNamespace'];context_key:string;policy_revision:number}>('SELECT * FROM tasks WHERE id=? AND run_id=?',taskId,runId);if(!task||task.origin_kind!=='trigger'||this.read(runId))return;
    const path=this.path(runId),selection=path+'.selection';let manifest:TriggerHistoryManifest;
    if(existsSync(selection)){if(lstatSync(selection).isSymbolicLink())throw Error('Unsafe selection');manifest=JSON.parse(readFileSync(selection,'utf8'));if(manifest.taskId!==taskId||manifest.runId!==runId||manifest.workspaceId!==task.workspace_id||manifest.entityId!==task.entity_id||manifest.contextNamespace!==task.context_namespace||manifest.contextKey!==task.context_key)throw Error('History selection mismatch');}
    else{const cutoffAt=this.now();const rows=this.db.all<{taskId:string;taskStatus:TriggerHistoryItem['taskStatus'];runId:string;attempt:number;runStatus:TriggerHistoryItem['runStatus']}>(`SELECT t.id taskId,t.status taskStatus,r.id runId,r.attempt,r.status runStatus FROM tasks t JOIN runs r ON r.task_id=t.id WHERE t.workspace_id=? AND t.entity_id=? AND t.origin_kind='trigger' AND t.context_namespace=? AND t.context_key=? AND t.id!=? AND t.status IN ('succeeded','failed','canceled') AND t.terminal_at<=? AND r.status IN ('succeeded','failed','canceled') AND r.terminal_at<=? ORDER BY t.terminal_at,t.id,r.attempt,r.id`,task.workspace_id,task.entity_id,task.context_namespace,task.context_key,taskId,cutoffAt,cutoffAt);manifest={version:1,workspaceId:task.workspace_id,entityId:task.entity_id,taskId,runId,policyRevision:task.policy_revision,contextNamespace:task.context_namespace,contextKey:task.context_key,cutoffAt,items:rows.map(row=>({...row,records:[]}))};writeFileSync(selection,JSON.stringify(manifest),{mode:0o600,flag:'wx'});}
    const items:TriggerHistoryItem[]=[];for(const item of manifest.items){let refs:TriggerHistoryItem['records'];try{refs=await records(item.runId);}catch{refs=[{resourceId:'run:'+item.runId,runtimeId:'local-pi',hostId:'unavailable',format:'unknown',availability:'unavailable'}];}items.push({...item,records:refs});}
    const bytes=JSON.stringify({...manifest,items});if(existsSync(path)){if(lstatSync(path).isSymbolicLink()||readFileSync(path,'utf8')!==bytes)throw Error('Immutable manifest conflict');}else writeFileSync(path,bytes,{mode:0o400,flag:'wx'});
    this.db.run('UPDATE runs SET history_manifest_ref=? WHERE id=? AND history_manifest_ref IS NULL',digest(bytes),runId);this.read(runId);
  }
}
