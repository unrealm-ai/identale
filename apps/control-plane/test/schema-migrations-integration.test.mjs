import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../dist/store.js';
import {createPlatformServer,createRuntimeServer} from '../dist/split/server.js';
import {PLATFORM_TABLES,RUNTIME_TABLES} from '../dist/split/table-ownership.js';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'identale-migration-integration-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
const options=role=>role==='combined'?{}:{role};
function backupCount(root){const path=join(root,'schema-backups');return existsSync(path)?readdirSync(path).length:0;}
function seedPolicy(db){
 db.exec("INSERT INTO users(id,username,display_name) VALUES('u','synthetic-user','Synthetic');INSERT INTO workspaces(id,name,created_by) VALUES('w','Synthetic','u');INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner');INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Synthetic','m','m',1,'u','builtin');");
 db.prepare('INSERT INTO entity_directory_policies(entity_id,workspace_id,revision,allow_json,deny_json,channel_policies_json,allow_group_members) VALUES(?,?,?,?,?,?,?)').run('e','w',17,'[{"id":"bound-a"}]','[{"id":"blocked-b"}]','[{"channel":"wecom","mode":"allowlist"}]',0);
 return {...db.prepare('SELECT * FROM entity_directory_policies').get()};
}
for(const role of ['platform','runtime','combined']){
 test(`${role}: new database versioned once, TEMP projections unversioned`,t=>{
  const root=fixture(t),path=join(root,'db.sqlite');let store=new Store(path,options(role));
  try{
   assert.deepEqual(store.all(`SELECT version FROM main.${role}_schema_migrations ORDER BY version`).map(row=>row.version),[1,2,3]);
   assert.equal(store.all("SELECT name FROM temp.sqlite_master WHERE name LIKE '%schema_migrations'").length,0);
   if(role!=='combined'){
    const opposite=role==='platform'?RUNTIME_TABLES:PLATFORM_TABLES;
    assert.equal(store.all("SELECT name FROM main.sqlite_master WHERE type='table'").some(row=>opposite.includes(row.name)),false);
   }
  }finally{store.close();}
  const count=backupCount(root);store=new Store(path,options(role));store.close();assert.equal(backupCount(root),count);
 });
 test(`${role}: verified legacy schema gains explicit columns without changing authorization`,t=>{
  const root=fixture(t),path=join(root,'db.sqlite');const store=new Store(path,options(role));store.close();
  const db=new DatabaseSync(path);let policy;
  try{
   db.exec(`DROP TABLE ${role}_schema_migrations`);
   if(role!=='runtime'){
    policy=seedPolicy(db);
    for(const field of ['channel_binding_history_json','initial_channel_defaults_json','avatar_preset','description'])db.exec(`ALTER TABLE entities DROP COLUMN ${field}`);
   }
   if(role!=='platform')for(const [table,field]of [['runs','end_reason'],['human_requests','selection_json'],['task_outbox','lease_token']])db.exec(`ALTER TABLE ${table} DROP COLUMN ${field}`);
  }finally{db.close();}
  const upgraded=new Store(path,options(role));try{
   assert.deepEqual(upgraded.all(`SELECT version FROM ${role}_schema_migrations ORDER BY version`).map(row=>row.version),[1,2,3]);
   if(policy)assert.deepEqual({...upgraded.one('SELECT * FROM entity_directory_policies')},policy);
   const fields=role==='runtime'?[['runs','end_reason'],['human_requests','selection_json'],['task_outbox','lease_token']]:[['entities','initial_channel_defaults_json'],['entities','avatar_preset'],['entities','description']];
   for(const [table,field]of fields)assert.ok(upgraded.all(`PRAGMA main.table_info(${table})`).some(c=>c.name===field));
  }finally{upgraded.close();}
  assert.equal(backupCount(root),1);const repeated=new Store(path,options(role));repeated.close();assert.equal(backupCount(root),1);
 });
 test(`${role}: modified checksum and future version prevent opening`,t=>{
  const root=fixture(t),path=join(root,'db.sqlite');new Store(path,options(role)).close();
  let db=new DatabaseSync(path);const checksum=db.prepare(`SELECT checksum FROM ${role}_schema_migrations WHERE version=1`).get().checksum;db.exec(`UPDATE ${role}_schema_migrations SET checksum='tampered' WHERE version=1`);db.close();
  assert.throws(()=>new Store(path,options(role)),/checksum_mismatch/);
  db=new DatabaseSync(path);db.prepare(`UPDATE ${role}_schema_migrations SET checksum=? WHERE version=1`).run(checksum);db.exec(`UPDATE ${role}_schema_migrations SET version=999 WHERE version=3`);db.close();
  assert.throws(()=>new Store(path,options(role)),/database_newer_than_code/);
 });
}

test('real split API creates an employee after migration and syncs configuration',async t=>{
 const root=fixture(t),origin='http://127.0.0.1:15173',configurationToken='isolated-config-token-'.repeat(4),serviceToken='isolated-runtime-token-'.repeat(4);let p,r;
 const transport=async(raw,init={})=>{const u=new URL(String(raw)),target=u.port==='20110'?p:r;if(!target)throw Error('isolated service unavailable');const result=await target.inject({method:init.method??'GET',url:u.pathname+u.search,headers:Object.fromEntries(new Headers(init.headers)),...(init.body===undefined?{}:{payload:init.body})});return new Response(result.statusCode===204||result.statusCode===304?null:result.rawPayload,{status:result.statusCode,headers:result.headers});};
 try{
  p=createPlatformServer({databasePath:join(root,'platform.sqlite'),origin,configurationToken,runtimeService:{url:'http://127.0.0.1:20111',token:serviceToken},transport,directorySync:{automatic:false}});await p.ready();
  r=createRuntimeServer({databasePath:join(root,'runtime.sqlite'),origin,platformConfig:{url:'http://127.0.0.1:20110',token:configurationToken,pollMs:3600000},serviceToken,transport,directorySync:{automatic:false},triggers:{automatic:false},maintenance:{enabled:false},pollIntervalMs:0});await r.ready();
  const register=await p.inject({method:'POST',url:'/api/auth/register',headers:{origin},payload:{username:'migration-owner',password:'Synthetic isolated QA password!'}});assert.equal(register.statusCode,201,register.body);
  const owner=register.json(),cookie=register.headers['set-cookie'].split(';')[0];
  const created=await p.inject({method:'POST',url:`/api/workspaces/${owner.workspace.id}/entities`,headers:{origin,cookie},payload:{name:'Migration employee',ownWebUse:true}});assert.equal(created.statusCode,200,created.body);assert.equal(created.json().entity.name,'Migration employee');
  await r.getDecorator('configurationPoller').poll();assert.equal((await r.inject({url:'/readyz'})).statusCode,200);
 }finally{await r?.close();await p?.close();}
});

test('corrupt migration history prevents split server from becoming ready',async t=>{
 const root=fixture(t),path=join(root,'platform.sqlite');new Store(path,{role:'platform'}).close();const db=new DatabaseSync(path);db.exec("UPDATE platform_schema_migrations SET checksum='bad'");db.close();
 let app;try{await assert.rejects(async()=>{app=createPlatformServer({databasePath:path,origin:'http://127.0.0.1:15173',configurationToken:'isolated-config-token-'.repeat(4),runtimeService:{url:'http://127.0.0.1:20111',token:'isolated-runtime-token-'.repeat(4)},directorySync:{automatic:false}});await app.ready();},/checksum_mismatch/);}finally{await app?.close();}
});

 test('configuration projection cannot import a migration history table',t=>{
  const root=fixture(t),store=new Store(join(root,'runtime.sqlite'),{role:'runtime'});
  try{assert.throws(()=>store.replaceConfigurationTables([{name:'platform_schema_migrations',sql:'CREATE TABLE platform_schema_migrations(version INTEGER PRIMARY KEY)',rows:[]}]),/snapshot_table_forbidden/);assert.equal(store.all("SELECT name FROM temp.sqlite_master WHERE name LIKE '%schema_migrations'").length,0);}finally{store.close();}
 });

test('two actual Store starters converge on one platform migration',async t=>{
 const root=fixture(t),path=join(root,'platform.sqlite');const {spawn}=await import('node:child_process');
 const module=new URL('../dist/store.js',import.meta.url).href;
 const source=`import{Store}from ${JSON.stringify(module)};new Store(process.argv[1],{role:'platform'}).close();`;
 const start=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',source,path],{stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',chunk=>error+=chunk);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(error)));});
 await Promise.all([start(),start()]);const db=new DatabaseSync(path);try{assert.deepEqual(db.prepare('SELECT version FROM platform_schema_migrations ORDER BY version').all().map(row=>row.version),[1,2,3]);}finally{db.close();}
});

const releasedChecksums={
 platform:['791ff03c8b039b68957d1f4e020a841471845e01a2ee0b305592e1f860b5abb9','5160532572c55a72137a5ea38289e2b9d43bc16663b8fea72af26f13a177bdcf'],
 runtime:['fe8cfc506155f8ea0d0138e379f86bb3bad373ebcbb2dee31bf11bd74809c3d3','8cdfa4b6644651cbdb32899a2a1968bf224ff8a3d51d26eaae6970fb8c60ad32'],
 combined:['b0c45a88b2e6561901f337e68f15b1f87eb6bee31b562eb420d0649e113851f5','8d5b38a24aab6b6b4474471ec77c267c22bb715cbdcb7eb83c7ace33124d8c84'],
};
for(const role of ['platform','runtime','combined'])test(`${role}: V2 upgrades to V3 preserving released checksums, policies and binding history on restart`,t=>{
 const root=fixture(t),path=join(root,'v2.sqlite');new Store(path,options(role)).close();
 const db=new DatabaseSync(path);let policy;
 try{
  assert.deepEqual(db.prepare(`SELECT checksum FROM ${role}_schema_migrations WHERE version<=2 ORDER BY version`).all().map(r=>r.checksum),releasedChecksums[role]);
  db.exec(`DELETE FROM ${role}_schema_migrations WHERE version=3`);
  if(role!=='runtime'){policy=seedPolicy(db);db.exec('ALTER TABLE entities DROP COLUMN channel_binding_history_json');}
 }finally{db.close();}
 let store=new Store(path,options(role));
 try{
  assert.deepEqual(store.all(`SELECT version FROM ${role}_schema_migrations ORDER BY version`).map(r=>r.version),[1,2,3]);
  if(policy){assert.deepEqual({...store.one('SELECT * FROM entity_directory_policies')},policy);assert.equal(store.one('SELECT channel_binding_history_json FROM entities').channel_binding_history_json,'{}');store.run('UPDATE entities SET channel_binding_history_json=?',JSON.stringify({wecom:true}));}
 }finally{store.close();}
 assert.equal(backupCount(root),1);store=new Store(path,options(role));
 try{if(policy)assert.equal(store.one('SELECT channel_binding_history_json FROM entities').channel_binding_history_json,'{"wecom":true}');assert.deepEqual(store.all(`SELECT checksum FROM ${role}_schema_migrations WHERE version<=2 ORDER BY version`).map(r=>r.checksum),releasedChecksums[role]);}finally{store.close();}
 assert.equal(backupCount(root),1);
});
