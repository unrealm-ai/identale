import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../dist/store.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {EmployeeChannelService} from '../dist/employee-channels/service.js';
import {registerEmployeeChannelRoutes} from '../dist/employee-channels/routes.js';

function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'identity-wecom-bot-')),store=new Store(join(dir,'test.sqlite'));
 store.run("INSERT INTO users(id,username,display_name) VALUES('u','owner','Owner')");
 store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Workspace','u')");
 store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner')");
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin'),('e2','w','Second','m','m',1,'u','builtin')");
 const repository=new EmployeeChannelRepository(store),service=new EmployeeChannelService(repository,{masterKey:Buffer.alloc(32,7)});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,repository,service};
}
const save=(f,expectedRevision=0,appSecret='synthetic-secret')=>f.service.save('w','e','wecom','u',{appId:'synthetic-bot',appSecret,expectedRevision});

test('WeCom bot-only source has no traditional directory dependency or manual verification',async t=>{
 const f=setup(t),c=await save(f);
 assert.equal(c.directoryMode,'member_search');assert.equal(c.directoryStatus,'unavailable');assert.equal(c.status,'pending_verification');
 assert.equal(c.validation.canContinue,true);assert.equal(c.validation.checks[0].status,'unverified');
 assert.equal(c.tenantIdNamespace,'app_id');assert.equal(c.tenantId,c.appId);assert.equal(c.directoryBinding,undefined);
 assert.deepEqual(f.service.directorySources(),[]);assert.equal(f.service.directorySource(c.id),undefined);
 assert.throws(()=>f.service.startVerification('w','e','wecom','u',{expectedRevision:c.revision}),{code:'channel_verification_automatic'});
 assert.equal(f.store.one("SELECT name FROM sqlite_master WHERE name='employee_channel_directory_credentials'"),undefined);
 assert.equal(f.store.all('PRAGMA table_info(employee_channel_connections)').some(c=>c.name==='directory_credential_id'),false);
 assert.ok(!JSON.stringify(c).includes('synthetic-secret'));
});

test('same BotID credential rotation preserves source, fences session evidence and keeps disabled state',async t=>{
 const f=setup(t),first=await save(f);
 f.service.observeFirstInbound(first.id,{appId:first.appId,botId:first.appId,tenantId:first.appId,tenantNamespace:'app_id'});
 const oldVersion=f.service.currentBindingVersion(first.id),next=await save(f,first.revision,'rotated-secret');
 assert.equal(next.id,first.id);assert.equal(next.sourceId,first.sourceId);assert.equal(next.authRevision,first.authRevision+1);assert.equal(next.status,'pending_verification');assert.equal(next.inboundVerified,false);
 assert.equal(f.service.currentBindingVersion(first.id),undefined);
 f.service.observeFirstInbound(first.id,{appId:first.appId,botId:first.appId,tenantId:first.appId,tenantNamespace:'app_id'});
 // Same bot credential rotation fences transport auth, not the persistent identity mapping.
 assert.equal(f.service.currentBindingVersion(first.id),oldVersion);
 const disabled=f.service.settings('w','e','wecom','u',{enabled:false,expectedRevision:next.revision});
 const retry=await f.service.revalidate('w','e','wecom','u',disabled.revision);
 assert.equal(retry.status,'disabled');assert.equal(retry.sourceId,first.sourceId);
});

test('robot replacement and stale credential writes are rejected without changing source',async t=>{
 const f=setup(t),c=await save(f);
 await assert.rejects(save(f,0,'other'),{code:'channel_configuration_changed'});
 await assert.rejects(f.service.save('w','e','wecom','u',{appId:'other-bot',appSecret:'secret',expectedRevision:c.revision}),{code:'channel_unbind_required'});
 await assert.rejects(f.service.save('w','e2','wecom','u',{appId:c.appId,appSecret:'secret',expectedRevision:0}),{code:'channel_connection_conflict'});
 assert.equal(f.repository.byId(c.id).sourceId,c.sourceId);
 for(const appSecret of ['  ','a\nb','a\0b'])await assert.rejects(save(f,c.revision,appSecret),{code:'invalid_channel_credentials'});
});

test('traditional directory API is retired and department discovery is explicitly unsupported',async t=>{
 const f=setup(t),app=Fastify();t.after(()=>app.close());
 await registerEmployeeChannelRoutes(app,f.service,{requireManager:()=> 'u'});await save(f);
 const base='/api/workspaces/w/entities/e/channels/wecom';
 assert.equal((await app.inject({method:'POST',url:base+'/directory-credentials',payload:{corpId:'corp',agentId:'7',appSecret:'secret'}})).statusCode,404);
 assert.equal((await app.inject({method:'PUT',url:base+'/directory-binding',payload:{credentialId:'old',confirmSameCorp:true}})).statusCode,404);
 const discovery=await app.inject({method:'GET',url:base+'/directory?kind=departments'});
 assert.equal(discovery.statusCode,400);assert.equal(discovery.json().error,'channel_directory_unsupported');
});


test('retired enterprise-scoped records do not reconnect or use directory fallback',async t=>{
 const f=setup(t),c=await save(f),old=f.repository.byId(c.id);
 f.repository.save({...old,identity:{appId:c.appId,tenantId:'old-corp',tenantIdNamespace:'corp_id'},eventTenantId:'old-corp',status:'verified',directoryStatus:'available'},old);
 assert.equal(f.service.ingressConfiguration(c.id),undefined);
 assert.equal(f.service.currentBindingVersion(c.id),undefined);
 await assert.rejects(f.service.revalidate('w','e','wecom','u',c.revision),{code:'wecom_bot_reconfiguration_required'});
 assert.deepEqual(f.service.directorySources(),[]);
});

test('WeCom recent-context defaults on and persists independent off generation without enabling listener',async t=>{
 const f=setup(t),c=await save(f);assert.equal(c.context.wecomRecentGroupContextEnabled,true);assert.equal(c.context.groupListenEnabled,undefined);
 const off=f.service.settings('w','e','wecom','u',{enabled:true,expectedRevision:c.revision,wecomRecentGroupContextEnabled:false});
 assert.equal(off.context.wecomRecentGroupContextEnabled,false);assert.equal(off.context.wecomRecentGroupContextGeneration,1);assert.equal(off.context.groupListenEnabled,false);
 const unchanged=f.service.settings('w','e','wecom','u',{enabled:true,expectedRevision:off.revision});assert.equal(unchanged.context.wecomRecentGroupContextEnabled,false);assert.equal(unchanged.context.wecomRecentGroupContextGeneration,1);
 const on=f.service.settings('w','e','wecom','u',{enabled:true,expectedRevision:unchanged.revision,wecomRecentGroupContextEnabled:true});assert.equal(on.context.wecomRecentGroupContextGeneration,2);
 assert.throws(()=>f.service.settings('w','e','wecom','u',{enabled:true,expectedRevision:on.revision,groupListenEnabled:true}),/channel_context_unsupported/);
});
