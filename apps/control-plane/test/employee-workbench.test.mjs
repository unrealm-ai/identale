import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../dist/server.js';
import {Store} from '../dist/store.js';
import {SqliteConversationRepository} from '../dist/adapters/sqlite/conversation-repository.js';
import {JsonlJournal} from '@dentity/runtime-builtin';
import {ingressFixture} from './helpers/ingress-fixture.mjs';
import {randomUUID} from 'node:crypto';

const origin = 'http://127.0.0.1:5173';
const password = 'Synthetic local test password 2026!';
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dentity-accounts-'));
  const path = join(dir, 'test.sqlite');
  let now = 1800000000000;
  const serverOptions={ databasePath:path,origin,now:()=>now,sessionTtlMs:3600000,...options };
  let app=createServer(serverOptions);
  await app.ready();
  const db = new DatabaseSync(path);
  t.after(async () => { db.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const call = (method, url, body, cookie) => app.inject({ method, url, ...(body === undefined ? {} : { payload: body }), headers: { origin: options.origin ?? origin, ...(cookie ? { cookie } : {}) } });
  const register = async (username, extra = {}) => {
    const response = await call('POST', '/api/auth/register', { username, password, ...extra });
    assert.equal(response.statusCode, 201, response.body);
    return { ...response.json(), cookie: response.headers['set-cookie'].split(';')[0], response };
  };
  return { app, db, path, call, register, restart:async()=>{await app.close();app=createServer(serverOptions);await app.ready();}, advance: ms => { now += ms; } };
}


async function employee(t,options={}){const f=await setup(t,{pollIntervalMs:0,maintenance:{enabled:false},...options}),owner=await f.register('workbench-owner'),root=`/api/workspaces/${owner.workspace.id}`,entity=(await f.call('POST',root+'/entities',{name:'Workbench employee',ownWebUse:true},owner.cookie)).json().entity,base=root+'/entities/'+entity.id;const request=(method,path,body)=>f.call(method,base+path,body,owner.cookie);return {...f,owner,root,entity,base,request};}
function conversation(f){const store=new Store(f.path);try{const journal=new JsonlJournal({root:join(f.path,'..','builtin-records'),ownerId:JSON.stringify([store.databaseId,store.databasePath]),serialize:fn=>store.transaction(fn)}),r=new SqliteConversationRepository(store,journal);r.initialize(0);const id=randomUUID();r.create(id,{workspaceId:f.owner.workspace.id,entityId:f.entity.id,userId:f.owner.user.id},'fixture:'+id,1800000000000,'real',0);r.addMessage('history:'+id,r.get(id),'user','Authorized retained context',1800000000000,false);return id;}finally{store.close();}}

test('employee state is reversible, versioned, cross-workspace protected and keeps authorized history',async t=>{
 const f=await employee(t),id=conversation(f),before=f.db.prepare('SELECT count(*) n FROM conversations').get().n;
 const disabled=await f.request('PUT','/status',{enabled:false,expectedRevision:1});assert.equal(disabled.statusCode,200,disabled.body);assert.equal(disabled.json().entity.enabled,false);assert.equal(disabled.json().entity.lifecycleRevision,2);
 assert.equal((await f.request('GET',`/conversations/${id}/messages`)).statusCode,200);
 assert.equal((await f.request('POST',`/conversations/${id}/turns`,{operationId:'disabled-turn',text:'must not dispatch'})).json().error,'employee_disabled');
 assert.equal((await f.request('POST',`/conversations/${id}/todos`,{operationId:'disabled-todo',input:'must not create'})).json().error,'employee_disabled');
 assert.equal((await f.request('PUT','/status',{enabled:true,expectedRevision:1})).statusCode,409);
 const other=await f.register('outside-owner');assert.equal((await f.call('PUT',`/api/workspaces/${other.workspace.id}/entities/${f.entity.id}/status`,{enabled:true,expectedRevision:2},other.cookie)).statusCode,404);
 assert.equal((await f.request('PUT','/status',{enabled:true,expectedRevision:2})).json().entity.enabled,true);assert.equal(f.db.prepare('SELECT count(*) n FROM conversations').get().n,before);
});

test('ordinary member retains employee/package management and concurrent versions choose one transition',async t=>{
 const f=await employee(t),invite=(await f.call('POST',f.root+'/invitations',{},f.owner.cookie)).json(),member=await f.register('member-user',{invitationToken:invite.token});
 // Registration uses the existing invitation contract; explicit acceptance handles independent registration too.
 if(member.workspace.id!==f.owner.workspace.id)await f.call('POST','/api/invitations/accept',{token:invite.token},member.cookie);
 assert.equal((await f.call('PUT',f.base+'/status',{enabled:false,expectedRevision:1},member.cookie)).statusCode,200);assert.equal((await f.request('PUT','/status',{enabled:true,expectedRevision:2})).statusCode,200);
 const pack=(await f.request('POST','/capability-packages',{name:'Owner status only',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[]})).json();assert.equal((await f.call('PUT',f.base+'/capability-packages/'+pack.id+'/status',{enabled:false,expectedVersion:pack.version},member.cookie)).statusCode,200);
 const outsider=await f.register('package-outsider');assert.equal((await f.call('PUT',`/api/workspaces/${outsider.workspace.id}/entities/${f.entity.id}/capability-packages/${pack.id}/status`,{enabled:false,expectedVersion:pack.version},outsider.cookie)).statusCode,404);
 const results=await Promise.all([f.request('PUT','/status',{enabled:false,expectedRevision:3}),f.request('PUT','/status',{enabled:false,expectedRevision:3})]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
});

test('planned work is retained but active or unknown task states reject employee disable',async t=>{
 const f=await employee(t),id=conversation(f),todo=(await f.request('POST',`/conversations/${id}/todos`,{operationId:'planned',input:'retained planned work'})).json().task;
 for(const status of ['queued','running','waiting_input','waiting_approval','cancel_requested','unknown']){f.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status,todo.id);const r=await f.request('PUT','/status',{enabled:false,expectedRevision:1});assert.equal(r.statusCode,409,status);assert.equal(r.json().error,'employee_has_pending_work');}
 f.db.prepare("UPDATE tasks SET status='planned' WHERE id=?").run(todo.id);assert.equal((await f.request('PUT','/status',{enabled:false,expectedRevision:1})).statusCode,200);assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(todo.id).status,'planned');
});

test('reply and sending/unknown delivery all block disable without changing state',async t=>{
 let channels;const f=await employee(t,{channelIngressFactory:ingressFixture().factory,onEmployeeChannelService:s=>channels=s,employeeChannels:{masterKey:Buffer.alloc(32,21),verifyApplication:async(_p,appId)=>({identity:{appId,tenantId:'synthetic-tenant',tenantIdNamespace:'tenant_key'},botId:'synthetic-bot',eventTenantId:'synthetic-tenant',directoryStatus:'available'})}}),id=conversation(f);const channel=await channels.save(f.owner.workspace.id,f.entity.id,'feishu',f.owner.user.id,{appId:'synthetic-memory-status',appSecret:'synthetic-memory-secret',expectedRevision:0});f.db.prepare("INSERT INTO interaction_turns(id,conversation_id,operation_id,input_hash,mode,status,created_at,epoch) VALUES('busy-turn',?,'busy-op','h','real','preparing',1800000000000,1)").run(id);
 assert.equal((await f.request('PUT','/status',{enabled:false,expectedRevision:1})).json().error,'employee_has_pending_work');f.db.prepare("UPDATE interaction_turns SET status='failed' WHERE id='busy-turn'").run();
 const scope=JSON.stringify({workspaceId:f.owner.workspace.id,entityId:f.entity.id,userId:f.owner.user.id});
 for(const status of ['queued','sending','blocked','accepted','unknown']){f.db.prepare("INSERT OR REPLACE INTO channel_message_receipts(id,kind,lane,connection_id,status,created_at,updated_at) VALUES('pending-output','outbox','test',?,?,1800000000000,1800000000000)").run(channel.id,status);assert.equal((await f.request('PUT','/status',{enabled:false,expectedRevision:1})).json().error,'employee_has_pending_work');}
 assert.equal(f.db.prepare('SELECT lifecycle_enabled FROM entities WHERE id=?').get(f.entity.id).lifecycle_enabled,1);
});

test('disabling preserves bot uniqueness, stops fake ingress, and restore never automatically enables a channel',async t=>{
 const ingress=ingressFixture();let channels,supervisor;const f=await employee(t,{channelIngressFactory:ingress.factory,onEmployeeChannelService:s=>{channels=s},onChannelIngressSupervisor:s=>{supervisor=s},employeeChannels:{masterKey:Buffer.alloc(32,21),verifyApplication:async(p,appId)=>({identity:{appId,tenantId:'synthetic-tenant',tenantIdNamespace:'tenant_key'},botId:'synthetic-bot',eventTenantId:'synthetic-tenant',directoryStatus:'available'})}});
 const channel=await channels.save(f.owner.workspace.id,f.entity.id,'feishu',f.owner.user.id,{appId:'synthetic-status-app',appSecret:'synthetic-status-secret',expectedRevision:0});await supervisor.tick();const live=await ingress.current(channel.id);
 assert.equal((await f.request('PUT','/status',{enabled:false,expectedRevision:1})).statusCode,200);await new Promise(r=>setImmediate(r));assert.equal(live.stopped,true);assert.equal(channels.repository.byId(channel.id).enabled,false);assert.throws(()=>channels.repository.assertAvailable({provider:'feishu',appId:'synthetic-status-app'}));
 assert.equal((await f.request('PUT','/channels/feishu/settings',{enabled:true,expectedRevision:2})).json().error,'employee_disabled');
 assert.equal((await f.request('PUT','/status',{enabled:true,expectedRevision:2})).statusCode,200);await supervisor.tick();assert.equal(channels.repository.byId(channel.id).enabled,false);assert.equal(ingress.all.length,1);
});

test('task context is a bounded authorized projection; planned and expired snapshots never expose raw configuration',async t=>{
 const f=await employee(t),id=conversation(f),otherId=conversation(f),todo=(await f.request('POST',`/conversations/${id}/todos`,{operationId:'context-todo',input:'Context task',contextMode:'fork',historyMessageIds:[]})).json().task,path=`/conversations/${id}/tasks/${todo.id}/context`;
 assert.equal((await f.request('GET',path)).json().status,'not_started');
 const messages=[{id:'allowed-history',role:'user',text:'Authorized task snapshot',privateField:'must not expose'}];f.db.prepare("UPDATE tasks SET status='succeeded',snapshot_json=?,context_mode='fork' WHERE id=?").run(JSON.stringify(messages),todo.id);
 const read=await f.request('GET',path);assert.equal(read.statusCode,200,read.body);assert.deepEqual(read.json().messages,[{id:'allowed-history',role:'user',text:'Authorized task snapshot'}]);assert.ok(!read.body.includes('privateField'));
 assert.equal((await f.request('GET',`/conversations/${otherId}/tasks/${todo.id}/context`)).statusCode,404);
 f.db.prepare('UPDATE tasks SET snapshot_expires_at=1 WHERE id=?').run(todo.id);const expired=await f.request('GET',path);assert.equal(expired.json().status,'expired');assert.deepEqual(expired.json().messages,[]);
});

test('package status compare-and-swap preserves resources, denies stale changes and never revives old snapshots',async t=>{
 const f=await employee(t),body={name:'Status package',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[]},pack=(await f.request('POST','/capability-packages',body)).json();
 const result=await f.request('PUT',`/capability-packages/${pack.id}/status`,{enabled:false,expectedVersion:pack.version});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().enabled,false);assert.deepEqual(result.json().resourceIds,[]);assert.equal(result.json().name,pack.name);
 assert.equal((await f.request('PUT',`/capability-packages/${pack.id}/status`,{enabled:true,expectedVersion:pack.version})).statusCode,409);
 assert.equal((await f.request('PUT',`/capability-packages/${pack.id}`,{...body,expectedVersion:pack.version})).statusCode,409);
 assert.equal((await f.request('GET','/usable-capabilities')).json().packages.length,0);
 const enabled=await f.request('PUT',`/capability-packages/${pack.id}/status`,{enabled:true,expectedVersion:result.json().version});assert.equal(enabled.json().version,pack.version+2);
});

test('an async channel verification started before employee disable cannot reconnect afterward',async t=>{
 let channels,entered=false,release;const gate=new Promise(r=>release=r);t.after(()=>release());const ingress=ingressFixture();
 const f=await employee(t,{channelIngressFactory:ingress.factory,onEmployeeChannelService:s=>channels=s,employeeChannels:{masterKey:Buffer.alloc(32,21),verifyApplication:async(p,appId)=>{entered=true;await gate;return{identity:{appId,tenantId:'synthetic-tenant',tenantIdNamespace:'tenant_key'},botId:'synthetic-bot',eventTenantId:'synthetic-tenant',directoryStatus:'available'}}}});
 const pending=channels.save(f.owner.workspace.id,f.entity.id,'feishu',f.owner.user.id,{appId:'late-app',appSecret:'synthetic-late-secret',expectedRevision:0});const rejected=assert.rejects(pending,e=>e.code==='channel_connection_conflict');while(!entered)await new Promise(r=>setImmediate(r));
 assert.equal((await f.request('PUT','/status',{enabled:false,expectedRevision:1})).statusCode,200);release();await rejected;assert.equal(channels.repository.list(f.owner.workspace.id,f.entity.id).length,0);assert.equal(ingress.all.length,0);
});


test('undiscovered and pending completion work blocks disable, persisted status survives service restart',async t=>{
 const f=await employee(t),id=conversation(f),todo=(await f.request('POST',`/conversations/${id}/todos`,{operationId:'notify-retained',input:'Completed fixture'})).json().task,runId=randomUUID();
 f.db.prepare("INSERT INTO runs(id,task_id,session_id,status,created_at) VALUES(?,?,?,'succeeded',1800000000000)").run(runId,todo.id,randomUUID());f.db.prepare("UPDATE tasks SET status='succeeded',run_id=? WHERE id=?").run(runId,todo.id);
 assert.equal((await f.request('PUT','/status',{enabled:false,expectedRevision:1})).json().error,'employee_has_pending_work','not-yet-discovered completion must not be lost');
 f.db.prepare("INSERT INTO task_completion_notifications(id,task_id,run_id,conversation_id,scope_json,result_ref,status,created_at) VALUES('retained-completion',?,?,?,'{}','','pending',1800000000000)").run(todo.id,runId,id);
 for(const state of ['pending','leased']){f.db.prepare("UPDATE task_completion_notifications SET status=? WHERE id='retained-completion'").run(state);assert.equal((await f.request('PUT','/status',{enabled:false,expectedRevision:1})).json().error,'employee_has_pending_work');}
 f.db.prepare("UPDATE task_completion_notifications SET status='succeeded' WHERE id='retained-completion'").run();assert.equal((await f.request('PUT','/status',{enabled:false,expectedRevision:1})).statusCode,200);await f.restart();
 const restored=await f.request('GET','/configuration');assert.equal(restored.json().entity.enabled,false);assert.equal(restored.json().entity.lifecycleRevision,2);assert.equal((await f.request('GET',`/conversations/${id}/messages`)).statusCode,200);assert.equal((await f.request('POST',`/conversations/${id}/todos`,{operationId:'after-restart',input:'Cannot admit'})).json().error,'employee_disabled');
 assert.equal((await f.request('PUT','/status',{enabled:true,expectedRevision:2})).statusCode,200);assert.equal(f.db.prepare('SELECT count(*) n FROM runs WHERE id=?').get(runId).n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM task_completion_notifications').get().n,1);
});
