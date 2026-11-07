import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {JsonlJournal} from '@dentity/runtime-builtin';
import {createServer} from '../dist/server.js';
import {Store} from '../dist/store.js';
import {createJournalIndex} from '../dist/adapters/sqlite/journal-index.js';
const origin='http://127.0.0.1:5173';
class MockRuntime {
  idempotentDispatch=true; commands=[]; stream=[]; receipts=new Map(); failOnce=false;
  capabilities(runId){return {runId,runtimeId:'fixture',runtimeVersion:'1',bindingVersion:'fixture-v1',observedAt:1800000000000,expiresAt:1900000000000,appendInput:'supported',cancel:'supported'};}
  async dispatch(command) { this.commands.push(command);if(this.failOnce){this.failOnce=false;throw Error('Synthetic transport failure');}this.receipts.set(command.operationId,command);return {status:'accepted'}; }
  async input(){return {status:'received'};}
  async cancel(){return {status:'unknown'};}
  async events(runId,after){return this.stream.filter(e=>e.runId===runId&&e.sequence>after);}
}
async function setup(t, configured=true, extraOptions={}){
  const dir=await mkdtemp(join(tmpdir(),'dentity-tasks-'));const databasePath=join(dir,'tasks.sqlite');let service,journalStore;let now=1800000000000;
  const runtime=new MockRuntime();const app=createServer({databasePath,origin,modelClient:{async complete(){throw Error('Task state-machine tests must not invoke a model');}},now:()=>now,pollIntervalMs:0,onService:s=>service=s,...(configured?{runtime}:{}),...extraOptions});await app.ready();
  const db=new DatabaseSync(databasePath);t.after(async()=>{await app.close();db.close();journalStore?.close();await rm(dir,{recursive:true,force:true});});
  let conversation;
  const call=(method,url,payload,cookie)=>{const located=/\/tasks(?:[/?]|$)/.test(url)&&!url.includes('/conversations/')&&conversation?.id&&!url.includes('conversationId=')?`${url}${url.includes('?')?'&':'?'}conversationId=${encodeURIComponent(payload?.conversationId??conversation.id)}`:url;return app.inject({method,url:located,...(payload===undefined?{}:{payload}),headers:{origin,...(cookie?{cookie}:{})}});};
  const reg=await call('POST','/api/auth/register',{username:'task-user',password:'Synthetic task test password 2026!'});assert.equal(reg.statusCode,201,reg.body);const user=reg.json(),cookie=reg.headers['set-cookie'].split(';')[0];
  const entity=(await call('POST',`/api/workspaces/${user.workspace.id}/entities`,{name:'Task employee',ownWebUse:true},cookie)).json().entity;
  const base=`/api/workspaces/${user.workspace.id}/entities/${entity.id}`;
  conversation=(await call('POST',base+'/conversations',{operationId:'conversation-one',mode:'real'},cookie)).json().conversation;
  const create=(operationId='create-one',extra={})=>call('POST',base+'/tasks',{operationId,conversationId:conversation.id,input:'Synthetic task',contextMode:'new',...extra},cookie);
  // Out-of-band synthetic history must use the same indexed format and SQLite
  // connection for payload publication as the real adapter; legacy seeding is rejected.
  journalStore=new Store(databasePath);
  const journal=new JsonlJournal({root:join(dir,'builtin-records'),ownerId:JSON.stringify([journalStore.databaseId,databasePath]),serialize:fn=>journalStore.transaction(fn),index:createJournalIndex(journalStore)});
  const seedMessage=(id,c,role,text,created,simulated,expires)=>{const conv=db.prepare('SELECT * FROM conversations WHERE id=?').get(c);const ref=journal.put({workspaceId:conv.workspace_id,entityId:conv.entity_id,conversationId:c},'text',text);db.prepare('INSERT INTO conversation_message_index(id,conversation_id,role,record_ref,created_at,simulated,expires_at) VALUES(?,?,?,?,?,?,?)').run(id,c,role,JSON.stringify(ref),created,simulated,expires);};
  return {seedMessage,databasePath,db,app,call,user,cookie,entity,base,conversation,create,runtime,get service(){return service;},advance:ms=>now+=ms};
}
test('task create is durable, idempotent, conflict-safe and authenticates requester',async t=>{
  const s=await setup(t);const response=await s.create();assert.equal(response.statusCode,202,response.body);const task=response.json().task;assert.equal(task.status,'queued');assert.equal(s.runtime.commands.length,0);
  assert.equal((await s.create()).json().task.id,task.id);assert.equal((await s.create('create-one',{input:'different'})).statusCode,409);
  assert.equal((await s.create('forged',{requester:{userId:'other'}})).statusCode,400);
  await s.service.tick();assert.equal(s.runtime.commands.length,1);assert.deepEqual(s.runtime.commands[0].requester,{channelType:'web',tenantId:s.user.workspace.id,identityNamespace:'platform-user',externalUserId:s.user.user.id});
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n,1);assert.equal((await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task.status,'running');
});
test('progress, result and terminal confirmation remain separate; duplicate and ordered events persist once',async t=>{
  const s=await setup(t);const task=(await s.create()).json().task;await s.service.tick();const runId=task.run.id;
  const event=(sequence,type,extra={})=>({eventId:`e-${sequence}`,runId,sequence,type,...extra});
  s.service.ingest(runId,event(2,'final_result',{text:'Result',inputRevision:1}));assert.equal(s.db.prepare('SELECT count(*) AS n FROM task_updates').get().n,0);
  s.service.ingest(runId,event(1,'progress',{text:'Stage one'}));s.service.ingest(runId,event(1,'progress',{text:'Stage one'}));s.service.ingest(runId,event(2,'final_result',{text:'Result',inputRevision:1}));
  let got=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;assert.equal(got.status,'running');assert.equal(got.run.result,'Result');
  s.service.ingest(runId,event(3,'status',{status:'succeeded'}));s.service.ingest(runId,event(4,'status',{status:'running'}));got=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;assert.equal(got.status,'succeeded');
  const updates=(await s.call('GET',s.base+`/tasks/${task.id}/updates`,undefined,s.cookie)).json();assert.equal(updates.updates.length,4);assert.equal(updates.deliveries.length,2);
  assert.throws(()=>s.service.ingest('another',event(5,'progress',{text:'forged'})),/invalid_runtime_event/);
});
test('supplement received differs from applied; version checks and cancel requested differs from confirmed',async t=>{
  const s=await setup(t);let task=(await s.create()).json().task;await s.service.tick();task=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;
  const supplement={operationId:'add-input',expectedVersion:task.version,input:'More context'};const appended=await s.call('POST',s.base+`/tasks/${task.id}/input`,supplement,s.cookie);assert.equal(appended.statusCode,200,appended.body);task=appended.json().task;
  assert.equal((await s.call('POST',s.base+`/tasks/${task.id}/input`,supplement,s.cookie)).statusCode,200);
  assert.equal((await s.call('POST',s.base+`/tasks/${task.id}/input`,{...supplement,operationId:'stale'},s.cookie)).statusCode,409);
  await s.service.tick();assert.equal(s.db.prepare('SELECT status FROM task_inputs WHERE revision=2').get().status,'received');
  s.service.ingest(task.run.id,{eventId:'input-ack',runId:task.run.id,sequence:1,type:'input_receipt',inputRevision:2,inputStatus:'applied'});assert.equal(s.db.prepare('SELECT status FROM task_inputs WHERE revision=2').get().status,'applied');
  task=(await s.call('POST',s.base+`/tasks/${task.id}/cancel`,{operationId:'cancel',expectedVersion:task.version},s.cookie)).json().task;assert.equal(task.status,'cancel_requested');await s.service.tick();assert.equal((await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task.status,'cancel_requested');
  s.service.ingest(task.run.id,{eventId:'cancel-ack',runId:task.run.id,sequence:2,type:'status',status:'canceled'});assert.equal((await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task.status,'canceled');
});
test('outbox retries preserve identity; uncertain non-idempotent dispatch is never blindly replayed',async t=>{
  const s=await setup(t);await s.create();s.runtime.failOnce=true;await s.service.tick();s.advance(5001);await s.service.tick();assert.equal(s.runtime.commands.length,2);assert.equal(s.runtime.commands[0].operationId,s.runtime.commands[1].operationId);
  s.runtime.idempotentDispatch=false;s.runtime.failOnce=true;await s.create('second');await s.service.tick();s.advance(60000);await s.service.tick();assert.equal(s.runtime.commands.length,3);assert.equal(s.db.prepare("SELECT count(*) AS n FROM task_outbox WHERE status='unknown'").get().n,1);
});
test('existing tasks retain local access after use-policy changes; new tasks and cross-conversation forks remain denied',async t=>{
  const s=await setup(t);const task=(await s.create()).json().task;
  const foreign={id:'legacy-foreign'};s.db.prepare("INSERT INTO conversations(id,workspace_id,entity_id,user_id,owner_key,scope_json,channel,operation_id,created_at,mode,expires_at) SELECT ?,workspace_id,entity_id,user_id,owner_key,scope_json,channel,?,created_at,mode,expires_at FROM conversations WHERE id=?").run(foreign.id,'legacy-foreign',s.conversation.id);
  s.seedMessage('private-message',foreign.id,'user','Private content',1,0,1900000000000);
  assert.equal((await s.create('fork',{contextMode:'fork',historyMessageIds:['private-message']})).statusCode,403);
  assert.equal((await s.call('GET',s.base+'/tasks',undefined)).statusCode,401);
  s.db.prepare('UPDATE entities SET own_web_use=0').run();assert.equal((await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).statusCode,200);assert.equal((await s.create('new-denied')).statusCode,403);await s.service.tick();assert.equal(s.runtime.commands.length,1);assert.equal(s.db.prepare('SELECT status FROM task_outbox').get().status,'done');
});
test('production without injected runtime fails explicitly and creates no task or run',async t=>{
  const s=await setup(t,false);const response=await s.create();assert.equal(response.statusCode,503,response.body);assert.equal(response.json().error,'runtime_not_configured');assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n,0);
});
test('stale final result cannot satisfy later input; terminal success waits for matching result',async t=>{
  const s=await setup(t);let task=(await s.create()).json().task;await s.service.tick();task=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;
  task=(await s.call('POST',s.base+`/tasks/${task.id}/input`,{operationId:'second-input',expectedVersion:task.version,input:'Changed requirement'},s.cookie)).json().task;
  const runId=task.run.id;s.service.ingest(runId,{eventId:'old-result',runId,sequence:1,type:'final_result',text:'Old result',inputRevision:1});s.service.ingest(runId,{eventId:'finished',runId,sequence:2,type:'status',status:'succeeded'});
  task=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;assert.equal(task.status,'waiting_input');assert.equal(task.run.status,'succeeded');assert.equal(task.run.resultInputRevision,1);
  const waitingVersion=task.version;await s.service.tick();await s.service.tick();assert.equal((await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task.version,waitingVersion,'projection reconciliation must not repeatedly mutate an already waiting task');
  assert.throws(()=>s.service.ingest(runId,{eventId:'invalid-result',runId,sequence:3,type:'final_result',text:'Unversioned'}),/invalid_result_revision/);
});
test('demo conversations and expired evidence cannot be executed or forked',async t=>{
  const s=await setup(t),demo={id:'historical-demo'};s.db.prepare("INSERT INTO conversations(id,workspace_id,entity_id,user_id,owner_key,scope_json,channel,operation_id,created_at,mode,expires_at) SELECT ?,workspace_id,entity_id,user_id,owner_key,scope_json,channel,?,created_at,'demo',expires_at FROM conversations WHERE id=?").run(demo.id,'historical-demo-operation',s.conversation.id);
  assert.equal((await s.create('from-demo',{conversationId:demo.id})).statusCode,409);
  s.seedMessage('simulated',s.conversation.id,'assistant','Not real',1,1,1900000000000);
  assert.equal((await s.create('demo-history',{contextMode:'fork',historyMessageIds:['simulated']})).statusCode,403);
  s.seedMessage('expired',s.conversation.id,'assistant','Expired',1,0,1);
  assert.equal((await s.create('expired-history',{contextMode:'fork',historyMessageIds:['expired']})).statusCode,403);
});
test('lease fencing ignores stale consumer receipt and input retry requires its own explicit guarantee',async t=>{
  const s=await setup(t);const task=(await s.create()).json().task;let release;s.runtime.dispatch=async()=>{await new Promise(resolve=>release=resolve);return {status:'accepted'};};
  const ticking=s.service.tick();await new Promise(resolve=>setImmediate(resolve));s.db.prepare("UPDATE task_outbox SET lease_token='new-owner' WHERE kind='dispatch'").run();release();await ticking;
  assert.equal(s.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status,'queued');
  s.db.prepare("UPDATE task_outbox SET status='done' WHERE kind='dispatch'").run();s.db.prepare("UPDATE runs SET status='running'").run();s.db.prepare("UPDATE tasks SET status='running'").run();let current=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;
  await s.call('POST',s.base+`/tasks/${task.id}/input`,{operationId:'uncertain-input',expectedVersion:current.version,input:'New'},s.cookie);
  let calls=0;s.runtime.input=async()=>{calls++;throw Error('unknown transport');};await s.service.tick();s.advance(60000);await s.service.tick();assert.equal(calls,1);assert.equal(s.db.prepare("SELECT status FROM task_outbox WHERE kind='input'").get().status,'unknown');
});
test('fresh service recovers an expired durable outbox lease with stable operation identity',async t=>{
  const s=await setup(t);const task=(await s.create()).json().task;
  const outbox=s.db.prepare('SELECT * FROM task_outbox').get();s.db.prepare("UPDATE task_outbox SET status='leased',lease_until=1,lease_token='crashed-worker'").run();
  const {TaskService}=await import('../dist/tasks.js');const {SqliteTaskRepository}=await import('../dist/adapters/sqlite/task-repository.js');const {SqliteTaskAuthorization}=await import('../dist/adapters/sqlite/task-authorization.js');const {Store}=await import('../dist/store.js');const reopened=new Store(s.databasePath);t.after(()=>reopened.close());const recovered=new TaskService(new SqliteTaskRepository(reopened),s.service.now,s.runtime,new SqliteTaskAuthorization(reopened));await recovered.tick();
  assert.equal(s.runtime.commands.length,1);assert.equal(s.runtime.commands[0].operationId,outbox.operation_id);assert.equal(s.db.prepare('SELECT status FROM task_outbox').get().status,'done');
  recovered.ingest(task.run.id,{eventId:'persisted-progress',runId:task.run.id,sequence:1,type:'progress',text:'Persisted before restart'});
  const again=new TaskService(new SqliteTaskRepository(reopened),s.service.now,s.runtime,new SqliteTaskAuthorization(reopened));again.ingest(task.run.id,{eventId:'persisted-progress',runId:task.run.id,sequence:1,type:'progress',text:'Persisted before restart'});assert.equal(s.db.prepare('SELECT count(*) AS n FROM task_updates').get().n,1);
});
test('versioned package disable preserves old execution snapshot and removes it from new sessions',async t=>{
  const s=await setup(t,true,{approvedResources:[{id:'approved-skill',shared:true,kind:'skill',resourceId:'synthetic-skill',version:'1',digest:'a'.repeat(64)}]});
  const config={name:'Approved text instructions',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:['approved-skill']};
  const created=await s.call('POST',s.base+'/capability-packages',config,s.cookie);assert.equal(created.statusCode,200,created.body);const pack=created.json();
  const response=await s.create('with-package',{capabilityPackageIds:[pack.id]});assert.equal(response.statusCode,202,response.body);
  const snapshot=JSON.parse(s.db.prepare('SELECT config_snapshot_json FROM tasks').get().config_snapshot_json);assert.equal(snapshot.skills[0].resourceId,'synthetic-skill');assert.equal(snapshot.packages[0].version,1);
  await s.call('PUT',s.base+`/capability-packages/${pack.id}`,{...config,enabled:false},s.cookie);await s.service.tick();assert.equal(s.runtime.commands.length,1);assert.equal(s.db.prepare('SELECT status FROM task_outbox').get().status,'done');assert.equal((await s.call('GET',s.base+'/tasks',undefined,s.cookie)).statusCode,200);assert.equal((await s.call('GET',s.base+`/tasks/${response.json().task.id}`,undefined,s.cookie)).statusCode,200);assert.deepEqual(JSON.parse(s.db.prepare('SELECT config_snapshot_json FROM tasks').get().config_snapshot_json),snapshot);const fresh=await s.create('new-after-disable');assert.equal(fresh.statusCode,202);assert.deepEqual(JSON.parse(s.db.prepare('SELECT config_snapshot_json FROM tasks WHERE id=?').get(fresh.json().task.id).config_snapshot_json).packages,[]);
});
test('explicit additional Web user grant does not expose another private conversation or task',async t=>{
  const s=await setup(t);const task=(await s.create()).json().task;
  const reg=await s.call('POST','/api/auth/register',{username:'second-user',password:'Synthetic second user password 2026!'});const bob=reg.json(),bobCookie=reg.headers['set-cookie'].split(';')[0];
  const invite=(await s.call('POST',`/api/workspaces/${s.user.workspace.id}/invitations`,{role:'member'},s.cookie)).json();await s.call('POST','/api/invitations/accept',{token:invite.token},bobCookie);
  const bobMember=s.db.prepare('SELECT id FROM members WHERE user_id=? AND workspace_id=?').get(bob.user.id,s.user.workspace.id);
  const policy=await s.call('PUT',s.base+'/web-access',{allowMemberIds:[s.user.workspace.memberId,bobMember.id],denyMemberIds:[]},s.cookie);assert.equal(policy.statusCode,200,policy.body);
  const entities=(await s.call('GET',`/api/workspaces/${s.user.workspace.id}/entities`,undefined,bobCookie)).json().entities;assert.ok(entities.some(e=>e.id===s.entity.id));
  assert.equal((await s.call('GET',s.base+`/tasks/${task.id}`,undefined,bobCookie)).statusCode,404);
  assert.equal((await s.call('GET',s.base+`/conversations/${s.conversation.id}/messages`,undefined,bobCookie)).statusCode,404);
  assert.equal((await s.call('POST',s.base+'/conversations',{operationId:'bob-private',mode:'real'},bobCookie)).statusCode,201);
});
test('expired fork bodies are scrubbed from task and transport snapshots, preserving only provenance',async t=>{
  const s=await setup(t);s.seedMessage('retained-ref',s.conversation.id,'user','Short-lived private body',1800000000000,0,1800000000010);
  const response=await s.create('fork-retention',{contextMode:'fork',historyMessageIds:['retained-ref']});assert.equal(response.statusCode,202,response.body);const task=response.json().task;
  assert.ok(s.db.prepare('SELECT snapshot_json FROM tasks').get().snapshot_json.includes('Short-lived private body'));
  s.db.exec('CREATE TABLE task_host_bindings(run_id TEXT PRIMARY KEY,command_json TEXT NOT NULL)');s.db.prepare('INSERT INTO task_host_bindings VALUES(?,?)').run(task.run.id,JSON.stringify({context:{messages:[{id:'retained-ref',role:'user',text:'Short-lived private body'}]}}));
  s.advance(11);await s.service.tick();const snapshot=JSON.parse(s.db.prepare('SELECT snapshot_json FROM tasks').get().snapshot_json);assert.equal(snapshot[0].id,'retained-ref');assert.equal(snapshot[0].text,'');assert.equal(snapshot[0].expired,true);
  assert.ok(!s.db.prepare('SELECT command_json FROM task_host_bindings').get().command_json.includes('Short-lived private body'));assert.equal(s.runtime.commands.length,0);assert.equal(s.db.prepare('SELECT status FROM task_outbox').get().status,'blocked');
});
test('availableActions use positive runtime evidence; unknown still permits explicitly record-only supplements',async t=>{
 const s=await setup(t);s.runtime.capabilities=()=>undefined;const created=(await s.create()).json().task;assert.equal(created.availableActions.cancel.available,false);assert.equal(created.availableActions.cancel.reason,'runtime_not_bound');await s.service.tick();
 let task=(await s.call('GET',s.base+`/tasks/${created.id}`,undefined,s.cookie)).json().task;assert.equal(task.actionCapabilities.status,'unknown');assert.equal(task.availableActions.cancel.reason,'runtime_capability_unknown');assert.equal(task.availableActions.supplement.available,true);assert.equal(task.availableActions.supplement.mode,'platform_record_only');assert.equal(task.availableActions.pause.reason,'platform_action_unsupported');assert.equal(task.availableActions.resume.available,false);
 const refused=await s.call('POST',s.base+`/tasks/${task.id}/cancel`,{operationId:'unknown-cancel',expectedVersion:task.version},s.cookie);assert.equal(refused.statusCode,409);assert.equal(s.db.prepare('SELECT count(*) AS n FROM task_operations').get().n,0);
 const recorded=await s.call('POST',s.base+`/tasks/${task.id}/input`,{operationId:'record-only',expectedVersion:task.version,input:'Keep this new requirement'},s.cookie);assert.equal(recorded.statusCode,200);task=recorded.json().task;assert.equal(task.actionReceipt.status,'recorded');assert.equal(task.actionReceipt.runtimeStatus,'recorded');assert.equal(task.actionReceipt.deliveryMode,'platform_record_only');assert.equal(s.db.prepare("SELECT count(*) AS n FROM task_outbox WHERE kind='input'").get().n,0);
 assert.equal((await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task.actionReceipt.runtimeStatus,'recorded');
});
test('unsupported capability explains action refusal without redefining tools; terminal state wins over supported capability',async t=>{
 const s=await setup(t);const supported=s.runtime.capabilities.bind(s.runtime);s.runtime.capabilities=runId=>({...supported(runId),appendInput:'unsupported',cancel:'unsupported'});let task=(await s.create()).json().task;await s.service.tick();task=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;
 assert.equal(task.availableActions.supplement.runtimeDelivery.support,'unsupported');assert.equal(task.availableActions.cancel.reason,'runtime_action_unsupported');assert.equal(task.availableActions.supplement.mode,'platform_record_only');
 s.runtime.capabilities=supported;s.service.ingest(task.run.id,{eventId:'failed',runId:task.run.id,sequence:1,type:'status',status:'failed'});task=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;
 assert.equal(task.availableActions.supplement.reason,'task_terminal');assert.equal(task.availableActions.cancel.reason,'task_terminal');assert.equal(task.availableActions.query.available,true);
 assert.equal((await s.call('POST',s.base+`/tasks/${task.id}/input`,{operationId:'late',expectedVersion:task.version,input:'Too late'},s.cookie)).statusCode,409);
});
test('mutation uses local runtime capability and version facts without remote discovery',async t=>{
 const s=await setup(t);let task=(await s.create()).json().task;await s.service.tick();task=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;const supported=s.runtime.capabilities.bind(s.runtime);let refreshes=0;s.runtime.refreshCapabilities=async()=>{refreshes++;};s.runtime.capabilities=id=>({...supported(id),cancel:'unsupported'});
 assert.equal((await s.call('POST',s.base+`/tasks/${task.id}/cancel`,{operationId:'unsupported',expectedVersion:task.version},s.cookie)).json().error,'runtime_action_unsupported');
 s.runtime.capabilities=supported;s.db.prepare('UPDATE tasks SET version=version+1').run();assert.equal((await s.call('POST',s.base+`/tasks/${task.id}/cancel`,{operationId:'stale',expectedVersion:task.version},s.cookie)).json().error,'version_conflict');
 task=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;s.db.prepare('UPDATE entities SET own_web_use=0').run();assert.equal((await s.call('POST',s.base+`/tasks/${task.id}/cancel`,{operationId:'local-cancel',expectedVersion:task.version},s.cookie)).statusCode,200);assert.equal(refreshes,0);
});
test('expired or mismatched capability facts fail closed and task query does not perform remote discovery',async t=>{
 const s=await setup(t);let task=(await s.create()).json().task;await s.service.tick();const supported=s.runtime.capabilities.bind(s.runtime);let refreshes=0;s.runtime.refreshCapabilities=async()=>{refreshes++;};s.runtime.capabilities=id=>({...supported(id),expiresAt:1});
 task=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;assert.equal(task.actionCapabilities.status,'unknown');assert.equal(task.availableActions.cancel.available,false);assert.equal(refreshes,0);
 s.runtime.capabilities=id=>({...supported(id),runId:'different-run'});assert.equal((await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task.availableActions.cancel.reason,'runtime_capability_unknown');assert.equal(refreshes,0);
 await s.call('POST',s.base+`/tasks/${task.id}/cancel`,{operationId:'refresh',expectedVersion:task.version},s.cookie);assert.equal(refreshes,0);
});
test('queued action rechecks capability before external send; requested/unknown cancellation never means stopped',async t=>{
 const s=await setup(t);let task=(await s.create()).json().task;await s.service.tick();task=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;
 task=(await s.call('POST',s.base+`/tasks/${task.id}/cancel`,{operationId:'request',expectedVersion:task.version},s.cookie)).json().task;assert.equal(task.actionReceipt.status,'requested');assert.notEqual(task.actionReceipt.runtimeStatus,'canceled');assert.equal(task.availableActions.cancel.reason,'cancel_already_requested');
 const supported=s.runtime.capabilities.bind(s.runtime);let calls=0;s.runtime.cancel=async()=>{calls++;return{status:'confirmed'};};s.runtime.capabilities=id=>({...supported(id),cancel:'unsupported'});await s.service.tick();assert.equal(calls,0);assert.equal(s.db.prepare("SELECT status FROM task_outbox WHERE kind='cancel'").get().status,'blocked');assert.equal((await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task.status,'cancel_requested');
});
test('in-flight runtime input cannot overwrite a reclaimed local outbox lease',async t=>{const s=await setup(t);let task=(await s.create()).json().task;await s.service.tick();task=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;await s.call('POST',s.base+`/tasks/${task.id}/input`,{operationId:'lease-refresh',expectedVersion:task.version,input:'More input'},s.cookie);let entered,release;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);s.runtime.input=async()=>{entered();await gate;return{status:'applied'};};const tick=s.service.tick();await started;s.db.prepare("UPDATE task_outbox SET lease_token='replacement-owner' WHERE kind='input'").run();release();await tick;const outbox=s.db.prepare("SELECT status,lease_token FROM task_outbox WHERE kind='input'").get();assert.equal(outbox.status,'leased');assert.equal(outbox.lease_token,'replacement-owner');assert.equal(s.db.prepare('SELECT status FROM task_inputs WHERE revision=2').get().status,'pending');});
test('unknown execution permits only evidence-backed stop request, not runtime input application',async t=>{
 const s=await setup(t);let task=(await s.create()).json().task;await s.service.tick();s.db.prepare("UPDATE runs SET status='unknown'").run();task=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;
 assert.equal(task.availableActions.supplement.mode,'platform_record_only');assert.equal(task.availableActions.supplement.runtimeDelivery.reason,'runtime_state_unknown');assert.equal(task.availableActions.cancel.available,true);
 const requested=await s.call('POST',s.base+`/tasks/${task.id}/cancel`,{operationId:'unknown-run-stop',expectedVersion:task.version},s.cookie);assert.equal(requested.statusCode,200);await s.service.tick();const current=(await s.call('GET',s.base+`/tasks/${task.id}`,undefined,s.cookie)).json().task;assert.equal(current.status,'cancel_requested');assert.equal(current.actionReceipt.status,'requested');assert.equal(current.actionReceipt.runtimeStatus,'unknown');
});

test('shutdown waits for an in-flight task dispatch and preserves its durable receipt before closing storage',async t=>{
  const s=await setup(t);const task=(await s.create()).json().task;
  let releaseDispatch,markEntered;
  const dispatchEntered=new Promise(resolve=>markEntered=resolve);
  const dispatchGate=new Promise(resolve=>releaseDispatch=resolve);
  s.runtime.dispatch=async command=>{s.runtime.commands.push(command);markEntered();await dispatchGate;return {status:'accepted'};};
  const ticking=s.service.tick();await dispatchEntered;
  let closed=false;const closing=s.app.close().then(()=>{closed=true;});
  try {
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(closed,false,'server must wait for the leased dispatch before closing its database');
    assert.equal(s.db.prepare('SELECT status FROM task_outbox WHERE task_id=?').get(task.id).status,'leased');
  } finally {releaseDispatch();}
  await Promise.all([ticking,closing]);
  const reopened=new DatabaseSync(s.databasePath);
  try {
    assert.equal(reopened.prepare('SELECT status FROM task_outbox WHERE task_id=?').get(task.id).status,'done');
    assert.equal(reopened.prepare('SELECT status FROM runs WHERE id=?').get(task.run.id).status,'running');
    assert.equal(reopened.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status,'running');
  } finally {reopened.close();}
});

test('HTTP tasks require verified conversation context and planned lifecycle uses the same Task id',async t=>{
  const s=await setup(t),root=`${s.base}/conversations/${s.conversation.id}`,raw=(method,url,payload)=>s.app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{origin,cookie:s.cookie}});
  for(const method of ['GET','POST']){const denied=await raw(method,s.base+'/tasks',method==='POST'?{operationId:'missing',input:'must reject'}:undefined);assert.equal(denied.statusCode,400,denied.body);assert.equal(denied.json().error,'task_context_required');}
  const saved=await raw('POST',root+'/todos',{operationId:'http-todo',input:'Deferred HTTP intent'});assert.equal(saved.statusCode,201,saved.body);const todo=saved.json().task;assert.equal(todo.status,'planned');assert.equal(todo.run,null);
  const other={id:'legacy-isolation'};s.db.prepare("INSERT INTO conversations(id,workspace_id,entity_id,user_id,owner_key,scope_json,channel,operation_id,created_at,mode,expires_at) SELECT ?,workspace_id,entity_id,user_id,owner_key,scope_json,channel,?,created_at,mode,expires_at FROM conversations WHERE id=?").run(other.id,'legacy-isolation',s.conversation.id);const foreignRoot=`${s.base}/conversations/${other.id}`;
  assert.deepEqual((await raw('GET',foreignRoot+'/tasks')).json().tasks,[]);
  for(const suffix of ['', '/updates'])assert.equal((await raw('GET',foreignRoot+`/tasks/${todo.id}${suffix}`)).statusCode,404);
  for(const action of ['start','cancel','input'])assert.equal((await raw('POST',foreignRoot+`/tasks/${todo.id}/${action}`,{operationId:action,expectedVersion:1,...(action==='input'?{input:'forged'}:{})})).statusCode,404);
  assert.equal((await raw('POST',root+'/todos',{operationId:'source-forged',input:'forge',source:{userId:'other'}})).statusCode,400);
  assert.equal((await raw('POST',root+'/todos',{operationId:'conversation-forged',conversationId:other.id,input:'forge'})).statusCode,403);
  const started=await raw('POST',root+`/tasks/${todo.id}/start`,{operationId:'http-start',expectedVersion:1});assert.equal(started.statusCode,200,started.body);assert.equal(started.json().task.id,todo.id);assert.equal(started.json().task.status,'queued');
  assert.equal(s.db.prepare('SELECT count(*) n FROM tasks').get().n,1);assert.equal(s.db.prepare('SELECT count(*) n FROM runs').get().n,1);
  const listed=await raw('GET',root+'/tasks?status=active&limit=1');assert.equal(listed.statusCode,200,listed.body);assert.equal(listed.json().tasks[0].id,todo.id);
});
test('HTTP no-runtime todo cancel is platform confirmed and does not queue a remote cancellation',async t=>{
  const s=await setup(t,false),root=`${s.base}/conversations/${s.conversation.id}`;
  const saved=await s.call('POST',root+'/todos',{operationId:'deferred',input:'save only'},s.cookie);assert.equal(saved.statusCode,201,saved.body);const todo=saved.json().task;
  const canceled=await s.call('POST',root+`/tasks/${todo.id}/cancel`,{operationId:'cancel-planned',expectedVersion:1},s.cookie);assert.equal(canceled.statusCode,200,canceled.body);assert.equal(canceled.json().task.status,'canceled');assert.equal(canceled.json().task.run,null);assert.equal(canceled.json().task.actionReceipt.status,'canceled');
  assert.equal((await s.call('POST',root+`/tasks/${todo.id}/cancel`,{operationId:'cancel-planned',expectedVersion:1},s.cookie)).statusCode,200);
  assert.equal(s.db.prepare('SELECT count(*) n FROM runs').get().n,0);assert.equal(s.db.prepare('SELECT count(*) n FROM task_outbox').get().n,0);
});

test('legacy untrusted package field cannot narrow or expand automatic task resources or retry identity',async t=>{
 const s=await setup(t,true,{approvedResources:[{id:'auto-skill',shared:true,kind:'skill',resourceId:'approved-auto-skill',version:'1',digest:'c'.repeat(64)}]});
 const p=await s.call('POST',s.base+'/capability-packages',{name:'Automatic',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:['auto-skill']},s.cookie);assert.equal(p.statusCode,200,p.body);
 const one=await s.create('automatic-legacy',{capabilityPackageIds:['forged-unavailable-package']});assert.equal(one.statusCode,202,one.body);
 const snapshot=JSON.parse(s.db.prepare('SELECT config_snapshot_json FROM tasks WHERE id=?').get(one.json().task.id).config_snapshot_json);assert.deepEqual(snapshot.packages.map(p=>p.id),[p.json().id]);assert.equal(snapshot.skills[0].resourceId,'approved-auto-skill');
 await s.call('POST',s.base+'/capability-packages',{name:'New later grant',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[]},s.cookie);
 const retry=await s.create('automatic-legacy',{capabilityPackageIds:[]});assert.equal(retry.statusCode,202,retry.body);assert.equal(retry.json().task.id,one.json().task.id);assert.equal(JSON.parse(s.db.prepare('SELECT config_snapshot_json FROM tasks WHERE id=?').get(one.json().task.id).config_snapshot_json).packages.length,1);assert.equal(s.db.prepare('SELECT count(*) n FROM runs').get().n,1);
});


test('new snapshot preparation is outside the write transaction and concurrent package edits fence its commit',async t=>{const s=await setup(t),config={name:'Prepared',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[]};const pack=(await s.call('POST',s.base+'/capability-packages',config,s.cookie)).json();const original=s.service.capabilities.resolveForTask.bind(s.service.capabilities);let enter,release;const gate=new Promise(r=>release=r),started=new Promise(r=>enter=r);s.service.capabilities.resolveForTask=async scope=>{const snapshot=await original(scope);enter();await gate;return snapshot;};const pending=s.create('prepared-race');await started;const edited=await s.call('PUT',s.base+'/capability-packages/'+pack.id,{...config,enabled:false,expectedVersion:pack.version},s.cookie);assert.equal(edited.statusCode,200,'another write completes while preparation waits');release();const r=await pending;assert.equal(r.statusCode,409,r.body);assert.equal(r.json().error,'capability_configuration_changed');assert.equal(s.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM runs').get().n,0);});
test('interrupted async execution preparation creates no Task or Run and todo remains snapshot-free until start',async t=>{const s=await setup(t);const context={workspaceId:s.user.workspace.id,entityId:s.entity.id,userId:s.user.user.id,conversationId:s.conversation.id};const original=s.service.capabilities.resolveForTask.bind(s.service.capabilities);let release,enter,resolves=0;const gate=new Promise(r=>release=r),started=new Promise(r=>enter=r);s.service.capabilities.resolveForTask=async scope=>{resolves++;const snapshot=await original(scope);enter();await gate;return snapshot;};const controller=new AbortController(),pending=s.service.create(context,{operationId:'abort-prepare',input:'Synthetic',contextMode:'new'},false,controller.signal);await started;controller.abort();release();await assert.rejects(pending,e=>e.code==='task_creation_interrupted');assert.equal(s.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);const todo=s.service.createTodo(context,{operationId:'planned-no-prepare',input:'Planned',contextMode:'new'});assert.equal(todo.status,'planned');assert.equal(resolves,1);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM runs').get().n,0);});

test('durable unknown status is reflected on the current Task, replay is idempotent and later terminal evidence settles it',async t=>{
 const s=await setup(t),created=(await s.create()).json().task;await s.service.tick();const runId=created.run.id;
 const event={eventId:'persisted-unknown',runId,sequence:1,type:'status',status:'unknown'};s.runtime.stream.push(event);await s.service.tick();
 assert.equal(s.db.prepare('SELECT status FROM runs WHERE id=?').get(runId).status,'unknown');assert.equal(s.db.prepare('SELECT status FROM tasks WHERE id=?').get(created.id).status,'unknown');
 s.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(created.id);await s.service.tick();assert.equal(s.db.prepare('SELECT status FROM tasks WHERE id=?').get(created.id).status,'unknown','persisted Run repairs a stale projection without replaying the consumed event');
 const version=s.db.prepare('SELECT version FROM tasks WHERE id=?').get(created.id).version;await s.service.tick();assert.equal(s.db.prepare('SELECT version FROM tasks WHERE id=?').get(created.id).version,version);assert.equal(s.runtime.commands.length,1,'unknown must not resubmit');
 s.runtime.stream.push({eventId:'persisted-failure',runId,sequence:2,type:'status',status:'failed'});await s.service.tick();assert.equal(s.db.prepare('SELECT status FROM tasks WHERE id=?').get(created.id).status,'failed');
 s.service.ingest(runId,{eventId:'late-unknown',runId,sequence:3,type:'status',status:'unknown'});assert.equal(s.db.prepare('SELECT status FROM tasks WHERE id=?').get(created.id).status,'failed');
});
