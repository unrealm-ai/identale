import {createJournalIndex} from '../dist/adapters/sqlite/journal-index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../dist/server.js';
import { Store } from '../dist/store.js';
import { SqliteConversationRepository } from '../dist/adapters/sqlite/conversation-repository.js';
import { SqliteTaskRepository } from '../dist/adapters/sqlite/task-repository.js';
import { JsonlJournal } from '@dentity/runtime-builtin';
const origin = 'http://127.0.0.1:5173';
async function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'identity-im-admin-test-')),path=join(dir,'test.sqlite');let tasks,modelCalls=0;
 const app=createServer({databasePath:path,origin,pollIntervalMs:0,onService:s=>tasks=s,modelClient:{async complete(){modelCalls++;throw Error('No model calls permitted');}}});await app.ready();
 const store=new Store(path),journal=new JsonlJournal({root:join(dir,'builtin-records'),ownerId:JSON.stringify([store.databaseId,store.databasePath]),serialize:fn=>store.transaction(fn),index:createJournalIndex(store)}),conversations=new SqliteConversationRepository(store,journal),repo=new SqliteTaskRepository(store);
 t.after(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const call=(method,url,body,cookie)=>app.inject({method,url,...(body===undefined?{}:{payload:body}),headers:{origin,...(cookie?{cookie}:{})}});
 async function register(name){const r=await call('POST','/api/auth/register',{username:name,password:'Synthetic password 2026!'});assert.equal(r.statusCode,201,r.body);return{...r.json(),cookie:r.headers['set-cookie'].split(';')[0]};}
 const owner=await register('admin-owner'),member=await register('chat-member'),admin=await register('second-admin'),outsider=await register('outside-admin'),w=owner.workspace.id;
 store.run("INSERT INTO members(id,workspace_id,user_id,role,status) VALUES('member-fixture',?,?,'member','active')",w,member.user.id);store.run("INSERT INTO members(id,workspace_id,user_id,role,status) VALUES('admin-fixture',?,?,'admin','active')",w,admin.user.id);
 const employee=async name=>(await call('POST',`/api/workspaces/${w}/entities`,{name,ownWebUse:true},owner.cookie)).json().entity;
 const e=await employee('First employee'),e2=await employee('Second employee'),base=`/api/workspaces/${w}`,root=id=>`${base}/entities/${id}`;
 await call('PUT',root(e.id)+'/web-access',{allowMemberIds:[owner.workspace.memberId,'member-fixture'],denyMemberIds:[]},owner.cookie);
 const scope=(entity=e,user=owner)=>({workspaceId:w,entityId:entity.id,userId:user.user.id});
 function seedConversation(id,at=1000,entity=e,s=scope(entity)){conversations.create(id,s,'fixture:'+id,at,'real',0);return{id,scope:s};}
 function seedTask(c,id,at,status='planned',result=null){const s={...c.scope,conversationId:c.id};if(status==='planned'){repo.insertPlannedTask(id,s,id,'hash',`Task ${id}`,'new','[]','[]',null,at);}else{const run='run:'+id;repo.insertTask(id,s,c.id,id,'hash',`Task ${id}`,'new','snapshot','[]',JSON.stringify(c.scope),run,at,at);repo.insertRun(run,id,'session:'+id,at);repo.setTaskStatus(status,at,id);repo.setRunStatus(status,run);if(result!==null)repo.setRunResult(result,1,run,1);}return id;}
 return{app,store,call,owner,member,admin,outsider,w,e,e2,base,root,scope,seedConversation,seedTask,conversations,repo,get tasks(){return tasks;},get modelCalls(){return modelCalls;}};
}
test('Web private get-or-create is stable across operations, concurrent requests, employees and server recreation',async t=>{
 const f=await fixture(t),url=f.root(f.e.id)+'/conversations';
 const replies=await Promise.all(Array.from({length:12},(_,i)=>f.call('POST',url,{operationId:'create-'+i},f.owner.cookie)));
 for(const reply of replies)assert.ok([200,201].includes(reply.statusCode),reply.body);
 const id=replies[0].json().conversation.id;assert.equal(new Set(replies.map(r=>r.json().conversation.id)).size,1);assert.equal(replies.filter(r=>r.statusCode===201).length,1);
 const c=f.conversations.get(id);f.conversations.addMessage('private-message',c,'user','PERSISTENT_CHAT_HISTORY',1000,false);
 const other=(await f.call('POST',f.root(f.e2.id)+'/conversations',{},f.owner.cookie)).json().conversation;assert.notEqual(other.id,id);
 const reopened=new Store(f.store.databasePath);try{const repo=new SqliteConversationRepository(reopened,new JsonlJournal({root:join(tmpdir(),'unused-im-admin-journal'),ownerId:'unused',serialize:fn=>reopened.transaction(fn)}));const result=repo.getOrCreateWeb(f.scope(),'unused','other-op',2000,0,()=>assert.fail('must reuse'));assert.equal(result.conversation.id,id);}finally{reopened.close();}
 assert.equal((await f.call('POST',url,{},f.owner.cookie)).json().conversation.id,id);
 const messages=await f.call('GET',`${url}/${id}/messages`,undefined,f.owner.cookie);assert.equal(messages.statusCode,200,messages.body);assert.match(messages.body,/PERSISTENT_CHAT_HISTORY/);
 assert.equal(f.store.one('SELECT count(*) n FROM web_private_conversations').n,2);assert.equal(f.modelCalls,0);
});
test('legacy conversations choose oldest unbounded real Web record without merging private history',async t=>{
 const f=await fixture(t);f.seedConversation('legacy-z',10);f.seedConversation('legacy-a',10);f.seedConversation('legacy-new',20);f.conversations.create('legacy-demo',f.scope(),'demo',1,'demo',0);
 const r=await f.call('POST',f.root(f.e.id)+'/conversations',{},f.owner.cookie);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().conversation.id,'legacy-a');assert.equal(f.store.one('SELECT count(*) n FROM conversations').n,4);assert.equal(f.store.one('SELECT count(*) n FROM conversation_message_index').n,0);
});
test('usable employee list and all ordinary conversation reads/writes recheck actor and grants',async t=>{
 const f=await fixture(t),a=(await f.call('POST',f.root(f.e.id)+'/conversations',{},f.owner.cookie)).json().conversation,b=(await f.call('POST',f.root(f.e.id)+'/conversations',{},f.member.cookie)).json().conversation;
 assert.notEqual(a.id,b.id);const employees=await f.call('GET',f.base+'/chat-employees',undefined,f.member.cookie);assert.deepEqual(employees.json().entities.map(e=>e.id),[f.e.id]);
 assert.equal((await f.call('GET',f.root(f.e.id)+`/conversations/${a.id}/messages`,undefined,f.member.cookie)).statusCode,404);
 await f.call('PUT',f.root(f.e.id)+'/web-access',{allowMemberIds:[f.owner.workspace.memberId],denyMemberIds:[]},f.owner.cookie);
 assert.deepEqual((await f.call('GET',f.base+'/chat-employees',undefined,f.member.cookie)).json().entities,[]);
 assert.equal((await f.call('GET',f.root(f.e.id)+`/conversations/${b.id}/messages`,undefined,f.member.cookie)).statusCode,200,'existing authorized history remains readable');assert.equal((await f.call('POST',f.root(f.e.id)+`/conversations/${b.id}/turns`,{operationId:'revoke',text:'blocked'},f.member.cookie)).statusCode,403);
 assert.equal((await f.call('POST',f.root(f.e.id)+'/conversations',{},f.member.cookie)).statusCode,403);assert.equal(f.modelCalls,0);
});
test('management readers require current Workspace owner/admin and never grant chat transcript access',async t=>{
 const f=await fixture(t),c=f.seedConversation('member-private',1000,f.e,f.scope(f.e,f.member));f.conversations.addMessage('secret',f.conversations.get(c.id),'user','PRIVATE_BODY_NEVER_ADMIN',1001,false);f.seedTask(c,'member-task',1000,'succeeded','TASK_RESULT_ALLOWED');
 const urls=['/overview',`/conversations?entityId=${f.e.id}`,`/tasks?entityId=${f.e.id}&conversationId=${c.id}`];
 for(const url of urls){for(const actor of [f.owner,f.admin])assert.equal((await f.call('GET',f.base+'/task-management'+url,undefined,actor.cookie)).statusCode,200);for(const actor of [f.member,f.outsider])assert.equal((await f.call('GET',f.base+'/task-management'+url,undefined,actor.cookie)).statusCode,403);assert.equal((await f.call('GET',f.base+'/task-management'+url)).statusCode,401);}
 const response=await f.call('GET',f.base+`/task-management/tasks?entityId=${f.e.id}&conversationId=${c.id}`,undefined,f.admin.cookie);assert.match(response.body,/TASK_RESULT_ALLOWED/);assert.doesNotMatch(response.body,/PRIVATE_BODY_NEVER_ADMIN|owner_key|source_json|config_snapshot|record_ref|scope_json/);
 assert.equal((await f.call('GET',f.root(f.e.id)+`/conversations/${c.id}/messages`,undefined,f.admin.cookie)).statusCode,404);
 f.store.run("UPDATE members SET status='inactive' WHERE id='admin-fixture'");assert.equal((await f.call('GET',f.base+'/task-management/overview',undefined,f.admin.cookie)).statusCode,403);
});
test('global/employee overview count digital employees, distinct conversations and Web/channel task facts',async t=>{
 const f=await fixture(t),a=f.seedConversation('web-one'),channel={workspaceId:f.w,entityId:f.e.id,principal:{kind:'channel',channelType:'feishu',tenantId:'tenant',identityNamespace:'open_id',externalUserId:'alice'},source:{channelType:'feishu',tenantId:'tenant',installationId:'app',applicationId:'app',connectionId:'conn',bindingVersion:'1',conversationId:'group',conversationKind:'group'}},b=f.seedConversation('channel-one',1000,f.e,channel),c=f.seedConversation('other-employee',1000,f.e2);
 f.seedTask(a,'ok',1,'succeeded');f.seedTask(b,'bad',2,'failed');for(const [i,status]of ['planned','queued','running','canceled','waiting_input','cancel_requested','unknown'].entries())f.seedTask(b,'state-'+i,3+i,status);f.seedTask(c,'other-ok',1,'succeeded');
 const get=async suffix=>(await f.call('GET',f.base+'/task-management/overview'+suffix,undefined,f.owner.cookie)).json();
 const global=await get('');assert.deepEqual(global,{employees:2,conversations:3,activeTasks:5,succeeded:2,failed:1,successRate:2/3});
 const employee=await get('?entityId='+f.e.id);assert.equal(employee.conversations,2);assert.equal(employee.successRate,0.5);assert.deepEqual(await get(''),global,'employee filters do not change global');
 f.store.run("UPDATE tasks SET status='canceled'");assert.equal((await get('')).successRate,null);
});
test('management conversation/task pages are descending, tie-stable, scoped and exclude later insertions',async t=>{
 const f=await fixture(t),records=['a','b','c','d','e'].map(id=>f.seedConversation('conv-'+id,1000));const root=f.base+`/task-management/conversations?entityId=${f.e.id}&limit=2`;
 let r=(await f.call('GET',root,undefined,f.owner.cookie)).json(),ids=r.records.map(c=>c.id);assert.deepEqual(ids,['conv-e','conv-d']);const cursor=r.nextCursor;f.seedConversation('conv-new',2000);
 while(r.nextCursor){r=(await f.call('GET',root+'&cursor='+r.nextCursor,undefined,f.owner.cookie)).json();ids.push(...r.records.map(c=>c.id));}assert.deepEqual(ids,['conv-e','conv-d','conv-c','conv-b','conv-a']);
 for(const [n,at] of [[0,1000],[1,1000],[2,1001],[3,1000]])f.seedTask(records[0],'task-'+n,at,n===3?'failed':'planned');
 const tasks=f.base+`/task-management/tasks?entityId=${f.e.id}&conversationId=conv-a&limit=2`;let page=(await f.call('GET',tasks,undefined,f.owner.cookie)).json();assert.deepEqual(page.records.map(t=>t.id),['task-2','task-3']);f.seedTask(records[0],'new-task',2000);const next=(await f.call('GET',tasks+'&cursor='+page.nextCursor,undefined,f.owner.cookie)).json();assert.deepEqual(next.records.map(t=>t.id),['task-1','task-0']);
 assert.deepEqual((await f.call('GET',tasks+'&status=failed',undefined,f.owner.cookie)).json().records.map(t=>t.id),['task-3']);
 assert.equal((await f.call('GET',root.replace(f.e.id,f.e2.id)+'&cursor='+cursor,undefined,f.owner.cookie)).statusCode,400);
 assert.equal((await f.call('GET',f.base+`/task-management/tasks?entityId=${f.e2.id}&conversationId=conv-a`,undefined,f.owner.cookie)).statusCode,404);
 assert.equal((await f.call('GET',f.base+`/task-management/conversations?entityId=foreign-employee`,undefined,f.owner.cookie)).statusCode,404);
 assert.deepEqual((await f.call('GET',f.base+`/task-management/conversations?entityId=${f.e2.id}`,undefined,f.owner.cookie)).json().records,[]);
});

test('direct task pages and read-only detail retain admin scope, tie order, channel filters and insertion ceiling',async t=>{
 const f=await fixture(t),a=f.seedConversation('direct-web',1000),b=f.seedConversation('direct-other',1000,f.e2);for(const id of ['a','b','c'])f.seedTask(a,'direct-'+id,1000,id==='b'?'failed':'planned');f.seedTask(b,'other-task',1001,'succeeded','RESULT');const root=f.base+'/task-management/task-list';
 let r=await f.call('GET',root+'?limit=2',undefined,f.owner.cookie);assert.equal(r.statusCode,200,r.body);let page=r.json();assert.deepEqual(page.records.map(t=>t.id),['other-task','direct-c']);f.seedTask(a,'later-task',2000);const next=(await f.call('GET',root+'?limit=2&cursor='+page.nextCursor,undefined,f.owner.cookie)).json();assert.deepEqual(next.records.map(t=>t.id),['direct-b','direct-a']);assert.equal((await f.call('GET',root+'?status=failed&cursor='+page.nextCursor,undefined,f.owner.cookie)).statusCode,400);assert.deepEqual((await f.call('GET',root+'?channel=wecom',undefined,f.owner.cookie)).json().records,[]);assert.deepEqual((await f.call('GET',root+'?status=failed',undefined,f.owner.cookie)).json().records.map(t=>t.id),['direct-b']);
 for(const suffix of ['', '/direct-a'])for(const actor of [f.member,f.outsider])assert.equal((await f.call('GET',root+suffix,undefined,actor.cookie)).statusCode,403);const detail=(await f.call('GET',root+'/direct-a',undefined,f.admin.cookie)).json();assert.equal(detail.run,null);assert.deepEqual(detail.deliveries,[]);assert.equal(detail.channel,'web');assert.doesNotMatch(JSON.stringify(detail),/scope_json|source_json|record_ref|config_snapshot/);assert.equal((await f.call('GET',root+'/missing',undefined,f.owner.cookie)).statusCode,404);assert.match(JSON.stringify(f.store.all('EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 25',f.w)),/workbench_tasks_order/);assert.equal(f.modelCalls,0);
});

// Regression: unattended tasks have no conversation and must not disappear from management reads.
test('direct task list/detail include null-conversation automatic tasks without expanding member access',async t=>{const f=await fixture(t);const scope={workspaceId:f.w,entityId:f.e.id,userId:f.owner.user.id};f.repo.insertTask('automatic',scope,null,'automatic','hash','Automatic task','new','snapshot','[]','{}','run-auto',1000,1000);f.repo.setTriggerOrigin('automatic','trigger-id','event-id','employee','group',1);f.repo.insertRun('run-auto','automatic','session-auto',1000);const path=f.base+'/task-management/task-list';const list=await f.call('GET',path+'?channel=trigger',undefined,f.owner.cookie);assert.equal(list.statusCode,200,list.body);assert.deepEqual(list.json().records.map(t=>[t.id,t.channel,t.conversationId]),[['automatic','trigger',null]]);const detail=await f.call('GET',path+'/automatic',undefined,f.admin.cookie);assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().channel,'trigger');assert.equal(detail.json().run.id,'run-auto');assert.deepEqual(detail.json().deliveries,[]);assert.equal((await f.call('GET',path+'/automatic',undefined,f.member.cookie)).statusCode,403);assert.equal((await f.call('GET',path+'/automatic',undefined,f.outsider.cookie)).statusCode,403);});
