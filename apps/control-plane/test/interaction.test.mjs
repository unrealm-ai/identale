// Modified for Identale; see the root NOTICE.
import {createJournalIndex} from '../dist/adapters/sqlite/journal-index.js';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import{spawnSync}from'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from '../dist/server.js';
import {Store} from '../dist/store.js';
import {ModelProfileService} from '../dist/model-profiles.js';
import {SqliteConversationRepository} from '../dist/adapters/sqlite/conversation-repository.js';
import {createBuiltinInteractionProvider} from '../dist/adapters/builtin-interaction-provider.js';
import {createInteractionService,TaskError,TaskMutationVersionConflict} from '@dentity/application';
import {JsonlJournal} from '@dentity/runtime-builtin';
import {resetLegacyBuiltinHistory} from '../dist/adapters/sqlite/builtin-history-reset.js';
const origin='http://127.0.0.1:5173';
const response=value=>({...value,usage:{inputTokens:10,outputTokens:5}});
test('synthetic interaction queries running task before supplement/cancel, deduplicates calls and rejects another conversation',async t=>{
 // This is an isolated tool-loop contract, not evidence of a live model choosing an action.
 let taskId,action='task_supplement',duplicate=false,serial=0,mutationArgs;const observed=[];
 const s=await setup(t,{modelClient:{async complete({messages,tools}){
  assert.ok(tools.some(tool=>tool.name===action));
  const last=messages.at(-1),call=(name,args)=>response({toolCalls:[{id:`control-${++serial}`,name,arguments:args}]});
  if(last.role!=='tool')return call('task_query',{taskId});
  const previous=[...messages].reverse().find(message=>message.role==='assistant'&&message.toolCalls?.length)?.toolCalls.at(-1);
  const result=JSON.parse(last.content);observed.push({tool:previous.name,result});
  if(previous.name==='task_query'){
   assert.equal(result.availableActions[action==='task_supplement'?'supplement':'cancel'].available,true);
   mutationArgs={taskId,expectedVersion:result.version,...(action==='task_supplement'?{input:'Synthetic additional requirement'}:{})};
   return call(action,mutationArgs);
  }
  if(!duplicate){duplicate=true;return call(action,mutationArgs);}
  return response({text:action==='task_supplement'?'补充已记录，尚未确认应用。':'取消已请求，尚未确认停止。'});
 }}});
 const c=await s.conv('real'),created=await s.call('POST',s.base+'/tasks',{operationId:'running-control',conversationId:c.id,input:'Synthetic ongoing task'},s.cookie);
 assert.equal(created.statusCode,202,created.body);const task=created.json().task;taskId=task.id;await s.service.tick();
 const runId=s.db.prepare('SELECT run_id FROM tasks WHERE id=?').get(taskId).run_id;
 s.service.ingest(runId,{eventId:'control-running',runId,sequence:1,type:'status',status:'running'});
 const invoke=async(conversation,operationId)=>{const started=await s.turn(conversation,'Synthetic explicit control request',operationId);assert.equal(started.statusCode,202,started.body);return s.finish(conversation,started.json().turn.id);};
 assert.equal((await invoke(c,'supplement-running')).status,'succeeded');
 assert.equal(s.db.prepare('SELECT input_revision FROM tasks WHERE id=?').get(taskId).input_revision,2);
 assert.equal(s.db.prepare("SELECT count(*) n FROM task_operations WHERE task_id=? AND kind='input'").get(taskId).n,1);
 assert.equal(s.db.prepare('SELECT count(*) n FROM task_inputs WHERE task_id=? AND revision=2').get(taskId).n,1);
 assert.deepEqual(observed.map(item=>item.tool),['task_query','task_supplement','task_supplement']);
 await s.service.tick();assert.equal(s.db.prepare('SELECT status FROM task_inputs WHERE task_id=? AND revision=2').get(taskId).status,'received');
 s.service.ingest(runId,{eventId:'control-input-applied',runId,sequence:2,type:'input_receipt',inputRevision:2,inputStatus:'applied'});
 assert.equal(s.db.prepare('SELECT status FROM task_inputs WHERE task_id=? AND revision=2').get(taskId).status,'applied');
 const other=s.historical('Synthetic other conversation','Synthetic retained reply','real'),before=s.db.prepare('SELECT count(*) n FROM task_operations').get().n;
 action='task_cancel';duplicate=false;assert.equal((await invoke(other,'foreign-cancel')).status,'failed');
 assert.equal(s.db.prepare('SELECT count(*) n FROM task_operations').get().n,before);
 assert.equal(s.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status,'running');
 assert.equal((await invoke(c,'cancel-running')).status,'succeeded');
 assert.equal(s.db.prepare("SELECT count(*) n FROM task_operations WHERE task_id=? AND kind='cancel'").get(taskId).n,1);
 assert.equal(s.db.prepare("SELECT count(*) n FROM task_outbox WHERE task_id=? AND kind='cancel'").get(taskId).n,1);
 assert.equal(s.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status,'cancel_requested');
 await s.service.tick();assert.equal(s.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status,'cancel_requested');
 s.service.ingest(runId,{eventId:'control-canceled',runId,sequence:3,type:'status',status:'canceled'});
 assert.equal(s.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status,'canceled');
 assert.equal(s.db.prepare('SELECT count(*) n FROM tasks').get().n,1);assert.equal(s.db.prepare('SELECT count(*) n FROM runs').get().n,1);
});
async function setup(t,options={}) {
 const dir=await mkdtemp(join(tmpdir(),'dentity-interaction-')),databasePath=join(dir,'interaction.sqlite');let now=1800000000000,service;const calls=[];
 const runtime={idempotentDispatch:true,capabilities(runId){return{runId,runtimeId:'fixture',runtimeVersion:'1',bindingVersion:'fixture',observedAt:0,expiresAt:4102444800000,appendInput:'supported',cancel:'supported'};},async dispatch(c){calls.push(c);return{status:'accepted'};},async input(){return{status:'received'};},async cancel(){return{status:'unknown'};},async events(){return[];}};
 const config={databasePath,origin,now:()=>now,pollIntervalMs:0,sessionTtlMs:48*60*60*1000,runtime,onService:s=>service=s,...options};let app=createServer(config);await app.ready();
 const db=new DatabaseSync(databasePath);t.after(async()=>{await app.close();db.close();await rm(dir,{recursive:true,force:true});});
 const call=(method,url,payload,cookie)=>app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{origin,...(cookie?{cookie}:{})}});
 const reg=await call('POST','/api/auth/register',{username:'interaction-user',password:'Synthetic conversation test password 2026!'});assert.equal(reg.statusCode,201,reg.body);const user=reg.json(),cookie=reg.headers['set-cookie'].split(';')[0];
 const er=await call('POST',`/api/workspaces/${user.workspace.id}/entities`,{name:'Interaction employee',ownWebUse:true},cookie);assert.equal(er.statusCode,200,er.body);const entity=er.json().entity,base=`/api/workspaces/${user.workspace.id}/entities/${entity.id}`;
 const conv=async mode=>{const result=await call('POST',base+'/conversations',{mode},cookie);assert.ok([200,201].includes(result.statusCode),result.body);return result.json().conversation;};
 // Seed pre-existing records through the real SQL/JSONL adapter; no retired demo endpoint runs.
 const historical=(text='HISTORICAL_DEMO_INPUT',output='历史模拟回复',mode='demo',operationId=`historical-${randomUUID()}`)=>{
  const store=new Store(databasePath);try {
   const journal=new JsonlJournal({root:join(dir,'builtin-records'),ownerId:JSON.stringify([store.databaseId,store.databasePath]),serialize:fn=>store.transaction(fn),index:createJournalIndex(store)});
   const repository=new SqliteConversationRepository(store,journal,()=>now),scope={workspaceId:user.workspace.id,entityId:entity.id,userId:user.user.id},id=randomUUID(),turnId=randomUUID();
   repository.create(id,scope,operationId,now,mode,0);const row=repository.get(id);
   repository.createTurn({id:turnId,conversation_id:id,operation_id:'historical-turn',text,scope_json:JSON.stringify(scope),mode,status:'succeeded',request_json:null,output,error:null,created_at:now,epoch:1},false);
   repository.addMessage(`user:${turnId}`,row,'user',text,now,mode==='demo');repository.addMessage(`assistant:${turnId}`,row,'assistant',output,now,mode==='demo');
   return{id,mode,simulated:mode==='demo',turnId,operationId};
  }finally{store.close();}
 };
 const turn=async(c,text='hello',operationId='op')=>call('POST',`${base}/conversations/${c.id}/turns`,{operationId,text},cookie);
 const finish=async(c,id)=>{for(let n=0;n<100;n++){const result=await call('GET',`${base}/conversations/${c.id}/turns/${id}`,undefined,cookie);assert.equal(result.statusCode,200,result.body);const turn=result.json().turn;if(['succeeded','failed','canceled','unknown'].includes(turn.status))return turn;await new Promise(r=>setTimeout(r,2));}throw Error('Turn did not finish');};
 return{dir,databasePath,db,call,historical,purgeExpired(){const store=new Store(databasePath);try{const journal=new JsonlJournal({root:join(dir,'builtin-records'),ownerId:JSON.stringify([store.databaseId,store.databasePath]),serialize:fn=>store.transaction(fn),index:createJournalIndex(store)}),repository=new SqliteConversationRepository(store,journal,()=>now);const entities={getRuntimeDefinition(workspaceId,entityId){return store.one('SELECT name,description,interaction_runtime AS interactionRuntime FROM entities WHERE workspace_id=? AND id=?',workspaceId,entityId);}};const provider=createBuiltinInteractionProvider(store,repository,service,()=>now,entities,{journal});createInteractionService(repository,service,provider,()=>now).purgeExpired();}finally{store.close();}},user,cookie,entity,base,conv,turn,finish,calls,get service(){return service;},async stop(){await app.close();},advance:ms=>now+=ms,async restart(){await app.close();app=createServer(config);await app.ready();}};
}
test('new demo is rejected while historical simulated records remain read-only without invoking models',async t=>{
 let models=0;const s=await setup(t,{modelClient:{async complete(){models++;throw Error('Must not call');}}});
 const rejected=await s.call('POST',s.base+'/conversations',{mode:'demo'},s.cookie);assert.equal(rejected.statusCode,400,rejected.body);assert.equal(rejected.json().error,'invalid_conversation_mode');
 const c=s.historical();const before=JSON.stringify(s.db.prepare('SELECT * FROM interaction_turns').all());
 const messages=await s.call('GET',`${s.base}/conversations/${c.id}/messages`,undefined,s.cookie);assert.equal(messages.statusCode,200,messages.body);assert.deepEqual(messages.json().messages.map(m=>m.text),['HISTORICAL_DEMO_INPUT','历史模拟回复']);assert.equal(messages.json().messages.every(m=>m.simulated),true);
 const oldTurn=await s.call('GET',`${s.base}/conversations/${c.id}/turns/${c.turnId}`,undefined,s.cookie);assert.equal(oldTurn.statusCode,200,oldTurn.body);assert.equal(oldTurn.json().turn.simulated,true);
 for(const operationId of ['historical-turn','new-turn']){const denied=await s.turn(c,'attempted write',operationId);assert.equal(denied.statusCode,409,denied.body);assert.equal(denied.json().error,'historical_demo_read_only');}
 const interrupt=await s.call('POST',`${s.base}/conversations/${c.id}/turns/${c.turnId}/interrupt`,{},s.cookie);assert.equal(interrupt.statusCode,409,interrupt.body);assert.equal(interrupt.json().error,'historical_demo_read_only');
 const task=await s.call('POST',s.base+'/tasks',{operationId:'attempt',conversationId:c.id,input:'Use demo history'},s.cookie);assert.equal(task.statusCode,409,task.body);
 assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM interaction_turns').all()),before);assert.equal(models,0);for(const table of ['tasks','runs','task_outbox','builtin_operations'])assert.equal(s.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
 await s.restart();assert.equal((await s.call('GET',`${s.base}/conversations/${c.id}/messages`,undefined,s.cookie)).statusCode,200);assert.equal(models,0);
});
test('missing model rejects new real/auto conversations and existing real turns without fake replies or work',async t=>{
 const s=await setup(t);for(const body of [{},{mode:'auto'},{mode:'real'}]){const result=await s.call('POST',s.base+'/conversations',body,s.cookie);assert.equal(result.statusCode,409,result.body);assert.equal(result.json().error,'model_not_configured');}
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM conversations').get().n,0);
 const c=s.historical('REAL_RETAINED_INPUT','REAL_RETAINED_OUTPUT','real');const result=await s.turn(c);assert.equal(result.statusCode,409,result.body);assert.equal(result.json().error,'model_not_configured');
 const tasks=await s.call('POST',s.base+'/tasks',{operationId:'missing-model-task',conversationId:c.id,input:'Must not execute'},s.cookie);assert.equal(tasks.statusCode,409,tasks.body);assert.equal(tasks.json().error,'model_not_configured');
 const history=await s.call('GET',`${s.base}/conversations/${c.id}/messages`,undefined,s.cookie);assert.equal(history.statusCode,200,history.body);assert.deepEqual(history.json().messages.map(m=>m.text),['REAL_RETAINED_INPUT','REAL_RETAINED_OUTPUT']);
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM interaction_turns').get().n,1);for(const table of ['tasks','runs','task_outbox'])assert.equal(s.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
});
test('real bounded model invokes task service once, preserves trusted initiator and stays conversational',async t=>{
 let round=0;const s=await setup(t,{modelClient:{async complete(){round++;return response(round<=2?{toolCalls:[{id:`call-${round}`,name:'task_create',arguments:{input:'Background task',title:'后台任务标题'}}]}:{text:'Task accepted, still running.'});}}});const c=await s.conv('real');const result=await s.turn(c,'Please do a task');assert.equal(result.statusCode,202,result.body);const final=await s.finish(c,result.json().turn.id);assert.equal(final.status,'succeeded');assert.equal(final.simulated,false);assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n,1);assert.equal(s.db.prepare('SELECT count(*) AS n FROM runs').get().n,1);assert.equal(s.calls.length,0);await s.service.tick();assert.equal(s.calls.length,1);assert.equal(s.calls[0].requester.externalUserId,s.user.user.id);assert.equal(s.db.prepare('SELECT title FROM tasks').get().title,'后台任务标题');assert.equal(s.calls[0].input,'Background task');
 const another=await s.turn(c,'Can we keep chatting?','op2');assert.equal(another.statusCode,202,another.body);assert.equal((await s.finish(c,another.json().turn.id)).status,'succeeded');assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n,1);
 const replay=await s.turn(c,'Please do a task');assert.equal(replay.json().turn.id,result.json().turn.id);assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n,1);
 await s.restart();const messages=await s.call('GET',`${s.base}/conversations/${c.id}/messages`,undefined,s.cookie);assert.equal(messages.statusCode,200,messages.body);assert.equal(messages.json().messages.length,6);
});
test('cancel generation suppresses output and never cancels accepted business task',async t=>{
 let round=0,entered;const started=new Promise(r=>entered=r);const s=await setup(t,{modelClient:{async complete({signal}){if(++round===1)return response({toolCalls:[{id:'create',name:'task_create',arguments:{input:'Long task'}}]});entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))));}}});const c=await s.conv('real');const result=await s.turn(c);await started;const interrupted=await s.call('POST',`${s.base}/conversations/${c.id}/turns/${result.json().turn.id}/interrupt`,{},s.cookie);assert.equal(interrupted.statusCode,200,interrupted.body);assert.equal(interrupted.json().status,'requested');assert.equal((await s.finish(c,result.json().turn.id)).status,'canceled');assert.equal(s.db.prepare('SELECT status FROM tasks').get().status,'queued');assert.equal(s.db.prepare("SELECT count(*) AS n FROM task_outbox WHERE kind='cancel'").get().n,0);
});
test('cross-conversation task ids and model identity injection are denied; own-web-use revocation blocks new input while scoped history remains readable until TTL',async t=>{
 let taskId='';const s=await setup(t,{conversationTtlMs:24*60*60*1000,modelClient:{async complete(){return response({toolCalls:[{id:'lookup',name:'task_query',arguments:{taskId}}]});}}});const a=await s.conv('real'),b=s.historical('LEGACY_OTHER_INPUT','LEGACY_OTHER_REPLY','real');const task=await s.call('POST',s.base+'/tasks',{operationId:'create',conversationId:a.id,input:'Private task'},s.cookie);taskId=task.json().task.id;const result=await s.turn(b);assert.equal((await s.finish(b,result.json().turn.id)).status,'failed');
 s.db.prepare('UPDATE entities SET own_web_use=0').run();assert.equal((await s.call('GET',`${s.base}/conversations/${a.id}/messages`,undefined,s.cookie)).statusCode,200);assert.equal((await s.turn(a,'blocked input','revoked-input')).statusCode,403);s.db.prepare('UPDATE entities SET own_web_use=1').run();s.advance(24*60*60*1000+1);assert.equal((await s.call('GET',`${s.base}/conversations/${a.id}/messages`,undefined,s.cookie)).statusCode,404);
});
test('local-pi choice does not silently route to builtin',async t=>{let calls=0;const s=await setup(t,{modelClient:{async complete(){calls++;return response({text:'wrong adapter'});}}});s.db.prepare("UPDATE entities SET interaction_runtime='local-pi'").run();const c=await s.conv('real');const result=await s.turn(c);assert.equal(result.statusCode,409,result.body);assert.equal(result.json().error,'interaction_runtime_unavailable');assert.equal(calls,0);});
test('config change preserves real private history without copying demo conversation history',async t=>{
 let revision='1';const histories=[];const s=await setup(t,{modelClientForScope:async()=>({revision,client:{async complete(input){histories.push(input.messages.map(m=>m.content).join('\n'));return response({text:'Real reply'});}}})});const demo=s.historical('DEMO_SECRET');assert.equal(demo.simulated,true);const real=await s.conv('real');let result=await s.turn(real,'REAL_FIRST');await s.finish(real,result.json().turn.id);revision='2';result=await s.turn(real,'REAL_SECOND','second');await s.finish(real,result.json().turn.id);assert.equal(histories.every(h=>!h.includes('DEMO_SECRET')),true);assert.equal(histories[1].includes('REAL_FIRST'),true);
});
test('concurrent retry uses one durable turn and dispatches one model invocation',async t=>{
 let calls=0;const s=await setup(t,{modelClient:{async complete(){calls++;return response({text:'Only one turn'});}}});const c=await s.conv('real');const results=await Promise.all([s.turn(c),s.turn(c)]);for(const r of results)assert.equal(r.statusCode,202,r.body);assert.equal(results[0].json().turn.id,results[1].json().turn.id);await s.finish(c,results[0].json().turn.id);assert.equal(calls,1);assert.equal(s.db.prepare('SELECT count(*) AS n FROM interaction_turns').get().n,1);
});
test('retention expiry removes private bodies on restart, not task facts',async t=>{
 const s=await setup(t,{conversationTtlMs:10,modelClient:{async complete(){return response({text:'PRIVATE_RESPONSE'});}}});const c=await s.conv('real');const r=await s.turn(c,'PRIVATE_INPUT');await s.finish(c,r.json().turn.id);const task=await s.call('POST',s.base+'/tasks',{operationId:'task',conversationId:c.id,input:'TASK_FACT'},s.cookie);assert.equal(task.statusCode,202,task.body);s.advance(11);await s.restart();assert.equal(s.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='interaction_content'").get().n,0);assert.equal(s.db.prepare('SELECT count(*) AS n FROM builtin_content_refs').get().n,0);assert.equal(s.db.prepare('SELECT count(*) AS n FROM conversation_message_index').get().n,0);assert.equal(s.db.prepare('SELECT input_ref FROM interaction_turns').get().input_ref,null);assert.equal((await readdir(join(s.dir,'builtin-records'),{recursive:true})).filter(name=>name.endsWith('.jsonl')).length,0);assert.equal(s.db.prepare('SELECT input FROM tasks').get().input,'TASK_FACT');const records=s.db.prepare('SELECT json FROM builtin_records').all();assert.equal(records.some(r=>r.json.includes('PRIVATE_INPUT')||r.json.includes('PRIVATE_RESPONSE')),false);
});

test('platform instructions snapshot employee persona while preserving the same conversation history',async t=>{
 const seen=[],toolsets=[];const s=await setup(t,{modelClient:{async complete(input){seen.push(input.messages);toolsets.push(input.tools);return response({text:'Acknowledged'});}}});
 const update=async description=>s.call('PUT',s.base+'/description',{description},s.cookie);
 assert.equal((await update('产品客服，回答简洁。')).statusCode,200);
 assert.equal((await update('x'.repeat(4001))).statusCode,400);
 assert.equal((await s.call('PUT',s.base+'/description',{description:'not authorized'})).statusCode,401);
 const listing=await s.call('GET',`/api/workspaces/${s.user.workspace.id}/entities`,undefined,s.cookie);assert.equal(listing.json().entities[0].description,'产品客服，回答简洁。');
 const outsider=await s.call('POST','/api/auth/register',{username:'outsider-persona',password:'Synthetic other account password 2026!'});assert.equal(outsider.statusCode,201);assert.equal((await s.call('PUT',s.base+'/description',{description:'forged'},outsider.headers['set-cookie'].split(';')[0])).statusCode,403);
 const created=await s.call('POST',`/api/workspaces/${s.user.workspace.id}/entities`,{name:'Description test',description:'已配置的描述',ownWebUse:false},s.cookie);assert.equal(created.statusCode,200);assert.equal(created.json().entity.description,'已配置的描述');
 const c=await s.conv('real');let result=await s.turn(c,'FIRST_PERSONA_CONTEXT');assert.equal((await s.finish(c,result.json().turn.id)).status,'succeeded');
 assert.equal(seen[0][0].role,'system');assert.match(seen[0][0].content,/一、身份与表达/);assert.match(seen[0][0].content,/产品客服，回答简洁/);assert.match(seen[0][0].content,/Interaction employee/);assert.match(seen[0][0].content,/不轮询等待业务完成/);assert.match(seen[0][0].content,/不能把每条消息默认当新任务/);assert.match(seen[0][0].content,/availableActions/);assert.match(toolsets[0].find(t=>t.name==='task_query').description,/availableActions specifies permitted operations/);assert.match(seen[0][0].content,/当前未提供暂停\/恢复工具/);assert.match(seen[0][0].content,/不得将.*暂停.*转换成取消/);assert.match(toolsets[0].find(t=>t.name==='task_cancel').description,/Not pause\/resume/);assert.match(toolsets[0].find(t=>t.name==='task_supplement').description,/not a new task/);assert.match(toolsets[0].find(t=>t.name==='task_supplement').parameters.properties.expectedVersion.description,/never guess/);assert.equal(toolsets[0].some(t=>/pause|resume/.test(t.name)),false);
 assert.equal((await update('新的人设')).statusCode,200);result=await s.turn(c,'SECOND_PERSONA_CONTEXT','second');assert.equal((await s.finish(c,result.json().turn.id)).status,'succeeded');
 assert.match(seen[1][0].content,/新的人设/);assert.equal(JSON.stringify(seen[1]).includes('FIRST_PERSONA_CONTEXT'),true);assert.equal(JSON.stringify(seen[1]).includes('产品客服，回答简洁'),false);
 assert.equal(s.db.prepare("SELECT count(*) AS n FROM builtin_records WHERE key LIKE 'builtin:session:%'").get().n,1);
});

test('task intent precedes dispatch and accepted notice is queryable while model is stalled; retries do not duplicate',async t=>{
 let round=0,entered;const waiting=new Promise(r=>entered=r);const s=await setup(t,{modelClient:{async complete({signal}){if(++round===1)return response({toolCalls:[{id:'create',name:'task_create',arguments:{input:'分析已授权的资料'}}]});entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('stopped'))));}}});
 const c=await s.conv('real');const result=await s.turn(c,'安排分析任务');await waiting;
 const read=async()=>{const r=await s.call('GET',`${s.base}/conversations/${c.id}/messages`,undefined,s.cookie);assert.equal(r.statusCode,200,r.body);return r.json().messages;};
 let messages=await read();assert.equal(messages.length,3);assert.match(messages[1].text,/准备交给后台处理：分析已授权的资料/);assert.match(messages[2].text,/后台任务已受理/);assert.match(messages[2].text,/不是完成通知/);
 assert.equal(s.calls.length,0);assert.equal(s.db.prepare('SELECT status FROM tasks').get().status,'queued');
 await s.service.tick();assert.equal(s.calls.length,1);assert.equal((await s.turn(c,'安排分析任务')).json().turn.id,result.json().turn.id);assert.equal((await read()).length,3);assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n,1);
 await s.call('POST',`${s.base}/conversations/${c.id}/turns/${result.json().turn.id}/interrupt`,{},s.cookie);await s.finish(c,result.json().turn.id);await s.restart();messages=await read();assert.equal(messages.length,3);
});

test('failed task creation emits no acceptance or completion and creates no business work',async t=>{
 const s=await setup(t,{runtime:undefined,modelClient:{async complete(){return response({toolCalls:[{id:'create',name:'task_create',arguments:{input:'尚不可执行的任务'}}]});}}});const c=await s.conv('real');const r=await s.turn(c);assert.equal((await s.finish(c,r.json().turn.id)).status,'failed');
 const messages=(await s.call('GET',`${s.base}/conversations/${c.id}/messages`,undefined,s.cookie)).json().messages;
 assert.equal(messages.length,3);assert.match(messages[1].text,/准备交给后台处理/);assert.match(messages[2].text,/未创建成功/);assert.equal(messages.some(m=>m.text.includes('已受理')),false);for(const table of ['tasks','runs','task_outbox'])assert.equal(s.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
 const retry=await s.turn(c);assert.equal(retry.json().turn.id,r.json().turn.id);assert.equal(s.db.prepare("SELECT count(*) AS n FROM conversation_message_index WHERE id LIKE 'task-notice:%'").get().n,2);
});

test('two authorized users prepare independent interaction sessions for one employee without prompt/history collision',async t=>{
 const seen=[];const s=await setup(t,{modelClient:{async complete(input){seen.push(JSON.stringify(input.messages));return response({text:'Private reply'});}}});
 const invited=await s.call('POST',`/api/workspaces/${s.user.workspace.id}/invitations`,{role:'member',expiresInHours:1},s.cookie);assert.equal(invited.statusCode,200,invited.body);
 const guest=await s.call('POST','/api/auth/register',{username:'second-interaction-user',password:'Synthetic guest account password 2026!',invitationToken:invited.json().token});assert.equal(guest.statusCode,201,guest.body);const g=guest.json(),cookie=guest.headers['set-cookie'].split(';')[0];
 const allowed=await s.call('PUT',s.base+'/web-access',{allowMemberIds:[s.user.workspace.memberId,g.workspace.memberId],denyMemberIds:[]},s.cookie);assert.equal(allowed.statusCode,200,allowed.body);
 const a=await s.conv('real'),first=await s.turn(a,'OWNER_PRIVATE');assert.equal((await s.finish(a,first.json().turn.id)).status,'succeeded');
 const created=await s.call('POST',s.base+'/conversations',{mode:'real'},cookie);assert.equal(created.statusCode,201,created.body);const b=created.json().conversation;
 const second=await s.call('POST',`${s.base}/conversations/${b.id}/turns`,{operationId:'guest-turn',text:'GUEST_PRIVATE'},cookie);assert.equal(second.statusCode,202,second.body);
 let final;for(let i=0;i<100;i++){const r=await s.call('GET',`${s.base}/conversations/${b.id}/turns/${second.json().turn.id}`,undefined,cookie);assert.equal(r.statusCode,200,r.body);final=r.json().turn;if(final.status==='succeeded')break;await new Promise(resolve=>setTimeout(resolve,2));}assert.equal(final.status,'succeeded');
 assert.equal(seen.length,2);assert.equal(seen[0].includes('GUEST_PRIVATE'),false);assert.equal(seen[1].includes('OWNER_PRIVATE'),false);assert.equal(s.db.prepare("SELECT count(*) AS n FROM builtin_records WHERE key LIKE 'builtin:session:%'").get().n,2);
 // Active members may manage shared employee configuration (spec 40); private conversations remain isolated.
 assert.equal((await s.call('PUT',s.base+'/description',{description:'Shared employee style'},cookie)).statusCode,200);
 assert.equal((await s.call('GET',`${s.base}/conversations/${a.id}/messages`,undefined,cookie)).statusCode,404);
});


test('real and demo conversation bodies live only in JSONL; DTO and restart hydrate identical text',async t=>{
 const s=await setup(t,{modelClient:{async complete(){return response({text:'JOURNAL_ONLY_OUTPUT'});}}});
 const real=await s.conv('real');s.historical('JOURNAL_ONLY_DEMO');const started=await s.turn(real,'JOURNAL_ONLY_INPUT');await s.finish(real,started.json().turn.id);
 for(const [table,forbidden] of [['conversation_message_index',['text']],['interaction_turns',['text','output','request_json']]]){const columns=s.db.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name);for(const column of forbidden)assert.equal(columns.includes(column),false);}
 assert.equal(s.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('interaction_content','conversation_messages')").get(),undefined);
 for(const table of ['conversation_message_index','interaction_turns','builtin_content_refs','builtin_records']){const rows=JSON.stringify(s.db.prepare(`SELECT * FROM ${table}`).all());for(const marker of ['JOURNAL_ONLY_INPUT','JOURNAL_ONLY_OUTPUT','JOURNAL_ONLY_DEMO'])assert.equal(rows.includes(marker),false,table);}
 const files=(await readdir(join(s.dir,'builtin-records'),{recursive:true})).filter(name=>name.endsWith('.jsonl'));assert.equal(files.filter(name=>name.endsWith('/current.jsonl')).length,1,'Only the real model Session has an effective history projection; demo remains read-only payloads');assert.ok(files.some(name=>name.includes('/payloads/')),'Private payloads are separate from effective model history');
 const bodies=(await Promise.all(files.map(name=>readFile(join(s.dir,'builtin-records',name),'utf8')))).join('\n');for(const marker of ['JOURNAL_ONLY_INPUT','JOURNAL_ONLY_OUTPUT','JOURNAL_ONLY_DEMO'])assert.ok(bodies.includes(marker));
 await s.restart();const result=await s.call('GET',`${s.base}/conversations/${real.id}/messages`,undefined,s.cookie);assert.deepEqual(result.json().messages.map(m=>m.text),['JOURNAL_ONLY_INPUT','JOURNAL_ONLY_OUTPUT']);
});


test('real SQLite terminal publication failure recovers journal commit after restart without replay',async t=>{
 let modelCalls=0;const s=await setup(t,{modelClient:{async complete(){modelCalls++;return response(modelCalls===1?{toolCalls:[{id:'recoverable-create',name:'task_create',arguments:{input:'TERMINAL_RECOVERY_TASK_FACT'}}]}:{text:'TERMINAL_RECOVERY_OUTPUT'});}}});const c=await s.conv('real');
 s.db.exec("CREATE TRIGGER fail_terminal_publish BEFORE UPDATE ON builtin_records WHEN json_extract(NEW.json,'$.status')='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic terminal publication failure'); END;");
 const started=await s.turn(c,'TERMINAL_RECOVERY_INPUT');assert.equal(started.statusCode,202,started.body);const id=started.json().turn.id;
 let terminalWritten=false;for(let n=0;n<100;n++){const files=(await readdir(join(s.dir,'builtin-records'),{recursive:true})).filter(name=>name.endsWith('.jsonl'));const lines=(await Promise.all(files.map(name=>readFile(join(s.dir,'builtin-records',name),'utf8')))).join('\n');if(lines.includes('"kind":"terminal_commit"')){terminalWritten=true;break;}await new Promise(resolve=>setTimeout(resolve,2));}assert.ok(terminalWritten);
 const blocked=await s.call('GET',`${s.base}/conversations/${c.id}/turns/${id}`,undefined,s.cookie);assert.notEqual(blocked.json().turn?.status,'succeeded');assert.equal(s.db.prepare("SELECT count(*) AS n FROM builtin_records WHERE json_extract(json,'$.status')='succeeded'").get().n,0);
 s.db.exec('DROP TRIGGER fail_terminal_publish');await s.restart();const recovered=await s.finish(c,id);assert.equal(recovered.status,'succeeded');assert.equal(recovered.text,'TERMINAL_RECOVERY_OUTPUT');assert.equal(modelCalls,2);
 const messages=(await s.call('GET',`${s.base}/conversations/${c.id}/messages`,undefined,s.cookie)).json().messages;assert.deepEqual(messages.filter(m=>!m.id.startsWith('task-notice:')).map(m=>m.text),['TERMINAL_RECOVERY_INPUT','TERMINAL_RECOVERY_OUTPUT']);assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n,1);assert.equal(s.db.prepare('SELECT count(*) AS n FROM builtin_operations').get().n,1);assert.equal(s.db.prepare('SELECT status FROM builtin_operations').get().status,'completed');
 const replay=await s.turn(c,'TERMINAL_RECOVERY_INPUT');assert.equal(replay.json().turn.id,id);assert.equal(modelCalls,2);assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n,1);assert.equal(s.db.prepare('SELECT count(*) AS n FROM builtin_operations').get().n,1);
});

test('expiry during blocked generation revokes refs and prevents late journal recreation',async t=>{
 let entered,release;const started=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>release=resolve);const s=await setup(t,{conversationTtlMs:10,modelClient:{async complete(){entered();await blocked;return response({text:'LATE_EXPIRED_OUTPUT'});}}});const c=await s.conv('real');const result=await s.turn(c,'EXPIRED_ACTIVE_INPUT');assert.equal(result.statusCode,202,result.body);await started;
 // Maintenance uses its own trusted authorization envelope, not a human request context.
 for(const [key,conversationId]of [['builtin:maintenance:expired',c.id],['builtin:maintenance:other','other-conversation']])s.db.prepare('INSERT INTO builtin_records(key,version,json) VALUES(?,1,?)').run(key,JSON.stringify({request:{authorization:{conversationId}},snapshotRef:{recordId:'private-snapshot-ref'}}));
 s.advance(11);s.purgeExpired();assert.equal(s.db.prepare('SELECT key FROM builtin_records WHERE key=?').get('builtin:maintenance:expired'),undefined);assert.ok(s.db.prepare('SELECT key FROM builtin_records WHERE key=?').get('builtin:maintenance:other'));assert.equal(s.db.prepare("SELECT count(*) AS n FROM builtin_records WHERE key LIKE 'builtin:session:%' OR key LIKE 'builtin:execution:%'").get().n,0);assert.equal((await readdir(join(s.dir,'builtin-records'),{recursive:true})).filter(name=>name.endsWith('.jsonl')).length,0);
 release();await s.restart();assert.equal((await readdir(join(s.dir,'builtin-records'),{recursive:true})).filter(name=>name.endsWith('.jsonl')).length,0);assert.equal(s.db.prepare('SELECT count(*) AS n FROM conversation_message_index').get().n,0);assert.equal(s.db.prepare('SELECT count(*) AS n FROM builtin_content_refs').get().n,0);
 const inaccessible=await s.call('GET',`${s.base}/conversations/${c.id}/turns/${result.json().turn.id}`,undefined,s.cookie);assert.equal(inaccessible.statusCode,404);assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM builtin_records').all()).includes('LATE_EXPIRED_OUTPUT'),false);
});

test('historical automatic creation retries preserve read-only identity and never convert to real',async t=>{
 const s=await setup(t),c=s.historical('LEGACY_INPUT','LEGACY_REPLY','demo','automatic');
 const replay=await s.call('POST',s.base+'/conversations',{mode:'auto',operationId:'automatic'},s.cookie);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().conversation.id,c.id);assert.equal(replay.json().conversation.mode,'demo');
 const conflict=await s.call('POST',s.base+'/conversations',{mode:'real',operationId:'automatic'},s.cookie);assert.equal(conflict.statusCode,409,conflict.body);assert.equal(conflict.json().error,'operation_conflict');
 const fresh=await s.call('POST',s.base+'/conversations',{mode:'auto',operationId:'fresh'},s.cookie);assert.equal(fresh.statusCode,409,fresh.body);assert.equal(fresh.json().error,'model_not_configured');
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM conversations').get().n,1);assert.equal(s.db.prepare('SELECT mode FROM conversations').get().mode,'demo');
});

test('automatic mode resolves catalog selection and default but never hides invalid or removed profiles',async t=>{
 const config={masterKey:Buffer.alloc(32,7)};
 const s=await setup(t,{modelProfiles:config});const store=new Store(s.databasePath),profiles=new ModelProfileService(store,config);t.after(()=>store.close());
 const ws=s.user.workspace.id,entity=s.entity.id;
 const input={name:'Shared default',provider:'openai-compatible',endpoint:'https://synthetic.invalid/v1',modelId:'synthetic-model',apiKey:'synthetic-not-real'};
 const profile=profiles.saveWorkspace(ws,input);
 const create=()=>s.call('POST',s.base+'/conversations',{},s.cookie);
 const inherited=await create();assert.equal(inherited.statusCode,201,inherited.body);assert.equal(inherited.json().conversation.mode,'real');
 profiles.setDefault(ws,null);
 const unselected=await create();assert.equal(unselected.statusCode,200,unselected.body);assert.equal(unselected.json().conversation.id,inherited.json().conversation.id);
 profiles.select(ws,entity,profile.id);
 profiles.save(ws,entity,{...input,enabled:false});
 const disabled=await create();assert.equal(disabled.statusCode,200);assert.notEqual(disabled.json().conversation?.mode,'demo');
 profiles.save(ws,entity,{...input,apiKey:null});
 const missingKey=await create();assert.equal(missingKey.statusCode,200);assert.notEqual(missingKey.json().conversation?.mode,'demo');
 profiles.save(ws,entity,input);
 const selected=await create();assert.equal(selected.statusCode,200,selected.body);assert.equal(selected.json().conversation.mode,'real');
 profiles.select(ws,entity,null);profiles.deleteProfile(ws,profile.id);
 const old=await s.turn(selected.json().conversation);assert.equal(old.statusCode,409);assert.equal(old.json().error,'model_not_configured');
 const newConversation=await create();assert.equal(newConversation.statusCode,200,newConversation.body);assert.equal(newConversation.json().conversation.id,inherited.json().conversation.id);
 const retry=await s.turn(inherited.json().conversation);assert.equal(retry.statusCode,409,'Existing real conversation must remain real after deleting last profile');
});


test('revoking a configured model blocks new work but preserves authorized task reads and cancellation',async t=>{
 const config={masterKey:Buffer.alloc(32,19)},s=await setup(t,{modelProfiles:config});
 const store=new Store(s.databasePath),profiles=new ModelProfileService(store,config);t.after(()=>store.close());
 const profile=profiles.save(s.user.workspace.id,s.entity.id,{name:'Synthetic only',provider:'openai-compatible',endpoint:'https://synthetic.invalid/v1',modelId:'synthetic-model',apiKey:'synthetic-unused-local-credential'});
 const c=await s.conv('real'),created=await s.call('POST',s.base+'/tasks',{operationId:'before-revoke',conversationId:c.id,input:'Existing authorized task'},s.cookie);assert.equal(created.statusCode,202,created.body);const task=created.json().task;await s.service.tick();assert.equal(s.calls.length,1);
 profiles.revoke(s.user.workspace.id,profile.id);
 const read=await s.call('GET',s.base+`/conversations/${c.id}/tasks/${task.id}`,undefined,s.cookie);assert.equal(read.statusCode,200,read.body);assert.equal(read.json().task.status,'running');
 assert.equal((await s.call('GET',s.base+`/conversations/${c.id}/tasks/${task.id}/updates`,undefined,s.cookie)).statusCode,200);assert.equal((await s.call('GET',`${s.base}/conversations/${c.id}/messages`,undefined,s.cookie)).statusCode,200);
 const refused=await s.call('POST',s.base+'/tasks',{operationId:'after-revoke',conversationId:c.id,input:'Must not enqueue new work'},s.cookie);assert.equal(refused.statusCode,409,refused.body);assert.equal(refused.json().error,'model_profile_unavailable');
 const canceled=await s.call('POST',s.base+`/conversations/${c.id}/tasks/${task.id}/cancel`,{operationId:'cancel-after-revoke',expectedVersion:read.json().task.version},s.cookie);assert.equal(canceled.statusCode,200,canceled.body);assert.equal(canceled.json().task.status,'cancel_requested');
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n,1);assert.equal(s.db.prepare('SELECT count(*) AS n FROM runs').get().n,1);
});

test('task tools inject logical conversation, hide identity arguments and isolate todo/list/start/cancel',async t=>{
 let command={name:'task_create_todo',arguments:{input:'Current conversation todo',title:'当前会话待办'}},schemas=[],toolResults=[],toolCalls=0;
 const s=await setup(t,{modelClient:{async complete({messages,tools}){schemas=tools;const last=messages.at(-1);if(last.role==='tool'){toolResults.push(JSON.parse(last.content));return response({text:'已按平台回执处理。'});}return response({toolCalls:[{id:`tool-${++toolCalls}`,name:command.name,arguments:command.arguments}]});}}});
 const c=await s.conv('real'),c2=s.historical('LEGACY_TOOL_INPUT','LEGACY_TOOL_REPLY','real');
 const run=async(conversation,op)=>{const started=await s.turn(conversation,'Synthetic tool request',op);assert.equal(started.statusCode,202,started.body);return s.finish(conversation,started.json().turn.id);};
 assert.equal((await run(c,'save-todo')).status,'succeeded');const todo=s.db.prepare('SELECT * FROM tasks').get();assert.equal(todo.title,'当前会话待办');assert.equal(todo.input,'Current conversation todo');assert.equal(schemas.find(t=>t.name==='task_create_todo').parameters.properties.title.type,'string');assert.equal(todo.status,'planned');assert.equal(todo.conversation_id,c.id);assert.equal(todo.run_id,null);assert.equal(s.calls.length,0);
 for(const schema of schemas.filter(t=>t.name.startsWith('task_')))for(const key of ['sessionId','conversationId','actor','workspaceId','entityId','source'])assert.equal(key in (schema.parameters.properties??{}),false,`${schema.name} exposes ${key}`);
 command={name:'task_list',arguments:{status:'planned'}};assert.equal((await run(c2,'other-session-list')).status,'succeeded');assert.deepEqual(toolResults.at(-1).tasks,[]);
 command={name:'task_query',arguments:{taskId:todo.id}};assert.equal((await run(c2,'foreign-task-query')).status,'failed');assert.equal(s.db.prepare('SELECT count(*) n FROM task_operations').get().n,0);
 command={name:'task_start',arguments:{taskId:todo.id,expectedVersion:1}};assert.equal((await run(c2,'foreign-task-start')).status,'failed');assert.equal(s.db.prepare('SELECT count(*) n FROM runs').get().n,0);
 command={name:'task_list',arguments:{status:'planned'}};assert.equal((await run(c,'own-session-list')).status,'succeeded');assert.equal(toolResults.at(-1).tasks[0].id,todo.id);
 command={name:'task_start',arguments:{taskId:todo.id,expectedVersion:1}};assert.equal((await run(c,'own-session-start')).status,'succeeded');assert.equal(s.db.prepare('SELECT count(*) n FROM runs').get().n,1);assert.equal(s.calls.length,0);
 const current=s.db.prepare('SELECT version FROM tasks').get();command={name:'task_cancel_todo',arguments:{taskId:todo.id,expectedVersion:current.version}};assert.equal((await run(c,'already-started')).status,'succeeded');assert.equal(toolResults.at(-1).actionReceipt.status,'already_started');assert.equal(s.db.prepare("SELECT count(*) n FROM task_outbox WHERE kind='cancel'").get().n,0);
 command={name:'task_list',arguments:{conversationId:c2.id}};assert.equal((await run(c,'forged-context-parameter')).status,'failed');
});

test('completed task operation cache reauthorizes its Task after package changes without repeating the write',async t=>{
 let s,packageId,rounds=0,observed=0;
 const input='CACHED_TASK_GRANT_FACT';
 s=await setup(t,{modelClient:{async complete({messages}){
   rounds++;
   if(rounds===1)return response({toolCalls:[{id:'initial-write',name:'task_create',arguments:{input}}]});
   observed++;assert.equal(JSON.parse(messages.at(-1).content).input,input);
   if(rounds===2){
     const changed=await s.call('PUT',`${s.base}/capability-packages/${packageId}`,{name:'Changed grant version',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[]},s.cookie);assert.equal(changed.statusCode,200,changed.body);
     const task=s.db.prepare('SELECT * FROM tasks').get(),read=await s.call('GET',`${s.base}/conversations/${task.conversation_id}/tasks/${task.id}`,undefined,s.cookie);assert.equal(read.statusCode,409,read.body);
     return response({toolCalls:[{id:'regenerated-write',name:'task_create',arguments:{input}}]});
   }
   return response({text:'Must not receive a revoked cached DTO'});
 }}});
 const pack=await s.call('POST',s.base+'/capability-packages',{name:'Original grant',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[]},s.cookie);assert.equal(pack.statusCode,200,pack.body);packageId=pack.json().id;
 const c=await s.conv('real'),started=await s.turn(c,'Synthetic cached operation','cache-grant-review');assert.equal(started.statusCode,202,started.body);assert.equal((await s.finish(c,started.json().turn.id)).status,'failed');assert.equal(rounds,2);assert.equal(observed,1);
 assert.equal(s.db.prepare('SELECT count(*) n FROM tasks').get().n,1);assert.equal(s.db.prepare('SELECT count(*) n FROM runs').get().n,1);assert.equal(s.db.prepare("SELECT count(*) n FROM builtin_operations WHERE status='completed'").get().n,1);assert.equal(s.calls.length,0);
});
test('authorized completed-operation cache returns current Task facts after explicit start',async t=>{
 let s,rounds=0,expectedRun;
 s=await setup(t,{modelClient:{async complete({messages}){
   rounds++;
   if(rounds===1)return response({toolCalls:[{id:'save',name:'task_create_todo',arguments:{input:'CACHED_CURRENT_TASK_FACT'}}]});
   const cached=JSON.parse(messages.at(-1).content);
   if(rounds===2){
     const started=await s.service.startTodo({workspaceId:s.user.workspace.id,entityId:s.entity.id,userId:s.user.user.id,conversationId:s.db.prepare('SELECT conversation_id FROM tasks WHERE id=?').get(cached.id).conversation_id},cached.id,{operationId:'explicit-host-start',expectedVersion:cached.version});expectedRun=started.run.id;
     return response({toolCalls:[{id:'repeat-save',name:'task_create_todo',arguments:{input:'CACHED_CURRENT_TASK_FACT'}}]});
   }
   assert.equal(cached.status,'queued');assert.equal(cached.executionStatus,'preparing');assert.equal('run' in cached,false);assert.equal(s.db.prepare('SELECT run_id FROM tasks WHERE id=?').get(cached.id).run_id,expectedRun);return response({text:'Current authorized facts received'});
 }}});
 const c=await s.conv('real'),started=await s.turn(c,'Synthetic current cached operation','cache-current-review');assert.equal((await s.finish(c,started.json().turn.id)).status,'succeeded');assert.equal(rounds,3);assert.equal(s.db.prepare('SELECT count(*) n FROM tasks').get().n,1);assert.equal(s.db.prepare('SELECT count(*) n FROM runs').get().n,1);assert.equal(s.calls.length,0);
});

test('offline legacy test reset is backed up, idempotent and keeps account/config/task/message data while the same conversation gets a stable context',async t=>{
 let models=0;const s=await setup(t,{modelClient:{async complete(){models++;return response({text:'Synthetic reset greeting'});}}});const c=await s.conv('real'),first=await s.turn(c,'hello','before-reset');assert.equal(first.statusCode,202);assert.equal((await s.finish(c,first.json().turn.id)).status,'succeeded');await s.stop();
 const row=s.db.prepare("SELECT * FROM builtin_records WHERE key LIKE 'builtin:session:%'").get(),v=JSON.parse(row.json),oldKey=row.key+':legacy';v.handle.sessionId=c.id+':legacy';v.handle.opaqueHandle='old-opaque';s.db.prepare('UPDATE builtin_records SET key=?,json=? WHERE key=?').run(oldKey,JSON.stringify(v),row.key);
 const tables=['users','credentials','workspaces','members','entities','model_catalog','employee_channel_connections','tasks','runs','conversation_message_index'];const snapshot=()=>Object.fromEntries(tables.map(table=>[table,s.db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));const before=snapshot(),oldJSONL=await readFile(join(s.dir,'builtin-records',v.handle.recordLocation.resourceId,'current.jsonl'),'utf8');
 const options={databasePath:s.databasePath,journalRoot:join(s.dir,'builtin-records'),dryRun:true};const dry=await resetLegacyBuiltinHistory(options);assert.equal(dry.status,'ready');assert.equal(dry.sessions,1);
 const cli=spawnSync(process.execPath,[resolve('scripts/maintenance/reset-builtin-test-context.mjs'),'--database',s.databasePath,'--journal-root',options.journalRoot],{encoding:'utf8',timeout:10000});assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),dry);assert.equal(s.db.prepare('SELECT json FROM builtin_records WHERE key=?').get(oldKey).json,JSON.stringify(v));
 const backupDirectory=join(s.dir,'private-backup');const applied=await resetLegacyBuiltinHistory({...options,dryRun:false,offlineConfirmed:true,backupDirectory});assert.equal(applied.status,'archived');assert.deepEqual(snapshot(),before);assert.equal(await readFile(join(s.dir,'builtin-records',v.handle.recordLocation.resourceId,'current.jsonl'),'utf8'),oldJSONL);assert.equal(JSON.parse(s.db.prepare('SELECT json FROM builtin_records WHERE key=?').get(oldKey).json).closed,true);
 const backupDb=new DatabaseSync(join(backupDirectory,'database.sqlite'),{readOnly:true});assert.equal(JSON.parse(backupDb.prepare('SELECT json FROM builtin_records WHERE key=?').get(oldKey).json).closed,false);backupDb.close();assert.equal((await resetLegacyBuiltinHistory({...options,dryRun:false,offlineConfirmed:true,backupDirectory})).status,'already_current');
 await s.restart();const next=await s.turn(c,'hello after reset','after-reset');assert.equal(next.statusCode,202,next.body);assert.equal((await s.finish(c,next.json().turn.id)).status,'succeeded');assert.equal(models,2);const live=s.db.prepare("SELECT json FROM builtin_records WHERE key LIKE 'builtin:session:%' AND json_extract(json,'$.closed')=0").all();assert.equal(live.length,1);assert.equal(JSON.parse(live[0].json).handle.sessionId,c.id);const msgs=await s.call('GET',`${s.base}/conversations/${c.id}/messages`,undefined,s.cookie);assert.equal(msgs.statusCode,200);assert.ok(msgs.json().messages.some(m=>m.text==='hello'));
});
test('legacy context reset blocks unresolved generation without backup, mutation or model replay',async t=>{
 const s=await setup(t,{modelClient:{async complete(){return response({text:'done'});}}}),c=await s.conv('real'),r=await s.turn(c,'hello');await s.finish(c,r.json().turn.id);await s.stop();const row=s.db.prepare("SELECT * FROM builtin_records WHERE key LIKE 'builtin:session:%'").get(),v=JSON.parse(row.json);v.handle.sessionId+=':legacy';v.activeExecution='unresolved';s.db.prepare('UPDATE builtin_records SET json=? WHERE key=?').run(JSON.stringify(v),row.key);const report=await resetLegacyBuiltinHistory({databasePath:s.databasePath,journalRoot:join(s.dir,'builtin-records'),dryRun:true});assert.equal(report.status,'blocked');assert.ok(report.blocked.includes('unresolved_generation_or_maintenance'));const startup=spawnSync(process.execPath,[resolve('apps/control-plane/dist/main.js')],{cwd:s.dir,env:{PATH:process.env.PATH,HOME:s.dir,DENTITY_DATABASE_PATH:s.databasePath,DENTITY_BUILTIN_RECORD_ROOT:join(s.dir,'builtin-records'),DENTITY_MAINTENANCE_ENABLED:'false',DENTITY_CONTROL_PLANE_PORT:'29322'},encoding:'utf8',timeout:10000});assert.equal(startup.status,1,startup.stderr);assert.match(startup.stderr,/builtin_test_context_reset_required.*privately backed up and archived/);assert.doesNotMatch(startup.stderr,/check the port/);assert.equal(s.db.prepare('SELECT json FROM builtin_records WHERE key=?').get(row.key).json,JSON.stringify(v));
});

test('configuration change during a generation preserves its snapshot and old-result polling; next generation uses new model after restart',async t=>{
 let revision='one',enter,release;const entered=new Promise(r=>enter=r),hold=new Promise(r=>release=r),captured=[];const s=await setup(t,{modelClientForScope:async()=>{const pinned=revision;return{revision:pinned,client:{async complete(input){captured.push({revision:pinned,messages:input.messages});if(pinned==='one'){enter();await hold;}return response({text:`answer-${pinned}`});}}};}});
 const c=await s.conv('real'),a=await s.turn(c,'first generation','pinned-first');assert.equal(a.statusCode,202);await entered;revision='two';const polling=await s.call('GET',`${s.base}/conversations/${c.id}/turns/${a.json().turn.id}`,undefined,s.cookie);assert.equal(polling.statusCode,200,polling.body);assert.notEqual(polling.json().turn.status,'unknown');
 const b=await s.turn(c,'second generation','pinned-second');assert.equal(b.statusCode,202,b.body);assert.equal(b.json().turn.status,'queued');release();assert.equal((await s.finish(c,a.json().turn.id)).status,'succeeded');assert.equal((await s.finish(c,b.json().turn.id)).status,'succeeded');assert.deepEqual(captured.map(x=>x.revision),['one','two']);assert.ok(captured[1].messages.some(m=>m.content==='answer-one'));assert.equal(s.db.prepare("select count(*) n from builtin_records where key like 'builtin:session:%'").get().n,1);
 await s.restart();const old=await s.call('GET',`${s.base}/conversations/${c.id}/turns/${a.json().turn.id}`,undefined,s.cookie);assert.equal(old.json().turn.status,'succeeded');const retry=await s.turn(c,'first generation','pinned-first');assert.equal(retry.json().turn.id,a.json().turn.id);assert.equal(captured.length,2);
});

test('new interaction inputs contain only employee behavior and business task views; acceptance does not poll execution',async t=>{
 let mode='create',taskId,rounds=0;const calls=[],received=[];
 const s=await setup(t,{modelClient:{async complete({messages,tools}){
  const system=messages.find(m=>m.role==='system').content;
  assert.doesNotMatch(system,/Runtime|Adapter|Session|\bRun\b|Dentity|DENTITY|能力包|装配|平台|进程|沙箱|steer|platform_record_only|runtime_input/);
  assert.doesNotMatch(system,/Skill|local-mock|合成业务/i);for(const tool of tools)assert.doesNotMatch(tool.description,/Skill|local-mock|合成业务/i);
  for(const part of ['一、身份与表达','二、理解与处理需求','三、准确转交任务','四、工具调用与及时回复','五、管理已有任务','六、人工确认','七、信息与权限','不能仅因自己没有直接查询工具就拒绝','默认只读','立即简短回复并结束本轮','不向用户播报自检','不能隐藏失败','不提前声称已安排或完成'])assert.ok(system.includes(part),part);
  assert.doesNotMatch(JSON.stringify(tools),/Runtime|Adapter|Session|\bRun\b|Dentity|platform_record_only|runtime_input|host inject|能力包|装配/);
  const last=messages.at(-1);if(last.role==='tool'){
   const value=JSON.parse(last.content);received.push(value);taskId=value.id;
   assert.doesNotMatch(last.content,/runtimeId|runtimeVersion|actionCapabilities|bindingVersion|runtimeDelivery|runtimeStatus|deliveryMode|runId|conversationId|entityId|operationId|eventId|sequence/);
   return response({text:mode==='create'?'已安排查看，你可以继续聊其他事情。':'已查到当前任务结果。'});
  }
  const name=mode==='create'?'task_create':'task_query_results';calls.push(name);rounds++;
  return response({toolCalls:[{id:`behavior-${rounds}`,name,arguments:mode==='create'?{input:'读取指定 Skill 的说明并解释用途；仅阅读，不执行其中操作。'}:{taskId}}]});
 }}});
 const c=await s.conv('real'),first=await s.turn(c,'看看指定 Skill 是干什么的','skill-read');assert.equal((await s.finish(c,first.json().turn.id)).status,'succeeded');
 assert.deepEqual(calls,['task_create']);assert.equal(s.calls.length,0);assert.equal(received[0].status,'queued');assert.equal(received[0].result,null);
 const row=s.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
 s.service.ingest(row.run_id,{eventId:'business-progress',runId:row.run_id,sequence:1,type:'progress',text:'说明已读取'});
 s.service.ingest(row.run_id,{eventId:'business-result',runId:row.run_id,sequence:2,type:'final_result',text:'这是用于查询合成业务数据的 Skill。',inputRevision:1});
 s.service.ingest(row.run_id,{eventId:'business-success',runId:row.run_id,sequence:3,type:'status',status:'succeeded'});
 mode='query';const query=await s.turn(c,'查看结果','skill-result');assert.equal((await s.finish(c,query.json().turn.id)).status,'succeeded');
 assert.deepEqual(calls,['task_create','task_query_results']);assert.equal(received[1].result,'这是用于查询合成业务数据的 Skill。');assert.equal(received[1].status,'succeeded');assert.equal(received[1].updates[0].text,'说明已读取');assert.equal(s.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
});

test('model list pagination preserves opaque cursors and current task authorization with clean rows',async t=>{
 let cursor;const pages=[];let calls=0;
 const s=await setup(t,{modelClient:{async complete({messages}){
  if(messages.at(-1).role==='tool'){
   const page=JSON.parse(messages.at(-1).content);pages.push(page);assert.deepEqual(Object.keys(page).sort(),['nextCursor','tasks']);
   assert.doesNotMatch(JSON.stringify(page.tasks),/runtimeId|bindingVersion|actionCapabilities|runtimeDelivery|operationId|conversationId|entityId|runId/);
   if(page.nextCursor){cursor=page.nextCursor;return response({toolCalls:[{id:`page-${++calls}`,name:'task_list',arguments:{status:'planned',limit:2,cursor}}]});}
   return response({text:'待办已列出。'});
  }
  return response({toolCalls:[{id:`page-${++calls}`,name:'task_list',arguments:{status:'planned',limit:2}}]});
 }}});
 const c=await s.conv('real');for(let i=0;i<3;i++){const saved=await s.call('POST',`${s.base}/conversations/${c.id}/todos`,{operationId:`page-todo-${i}`,input:`待办 ${i}`},s.cookie);assert.equal(saved.statusCode,201,saved.body);}
 const started=await s.turn(c,'列出我的待办','list-pages');assert.equal((await s.finish(c,started.json().turn.id)).status,'succeeded');assert.deepEqual(pages.map(p=>p.tasks.length),[2,1]);assert.equal(typeof cursor,'string');assert.equal(pages[1].nextCursor,null);assert.equal(new Set(pages.flatMap(p=>p.tasks.map(t=>t.id))).size,3);assert.equal(s.db.prepare('SELECT count(*) n FROM runs').get().n,0);
});

for(const toolName of ['task_query','task_query_results'])test(`${toolName} handles 527 durable stream fragments within unchanged interaction budgets`,async t=>{
 let taskId;const observed=[];
 const s=await setup(t,{modelClient:{async complete({messages}){
  const last=messages.at(-1);if(last.role!=='tool')return response({toolCalls:[{id:'stream-query',name:toolName,arguments:{taskId}}]});
  const value=JSON.parse(last.content);observed.push(value);assert.equal(value.updates.some(u=>u.type==='output_delta'),false);return response({text:'查询已完成，结果已取得。'});
 }}});
 const c=await s.conv('real'),created=await s.call('POST',`${s.base}/conversations/${c.id}/tasks`,{operationId:'fragment-query',input:'读取合成资料并说明结果'},s.cookie);assert.equal(created.statusCode,202,created.body);const task=created.json().task;taskId=task.id;
 const text='合成结果：'+'业务说明。'.repeat(130);let sequence=0;
 const ingest=event=>s.service.ingest(task.run.id,{eventId:`fragment-${++sequence}`,runId:task.run.id,sequence,...event});
 ingest({type:'status',status:'running'});ingest({type:'progress',text:'资料已读取'});
 for(let i=0;i<527;i++)ingest({type:'output_delta',text:text.slice(Math.floor(i*text.length/527),Math.floor((i+1)*text.length/527))});
 ingest({type:'final_result',text,inputRevision:1});ingest({type:'status',status:'succeeded'});
 const started=await s.turn(c,'现在处理得怎么样了？','query-with-fragments'),finished=await s.finish(c,started.json().turn.id);
 assert.equal(finished.status,'succeeded');assert.equal(finished.text,'查询已完成，结果已取得。');assert.equal(observed.length,1);assert.equal(observed[0].result,text);assert.equal(observed[0].status,'succeeded');assert.equal(observed[0].updates.find(u=>u.type==='progress').text,'资料已读取');
 const raw=(await s.call('GET',`${s.base}/conversations/${c.id}/tasks/${task.id}/updates`,undefined,s.cookie)).json();
 assert.equal(raw.updates.filter(u=>u.type==='output_delta').length,527);assert.equal(raw.updates.find(u=>u.type==='final_result').text,text);assert.equal(s.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
});


// Deterministic ModelClient + existing isolated execution fixture; no model API or channel.
const lastToolResult=messages=>JSON.parse(messages.filter(m=>m.role==='tool').at(-1).content);
const mutationCall=(name,taskId,expectedVersion,id='mutation')=>response({toolCalls:[{id,name,arguments:{taskId,expectedVersion,...(name==='task_supplement'?{input:'Additional synthetic requirement'}:{})}}]});
function assertVersionRejection(value,taskId,name){
 assert.equal(value.status,'rejected');assert.equal(value.taskId,taskId);
 assert.equal(value.action,name==='task_cancel'?'cancel':'supplement');
 assert.deepEqual(value.error,{code:'version_conflict',applied:false,message:'This operation was not applied because the task version changed.'});
 assert.equal(value.nextAction.tool,'task_query');assert.deepEqual(value.nextAction.arguments,{taskId});
 assert.equal('version' in value,false,'The model must query current state instead of receiving an invented version');
}
for(const name of ['task_supplement','task_cancel'])for(const planned of [false,true])test(`${name} returns a confirmed unapplied version rejection and allows model-selected query (${planned?'planned':'active'})`,async t=>{
 let rounds=0,taskId='',staleVersion,currentVersion,initialRevision;const seen=[];
 const s=await setup(t,{modelClient:{async complete({messages}){
   rounds++;if(rounds===1)return mutationCall(name,taskId,staleVersion);
   if(rounds===2){const rejected=lastToolResult(messages);seen.push(rejected);assertVersionRejection(rejected,taskId,name);
     assert.equal(s.db.prepare('SELECT count(*) n FROM task_operations WHERE task_id=?').get(taskId).n,0);
     return response({toolCalls:[{id:'query',name:'task_query',arguments:{taskId}}]});}
   if(rounds===3){const current=lastToolResult(messages);assert.equal(current.id,taskId);assert.equal(current.version,currentVersion);return mutationCall(name,taskId,current.version,'new-intent');}
   const receipt=lastToolResult(messages);assert.equal(receipt.actionReceipt.action,name==='task_cancel'?'cancel':'supplement');return response({text:'Observed authoritative action receipt; execution completion is not implied.'});
 }}});const c=await s.conv('real');
 const created=await s.call('POST',planned?`${s.base}/conversations/${c.id}/todos`:s.base+'/tasks',{operationId:'create',conversationId:c.id,input:'Synthetic task'},s.cookie);assert.ok([201,202].includes(created.statusCode),created.body);let task=created.json().task;taskId=task.id;staleVersion=task.version;initialRevision=task.inputRevision;
 if(planned)s.db.prepare('UPDATE tasks SET version=version+1 WHERE id=?').run(taskId);else await s.service.tick();
 currentVersion=s.db.prepare('SELECT version FROM tasks WHERE id=?').get(taskId).version;
 const turn=await s.turn(c,'Please change this task');assert.equal((await s.finish(c,turn.json().turn.id)).status,'succeeded');assert.equal(rounds,4);assert.equal(seen.length,1);
 assert.equal(s.db.prepare('SELECT count(*) n FROM task_operations WHERE task_id=?').get(taskId).n,1);
 assert.equal(s.db.prepare('SELECT input_revision FROM tasks WHERE id=?').get(taskId).input_revision,initialRevision+(name==='task_supplement'?1:0));
 assert.equal(s.db.prepare("SELECT count(*) n FROM builtin_operations WHERE status='completed' AND json_extract(result_json,'$.error.code')='version_conflict'").get().n,1);
});
test('a valid mutation does not require an extra task_query',async t=>{
 let rounds=0,taskId,version;const s=await setup(t,{modelClient:{async complete(){return ++rounds===1?mutationCall('task_supplement',taskId,version):response({text:'Requirements recorded.'});}}});const c=await s.conv('real'),created=await s.call('POST',s.base+'/tasks',{operationId:'create',conversationId:c.id,input:'Synthetic'},s.cookie);({id:taskId,version}=created.json().task);
 const turn=await s.turn(c);assert.equal((await s.finish(c,turn.json().turn.id)).status,'succeeded');assert.equal(rounds,2);assert.equal(s.db.prepare('SELECT count(*) n FROM task_operations').get().n,1);
});
test('a rejected mutation is durably replayed without a later write even if its version becomes valid',async t=>{
 let rounds=0,taskId,first;const s=await setup(t,{modelClient:{async complete({messages}){
   rounds++;if(rounds===1)return mutationCall('task_cancel',taskId,1);
   if(rounds===2){first=lastToolResult(messages);assertVersionRejection(first,taskId,'task_cancel');s.db.prepare('UPDATE tasks SET version=1 WHERE id=?').run(taskId);return mutationCall('task_cancel',taskId,1,'regenerated-call-id');}
   assert.deepEqual(lastToolResult(messages),first);return response({text:'No change made.'});
 }}});const c=await s.conv('real');taskId=(await s.call('POST',s.base+'/tasks',{operationId:'create',conversationId:c.id,input:'Synthetic'},s.cookie)).json().task.id;await s.service.tick();
 const turn=await s.turn(c);assert.equal((await s.finish(c,turn.json().turn.id)).status,'succeeded');assert.equal(s.db.prepare('SELECT count(*) n FROM task_operations').get().n,0);
 const before=s.db.prepare('SELECT * FROM builtin_operations').all();assert.equal(before.length,1);assert.equal(before[0].status,'completed');assert.deepEqual(JSON.parse(before[0].result_json),first);
 await s.restart();assert.deepEqual(s.db.prepare('SELECT * FROM builtin_operations').all(),before);const replay=await s.turn(c);assert.equal(replay.json().turn.id,turn.json().turn.id);assert.equal(rounds,3);assert.equal(s.db.prepare('SELECT count(*) n FROM task_operations').get().n,0);
});
test('after a version rejection the model may query a terminal task and stop without a new mutation',async t=>{
 let rounds=0,taskId;const s=await setup(t,{modelClient:{async complete({messages}){
   if(++rounds===1)return mutationCall('task_cancel',taskId,1);
   if(rounds===2){assertVersionRejection(lastToolResult(messages),taskId,'task_cancel');s.db.prepare("UPDATE tasks SET status='succeeded',version=version+1 WHERE id=?").run(taskId);return response({toolCalls:[{id:'query',name:'task_query',arguments:{taskId}}]});}
   assert.equal(lastToolResult(messages).availableActions.cancel.available,false);return response({text:'The task has ended; no cancellation was submitted.'});
 }}});const c=await s.conv('real');taskId=(await s.call('POST',s.base+'/tasks',{operationId:'create',conversationId:c.id,input:'Synthetic'},s.cookie)).json().task.id;await s.service.tick();const turn=await s.turn(c);assert.equal((await s.finish(c,turn.json().turn.id)).status,'succeeded');assert.equal(s.db.prepare('SELECT count(*) n FROM task_operations').get().n,0);
});
for(const scenario of ['unproven-version-code','mismatched-proof','permission','unknown-after-write'])test(`mutation errors stay fatal without authoritative pre-write proof: ${scenario}`,async t=>{
 let rounds=0,taskId,version;const s=await setup(t,{modelClient:{async complete(){rounds++;return mutationCall('task_supplement',taskId,version);}}});const c=await s.conv('real');({id:taskId,version}=(await s.call('POST',s.base+'/tasks',{operationId:'create',conversationId:c.id,input:'Synthetic'},s.cookie)).json().task);
 if(scenario==='permission'){const other=s.historical('OTHER_SYNTHETIC','OTHER_REPLY','real');taskId=(await s.call('POST',s.base+'/tasks',{operationId:'foreign',conversationId:other.id,input:'Private other conversation'},s.cookie)).json().task.id;}
 else{const mutate=s.service.mutate.bind(s.service);s.service.mutate=async(...args)=>{if(scenario==='unknown-after-write'){await mutate(...args);throw Error('Synthetic lost response after write');}if(scenario==='mismatched-proof')throw new TaskMutationVersionConflict('other-task','other-operation','cancel');throw new TaskError(409,'version_conflict');};}
 const turn=await s.turn(c);assert.equal((await s.finish(c,turn.json().turn.id)).status,'failed');assert.equal(rounds,1);
 assert.equal(s.db.prepare("SELECT count(*) n FROM builtin_operations WHERE status='completed'").get().n,0);
 assert.equal(s.db.prepare('SELECT count(*) n FROM task_operations').get().n,scenario==='unknown-after-write'?1:0);
});


test('Web/API preserves sanitized failed terminal error through event replay, legacy journals and restart',async t=>{
 let models=0;const secret='SYNTHETIC_PRIVATE_BACKEND_DETAIL_DO_NOT_RETURN';
 const s=await setup(t,{modelClient:{async complete(){models++;throw Error(secret);}}}),c=await s.conv('real'),start=await s.turn(c,'Synthetic failure');const id=start.json().turn.id;
 const failed=await s.finish(c,id);assert.equal(failed.status,'failed');assert.equal(failed.error,'Builtin runtime operation failed');assert.equal(JSON.stringify(failed).includes(secret),false);
 const key=s.db.prepare("SELECT key,json FROM builtin_records WHERE key LIKE 'builtin:execution:%' AND key LIKE ?").get('%:'+id),meta=JSON.parse(key.json),store=new Store(s.databasePath);
 try{
  const journal=new JsonlJournal({root:join(s.dir,'builtin-records'),ownerId:JSON.stringify([store.databaseId,store.databasePath]),serialize:fn=>store.transaction(fn),index:createJournalIndex(store)}),scope={workspaceId:s.user.workspace.id,entityId:s.entity.id,conversationId:c.id};
  const events=journal.readMany(scope,meta.deliveryRefs),terminal=events.find(e=>e.type==='terminal');assert.equal(terminal.status,'failed');assert.deepEqual(Object.keys(terminal.error).sort(),['code','safeMessage']);assert.equal(terminal.error.safeMessage,failed.error);
  const legacy=events.map(e=>{const {error,...rest}=e;return e.type==='terminal'?rest:e;});meta.deliveryRefs=legacy.map(e=>journal.put(scope,'interaction_event',e));
  store.run('UPDATE builtin_records SET json=?,version=version+1 WHERE key=?',JSON.stringify(meta),key.key);store.run("UPDATE interaction_turns SET status='running',error=NULL WHERE id=?",id);
 }finally{store.close();}
 const legacy=await s.finish(c,id);assert.equal(legacy.status,'failed');assert.equal(legacy.error,failed.error,'Old terminal without error uses the same execution status safely');
 for(let n=0;n<2;n++)assert.equal((await s.finish(c,id)).error,failed.error);
 const other=s.historical('Other synthetic input','Other reply','real'),denied=await s.call('GET',`${s.base}/conversations/${other.id}/turns/${id}`,undefined,s.cookie);assert.equal(denied.statusCode,404);assert.equal(denied.body.includes(failed.error),false);
 await s.restart();const restarted=await s.finish(c,id);assert.equal(restarted.status,'failed');assert.equal(restarted.error,failed.error);assert.equal(models,1);assert.equal(s.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
});
test('Web/API cancellation retains safe terminal detail without canceling background work or replay after restart',async t=>{
 let entered,models=0;const started=new Promise(r=>entered=r),secret='SYNTHETIC_CANCEL_PRIVATE_DETAIL';
 const s=await setup(t,{modelClient:{async complete({signal}){models++;entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error(secret)),{once:true}));}}}),c=await s.conv('real'),start=await s.turn(c,'Synthetic cancellable generation');await started;
 const id=start.json().turn.id,stop=await s.call('POST',`${s.base}/conversations/${c.id}/turns/${id}/interrupt`,{},s.cookie);assert.equal(stop.json().status,'requested');const turn=await s.finish(c,id);assert.equal(turn.status,'canceled');assert.equal(typeof turn.error,'string');assert.ok(turn.error.length);assert.equal(turn.error.includes(secret),false);
 await s.restart();const again=await s.finish(c,id);assert.equal(again.status,'canceled');assert.equal(again.error,turn.error);assert.equal(models,1);assert.equal(s.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
});

// Deterministic tool/input contract coverage, not proof that a live model always
// extracts every natural-language restriction from a conversation.
test('task boundaries are explicit in model instructions and survive creation to execution without history inheritance',async t=>{
 const input='目标：给出三条检查建议。\n用户边界：不创建事项；不读取历史；只读，不修改文件、不发送消息。\n输出：只列建议，不承诺已执行。';
 let mode='history',receipt;const toolCalls=[];
 const s=await setup(t,{modelClient:{async complete({messages,tools}){
  const system=messages.find(m=>m.role==='system').content;
  for(const part of ['逐项保留用户明确的禁止项','不创建事项、不读取历史','不能被假定知道当前对话中未传递的限制','不复制整段会话','不为补齐背景读取用户禁止的历史','工具可用不等于用户允许使用','不能因用户补充目标或要求启动就推定撤销'])assert.ok(system.includes(part),part);
  for(const name of ['task_create','task_create_todo','task_supplement']){
   const schema=tools.find(tool=>tool.name===name).parameters,description=schema.properties.input.description;
   assert.equal(schema.additionalProperties,false);assert.ok(schema.required.includes('input'));
   assert.match(description,/every explicit user prohibition/);assert.match(description,/no work item creation or no history reads/);
   assert.match(description,/necessary authorized context/);assert.match(description,/never whole conversations/);
   assert.equal(schema.properties.contextMode,undefined);assert.equal(schema.properties.historyMessageIds,undefined);
  }
  assert.match(tools.find(tool=>tool.name==='task_create_todo').description,/explicit prohibitions; these are not scheduling instructions/);
  assert.match(tools.find(tool=>tool.name==='task_supplement').parameters.properties.input.description,/Earlier restrictions remain in force/);
  if(mode==='history')return response({text:'已记录当前聊天内容。'});
  assert.equal(JSON.stringify(messages).includes('FOREIGN_CONVERSATION_PRIVATE'),false);
  if(messages.at(-1).role==='tool'){receipt=JSON.parse(messages.at(-1).content);return response({text:'已受理，尚未完成。'});}
  toolCalls.push('task_create');return response({toolCalls:[{id:'preserve-boundaries',name:'task_create',arguments:{title:'只读检查建议',input}}]});
 }}});
 s.historical('FOREIGN_CONVERSATION_PRIVATE','Private reply','real');
 const c=await s.conv('real'),earlier=await s.turn(c,'UNRELATED_SAME_CONVERSATION_PRIVATE','old-context');assert.equal((await s.finish(c,earlier.json().turn.id)).status,'succeeded');
 mode='create';const created=await s.turn(c,input,'preserve-boundaries');assert.equal((await s.finish(c,created.json().turn.id)).status,'succeeded');
 const task=s.db.prepare('SELECT * FROM tasks').get();assert.equal(task.input,input);assert.equal(task.context_mode,'new');assert.deepEqual(JSON.parse(task.snapshot_json),[]);
 assert.equal(s.db.prepare('SELECT text FROM task_inputs WHERE task_id=? AND revision=1').get(task.id).text,input);
 assert.equal(receipt.status,'queued');assert.equal(receipt.result,null);assert.equal(s.calls.length,0);assert.deepEqual(toolCalls,['task_create']);
 await s.service.tick();assert.equal(s.calls.length,1);assert.equal(s.calls[0].input,input);assert.equal(s.calls[0].context.mode,'new');assert.deepEqual(s.calls[0].context.messages,[]);
 assert.doesNotMatch(JSON.stringify(s.calls[0]),/UNRELATED_SAME_CONVERSATION_PRIVATE|FOREIGN_CONVERSATION_PRIVATE/);
 assert.equal(s.db.prepare('SELECT count(*) n FROM work_items').get().n,0);
 const messages=(await s.call('GET',`${s.base}/conversations/${c.id}/messages`,undefined,s.cookie)).json().messages;
 assert.ok(messages.some(m=>m.text.includes('这不是完成通知')));assert.equal(s.db.prepare('SELECT result FROM runs WHERE id=?').get(task.run_id).result,null);
});

test('task boundaries survive planned supplement and explicit start without turning business prohibitions into scheduling hints',async t=>{
 const original='列出三条建议；不创建事项，不读取历史，不修改文件。任何后续写入仍需用户单独批准。',addition='输出仅限中文；不发送消息、不安装工具。';
 let mode='save',taskId,receipt,serial=0;const calls=[];
 const s=await setup(t,{modelClient:{async complete({messages}){
  const call=(name,args)=>{calls.push(name);return response({toolCalls:[{id:`planned-boundary-${++serial}`,name,arguments:args}]});};
  if(messages.at(-1).role!=='tool')return mode==='save'?call('task_create_todo',{input:original}):call('task_query',{taskId});
  const previous=[...messages].reverse().find(m=>m.role==='assistant'&&m.toolCalls?.length).toolCalls.at(-1),value=JSON.parse(messages.at(-1).content);
  if(previous.name==='task_query')return call(mode==='supplement'?'task_supplement':'task_start',{taskId,expectedVersion:value.version,...(mode==='supplement'?{input:addition}:{})});
  receipt=value;taskId=value.id;return response({text:mode==='save'?'待办已保存，尚未启动。':mode==='supplement'?'补充已记录，启动时使用。':'已受理启动，尚未完成。'});
 }}});
 const c=await s.conv('real'),invoke=async(text,id)=>{const r=await s.turn(c,text,id);assert.equal((await s.finish(c,r.json().turn.id)).status,'succeeded');};
 await invoke(`先记下来，暂不启动。未来的工作：${original}`,'save-boundaries');
 assert.equal(receipt.status,'planned');assert.equal(s.db.prepare('SELECT count(*) n FROM runs').get().n,0);assert.equal(s.db.prepare('SELECT input FROM tasks').get().input,original);
 assert.doesNotMatch(s.db.prepare('SELECT input FROM tasks').get().input,/暂不启动|等用户启动/);
 mode='supplement';await invoke(addition,'add-boundaries');assert.equal(receipt.actionReceipt.status,'recorded');assert.equal(receipt.actionReceipt.effectStatus,'not_started');assert.equal(receipt.availableActions.supplement.effect,'on_start');
 const combined=`${original}\n\n补充要求：\n${addition}`;assert.equal(s.db.prepare('SELECT input FROM tasks').get().input,combined);assert.equal(s.db.prepare('SELECT count(*) n FROM runs').get().n,0);
 await invoke(addition,'add-boundaries');assert.equal(s.db.prepare("SELECT count(*) n FROM task_operations WHERE kind='input'").get().n,1);
 await s.restart();mode='start';await invoke('现在启动这个待办，原有边界保持不变。','start-boundaries');
 assert.equal(receipt.status,'queued');assert.equal(receipt.result,null);assert.equal(s.calls.length,0);
 const task=s.db.prepare('SELECT * FROM tasks').get();assert.equal(task.input,combined);assert.equal(task.context_mode,'new');assert.deepEqual(JSON.parse(task.snapshot_json),[]);
 assert.equal(s.db.prepare('SELECT text FROM task_inputs WHERE task_id=? AND revision=?').get(task.id,task.input_revision).text,combined);
 await s.service.tick();assert.equal(s.calls.length,1);assert.equal(s.calls[0].input,combined);assert.deepEqual(s.calls[0].context.messages,[]);
 assert.deepEqual(calls,['task_create_todo','task_query','task_supplement','task_query','task_start']);
 assert.equal(s.db.prepare('SELECT count(*) n FROM work_items').get().n,0);
});

for(const scenario of ['history arguments','oversized input'])test(`task boundary input rejects ${scenario} instead of inheriting history or silently truncating restrictions`,async t=>{
 const args=scenario==='history arguments'?{input:'只读，不创建事项，不读取历史。',contextMode:'fork',historyMessageIds:['private-message']}:{input:'任务说明'.repeat(2700)+'；不创建事项、不读取历史。'};
 const s=await setup(t,{modelClient:{async complete(){return response({toolCalls:[{id:'invalid-boundaries',name:'task_create',arguments:args}]});}}});
 const c=await s.conv('real'),r=await s.turn(c,'只读，不创建事项，不读取历史。','invalid-boundaries');assert.equal((await s.finish(c,r.json().turn.id)).status,'failed');
 for(const table of ['tasks','runs','task_inputs','task_outbox','work_items'])assert.equal(s.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0,table);
 assert.equal(s.calls.length,0);const messages=(await s.call('GET',`${s.base}/conversations/${c.id}/messages`,undefined,s.cookie)).json().messages;
 assert.equal(messages.some(m=>m.text.includes('已受理')||m.text.includes('已完成')),false);
});
