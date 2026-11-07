import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../dist/store.js';
import {EmployeeLifecycleController,employeeHasPendingWork,registerLifecycleControl,remoteLifecycleTransition} from '../dist/split/lifecycle-control.js';
import {SqliteConversationRepository} from '../dist/adapters/sqlite/conversation-repository.js';
import {SqliteTaskRepository} from '../dist/adapters/sqlite/task-repository.js';
import {SqliteTaskCompletionNotifications} from '../dist/adapters/sqlite/task-completion-notifications.js';
import {SqliteScheduleRepository} from '../dist/adapters/sqlite/schedule-repository.js';
import {SqliteMessageLoopRepository} from '../dist/channel-loop/repository.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {JsonlJournal} from '@dentity/runtime-builtin';
import {TaskError} from '@dentity/application';
import {authorizeService} from '../dist/split/service-transport.js';

const scope={workspaceId:'w',entityId:'e'},request={...scope,actorId:'u',enabled:false,expectedRevision:1},reservation={...scope,operationId:'operation-one',enabled:false,expectedRevision:1};
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'identity-lifecycle-fence-')),path=join(dir,'runtime.sqlite');let store=new Store(path);
 store.run("INSERT INTO users VALUES('u','owner','Owner','active')");store.run("INSERT INTO workspaces VALUES('w','Workspace','u','active')");store.run("INSERT INTO members VALUES('m','w','u','owner','active')");
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin-interaction')");
 const journal=new JsonlJournal({root:join(dir,'journal'),ownerId:'isolated-lifecycle',serialize:fn=>store.transaction(fn)}),conversations=new SqliteConversationRepository(store,journal);conversations.initialize(0);
 const channels=new SqliteMessageLoopRepository(store);new EmployeeChannelRepository(store);new SqliteScheduleRepository(store);new SqliteTaskCompletionNotifications(store,conversations,channels);
 conversations.create('c',{...scope,userId:'u'},'fixture-conversation',1,'real',0);
 const changed=[],options=()=>({store,now:()=>100,onFenceChanged:(...ids)=>changed.push(ids)});let control=new EmployeeLifecycleController(options());
 t.after(async()=>{channels.close();store.close();await rm(dir,{recursive:true,force:true});});
 return{get store(){return store;},get control(){return control;},path,changed,task(){new SqliteTaskRepository(store).insertPlannedTask('t',{...scope,userId:'u',conversationId:'c'},'op-task','hash','Isolated retained work','new','[]','[]',null,1);},restart(){channels.close();store.close();store=new Store(path);control=new EmployeeLifecycleController(options());},enabled(){return store.one("SELECT lifecycle_enabled FROM entities WHERE id='e'").lifecycle_enabled;},fences(){return store.all('SELECT * FROM employee_lifecycle_fences');}};
}
const denied=fn=>assert.throws(fn,error=>error instanceof TaskError&&error.code==='employee_has_pending_work');
test('reservation preserves original task busy states while retaining planned work',async t=>{
 const f=await fixture(t);f.task();for(const state of ['queued','running','waiting_input','waiting_approval','cancel_requested','unknown']){f.store.run("UPDATE tasks SET status=? WHERE id='t'",state);denied(()=>f.control.reserve(reservation));assert.equal(f.enabled(),1);assert.equal(f.fences().length,0);}
 f.store.run("UPDATE tasks SET status='planned' WHERE id='t'");assert.equal(f.control.reserve(reservation).reserved,true);assert.equal(f.enabled(),0);assert.equal(f.store.one("SELECT status FROM tasks WHERE id='t'").status,'planned');
});
test('active interaction, in-flight receipt and running scheduled job each prevent disable',async t=>{
 const f=await fixture(t);
 f.store.run("INSERT INTO interaction_turns(id,conversation_id,operation_id,input_hash,mode,status,created_at,epoch) VALUES('turn','c','op-turn','h','real','preparing',1,1)");denied(()=>f.control.reserve(reservation));f.store.run("UPDATE interaction_turns SET status='failed'");
 f.store.run("INSERT INTO employee_channel_connections(id,workspace_id,entity_id,provider,app_id,revision,state_version,record_json) VALUES('channel','w','e','feishu','isolated-app',1,1,'{}')");
 for(const state of ['queued','leased','waiting','blocked','sending','accepted','unknown']){f.store.run("INSERT OR REPLACE INTO channel_message_receipts(id,kind,lane,connection_id,status,created_at,updated_at) VALUES('receipt','outbox','lane','channel',?,1,1)",state);denied(()=>f.control.reserve(reservation));}
 f.store.run('DELETE FROM channel_message_receipts');f.store.run("INSERT INTO scheduled_jobs(id,job_key,handler,payload_json,status,created_at,updated_at) VALUES('job','key','summary',?,'running',1,1)",JSON.stringify({session:{runtime:scope}}));denied(()=>f.control.reserve(reservation));f.store.run("UPDATE scheduled_jobs SET status='queued'");assert.equal(employeeHasPendingWork(f.store,'w','e',100),false);
});
test('pending dispatch and completion delivery preserve busy guards including undiscovered terminal result',async t=>{
 const f=await fixture(t);f.task();const repo=new SqliteTaskRepository(f.store);repo.insertRun('r','t','session',1);f.store.run("UPDATE tasks SET run_id='r' WHERE id='t'");repo.enqueue('outbox','t','r','dispatch','dispatch',1);
 denied(()=>f.control.reserve(reservation));f.store.run("UPDATE task_outbox SET status='sent'");f.store.run("UPDATE tasks SET status='succeeded' WHERE id='t'");denied(()=>f.control.reserve(reservation));
 f.store.run("INSERT INTO task_completion_notifications(id,task_id,run_id,conversation_id,scope_json,result_ref,status,created_at) VALUES('completion','t','r','c','{}','result','published',1)");assert.equal(employeeHasPendingWork(f.store,'w','e',100),false);
 for(const status of ['pending','leased']){f.store.run("UPDATE task_completion_notifications SET status=?",status);denied(()=>f.control.reserve(reservation));}
});
test('same reservation is idempotent and competing transition cannot unlock it',async t=>{
 const f=await fixture(t);assert.equal(f.control.reserve(reservation).reserved,true);assert.equal(f.control.reserve(reservation).reserved,true);assert.equal(f.fences().length,1);
 assert.throws(()=>f.control.reserve({...reservation,operationId:'other'}),/employee_lifecycle_pending/);assert.throws(()=>f.control.release({...scope,operationId:'other',outcome:'rolled_back'}),/employee_lifecycle_pending/);assert.equal(f.enabled(),0);
});
test('unknown outcome survives restart and same revision poll, later lifecycle CAS revision resolves fence',async t=>{
 const f=await fixture(t);f.control.reserve(reservation);f.restart();assert.equal(f.fences().length,1);
 f.store.run("UPDATE entities SET lifecycle_enabled=1 WHERE id='e'");f.control.reconcile();assert.equal(f.enabled(),0);assert.equal(f.fences().length,1,'unchanged platform version cannot prove abort');
 f.store.run("UPDATE entities SET lifecycle_enabled=0,lifecycle_revision=2 WHERE id='e'");f.control.reconcile();assert.equal(f.fences().length,0);assert.equal(f.enabled(),0);
});
test('known rollback restores source state and success acknowledgement alone never unlocks stale config',async t=>{
 const f=await fixture(t);f.control.reserve(reservation);assert.deepEqual(f.control.release({...scope,operationId:reservation.operationId,outcome:'rolled_back'}),{pending:false});assert.equal(f.enabled(),1);assert.equal(f.fences().length,0);
 f.control.reserve(reservation);assert.deepEqual(f.control.release({...scope,operationId:reservation.operationId,outcome:'committed'}),{pending:true});assert.equal(f.enabled(),0);assert.equal(f.fences().length,1);
 assert.throws(()=>f.control.release({...scope,operationId:reservation.operationId,outcome:'rolled_back'}),/employee_lifecycle_pending/);
});
test('enable is fenced until its new platform revision has been applied',async t=>{
 const f=await fixture(t);f.store.run("UPDATE entities SET lifecycle_enabled=0 WHERE id='e'");f.control.reserve({...reservation,enabled:true});assert.equal(f.enabled(),0);
 f.store.run("UPDATE entities SET lifecycle_enabled=1,lifecycle_revision=2 WHERE id='e'");f.control.reconcile();assert.equal(f.enabled(),1);assert.equal(f.fences().length,0);assert.ok(f.changed.length>=2);
});
test('stale expected revision fails before reservation and unchanged state is a no-op',async t=>{
 const f=await fixture(t);assert.throws(()=>f.control.reserve({...reservation,expectedRevision:2}),/employee_state_changed/);assert.equal(f.control.reserve({...reservation,enabled:true}).reserved,false);assert.equal(f.enabled(),1);assert.equal(f.fences().length,0);
});
test('lost reserve acknowledgement is recoverable with a deterministic operation key and does not run work twice',async t=>{
 const f=await fixture(t),seen=[];let lost=true,work=0;
 const transition=remoteLifecycleTransition({url:'http://127.0.0.1:29901',token:'runtime-capability-'.repeat(3),fetch:async(url,init)=>{
  const input=JSON.parse(init.body);seen.push(input.operationId);assert.equal(init.headers['x-dentity-actor'],'u');let data;
  if(url.endsWith('/reserve')){data=f.control.reserve({...scope,...input});if(lost){lost=false;throw Error('ack lost after durable reserve');}}
  else{data=f.control.release({...scope,...input});if(input.outcome==='committed')f.control.reconcile();}
  return new Response(JSON.stringify(data),{status:200});
 }});
 await assert.rejects(transition(request,()=>{work++;}),/employee_lifecycle_unavailable/);assert.equal(work,0);assert.equal(f.fences().length,1);
 const result=await transition(request,()=>{work++;f.store.run("UPDATE entities SET lifecycle_enabled=0,lifecycle_revision=2 WHERE id='e'");return{saved:true};});assert.deepEqual(result,{saved:true});assert.equal(work,1);assert.equal(seen[0],seen[1]);assert.equal(f.fences().length,0);
});
test('failed platform transaction releases reservation, failed release keeps conservative fence',async t=>{
 const f=await fixture(t);let failRelease=false;
 const transition=remoteLifecycleTransition({url:'http://127.0.0.1:29901',token:'runtime-capability-'.repeat(3),fetch:async(url,init)=>{const input=JSON.parse(init.body);if(failRelease&&url.endsWith('/release'))throw Error('offline');const data=url.endsWith('/reserve')?f.control.reserve({...scope,...input}):f.control.release({...scope,...input});return new Response(JSON.stringify(data),{status:200});}});
 await assert.rejects(transition(request,()=>{throw Error('transaction rolled back');}),/transaction rolled back/);assert.equal(f.enabled(),1);assert.equal(f.fences().length,0);
 failRelease=true;await assert.rejects(transition(request,()=>{throw Error('second rollback');}),/second rollback/);assert.equal(f.enabled(),0);assert.equal(f.fences().length,1);
});
test('control API requires service and trusted manager before changing runtime fence',async t=>{
 const f=await fixture(t),app=Fastify(),token='service-token-'.repeat(3);t.after(()=>app.close());app.setErrorHandler((error,_req,reply)=>reply.code(error.status??500).send({error:error.code??error.message}));let refresh=0;
 registerLifecycleControl(app,{controller:f.control,authenticate:r=>authorizeService(r.headers.authorization,token),authorize:r=>{authorizeService(r.headers.authorization,token);if(r.headers['x-dentity-actor']!=='u')throw new TaskError(403,'role_forbidden');},refresh:async()=>{refresh++;}});
 const url='/internal/control/employees/w/e/lifecycle/reserve',payload={operationId:'api-operation',enabled:false,expectedRevision:1};
 assert.equal((await app.inject({method:'POST',url,payload,headers:{'x-dentity-actor':'u'}})).statusCode,401);assert.equal(refresh,0);
 assert.equal((await app.inject({method:'POST',url,payload,headers:{authorization:'Bearer '+token,'x-dentity-actor':'outsider'}})).statusCode,403);assert.equal(f.fences().length,0);
 assert.equal((await app.inject({method:'POST',url,payload,headers:{authorization:'Bearer '+token,'x-dentity-actor':'u'}})).statusCode,200);assert.equal(f.fences().length,1);
});

test('concurrent same-version platform transitions serialize and a losing CAS cannot restore the winner',async t=>{
 const f=await fixture(t);let work=0;
 const transition=remoteLifecycleTransition({url:'http://127.0.0.1:29901',token:'runtime-capability-'.repeat(3),fetch:async(url,init)=>{const input=JSON.parse(init.body);await new Promise(resolve=>setImmediate(resolve));const data=url.endsWith('/reserve')?f.control.reserve({...scope,...input}):f.control.release({...scope,...input});if(input.outcome==='committed')f.control.reconcile();return new Response(JSON.stringify(data),{status:200});}});
 const commit=()=>{work++;f.store.run("UPDATE entities SET lifecycle_enabled=0,lifecycle_revision=2 WHERE id='e'");return{saved:true};};
 const results=await Promise.allSettled([transition(request,commit),transition(request,commit)]);assert.deepEqual(results.map(result=>result.status),['fulfilled','rejected']);assert.equal(work,1);assert.equal(f.enabled(),0);assert.equal(f.fences().length,0);
});
test('platform CAS conflict cannot count as proof that a previously uncertain commit rolled back',async t=>{
 const f=await fixture(t);
 const transition=remoteLifecycleTransition({url:'http://127.0.0.1:29901',token:'runtime-capability-'.repeat(3),fetch:async(url,init)=>{const input=JSON.parse(init.body);assert.ok(url.endsWith('/reserve'),'CAS conflict must leave fence for config revision reconciliation');return new Response(JSON.stringify(f.control.reserve({...scope,...input})),{status:200});}});
 await assert.rejects(transition(request,()=>{throw new TaskError(409,'employee_state_changed');}),/employee_state_changed/);assert.equal(f.enabled(),0);assert.equal(f.fences().length,1);
});

test('split platform lifecycle uses runtime busy facts and applies the committed revision without reading runtime tables',async t=>{
 const {createPlatformServer,createRuntimeServer}=await import('../dist/split/server.js');
 const {DatabaseSync}=await import('node:sqlite');
 const root=await mkdtemp(join(tmpdir(),'identity-lifecycle-services-')),origin='http://127.0.0.1:15173',configurationToken='config-token-'.repeat(4),serviceToken='runtime-token-'.repeat(4);let platform,runtime;
 const transport=async(raw,init={})=>{const url=new URL(String(raw)),target=url.port==='20210'?platform:runtime;if(!target)throw Error('service unavailable');const response=await target.inject({method:init.method??'GET',url:url.pathname+url.search,headers:Object.fromEntries(new Headers(init.headers)),...(init.body===undefined?{}:{payload:init.body})});return new Response([204,304].includes(response.statusCode)?null:response.rawPayload,{status:response.statusCode,headers:response.headers});};
 platform=createPlatformServer({databasePath:join(root,'platform','platform.sqlite'),origin,configurationToken,runtimeService:{url:'http://127.0.0.1:20211',token:serviceToken},transport,directorySync:{automatic:false}});await platform.ready();
 runtime=createRuntimeServer({databasePath:join(root,'runtime','runtime.sqlite'),origin,platformConfig:{url:'http://127.0.0.1:20210',token:configurationToken,pollMs:3600000},serviceToken,transport,directorySync:{automatic:false},triggers:{automatic:false},maintenance:{enabled:false},pollIntervalMs:3600000});await runtime.ready();
 t.after(async()=>{await runtime.close();await platform.close();await rm(root,{recursive:true,force:true});});
 const registered=await platform.inject({method:'POST',url:'/api/auth/register',headers:{origin},payload:{username:'lifecycle-owner',password:'Synthetic lifecycle testing password!'}});assert.equal(registered.statusCode,201,registered.body);const owner=registered.json(),cookie=registered.headers['set-cookie'].split(';')[0],headers={origin,cookie};
 const created=await platform.inject({method:'POST',url:`/api/workspaces/${owner.workspace.id}/entities`,headers,payload:{name:'Isolated lifecycle employee',ownWebUse:true}});assert.equal(created.statusCode,200,created.body);const entity=created.json().entity,path=`/api/workspaces/${owner.workspace.id}/entities/${entity.id}/status`;
 // Do not pre-poll: the control route must refresh before resolving the newly created actor/employee.
 let result=await platform.inject({method:'PUT',url:path,headers,payload:{enabled:false,expectedRevision:1}});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().entity.enabled,false);assert.equal(result.json().entity.lifecycleRevision,2);
 result=await platform.inject({method:'PUT',url:path,headers,payload:{enabled:true,expectedRevision:2}});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().entity.enabled,true);
 const disk=new DatabaseSync(join(root,'runtime','runtime.sqlite'));try{
  assert.equal(disk.prepare("SELECT name FROM sqlite_master WHERE name='entities'").get(),undefined,'no persisted platform tables on runtime');
  assert.equal(disk.prepare('SELECT count(*) n FROM employee_lifecycle_fences').get().n,0);
  disk.prepare("INSERT INTO scheduled_jobs(id,job_key,handler,payload_json,status,created_at,updated_at) VALUES('busy-runtime-job','busy-job','context',?,'running',1,1)").run(JSON.stringify({session:{runtime:{workspaceId:owner.workspace.id,entityId:entity.id}}}));
  result=await platform.inject({method:'PUT',url:path,headers,payload:{enabled:false,expectedRevision:3}});assert.equal(result.statusCode,409,result.body);assert.equal(result.json().error,'employee_has_pending_work');
  disk.prepare("UPDATE scheduled_jobs SET status='succeeded' WHERE id='busy-runtime-job'").run();
  result=await platform.inject({method:'PUT',url:path,headers,payload:{enabled:false,expectedRevision:3}});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().entity.lifecycleRevision,4);
 }finally{disk.close();}
 const config=new DatabaseSync(join(root,'platform','platform.sqlite'),{readOnly:true});try{assert.equal(config.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get(),undefined);assert.equal(config.prepare('SELECT lifecycle_enabled FROM entities WHERE id=?').get(entity.id).lifecycle_enabled,0);}finally{config.close();}
});

test('unified reporting keeps disable fenced while generation is pending or uncertain, without coupling business success to delivery',async t=>{const f=await fixture(t);f.store.db.exec('CREATE TABLE business_notification_jobs(id TEXT PRIMARY KEY,workspace_id TEXT,entity_id TEXT,state TEXT)');f.store.run("INSERT INTO business_notification_jobs VALUES('report','w','e','pending')");for(const state of['pending','generating','ready','unknown']){f.store.run('UPDATE business_notification_jobs SET state=?',state);denied(()=>f.control.reserve(reservation));assert.equal(f.enabled(),1);}for(const state of['published','failed']){f.store.run('UPDATE business_notification_jobs SET state=?',state);assert.equal(employeeHasPendingWork(f.store,'w','e',100),false);}f.store.run("UPDATE business_notification_jobs SET state='pending',workspace_id='other'");assert.equal(employeeHasPendingWork(f.store,'w','e',100),false);});
