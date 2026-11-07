import type{Store}from'../store.js';
/** Domain technical details only; user journals and task/run final results are excluded. */
export function technicalRetention(store:Store){
 const has=(table:string)=>!!store.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",table);
 for(const table of ['task_completion_notifications','scheduled_jobs','group_live_batches'])if(has(table)){
  for(const column of ['retention_closed_at','retention_compacted_at'])if(!store.all<{name:string}>(`PRAGMA table_info(${table})`).some(c=>c.name===column))store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`);
  store.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_technical_retention ON ${table}(retention_closed_at,retention_compacted_at)`);
 }
 if(has('group_live_batches'))store.db.exec('CREATE INDEX IF NOT EXISTS group_batch_released_retention ON group_live_batches(released,retention_closed_at,id);CREATE INDEX IF NOT EXISTS group_batch_released_scan ON group_live_batches(released)');
 const cursors=new Map<string,number>();
 return(at:number,limit=100)=>{let deleted=0,more=false;const cutoff=at-30*86400000;
  if(has('task_completion_notifications')){
   const fresh=store.all<{id:string;published_at:number|null;created_at:number}>("SELECT id,published_at,created_at FROM task_completion_notifications WHERE status IN ('published','succeeded','failed','canceled') AND retention_closed_at IS NULL LIMIT ?",limit);
   for(const row of fresh)store.run('UPDATE task_completion_notifications SET retention_closed_at=? WHERE id=?',row.published_at??at,row.id);more ||=fresh.length===limit;
   const rows=store.all<{id:string;turn_id:string|null;rowId:number}>("SELECT rowid rowId,id,turn_id FROM task_completion_notifications WHERE retention_closed_at<? AND retention_compacted_at IS NULL AND rowid>? ORDER BY rowid LIMIT ?",cutoff,cursors.get('notification')??0,limit);
   for(const row of rows){cursors.set('notification',row.rowId);if(row.turn_id&&has('interaction_turns')&&store.one("SELECT 1 FROM interaction_turns WHERE id=? AND status NOT IN ('succeeded','failed','canceled','unknown')",row.turn_id))continue;
    // Keep the task/run idempotency key while the final Task still exists: discovery
    // would otherwise create and republish its old completion notification.
    store.run("UPDATE task_completion_notifications SET scope_json='{}',result_ref='',error=NULL,turn_id=NULL,lease_token=NULL,lease_until=0,retention_compacted_at=? WHERE id=?",at,row.id);deleted++;}
   if(rows.length===limit)more=true;else cursors.delete('notification');
  }
  if(has('scheduled_jobs')){
   const fresh=store.all<{id:string;updated_at:number}>("SELECT id,updated_at FROM scheduled_jobs WHERE status IN ('succeeded','failed','canceled','skipped','obsolete') AND retention_closed_at IS NULL LIMIT ?",limit);
   for(const row of fresh)store.run('UPDATE scheduled_jobs SET retention_closed_at=? WHERE id=?',row.updated_at,row.id);more ||=fresh.length===limit;
   const rows=store.all<{id:string;rowId:number}>("SELECT rowid rowId,id FROM scheduled_jobs WHERE retention_closed_at<? AND handler='context.compact' AND rowid>? ORDER BY rowid LIMIT ?",cutoff,cursors.get('jobs')??0,limit);
   for(const row of rows){cursors.set('jobs',row.rowId);if(has('builtin_records')&&store.one("SELECT 1 FROM builtin_records WHERE json_extract(json,'$.request.authorization.jobRunId')=? OR json_extract(json,'$.pendingMaintenance')=?",row.id,row.id))continue;store.run('DELETE FROM scheduled_jobs WHERE id=?',row.id);deleted++;}if(rows.length===limit)more=true;else cursors.delete('jobs');
  }
  if(has('group_live_batches')){
   const fresh=store.all<{id:string}>('SELECT id FROM group_live_batches WHERE released=1 AND retention_closed_at IS NULL LIMIT ?',limit);for(const row of fresh)store.run('UPDATE group_live_batches SET retention_closed_at=? WHERE id=?',at,row.id);more ||=fresh.length===limit;
   const rows=store.all<{id:string;rowId:number;retention_closed_at:number|null}>('SELECT rowid rowId,id,retention_closed_at FROM group_live_batches WHERE released=1 AND rowid>? ORDER BY rowid LIMIT ?',cursors.get('groups')??0,limit);for(const row of rows){cursors.set('groups',row.rowId);if(row.retention_closed_at===null||row.retention_closed_at>=cutoff)continue;if(has('channel_inbox')&&store.one('SELECT 1 FROM channel_inbox WHERE history_batch_id=? AND (rt_terminal=0 OR event_json IS NOT NULL)',row.id))continue;if(store.one('SELECT 1 FROM group_live_messages WHERE batch_id=?',row.id))continue;store.run('DELETE FROM group_live_batches WHERE id=?',row.id);deleted++;}if(rows.length===limit)more=true;else cursors.delete('groups');
  }
  return{deleted,more};
 };
}
