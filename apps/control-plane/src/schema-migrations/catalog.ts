import {DatabaseSync} from 'node:sqlite';
import {RETAINED_LEGACY_SCHEMA,RETAINED_DIRECTORY_COLUMN} from './retained-legacy.js';
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
function baselineSchemaForRole(role:MigrationRole):SchemaObject[]{return BASELINE_V1.filter(o=>role==='combined'||tableOwner(o.tbl_name)===role).map(o=>({...o,sql:o.type==='table'&&role!=='combined'?stripCrossDomainReferences(o.sql,role):o.sql}));}
/** Current schema is also used for read-only cross-role TEMP projections. */
export function schemaForRole(role:MigrationRole):SchemaObject[]{return baselineSchemaForRole(role).map(o=>o.name==='entities'?{...o,sql:o.sql.replace(/\)$/,", channel_binding_history_json TEXT NOT NULL DEFAULT '{}')")}:o);}
function normalized(value:unknown):string{return String(value).split(/('(?:''|[^'])*')/g).map((part,i)=>i%2?part:part.replace(/\s+/g,' ').toLowerCase()).join('').trim();}
function foreignKeys(db:DatabaseSync,table:string,present:Set<string>):string[]{return db.prepare(`PRAGMA main.foreign_key_list(${quote(table)})`).all().filter(r=>present.has(String(r['from']))).map(r=>JSON.stringify([r['table'],r['from'],r['to'],r['on_update'],r['on_delete'],r['match']])).sort();}
function uniqueKeys(db:DatabaseSync,table:string):string[]{return db.prepare(`PRAGMA main.index_list(${quote(table)})`).all().filter(r=>Number(r['unique'])===1&&r['origin']!=='c').map(r=>JSON.stringify(db.prepare(`PRAGMA main.index_info(${quote(String(r['name']))})`).all().map(c=>c['name']))).sort();}
function canonicalSQL(sql:string):string{return sql.split(/('(?:''|[^'])*')/g).map((part,i)=>i%2?part:normalized(part.replace(/\bIF\s+NOT\s+EXISTS\b/gi,'')).replace(/\s*([(),;])\s*/g,'$1')).join('');}
function checks(sql:string,present:Set<string>):string[]{return parts(sql).filter(p=>{const c=p.trim().match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))/)?.slice(1).find(Boolean);return !c||['check','constraint','primary','unique','foreign'].includes(c.toLowerCase())||present.has(c);}).flatMap(p=>p.match(/CHECK\s*\((?:[^()]|\([^)]*\))*\)/gi)??[]).map(canonicalSQL).sort();}
function compatible(db:DatabaseSync,reference:DatabaseSync,schema:SchemaObject[],legacy:boolean,allowRetired=legacy){
 const tables=new Map(schema.filter(o=>o.type==='table').map(o=>[o.name,o]));
 for(const row of db.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()){
  const name=String(row['name']);if(/^(platform|runtime|combined)_schema_migrations$/.test(name))continue;
  const retained=RETAINED_LEGACY_SCHEMA.find(o=>o.name===name);
  if(retained){if(!allowRetired)throw Error(`schema_migration_retired_object_after_cleanup:${name}`);if(row['type']!==retained.type||!schema.some(o=>tableOwner(o.tbl_name)===retained.owner)||canonicalSQL(String(row['sql']))!==canonicalSQL(retained.sql))throw Error(`schema_migration_unrecognized_retired_object:${name}`);continue;}
  if(row['type']==='table'){
   if(!tables.has(name))throw Error(`schema_migration_unrecognized_table:${name}`);
   if(/\bWITHOUT\s+ROWID\b/i.test(String(row['sql']))!==/\bWITHOUT\s+ROWID\b/i.test(tables.get(name)!.sql)||/\bSTRICT\s*$/i.test(String(row['sql']))!==/\bSTRICT\s*$/i.test(tables.get(name)!.sql))throw Error(`schema_migration_unrecognized_table_options:${name}`);
   const expected=new Map(columns(reference,name).map(c=>[c.name,c]));
   const actualColumns=columns(db,name);
   // Offline split copies a validated current schema without the source role's
   // history table. Recognize only the exact additive V3 column while adopting
   // that copy; V1/V2 apply functions and their published checksums stay frozen.
   if(name==='entities'&&!expected.has('channel_binding_history_json')&&actualColumns.some(c=>c.name==='channel_binding_history_json'))expected.set('channel_binding_history_json',{name:'channel_binding_history_json',type:'TEXT',notnull:1,dflt_value:"'{}'",pk:0,hidden:0});
   const retainedColumn=allowRetired&&name==='employee_channel_connections'&&actualColumns.some(c=>c.name==='directory_credential_id');
   if(retainedColumn){
    const c=actualColumns.find(c=>c.name==='directory_credential_id')!;
    const links=db.prepare(`PRAGMA main.foreign_key_list(${quote(name)})`).all().filter(f=>f['from']==='directory_credential_id');
    if(links.length!==1||links[0]!['table']!=='employee_channel_directory_credentials'||links[0]!['to']!=='id'||links[0]!['on_update']!=='NO ACTION'||links[0]!['on_delete']!=='RESTRICT'||links[0]!['match']!=='NONE'||links[0]!['seq']!==0)throw Error('schema_migration_unrecognized_retired_column_constraint');
    if(c.type!=='TEXT'||c.notnull!==0||c.dflt_value!==null||c.pk!==0||c.hidden!==0||canonicalSQL(definition(String(row['sql']),'directory_credential_id'))!==canonicalSQL(RETAINED_DIRECTORY_COLUMN)||!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='employee_channel_directory_credentials'").get())throw Error('schema_migration_unrecognized_retired_column:employee_channel_connections.directory_credential_id');
   }
   const present=new Set(actualColumns.filter(c=>!retainedColumn||c.name!=='directory_credential_id').map(c=>c.name));
   if(JSON.stringify(checks(String(row['sql']),present))!==JSON.stringify(checks(tables.get(name)!.sql,present)))throw Error(`schema_migration_unrecognized_checks:${name}`);
   if(JSON.stringify(foreignKeys(db,name,present))!==JSON.stringify(foreignKeys(reference,name,present))||JSON.stringify(uniqueKeys(db,name))!==JSON.stringify(uniqueKeys(reference,name)))throw Error(`schema_migration_unrecognized_constraints:${name}`);
   for(const col of actualColumns){if(retainedColumn&&col.name==='directory_credential_id')continue;const target=expected.get(col.name);if(!target||['type','notnull','pk','hidden'].some(k=>col[k as keyof Column]!==target[k as keyof Column])||normalized(col.dflt_value)!==normalized(target.dflt_value))throw Error(`schema_migration_unrecognized_column:${name}.${col.name}`);expected.delete(col.name);}
   for(const col of expected.keys())if(!legacy||!ADDITIVE_V1[name]?.includes(col))throw Error(`schema_migration_missing_column:${name}.${col}`);
  }else {const expected=schema.find(o=>o.name===name&&o.type===row['type']);if(!expected||canonicalSQL(String(row['sql']))!==canonicalSQL(expected.sql))throw Error(`schema_migration_unrecognized_object:${name}`);}
 }
 if(!legacy)for(const object of schema)if(!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type=? AND name=?").get(object.type,object.name))throw Error(`schema_migration_missing_${object.type}:${object.name}`);
}
/** Durable schemas are migrated before any repository, worker or TEMP projection. */
export function migrateDatabase(db:DatabaseSync,path:string,role:MigrationRole,verifyOnly=false):void{
 const schema=baselineSchemaForRole(role),reference=new DatabaseSync(':memory:'),targetReference=new DatabaseSync(':memory:');
 try{
  for(const object of schema){reference.exec(object.sql);targetReference.exec(object.sql);}
  const bindingHistorySQL=role==='runtime'?'-- runtime has no employee binding history':"ALTER TABLE entities ADD COLUMN channel_binding_history_json TEXT NOT NULL DEFAULT '{}'";
  if(role!=='runtime')targetReference.exec(bindingHistorySQL);
  const targetSchema=targetReference.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as unknown as SchemaObject[];
  const hasBindingHistory=(database:DatabaseSync)=>role!=='runtime'&&columns(database,'entities').some(c=>c.name==='channel_binding_history_json');
  const validatePreV3=(database:DatabaseSync,legacy=false,allowRetired=legacy)=>hasBindingHistory(database)?compatible(database,targetReference,targetSchema,legacy,allowRetired):compatible(database,reference,schema,legacy,allowRetired);
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
  }},{version:2,name:'remove_retired_directory_and_verification_storage',sql:JSON.stringify(role==='runtime'?[
   'DROP TABLE IF EXISTS wecom_member_verification_attempts',
   'DROP TABLE IF EXISTS wecom_member_verification_notices',
  ]:role==='platform'?[
   'DROP INDEX IF EXISTS employee_channel_directory_reference',
   'ALTER TABLE employee_channel_connections DROP COLUMN directory_credential_id',
   'DROP TABLE IF EXISTS employee_channel_directory_credentials',
  ]:[
   'DROP INDEX IF EXISTS employee_channel_directory_reference',
   'ALTER TABLE employee_channel_connections DROP COLUMN directory_credential_id',
   'DROP TABLE IF EXISTS employee_channel_directory_credentials',
   'DROP TABLE IF EXISTS wecom_member_verification_attempts',
   'DROP TABLE IF EXISTS wecom_member_verification_notices',
  ]),apply(database){
   // V2 alone owns destructive cleanup. Validate exact historical signatures
   // before touching even a recognized old name; never delete unknown shapes.
   compatible(database,reference,schema,false,true);
   if(role!=='runtime'){
    database.exec('DROP INDEX IF EXISTS employee_channel_directory_reference');
    if(columns(database,'employee_channel_connections').some(c=>c.name==='directory_credential_id'))database.exec('ALTER TABLE employee_channel_connections DROP COLUMN directory_credential_id');
    database.exec('DROP TABLE IF EXISTS employee_channel_directory_credentials');
   }
   if(role!=='platform')database.exec('DROP TABLE IF EXISTS wecom_member_verification_attempts; DROP TABLE IF EXISTS wecom_member_verification_notices');
  }},{version:3,name:'employee_channel_binding_history',sql:bindingHistorySQL,apply(database){
   // Validate the released V2 shape before adding lifecycle state; no existing
   // authorization policy or historical binding is inferred or rewritten.
   validatePreV3(database);
   if(role!=='runtime'&&!hasBindingHistory(database))database.exec(bindingHistorySQL);
  }}],validateBaseline:database=>validatePreV3(database,true),validateTarget:(database,migrated)=>{compatible(database,targetReference,targetSchema,false);if(migrated&&database.prepare('PRAGMA foreign_key_check').get())throw Error('schema_migration_foreign_key_failure');}};
  if(verifyOnly){
   const rows=db.prepare(`SELECT version,name,checksum FROM ${role}_schema_migrations ORDER BY version`).all();
   if(rows.length!==options.migrations.length)throw Error('schema_migration_database_version_unsupported');
   rows.forEach((row,i)=>{const expected=options.migrations[i]!;if(row['version']!==expected.version||row['name']!==expected.name||row['checksum']!==migrationChecksum(expected))throw Error('schema_migration_checksum_or_version_mismatch');});
   options.validateTarget!(db,false);
  }else runSchemaMigrations(db,options);
 }finally{reference.close();targetReference.close();}
}

/** Read-only guard for offline tools. Never adopts or repairs an unversioned source. */
export function validateDatabaseVersion(db:DatabaseSync,expectedRole?:MigrationRole):MigrationRole|'unversioned'{
 const roles=(['platform','runtime','combined'] as const).filter(role=>db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(`${role}_schema_migrations`));
 if(!roles.length)return 'unversioned';
 if(roles.length!==1||(expectedRole&&roles[0]!==expectedRole))throw Error('schema_migration_wrong_database_role');
 const role=roles[0]!;migrateDatabase(db,':memory:',role,true);return role;
}
