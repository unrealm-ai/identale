import{createHash}from'node:crypto';
import{TaskError,type TaskRow,type TaskArtifactReadPort,type TaskService,type MessageLoopRepository,type ChannelDeliveryRow}from'@dentity/application';
import type{Store}from'./store.js';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
/** Selection is output metadata; external dispatch happens only through the durable channel outbox. */
export class TaskArtifacts{
 constructor(private readonly store:Store,private readonly tasks:TaskService,private readonly runtime:TaskArtifactReadPort){
  store.db.exec('CREATE TABLE IF NOT EXISTS task_artifact_delivery_grants(delivery_id TEXT PRIMARY KEY,scope_hash TEXT NOT NULL,target_hash TEXT NOT NULL,parent_json TEXT NOT NULL);');
  store.db.exec('CREATE TABLE IF NOT EXISTS task_artifact_selection_inputs(operation_id TEXT NOT NULL,turn_id TEXT NOT NULL,PRIMARY KEY(operation_id,turn_id))');
  store.db.exec('CREATE TABLE IF NOT EXISTS task_artifact_selections(operation_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,turn_id TEXT NOT NULL,task_id TEXT NOT NULL,run_id TEXT NOT NULL,ids_json TEXT NOT NULL)');
 }
 list(taskId:string){const task=this.store.one<TaskRow>('SELECT * FROM tasks WHERE id=?',taskId);if(!task)throw new TaskError(404,'task_not_found');return task.run_id?this.runtime.artifacts(task.run_id):[];}
 select(conversationId:string,turnId:string,taskId:string,ids:readonly string[],operationId:string,coveredTurnIds:readonly string[]=[]){
  const task=this.store.one<TaskRow>('SELECT * FROM tasks WHERE id=?',taskId);if(!task)throw new TaskError(404,'task_not_found');if(task.status!=='succeeded')throw new TaskError(409,'artifact_task_not_completed');const available=this.list(taskId),selected=[...new Set(ids)];if(!task.run_id||selected.some(id=>!available.some(a=>a.content.resourceId===id)))throw new TaskError(403,'artifact_not_authorized');
  const values=[conversationId,turnId,taskId,task.run_id,JSON.stringify(selected)]as const;
  this.store.transaction(()=>{const prior=this.store.one<{conversation_id:string;turn_id:string;task_id:string;run_id:string;ids_json:string}>('SELECT * FROM task_artifact_selections WHERE operation_id=?',operationId);if(prior){if(JSON.stringify([prior.conversation_id,prior.turn_id,prior.task_id,prior.run_id,prior.ids_json])!==JSON.stringify(values))throw new TaskError(409,'artifact_selection_conflict');return;}this.store.run('INSERT INTO task_artifact_selections VALUES(?,?,?,?,?,?)',operationId,...values);for(const id of new Set([turnId,...coveredTurnIds]))this.store.run('INSERT OR IGNORE INTO task_artifact_selection_inputs VALUES(?,?)',operationId,id);});
  return{status:'selected',taskId,artifacts:available.filter(a=>selected.includes(a.content.resourceId)),delivery:'not_sent'};
 }
 reconcile(operationId:string){const row=this.store.one<{task_id:string;ids_json:string}>('SELECT task_id,ids_json FROM task_artifact_selections WHERE operation_id=?',operationId);if(!row)return{status:'unknown' as const};const ids=JSON.parse(row.ids_json)as string[];return{status:'completed' as const,result:{status:'selected',taskId:row.task_id,artifacts:this.list(row.task_id).filter(a=>ids.includes(a.content.resourceId)),delivery:'not_sent'}};}
 deliveryViews(taskId:string){return this.store.all<{id:string;status:string;error:string|null;created_at:number}>("SELECT d.id,d.status,d.error,d.created_at FROM channel_deliveries d JOIN task_artifact_delivery_grants g ON g.delivery_id=d.id WHERE json_extract(d.target_json,'$.artifact.taskId')=? ORDER BY d.created_at,d.id",taskId).map(r=>({id:r.id,status:r.status,error:r.error,createdAt:r.created_at}));}
 selected(conversationId:string,turnId:string){return this.store.all<{selection_turn_id:string;task_id:string;run_id:string;ids_json:string}>('SELECT turn_id selection_turn_id,task_id,run_id,ids_json FROM task_artifact_selections s WHERE conversation_id=? AND (turn_id=? OR EXISTS(SELECT 1 FROM task_artifact_selection_inputs i WHERE i.operation_id=s.operation_id AND i.turn_id=?)) ORDER BY operation_id',conversationId,turnId,turnId).flatMap(row=>{const ids=JSON.parse(row.ids_json)as string[];return this.runtime.artifacts(row.run_id).filter(a=>ids.includes(a.content.resourceId)).map(artifact=>({selectionTurnId:row.selection_turn_id,taskId:row.task_id,runId:row.run_id,artifact}));});}
 enqueue(outbox:MessageLoopRepository,base:ChannelDeliveryRow,conversationId:string,turnId:string,at:number){
  const target=JSON.parse(base.targetJson);if(target.conversation?.provider!=='feishu')return;
  for(const selected of this.selected(conversationId,turnId)){const id='artifact-delivery:'+digest(canonical([conversationId,selected.selectionTurnId,selected.taskId,selected.runId,selected.artifact.content,target.conversation,target.threadId??null])),targetJson=JSON.stringify({...target,artifact:{taskId:selected.taskId,runId:selected.runId,ref:selected.artifact.content}});this.store.transaction(()=>{this.store.run('INSERT OR IGNORE INTO task_artifact_delivery_grants VALUES(?,?,?,?)',id,digest(base.scopeJson),digest(targetJson),JSON.stringify(base));outbox.enqueueDelivery({...base,id,text:'',taskDeliveryId:null,targetJson},at);});}

 }
 parentDelivery(row:ChannelDeliveryRow):ChannelDeliveryRow|undefined{const target=JSON.parse(row.targetJson);if(!target.artifact)return;const grant=this.store.one<{scope_hash:string;target_hash:string;parent_json:string}>('SELECT * FROM task_artifact_delivery_grants WHERE delivery_id=?',row.id);if(!grant||grant.scope_hash!==digest(row.scopeJson)||grant.target_hash!==digest(row.targetJson))throw new TaskError(403,'artifact_delivery_not_granted');return JSON.parse(grant.parent_json)as ChannelDeliveryRow;}
 async readDelivery(row:ChannelDeliveryRow){
  const grant=this.store.one<{scope_hash:string;target_hash:string}>('SELECT * FROM task_artifact_delivery_grants WHERE delivery_id=?',row.id);if(!grant||grant.scope_hash!==digest(row.scopeJson)||grant.target_hash!==digest(row.targetJson))throw new TaskError(403,'artifact_delivery_not_granted');
  const target:unknown=JSON.parse(row.targetJson);if(!target||typeof target!=='object'||!('artifact'in target))throw new TaskError(403,'artifact_delivery_invalid');const value=target.artifact as {taskId?:unknown;runId?:unknown;ref?:{resourceId?:unknown;version?:unknown}};
  if(typeof value.taskId!=='string'||typeof value.runId!=='string'||typeof value.ref?.resourceId!=='string'||typeof value.ref.version!=='string')throw new TaskError(403,'artifact_delivery_invalid');
  const original=this.store.one<TaskRow>('SELECT * FROM tasks WHERE id=?',value.taskId);if(!original)throw new TaskError(404,'task_not_found');
  const task=await this.tasks.refreshTaskContext(this.tasks.contextOfTask(original),value.taskId);if(task.run_id!==value.runId||!this.runtime.artifacts(value.runId).some(a=>a.content.resourceId===value.ref!.resourceId&&a.content.version===value.ref!.version))throw new TaskError(403,'artifact_delivery_changed');
  return this.runtime.artifactContent(value.runId,value.ref.resourceId);
 }
}
