import test from 'node:test';
import {ChannelTaskAuthorization} from '../dist/channel-loop/authorization.js';
import {EmployeeChannelService} from '../dist/employee-channels/service.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {SqliteTaskRepository} from '../dist/adapters/sqlite/task-repository.js';
import {SqliteConversationRepository} from '../dist/adapters/sqlite/conversation-repository.js';
import {CapabilityConfigService} from '../dist/capability-config.js';
import {TaskService,TaskError} from '@dentity/application';
import {JsonlJournal} from '@dentity/runtime-builtin';
const code=c=>e=>e.code===c;
class MockRuntime {
  commands=[];idempotentDispatch=true;
  capabilities(runId){return{runId,runtimeId:'fixture',runtimeVersion:'1',bindingVersion:'1',observedAt:1000,expiresAt:999999,appendInput:'supported',cancel:'supported'};}
  async dispatch(c){this.commands.push(c);return{status:'accepted'};}
  async events(){return[];}
  async input(){return{status:'received'};}
  async cancel(){return{status:'unknown'};}
}
function fixture(t,{runtimeConfigured=true,modelConfigured=true}={}){
  const dir=mkdtempSync(join(tmpdir(),'dentity-planning-')),path=join(dir,'test.sqlite'),store=new Store(path);let now=1000;
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.db.exec("INSERT INTO users VALUES('u','user','Owner','active'),('guest','guest','Guest','active'); INSERT INTO workspaces VALUES('w','Workspace','u','active'),('other','Other','guest','active'); INSERT INTO members VALUES('m','w','u','owner','active'),('g','w','guest','member','active'); INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin-interaction');");
  const journal=new JsonlJournal({root:join(dir,'journal'),ownerId:'fixture',serialize:fn=>store.transaction(fn)}),conversations=new SqliteConversationRepository(store,journal,()=>now);conversations.initialize(0);
  const scope={workspaceId:'w',entityId:'e',userId:'u'},context={...scope,conversationId:'c'},other={...scope,conversationId:'c2'};
  conversations.create('c',scope,'c-op',now,'real',0);conversations.create('c2',scope,'c2-op',now,'real',0);
  const capabilities=new CapabilityConfigService(store,[{id:'skill',kind:'skill',shared:true,resourceId:'skill-resource',version:'1',digest:'a'.repeat(64)}]);
  const repository=new SqliteTaskRepository(store),runtime=new MockRuntime();
  const authorization=new ChannelTaskAuthorization(store,capabilities,new EmployeeChannelService(new EmployeeChannelRepository(store),{masterKey:new Uint8Array(32).fill(8),now:()=>now}),()=>now);
  const make=(r=runtimeConfigured?runtime:undefined)=>new TaskService(repository,()=>now,r,authorization,undefined,conversations,()=>{if(!modelConfigured)throw new TaskError(409,'model_not_configured');});
  const service=make(),todo=(op='todo',extra={})=>service.createTodo(context,{operationId:op,input:'Synthetic deferred work',...extra});
  const counts=()=>Object.fromEntries(['tasks','runs','task_inputs','task_outbox'].map(table=>[table,store.one(`SELECT count(*) n FROM ${table}`).n]));
  return{store,path,scope,context,other,service,repository,runtime,capabilities,conversations,make,todo,counts,advance:ms=>now+=ms,setModel:v=>modelConfigured=v};
}
test('same Task table supports durable no-model/no-runtime todo create/query/cancel with null Run',async t=>{
  const f=fixture(t,{runtimeConfigured:false,modelConfigured:false}),task=f.todo();assert.equal(task.status,'planned');assert.equal(task.run,null);assert.equal(task.inputRevision,0);assert.equal(task.availableActions.start.available,true);assert.equal(task.availableActions.supplement.available,true);assert.equal(task.availableActions.supplement.application,'on_start');assert.equal(task.availableActions.cancel.mode,'cancel_planned');
  assert.deepEqual(f.counts(),{tasks:1,runs:0,task_inputs:0,task_outbox:0});assert.equal((await f.service.listPage(f.context,{status:'planned'})).tasks[0].id,task.id);assert.deepEqual(f.service.getUpdates(f.context,task.id),{updates:[],inputs:[],deliveries:[]});
  await assert.rejects(f.service.startTodo(f.context,task.id,{operationId:'start',expectedVersion:1}),code('model_not_configured'));
  const canceled=await f.service.cancelTodo(f.context,task.id,{operationId:'cancel',expectedVersion:1});assert.equal(canceled.status,'canceled');assert.equal(canceled.run,null);assert.equal(canceled.actionReceipt.status,'canceled');assert.equal(canceled.actionReceipt.runtimeStatus,'not_started');
  assert.equal((await f.service.cancelTodo(f.context,task.id,{operationId:'cancel',expectedVersion:1})).version,2);assert.deepEqual(f.counts(),{tasks:1,runs:0,task_inputs:0,task_outbox:0});
  await assert.rejects(f.service.startTodo(f.context,task.id,{operationId:'after-cancel',expectedVersion:2}),code('task_terminal'));await f.service.tick();assert.equal(f.runtime.commands.length,0);
});
test('start retains Task id and creates exactly one Run/input/outbox with idempotent receipt before old-version rejection',async t=>{
  const f=fixture(t),todo=f.todo(),body={operationId:'start',expectedVersion:1};assert.equal(f.todo().id,todo.id);assert.throws(()=>f.todo('todo',{input:'different'}),code('operation_conflict'));
  const started=await f.service.startTodo(f.context,todo.id,body);assert.equal(started.id,todo.id);assert.equal(started.status,'queued');assert.equal(started.actionReceipt.status,'queued');assert.ok(started.run.id);
  assert.equal((await f.service.startTodo(f.context,todo.id,body)).run.id,started.run.id);await assert.rejects(f.service.startTodo(f.context,todo.id,{...body,expectedVersion:2}),code('operation_conflict'));await assert.rejects(f.service.startTodo(f.context,todo.id,{operationId:'stale',expectedVersion:1}),code('version_conflict'));await assert.rejects(f.service.startTodo(f.context,todo.id,{operationId:'second',expectedVersion:2}),code('already_started'));
  assert.deepEqual(f.counts(),{tasks:1,runs:1,task_inputs:1,task_outbox:1});assert.equal(f.runtime.commands.length,0);await f.service.tick();assert.equal(f.runtime.commands.length,1);assert.equal(f.runtime.commands[0].taskId,todo.id);assert.equal(f.runtime.commands[0].requester.externalUserId,'u');
  const receipt=await f.service.cancelTodo(f.context,todo.id,{operationId:'cancel-todo',expectedVersion:3});assert.equal(receipt.actionReceipt.status,'already_started');assert.equal(receipt.run.id,started.run.id);assert.equal(f.store.one("SELECT count(*) n FROM task_outbox WHERE kind='cancel'").n,0);
});
test('double start and start/cancel races have one transition winner in both orders',async t=>{
  const f=fixture(t);
  for(const [i,actions] of [['double',['start','start']],['start-first',['start','cancel']],['cancel-first',['cancel','start']]]){
    const todo=f.todo(i),results=await Promise.allSettled(actions.map((a,n)=>a==='start'?f.service.startTodo(f.context,todo.id,{operationId:`${i}-${n}`,expectedVersion:1}):f.service.cancelTodo(f.context,todo.id,{operationId:`${i}-${n}`,expectedVersion:1})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='version_conflict').length,1);const winner=results.find(r=>r.status==='fulfilled').value;assert.equal(f.store.one('SELECT count(*) n FROM runs WHERE task_id=?',todo.id).n,winner.status==='canceled'?0:1);
  }
});
test('SQLite abort after CAS rolls back Task/Run/input/outbox/receipt and retries recover committed response',async t=>{
  const f=fixture(t),todo=f.todo();f.store.db.exec("CREATE TRIGGER reject_dispatch BEFORE INSERT ON task_outbox BEGIN SELECT RAISE(ABORT,'injected transaction failure'); END;");
  await assert.rejects(f.service.startTodo(f.context,todo.id,{operationId:'start',expectedVersion:1}),/injected transaction failure/);assert.deepEqual(f.counts(),{tasks:1,runs:0,task_inputs:0,task_outbox:0});assert.equal(f.store.one('SELECT status FROM tasks').status,'planned');assert.equal(f.store.one('SELECT count(*) n FROM task_operations').n,0);
  f.store.db.exec('DROP TRIGGER reject_dispatch');await f.service.startTodo(f.context,todo.id,{operationId:'start',expectedVersion:1});
  const restarted=f.make(),recovered=await restarted.startTodo(f.context,todo.id,{operationId:'start',expectedVersion:1});assert.equal(recovered.id,todo.id);assert.equal(recovered.actionReceipt.status,'queued');assert.deepEqual(f.counts(),{tasks:1,runs:1,task_inputs:1,task_outbox:1});
});
test('current logical session and actor constrain all task operations and operation lookup; missing context fails closed',async t=>{
  const f=fixture(t),todo=f.todo();assert.deepEqual((await f.service.listPage(f.other)).tasks,[]);assert.equal(f.service.findByOperation(f.other,'todo'),undefined);
  assert.throws(()=>f.service.task(f.other,todo.id),code('task_not_found'));assert.throws(()=>f.service.getUpdates(f.other,todo.id),code('task_not_found'));await assert.rejects(f.service.startTodo(f.other,todo.id,{operationId:'start',expectedVersion:1}),code('task_not_found'));await assert.rejects(f.service.mutate(f.other,todo.id,'cancel',{operationId:'cancel',expectedVersion:1}),code('task_not_found'));await assert.rejects(f.service.mutate(f.other,todo.id,'input',{operationId:'input',expectedVersion:1,input:'forged'}),code('task_not_found'));
  await assert.rejects(()=>f.service.create(f.context,{operationId:'forged',conversationId:'c2',input:'forged'}),code('task_conversation_forbidden'));
  assert.throws(()=>f.service.list(f.scope),code('task_context_required'));assert.throws(()=>f.service.createTodo(f.scope,{operationId:'missing-context',conversationId:'c',input:'work'}),code('task_context_required'));
  f.capabilities.saveWebAccess('w','e',{allowMemberIds:['m','g'],denyMemberIds:[]});const guest={...f.context,userId:'guest'};assert.deepEqual(f.service.list(guest),[]);assert.throws(()=>f.service.task(guest,todo.id),code('task_not_found'));
  assert.throws(()=>f.service.task({...f.context,workspaceId:'other'},todo.id));
});
test('revoked actor, removed Runtime/model and expired fork leave todo planned',async t=>{
  const f=fixture(t);
  const noRT=f.todo('no-rt');await assert.rejects(f.make(null).startTodo(f.context,noRT.id,{operationId:'start-no-rt',expectedVersion:1}),code('runtime_not_configured'));
  f.setModel(false);await assert.rejects(f.service.startTodo(f.context,noRT.id,{operationId:'start-no-model',expectedVersion:1}),code('model_not_configured'));f.setModel(true);
  f.conversations.addMessage('retained',f.conversations.get('c'),'user','retained synthetic text',1000,false);
  const fork=f.todo('fork',{contextMode:'fork',historyMessageIds:['retained']});assert.equal(f.store.one('SELECT snapshot_json FROM tasks WHERE id=?',fork.id).snapshot_json,'[]');f.store.run('UPDATE conversation_message_index SET expires_at=1001');f.advance(2);await assert.rejects(f.service.startTodo(f.context,fork.id,{operationId:'expired-fork',expectedVersion:1}),code('context_unavailable'));
  f.capabilities.saveWebAccess('w','e',{allowMemberIds:[],denyMemberIds:[]});await assert.rejects(f.service.startTodo(f.context,noRT.id,{operationId:'revoked',expectedVersion:1}),code('entity_use_forbidden'));assert.equal(f.store.one('SELECT count(*) n FROM runs').n,0);
});
test('unified session list filters planned/active/success/failure and stable pages exclude later insertions',async t=>{
  const f=fixture(t);for(let n=0;n<6;n++)f.todo(`page-${n}`);
  const first=await f.service.listPage(f.context,{status:'planned',limit:2});assert.equal(first.tasks.length,2);assert.ok(first.nextCursor);const later=f.todo('later');let ids=first.tasks.map(t=>t.id),cursor=first.nextCursor;
  while(cursor){const page=await f.service.listPage(f.context,{status:'planned',limit:2,cursor});ids.push(...page.tasks.map(t=>t.id));cursor=page.nextCursor;}
  assert.equal(new Set(ids).size,6);assert.equal(ids.includes(later.id),false);await assert.rejects(f.service.listPage(f.other,{status:'planned',limit:2,cursor:first.nextCursor}),code('invalid_task_cursor'));
  const active=await f.service.create(f.context,{operationId:'immediate',input:'immediate'});await f.service.tick();f.service.ingest(active.run.id,{runId:active.run.id,eventId:'result',sequence:1,type:'final_result',inputRevision:1,text:'success'});f.service.ingest(active.run.id,{runId:active.run.id,eventId:'success',sequence:2,type:'status',status:'succeeded'});
  const failed=await f.service.create(f.context,{operationId:'failed',input:'fail'});await f.service.tick();f.service.ingest(failed.run.id,{runId:failed.run.id,eventId:'failure',sequence:1,type:'status',status:'failed'});
  assert.equal((await f.service.listPage(f.context,{status:'succeeded'})).tasks[0].id,active.id);assert.equal((await f.service.listPage(f.context,{status:'failed'})).tasks[0].id,failed.id);assert.equal((await f.service.listPage(f.context,{status:'planned'})).tasks.length,7);assert.equal((await f.service.listPage(f.other)).tasks.length,0);
});

test('planned supplements persist once without Run and explicit start sends latest complete requirements',async t=>{
  const f=fixture(t),todo=f.todo(),body={operationId:'planned-add',expectedVersion:1,input:'ADDITIONAL_SCOPE_FACT'};
  const added=await f.service.mutate(f.context,todo.id,'input',body);assert.equal(added.status,'planned');assert.equal(added.run,null);assert.equal(added.inputRevision,1);assert.equal(added.availableActions.supplement.application,'on_start');assert.equal(added.actionReceipt.status,'recorded');assert.equal(added.actionReceipt.runtimeStatus,'not_started');assert.equal(f.store.one('SELECT count(*) n FROM task_outbox').n,0);assert.equal(f.store.one('SELECT count(*) n FROM runs').n,0);
  assert.equal((await f.service.mutate(f.context,todo.id,'input',body)).version,2);await assert.rejects(f.service.mutate(f.context,todo.id,'input',{...body,input:'changed'}),code('operation_conflict'));assert.equal(added.input.split('ADDITIONAL_SCOPE_FACT').length-1,1);
  const started=await f.service.startTodo(f.context,todo.id,{operationId:'start-latest',expectedVersion:2});assert.equal(started.inputRevision,2);assert.equal(f.store.one('SELECT status FROM task_inputs WHERE revision=2').status,'pending');await f.service.tick();assert.equal(f.runtime.commands.length,1);assert.equal(f.runtime.commands[0].inputRevision,2);assert.match(f.runtime.commands[0].input,/Synthetic deferred work/);assert.match(f.runtime.commands[0].input,/ADDITIONAL_SCOPE_FACT/);assert.equal(f.store.one('SELECT status FROM task_inputs WHERE revision=2').status,'received');assert.notEqual(f.store.one('SELECT status FROM task_inputs WHERE revision=2').status,'applied');
});
test('pending queued dispatch uses latest requirements without creating a second Run or input Outbox',async t=>{
  const f=fixture(t),task=await f.service.create(f.context,{operationId:'queued',input:'Initial queued request'}),body={operationId:'queued-add',expectedVersion:1,input:'Newest queued constraint'};
  const added=await f.service.mutate(f.context,task.id,'input',body);assert.equal(added.actionReceipt.deliveryMode,'dispatch_input');assert.equal(added.actionReceipt.runtimeStatus,'pending');assert.equal(f.store.one('SELECT input_revision FROM task_outbox').input_revision,2);assert.equal(f.store.one('SELECT count(*) n FROM task_outbox').n,1);assert.equal((await f.service.mutate(f.context,task.id,'input',body)).version,2);
  await f.service.tick();assert.equal(f.runtime.commands.length,1);assert.match(f.runtime.commands[0].input,/Initial queued request/);assert.match(f.runtime.commands[0].input,/Newest queued constraint/);assert.equal(f.runtime.commands[0].inputRevision,2);assert.equal(f.store.one('SELECT count(*) n FROM runs').n,1);assert.equal(f.store.one('SELECT status FROM task_inputs WHERE revision=2').status,'received');
});
test('supplement/start races preserve accepted requirements and completion rejects late rewrites',async t=>{
  const f=fixture(t);
  for(const order of ['input-first','start-first']){
    const todo=f.todo(order),addition=()=>f.service.mutate(f.context,todo.id,'input',{operationId:`${order}-input`,expectedVersion:1,input:'RACE_ADDITION'}),start=()=>f.service.startTodo(f.context,todo.id,{operationId:`${order}-start`,expectedVersion:1});
    const settled=await Promise.allSettled(order==='input-first'?[addition(),start()]:[start(),addition()]);assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);assert.equal(settled.filter(r=>r.status==='rejected'&&r.reason.code==='version_conflict').length,1);
    const current=f.service.task(f.context,todo.id);if(current.status==='planned'){await f.service.startTodo(f.context,todo.id,{operationId:'start-after-input',expectedVersion:current.version});assert.match(f.store.one('SELECT input FROM tasks WHERE id=?',todo.id).input,/RACE_ADDITION/);}
  }
  await f.service.tick();const task=f.service.list(f.context).find(t=>t.run);const current=f.service.task(f.context,task.id);
  f.service.ingest(current.run_id,{runId:current.run_id,eventId:'result',sequence:1,type:'final_result',text:'IMMUTABLE_RESULT',inputRevision:current.input_revision});f.service.ingest(current.run_id,{runId:current.run_id,eventId:'done',sequence:2,type:'status',status:'succeeded'});
  const finished=f.service.dto(f.service.task(f.context,task.id));await assert.rejects(f.service.mutate(f.context,task.id,'input',{operationId:'late',expectedVersion:finished.version,input:'Late rewrite'}),code('task_terminal'));assert.equal(f.service.dto(f.service.task(f.context,task.id)).run.result,'IMMUTABLE_RESULT');
});

test('queued coalescing uses the leased revision even if an earlier task delayed a tick batch',async t=>{
  const f=fixture(t);await f.service.create(f.context,{operationId:'first',input:'slow dispatch'});const second=await f.service.create(f.context,{operationId:'second',input:'second intent'});
  let enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);f.runtime.dispatch=async command=>{f.runtime.commands.push(command);if(f.runtime.commands.length===1){enter();await wait;}return{status:'accepted'};};
  const tick=f.service.tick();await entered;const added=await f.service.mutate(f.context,second.id,'input',{operationId:'during-first',expectedVersion:1,input:'LATEST_BATCH_FACT'});assert.equal(added.actionReceipt.deliveryMode,'dispatch_input');release();await tick;
  assert.equal(f.runtime.commands.length,2);assert.equal(f.runtime.commands[1].inputRevision,2);assert.match(f.runtime.commands[1].input,/LATEST_BATCH_FACT/);
});
test('running input stays durable received rather than applied and an unresolved earlier input fences later revisions',async t=>{
  const f=fixture(t),created=await f.service.create(f.context,{operationId:'active',input:'run'});await f.service.tick();let current=f.service.dto(f.service.task(f.context,created.id));
  const first={operationId:'first-input',expectedVersion:current.version,input:'FIRST_STEER_FACT'};current=await f.service.mutate(f.context,created.id,'input',first);await f.service.mutate(f.context,created.id,'input',first);
  current=await f.service.mutate(f.context,created.id,'input',{operationId:'second-input',expectedVersion:current.version,input:'SECOND_STEER_FACT'});
  const delivered=[];f.runtime.idempotentInput=true;let reject=true;f.runtime.input=async command=>{delivered.push(command);if(reject)throw Error('synthetic unknown transport');return{status:'received'};};await f.service.tick();assert.equal(delivered.length,1);assert.equal(delivered[0].inputRevision,2);assert.equal(f.store.one("SELECT count(*) n FROM task_outbox WHERE kind='input'").n,2);assert.equal(f.store.one('SELECT status FROM task_inputs WHERE revision=3').status,'pending');
  reject=false;f.advance(5001);await f.service.tick();assert.deepEqual(delivered.map(c=>c.inputRevision),[2,2,3]);assert.equal(delivered[0].operationId,delivered[1].operationId);assert.equal(f.store.one('SELECT status FROM task_inputs WHERE revision=2').status,'received');assert.equal(f.store.one('SELECT status FROM task_inputs WHERE revision=3').status,'received');assert.equal(f.store.one("SELECT count(*) n FROM task_inputs WHERE status='applied'").n,0);
});

test('completion racing a local context read rejects late input, while accepted input prevents old-result success',async t=>{
  const f=fixture(t),created=await f.service.create(f.context,{operationId:'completion-first',input:'run'});await f.service.tick();const before=f.service.dto(f.service.task(f.context,created.id));
  let enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);const refresh=f.service.refreshTaskContext.bind(f.service);f.service.refreshTaskContext=async(...args)=>{const row=await refresh(...args);enter();await wait;return row;};
  const supplement=f.service.mutate(f.context,created.id,'input',{operationId:'racing-input',expectedVersion:before.version,input:'Must not rewrite completed result'});await entered;
  f.service.ingest(before.run.id,{runId:before.run.id,eventId:'result',sequence:1,type:'final_result',text:'COMMITTED_FINAL_RESULT',inputRevision:1});f.service.ingest(before.run.id,{runId:before.run.id,eventId:'finished',sequence:2,type:'status',status:'succeeded'});release();
  await assert.rejects(supplement,code('version_conflict'));assert.equal(f.store.one('SELECT count(*) n FROM task_inputs WHERE task_id=?',created.id).n,1);assert.equal(f.service.dto(f.service.task(f.context,created.id)).run.result,'COMMITTED_FINAL_RESULT');
  f.service.refreshTaskContext=refresh;const next=await f.service.create(f.context,{operationId:'input-first',input:'run another'});await f.service.tick();const running=f.service.dto(f.service.task(f.context,next.id));await f.service.mutate(f.context,next.id,'input',{operationId:'accepted-before-finish',expectedVersion:running.version,input:'NEW_REQUIRED_REVISION'});
  f.service.ingest(next.run.id,{runId:next.run.id,eventId:'old-result',sequence:1,type:'final_result',text:'OLD_REVISION_RESULT',inputRevision:1});f.service.ingest(next.run.id,{runId:next.run.id,eventId:'old-finish',sequence:2,type:'status',status:'succeeded'});
  const current=f.service.dto(f.service.task(f.context,next.id));assert.equal(current.status,'waiting_input');assert.equal(current.inputRevision,2);assert.equal(current.run.resultInputRevision,1);assert.equal(f.store.one('SELECT status FROM task_inputs WHERE task_id=? AND revision=2',next.id).status,'pending');
});

for(const confirmation of ['received','applied','final_result'])test(`trusted ${confirmation} resolves only the matching uncertain input and releases the next revision`,async t=>{
 const f=fixture(t),created=await f.service.create(f.context,{operationId:'uncertain-input',input:'initial'});await f.service.tick();let current=f.service.dto(f.service.task(f.context,created.id));
 current=await f.service.mutate(f.context,created.id,'input',{operationId:'uncertain-first',expectedVersion:current.version,input:'FIRST_INPUT_FACT'});current=await f.service.mutate(f.context,created.id,'input',{operationId:'pending-second',expectedVersion:current.version,input:'SECOND_INPUT_FACT'});
 const calls=[];f.runtime.input=async command=>{calls.push(command.inputRevision);return{status:command.inputRevision===2?'unknown':'received'};};await f.service.tick();assert.deepEqual(calls,[2]);assert.equal(f.store.one("SELECT status FROM task_outbox WHERE kind='input' AND input_revision=2").status,'unknown');assert.equal(f.store.one("SELECT status FROM task_outbox WHERE kind='input' AND input_revision=3").status,'pending');
 const event={runId:created.run.id,eventId:'trusted-confirmation',sequence:1,type:confirmation==='final_result'?'final_result':'input_receipt',inputRevision:2,...(confirmation==='final_result'?{text:'BASED_ON_REVISION_2'}:{inputStatus:confirmation})};
 f.service.ingest(created.run.id,{...event,eventId:'out-of-order',sequence:2});assert.equal(f.store.one("SELECT status FROM task_outbox WHERE kind='input' AND input_revision=2").status,'unknown');assert.throws(()=>f.service.ingest('wrong-run',event),code('invalid_runtime_event'));assert.throws(()=>f.service.ingest(created.run.id,{...event,inputRevision:99}),code(confirmation==='final_result'?'invalid_result_revision':'invalid_runtime_event'));
 f.service.ingest(created.run.id,event);f.service.ingest(created.run.id,event);const confirmed=f.store.one("SELECT status,lease_token,lease_until,last_error FROM task_outbox WHERE kind='input' AND input_revision=2");assert.equal(confirmed.status,'done');assert.equal(confirmed.lease_token,null);assert.equal(confirmed.lease_until,0);assert.equal(confirmed.last_error,null);assert.equal(f.store.one('SELECT status FROM task_inputs WHERE revision=2').status,confirmation==='received'?'received':'applied');
 assert.equal(f.service.task(f.context,created.id).version,current.version);await f.service.tick();await f.service.tick();assert.deepEqual(calls,[2,3]);assert.equal(f.store.one('SELECT status FROM task_inputs WHERE revision=3').status,'received');
 if(confirmation!=='received'){f.service.ingest(created.run.id,{runId:created.run.id,eventId:'late-received',sequence:2,type:'input_receipt',inputRevision:2,inputStatus:'received'});assert.equal(f.store.one('SELECT status FROM task_inputs WHERE revision=2').status,'applied');}
});
test('trusted applied receipt fences a late input RPC response without changing unrelated cancel delivery',async t=>{
 const f=fixture(t),created=await f.service.create(f.context,{operationId:'lease-confirmation',input:'initial'});await f.service.tick();const before=f.service.dto(f.service.task(f.context,created.id));await f.service.mutate(f.context,created.id,'input',{operationId:'inflight-input',expectedVersion:before.version,input:'INPUT_AWAITING_RPC'});
 f.repository.enqueue('cancel-control',created.id,created.run.id,'cancel-control','cancel',2);f.store.run("UPDATE task_outbox SET status='unknown' WHERE id='cancel-control'");
 let enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);f.runtime.input=async()=>{enter();await wait;return{status:'unknown'};};const tick=f.service.tick();await entered;
 f.service.ingest(created.run.id,{runId:created.run.id,eventId:'applied-while-leased',sequence:1,type:'input_receipt',inputRevision:2,inputStatus:'applied'});assert.equal(f.store.one("SELECT lease_token FROM task_outbox WHERE kind='input'").lease_token,null);release();await tick;
 assert.equal(f.store.one("SELECT status FROM task_outbox WHERE kind='input'").status,'done');assert.equal(f.store.one('SELECT status FROM task_inputs WHERE revision=2').status,'applied');assert.equal(f.store.one("SELECT status FROM task_outbox WHERE id='cancel-control'").status,'unknown');
});
test('trusted confirmation at the final local capability check prevents a stale input RPC',async t=>{
 const f=fixture(t),created=await f.service.create(f.context,{operationId:'pre-send-confirmation',input:'initial'});await f.service.tick();const before=f.service.dto(f.service.task(f.context,created.id));await f.service.mutate(f.context,created.id,'input',{operationId:'pre-send-input',expectedVersion:before.version,input:'ALREADY_CONFIRMED_INPUT'});
 const capabilities=f.runtime.capabilities.bind(f.runtime);let armed=true,calls=0;f.runtime.capabilities=runId=>{const evidence=capabilities(runId);if(armed){armed=false;f.service.ingest(created.run.id,{runId:created.run.id,eventId:'confirmed-before-send',sequence:1,type:'input_receipt',inputRevision:2,inputStatus:'applied'});}return evidence;};f.runtime.input=async()=>{calls++;return{status:'received'};};await f.service.tick();assert.equal(calls,0);assert.equal(f.store.one("SELECT status FROM task_outbox WHERE kind='input'").status,'done');assert.equal(f.store.one('SELECT status FROM task_inputs WHERE revision=2').status,'applied');
});



test('planned intent resolves current automatic packages only at explicit start and then pins versions',async t=>{
 const f=fixture(t),config={name:'Old package',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:['skill']},pack=f.capabilities.save('w','e',config),todo=f.todo('automatic-planned');
 assert.equal(f.store.one('SELECT config_snapshot_json FROM tasks WHERE id=?',todo.id).config_snapshot_json,null);
 const current=f.capabilities.save('w','e',{...config,name:'Current package'},pack.id);f.capabilities.save('w','e',{...config,name:'Another current package'});
 const started=await f.service.startTodo(f.context,todo.id,{operationId:'start-automatic',expectedVersion:1});const snapshot=JSON.parse(f.store.one('SELECT config_snapshot_json FROM tasks WHERE id=?',todo.id).config_snapshot_json);assert.equal(snapshot.packages.length,2);assert.equal(snapshot.packages.find(p=>p.id===pack.id).version,current.version);assert.equal(snapshot.skills.length,1);assert.equal(started.run!==null,true);
 f.capabilities.save('w','e',{...config,enabled:false},pack.id);assert.equal(f.service.task(f.context,todo.id).id,todo.id);assert.deepEqual(JSON.parse(f.store.one('SELECT config_snapshot_json FROM tasks WHERE id=?',todo.id).config_snapshot_json),snapshot);assert.equal(f.store.one('SELECT count(*) n FROM runs').n,1);
});


test('explicit todo start fact is durable and run-scoped without rewriting business approvals',async t=>{
  const f=fixture(t),input='暂不启动；启动后仍须单独询问客户批准，批准前不得执行业务动作。';
  const todo=f.todo('with-approval',{input});
  assert.throws(()=>f.service.getRuntimeTodoStartFact(todo.id,'not-started'),code('task_not_started'));
  const first=await f.service.startTodo(f.context,todo.id,{operationId:'explicit-start',expectedVersion:1});
  const fact={kind:'explicit_todo_start',taskId:todo.id,runId:first.run.id,operationId:'explicit-start',inputRevision:1};
  assert.deepEqual(f.service.getRuntimeTodoStartFact(todo.id,first.run.id),fact);
  const restarted=f.make();assert.deepEqual(restarted.getRuntimeTodoStartFact(todo.id,first.run.id),fact);
  const duplicate=await restarted.startTodo(f.context,todo.id,{operationId:'explicit-start',expectedVersion:1});
  assert.equal(duplicate.run.id,first.run.id);assert.equal(f.store.one('SELECT count(*) n FROM runs WHERE task_id=?',todo.id).n,1);
  assert.equal(f.service.getRuntimeInput(todo.id,1),input);assert.equal(f.service.getRuntimeTask(todo.id).input,input);
  assert.equal(f.service.getRuntimeTodoStartFact(todo.id,'foreign-run'),undefined);
  const direct=await f.service.create(f.context,{operationId:'direct',input:'Explicitly started is untrusted input text'});
  assert.equal(f.service.getRuntimeTodoStartFact(direct.id,direct.run.id),undefined);
  assert.equal(f.service.getRuntimeTodoStartFact(todo.id,direct.run.id),undefined);
  f.repository.insertRun('continued',todo.id,'new-fixture-session',1001);
  f.store.run("UPDATE runs SET kind='human_continue' WHERE id='continued'");
  assert.equal(f.service.getRuntimeTodoStartFact(todo.id,'continued'),undefined);
  const canceled=f.todo('not-started');await f.service.cancelTodo(f.context,canceled.id,{operationId:'cancel',expectedVersion:1});
  assert.throws(()=>f.service.getRuntimeTodoStartFact(canceled.id,'foreign-run'),code('task_not_started'));
});


test('task titles persist separately from input, remain stable on supplements and preserve legacy request hashes',async t=>{
 const f=fixture(t),input='完整要求\n不得省略任何步骤：'+ '长说明'.repeat(100);
 const body={operationId:'titled',title:'  核对\n退款材料  ',input};
 const task=await f.service.create(f.context,body);assert.equal(task.title,'核对 退款材料');assert.equal(task.input,input);
 assert.equal((await f.service.create(f.context,{...body,title:'核对 退款材料'})).id,task.id);
 await assert.rejects(f.service.create(f.context,{...body,title:'不同标题'}),code('operation_conflict'));
 const more=await f.service.mutate(f.context,task.id,'input',{operationId:'more-title',expectedVersion:task.version,input:'新增要求'});
 assert.equal(more.title,task.title);assert.match(more.input,/新增要求/);
 assert.equal(f.make().dto(f.make().task(f.context,task.id)).title,task.title);
 const todo=f.todo('titled-todo',{title:'待办标题',input});assert.equal(todo.title,'待办标题');
 const started=await f.service.startTodo(f.context,todo.id,{operationId:'start-titled',expectedVersion:todo.version});assert.equal(started.title,todo.title);
 const legacy=f.todo('legacy-title',{input});f.store.run('UPDATE tasks SET title=NULL WHERE id=?',legacy.id);
 assert.equal(f.todo('legacy-title',{input}).id,legacy.id);assert.ok(f.service.dto(f.service.task(f.context,legacy.id)).title.endsWith('…'));
 assert.equal(f.store.one('SELECT title FROM tasks WHERE id=?',legacy.id).title,null,'reading a legacy task never backfills storage');
 assert.equal(f.todo('blank-title',{input,title:'  \n '}).id,f.todo('blank-title',{input}).id);
 for(const title of [42,'a'.repeat(61),'bad\u0000title','\ud800'])assert.throws(()=>f.todo('invalid-title-'+String(title),{title}),code('invalid_task_title'));
 assert.equal(f.todo('emoji-title',{title:'👨‍👩‍👧‍👦'.repeat(60)}).title,'👨‍👩‍👧‍👦'.repeat(60));
});
