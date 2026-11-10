import {DatabaseSync} from 'node:sqlite';
import {BASELINE_V1} from './baseline-v1.js';
import {runSchemaMigrations,migrationChecksum,type MigrationRole,type MigrationOptions} from './runner.js';
import {tableOwner,stripCrossDomainReferences} from '../split/table-ownership.js';

// Frozen compatibility contract for pre-version databases. Do not broaden this
// list to hide a schema mismatch: subsequent releases must append a migration.
const ADDITIVE_V1:Readonly<Record<string,readonly string[]>>={
 entities:['lifecycle_enabled','lifecycle_revision','execution_thinking_level','model_settings_revision','avatar_preset','initial_channel_defaults_json','description','trigger_history_policy','trigger_policy_revision'],
 invitations:['reusable'],members:['version'],tasks:['title','snapshot_expires_at','config_snapshot_json','planned_history_ids_json','planned_package_ids_json','origin_kind','trigger_id','creation_event_record_id','context_namespace','context_key','policy_revision','terminal_at'],
 task_operations:['receipt_json'],task_outbox:['lease_token'],runs:['attempt','kind','parent_run_id','end_reason','terminal_at','history_manifest_ref'],human_requests:['input_revision','selection_json'],
 conversations:['mode','expires_at'],interaction_turns:['queue_input_id','scope_json','reply_id'],
 model_profiles:['interaction_thinking_control','execution_thinking_control'],model_catalog:['input_capabilities_json','protocol'],skill_resource_versions:['package_json','source_json'],
 entity_directory_policies:['channel_policies_json','allow_group_members'],entity_web_policies:['allow_workspace_members'],
 directory_sync_tasks:['full_snapshot'],directory_sync_history:['source_version'],wecom_bot_contacts:['selected'],
 context_maintenance_schedules:['last_context_fingerprint'],work_item_dispatches:['source_run_id'],group_live_topic_roots:['guard_json'],
 task_host_bindings:['binding_revision','materials_json','host_instance_id','material_pending_revision','configuration_id','profile_source','host_url'],
 task_completion_notifications:['event_status','delivery_id','retention_closed_at','retention_compacted_at'],scheduled_jobs:['retention_closed_at','retention_compacted_at'],group_live_batches:['retention_closed_at','retention_compacted_at'],
 builtin_records:['created_at','closed_at'],builtin_operations:['created_at','closed_at'],
 trigger_result_notifications:['delivery_status','delivery_error','provider_accepted'],business_notification_jobs:['attempt','delivery_state','delivery_error'],
 channel_message_receipts:['source_key','payload_hash'],
 channel_inbox:['employee_use_admitted','source_key','payload_hash','lease_owner','submitted_at','submit_deadline','accepted_at','committed_at','closed_at','input_text','history_batch_id','event_cursor','rt_terminal'],
 channel_deliveries:['provider_request_id','correlation_json','retry_at','lane','connection_id','priority','blocking','lease_owner','attempt_token','attempts','first_attempt_at','send_deadline','closed_at','receipt_query_state','receipt_query_attempts','receipt_query_at','receipt_query_deadline','receipt_query_token','receipt_query_lease_until'],
};
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
type SchemaObject={type:string;name:string;tbl_name:string;sql:string};
type Column={name:string;type:string;notnull:number;dflt_value:unknown;pk:number;hidden:number};
const columns=(db:DatabaseSync,table:string)=>db.prepare(`PRAGMA main.table_xinfo(${quote(table)})`).all() as unknown as Column[];
function parts(sql:string):string[]{
 const start=sql.indexOf('(');let depth=1,begin=start+1,quoted='';const out:string[]=[];
 for(let i=begin;i<sql.length;i++){const c=sql[i]!;if(quoted){if(c===quoted){if(sql[i+1]===quoted&&quoted!==']')i++;else quoted='';}continue;}if(['"',"'",'`','['].includes(c)){quoted=c==='['?']':c;continue;}if(c==='(')depth++;if(c===')'&&!--depth){out.push(sql.slice(begin,i));return out;}if(c===','&&depth===1){out.push(sql.slice(begin,i));begin=i+1;}}
 throw Error('schema_migration_invalid_table_sql');
}
function definition(sql:string,column:string):string{const p=parts(sql).find(x=>x.trim().match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))/)?.slice(1).includes(column));if(!p)throw Error('schema_migration_column_definition_missing');return p.trim();}
export function schemaForRole(role:MigrationRole):SchemaObject[]{return BASELINE_V1.filter(o=>role==='combined'||tableOwner(o.tbl_name)===role).map(o=>({...o,sql:o.type==='table'&&role!=='combined'?stripCrossDomainReferences(o.sql,role):o.sql}));}
function normalized(value:unknown):string{return String(value).split(/('(?:''|[^'])*')/g).map((part,i)=>i%2?part:part.replace(/\s+/g,' ').toLowerCase()).join('').trim();}
function foreignKeys(db:DatabaseSync,table:string,present:Set<string>):string[]{return db.prepare(`PRAGMA main.foreign_key_list(${quote(table)})`).all().filter(r=>present.has(String(r['from']))).map(r=>JSON.stringify([r['table'],r['from'],r['to'],r['on_update'],r['on_delete'],r['match']])).sort();}
function uniqueKeys(db:DatabaseSync,table:string):string[]{return db.prepare(`PRAGMA main.index_list(${quote(table)})`).all().filter(r=>Number(r['unique'])===1&&r['origin']!=='c').map(r=>JSON.stringify(db.prepare(`PRAGMA main.index_info(${quote(String(r['name']))})`).all().map(c=>c['name']))).sort();}
function canonicalSQL(sql:string):string{return sql.split(/('(?:''|[^'])*')/g).map((part,i)=>i%2?part:normalized(part.replace(/\bIF\s+NOT\s+EXISTS\b/gi,'')).replace(/\s*([(),;])\s*/g,'$1')).join('');}
function checks(sql:string,present:Set<string>):string[]{return parts(sql).filter(p=>{const c=p.trim().match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))/)?.slice(1).find(Boolean);return !c||['check','constraint','primary','unique','foreign'].includes(c.toLowerCase())||present.has(c);}).flatMap(p=>p.match(/CHECK\s*\((?:[^()]|\([^)]*\))*\)/gi)??[]).map(canonicalSQL).sort();}
function compatible(db:DatabaseSync,reference:DatabaseSync,schema:SchemaObject[],legacy:boolean){
 const tables=new Map(schema.filter(o=>o.type==='table').map(o=>[o.name,o]));
 for(const row of db.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()){
  const name=String(row['name']);if(/^(platform|runtime|combined)_schema_migrations$/.test(name))continue;
  if(row['type']==='table'){
   if(!tables.has(name))throw Error(`schema_migration_unrecognized_table:${name}`);
   if(/\bWITHOUT\s+ROWID\b/i.test(String(row['sql']))!==/\bWITHOUT\s+ROWID\b/i.test(tables.get(name)!.sql)||/\bSTRICT\s*$/i.test(String(row['sql']))!==/\bSTRICT\s*$/i.test(tables.get(name)!.sql))throw Error(`schema_migration_unrecognized_table_options:${name}`);
   const expected=new Map(columns(reference,name).map(c=>[c.name,c]));
   const present=new Set(columns(db,name).map(c=>c.name));
   if(JSON.stringify(checks(String(row['sql']),present))!==JSON.stringify(checks(tables.get(name)!.sql,present)))throw Error(`schema_migration_unrecognized_checks:${name}`);
   if(JSON.stringify(foreignKeys(db,name,present))!==JSON.stringify(foreignKeys(reference,name,present))||JSON.stringify(uniqueKeys(db,name))!==JSON.stringify(uniqueKeys(reference,name)))throw Error(`schema_migration_unrecognized_constraints:${name}`);
   for(const col of columns(db,name)){const target=expected.get(col.name);if(!target||['type','notnull','pk','hidden'].some(k=>col[k as keyof Column]!==target[k as keyof Column])||normalized(col.dflt_value)!==normalized(target.dflt_value))throw Error(`schema_migration_unrecognized_column:${name}.${col.name}`);expected.delete(col.name);}
   for(const col of expected.keys())if(!legacy||!ADDITIVE_V1[name]?.includes(col))throw Error(`schema_migration_missing_column:${name}.${col}`);
  }else {const expected=schema.find(o=>o.name===name&&o.type===row['type']);if(!expected||canonicalSQL(String(row['sql']))!==canonicalSQL(expected.sql))throw Error(`schema_migration_unrecognized_object:${name}`);}
 }
 if(!legacy)for(const object of schema)if(!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type=? AND name=?").get(object.type,object.name))throw Error(`schema_migration_missing_${object.type}:${object.name}`);
}
/** Durable schemas are migrated before any repository, worker or TEMP projection. */
export function migrateDatabase(db:DatabaseSync,path:string,role:MigrationRole,verifyOnly=false):void{
 const schema=schemaForRole(role),reference=new DatabaseSync(':memory:');
 try{
  for(const object of schema)reference.exec(object.sql);
  const manifest=JSON.stringify({schema,additive:ADDITIVE_V1});
  const options:MigrationOptions={role,databasePath:path,migrations:[{version:1,name:'versioned_storage_baseline',sql:"-- frozen-v1-manifest " + Buffer.from(manifest).toString("base64"),apply(database){
   let upgradeTriggerReceipts=false;
   for(const object of schema.filter(o=>o.type==='table')){
    const exists=database.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(object.name);
    if(!exists){database.exec(object.sql);continue;}
    const present=new Set(columns(database,object.name).map(c=>c.name));
    for(const column of columns(reference,object.name))if(!present.has(column.name)){
     if(object.name==='trigger_result_notifications'&&['delivery_status','delivery_error','provider_accepted'].includes(column.name))upgradeTriggerReceipts=true;
     database.exec(`ALTER TABLE ${quote(object.name)} ADD COLUMN ${definition(object.sql,column.name)}`);
     if(object.name==='runs'&&column.name==='attempt')database.exec('UPDATE runs SET attempt=(SELECT count(*) FROM runs p WHERE p.task_id=runs.task_id AND (p.created_at<runs.created_at OR (p.created_at=runs.created_at AND p.rowid<=runs.rowid)))');
     if(object.name==='tasks'&&column.name==='snapshot_expires_at')database.exec("UPDATE tasks SET snapshot_expires_at=0 WHERE snapshot_json!='[]'");
     if(object.name==='directory_sync_tasks'&&column.name==='full_snapshot')database.exec('UPDATE directory_sync_tasks SET next_at=0 WHERE enabled=1 AND invalidated=0');
    }
   }
   if(upgradeTriggerReceipts)database.exec("UPDATE trigger_result_notifications SET delivery_status=coalesce((SELECT status FROM channel_message_receipts WHERE kind='outbox' AND id=trigger_result_notifications.id),CASE WHEN error IS NULL THEN 'unknown' ELSE 'failed' END),delivery_error=(SELECT error FROM channel_message_receipts WHERE kind='outbox' AND id=trigger_result_notifications.id),provider_accepted=EXISTS(SELECT 1 FROM channel_message_receipts WHERE kind='outbox' AND id=trigger_result_notifications.id AND provider_request_id IS NOT NULL)");
   for(const object of schema.filter(o=>o.type!=='table'))if(!database.prepare('SELECT 1 FROM main.sqlite_master WHERE name=?').get(object.name))database.exec(object.sql);
  }}],validateBaseline:database=>compatible(database,reference,schema,true),validateTarget:(database,migrated)=>{compatible(database,reference,schema,false);if(migrated&&database.prepare('PRAGMA foreign_key_check').get())throw Error('schema_migration_foreign_key_failure');}};
  if(verifyOnly){
   const rows=db.prepare(`SELECT version,name,checksum FROM ${role}_schema_migrations ORDER BY version`).all();
   if(rows.length!==options.migrations.length)throw Error('schema_migration_database_version_unsupported');
   rows.forEach((row,i)=>{const expected=options.migrations[i]!;if(row['version']!==expected.version||row['name']!==expected.name||row['checksum']!==migrationChecksum(expected))throw Error('schema_migration_checksum_or_version_mismatch');});
   options.validateTarget!(db,false);
  }else runSchemaMigrations(db,options);
 }finally{reference.close();}
}

/** Read-only guard for offline tools. Never adopts or repairs an unversioned source. */
export function validateDatabaseVersion(db:DatabaseSync,expectedRole?:MigrationRole):MigrationRole|'unversioned'{
 const roles=(['platform','runtime','combined'] as const).filter(role=>db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(`${role}_schema_migrations`));
 if(!roles.length)return 'unversioned';
 if(roles.length!==1||(expectedRole&&roles[0]!==expectedRole))throw Error('schema_migration_wrong_database_role');
 const role=roles[0]!;migrateDatabase(db,':memory:',role,true);return role;
}
