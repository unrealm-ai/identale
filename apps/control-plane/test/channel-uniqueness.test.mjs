import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {EmployeeChannelRepository,ChannelBindingMigrationConflict} from '../dist/employee-channels/repository.js';
import {EmployeeChannelService} from '../dist/employee-channels/service.js';
async function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'identity-global-bot-')),path=join(dir,'test.sqlite'),store=new Store(path);
 store.run("INSERT INTO users(id,username,display_name) VALUES('u','owner','Owner')");
 store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Private one','u'),('other','Private two','u')");
 store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner'),('om','other','u','owner')");
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','First','m','m',1,'u','builtin'),('e2','other','Second','om','om',1,'u','builtin')");
 const options={masterKey:Buffer.alloc(32,21),verifyApplication:async(p,appId)=>({identity:{appId,tenantId:'fixture-tenant',tenantIdNamespace:p==='dingtalk'?'app_id':'tenant_key'},...(p==='feishu'?{botId:`bot-${appId}`,eventTenantId:'fixture-tenant'}:{}),directoryStatus:'available'})};
 const repo=new EmployeeChannelRepository(store),service=new EmployeeChannelService(repo,options);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return{store,path,repo,service,options};
}
const input=appId=>({appId,appSecret:'synthetic-global-binding-secret',expectedRevision:0});
const duplicate=e=>e.code==='channel_connection_conflict';
test('global unique indexes stop direct SQL app and canonical robot collisions across workspaces',async t=>{
 const f=await setup(t),a=await f.service.save('w','e','feishu','u',input('app-a'));
 const original=f.repo.byId(a.id),other={...original,id:'direct-other',workspaceId:'other',entityId:'e2'};
 assert.throws(()=>f.store.run('INSERT INTO employee_channel_connections(id,workspace_id,entity_id,provider,app_id,bot_id,revision,state_version,record_json) VALUES(?,?,?,?,?,?,?,?,?)',other.id,other.workspaceId,other.entityId,other.provider,other.appId,'another-bot',1,1,JSON.stringify(other)),/UNIQUE/);
 assert.equal(f.repo.all().length,1);
});
test('independent SQL connections racing same app commit one binding and reject the other without tenant leakage',async t=>{
 const f=await setup(t),secondStore=new Store(f.path),other=new EmployeeChannelService(new EmployeeChannelRepository(secondStore),f.options);t.after(()=>secondStore.close());
 const results=await Promise.allSettled([f.service.save('w','e','feishu','u',input('race-app')),other.save('other','e2','feishu','u',input('race-app'))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const rejected=results.find(r=>r.status==='rejected').reason;assert.equal(rejected.code,'channel_connection_conflict');assert.equal(rejected.message,'channel_connection_conflict');assert.equal(f.repo.all().length,1);
});
test('conflicting edit keeps old configuration valid, and disabled bindings retain global identity',async t=>{
 const f=await setup(t),first=await f.service.save('w','e','feishu','u',input('app-a')),second=await f.service.save('other','e2','feishu','u',input('app-b'));
 const before=JSON.stringify(f.repo.byId(second.id));
 await assert.rejects(f.service.save('other','e2','feishu','u',{...input('app-a'),expectedRevision:second.revision,replaceSource:true}),duplicate);assert.equal(JSON.stringify(f.repo.byId(second.id)),before);
 f.service.settings('w','e','feishu','u',{enabled:false,expectedRevision:first.revision});await assert.rejects(f.service.save('other','e2','feishu','u',{...input('app-a'),expectedRevision:second.revision,replaceSource:true}),duplicate);
});
function candidate(f,w,e,appId,robotCode,botId){const c=f.service.list(w,e)[0],v=f.service.startVerification(w,e,'dingtalk','u',{expectedRevision:c.revision});f.service.recordVerifiedCandidate(c.id,String(v.revision),{appId,botId,tenantId:'fixture-corp',robotCode,challengeText:v.challengeText,eventId:'event-'+e,messageId:'message-'+e});const ready=f.service.verification(w,e,'dingtalk');return()=>f.service.confirmVerification(w,e,'dingtalk','u',{expectedRevision:ready.revision,candidateId:ready.candidateId});}
test('DingTalk reserves ClientID first and independently fences authenticated robotCode without equating the strings',async t=>{
 const f=await setup(t);await f.service.save('w','e','dingtalk','u',input('client-a'));await f.service.save('other','e2','dingtalk','u',input('client-b'));
 const verified=candidate(f,'w','e','client-a','separate-robot-code','bot-a')();assert.notEqual(verified.appId,'separate-robot-code');
 const conflict=candidate(f,'other','e2','client-b','separate-robot-code','bot-b');assert.throws(conflict,duplicate);
 const before=f.repo.byId(verified.id);await f.service.revalidate('w','e','dingtalk','u',before.revision);assert.equal(f.repo.byId(before.id).robotCode,'separate-robot-code');
 const raw={...f.repo.byId(before.id),id:'direct-canonical',workspaceId:'other',entityId:'e2',appId:'different-client'};
 // Existing second app occupies e2; remove only this isolated test row to exercise the canonical index directly.
 f.store.run('DELETE FROM employee_channel_connections WHERE entity_id=?','e2');
 assert.throws(()=>f.store.run('INSERT INTO employee_channel_connections(id,workspace_id,entity_id,provider,app_id,bot_id,revision,state_version,record_json) VALUES(?,?,?,?,?,?,?,?,?)',raw.id,raw.workspaceId,raw.entityId,raw.provider,raw.appId,'different-bot',1,1,JSON.stringify(raw)),/UNIQUE/);
});
test('legacy duplicates stop migration without deleting records or rewriting encrypted bytes',async t=>{
 const f=await setup(t),first=await f.service.save('w','e','feishu','u',input('legacy-app')),r=f.repo.byId(first.id);
 f.store.db.exec('DROP INDEX employee_channel_global_app; DROP INDEX employee_channel_global_bot');
 const duplicateRow={...r,id:'legacy-second',workspaceId:'other',entityId:'e2'};
 f.store.run('INSERT INTO employee_channel_connections(id,workspace_id,entity_id,provider,app_id,bot_id,revision,state_version,record_json) VALUES(?,?,?,?,?,?,?,?,?)',duplicateRow.id,duplicateRow.workspaceId,duplicateRow.entityId,duplicateRow.provider,duplicateRow.appId,duplicateRow.botId,1,1,JSON.stringify(duplicateRow));
 const before=f.store.all('SELECT record_json FROM employee_channel_connections ORDER BY id');
 assert.throws(()=>new EmployeeChannelRepository(f.store),ChannelBindingMigrationConflict);assert.deepEqual(f.store.all('SELECT record_json FROM employee_channel_connections ORDER BY id'),before);assert.equal(f.repo.all().length,2);
});
