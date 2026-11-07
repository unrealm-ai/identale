import{unmanagedTaskSql}from'../work-items/managed-task-sql.js';
import type{BusinessNoticeInput}from'./business-results.js';
import {createHash} from 'node:crypto';
import {ChannelError,triggerResultScope,type ChannelDeliveryRow,type MessageLoopRepository,type TriggerResultScope} from '@dentity/application';
import type {Store} from '../store.js';
import {NotificationTargetCodec,targetKey,type SelectedNotificationTarget} from './targets.js';
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
/** Only the public final reply, never execution events, reasoning, raw JSONL or artifacts. */
export const notificationText=(x:string,max:number)=>Array.from(x.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi,'').replace(/(?:Bearer\s+|(?:api[_-]?key|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi,'[已隐藏]').replace(/(?:file:\/\/\S+|(?:\/(?:Users|home|private|tmp|var)\/|[A-Z]:\\)[^\s<>"']+)/g,'[文件引用]').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim()).slice(0,max).join('');
export function resultNotice(title:string,status:string,result:string|null){

 return `${notificationText(title,120)||'自动化任务'}\n${status==='succeeded'?'已完成':status==='canceled'?'已取消':'执行失败'}${status==='succeeded'&&result?'\n'+notificationText(result,1000):status==='failed'?'\n请在平台任务记录中查看失败原因。':''}`;
}
export class TriggerResultNotifications {
 private sink?:(input:BusinessNoticeInput)=>void;
 setSink(value:(input:BusinessNoticeInput)=>void){this.sink=value;}
 constructor(private readonly store:Store,private readonly outbox:MessageLoopRepository,private readonly codec:NotificationTargetCodec,private readonly assertActive:(w:string,e:string)=>void,private readonly managed?:(taskId:string)=>boolean){
  store.db.exec(`CREATE TABLE IF NOT EXISTS trigger_result_notifications(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),run_id TEXT NOT NULL REFERENCES runs(id),target_key TEXT NOT NULL,target_json TEXT NOT NULL,label TEXT NOT NULL,scope_json TEXT NOT NULL,text TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,delivery_status TEXT NOT NULL DEFAULT 'pending',delivery_error TEXT,provider_accepted INTEGER NOT NULL DEFAULT 0,UNIQUE(task_id,run_id,target_key));
  CREATE INDEX IF NOT EXISTS trigger_results_task ON trigger_result_notifications(task_id,run_id);`);
  const columns=new Set(store.all<{name:string}>('PRAGMA table_info(trigger_result_notifications)').map(c=>c.name));let upgraded=false;
  for(const [name,type]of Object.entries({delivery_status:"TEXT NOT NULL DEFAULT 'pending'",delivery_error:'TEXT',provider_accepted:'INTEGER NOT NULL DEFAULT 0'}))if(!columns.has(name)){store.db.exec(`ALTER TABLE trigger_result_notifications ADD COLUMN ${name} ${type}`);upgraded=true;}
  // Business history outlives the technical outbox. Receipt updates copy only the
  // status summary atomically; normal payload/receipt retention stays unchanged.
  store.db.exec(`CREATE TRIGGER IF NOT EXISTS trigger_result_receipt_insert AFTER INSERT ON channel_message_receipts WHEN NEW.kind='outbox' AND NEW.id GLOB 'trigger-result:*' BEGIN UPDATE trigger_result_notifications SET delivery_status=NEW.status,delivery_error=NEW.error,provider_accepted=(NEW.provider_request_id IS NOT NULL) WHERE id=NEW.id;END;
  CREATE TRIGGER IF NOT EXISTS trigger_result_receipt_update AFTER UPDATE ON channel_message_receipts WHEN NEW.kind='outbox' AND NEW.id GLOB 'trigger-result:*' BEGIN UPDATE trigger_result_notifications SET delivery_status=NEW.status,delivery_error=NEW.error,provider_accepted=(NEW.provider_request_id IS NOT NULL) WHERE id=NEW.id;END;`);
  if(upgraded)store.run(`UPDATE trigger_result_notifications SET delivery_status=coalesce((SELECT status FROM channel_message_receipts WHERE kind='outbox' AND id=trigger_result_notifications.id),CASE WHEN error IS NULL THEN 'unknown' ELSE 'failed' END),delivery_error=(SELECT error FROM channel_message_receipts WHERE kind='outbox' AND id=trigger_result_notifications.id),provider_accepted=EXISTS(SELECT 1 FROM channel_message_receipts WHERE kind='outbox' AND id=trigger_result_notifications.id AND provider_request_id IS NOT NULL)`);

 }
 discover(at:number){this.store.transaction(()=>{
  const rows=this.store.all<{id:string;workspace_id:string;entity_id:string;run_id:string;status:string;input:string;result:string|null;targets_json:string}>(`SELECT t.id,t.workspace_id,t.entity_id,t.run_id,t.status,t.input,r.result,n.targets_json FROM trigger_notification_targets n JOIN tasks t ON t.id=n.task_id JOIN runs r ON r.id=t.run_id WHERE t.origin_kind='trigger' AND t.conversation_id IS NULL AND ((t.status='succeeded' AND r.status='succeeded' AND r.result_revision=t.input_revision AND r.result IS NOT NULL) OR (t.status IN('failed','canceled') AND r.status=t.status)) AND ${unmanagedTaskSql(this.store,'t.id')} AND NOT EXISTS(SELECT 1 FROM trigger_result_notifications x WHERE x.task_id=t.id AND x.run_id=t.run_id) ORDER BY t.updated_at,t.id LIMIT 100`);
  for(const row of rows){if(this.managed?.(row.id))continue;
   // Configuration is persisted by the trusted platform. Invalid selectors fail this
   // destination, never the execution or sibling destinations, and never get guessed.
   let values:unknown;try{values=JSON.parse(row.targets_json);}catch{continue;}
   if(!Array.isArray(values))continue;
   for(const raw of values){
    let t:SelectedNotificationTarget|undefined,error:string|undefined;try{t=this.codec.read(row.workspace_id,row.entity_id,raw);}catch{error='notification_target_invalid';}
    const key=t?targetKey(t):hash(raw),id='trigger-result:'+hash([row.id,row.run_id,key]);
    const scope:TriggerResultScope|undefined=t?{kind:'trigger_result_notification',workspaceId:row.workspace_id,entityId:row.entity_id,taskId:row.id,runId:row.run_id,source:{connectionId:t.connectionId,appId:t.appId,bindingVersion:t.bindingVersion,tenantId:t.tenantId,channelType:t.provider,conversationKind:'group',conversationId:t.id}}:undefined;
    const target=t?{conversation:{provider:t.provider,connectionId:t.connectionId,tenantId:t.tenantId,kind:'conversation',conversationKind:'group',externalId:t.id}}:{};
    const text=resultNotice(row.input,row.status,row.result),scopeJson=JSON.stringify(scope??{}),targetJson=JSON.stringify(target);
    this.store.run('INSERT OR IGNORE INTO trigger_result_notifications(id,task_id,run_id,target_key,target_json,label,scope_json,text,error,created_at,delivery_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,row.id,row.run_id,key,targetJson,t?.label??'目标信息无效',scopeJson,text,error??null,at,error?'failed':'pending');
    if(!error&&this.sink)this.sink({id,sourceKind:'trigger',sourceId:id,taskId:row.id,runId:row.run_id,scopeJson,targetJson,facts:{status:row.status,result:text}});
    if(!error&&!this.sink)this.outbox.enqueueDelivery({id,scopeJson,targetJson,text,status:'queued',taskDeliveryId:null,leaseToken:null,correlation:{traceId:id,messageId:id,taskId:row.id}},at);
   }
  }
 });}
 isDelivery(row:ChannelDeliveryRow){return row.id.startsWith('trigger-result:');}
 assert(row:ChannelDeliveryRow){
  const scope=triggerResultScope(row.scopeJson),n=this.store.one<{scope_json:string;target_json:string;text:string;error:string|null}>('SELECT scope_json,target_json,text,error FROM trigger_result_notifications WHERE id=?',row.id);
  if(scope&&this.managed?.(scope.taskId))throw new ChannelError('forbidden','work_item_notification_managed');
  if(!scope||!n||n.error||n.scope_json!==row.scopeJson||n.target_json!==row.targetJson||n.text!==row.text||row.taskDeliveryId!==null)throw new ChannelError('forbidden','notification_scope_invalid');
  const task=this.store.one<{status:string;run_id:string}>('SELECT status,run_id FROM tasks WHERE id=? AND workspace_id=? AND entity_id=? AND origin_kind=\'trigger\' AND conversation_id IS NULL',scope.taskId,scope.workspaceId,scope.entityId);
  if(!task||task.run_id!==scope.runId||!['succeeded','failed','canceled'].includes(task.status))throw new ChannelError('forbidden','notification_task_changed');
  this.assertActive(scope.workspaceId,scope.entityId);
 }
}
