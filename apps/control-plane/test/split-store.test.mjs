import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../dist/store.js';
import {ModelProfileService} from '../dist/model-profiles.js';
import {CapabilityConfigService} from '../dist/capability-config.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {TriggerStore} from '../dist/triggers/store.js';
import {PLATFORM_TABLES,RUNTIME_TABLES} from '../dist/split/table-ownership.js';
import {createJournalIndex} from '../dist/adapters/sqlite/journal-index.js';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'identity-split-store-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('interaction journal indexes belong to runtime disk and stay temporary in platform across reopen',t=>{
 const dir=fixture(t),tables=['builtin_journal_scopes','builtin_journal_index','builtin_journal_heads'];
 for(const role of ['runtime','platform']){
  const path=join(dir,role+'.sqlite');let store=new Store(path,{role});
  try{
   let index=createJournalIndex(store);
   for(const name of tables){assert.ok(RUNTIME_TABLES.includes(name));assert.ok(!PLATFORM_TABLES.includes(name));assert.ok(store.one(`SELECT 1 FROM ${role==='runtime'?'main':'temp'}.sqlite_master WHERE type='table' AND name=?`,name));assert.equal(store.one(`SELECT 1 FROM ${role==='runtime'?'temp':'main'}.sqlite_master WHERE type='table' AND name=?`,name),undefined);}
   index.markMigrated('synthetic-scope');index.add('synthetic-scope',{recordId:'synthetic-record',kind:'message',bytes:10});index.setHead('synthetic-scope',{version:'1',refs:[],checksum:'synthetic-checksum'});
   store.close();store=new Store(path,{role});index=createJournalIndex(store);
   assert.equal(index.migrated('synthetic-scope'),role==='runtime');assert.equal(index.list('synthetic-scope','message').length,role==='runtime'?1:0);assert.equal(index.head('synthetic-scope')?.version,role==='runtime'?'1':undefined);
  }finally{store.close();}
 }
});
const facts={
 users:[{id:'u',username:'owner',display_name:'Owner',status:'active'}],
 workspaces:[{id:'w',name:'Workspace',created_by:'u',status:'active'}],
 members:[{id:'m',workspace_id:'w',user_id:'u',role:'owner',status:'active'}],
 entities:[{id:'e',workspace_id:'w',name:'Employee',owner_member_id:'m',created_by_member_id:'m',own_web_use:1,web_use_user_id:'u',interaction_runtime:'builtin'}],
};
test('split roles persist only own tables, dynamic config remains TEMP memory and legacy Store unchanged',t=>{
 const dir=fixture(t);
 for(const role of ['runtime','platform']){
  const store=new Store(join(dir,role+'.sqlite'),{role});
  try{
   new ModelProfileService(store);new CapabilityConfigService(store,[]);new EmployeeChannelRepository(store);new TriggerStore(store);
   const main=store.all("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(r=>r.name);
   const opposite=role==='runtime'?PLATFORM_TABLES:RUNTIME_TABLES;
   assert.equal(main.some(name=>opposite.includes(name)),false);
   assert.ok(main.length>5);
   const config=store.one("SELECT sql FROM sqlite_master WHERE name='model_catalog' AND type='table'");assert.ok(config?.sql);
   if(role==='runtime'){
    assert.ok(store.one("SELECT 1 FROM temp.sqlite_master WHERE name='model_catalog'"));
    assert.equal(store.all('PRAGMA main.foreign_key_list(conversations)').some(row=>PLATFORM_TABLES.includes(row.table)),false);
    assert.equal(store.all('PRAGMA main.foreign_key_list(runs)').some(row=>row.table==='tasks'),true);
    assert.equal(store.all('PRAGMA temp.foreign_key_list(entities)').some(row=>row.table==='workspaces'),true);
   }
  } finally {store.close();}
 }
 const legacy=new Store(join(dir,'legacy.sqlite'));try{assert.ok(legacy.one("SELECT name FROM main.sqlite_master WHERE name='users'"));assert.ok(legacy.one("SELECT name FROM main.sqlite_master WHERE name='tasks'"));}finally{legacy.close();}
});
test('snapshot replacement is atomic, runtime rows cannot be injected and config is gone after restart',t=>{
 const dir=fixture(t),path=join(dir,'runtime.sqlite');let store=new Store(path,{role:'runtime'});
 store.replaceConfigurationTables(facts);
 assert.equal(store.one('SELECT name FROM entities WHERE id=?','e').name,'Employee');
 store.run("INSERT INTO conversations(id,workspace_id,entity_id,user_id,operation_id,created_at,owner_key) VALUES('c','w','e','u','op',1,'owner')");
 assert.throws(()=>store.replaceConfigurationTables({users:[{id:'u2',username:'new',display_name:'New',status:'active'}]}));
 assert.equal(store.one('SELECT id FROM users').id,'u');
 assert.throws(()=>store.replaceConfigurationTables({tasks:[]}),/snapshot_table_forbidden/);
 assert.throws(()=>store.replaceConfigurationTables({credentials:[]}),/snapshot_table_forbidden/);
 assert.throws(()=>store.replaceConfigurationTables({users:[{injected:'no'}]}),/snapshot_column_unknown/);
 store.replaceConfigurationTables({...facts,entities:[{...facts.entities[0],name:'Changed'}]});
 assert.equal(store.one('SELECT name FROM entities').name,'Changed');
 const id=store.databaseId;store.close();store=new Store(path,{role:'runtime'});
 try{assert.equal(store.databaseId,id);assert.equal(store.one('SELECT id FROM users'),undefined);assert.equal(store.one('SELECT id FROM entities'),undefined);assert.equal(store.one('SELECT id FROM conversations').id,'c');}finally{store.close();}
 const disk=new DatabaseSync(path,{readOnly:true});try{assert.equal(disk.prepare("SELECT name FROM sqlite_master WHERE name='users'").get(),undefined);}finally{disk.close();}
});
test('wrong-owner existing tables and unknown DDL are rejected without deleting any data',t=>{
 const dir=fixture(t),path=join(dir,'existing.sqlite');let db=new DatabaseSync(path);db.exec("CREATE TABLE users(id TEXT);INSERT INTO users VALUES('keep')");db.close();
 assert.throws(()=>new Store(path,{role:'runtime'}),/split_storage_wrong_owner:users/);
 db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare('SELECT id FROM users').get().id,'keep');}finally{db.close();}
 const store=new Store(join(dir,'runtime.sqlite'),{role:'runtime'});try{assert.throws(()=>store.db.exec('CREATE TABLE unowned(id TEXT)'),/split_unknown_table/);}finally{store.close();}
});
test('catalog first-sync evolves TEMP columns atomically and keeps schema/data/indexes on failure',t=>{
 const dir=fixture(t),platform=new Store(join(dir,'platform.sqlite'),{role:'platform'}),runtime=new Store(join(dir,'runtime.sqlite'),{role:'runtime'});
 try{
  assert.equal(runtime.one('PRAGMA temp_store').temp_store,2);
  runtime.replaceConfigurationTables(facts);
  runtime.db.exec('CREATE INDEX IF NOT EXISTS employee_name_lookup ON entities(name)');
  new TriggerStore(platform);
  const catalog=Object.entries(facts).map(([name,rows])=>({name,rows,sql:platform.one("SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?",name).sql}));
  const entity=catalog.find(table=>table.name==='entities');entity.rows=[{...facts.entities[0],trigger_history_policy:'employee_shared',trigger_policy_revision:7}];
  runtime.replaceConfigurationTables(catalog);
  assert.equal(runtime.one('SELECT trigger_policy_revision FROM entities').trigger_policy_revision,7);
  assert.ok(runtime.one("SELECT name FROM temp.sqlite_master WHERE name='employee_name_lookup'"));
  assert.equal(runtime.one("SELECT name FROM main.sqlite_master WHERE name='entities'"),undefined);
  const before=runtime.one("SELECT sql FROM temp.sqlite_master WHERE name='entities'").sql;
  const invalid=catalog.map(table=>table.name==='entities'?{...table,sql:table.sql.replace(/\)\s*$/,', new_required TEXT NOT NULL)')}:table);
  assert.throws(()=>runtime.replaceConfigurationTables(invalid),/NOT NULL/);
  assert.equal(runtime.one("SELECT sql FROM temp.sqlite_master WHERE name='entities'").sql,before);
  assert.equal(runtime.one('SELECT trigger_policy_revision FROM entities').trigger_policy_revision,7);
  assert.ok(runtime.one("SELECT name FROM temp.sqlite_master WHERE name='employee_name_lookup'"));
  assert.equal(runtime.one('PRAGMA foreign_keys').foreign_keys,1);
  assert.throws(()=>runtime.replaceConfigurationTables(catalog.map(table=>table.name==='workspaces'?{...table,rows:[{...facts.workspaces[0],created_by:'missing'}]}:table)),/snapshot_foreign_key_check_failed/);
  assert.equal(runtime.one('SELECT created_by FROM workspaces').created_by,'u');
  assert.throws(()=>runtime.replaceConfigurationTables([{name:'entities',sql:entity.sql+';DROP TABLE tasks',rows:[]}]),/snapshot_schema_invalid/);
  assert.throws(()=>platform.replaceConfigurationTables(catalog),/snapshot_wrong_store/);
 }finally{platform.close();runtime.close();}
});
test('queue scheduling cursors persist only in runtime and platform projections vanish on reopen',async t=>{const{SqliteTaskRepository}=await import('../dist/adapters/sqlite/task-repository.js');const dir=fixture(t);for(const role of['runtime','platform']){const path=join(dir,role+'-queue.sqlite');let s=new Store(path,{role});try{new SqliteTaskRepository(s);const own=role==='runtime'?'main':'temp',opposite=role==='runtime'?'temp':'main';assert.ok(s.one(`SELECT 1 FROM ${own}.sqlite_master WHERE name='queue_scan_cursors'`));assert.equal(s.one(`SELECT 1 FROM ${opposite}.sqlite_master WHERE name='queue_scan_cursors'`),undefined);s.run("INSERT INTO queue_scan_cursors VALUES('synthetic',1,2,3)");s.close();s=new Store(path,{role});new SqliteTaskRepository(s);assert.equal(!!s.one("SELECT key FROM queue_scan_cursors WHERE key='synthetic'"),role==='runtime');}finally{s.close();}}});
