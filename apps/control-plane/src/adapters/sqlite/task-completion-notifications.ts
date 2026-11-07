import{unmanagedTaskSql}from'../../work-items/managed-task-sql.js';
import type{BusinessNoticeInput}from'../../notifications/business-results.js';
import{notificationText}from'../../notifications/trigger-results.js';
import {createHash} from 'node:crypto';
import {scopeFromJson,type TaskRow,type TaskCompletionNotification,type TaskCompletionNotificationRepository,type ConversationRepository,type MessageLoopRepository} from '@dentity/application';
import {nullDiagnostics,type DiagnosticPort} from '@dentity/application';
import type {RuntimeInteractionEvent} from '@dentity/contracts';
import type {Store} from '../../store.js';
// Execution feedback remains a durable Task-process fact. It is not an
// audience-scoped conversation reply: only the unified interaction publication
// may send business feedback to the conversation (including a progress tool
// whose text happens to look like the final result).
const managedDelivery="u.type IN ('progress','partial_result','final_result')";
const eventId=(taskId:string,runId:string,revision:number)=>createHash('sha256').update(JSON.stringify(['task-completed',taskId,runId,revision])).digest('hex');

export class SqliteTaskCompletionNotifications implements TaskCompletionNotificationRepository {
  private sink?: (input:BusinessNoticeInput)=>void;
  setSink(value:(input:BusinessNoticeInput)=>void){this.sink=value;}
  constructor(private readonly store:Store,private readonly conversations:ConversationRepository,private readonly channels:MessageLoopRepository,private readonly diagnostics:DiagnosticPort=nullDiagnostics){
    store.db.exec(`CREATE TABLE IF NOT EXISTS task_completion_notifications(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),run_id TEXT NOT NULL REFERENCES runs(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),scope_json TEXT NOT NULL,result_ref TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,turn_id TEXT,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL,published_at INTEGER,UNIQUE(task_id,run_id)); CREATE INDEX IF NOT EXISTS task_completion_pending ON task_completion_notifications(status,retry_at);`);
    if(!store.all<{name:string}>('PRAGMA table_info(task_completion_notifications)').some(column=>column.name==='event_status'))store.db.exec("ALTER TABLE task_completion_notifications ADD COLUMN event_status TEXT NOT NULL DEFAULT 'succeeded'");
  }
  private managed(taskId:string){if(!this.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='work_item_intents'"))return false;return !!this.store.one('SELECT task_id FROM work_item_task_links WHERE task_id=? UNION ALL SELECT task_id FROM work_item_intents WHERE task_id=? LIMIT 1',taskId,taskId);}
  discover(at:number){this.store.transaction(()=>{
    const rows=this.store.all<TaskRow>(`SELECT t.* FROM tasks t JOIN runs r ON r.id=t.run_id JOIN conversations c ON c.id=t.conversation_id WHERE ((t.status='succeeded' AND r.status='succeeded' AND r.result IS NOT NULL AND r.result_revision=t.input_revision) OR (t.status='failed' AND r.status='failed')) AND c.mode='real' AND (c.expires_at=0 OR c.expires_at>?) AND ${unmanagedTaskSql(this.store,'t.id')} AND NOT EXISTS (SELECT 1 FROM task_completion_notifications n WHERE n.task_id=t.id AND n.run_id=r.id) ORDER BY t.updated_at,t.id LIMIT 100`,at);
    for(const task of rows){if(this.managed(task.id))continue;
      const id=eventId(task.id,task.run_id!,task.input_revision),scope=scopeFromJson(task.source_json,{workspaceId:task.workspace_id,entityId:task.entity_id,userId:task.user_id});
      this.store.run("INSERT OR IGNORE INTO task_completion_notifications(id,task_id,run_id,conversation_id,scope_json,result_ref,event_status,created_at) VALUES(?,?,?,?,?,'',?,?)",id,task.id,task.run_id,task.conversation_id,JSON.stringify(scope),task.status,at);
    }
  });}

  discoverUnified(at:number){if(!this.sink)return;for(const row of this.store.all<{id:string;task_id:string;run_id:string;conversation_id:string;scope_json:string;input:string;status:string;result:string|null}> (`SELECT n.id,n.task_id,n.run_id,n.conversation_id,n.scope_json,t.input,t.status,r.result FROM task_completion_notifications n JOIN tasks t ON t.id=n.task_id JOIN runs r ON r.id=n.run_id WHERE n.status='pending' AND n.turn_id IS NULL AND ${unmanagedTaskSql(this.store,'t.id')} ${this.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='business_notification_jobs'")?"AND NOT EXISTS(SELECT 1 FROM business_notification_jobs b WHERE b.source_kind='task' AND b.source_id=n.id)":''} ORDER BY n.created_at,n.id LIMIT 100`)){if(this.managed(row.task_id))continue;const s=scopeFromJson(row.scope_json),target=s.source?{conversation:{provider:s.source.channelType,connectionId:s.source.connectionId,tenantId:s.source.tenantId,kind:'conversation',externalId:s.source.conversationId,conversationKind:s.source.conversationKind,...(s.source.conversationKind==='private'&&!s.source.threadId?{privateRecipientId:s.principal.externalUserId,privateRecipientNamespace:s.principal.identityNamespace}:{})},...((s.source.conversationKind==='group'||s.source.threadId)&&s.source.replyToMessageId?{replyToMessageId:s.source.replyToMessageId}:{}),...(s.source.threadId?{threadId:s.source.threadId}:{})}:{conversationId:row.conversation_id};this.store.transaction(()=>{this.sink!({id:'task-notification:'+row.id,sourceKind:'task',sourceId:row.id,taskId:row.task_id,runId:row.run_id,scopeJson:row.scope_json,targetJson:JSON.stringify(target),conversationId:row.conversation_id,facts:{id:row.task_id,input:notificationText(row.input,2000),status:row.status,executionStatus:row.status,result:row.result===null?null:notificationText(row.result,64000),updates:this.store.all<{payload_json:string}>("SELECT payload_json FROM task_updates WHERE task_id=? AND type IN('progress','partial_result','final_result','status','input_receipt') ORDER BY id DESC LIMIT 20",row.task_id).reverse().map(r=>{const e=JSON.parse(r.payload_json);return{type:e.type,...(e.status?{status:e.status}:{}),...(typeof e.text==='string'?{text:notificationText(e.text,2000)}:{})};})}});});}void at;}
  claim(at:number,until:number,token:string){this.discoverUnified(at);return this.store.transaction(()=>{
    this.store.run("UPDATE task_completion_notifications SET status='pending',lease_token=NULL WHERE status='leased' AND lease_until<=?",at);
    const row=this.store.one<TaskCompletionNotification>(`SELECT id,task_id AS taskId,run_id AS runId,conversation_id AS conversationId,scope_json AS scopeJson,attempts,turn_id AS turnId,status FROM task_completion_notifications WHERE status='pending' ${this.sink?"AND id NOT IN(SELECT source_id FROM business_notification_jobs WHERE source_kind='task')":''} AND retry_at<=? ORDER BY created_at,rowid LIMIT 1`,at);
    if(!row)return;if(this.managed(row.taskId)){this.store.run("UPDATE task_completion_notifications SET status='suppressed',error='work_item_managed' WHERE id=?",row.id);return;}this.store.run("UPDATE task_completion_notifications SET status='leased',lease_token=?,lease_until=? WHERE id=?",token,until,row.id);return row;
  });}
  owns(id:string,token:string){return !!this.store.one("SELECT id FROM task_completion_notifications WHERE id=? AND status='leased' AND lease_token=?",id,token);}
  begin(id:string,token:string,turnId:string){this.store.run("UPDATE task_completion_notifications SET turn_id=?,attempts=attempts+1 WHERE id=? AND status='leased' AND lease_token=?",turnId,id,token);}
  defer(id:string,token:string,retryAt:number,error:string,resetTurn=false){this.store.run(`UPDATE task_completion_notifications SET status='pending',lease_token=NULL,retry_at=?,error=?${resetTurn?',turn_id=NULL':''} WHERE id=? AND status='leased' AND lease_token=?`,retryAt,error,id,token);}
  event(row:TaskCompletionNotification):RuntimeInteractionEvent {
    const value=this.store.one<{event_status:'succeeded'|'failed'}>('SELECT event_status FROM task_completion_notifications WHERE id=?',row.id)!;
    return{schemaVersion:1,source:'platform',type:'task_terminal',eventId:row.id,taskId:row.taskId,runId:row.runId,status:value.event_status,conversationId:row.conversationId};
  }
  publish(row:TaskCompletionNotification,token:string,text:string,at:number,assertAllowed:()=>void){const correlation={traceId:row.id,messageId:`task-notification:${row.id}`,taskId:row.taskId,conversationId:row.conversationId};const published=this.store.transaction(()=>{
    if(!this.owns(row.id,token))return;if(this.managed(row.taskId)){this.store.run("UPDATE task_completion_notifications SET status='suppressed',lease_token=NULL,error='work_item_managed' WHERE id=?",row.id);return;}assertAllowed();
    const conv=this.conversations.get(row.conversationId)!;
    this.conversations.addMessage(`task-notification:${row.id}`,conv,'assistant',text,at,false,true);
    const scope=scopeFromJson(row.scopeJson);
    if(scope.source){
      const source=scope.source,target={conversation:{provider:source.channelType,connectionId:source.connectionId,tenantId:source.tenantId,kind:'conversation',externalId:source.conversationId,conversationKind:source.conversationKind,...(source.conversationKind==='private'?{privateRecipientId:scope.principal.externalUserId}:{})},...((source.conversationKind==='group'||source.threadId)&&source.replyToMessageId?{replyToMessageId:source.replyToMessageId}:{}),...(source.threadId?{threadId:source.threadId}:{})};
      this.channels.enqueueDelivery({id:correlation.messageId,scopeJson:row.scopeJson,targetJson:JSON.stringify(target),text,status:'queued',taskDeliveryId:null,leaseToken:null,correlation},at);
    }
    this.store.run("UPDATE task_completion_notifications SET status='succeeded',published_at=?,lease_token=NULL,error=NULL WHERE id=? AND lease_token=?",at,row.id,token);
    return scope.source?'channel':'web';
  });if(published)this.diagnostics.run(correlation,()=>{this.diagnostics.event({stage:'reply.persist',phase:'point',outcome:'success'});if(published==='channel')this.diagnostics.event({stage:'outbox.queued',phase:'point',outcome:'queued'});});}
  messageTask(id:string){if(!id.startsWith('task-notification:'))return;return this.store.one<{task_id:string}>('SELECT task_id FROM task_completion_notifications WHERE id=?',id.slice('task-notification:'.length))?.task_id;}
  pendingChannelDeliveries(){return this.store.all<ReturnType<MessageLoopRepository['taskDeliveries']>[number]>(`SELECT d.id,d.task_id AS taskId,d.text,t.source_json AS sourceJson,t.workspace_id AS workspaceId,t.entity_id AS entityId,t.user_id AS userId,t.conversation_id AS conversationId FROM deliveries d JOIN tasks t ON t.id=d.task_id WHERE d.status='stored' AND t.user_id IS NULL AND NOT EXISTS (SELECT 1 FROM task_updates u WHERE u.task_id=d.task_id AND u.event_id=d.event_id AND ${managedDelivery}) ORDER BY d.rowid LIMIT 100`);}
  suppressDelivery(id:string){if(!id.startsWith('task-delivery:'))return false;return !!this.store.one(`SELECT d.id FROM deliveries d JOIN task_updates u ON u.task_id=d.task_id AND u.event_id=d.event_id JOIN tasks t ON t.id=d.task_id WHERE d.id=? AND ${managedDelivery}`,id.slice('task-delivery:'.length));}
}
