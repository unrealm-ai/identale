import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../dist/store.js';
import {createPlatformServer} from '../dist/split/server.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {CapabilityConfigService} from '../dist/capability-config.js';

const origin='http://127.0.0.1:15173';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'identale-platform-defaults-upgrade-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return join(root,'platform.sqlite');}
function server(databasePath){return createPlatformServer({databasePath,origin,configurationToken:'synthetic-configuration-token-'.repeat(3),runtimeService:{url:'http://127.0.0.1:29999',token:'synthetic-runtime-token-'.repeat(3)},directorySync:{automatic:false}});}
function call(app,method,url,payload,cookie){return app.inject({method,url,headers:{origin,...(cookie?{cookie}:{})},...(payload===undefined?{}:{payload})});}
const defaults={feishu:'denylist',dingtalk:'denylist',wecom:'denylist'};

test('existing split platform upgrades missing entity defaults before real API creation without changing old permissions',async t=>{
 const root=mkdtempSync(join(tmpdir(),'identale-platform-defaults-upgrade-')),path=join(root,'platform.sqlite');let app=server(path);
 t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});await app.ready();
 const registration=await call(app,'POST','/api/auth/register',{username:'upgrade-owner',password:'Synthetic isolated QA password!'});assert.equal(registration.statusCode,201,registration.body);
 const cookie=registration.headers['set-cookie'].split(';')[0],workspaceId=registration.json().workspace.id;
 const created=await call(app,'POST',`/api/workspaces/${workspaceId}/entities`,{name:'Existing employee',ownWebUse:true},cookie);assert.equal(created.statusCode,200,created.body);const oldId=created.json().entity.id;
 await app.close();
 // Model the previous split schema in an isolated file, not the user's database.
 let raw=new DatabaseSync(path);
 raw.prepare('INSERT OR REPLACE INTO entity_directory_policies(entity_id,workspace_id,revision,allow_json,deny_json) VALUES(?,?,?,?,?)').run(oldId,workspaceId,7,'[]','[]');
 const oldPolicy=raw.prepare('SELECT * FROM entity_directory_policies WHERE entity_id=?').get(oldId),oldEntities=raw.prepare('SELECT count(*) AS n FROM entities').get().n;
 raw.exec('DROP TABLE platform_schema_migrations; ALTER TABLE entities DROP COLUMN initial_channel_defaults_json');raw.close();
 app=server(path);await app.ready();
 const result=await call(app,'POST',`/api/workspaces/${workspaceId}/entities`,{name:'New employee after upgrade',ownWebUse:true},cookie);assert.equal(result.statusCode,200,result.body);
 raw=new DatabaseSync(path,{readOnly:true});
 try{
  assert.equal(raw.prepare('SELECT initial_channel_defaults_json FROM entities WHERE id=?').get(oldId).initial_channel_defaults_json,'{}');
  assert.deepEqual(raw.prepare('SELECT * FROM entity_directory_policies WHERE entity_id=?').get(oldId),oldPolicy);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM entities').get().n,oldEntities+1);
  assert.deepEqual(JSON.parse(raw.prepare('SELECT initial_channel_defaults_json FROM entities WHERE id=?').get(result.json().entity.id).initial_channel_defaults_json),defaults);
  assert.equal(raw.prepare('PRAGMA quick_check').get().quick_check,'ok');
 }finally{raw.close();}
});

test('split platform defaults migration is idempotent and leaves consumed defaults and new tables intact',t=>{
 const path=fixture(t);let store=new Store(path,{role:'platform'});
 store.run("INSERT INTO users VALUES('u','user','User','active')");store.run("INSERT INTO workspaces VALUES('w','Workspace','u','active')");store.run("INSERT INTO members(id,workspace_id,user_id,role,status) VALUES('m','w','u','owner','active')");
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime,initial_channel_defaults_json) VALUES('e','w','Employee','m','m',1,'u','builtin',?)",JSON.stringify({wecom:'denylist'}));
 new EmployeeChannelRepository(store);new CapabilityConfigService(store,[]);
 // These independent tables were added alongside the defaults change. Older
 // split databases must initialize them through the versioned baseline.
 store.db.exec('DROP TABLE platform_schema_migrations; DROP TABLE wecom_identity_bindings; DROP TABLE wecom_member_challenges;');store.close();
 for(let i=0;i<3;i++){
  store=new Store(path,{role:'platform'});new EmployeeChannelRepository(store);new CapabilityConfigService(store,[]);
  try{
   assert.deepEqual(JSON.parse(store.one("SELECT initial_channel_defaults_json FROM entities WHERE id='e'").initial_channel_defaults_json),{wecom:'denylist'});
   assert.equal(store.all('PRAGMA main.table_info(entities)').filter(c=>c.name==='initial_channel_defaults_json').length,1);
   for(const name of ['wecom_identity_bindings','wecom_member_challenges'])assert.ok(store.one("SELECT name FROM main.sqlite_master WHERE name=?",name));
   assert.equal(store.one("SELECT name FROM temp.sqlite_master WHERE name='entities'"),undefined);
  }finally{store.close();}
 }
});

test('fresh split platform and runtime projection contain the same safe entity default column',t=>{
 const path=fixture(t);
 for(const role of ['platform','runtime']){
  const store=new Store(path+'-'+role,{role});
  try{const columns=store.all(`PRAGMA ${role==='platform'?'main':'temp'}.table_info(entities)`),column=columns.find(c=>c.name==='initial_channel_defaults_json');assert.equal(column?.dflt_value,"'{}'");assert.equal(column?.notnull,1);}finally{store.close();}
 }
});
