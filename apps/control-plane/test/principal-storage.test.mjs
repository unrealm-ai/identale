import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../dist/store.js';
import {migratePrincipalStorage} from '../dist/principal-storage-migration.js';
import {SqliteConversationRepository} from '../dist/adapters/sqlite/conversation-repository.js';
import {SqliteTaskRepository} from '../dist/adapters/sqlite/task-repository.js';
import {TaskService,TaskError,scopeActorKey,conversationOwnerKey,scopeFromJson} from '@dentity/application';
import {JsonlJournal} from '@dentity/runtime-builtin';
function directory(t){const dir=mkdtempSync(join(tmpdir(),'principal-storage-fixture-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function legacy(t,broken=false){const db=new DatabaseSync(join(directory(t),'legacy.sqlite'));t.after(()=>db.close());db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE users(id TEXT PRIMARY KEY);
CREATE TABLE conversations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),channel TEXT NOT NULL DEFAULT 'web',operation_id TEXT NOT NULL,UNIQUE(user_id,entity_id,operation_id));
CREATE TABLE tasks(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,user_id ${broken?'INTEGER':'TEXT'} NOT NULL REFERENCES users(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),operation_id TEXT NOT NULL,source_json TEXT NOT NULL,input TEXT NOT NULL,UNIQUE(user_id,entity_id,operation_id));
CREATE TABLE runs(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id));
CREATE TABLE conversation_message_index(id TEXT PRIMARY KEY,conversation_id TEXT REFERENCES conversations(id),record_ref TEXT);
INSERT INTO users VALUES('u');INSERT INTO conversations VALUES('c','w','e','u','web','op-c');INSERT INTO tasks VALUES('t','w','e','u','c','op-t','{"channelType":"web"}','unchanged input');INSERT INTO runs VALUES('r','t');INSERT INTO conversation_message_index VALUES('m','c','unchanged journal ref');`);return db;}
test('principal migration preserves populated Web data, foreign keys, and repeat startup',t=>{const db=legacy(t);migratePrincipalStorage(db);assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('SELECT input FROM tasks').get().input,'unchanged input');assert.equal(db.prepare('SELECT record_ref FROM conversation_message_index').get().record_ref,'unchanged journal ref');assert.equal(db.prepare('SELECT task_id FROM runs').get().task_id,'t');assert.equal(db.prepare('SELECT actor_key FROM tasks').get().actor_key,JSON.stringify(['platform','u']));assert.equal(db.prepare('PRAGMA table_info(tasks)').all().find(c=>c.name==='user_id').notnull,0);migratePrincipalStorage(db);assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,1);});
test('failed principal migration rolls back schema and contents and restores FK enforcement',t=>{const db=legacy(t,true);assert.throws(()=>migratePrincipalStorage(db),/unsupported_principal_schema/);assert.equal(db.prepare('PRAGMA table_info(conversations)').all().some(c=>c.name==='owner_key'),false);assert.equal(db.prepare('SELECT input FROM tasks').get().input,'unchanged input');assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);});
const channel=(who='alice',patch={})=>({workspaceId:'w',entityId:'e',principal:{kind:'channel',channelType:'feishu',tenantId:'tenant',identityNamespace:'open_id',externalUserId:who},source:{channelType:'feishu',tenantId:'tenant',installationId:'install',applicationId:'app',connectionId:'connection',bindingVersion:'v1',conversationId:'group',conversationKind:'group',replyToMessageId:'message',...patch}});
function fixture(t){const dir=directory(t),store=new Store(join(dir,'db.sqlite'));t.after(()=>store.close());store.db.exec("INSERT INTO users VALUES('u','user','User','active'); INSERT INTO workspaces VALUES('w','Workspace','u','active'); INSERT INTO members(id,workspace_id,user_id,role,status) VALUES('member','w','u','owner','active'); INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Entity','member','member',1,'u','builtin');");const journal=new JsonlJournal({root:join(dir,'journal'),ownerId:'fixture',serialize:fn=>store.transaction(fn)});const conversations=new SqliteConversationRepository(store,journal,()=>1000);conversations.initialize(0);const repository=new SqliteTaskRepository(store);let allowed=true,refreshes=[];const commands=[];const runtime={idempotentDispatch:true,dispatch:async c=>{commands.push(c);return{status:'accepted'};},events:async()=>[],input:async()=>({status:'received'}),cancel:async()=>({status:'confirmed'}),capabilities:runId=>({runId,runtimeId:'fixture',runtimeVersion:'1',bindingVersion:'v1',observedAt:1000,expiresAt:100000,appendInput:'supported',cancel:'supported'})};const authorization={authorizeEntity(s){if(!allowed)throw new TaskError(403,'revoked');scopeActorKey(s);},async refreshAuthorization(s){refreshes.push(s);if(!allowed)throw new TaskError(403,'revoked');}};const tasks=new TaskService(repository,()=>1000,runtime,authorization,undefined,conversations);return{store,conversations,tasks,runtime,commands,refreshes,authorization,setAllowed:v=>allowed=v};}
test('group conversation is shared but task owner and original runtime requester are isolated',async t=>{const f=fixture(t),a={...channel(),conversationId:'c'},b={...channel('bob'),conversationId:'c'};f.conversations.create('c',a,'conversation',1000,'real',0);assert.equal(f.conversations.findConversation('c',b,1000).id,'c');const task=await f.tasks.create(a,{operationId:'create',conversationId:'c',input:'work'});assert.throws(()=>f.tasks.task(b,task.id),/task_not_found/);assert.deepEqual(f.tasks.list(b),[]);assert.equal(f.tasks.findByOperation(b,'create'),undefined);await assert.rejects(f.tasks.mutate(b,task.id,'cancel',{operationId:'cancel',expectedVersion:1}),/task_not_found/);await f.tasks.tick();const {kind,...requester}=a.principal;assert.equal(kind,'channel');assert.deepEqual(f.commands[0].requester,requester);assert.equal(f.tasks.scopeOfTask(f.tasks.getRuntimeTask(task.id)).source.replyToMessageId,'message');assert.equal(f.store.one('SELECT user_id FROM tasks').user_id,null);assert.equal(f.store.one('SELECT count(*) n FROM users').n,1);assert.ok(f.refreshes.some(s=>s.principal.externalUserId==='alice'));});
test('principal keys and group/private boundaries include app connection tenant and namespace',t=>{const a=channel();for(const changed of [channel('alice',{applicationId:'app2'}),channel('alice',{connectionId:'connection2'}),{...a,principal:{...a.principal,tenantId:'other'}},{...a,principal:{...a.principal,identityNamespace:'user_id'}}])assert.notEqual(scopeActorKey(a),scopeActorKey(changed));assert.equal(conversationOwnerKey(a),conversationOwnerKey(channel('bob')));assert.notEqual(conversationOwnerKey(a),conversationOwnerKey(channel('alice',{bindingVersion:'v2'})));assert.equal(scopeActorKey(a),scopeActorKey(channel('alice',{bindingVersion:'v2'})));assert.notEqual(conversationOwnerKey(channel('alice',{conversationKind:'private'})),conversationOwnerKey(channel('bob',{conversationKind:'private'})));const f=fixture(t);f.conversations.create('c',a,'conversation',1000,'real',0);assert.equal(f.conversations.findConversation('c',channel('alice',{bindingVersion:'v2'}),1000),undefined);assert.equal(f.conversations.findConversation('c',channel('alice',{conversationId:'other-group'}),1000),undefined);assert.equal(f.conversations.findConversation('c',channel('alice',{conversationKind:'private'}),1000),undefined);});
test('revocation prevents queued channel dispatch and post-await runtime event ingestion',async t=>{const f=fixture(t),a={...channel(),conversationId:'c'};f.conversations.create('c',a,'conversation',1000,'real',0);const task=await f.tasks.create(a,{operationId:'create',conversationId:'c',input:'work'});f.setAllowed(false);await f.tasks.tick();assert.equal(f.commands.length,0);assert.equal(f.store.one('SELECT status FROM task_outbox').status,'blocked');f.setAllowed(true);f.store.run("UPDATE task_outbox SET status='pending',retry_at=0");f.runtime.events=async runId=>{f.setAllowed(false);return[{eventId:'event',runId,sequence:1,type:'final_result',text:'must not ingest',inputRevision:1}];};await f.tasks.tick();assert.equal(f.commands.length,1);assert.equal(f.store.one('SELECT count(*) n FROM task_updates').n,0);assert.equal(f.store.one('SELECT source_json FROM tasks WHERE id=?',task.id).source_json,JSON.stringify((({conversationId,...s})=>s)(a)));});
test('legacy Web source fallback never invents a channel user',()=>{assert.deepEqual(scopeFromJson('{"channelType":"web"}',{workspaceId:'w',entityId:'e',userId:'u'}),{workspaceId:'w',entityId:'e',userId:'u'});assert.throws(()=>scopeFromJson('{}',{workspaceId:'w',entityId:'e',userId:null}),/missing_persisted/);});

// Exercise real SQLite scope predicates, not just the derived owner-key strings.
// Every operation remains in synthetic temporary storage and uses MockRuntime.
for (const origin of ['private', 'private-topic', 'group', 'group-topic']) {
  test(`todo operation isolation across Feishu private/group/main/topic: ${origin}`, async t => {
    const f = fixture(t);
    const definitions = [
      ['private', 'alice', {conversationKind:'private',conversationId:'dm'}],
      ['private-topic', 'alice', {conversationKind:'private',conversationId:'dm',threadId:'dm-topic-a'}],
      ['private-topic-b', 'alice', {conversationKind:'private',conversationId:'dm',threadId:'dm-topic-b'}],
      ['private-other-user', 'bob', {conversationKind:'private',conversationId:'dm-bob'}],
      ['group', 'alice', {conversationKind:'group',conversationId:'group'}],
      ['group-topic', 'alice', {conversationKind:'group',conversationId:'group',threadId:'group-topic-a'}],
      ['group-topic-b', 'alice', {conversationKind:'group',conversationId:'group',threadId:'group-topic-b'}],
      ['other-group', 'alice', {conversationKind:'group',conversationId:'group-b'}],
    ];
    const scopes = definitions.map(([id, who, source]) => {
      const scope = {...channel(who, source),conversationId:`conversation-${id}`};
      f.conversations.create(scope.conversationId,scope,`conversation-${id}`,1000,'real',0);
      return {id,scope};
    });
    const scope = scopes.find(value => value.id === origin).scope;
    const todo = f.tasks.createTodo(scope,{operationId:'shared-operation',input:'Synthetic deferred work'});
    assert.equal(todo.status,'planned');
    assert.equal(todo.run,null);
    assert.equal(f.store.one('SELECT count(*) n FROM runs').n,0);
    assert.deepEqual((await f.tasks.listPage(scope,{status:'planned'})).tasks.map(value=>value.id),[todo.id]);
    const notFound = error => error.code === 'task_not_found';
    for (const other of scopes.filter(value => value.id !== origin)) {
      assert.deepEqual((await f.tasks.listPage(other.scope,{status:'planned'})).tasks,[],other.id);
      assert.equal(f.tasks.findByOperation(other.scope,'shared-operation'),undefined,other.id);
      for (const read of [()=>f.tasks.task(other.scope,todo.id),()=>f.tasks.getUpdates(other.scope,todo.id),()=>f.tasks.getContext(other.scope,todo.id),()=>f.tasks.activity(other.scope,todo.id,{})]) assert.throws(read,notFound,other.id);
      await assert.rejects(f.tasks.startTodo(other.scope,todo.id,{operationId:'start',expectedVersion:1}),notFound,other.id);
      await assert.rejects(f.tasks.cancelTodo(other.scope,todo.id,{operationId:'cancel',expectedVersion:1}),notFound,other.id);
      for (const kind of ['input','cancel']) await assert.rejects(f.tasks.mutate(other.scope,todo.id,kind,{operationId:`mutate-${kind}`,expectedVersion:1,...(kind==='input'?{input:'Unauthorized addition'}:{})}),notFound,other.id);
    }
    assert.equal(f.store.one('SELECT count(*) n FROM task_operations').n,0);
    assert.equal(f.store.one('SELECT count(*) n FROM runs').n,0);
    const added=await f.tasks.mutate(scope,todo.id,'input',{operationId:'supplement',expectedVersion:1,input:'Authorized addition'});
    assert.equal(added.run,null);
    const body={operationId:'start',expectedVersion:added.version};
    const started=await f.tasks.startTodo(scope,todo.id,body);
    assert.equal((await f.tasks.startTodo(scope,todo.id,body)).run.id,started.run.id);
    assert.equal(f.store.one('SELECT count(*) n FROM runs').n,1);
    // Even an exact replay of the successful operation cannot disclose its receipt elsewhere.
    for (const other of scopes.filter(value=>value.id!==origin)) {
      await assert.rejects(f.tasks.startTodo(other.scope,todo.id,body),notFound);
      assert.throws(()=>f.tasks.getOperationReceipt(other.scope,todo.id,'start'),notFound);
    }
    await f.tasks.tick();
    assert.equal(f.commands.length,1);
    assert.match(f.commands[0].input,/Authorized addition/);
    const cancelTodo=f.tasks.createTodo(scope,{operationId:'cancel-test',input:'Never execute this synthetic todo'});
    const canceled=await f.tasks.cancelTodo(scope,cancelTodo.id,{operationId:'cancel',expectedVersion:cancelTodo.version});
    assert.equal(canceled.status,'canceled');assert.equal(canceled.run,null);
    assert.equal((await f.tasks.cancelTodo(scope,cancelTodo.id,{operationId:'cancel',expectedVersion:cancelTodo.version})).id,cancelTodo.id);
    assert.equal(f.store.one('SELECT count(*) n FROM runs').n,1);
  });
}
test('HTTP runtime context and resolver preserve channel actor and group source rather than fabricating Web identity',async t=>{
  const {HttpTaskRuntime}=await import('../dist/runtime-http.js');const f=fixture(t),scope={...channel('alice',{sourceEventId:'channel-event',threadId:'thread'}),conversationId:'c'};f.conversations.create('c',scope,'conversation',1000,'real',0);const task=await f.tasks.create(scope,{operationId:'create',conversationId:'c',input:'work'});await f.tasks.tick();const command=f.commands[0],config={url:'http://127.0.0.1:39999',token:'a'.repeat(32),resolverToken:'b'.repeat(32)};
  const runtime=new HttpTaskRuntime(f.store,{},config,()=>1000,{task:id=>f.tasks.getRuntimeTask(id),input:(id,revision)=>({text:f.tasks.getRuntimeInput(id,revision)}),retainedMessage:()=>undefined});
  f.store.run('INSERT INTO task_host_bindings(run_id,task_id,command_json,profile_id,revision,spec_json,host_url) VALUES(?,?,?,?,?,?,?)',command.runId,task.id,JSON.stringify(command),'profile',1,'{}',config.url);
  const binding=f.store.one('SELECT * FROM task_host_bindings WHERE run_id=?',command.runId),context=runtime.context(binding);assert.equal(context.trigger.requester.externalUserId,'alice');assert.equal(context.trigger.requester.channelType,'feishu');assert.deepEqual(context.sourceChannel,{channelType:'feishu',tenantId:'tenant',installationId:'install'});assert.deepEqual(context.conversation,{conversationId:'c',kind:'group',threadId:'thread'});assert.equal(context.sourceEventRef,'channel-event');await runtime.refreshAuthorization(context,f.tasks);assert.equal(runtime.verify(context,f.tasks).task_id,task.id);assert.throws(()=>runtime.verify({...context,sourceChannel:{channelType:'web',tenantId:'w',installationId:'platform-web'}},f.tasks),/runtime_context_forbidden/);f.setAllowed(false);await assert.rejects(runtime.refreshAuthorization(context,f.tasks),/revoked/);
});

test('channel authorization-blocked outbox resumes only under the original logical binding and never retries unknown',async t=>{
 const f=fixture(t),scope={...channel(),conversationId:'c'};f.conversations.create('c',scope,'conversation',1000,'real',0);await f.tasks.create(scope,{operationId:'rotate',conversationId:'c',input:'work'});f.setAllowed(false);await f.tasks.tick();assert.equal(f.commands.length,0);assert.equal(f.store.one('SELECT status FROM task_outbox').status,'blocked');
 f.setAllowed(true);let currentBinding='v2';const original=f.authorization.authorizeEntity;f.authorization.authorizeEntity=s=>{original(s);if(s.source.bindingVersion!==currentBinding)throw new TaskError(403,'binding_changed');};f.store.run('UPDATE task_outbox SET retry_at=0');await f.tasks.tick();assert.equal(f.commands.length,0);assert.equal(f.store.one('SELECT status FROM task_outbox').status,'blocked');
 currentBinding='v1';f.store.run('UPDATE task_outbox SET retry_at=0');await f.tasks.tick();assert.equal(f.commands.length,1);await f.tasks.tick();assert.equal(f.commands.length,1);assert.equal(f.store.one('SELECT status FROM task_outbox').status,'done');
 f.store.run("UPDATE task_outbox SET status='unknown',last_error='authorization_revoked',retry_at=0");await f.tasks.tick();assert.equal(f.commands.length,1);assert.equal(f.store.one('SELECT status FROM task_outbox').status,'unknown');
});
