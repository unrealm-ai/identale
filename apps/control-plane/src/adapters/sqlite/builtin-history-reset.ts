import{backup,DatabaseSync}from'node:sqlite';
import{cpSync,mkdirSync,writeFileSync,existsSync,readdirSync,lstatSync}from'node:fs';
import{resolve,join}from'node:path';
export interface BuiltinHistoryResetReport{version:2;status:'ready'|'blocked'|'archived'|'already_current';sessions:number;conversations:number;blocked:string[];backupDirectory?:string}
/** Explicit OFFLINE reset of legacy test context. No transcript, task or configuration is deleted. */
export async function resetLegacyBuiltinHistory(options:{databasePath:string;journalRoot:string;dryRun:boolean;offlineConfirmed?:boolean;backupDirectory?:string}):Promise<BuiltinHistoryResetReport>{
 const path=resolve(options.databasePath);if(!existsSync(path))throw Error('Existing database required');const db=new DatabaseSync(path,{readOnly:options.dryRun});
 try{
  const has=(name:string)=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if(!has('builtin_records'))return{version:2,status:'already_current',sessions:0,conversations:0,blocked:[]};
  const rows=db.prepare("SELECT key,version,json FROM builtin_records WHERE key LIKE 'builtin:session:%' AND json_extract(json,'$.closed')=0 AND json_extract(json,'$.handle.scope.kind')='interaction' AND json_extract(json,'$.handle.sessionId')!=json_extract(json,'$.handle.scope.conversationId')").all();const blocked:string[]=[];
  if(rows.some(r=>{const s=JSON.parse(String(r['json']));return s.activeExecution||s.pendingMaintenance;}))blocked.push('unresolved_generation_or_maintenance');
  if(db.prepare("SELECT 1 FROM builtin_records WHERE json_extract(json,'$.status') IN ('queued','accepted','running','cancel_requested') LIMIT 1").get())blocked.push('nonterminal_runtime');
  if(db.prepare("SELECT 1 FROM tasks WHERE status NOT IN ('succeeded','failed','canceled') LIMIT 1").get())blocked.push('active_task');
  if(has('task_completion_notifications')&&db.prepare("SELECT 1 FROM task_completion_notifications WHERE status NOT IN ('succeeded','failed','canceled') LIMIT 1").get())blocked.push('pending_notification');
  const ids=new Set(rows.map(r=>JSON.parse(String(r['json'])).handle.scope.conversationId as string));const report:BuiltinHistoryResetReport={version:2,status:blocked.length?'blocked':rows.length?'ready':'already_current',sessions:rows.length,conversations:ids.size,blocked};if(options.dryRun||blocked.length||!rows.length)return report;
  if(!options.offlineConfirmed)throw Error('Stop the owning identity instance before applying this reset');
  if(!options.backupDirectory||existsSync(options.backupDirectory))throw Error('A new explicit private backup directory is required');
  const backupDirectory=resolve(options.backupDirectory);mkdirSync(backupDirectory,{mode:0o700});const files:string[]=[];
  const list=(folder:string,prefix='')=>{for(const name of readdirSync(folder)){const p=join(folder,name),s=lstatSync(p);if(s.isSymbolicLink())throw Error('Journal symlinks cannot be backed up');if(s.isDirectory())list(p,join(prefix,name));else if(s.isFile())files.push(join(prefix,name));else throw Error('Unexpected journal entry');}};list(options.journalRoot);
  // Backup directory is private before SQLite creates its backup file.
  await backup(db,join(backupDirectory,'database.sqlite'));cpSync(options.journalRoot,join(backupDirectory,'builtin-records'),{recursive:true,preserveTimestamps:true});
  writeFileSync(join(backupDirectory,'manifest.json'),JSON.stringify({version:2,databasePath:path,journalRoot:resolve(options.journalRoot),createdAt:new Date().toISOString(),sessionKeys:rows.map(r=>r['key']),conversationIds:[...ids],journalFiles:files,restore:'With identity stopped, restore database.sqlite to databasePath and the saved builtin-records directory to journalRoot as one consistent pair. Preserve the current files separately first; do not mix WAL files from another database snapshot.'},null,2),{mode:0o600});
  db.exec('BEGIN IMMEDIATE');try{
   for(const row of rows){const live=db.prepare('SELECT version,json FROM builtin_records WHERE key=?').get(row['key']!);if(!live||live['version']!==row['version']||live['json']!==row['json'])throw Error('Reset input changed; repeat offline dry-run');}
   db.exec('CREATE TABLE IF NOT EXISTS conversation_context_resets(conversation_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL)');
   for(const row of rows){const value=JSON.parse(String(row['json']));db.prepare('UPDATE builtin_records SET version=version+1,json=? WHERE key=?').run(JSON.stringify({...value,closed:true,supersededBy:value.handle.scope.conversationId,resetReason:'legacy_test_context_reset'}),row['key']!);}
   for(const id of ids)db.prepare("INSERT INTO conversation_context_resets VALUES(?,1,'legacy_test_context_reset',?) ON CONFLICT(conversation_id) DO UPDATE SET epoch=epoch+1,reason=excluded.reason,at=excluded.at").run(id,Date.now());
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}return{...report,status:'archived',backupDirectory};
 }finally{db.close();}
}
