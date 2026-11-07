import test from'node:test';import assert from'node:assert/strict';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import Fastify from'fastify';
import{Store}from'../dist/store.js';import{CapabilityConfigService}from'../dist/capability-config.js';import{EmployeeChannelService,channelSubject}from'../dist/employee-channels/service.js';import{EmployeeChannelRepository}from'../dist/employee-channels/repository.js';import{registerHumanConfiguration}from'../dist/human-configuration.js';
const known=value=>({status:'known',value}),unknown={status:'unknown'};
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'human-use-')),store=new Store(join(dir,'test.sqlite'));
 store.db.exec("INSERT INTO users VALUES('u','owner','Owner','active'),('guest','guest','Member','active');INSERT INTO workspaces VALUES('w','QA','u','active');INSERT INTO members VALUES('m','w','u','owner','active'),('g','w','guest','member','active');INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime)VALUES('e','w','QA','m','m',1,'u','builtin-interaction')");
 const person={id:{id:'person',namespace:'open_id',applicationId:'app'},displayName:'Synthetic confirmer',status:'active',departmentIds:['child'],departmentMembershipsKnown:true,aliases:[],primaryDepartmentId:known('child'),directManager:unknown,dottedLineManagers:unknown};
 const state={active:true,unknown:false,gate:undefined};
 const channels=new EmployeeChannelService(new EmployeeChannelRepository(store),{masterKey:new Uint8Array(32).fill(17),verifyApplication:async()=>({identity:{appId:'app',tenantId:'tenant',tenantIdNamespace:'tenant_key'},botId:'bot',eventTenantId:'tenant',directoryStatus:'available'}),adapterFactory:()=>({provider:'feishu',capabilities:{},verify:async()=>({appId:'app',tenantId:'tenant',tenantIdNamespace:'tenant_key'}),getUser:async id=>{await state.gate?.();return{...person,id,status:state.active?'active':'inactive',departmentMembershipsKnown:!state.unknown};},getDepartment:async id=>({id,namespace:'open_department_id',displayName:id,parentId:state.unknown?unknown:known(id==='child'?'root':null),leaders:unknown})})});
 const capabilities=new CapabilityConfigService(store,[],channels);channels.setAccessCheck((...args)=>capabilities.authorizeChannel(...args));const c=await channels.save('w','e','feishu','u',{appId:'app',appSecret:'synthetic-only-not-real',expectedRevision:0});
 store.db.exec('CREATE TABLE directory_sync_tasks(id TEXT PRIMARY KEY,workspace_id TEXT,connection_id TEXT,invalidated INTEGER);CREATE TABLE directory_snapshot_users(task_id TEXT,person_json TEXT)');store.run('INSERT INTO directory_sync_tasks VALUES(?,?,?,0)','snapshot','w',c.id);store.run('INSERT INTO directory_snapshot_users VALUES(?,?)','snapshot',JSON.stringify(person));
 const app=Fastify();app.setErrorHandler((error,_r,reply)=>reply.code(error.status??error.statusCode??500).send({error:error.code??error.message}));registerHumanConfiguration(app,store,channels,()=>{},capabilities);await app.ready();t.after(async()=>{await app.close();capabilities.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const url='/api/workspaces/w/entities/e/human-confirmation',call=(rules,expectedVersion=0)=>app.inject({method:'PUT',url,payload:{expectedVersion,rules}}),rule={questionScope:'*',target:{kind:'channel',connectionId:c.id,userId:'person',identityNamespace:'open_id',provider:'feishu',appId:'app',tenantId:'tenant'}};
 const allow=(kind='channel_user',subject='person',conversationKinds=['private'])=>({sourceId:c.sourceId,kind,subjectId:channelSubject(kind,subject,kind==='department'?'open_department_id':'open_id','app'),...(kind==='department'?{includeDescendants:true}:{}),conversationKinds});
 return{store,capabilities,channels,c,person,state,app,url,call,rule,allow};
}
test('Web confirmer save requires actual employee use, honors deny and active membership, and does not alter usage rules',async t=>{
 const f=await fixture(t),web={questionScope:'*',target:{kind:'web',userId:'guest'}};
 assert.equal((await f.call([web])).statusCode,403);assert.equal(f.store.one('SELECT count(*) n FROM employee_human_rules').n,0);
 f.capabilities.saveWebAccess('w','e',{allowWorkspaceMembers:true,allowMemberIds:[],denyMemberIds:[]});assert.equal((await f.call([web])).statusCode,200);
 f.capabilities.saveWebAccess('w','e',{allowWorkspaceMembers:true,allowMemberIds:[],denyMemberIds:['g']});assert.equal((await f.call([web],1)).statusCode,403);assert.equal(f.store.one('SELECT version FROM employee_human_rules').version,1);
 f.capabilities.saveWebAccess('w','e',{allowWorkspaceMembers:true,allowMemberIds:[],denyMemberIds:[]});f.store.run("UPDATE members SET status='inactive' WHERE id='g'");assert.equal((await f.call([web],1)).statusCode,400,'inactive person is no longer a candidate');
});
test('directory visibility and group-only use cannot save a private confirmer; explicit private grant works and deny wins',async t=>{
 const f=await fixture(t);assert.equal((await f.app.inject({url:f.url})).json().candidates.some(x=>x.target.kind==='channel'),true);
 f.capabilities.saveDirectoryAccess('w','e',{allow:[],deny:[],allowGroupMembers:true});const denied=await f.call([f.rule]);assert.equal(denied.statusCode,403,denied.body);assert.equal(denied.json().error,'human_recipient_use_forbidden');
 f.capabilities.saveDirectoryAccess('w','e',{allow:[f.allow('channel_user','person',['group'])],deny:[],allowGroupMembers:true});assert.equal((await f.call([f.rule])).statusCode,403);
 f.capabilities.saveDirectoryAccess('w','e',{allow:[f.allow()],deny:[],allowGroupMembers:true});assert.equal((await f.call([f.rule])).statusCode,200);
 f.capabilities.saveDirectoryAccess('w','e',{allow:[f.allow()],deny:[f.allow()]});assert.equal((await f.call([f.rule],1)).statusCode,403);assert.equal(f.store.one('SELECT version FROM employee_human_rules').version,1);
});
test('department grant uses existing descendant/unknown semantics; cross application identity is not accepted',async t=>{
 const f=await fixture(t);f.capabilities.saveDirectoryAccess('w','e',{allow:[f.allow('department','root')],deny:[]});assert.equal((await f.call([f.rule])).statusCode,200);
 f.state.unknown=true;f.capabilities.invalidateAdmission('w','e');assert.equal((await f.call([f.rule],1)).statusCode,403);
 const forged={...f.rule,target:{...f.rule.target,appId:'another'}};assert.equal((await f.call([forged],1)).statusCode,400);
 assert.equal((await f.app.inject({method:'PUT',url:f.url.replace('/w/','/other/'),payload:{expectedVersion:0,rules:[f.rule]}})).statusCode,400);
});
test('one unauthorized rule rejects the entire save and permission changes during lookup do not persist stale rules',async t=>{
 const f=await fixture(t);f.capabilities.saveDirectoryAccess('w','e',{allow:[f.allow()],deny:[]});const unauthorizedWeb={questionScope:'other',target:{kind:'web',userId:'guest'}};assert.equal((await f.call([f.rule,unauthorizedWeb])).statusCode,403);assert.equal(f.store.one('SELECT count(*) n FROM employee_human_rules').n,0);
 f.capabilities.invalidateAdmission('w','e');let release;f.state.gate=()=>new Promise(r=>release=r);const pending=f.call([f.rule]);while(!release)await new Promise(r=>setImmediate(r));f.capabilities.saveDirectoryAccess('w','e',{allow:[],deny:[]});release();const response=await pending;assert.ok([403,409].includes(response.statusCode),response.body);assert.equal(f.store.one('SELECT count(*) n FROM employee_human_rules').n,0);
});
test('empty save can remove historical unauthorized rules without granting rights or canceling existing requests',async t=>{
 const f=await fixture(t);f.store.run('INSERT INTO employee_human_rules VALUES(?,?,?,?)','w','e',4,JSON.stringify([f.rule]));assert.equal((await f.call([f.rule],4)).statusCode,403);assert.equal((await f.call([],4)).statusCode,200);assert.equal(f.store.one('SELECT rules_json FROM employee_human_rules').rules_json,'[]');assert.deepEqual(f.capabilities.getDirectoryAccess('w','e').allow,[]);
});
