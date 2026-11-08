import type {Store} from '../store.js';
import type {EmployeeChannelRecord} from './types.js';
const canonicalSql = "CASE WHEN provider='dingtalk' AND length(json_extract(record_json,'$.robotCode'))>0 THEN 'robot:'||json_extract(record_json,'$.robotCode') ELSE 'app:'||app_id END";
export class ChannelBindingConflict extends Error { constructor(){super('channel_connection_conflict');} }
export class ChannelBindingMigrationConflict extends Error { constructor(){super('channel_binding_migration_conflict');} }
const canonical = (r:Pick<EmployeeChannelRecord,'provider'|'appId'> & {robotCode?:string}) => r.provider==='dingtalk'&&r.robotCode?`robot:${r.robotCode}`:`app:${r.appId}`;
export class EmployeeChannelRepository {
 constructor(readonly store:Store){store.db.exec(`CREATE TABLE IF NOT EXISTS employee_channel_connections(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),entity_id TEXT NOT NULL REFERENCES entities(id),provider TEXT NOT NULL,app_id TEXT NOT NULL,bot_id TEXT,revision INTEGER NOT NULL,state_version INTEGER NOT NULL,record_json TEXT NOT NULL,UNIQUE(entity_id,provider),UNIQUE(workspace_id,provider,app_id),UNIQUE(workspace_id,provider,bot_id));CREATE TABLE IF NOT EXISTS employee_channel_verification_events(connection_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(connection_id,event_id));CREATE TABLE IF NOT EXISTS employee_channel_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,connection_id TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL);`);this.initializeGlobalBindings();}
 initializeGlobalBindings(){this.store.transaction(()=>{
  // Do not rewrite/delete legacy identities or ciphertext to make a new constraint pass.
  if(this.store.one('SELECT 1 FROM employee_channel_connections GROUP BY provider,app_id HAVING count(*)>1 LIMIT 1')||this.store.one(`SELECT 1 FROM employee_channel_connections GROUP BY provider,${canonicalSql} HAVING count(*)>1 LIMIT 1`))throw new ChannelBindingMigrationConflict();
  this.store.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS employee_channel_global_app ON employee_channel_connections(provider,app_id);
    CREATE UNIQUE INDEX IF NOT EXISTS employee_channel_global_bot ON employee_channel_connections(provider,(${canonicalSql}));`);
 });}
 assertAvailable(record:Pick<EmployeeChannelRecord,'provider'|'appId'> & {id?:string;robotCode?:string}){if(this.store.one(`SELECT id FROM employee_channel_connections WHERE provider=? AND (app_id=? OR (${canonicalSql})=?) AND id<>? LIMIT 1`,record.provider,record.appId,canonical(record),record.id??''))throw new ChannelBindingConflict();}
 all():EmployeeChannelRecord[]{return this.store.all<{record_json:string}>('SELECT record_json FROM employee_channel_connections').map(r=>JSON.parse(r.record_json));}
 list(workspaceId:string,entityId:string):EmployeeChannelRecord[]{return this.store.all<{record_json:string}>('SELECT record_json FROM employee_channel_connections WHERE workspace_id=? AND entity_id=?',workspaceId,entityId).map(r=>JSON.parse(r.record_json));}
 byId(id:string):EmployeeChannelRecord|undefined {const r=this.store.one<{record_json:string}>('SELECT record_json FROM employee_channel_connections WHERE id=?',id);return r?JSON.parse(r.record_json):undefined;}
 byProvider(workspaceId:string,entityId:string,provider:string){return this.list(workspaceId,entityId).find(r=>r.provider===provider);}
 save(record:EmployeeChannelRecord,previous:EmployeeChannelRecord|undefined):boolean {
  // Recheck at the write boundary: asynchronous credential verification may have
  // started before an administrator disabled the employee in another request.
  if(record.enabled&&!this.store.one('SELECT id FROM entities WHERE workspace_id=? AND id=? AND lifecycle_enabled=1',record.workspaceId,record.entityId))throw new ChannelBindingConflict();
  this.assertAvailable(record);
  const next={...record,stateVersion:(previous?.stateVersion??0)+1};
  const changed=previous?this.store.run('UPDATE employee_channel_connections SET app_id=?,bot_id=?,revision=?,state_version=?,record_json=? WHERE id=? AND workspace_id=? AND entity_id=? AND state_version=?',next.appId,next.botId??null,next.revision,next.stateVersion,JSON.stringify(next),next.id,next.workspaceId,next.entityId,previous.stateVersion).changes:this.store.run('INSERT INTO employee_channel_connections(id,workspace_id,entity_id,provider,app_id,bot_id,revision,state_version,record_json) VALUES(?,?,?,?,?,?,?,?,?)',next.id,next.workspaceId,next.entityId,next.provider,next.appId,next.botId??null,next.revision,next.stateVersion,JSON.stringify(next)).changes;
  if(changed)record.stateVersion=next.stateVersion;return !!changed;
 }
 remove(record:EmployeeChannelRecord):boolean{return !!this.store.run('DELETE FROM employee_channel_connections WHERE id=? AND workspace_id=? AND entity_id=? AND state_version=?',record.id,record.workspaceId,record.entityId,record.stateVersion).changes;}
 verificationEvent(id:string,eventId:string,messageId?:string):boolean{return !!this.store.one('SELECT 1 FROM employee_channel_verification_events WHERE connection_id=? AND (event_id=? OR event_id=?)',id,`event:${eventId}`,messageId===undefined?'':`message:${messageId}`);}
 markVerificationEvent(id:string,eventId:string,messageId:string){this.store.transaction(()=>{for(const key of [`event:${eventId}`,`message:${messageId}`])this.store.run('INSERT OR IGNORE INTO employee_channel_verification_events(connection_id,event_id) VALUES(?,?)',id,key);});}
 audit(r:EmployeeChannelRecord,actor:string,action:string,now:number){this.store.run('INSERT INTO employee_channel_audit(workspace_id,entity_id,connection_id,actor_id,action,revision,created_at) VALUES(?,?,?,?,?,?,?)',r.workspaceId,r.entityId,r.id,actor,action,r.revision,now);}
}
