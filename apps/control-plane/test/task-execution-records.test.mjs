import test from'node:test';import assert from'node:assert/strict';import{taskRecordsFixture}from'./helpers/task-records-fixture.mjs';
const get=(f,url,user=f.owner)=>f.call('GET',url,undefined,user.cookie);
test('real platform and Host read-only projection uses original authorization and no model, journal copy or list scan',async t=>{
 const f=await taskRecordsFixture(t),root=f.task.root.replace(/\/activity$/,'/records'),admin=f.task.adminRoot.replace(/\/activity$/,'/records');
 await get(f,`${f.entityBase}/conversations/${f.own.id}/tasks?summary=true`);assert.equal(f.calls.length,0);
 const page=await get(f,root);assert.equal(page.statusCode,200,page.body);const body=page.json();assert.equal(body.status,'available');assert.deepEqual(body.records.map(r=>r.type),['reply','tool_call','tool_result']);assert.doesNotMatch(page.body,/PRIVATE_NATIVE_INPUT|RAW_NATIVE_THINKING|SYNTHETIC_TOOL_SECRET|session-pointer|native.jsonl|details|signature/i);
 const args=await get(f,`${root}?runId=${f.task.runId}&entryId=${encodeURIComponent(body.records[1].id)}`);assert.equal(args.statusCode,200,args.body);assert.match(args.json().text,/fixture.txt/);assert.doesNotMatch(args.body,/SYNTHETIC_TOOL_SECRET/);
 assert.equal((await get(f,root,f.member)).statusCode,404);assert.equal((await get(f,admin,f.member)).statusCode,403);assert.equal((await get(f,admin,f.admin)).json().status,'available');assert.equal(f.modelCalls,0);
 const normalGrant=structuredClone(f.calls.find(c=>c.url.endsWith('/v1/readExecutionRecords')).body);normalGrant.authorizationContext.authenticatedActorRef='task-service:'+f.task.runId;
 assert.equal((await f.host.inject({method:'POST',url:'/v1/readExecutionRecords',headers:{authorization:`Bearer ${f.hostToken}`},payload:normalGrant})).json().ok,false);
 assert.equal(f.store.one('SELECT count(*) n FROM runtime_outputs').n,0);assert.equal(f.store.one('SELECT count(*) n FROM task_updates').n,0);
 const reused=await get(f,`${admin}?runId=${f.task.runId}&cursor=${encodeURIComponent(body.tailCursor)}`,f.admin);assert.equal(reused.json().status,'changed');assert.deepEqual(reused.json().records,[]);
});
test('historical Run reads have a separate read-only grant; it cannot obtain credentials or reuse another Run/Session binding',async t=>{
 const f=await taskRecordsFixture(t),root=f.task.root.replace(/\/activity$/,'/records');
 f.repo.insertRun('new-active-run',f.task.id,'new-active-session',5000);f.store.run('UPDATE tasks SET run_id=? WHERE id=?','new-active-run',f.task.id);
 const old=await get(f,`${root}?runId=${encodeURIComponent(f.task.runId)}`);assert.equal(old.statusCode,200,old.body);assert.equal(old.json().status,'available');
 const request=f.calls.find(c=>c.url.endsWith('/v1/readExecutionRecords')).body;
 for(const name of ['model','content','output']){const response=await f.app.inject({method:'POST',url:'/internal/runtime/'+name,headers:{authorization:`Bearer ${f.resolverToken}`},payload:{context:request.authorizationContext,...(name==='output'?{text:'MUST_NOT_STORE'}:{ref:{resourceId:'not-a-model',version:'1'}})}});assert.notEqual(response.statusCode,200);}
 const forged=structuredClone(request);forged.payload.execution.sessionId='new-active-session';assert.equal((await f.host.inject({method:'POST',url:'/v1/readExecutionRecords',headers:{authorization:`Bearer ${f.hostToken}`},payload:forged})).json().ok,false);
 assert.equal((await get(f,`${root}?runId=new-active-run&cursor=${encodeURIComponent(old.json().tailCursor)}`)).json().status,'unavailable');
 const savedSession=f.binding.session_json,badSession=JSON.parse(savedSession);badSession.scope.runId='new-active-run';f.store.run('UPDATE task_host_bindings SET session_json=? WHERE run_id=?',JSON.stringify(badSession),f.task.runId);assert.equal((await get(f,`${root}?runId=${encodeURIComponent(f.task.runId)}`)).statusCode,403);f.store.run('UPDATE task_host_bindings SET session_json=? WHERE run_id=?',savedSession,f.task.runId);
 f.store.run("UPDATE members SET status='inactive' WHERE id=?",f.owner.workspace.memberId);assert.equal((await get(f,`${root}?runId=${encodeURIComponent(f.task.runId)}&entryId=${encodeURIComponent(old.json().records[0].id)}`)).statusCode,403);
});
test('running record reads increment from the last complete offset and lazy result authorization is rechecked',async t=>{
 const f=await taskRecordsFixture(t),root=f.task.root.replace(/\/activity$/,'/records'),page=(await get(f,root)).json();
 f.manager.appendMessage({role:'toolResult',toolCallId:'late-call',toolName:'bash',content:[{type:'text',text:'增量结果'.repeat(4000)}],isError:false,timestamp:1793062801000});
 const next=await get(f,`${root}?cursor=${encodeURIComponent(page.tailCursor)}`);assert.equal(next.json().records.length,1);assert.equal(next.json().records[0].text,'');
 const entryId=next.json().records[0].id,first=await get(f,`${root}?entryId=${encodeURIComponent(entryId)}`);assert.equal(first.json().nextOffset,8000);
 f.store.run('UPDATE sessions SET revoked=1 WHERE user_id=?',f.owner.user.id);assert.equal((await get(f,`${root}?entryId=${encodeURIComponent(entryId)}&offset=8000`)).statusCode,401);
});
