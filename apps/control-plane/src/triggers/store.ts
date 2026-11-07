import {randomUUID} from 'node:crypto';
import type {TriggerAction,TriggerHistoryPolicy,TriggerSourceKind} from '@dentity/application';
import type {Store} from '../store.js';
import {DirectoryCredentialVault} from '../directory/secrets.js';
import {TriggerError,triggerIdentifier} from './protocol.js';
export interface TriggerBindingRow {id:string;workspace_id:string;entity_id:string;type:'webhook'|'schedule';name:string;enabled:number;version:number;allowed_actions_json:string;config_json:string;created_at:number;updated_at:number}
export interface TriggerEventRow {id:string;trigger_id:string;event_id:string;workspace_id:string;entity_id:string;source_kind:TriggerSourceKind;source_evidence_ref:string;binding_version:number;action:TriggerAction;payload_json:string;body_hash:string;scheduled_at:number|null;context_namespace:string|null;context_key:string|null;policy_revision:number|null;task_id:string|null;command_operation_id:string|null;status:string;receipt_json:string|null;error_code:string|null;received_at:number;processed_at:number|null}
export interface CredentialRow {id:string;trigger_id:string;key_id:string;credential_version:number;ciphertext:string;nonce:string;tag:string;status:'active'|'revoked';created_at:number;revoked_at:number|null}
const fail=(status:number,code:string):never=>{throw new TriggerError(status,code);};
/** Trigger-only persistence. Runtime dispatch continues to use the task outbox. */
export class TriggerStore {
  private vault:DirectoryCredentialVault;
  constructor(private readonly store:Store,key?:Uint8Array,private readonly now=Date.now){
    this.vault=new DirectoryCredentialVault(key);
    store.db.exec(`CREATE TABLE IF NOT EXISTS trigger_bindings(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),entity_id TEXT NOT NULL REFERENCES entities(id),type TEXT NOT NULL CHECK(type IN ('webhook','schedule')),name TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),version INTEGER NOT NULL,allowed_actions_json TEXT NOT NULL,config_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS trigger_bindings_employee ON trigger_bindings(workspace_id,entity_id,id);
      CREATE TABLE IF NOT EXISTS trigger_credentials(id TEXT PRIMARY KEY,trigger_id TEXT NOT NULL REFERENCES trigger_bindings(id),key_id TEXT NOT NULL,credential_version INTEGER NOT NULL,ciphertext TEXT NOT NULL,nonce TEXT NOT NULL,tag TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('active','revoked')),created_at INTEGER NOT NULL,revoked_at INTEGER,UNIQUE(trigger_id,key_id));
      CREATE INDEX IF NOT EXISTS trigger_credentials_active ON trigger_credentials(trigger_id,status);
      CREATE TABLE IF NOT EXISTS trigger_events(id TEXT PRIMARY KEY,trigger_id TEXT NOT NULL REFERENCES trigger_bindings(id),event_id TEXT NOT NULL,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,source_kind TEXT NOT NULL,source_evidence_ref TEXT NOT NULL,binding_version INTEGER NOT NULL,action TEXT NOT NULL,payload_json TEXT NOT NULL,body_hash TEXT NOT NULL,scheduled_at INTEGER,context_namespace TEXT,context_key TEXT,policy_revision INTEGER,task_id TEXT,command_operation_id TEXT,status TEXT NOT NULL,receipt_json TEXT,error_code TEXT,received_at INTEGER NOT NULL,processed_at INTEGER,UNIQUE(trigger_id,event_id));
      CREATE INDEX IF NOT EXISTS trigger_events_recovery ON trigger_events(status,received_at,id);
      CREATE INDEX IF NOT EXISTS trigger_events_task ON trigger_events(task_id,received_at,id);`);
    const columns=store.all<{name:string}>('PRAGMA table_info(entities)');
    if(!columns.some(c=>c.name==='trigger_history_policy'))store.db.exec("ALTER TABLE entities ADD COLUMN trigger_history_policy TEXT NOT NULL DEFAULT 'isolated' CHECK(trigger_history_policy IN('isolated','employee_shared','business_key'))");
    if(!columns.some(c=>c.name==='trigger_policy_revision'))store.db.exec('ALTER TABLE entities ADD COLUMN trigger_policy_revision INTEGER NOT NULL DEFAULT 1');
  }
  transaction<T>(work:()=>T){return this.store.transaction(work);}
  binding(id:string){return this.store.one<TriggerBindingRow>('SELECT * FROM trigger_bindings WHERE id=?',id);}
  list(workspaceId:string,entityId:string){return this.store.all<TriggerBindingRow>('SELECT * FROM trigger_bindings WHERE workspace_id=? AND entity_id=? ORDER BY created_at,id',workspaceId,entityId);}
  save(input:{workspaceId:string;entityId:string;id?:string;expectedVersion?:number;type:'webhook'|'schedule';name:string;enabled:boolean;allowedActions:readonly TriggerAction[];config:unknown}){
    return this.transaction(()=>{if(!this.store.one('SELECT id FROM entities WHERE id=? AND workspace_id=?',input.entityId,input.workspaceId))return fail(404,'entity_not_found');
      const old=input.id?this.binding(input.id):undefined;
      if(input.id&&(!old||old.workspace_id!==input.workspaceId||old.entity_id!==input.entityId))return fail(404,'trigger_not_found');
      if(old&&(old.version!==input.expectedVersion||old.type!==input.type))return fail(409,'trigger_version_conflict');
      const id=old?.id??randomUUID(),at=this.now();
      if(old)this.store.run('UPDATE trigger_bindings SET name=?,enabled=?,version=version+1,allowed_actions_json=?,config_json=?,updated_at=? WHERE id=? AND version=?',input.name,input.enabled?1:0,JSON.stringify(input.allowedActions),JSON.stringify(input.config),at,id,old.version);
      else this.store.run('INSERT INTO trigger_bindings VALUES(?,?,?,?,?,?,1,?,?,?,?)',id,input.workspaceId,input.entityId,input.type,input.name,input.enabled?1:0,JSON.stringify(input.allowedActions),JSON.stringify(input.config),at,at);
      return this.binding(id)!;
    });
  }
  policy(workspaceId:string,entityId:string){return this.store.one<{policy:TriggerHistoryPolicy;version:number}>('SELECT trigger_history_policy policy,trigger_policy_revision version FROM entities WHERE workspace_id=? AND id=?',workspaceId,entityId)??fail(404,'entity_not_found');}
  setPolicy(workspaceId:string,entityId:string,policy:TriggerHistoryPolicy,version:number){return this.transaction(()=>{const old=this.policy(workspaceId,entityId);if(old.version!==version)return fail(409,'trigger_policy_changed');if(!['isolated','employee_shared','business_key'].includes(policy))return fail(400,'invalid_trigger_policy');this.store.run('UPDATE entities SET trigger_history_policy=?,trigger_policy_revision=trigger_policy_revision+1 WHERE workspace_id=? AND id=? AND trigger_policy_revision=?',policy,workspaceId,entityId,version);return this.policy(workspaceId,entityId);});}
  credentials(workspaceId:string,triggerId:string){const binding=this.binding(triggerId);if(!binding||binding.workspace_id!==workspaceId)return fail(404,'trigger_not_found');return this.store.all<Pick<CredentialRow,'key_id'|'credential_version'|'status'|'created_at'|'revoked_at'>>('SELECT key_id,credential_version,status,created_at,revoked_at FROM trigger_credentials WHERE trigger_id=? ORDER BY credential_version DESC',triggerId);}
  addCredential(workspaceId:string,triggerId:string,keyId:string,secret:string){
    if(!triggerIdentifier(keyId)||typeof secret!=='string'||Buffer.byteLength(secret)<32||Buffer.byteLength(secret)>8192||/[\r\n\x00]/.test(secret))return fail(400,'invalid_trigger_credential');
    if(!this.vault.available)return fail(503,'trigger_secret_store_unconfigured');
    return this.transaction(()=>{const binding=this.binding(triggerId);if(!binding||binding.workspace_id!==workspaceId||binding.type!=='webhook')return fail(404,'trigger_not_found');if(this.store.one('SELECT id FROM trigger_credentials WHERE trigger_id=? AND key_id=?',triggerId,keyId))return fail(409,'trigger_key_conflict');
      const version=this.store.one<{version:number}>('SELECT coalesce(max(credential_version),0)+1 version FROM trigger_credentials WHERE trigger_id=?',triggerId)!.version,sealed=this.vault.seal(secret,['trigger-hmac-v1',workspaceId,triggerId,keyId,version]);
      this.store.run("INSERT INTO trigger_credentials VALUES(?,?,?,?,?,?,?,'active',?,NULL)",randomUUID(),triggerId,keyId,version,sealed.ciphertext,sealed.nonce,sealed.tag,this.now());return this.credentials(workspaceId,triggerId);
    });
  }
  revokeCredential(workspaceId:string,triggerId:string,keyId:string){return this.transaction(()=>{this.credentials(workspaceId,triggerId);if(!this.store.run("UPDATE trigger_credentials SET status='revoked',revoked_at=? WHERE trigger_id=? AND key_id=? AND status='active'",this.now(),triggerId,keyId).changes)return fail(404,'trigger_key_not_active');return this.credentials(workspaceId,triggerId);});}
  /** Internal authentication boundary only: never return from management endpoints. */
  secret(triggerId:string,keyId:string){const binding=this.binding(triggerId),r=this.store.one<CredentialRow>("SELECT * FROM trigger_credentials WHERE trigger_id=? AND key_id=? AND status='active'",triggerId,keyId);if(!binding||!r)return fail(401,'trigger_authentication_failed');try{return this.vault.open(r,['trigger-hmac-v1',binding.workspace_id,triggerId,keyId,r.credential_version]);}catch{return fail(503,'trigger_credential_unavailable');}}
  event(triggerId:string,eventId:string){return this.store.one<TriggerEventRow>('SELECT * FROM trigger_events WHERE trigger_id=? AND event_id=?',triggerId,eventId);}
  insertEvent(row:TriggerEventRow){this.store.run('INSERT INTO trigger_events(id,trigger_id,event_id,workspace_id,entity_id,source_kind,source_evidence_ref,binding_version,action,payload_json,body_hash,scheduled_at,context_namespace,context_key,policy_revision,task_id,command_operation_id,status,receipt_json,error_code,received_at,processed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',row.id,row.trigger_id,row.event_id,row.workspace_id,row.entity_id,row.source_kind,row.source_evidence_ref,row.binding_version,row.action,row.payload_json,row.body_hash,row.scheduled_at,row.context_namespace,row.context_key,row.policy_revision,row.task_id,row.command_operation_id,row.status,row.receipt_json,row.error_code,row.received_at,row.processed_at);}
}
