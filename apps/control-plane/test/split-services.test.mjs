import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {ModelProfileService} from '../dist/model-profiles.js';
import {createServer as createRuleModel,closeServer as closeRuleModel} from '../../mock-model/dist/server.js';
import {DatabaseSync} from 'node:sqlite';
import {createPlatformServer,createRuntimeServer} from '../dist/split/server.js';
const origin='http://127.0.0.1:15173',configurationToken='config-token-'.repeat(4),serviceToken='runtime-token-'.repeat(4);
async function fixture(t,{offline=false,runtimeOptions={},platformOptions={}}={}){
 const root=await mkdtemp(join(tmpdir(),'identity-split-services-'));let p,r;let platformDown=offline;
 const transport=async(raw,init={})=>{const u=new URL(String(raw)),target=u.port==='20110'?p:r;if((u.port==='20110'&&platformDown)||!target)throw Error('isolated service unavailable');let payload=init.body;if(payload instanceof ArrayBuffer)payload=Buffer.from(payload);const result=await target.inject({method:init.method??'GET',url:u.pathname+u.search,headers:Object.fromEntries(new Headers(init.headers)),...(payload===undefined?{}:{payload})});return new Response(result.statusCode===204||result.statusCode===304?null:result.rawPayload,{status:result.statusCode,headers:result.headers});};
 p=createPlatformServer({databasePath:join(root,'platform','platform.sqlite'),origin,configurationToken,runtimeService:{url:'http://127.0.0.1:20111',token:serviceToken},transport,directorySync:{automatic:false},...platformOptions});await p.ready();
 const runtimeConfig={databasePath:join(root,'runtime','runtime.sqlite'),origin,platformConfig:{url:'http://127.0.0.1:20110',token:configurationToken,pollMs:3600000},serviceToken,transport,directorySync:{automatic:false},triggers:{automatic:false},maintenance:{enabled:false},pollIntervalMs:0,...runtimeOptions};r=createRuntimeServer(runtimeConfig);await r.ready();
 t.after(async()=>{await r.close();await p.close();await rm(root,{recursive:true,force:true});});
 const call=(method,url,payload,cookie,headers={})=>p.inject({method,url,headers:{origin,...(cookie?{cookie}:{}),...headers},...(payload===undefined?{}:{payload})});
 const poll=()=>r.getDecorator('configurationPoller').poll();
 async function register(name){const result=await call('POST','/api/auth/register',{username:name,password:'Synthetic isolated QA password!'});assert.equal(result.statusCode,201,result.body);return{...result.json(),cookie:result.headers['set-cookie'].split(';')[0]};}
 return{p,get r(){return r;},call,poll,root,register,setDown(v){platformDown=v;},async restart(){await r.close();r=createRuntimeServer(runtimeConfig);await r.ready();}};
}
test('business OAuth configuration and material routes use the authenticated runtime relay only',async t=>{
 const f=await fixture(t),owner=await f.register('business-resource-split-owner');await f.poll();
 let response=await f.call('GET','/api/business-resources/configuration',undefined,owner.cookie);
 assert.equal(response.statusCode,200,response.body);assert.equal(response.json().configured,false);
 assert.equal((await f.call('GET','/api/business-resources/configuration')).statusCode,401);
 response=await f.call('GET','/api/business-resources/materials?taskId=missing',undefined,owner.cookie);
 assert.equal(response.statusCode,404,response.body);assert.equal(response.json().error,'task_not_found');
 assert.equal((await f.call('GET','/api/business-resources/configuration/other',undefined,owner.cookie)).statusCode,404);
 assert.equal((await f.r.inject({url:'/api/business-resources/configuration',headers:{'x-dentity-actor':owner.user.id}})).statusCode,401);
});
test('new workspace work item defaults synchronize to runtime and retain requested versus applied state',async t=>{
 const f=await fixture(t),owner=await f.register('default-items-split-owner');
 const settings='/api/workspaces/'+owner.workspace.id+'/work-items/settings';
 let response=await f.call('GET',settings,undefined,owner.cookie);
 assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(response.json().configured,{revision:1,enabled:true});
 assert.equal(response.json().effective.available,false,'Unapplied workspace configuration must not look ready');
 assert.equal(response.json().effective.enabled,false);
 await f.poll();
 response=await f.call('GET',settings,undefined,owner.cookie);
 assert.equal(response.json().effective.available,true);
 assert.equal(response.json().effective.enabled,true);
 assert.equal(response.json().effective.appliedRevision,1);
 const saved=await f.call('PUT',settings,{expectedRevision:1,enabled:false},owner.cookie);
 assert.equal(saved.statusCode,200,saved.body);
 response=await f.call('GET',settings,undefined,owner.cookie);
 assert.deepEqual(response.json().configured,{revision:2,enabled:false});
 assert.equal(response.json().effective.enabled,true,'Runtime has not yet applied the new revision');
 assert.equal(response.json().effective.appliedRevision,1);
 await f.poll();await f.restart();
 response=await f.call('GET',settings,undefined,owner.cookie);
 assert.deepEqual(response.json().configured,{revision:2,enabled:false});
 assert.equal(response.json().effective.enabled,false);
 assert.equal(response.json().effective.appliedRevision,2);
});
test('runtime channel status exposes matching connection versions and real transport through platform monitor',async t=>{
 const {ingressFixture}=await import('./helpers/ingress-fixture.mjs');
 const {EmployeeChannelRepository}=await import('../dist/employee-channels/repository.js');
 const {DirectoryCredentialVault}=await import('../dist/directory/secrets.js');
 const ingress=ingressFixture(),masterKey=Buffer.alloc(32,19);
 const f=await fixture(t,{platformOptions:{modelProfiles:{masterKey},employeeChannels:{masterKey}},runtimeOptions:{channelIngressFactory:ingress.factory}});
 const owner=await f.register('status-owner'),other=await f.register('status-other'),workspaceId=owner.workspace.id;
 const created=await f.call('POST',`/api/workspaces/${workspaceId}/entities`,{name:'Status employee',ownWebUse:true},owner.cookie);
 assert.equal(created.statusCode,200,created.body);const entityId=created.json().entity.id,path=`/api/workspaces/${workspaceId}/entities/${entityId}`;
 // Synthetic seed in the isolated real SQLite repository, encrypted by the real vault.
 // Reuse the existing ingress fixture; no provider or model API is called.
 const seed=new Store(join(f.root,'platform','platform.sqlite'),{role:'platform'});
 try{
  const record={id:'status-connection',sourceId:'status-source',workspaceId,entityId,provider:'feishu',appId:'status-app',identity:{appId:'status-app',tenantId:'status-tenant',tenantIdNamespace:'tenant_key'},botId:'status-bot',revision:2,authRevision:1,stateVersion:0,status:'verified',enabled:true,directoryStatus:'available',lastError:null,createdBy:owner.user.id,updatedBy:owner.user.id};
  record.credential=new DirectoryCredentialVault(masterKey).seal(JSON.stringify({appSecret:'Synthetic-isolated-status-secret'}),[workspaceId,entityId,record.id,record.appId,record.authRevision]);
  assert.equal(new EmployeeChannelRepository(seed).save(record),true);
 }finally{seed.close();}
 await f.poll();const live=await ingress.current('status-connection');
 const first=await f.call('GET',path+'/runtime-status',undefined,owner.cookie);assert.equal(first.statusCode,200,first.body);
 const channel=first.json().employee.channels[0];
 assert.deepEqual({id:channel.id,appId:channel.appId,revision:channel.revision,authRevision:channel.authRevision},{id:'status-connection',appId:'status-app',revision:2,authRevision:1});
 assert.equal(channel.transport.state,'connected');assert.equal(channel.state,'connected');assert.ok(channel.transport.changedAt>0);assert.ok(channel.transport.lastConnectedAt>0);
 const again=await f.call('GET',path+'/runtime-status',undefined,owner.cookie);assert.equal(again.json().employee.channels[0].transport.changedAt,channel.transport.changedAt,'queries preserve actual transition time');
 live.sink.onStatus({state:'reconnecting',changedAt:Date.now()});
 const changed=await f.call('GET',path+'/runtime-status',undefined,owner.cookie);assert.equal(changed.json().employee.channels[0].transport.state,'reconnecting');
 assert.equal((await f.call('GET',path+'/runtime-status',undefined,other.cookie)).statusCode,403);
 assert.ok(!first.body.includes('Synthetic-isolated-status-secret'));assert.equal(channel.transport.error,undefined);
});

test('split services separate authority, poll valid empty snapshots, retain privacy and reject forged browser actors',async t=>{
 const f=await fixture(t);assert.equal((await f.r.inject({url:'/readyz'})).statusCode,200);
 const owner=await f.register('split-owner'),other=await f.register('split-other'),base='/api/workspaces/'+owner.workspace.id;
 const created=await f.call('POST',base+'/entities',{name:'No model employee',ownWebUse:true},owner.cookie);assert.equal(created.statusCode,200,created.body);const employee=created.json().entity,path=base+'/entities/'+employee.id;
 assert.equal((await f.call('GET',base+'/recent-conversations',undefined,owner.cookie)).statusCode,503,'a newly authenticated platform actor awaiting its first identity update is not falsely logged out');
 await f.poll();let status=await f.call('GET',path+'/runtime-status',undefined,owner.cookie);assert.equal(status.statusCode,200,status.body);assert.equal(status.json().configuration.ready,true);assert.equal(status.json().employee.interaction.configured,false);assert.deepEqual(status.json().employee.channels,[]);
 assert.equal((await f.call('GET',path+'/runtime-status',undefined,other.cookie)).statusCode,403);
 assert.equal((await f.r.inject({url:base+'/chat-employees',headers:{'x-dentity-actor':owner.user.id}})).statusCode,401);
 assert.equal((await f.call('GET',base+'/chat-employees',undefined,other.cookie,{'x-dentity-actor':owner.user.id})).statusCode,403,'platform derives actor from authenticated cookie');
 assert.equal((await f.call('GET',base+'/recent-conversations',undefined,owner.cookie)).statusCode,200);
 assert.equal((await f.call('POST',path+'/conversations',{operationId:'no-model'},owner.cookie)).statusCode,409,'no model never succeeds');
 const platformDb=new DatabaseSync(join(f.root,'platform','platform.sqlite'),{readOnly:true}),runtimeDb=new DatabaseSync(join(f.root,'runtime','runtime.sqlite'),{readOnly:true});t.after(()=>{platformDb.close();runtimeDb.close();});
 const names=db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
 assert.ok(!names(platformDb).includes('tasks'));assert.ok(!names(runtimeDb).includes('users'));assert.ok(!names(runtimeDb).includes('model_catalog'));assert.ok(names(runtimeDb).includes('channel_inbox'));assert.equal(runtimeDb.prepare('SELECT count(*) n FROM tasks').get().n,0);
 assert.equal((await f.call('GET',base+'/recent-conversations')).statusCode,401,'anonymous proxy returns authentication failure');
 assert.equal((await f.r.inject({url:base+'/resources/skills',headers:{authorization:'Bearer '+serviceToken,'x-dentity-actor':owner.user.id}})).statusCode,404,'runtime does not host platform resource management');
 assert.equal((await f.p.inject({url:'/internal/config/snapshot'})).statusCode,401);assert.equal((await f.p.inject({method:'POST',url:'/internal/runtime/model',headers:{origin},payload:{}})).statusCode,404,'PI resolver absent on platform');
});
test('runtime first configuration failure remains unready, later empty snapshot is ready and observation failure is not missing config',async t=>{
 const f=await fixture(t,{offline:true});assert.equal((await f.r.inject({url:'/readyz'})).statusCode,503);f.setDown(false);await f.poll();assert.equal((await f.r.inject({url:'/readyz'})).statusCode,200);
 const owner=await f.register('recover-owner'),base='/api/workspaces/'+owner.workspace.id;const e=(await f.call('POST',base+'/entities',{name:'Observed',ownWebUse:true},owner.cookie)).json().entity;await f.poll();f.setDown(true);await f.poll();assert.equal((await f.r.inject({url:'/readyz'})).statusCode,200,'valid recent snapshot retained');
 const observed=await f.call('GET',base+'/entities/'+e.id+'/runtime-status',undefined,owner.cookie);assert.equal(observed.json().configuration.ready,true);assert.equal(observed.json().error,'configuration_unavailable');
});
test('new poll applies changed permissions and employee lifecycle without sharing databases',async t=>{
 const f=await fixture(t),owner=await f.register('poll-owner'),member=await f.register('poll-member'),base='/api/workspaces/'+owner.workspace.id;
 const invite=(await f.call('POST',base+'/invitations',{},owner.cookie)).json();await f.call('POST','/api/invitations/accept',{token:invite.token},member.cookie);
 const e=(await f.call('POST',base+'/entities',{name:'Initial name',ownWebUse:true},owner.cookie)).json().entity;await f.poll();const path=base+'/entities/'+e.id;
 let list=await f.call('GET',base+'/chat-employees',undefined,member.cookie);assert.equal(list.statusCode,200,list.body);assert.equal(list.json().entities.length,0);
 const p=(await f.call('GET',path+'/web-access',undefined,owner.cookie));assert.equal(p.statusCode,200,p.body);
 const db=new DatabaseSync(join(f.root,'platform','platform.sqlite'));const memberId=db.prepare('SELECT id FROM members WHERE workspace_id=? AND user_id=?').get(owner.workspace.id,member.user.id).id;
 const updated=await f.call('PUT',path+'/web-access',{allowMemberIds:[memberId],denyMemberIds:[]},owner.cookie);assert.equal(updated.statusCode,200,updated.body);await f.poll();list=await f.call('GET',base+'/chat-employees',undefined,member.cookie);assert.equal(list.json().entities.length,1,list.body);
 db.close();
});

test('split runtime preserves durable conversation JSONL, task/Run mapping and accepted dispatch across restart',async t=>{
 let calls=0,service,dispatches=0,eventPolls=0;
 const f=await fixture(t,{runtimeOptions:{pollIntervalMs:10,onService:s=>service=s,modelClient:{async complete(input){calls++;return input.messages.at(-1).role==='tool'?{text:'Task recorded in isolated runtime.',usage:{inputTokens:2,outputTokens:2}}:{toolCalls:[{id:'split-task-tool',name:'task_create',arguments:{input:'Authorized isolated background task'}}],usage:{inputTokens:2,outputTokens:2}};}},runtime:{idempotentDispatch:true,async dispatch(){dispatches++;return{status:'accepted'};},async events(){eventPolls++;return[];},async input(){return{status:'received'};},async cancel(){return{status:'confirmed'};}}}});
 const owner=await f.register('durable-split-owner'),base='/api/workspaces/'+owner.workspace.id;
 const e=(await f.call('POST',base+'/entities',{name:'Durable split',ownWebUse:true},owner.cookie)).json().entity;await f.poll();const path=base+'/entities/'+e.id;
 let response=await f.call('POST',path+'/conversations',{mode:'real'},owner.cookie);assert.equal(response.statusCode,201,response.body);const conv=response.json().conversation;
 response=await f.call('POST',path+'/conversations/'+conv.id+'/turns',{operationId:'split-first',text:'Please create the task'},owner.cookie);assert.equal(response.statusCode,202,response.body);const turn=response.json().turn;
 for(let n=0;n<300;n++){response=await f.call('GET',path+'/conversations/'+conv.id+'/turns/'+turn.id,undefined,owner.cookie);if(response.json().turn.status==='succeeded')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(response.json().turn.status,'succeeded',response.body);assert.equal(calls,2);
 response=await f.call('GET',path+'/conversations/'+conv.id+'/tasks',undefined,owner.cookie);assert.equal(response.statusCode,200,response.body);const task=response.json().tasks?.[0]??response.json().records?.[0];assert.ok(task,response.body);await service.tick();assert.equal(dispatches,1);
 const before=await f.call('GET',path+'/conversations/'+conv.id+'/messages',undefined,owner.cookie);assert.match(before.body,/Task recorded in isolated runtime/);
 f.setDown(true);await f.restart();assert.equal((await f.r.inject({url:'/readyz'})).statusCode,503);assert.equal((await f.call('GET',base+'/recent-conversations',undefined,owner.cookie)).statusCode,503,'first snapshot outage is service unavailability, not revoked login');
 const pollsWhilePaused=eventPolls;await new Promise(r=>setTimeout(r,40));assert.equal(eventPolls,pollsWhilePaused,'background scheduler cannot poll admitted executions with an absent first configuration');
 const pausedDb=new DatabaseSync(join(f.root,'runtime','runtime.sqlite'),{readOnly:true});assert.equal(pausedDb.prepare("SELECT count(*) n FROM tasks WHERE status='failed'").get().n,0);pausedDb.close();
 f.setDown(false);await f.poll();await service.tick();assert.equal(dispatches,1,'accepted dispatch never resubmitted on restart');
 const after=await f.call('GET',path+'/conversations/'+conv.id+'/messages',undefined,owner.cookie);assert.deepEqual(after.json(),before.json(),'same authorized JSONL remains readable after restart');
 const repeated=await f.call('POST',path+'/conversations/'+conv.id+'/turns',{operationId:'split-first',text:'Please create the task'},owner.cookie);assert.equal(repeated.statusCode,202,repeated.body);assert.equal(repeated.json().turn.id,turn.id);assert.equal(calls,2);
});

test('real rule HTTP model uses runtime metadata checks and platform-only credential resolution, with no credential mirror',async t=>{
 const model=createRuleModel();await new Promise((resolve,reject)=>{model.once('error',reject);model.listen(0,'127.0.0.1',resolve);});t.after(()=>closeRuleModel(model));
 const masterKey=Buffer.alloc(32,11),f=await fixture(t,{platformOptions:{modelProfiles:{masterKey,allowLoopbackHttp:true}},runtimeOptions:{modelProfiles:{allowLoopbackHttp:true}}});
 const owner=await f.register('split-real-model'),base='/api/workspaces/'+owner.workspace.id,e=(await f.call('POST',base+'/entities',{name:'Real split model',ownWebUse:true},owner.cookie)).json().entity,path=base+'/entities/'+e.id;
 const source=new Store(join(f.root,'platform','platform.sqlite'),{role:'platform'});const profile=new ModelProfileService(source,{masterKey,allowLoopbackHttp:true}).save(owner.workspace.id,e.id,{provider:'openai-compatible',endpoint:'http://127.0.0.1:'+model.address().port+'/v1',modelId:'mock',apiKey:'identity-local-test-token'});source.close();await f.poll();
 const status=await f.call('GET',path+'/runtime-status',undefined,owner.cookie);assert.equal(status.json().employee.interaction.configured,true,status.body);assert.equal(status.json().employee.interaction.available,true,status.body);
 const conversation=await f.call('POST',path+'/conversations',{mode:'real'},owner.cookie);assert.equal(conversation.statusCode,201,conversation.body);const c=conversation.json().conversation;
 const response=await f.call('POST',path+'/conversations/'+c.id+'/turns',{operationId:'real-greeting',text:'你好'},owner.cookie);assert.equal(response.statusCode,202,response.body);const id=response.json().turn.id;let result;
 for(let n=0;n<300;n++){result=await f.call('GET',path+'/conversations/'+c.id+'/turns/'+id,undefined,owner.cookie);if(['succeeded','failed','unknown'].includes(result.json().turn.status))break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(result.json().turn.status,'succeeded',result.body);assert.equal(result.json().turn.text,'你好。我可以帮你做什么');
 const locator=await f.call('GET',path+'/conversations/'+c.id+'/locator',undefined,owner.cookie);assert.equal(locator.statusCode,200,locator.body);assert.equal(locator.json().ownerService,'interaction-task');assert.match(locator.json().relativePath,/^[a-f0-9]+\/current.jsonl$/);assert.equal((await f.r.inject({url:path+'/conversations/'+c.id+'/locator',headers:{'x-dentity-actor':owner.user.id}})).statusCode,401);
 const revoked=await f.call('POST',base+'/model-profiles/'+profile.id+'/revoke',{},owner.cookie);assert.equal(revoked.statusCode,200,revoked.body);await f.poll();assert.equal((await f.call('POST',path+'/conversations/'+c.id+'/turns',{operationId:'after-revoke',text:'你好'},owner.cookie)).statusCode,409);assert.equal((await f.call('GET',path+'/conversations/'+c.id+'/messages',undefined,owner.cookie)).statusCode,200);
});

test('platform proxy preserves list filters and opaque recent-conversation cursors across pages',async t=>{
 const f=await fixture(t,{runtimeOptions:{modelClient:{async complete(){throw Error('This fixture never calls inference');}}}}),owner=await f.register('split-page-owner'),base='/api/workspaces/'+owner.workspace.id;
 const employees=[];for(const name of['First contact','Second contact']){const e=(await f.call('POST',base+'/entities',{name,ownWebUse:true},owner.cookie)).json().entity;employees.push(e);await f.poll();const c=await f.call('POST',base+'/entities/'+e.id+'/conversations',{mode:'real'},owner.cookie);assert.equal(c.statusCode,201,c.body);}
 const first=await f.call('GET',base+'/recent-conversations?limit=1',undefined,owner.cookie);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().records.length,1);assert.ok(first.json().nextCursor,first.body);
 const second=await f.call('GET',base+'/recent-conversations?limit=1&cursor='+encodeURIComponent(first.json().nextCursor),undefined,owner.cookie);assert.equal(second.statusCode,200,second.body);assert.equal(second.json().records.length,1);assert.notEqual(second.json().records[0].conversation.id,first.json().records[0].conversation.id);assert.equal(second.json().nextCursor,null);
 const available=await f.call('GET',base+'/chat-employees?unusedFilter=1',undefined,owner.cookie);assert.equal(available.statusCode,200,available.body);
 const conversations=await f.call('GET',base+'/entities/'+employees[0].id+'/conversations?unusedFilter=1',undefined,owner.cookie);assert.equal(conversations.statusCode,200,conversations.body);
});

test('new employee conversation reports a known configuration sync window, then opens once; missing and forbidden remain hard errors',async t=>{const f=await fixture(t,{runtimeOptions:{modelClient:{async complete(){assert.fail('Opening conversation must not invoke the model');}}}}),owner=await f.register('opening-owner'),base='/api/workspaces/'+owner.workspace.id;const create=async(name,ownWebUse=true)=>(await f.call('POST',base+'/entities',{name,ownWebUse},owner.cookie)).json().entity;const first=await create('New identity and employee'),path=base+'/entities/'+first.id+'/conversations';let response=await f.call('POST',path,{mode:'real'},owner.cookie);assert.equal(response.statusCode,503,response.body);assert.equal(response.json().error,'employee_configuration_pending');assert.equal(response.headers['retry-after'],'1');await f.poll();response=await f.call('POST',path,{mode:'real'},owner.cookie);assert.equal(response.statusCode,201,response.body);const id=response.json().conversation.id;assert.equal((await f.call('POST',path,{mode:'real'},owner.cookie)).json().conversation.id,id,'known retries preserve the one continuous conversation');const second=await create('New entity after identity applied');response=await f.call('POST',base+'/entities/'+second.id+'/conversations',{mode:'real'},owner.cookie);assert.equal(response.statusCode,503,response.body);assert.equal(response.json().error,'employee_configuration_pending');await f.poll();assert.equal((await f.call('POST',base+'/entities/'+second.id+'/conversations',{mode:'real'},owner.cookie)).statusCode,201);response=await f.call('POST',base+'/entities/missing/conversations',{mode:'real'},owner.cookie);assert.equal(response.statusCode,404,response.body);assert.equal(response.json().error,'entity_not_found');const denied=await create('No employee use',false);await f.poll();response=await f.call('POST',base+'/entities/'+denied.id+'/conversations',{mode:'real'},owner.cookie);assert.equal(response.statusCode,403,response.body);assert.notEqual(response.json().error,'employee_configuration_pending');const outsider=await f.register('opening-outsider');assert.equal((await f.call('POST',path,{mode:'real'},outsider.cookie)).statusCode,403);const db=new DatabaseSync(join(f.root,'runtime','runtime.sqlite'));assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n,2);assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,0);db.close();});

test('human retry POST is manager-authorized and relayed with safe runtime business errors',async t=>{const f=await fixture(t),owner=await f.register('human-retry-split-owner'),other=await f.register('human-retry-split-other');await f.poll();const url='/api/workspaces/'+owner.workspace.id+'/work-items/pending-human/missing/retry';let res=await f.call('POST',url,{expectedUpdatedAt:1,expectedNotificationStatus:'blocked'},owner.cookie);assert.equal(res.statusCode,404,res.body);assert.equal(res.json().error,'human_request_not_found');res=await f.call('POST',url,{expectedUpdatedAt:1,expectedNotificationStatus:'blocked'},other.cookie);assert.equal(res.statusCode,403,res.body);assert.notEqual(res.json().error,'notification_groups_unavailable');});

test('WeCom verification readiness requires service auth, the exact synchronized challenge and connected receiver',async t=>{
 const {ingressFixture}=await import('./helpers/ingress-fixture.mjs'),{EmployeeChannelRepository}=await import('../dist/employee-channels/repository.js'),{DirectoryCredentialVault}=await import('../dist/directory/secrets.js');
 const ingress=ingressFixture(),masterKey=Buffer.alloc(32,29),f=await fixture(t,{platformOptions:{modelProfiles:{masterKey},employeeChannels:{masterKey}},runtimeOptions:{channelIngressFactory:ingress.factory}});
 const owner=await f.register('wecom-proof-ready-owner'),workspaceId=owner.workspace.id;
 const response=await f.call('POST',`/api/workspaces/${workspaceId}/entities`,{name:'Proof employee',ownWebUse:true},owner.cookie),entityId=response.json().entity.id;
 const now=Date.now(),requestId='77777777-7777-4777-8777-777777777777',record={id:'proof-connection',sourceId:'proof-source',workspaceId,entityId,provider:'wecom',appId:'proof-bot',identity:{appId:'proof-bot',tenantId:'proof-bot',tenantIdNamespace:'app_id'},botId:'proof-bot',eventTenantId:'proof-bot',revision:2,authRevision:1,stateVersion:0,status:'verified',enabled:true,inboundVerified:true,directoryStatus:'unavailable',lastError:null,createdBy:owner.user.id,updatedBy:owner.user.id,wecomMemberChallenges:[{requestId,userId:'proof-user',authRevision:1,phraseHash:'d'.repeat(64),createdAt:now,expiresAt:now+86400000,issuedAt:now,status:'pending',method:'administrator_relay',createdBy:'manager'}]};
 record.credential=new DirectoryCredentialVault(masterKey).seal(JSON.stringify({appSecret:'Synthetic-isolated-proof-secret'}),[workspaceId,entityId,record.id,record.appId,record.authRevision]);
 const seed=new Store(join(f.root,'platform','platform.sqlite'),{role:'platform'});try{assert.equal(new EmployeeChannelRepository(seed).save(record),true);}finally{seed.close();}
 const url='/internal/control/wecom-member-verification-ready',payload={connectionId:record.id,sourceId:record.sourceId,authRevision:record.authRevision,stateVersion:record.stateVersion,requestId},headers={authorization:'Bearer '+serviceToken};
 assert.equal((await f.r.inject({method:'POST',url,payload})).statusCode,401);
 assert.equal((await f.r.inject({method:'POST',url,payload,headers})).json().ready,false);
 await f.poll();const live=await ingress.current(record.id);
 assert.equal((await f.r.inject({method:'POST',url,payload,headers})).json().ready,true);
 for(const patch of [{sourceId:'different'},{authRevision:2},{stateVersion:record.stateVersion+1},{requestId:'different'}])assert.equal((await f.r.inject({method:'POST',url,payload:{...payload,...patch},headers})).json().ready,false);
 live.sink.onStatus({state:'reconnecting',changedAt:Date.now()});assert.equal((await f.r.inject({method:'POST',url,payload,headers})).json().ready,false);
});
