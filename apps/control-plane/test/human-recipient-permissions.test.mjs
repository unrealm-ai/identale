import test from'node:test';import assert from'node:assert/strict';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import Fastify from'fastify';
import{Store}from'../dist/store.js';import{CapabilityConfigService}from'../dist/capability-config.js';import{EmployeeChannelService,channelSubject}from'../dist/employee-channels/service.js';import{EmployeeChannelRepository}from'../dist/employee-channels/repository.js';import{registerHumanConfiguration}from'../dist/human-configuration.js';
const known=value=>({status:'known',value}),unknown={status:'unknown'};
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'human-use-')),store=new Store(join(dir,'test.sqlite'));
 store.db.exec("INSERT INTO users VALUES('u','owner','Owner','active'),('guest','guest','Member','active');INSERT INTO workspaces VALUES('w','QA','u','active');INSERT INTO members(id,workspace_id,user_id,role,status) VALUES('m','w','u','owner','active'),('g','w','guest','member','active');INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime)VALUES('e','w','QA','m','m',1,'u','builtin-interaction')");
 const person={id:{id:'person',namespace:'open_id',applicationId:'app'},displayName:'Synthetic confirmer',status:'active',departmentIds:['child'],departmentMembershipsKnown:true,aliases:[],primaryDepartmentId:known('child'),directManager:unknown,dottedLineManagers:unknown};
 const state={active:true,unknown:false,gate:undefined};
 const channels=new EmployeeChannelService(new EmployeeChannelRepository(store),{masterKey:new Uint8Array(32).fill(17),verifyApplication:async()=>({identity:{appId:'app',tenantId:'tenant',tenantIdNamespace:'tenant_key'},botId:'bot',eventTenantId:'tenant',directoryStatus:'available'}),adapterFactory:()=>({provider:'feishu',capabilities:{},verify:async()=>({appId:'app',tenantId:'tenant',tenantIdNamespace:'tenant_key'}),getUser:async id=>{await state.gate?.();return{...person,id,status:state.active?'active':'inactive',departmentMembershipsKnown:!state.unknown};},getDepartment:async id=>({id,namespace:'open_department_id',displayName:id,parentId:state.unknown?unknown:known(id==='child'?'root':null),leaders:unknown})})});
 const capabilities=new CapabilityConfigService(store,[],channels);channels.setAccessCheck((...args)=>capabilities.authorizeChannel(...args));const c=await channels.save('w','e','feishu','u',{appId:'app',appSecret:'synthetic-only-not-real',expectedRevision:0});
 store.run(`INSERT INTO directory_sync_tasks(id,workspace_id,connection_id,entity_id,entity_name,provider,app_id,source_version,invalidated) VALUES(?,?,?,'e','QA','feishu','app','fixture',0)`,'snapshot','w',c.id);store.run(`INSERT INTO directory_snapshot_users(task_id,external_id,person_json,namespace,aliases_json,last_access,observed_at) VALUES(?,?,?,'open_id','[]',0,0)`,'snapshot','person',JSON.stringify(person));
 // Local snapshot facts are the authorization source; adapter methods must never be used here.
 const localUser=id=>({...person,id,status:state.active?'active':'inactive',departmentMembershipsKnown:!state.unknown});
 channels.setDirectorySnapshots({query:connectionId=>({items:connectionId===c.id?[localUser(person.id)]:[],exhausted:true,snapshotVersion:1,task:{}}),directory:()=>({getUser:async id=>{await state.gate?.();return localUser(id);},getDepartment:async id=>({id,namespace:'open_department_id',displayName:id,parentId:state.unknown?unknown:known(id==='child'?'root':null),leaders:unknown})}),peekUser:(connectionId,id)=>connectionId===c.id&&id.id==='person'&&id.namespace==='open_id'&&id.applicationId==='app'?localUser(id):undefined});
 const app=Fastify();app.setErrorHandler((error,_r,reply)=>reply.code(error.status??error.statusCode??500).send({error:error.code??error.message}));registerHumanConfiguration(app,store,channels,()=>{},capabilities);await app.ready();t.after(async()=>{await app.close();await state.beforeClose?.();capabilities.close();store.close();rmSync(dir,{recursive:true,force:true});});
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

// Reuse the isolated service/store fixture. No real message or model calls.
async function wecomFixture(t){
 const f=await fixture(t),created=await f.channels.save('w','e','wecom','u',{appId:'synthetic-wecom',appSecret:'synthetic-only-not-real',expectedRevision:0});
 f.channels.observeFirstInbound(created.id,{appId:created.appId,botId:created.appId,tenantId:created.appId,tenantNamespace:'app_id'});
 const current=()=>f.channels.repository.byId(created.id);
 f.channels.botContacts.remember(current(),[{id:'search-person',displayName:'Searched Person',departmentPaths:['Engineering']},{id:'search-denied',displayName:'Other Person',departmentPaths:[]}]);
 const target=()=>( {kind:'wecom_directory',connectionId:created.id,provider:'wecom',appId:created.appId,tenantId:created.appId,sourceId:created.sourceId,authRevision:created.authRevision,directoryUserId:'search-person',identityNamespace:'user_id'} );
 const grant=(id='search-person')=>({sourceId:created.sourceId,kind:'channel_user',subjectId:channelSubject('channel_user',id,'user_id',created.appId),conversationKinds:['private']});
 const map=(userId='search-person',callbackUserId='callback-person')=>{const previous=current(),next={...previous,wecomContactIdentityRevision:previous.authRevision,wecomContactMappings:[...(previous.wecomContactMappings??[]).filter(x=>x.userId!==userId),{userId,callbackUserId,requestId:'synthetic-verification',verifiedAt:Date.now(),method:'administrator_relay'}]};assert.equal(f.channels.repository.save(next,previous),true);};
 return{...f,current,target,grant,map};
}

test('WeCom searched confirmer saves while pending, retains its stable choice, and GET never rewrites rules',async t=>{
 const f=await wecomFixture(t),target=f.target(),rule={questionScope:'*',target};
 const before=(await f.app.inject({url:f.url})).json(),candidate=before.candidates.find(x=>x.target.kind==='wecom_directory'&&x.target.directoryUserId==='search-person');
 assert.deepEqual(candidate.target,target);assert.equal(candidate.identityVerified,false);assert.equal(candidate.directorySubjectId,f.grant().subjectId);assert.equal('userId'in candidate.target,false);
 const saved=await f.call([rule]);assert.equal(saved.statusCode,200,saved.body);const persisted=f.store.one('SELECT * FROM employee_human_rules');
 f.store.run('UPDATE wecom_bot_contacts SET found_at=0');
 assert.deepEqual((await f.app.inject({url:f.url})).json().candidates.find(x=>x.target.directoryUserId==='search-person').target,target,'saved pending selection survives search expiry');
 f.map();const after=(await f.app.inject({url:f.url})).json();assert.equal(after.candidates.find(x=>x.target.directoryUserId==='search-person').identityVerified,true);assert.deepEqual(after.rules,[rule]);assert.deepEqual(f.store.one('SELECT * FROM employee_human_rules'),persisted);
 assert.equal((await f.call([rule],1)).statusCode,403,'binding alone does not grant employee use');
 f.store.run('UPDATE wecom_bot_contacts SET found_at=?',Date.now());f.capabilities.saveDirectoryAccess('w','e',{allow:[f.grant()],deny:[]});assert.equal((await f.call([rule],1)).statusCode,200);
});

test('pending WeCom rule save rejects invented recipients, foreign source/app/auth revision and manager denial',async t=>{
 const f=await wecomFixture(t),target=f.target();
 for(const changes of [{directoryUserId:'invented'},{connectionId:'other-bot'},{appId:'other-bot'},{sourceId:'other-source'},{authRevision:target.authRevision+1},{userId:'search-person'}])assert.equal((await f.call([{questionScope:'*',target:{...target,...changes}}])).statusCode,400);
 const app=Fastify();t.after(()=>app.close());registerHumanConfiguration(app,f.store,f.channels,()=>{throw Object.assign(Error('forbidden'),{statusCode:403});},f.capabilities);
 assert.equal((await app.inject({method:'PUT',url:f.url,payload:{expectedVersion:0,rules:[{questionScope:'*',target}]}})).statusCode,403);
 assert.equal(f.store.one('SELECT count(*) n FROM employee_human_rules').n,0);
});

test('WeCom directory target resolution fences source, credentials, robot and missing/ambiguous callback mappings',async t=>{
 const {resolveHumanTarget,authorizeHumanTarget}=await import('../dist/human-target.js'),f=await wecomFixture(t),target=f.target();
 assert.equal(resolveHumanTarget(f.channels,'w','e',target),undefined);assert.equal(await authorizeHumanTarget(f.channels,f.capabilities,'w','e',target),false);
 f.map();const resolved=resolveHumanTarget(f.channels,'w','e',target);assert.equal(resolved.kind,'channel');assert.equal(resolved.userId,'callback-person');assert.equal(resolved.directoryReference.directoryUserId,'search-person');
 for(const changed of [{sourceId:'other-source'},{authRevision:target.authRevision+1},{appId:'other-bot'},{tenantId:'other-tenant'},{connectionId:f.c.id}])assert.throws(()=>resolveHumanTarget(f.channels,'w','e',{...target,...changed}),{code:'human_recipient_configuration_changed'});
 assert.throws(()=>resolveHumanTarget(f.channels,'foreign','e',target),{code:'human_recipient_configuration_changed'});
 let previous=f.current();assert.throws(()=>f.channels.repository.save({...previous,wecomContactMappings:[...previous.wecomContactMappings,{userId:'search-person',callbackUserId:'conflicting-callback',requestId:'conflict',verifiedAt:Date.now(),method:'administrator_relay'}]},previous),/wecom_identity_binding_conflict/);
 assert.equal(resolveHumanTarget(f.channels,'w','e',target).userId,'callback-person','conflicting write rolls back');
 previous=f.current();assert.throws(()=>f.channels.repository.save({...previous,wecomContactMappings:[...previous.wecomContactMappings,{userId:'search-denied',callbackUserId:'callback-person',requestId:'reverse-conflict',verifiedAt:Date.now(),method:'administrator_relay'}]},previous),/UNIQUE constraint/);
 assert.equal(resolveHumanTarget(f.channels,'w','e',target).userId,'callback-person');
 await f.channels.revalidate('w','e','wecom','u',f.current().revision);assert.throws(()=>resolveHumanTarget(f.channels,'w','e',target),{code:'human_recipient_configuration_changed'});
});

async function pendingHuman(t){
 const {resolveHumanTarget,authorizeHumanTarget}=await import('../dist/human-target.js'),{HumanConfirmation}=await import('../dist/human-confirmation.js'),{HumanChannelNotifications}=await import('../dist/human-channel.js'),{SqliteMessageLoopRepository}=await import('../dist/channel-loop/repository.js'),{SqliteTaskRepository}=await import('../dist/adapters/sqlite/task-repository.js'),{createHash}=await import('node:crypto');
 const f=await wecomFixture(t),target=f.target(),rule={questionScope:'*',target};assert.equal((await f.call([rule])).statusCode,200);
 const tasks=new SqliteTaskRepository(f.store),now=Date.now(),scope={workspaceId:'w',entityId:'e',userId:'u',conversationId:null};tasks.insertPlannedTask('human-task',scope,'synthetic-op','hash','synthetic task','fresh','[]','[]',null,now);tasks.insertRun('human-run','human-task','human-session',now);tasks.startPlannedTask('human-task',1,'human-run','snapshot','[]',null,1,now);
 const human=new HumanConfirmation(f.store,{}),outbox=new SqliteMessageLoopRepository(f.store),notices=new HumanChannelNotifications(f.store,f.channels,outbox,Date.now,f.capabilities);f.state.beforeClose=()=>outbox.close();human.setChannels(notices);human.setRecipientRouting({resolve:(w,e,target)=>resolveHumanTarget(f.channels,w,e,target),authorize:(w,e,target)=>authorizeHumanTarget(f.channels,f.capabilities,w,e,target),choose:async()=>{throw Error('one recipient must not call model');}});
 const question={questionScope:'*',background:'Synthetic local regression',goal:'Confirm local task',knownFacts:[],questions:[{id:'answer',text:'Approve?',required:true,answerType:'text'}],completionCriteria:['Explicit answer'],proposedAction:'local output',impactScope:'isolated test',ifNotConfirmed:'wait'},row=f.store.one('SELECT * FROM tasks WHERE id=?','human-task'),checkpoint={requestId:'human-request',contentVersion:1,question,questionDigest:createHash('sha256').update(JSON.stringify(question)).digest('hex'),taskId:row.id,runId:row.run_id,sessionId:'human-session',configurationId:'fixed',inputRevision:1,safe:false};
 human.onEvent(row,{eventId:'request',runId:row.run_id,sequence:1,type:'human_request',human:checkpoint});
 return{...f,human,outbox,notices};
}

test('pending human confirmation queues nothing, then automatically resolves only the authenticated callback without resaving',async t=>{
 const f=await pendingHuman(t),stored=f.store.one('SELECT * FROM employee_human_rules');f.capabilities.patchDirectoryAccess('w','e',{sourceId:f.current().sourceId,expectedRevision:f.capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===f.current().sourceId).revision,mode:'all'});
 await assert.rejects(f.notices.prepare({workspaceId:'w',entityId:'e',requestId:'human-request',target:f.target(),text:'must not send'}),/human_recipient_identity_pending/);await f.human.tick();await f.human.tick();let request=f.store.one('SELECT * FROM human_requests');assert.equal(request.notification_status,'blocked');assert.equal(request.notification_error,'human_recipient_identity_pending');assert.equal(request.target_json,null);assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,0);
 f.capabilities.patchDirectoryAccess('w','e',{sourceId:f.current().sourceId,expectedRevision:f.capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===f.current().sourceId).revision,mode:'allowlist',allow:[f.grant()],deny:[]});f.map();await f.human.tick();await f.human.tick();request=f.store.one('SELECT * FROM human_requests');assert.equal(request.notification_status,'queued');assert.equal(JSON.parse(request.target_json).userId,'callback-person');
 const notice=f.store.one('SELECT * FROM human_channel_notices');assert.equal(JSON.parse(notice.target_json).conversation.privateRecipientId,'callback-person');assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,1);assert.deepEqual(f.store.one('SELECT * FROM employee_human_rules'),stored);
 const row={id:notice.id,scopeJson:notice.scope_json,targetJson:notice.target_json,text:notice.text,taskDeliveryId:null};f.notices.assert(row);
 f.capabilities.saveDirectoryAccess('w','e',{allow:[],deny:[]});assert.throws(()=>f.notices.assert(row),/human_recipient_permissions_changed/);
});

test('binding never grants confirmer use, unresolved deny stays blocked, and send failures are never auto-retried',async t=>{
 const f=await pendingHuman(t);await f.human.tick();f.map();await f.human.tick();assert.equal(f.store.one('SELECT notification_error FROM human_requests').notification_error,'human_recipient_use_forbidden');assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,0);
 const retry=()=>{const row=f.store.one('SELECT * FROM human_requests');return f.human.retryRecipient('w',row.request_id,{expectedUpdatedAt:row.updated_at,expectedNotificationStatus:row.notification_status});};
 f.capabilities.saveDirectoryAccess('w','e',{allow:[f.grant()],deny:[f.grant('search-denied')]});retry();await f.human.tick();assert.equal(f.store.one('SELECT notification_error FROM human_requests').notification_error,'human_recipient_use_forbidden');assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,0);
 f.capabilities.saveDirectoryAccess('w','e',{allow:[f.grant()],deny:[]});retry();await f.human.tick();assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,1);
 for(const status of ['unknown','failed']){f.store.run('UPDATE channel_message_receipts SET status=?,error=?',status,'send_'+status);f.store.run('UPDATE human_requests SET notification_status=?,notification_error=?',status,'send_'+status);await f.human.tick();assert.equal(f.store.one('SELECT notification_status FROM human_requests').notification_status,status);assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,1);}
});

test('queued directory recipient cannot survive source/auth replacement or mapping removal',async t=>{
 for(const change of ['mapping','source','auth']){const f=await pendingHuman(t);f.capabilities.saveDirectoryAccess('w','e',{allow:[f.grant()],deny:[]});f.map();await f.human.tick();const notice=f.store.one('SELECT * FROM human_channel_notices'),row={id:notice.id,scopeJson:notice.scope_json,targetJson:notice.target_json,text:notice.text,taskDeliveryId:null},previous=f.current();
  f.channels.repository.save({...previous,...(change==='mapping'?{wecomContactMappings:[]} :change==='source'?{sourceId:'replacement-source'}:{authRevision:previous.authRevision+1})},previous);
  assert.throws(()=>f.notices.assert(row),{code:'human_recipient_configuration_changed'});
 }
});

// Reuse the existing local rule-model HTTP fixture and real routing/permission/outbox services.
async function independentWecomConfirmers(t){
 const {resolveHumanTarget,authorizeHumanTarget}=await import('../dist/human-target.js'),{HumanConfirmation}=await import('../dist/human-confirmation.js'),{HumanChannelNotifications}=await import('../dist/human-channel.js'),{createRecipientChoice,recipientCandidate}=await import('../dist/human-recipient-router.js'),{SqliteMessageLoopRepository}=await import('../dist/channel-loop/repository.js'),{SqliteTaskRepository}=await import('../dist/adapters/sqlite/task-repository.js'),{createHash}=await import('node:crypto'),{OpenAICompatibleModelClient}=await import('@dentity/runtime-builtin'),{createServer,closeServer,DEFAULT_TOKEN}=await import('../../mock-model/dist/server.js');
 const f=await wecomFixture(t),rules=[{questionScope:'first-question',target:f.target()},{questionScope:'second-question',target:{...f.target(),directoryUserId:'search-denied'}}];
 f.map();f.capabilities.saveDirectoryAccess('w','e',{allow:[f.grant(),f.grant('search-denied')],deny:[]});const saved=await f.call(rules);assert.equal(saved.statusCode,200,saved.body);
 const selections=[],model=createServer({observe:(request,rule)=>selections.push({request,rule})});await new Promise((resolve,reject)=>{model.once('error',reject);model.listen(0,'127.0.0.1',resolve);});t.after(()=>closeServer(model));
 const client=new OpenAICompatibleModelClient({endpoint:`http://127.0.0.1:${model.address().port}/v1`,model:'mock',secretRef:'synthetic',allowLoopbackHttp:true},async()=>DEFAULT_TOKEN),human=new HumanConfirmation(f.store,{}),outbox=new SqliteMessageLoopRepository(f.store),notices=new HumanChannelNotifications(f.store,f.channels,outbox,Date.now,f.capabilities),tasks=new SqliteTaskRepository(f.store);
 const routing={resolve:(w,e,target)=>resolveHumanTarget(f.channels,w,e,target),authorize:(w,e,target)=>authorizeHumanTarget(f.channels,f.capabilities,w,e,target),choose:createRecipientChoice(async()=>({client,model:'mock',revision:'local-rule-model'}))};
 f.state.beforeClose=()=>outbox.close();human.setChannels(notices);human.setRecipientRouting(routing);
 // Put B first to prove its pending identity cannot stall the independent A request.
 for(const questionScope of ['second-question','first-question']){
  const now=Date.now(),taskId='task-'+questionScope,runId='run-'+questionScope,sessionId='session-'+questionScope,scope={workspaceId:'w',entityId:'e',userId:'u',conversationId:null};
  tasks.insertPlannedTask(taskId,scope,'op-'+questionScope,'hash','synthetic task','fresh','[]','[]',null,now);tasks.insertRun(runId,taskId,sessionId,now);tasks.startPlannedTask(taskId,1,runId,'snapshot','[]',null,1,now);
  const question={questionScope,background:'Isolated local regression',goal:'Confirm '+questionScope,knownFacts:[],questions:[{id:'answer',text:'Approve?',required:true,answerType:'text'}],completionCriteria:['Explicit answer'],proposedAction:'local output',impactScope:'isolated test',ifNotConfirmed:'wait'},row=f.store.one('SELECT * FROM tasks WHERE id=?',taskId),checkpoint={requestId:questionScope,contentVersion:1,question,questionDigest:createHash('sha256').update(JSON.stringify(question)).digest('hex'),taskId,runId,sessionId,configurationId:'fixed',inputRevision:1,safe:false};
  human.onEvent(row,{eventId:'request-'+questionScope,runId,sequence:1,type:'human_request',human:checkpoint});
 }
 return{...f,human,outbox,notices,routing,selections,rules,candidateId:index=>recipientCandidate(rules[index].questionScope,rules[index].target).candidateId,request:id=>f.store.one('SELECT * FROM human_requests WHERE request_id=?',id)};
}

test('independent WeCom question scopes select A immediately and wait only for B, then queue B once without rerouting',async t=>{
 const f=await independentWecomConfirmers(t),configured=f.store.one('SELECT * FROM employee_human_rules');await f.human.tick();
 const a=f.request('first-question'),b=f.request('second-question');assert.equal(a.notification_status,'queued');assert.equal(JSON.parse(a.target_json).userId,'callback-person');assert.equal(b.notification_status,'blocked');assert.equal(b.notification_error,'human_recipient_identity_pending');assert.equal(b.target_json,null);
 assert.equal(JSON.parse(b.selection_json).candidateId,f.candidateId(1));assert.equal(f.selections.length,2);assert.ok(f.selections.every(x=>x.rule==='interaction.recipient-choice'));assert.ok(f.selections.every(x=>JSON.parse(x.request.messages.findLast(m=>m.role==='user').content).candidates.length===2));assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,1);
 const {HumanConfirmation}=await import('../dist/human-confirmation.js');f.human=new HumanConfirmation(f.store,{});f.human.setChannels(f.notices);f.human.setRecipientRouting(f.routing);
 await f.human.tick();assert.equal(f.selections.length,2,'identity waiting survives coordinator restart without invoking the selector');assert.equal(JSON.parse(f.request('second-question').selection_json).candidateId,f.candidateId(1));assert.deepEqual(f.request('first-question'),a);
 f.map('search-denied','callback-second');await f.human.tick();await f.human.tick();const resolved=f.request('second-question');assert.equal(resolved.notification_status,'queued');assert.equal(JSON.parse(resolved.target_json).userId,'callback-second');assert.equal(JSON.parse(resolved.selection_json).candidateId,f.candidateId(1));assert.equal(f.selections.length,2,'the original selected B is resumed, not chosen again');
 assert.deepEqual(f.store.all('SELECT request_id,json_extract(target_json,\'$.conversation.privateRecipientId\') recipient FROM human_channel_notices ORDER BY request_id').map(x=>({...x})),[{request_id:'first-question',recipient:'callback-person'},{request_id:'second-question',recipient:'callback-second'}]);assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,2);assert.deepEqual(f.request('first-question'),a);assert.deepEqual(f.store.one('SELECT * FROM employee_human_rules'),configured);
 for(const status of ['unknown','failed']){f.store.run('UPDATE channel_message_receipts SET status=?,error=? WHERE id=?',status,'send_'+status,'human-question:second-question');f.store.run('UPDATE human_requests SET notification_status=?,notification_error=? WHERE request_id=?',status,'send_'+status,'second-question');await f.human.tick();assert.equal(f.request('second-question').notification_status,status);assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,2);assert.equal(f.selections.length,2);}
});

test('a selected pending confirmer rechecks its own current use and never falls back to A after revocation or rule replacement',async t=>{
 for(const change of ['revoked','replaced']){
  const f=await independentWecomConfirmers(t);await f.human.tick();assert.equal(f.request('second-question').notification_error,'human_recipient_identity_pending');
  if(change==='revoked')f.capabilities.saveDirectoryAccess('w','e',{allow:[f.grant()],deny:[]});else{const saved=await f.call([f.rules[0],{...f.rules[1],target:f.rules[0].target}],1);assert.equal(saved.statusCode,200,saved.body);}
  f.map('search-denied','callback-second');await f.human.tick();await f.human.tick();const b=f.request('second-question');assert.equal(b.notification_status,'blocked');assert.equal(b.notification_error,change==='revoked'?'human_recipient_use_forbidden':'human_recipient_configuration_changed');assert.equal(b.target_json,null);assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,1);assert.equal(f.selections.length,2);
 }
});

test('routing never substitutes A when configured B is already bound but forbidden or has a stale identity reference',async t=>{
 for(const change of ['forbidden','stale']){
  const f=await independentWecomConfirmers(t);f.map('search-denied','callback-second');
  if(change==='forbidden')f.capabilities.saveDirectoryAccess('w','e',{allow:[f.grant()],deny:[]});else f.store.run('UPDATE employee_human_rules SET rules_json=?',JSON.stringify([f.rules[0],{...f.rules[1],target:{...f.rules[1].target,authRevision:f.rules[1].target.authRevision+1}}]));
  await f.human.tick();await f.human.tick();const a=f.request('first-question'),b=f.request('second-question');assert.equal(a.notification_status,'queued');assert.equal(JSON.parse(a.target_json).userId,'callback-person');assert.equal(b.notification_status,'blocked');assert.equal(b.notification_error,change==='forbidden'?'human_recipient_use_forbidden':'human_recipient_configuration_changed');assert.equal(b.target_json,null);assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,1);assert.equal(f.selections.length,2);
 }
});
