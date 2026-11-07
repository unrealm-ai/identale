// Modified for Identale; see the root NOTICE.
import type {JsonlJournal,JournalRef} from '@dentity/runtime-builtin';
import type { SessionStore, OperationStore, OperationRecord } from '@dentity/runtime-builtin';
import type { Store } from '../../store.js';
export class BuiltinTestContextResetRequiredError extends Error {constructor(){super('builtin_test_context_reset_required: legacy test contexts must be privately backed up and archived with scripts/maintenance/reset-builtin-test-context.mjs while identity is stopped. No conversation or task data was deleted.');this.name='BuiltinTestContextResetRequiredError';}}
/** Durable private runtime namespace and separately retained operation receipts. */
export function createBuiltinStores(store:Store,now:()=>number=Date.now,assertOwner?:()=>void,journal?:JsonlJournal):{sessionStore:SessionStore;operationStore:OperationStore} {
  store.db.exec(`CREATE TABLE IF NOT EXISTS builtin_records(key TEXT PRIMARY KEY,version INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS builtin_operations(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT);`);
  for(const table of ['builtin_records','builtin_operations'])for(const column of ['created_at','closed_at'])if(!store.all<{name:string}>(`PRAGMA table_info(${table})`).some(c=>c.name===column))store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`);
  store.run('UPDATE builtin_records SET created_at=? WHERE created_at IS NULL',now());store.run("UPDATE builtin_records SET closed_at=? WHERE closed_at IS NULL AND json_extract(json,'$.status') IN ('succeeded','failed','canceled','unknown')",now());store.run('UPDATE builtin_operations SET created_at=? WHERE created_at IS NULL',now());store.run("UPDATE builtin_operations SET closed_at=? WHERE closed_at IS NULL AND status='completed'",now());
  store.db.exec('CREATE INDEX IF NOT EXISTS builtin_record_retention ON builtin_records(closed_at);CREATE INDEX IF NOT EXISTS builtin_operation_retention ON builtin_operations(closed_at)');
  if(store.one("SELECT key FROM builtin_records WHERE key LIKE 'builtin:session:%' AND json_extract(json,'$.closed')=0 AND json_extract(json,'$.supersededBy') IS NULL AND json_extract(json,'$.handle.scope.kind')='interaction' AND json_extract(json,'$.handle.sessionId')!=json_extract(json,'$.handle.scope.conversationId') LIMIT 1"))throw new BuiltinTestContextResetRequiredError();
  return {
    sessionStore:{
      async compareAndSetMany(changes){assertOwner?.();return compareBuiltinRecords(store,changes,now,assertOwner,journal);},
      async get(key){return store.transaction(()=>{const row=store.one<{version:number;json:string}>('SELECT version,json FROM builtin_records WHERE key=?',key);if(!row)return;const value=JSON.parse(row.json);publishJournal(journal,key,value,row.version);return{version:row.version,value};});},
      async compareAndSet(key,expectedVersion,value){assertOwner?.();return compareBuiltinRecords(store,[{key,expectedVersion,value}],now,assertOwner,journal);},
    },
    operationStore:{
      async get(id){const row=store.one<{operation_id:string;fingerprint:string;status:'pending'|'completed';result_json:string|null}>('SELECT * FROM builtin_operations WHERE operation_id=?',id);return row?{operationId:row.operation_id,fingerprint:row.fingerprint,status:row.status,...(row.result_json!==null?{result:JSON.parse(row.result_json)}:{})}:undefined;},
      async claim(record:OperationRecord){assertOwner?.();return!!store.run("INSERT OR IGNORE INTO builtin_operations(operation_id,fingerprint,status,result_json,created_at) VALUES(?,?,'pending',NULL,?)",record.operationId,record.fingerprint,now()).changes;},
      async complete(id,result){assertOwner?.();store.run("UPDATE builtin_operations SET status='completed',result_json=?,closed_at=COALESCE(closed_at,?) WHERE operation_id=?",JSON.stringify(result)??'null',now(),id);},
    },
  };
}

export function purgeBuiltinRecords(store:Store,conversationIds:readonly string[]){for(const id of conversationIds)store.run("DELETE FROM builtin_records WHERE json_extract(json,'$.handle.scope.conversationId')=? OR json_extract(json,'$.request.authorizationContext.conversation.conversationId')=? OR json_extract(json,'$.request.authorization.conversationId')=?",id,id,id);}

function publishJournal(journal:JsonlJournal|undefined,key:string,value:unknown,version:number){
 if(!journal||!key.startsWith('builtin:session:')||!value||typeof value!=='object')return;
 const s=value as {handle?:{runtime:{workspaceId:string;entityId:string};scope:{kind:string;conversationId?:string}};messageRefs?:JournalRef[]};
 if(s.handle?.scope.kind!=='interaction'||!s.handle.scope.conversationId||!Array.isArray(s.messageRefs))return;
 journal.publishContext({workspaceId:s.handle.runtime.workspaceId,entityId:s.handle.runtime.entityId,conversationId:s.handle.scope.conversationId},s.messageRefs,String(version));
}
/** Synchronous CAS primitive permits lease/ACL fencing in the SAME SQLite transaction. */
export function compareBuiltinRecords(store:Store,changes:readonly {key:string;expectedVersion:number|null;value:unknown}[],now:()=>number=Date.now,assertOwner?:()=>void,journal?:JsonlJournal):boolean{return store.transaction(()=>{
  assertOwner?.();
  if(new Set(changes.map(change=>change.key)).size!==changes.length)throw new Error('Duplicate CAS key');
  if(changes.some(change=>(store.one<{version:number}>('SELECT version FROM builtin_records WHERE key=?',change.key)?.version??null)!==change.expectedVersion))return false;
  for(const change of changes){const json=JSON.stringify(change.value),terminal=change.value&&typeof change.value==='object'&&'status'in change.value&&['succeeded','failed','canceled','unknown'].includes(String(change.value.status)),closed=terminal?now():null;if(change.expectedVersion===null)store.run('INSERT INTO builtin_records(key,version,json,created_at,closed_at) VALUES(?,1,?,?,?)',change.key,json,now(),closed);else store.run('UPDATE builtin_records SET version=version+1,json=?,closed_at=COALESCE(closed_at,?) WHERE key=?',json,closed,change.key);}
  for(const change of changes)publishJournal(journal,change.key,change.value,(change.expectedVersion??0)+1);
  return true;
});}

const retentionCursors=new WeakMap<Store,{recordAt:number;recordKey:string;operationAt:number;operationKey:string}>();
/** Technical metadata only. Minimum dedup is 30 days; journals/task results remain independent. */
export function cleanupBuiltinTechnical(store:Store,at:number,limit=100):{deleted:number;more:boolean}{
 const has=(name:string)=>!!store.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",name);if(!has('builtin_records')||!store.all<{name:string}>('PRAGMA table_info(builtin_records)').some(c=>c.name==='closed_at'))return{deleted:0,more:false};const day=86400000;let deleted=0;
 const cursor=retentionCursors.get(store)??{recordAt:-1,recordKey:'',operationAt:-1,operationKey:''};retentionCursors.set(store,cursor);
 const candidates=store.all<{key:string;json:string;closed_at:number}>("SELECT key,json,closed_at FROM builtin_records WHERE key LIKE 'builtin:execution:%' AND closed_at<? AND (closed_at>? OR (closed_at=? AND key>?)) ORDER BY closed_at,key LIMIT ?",at-30*day,cursor.recordAt,cursor.recordAt,cursor.recordKey,limit);
 if(candidates.length){cursor.recordAt=candidates.at(-1)!.closed_at;cursor.recordKey=candidates.at(-1)!.key;}else{cursor.recordAt=-1;cursor.recordKey='';}
 let operations:{operation_id:string;closed_at:number}[]=[];store.transaction(()=>{for(const row of candidates){const state=JSON.parse(row.json),status=state.status;if(!['succeeded','failed','canceled','unknown'].includes(status)||row.closed_at>at-30*day)continue;const id=state.request?.payload?.execution?.executionId;if(!id)continue;
  if(store.one("SELECT 1 FROM builtin_records WHERE key LIKE 'builtin:session:%' AND (json_extract(json,'$.activeExecution')=? OR EXISTS(SELECT 1 FROM json_each(builtin_records.json,'$.pendingExecutionKeys') WHERE value=?))",id,row.key))continue;
  const receipt=has('channel_inbox')?store.one<{rt_terminal:number;event_cursor:string;status:string}>('SELECT rt_terminal,event_cursor,status FROM channel_inbox WHERE turn_id=?',id):undefined;
  if(receipt&&(!receipt.rt_terminal||Number(receipt.event_cursor)<(state.deliveryRefs?.length??0)))continue;
  if(!receipt&&status==='succeeded')continue; // Web events may still be queried; keep without a durable consumed proof.
  store.run('DELETE FROM builtin_records WHERE key=?',row.key);deleted++;
  if(has('interaction_turns'))store.run("DELETE FROM interaction_turns WHERE id=? AND status IN ('succeeded','failed','canceled','unknown')",id);
 }
 if(has('builtin_operations'))operations=store.all<{operation_id:string;closed_at:number}>("SELECT operation_id,closed_at FROM builtin_operations WHERE status='completed' AND closed_at<? AND (closed_at>? OR (closed_at=? AND operation_id>?)) ORDER BY closed_at,operation_id LIMIT ?",at-30*day,cursor.operationAt,cursor.operationAt,cursor.operationKey,limit);if(operations.length){cursor.operationAt=operations.at(-1)!.closed_at;cursor.operationKey=operations.at(-1)!.operation_id;}else{cursor.operationAt=-1;cursor.operationKey='';}
 for(const row of operations){
  if(has('tasks')&&store.one('SELECT 1 FROM tasks WHERE operation_id=? AND status NOT IN (\'succeeded\',\'failed\',\'canceled\')',row.operation_id)||has('task_operations')&&store.one('SELECT 1 FROM task_operations o JOIN tasks t ON t.id=o.task_id WHERE o.operation_id=? AND t.status NOT IN (\'succeeded\',\'failed\',\'canceled\')',row.operation_id)||has('task_outbox')&&store.one('SELECT 1 FROM task_outbox WHERE operation_id=? AND status IN (\'pending\',\'sending\')',row.operation_id))continue;
  store.run('DELETE FROM builtin_operations WHERE operation_id=?',row.operation_id);deleted++;
 }});return{deleted,more:candidates.length===limit||operations.length===limit};
}
