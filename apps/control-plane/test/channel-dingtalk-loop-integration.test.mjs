import {normalizeChannelIngressEvent} from '../dist/adapters/channels/ingress/normalize.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {Store} from '../dist/store.js';
import {SqliteConversationRepository} from '../dist/adapters/sqlite/conversation-repository.js';
import {SqliteTaskRepository} from '../dist/adapters/sqlite/task-repository.js';
import {SqliteMessageLoopRepository} from '../dist/channel-loop/repository.js';
import {createBuiltinInteractionProvider} from '../dist/adapters/builtin-interaction-provider.js';
import {DingTalkBotConversationAdapter} from '../dist/adapters/channels/dingtalk.js';
import {ChannelMessageLoop,TaskService,createInteractionService} from '@dentity/application';
import {JsonlJournal} from '@dentity/runtime-builtin';

// Only the provider HTTP endpoint and model output are local fixtures. The callback
// authentication, real DingTalk adapter, message loop, runtime and SQLite are exercised.
async function fixture(t,options={}){
 let now=1800000000000;const requests=[],queries=[],models=[];
 const http=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const request={method:req.method,url:req.url,headers:req.headers,body:raw?JSON.parse(raw):undefined};
  res.setHeader('content-type','application/json');
  if(req.url.startsWith('/v1.0/robot/oToMessages/readStatus?')||req.url==='/v1.0/robot/groupMessages/query'){
   queries.push(request);res.end(JSON.stringify(await options.query?.(request,queries.length)??{sendStatus:'SUCCESS'}));
  }else{requests.push(request);res.end(JSON.stringify({processQueryKey:`accepted-${requests.length}`}));}
 });
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 const local=`http://127.0.0.1:${http.address().port}`;
 const dir=mkdtempSync(join(tmpdir(),'identity-ding-loop-')),store=new Store(join(dir,'app.sqlite'));
 store.run("INSERT INTO users VALUES('manager','manager','Manager','active')");store.run("INSERT INTO workspaces VALUES('w','WS','manager','active')");store.run("INSERT INTO members VALUES('manager-member','w','manager','owner','active')");store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Helper','manager-member','manager-member',1,'manager','builtin-interaction')");
 const journal=new JsonlJournal({root:join(dir,'records'),ownerId:'fixture',serialize:fn=>store.transaction(fn)}),conversations=new SqliteConversationRepository(store,journal,()=>now);conversations.initialize(0);
 const auth={authorizeEntity(){},async refreshAuthorization(){}};
 const taskRuntime={idempotentDispatch:true,async dispatch(){throw new Error('no task expected');},async input(){throw new Error('no task expected');},async cancel(){throw new Error('no task expected');},async events(){return[];}};
 const tasks=new TaskService(new SqliteTaskRepository(store),()=>now,taskRuntime,auth,undefined,conversations);
 const provider=createBuiltinInteractionProvider(store,conversations,tasks,()=>now,{getRuntimeDefinition(){return{name:'Helper',description:'Local fixture',interactionRuntime:'builtin-interaction'};}},{journal,readAdmittedInput:id=>store.one('SELECT input_text FROM channel_inbox WHERE id=?',id)?.input_text??(()=>{throw Error('missing admitted fixture input');})(),modelClient:{async complete(input){models.push(input);return{text:'fixture reply',usage:{inputTokens:3,outputTokens:3}};}}});
 const interaction=createInteractionService(conversations,tasks,provider,()=>now);
 const connection={workspaceId:'w',connectionId:'ding-connection',provider:'dingtalk',tenantId:'corp',identity:{kind:'bot',externalId:'distinct-robot-code'},credentialRef:'fixture-only'};
 const adapter=new DingTalkBotConversationAdapter(connection,{appId:'app-key',robotCode:'distinct-robot-code',trustedHttpsBoundary:true,mentionEventsGranted:true,privateMessageEventsGranted:true,proactiveSendGranted:true,timeoutMs:options.timeoutMs??15000,now:()=>now,resolveCredential:async(_c,p)=>p==='webhook_app_secret'?'fixture-secret':'fixture-token',fetch:async(url,init)=>{const actual=new URL(url);assert.equal(actual.origin,'https://api.dingtalk.com');return fetch(local+actual.pathname+actual.search,init);}});
 const binding={connectionId:connection.connectionId,workspaceId:'w',entityId:'e',provider:'dingtalk',appId:'app-key',bindingVersion:'1',enabled:true,identity:{tenantId:'corp',tenantIdNamespace:'corp_id'},connection,policy:{entityMentionId:'distinct-robot-code',ownSenderIds:[]},conversation:adapter,webhook:adapter};
 const connections={async resolveBinding(){return binding;},currentBindingVersion(){return binding.bindingVersion;},async authorizeInvocation(_binding,actor){if(options.denyInvocation)throw Error('fixture usage denied');assert.equal(actor.applicationId,'app-key');assert.equal(actor.idNamespace,'user_id');assert.equal(actor.identityEvidence,'channel_verified');}};
 let repo=new SqliteMessageLoopRepository(store,()=>now),loop=new ChannelMessageLoop(repo,connections,interaction,tasks,()=>now);
 const receive=(id,type='1',at=false,patch={})=>{const body={msgId:id,chatbotCorpId:'corp',chatbotUserId:'bot-id',robotCode:'distinct-robot-code',conversationType:type,isInAtList:at,senderCorpId:'corp',senderStaffId:'staff-alice',senderId:'opaque-alice',conversationId:type==='1'?'private-conversation':'group-conversation',createAt:now,msgtype:'text',text:{content:'hello '+id},sessionWebhook:'https://attacker.invalid/not-used',...patch};const normalized=normalizeChannelIngressEvent({connectionId:connection.connectionId,provider:'dingtalk',appId:'app-key',revision:1,authRevision:1,generation:'test'},{type:'CALLBACK',headers:{topic:'/v1.0/im/bot/messages/get',messageId:id},data:JSON.stringify(body)},{botId:'distinct-robot-code',tenantId:'corp',tenantNamespace:'corp_id',robotCode:'distinct-robot-code'},now);return normalized.kind==='ignored'?Promise.resolve({kind:'ignored'}):loop.acceptAuthenticatedEvent(connection.connectionId,normalized.event);};
 const drain=async()=>{
  let idle=0;
  for(let n=0;n<1000;n++){
   await loop.tick();await loop.waitForWork();await new Promise(resolve=>setTimeout(resolve,5));
   const active=store.one("SELECT (SELECT count(*) FROM channel_inbox WHERE rt_terminal=0 AND status IN ('queued','submitting','accepted','committed'))+(SELECT count(*) FROM channel_deliveries WHERE status IN ('pending','queued','sending') OR receipt_query_state='querying') n").n;
   if(!active){if(++idle>=3)return;}else idle=0;
  }
  assert.fail('isolated DingTalk loop did not become idle');
 };
 t.after(async()=>{await loop.stop();await provider.shutdown();store.close();await new Promise(resolve=>http.close(resolve));rmSync(dir,{recursive:true,force:true});});
 return{receive,drain,store,requests,queries,models,binding,get loop(){return loop;},get repo(){return repo;},now:()=>now,advance:ms=>now+=ms,restart:async()=>{await loop.stop();repo=new SqliteMessageLoopRepository(store,()=>now);loop=new ChannelMessageLoop(repo,connections,interaction,tasks,()=>now);}};
}

test('Stream-normalized DingTalk private and group mentions run the loop and preserve accepted request IDs',async t=>{
 const f=await fixture(t);
 assert.equal((await f.receive('ordinary','2',false)).kind,'ignored');await f.drain();assert.equal(f.models.length,0);assert.equal(f.requests.length,0);
 assert.equal((await f.receive('private')).status,'created');await f.drain();
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'/v1.0/robot/oToMessages/batchSend');
 assert.deepEqual(f.requests[0].body,{robotCode:'distinct-robot-code',userIds:['staff-alice'],msgKey:'sampleText',msgParam:'{"content":"fixture reply"}'});
 assert.equal(f.requests[0].headers['x-acs-dingtalk-access-token'],'fixture-token');
 assert.equal((await f.receive('private')).status,'duplicate');await f.drain();assert.equal(f.requests.length,1);
 assert.equal((await f.receive('group','2',true)).status,'created');await f.drain();
 assert.equal(f.requests.length,2);assert.equal(f.requests[1].url,'/v1.0/robot/groupMessages/send');
 assert.deepEqual(f.requests[1].body,{robotCode:'distinct-robot-code',openConversationId:'group-conversation',msgKey:'sampleText',msgParam:'{"content":"fixture reply"}'});
 assert.equal(f.models.length,2);
 assert.deepEqual(f.store.all('SELECT status,message_id,provider_request_id FROM channel_deliveries ORDER BY rowid').map(r=>({...r})),[{status:'unknown',message_id:null,provider_request_id:'accepted-1'},{status:'unknown',message_id:null,provider_request_id:'accepted-2'}]);
 assert.equal(f.store.one('SELECT count(*) n FROM users').n,1);
 f.advance(30001);await f.drain();assert.equal(f.requests.length,2,'accepted-but-unconfirmed sends are never replayed after their lane unblocks');
});

test('six DingTalk callback account variants execute and share context only within their original conversations',async t=>{
 const f=await fixture(t);
 for(const kind of ['private','group-one','group-two'])for(const person of ['alice','bob']){
  const group=kind!=='private',id=kind+'-'+person;
  const patch={chatbotUserId:kind+'-account',conversationId:group?kind:'private-'+person,senderStaffId:'staff-'+person,senderId:'opaque-'+person};
  assert.equal((await f.receive(id,group?'2':'1',group,patch)).status,'created');await f.drain();
  assert.equal((await f.receive(id,group?'2':'1',group,patch)).status,'duplicate');
  f.advance(30001);await f.drain();
 }
 assert.equal(f.models.length,6);assert.equal(f.requests.length,6);
 const rows=f.store.all('SELECT event_json,conversation_id FROM channel_inbox');const byExternal=new Map();
 for(const row of rows){const event=JSON.parse(row.event_json),external=event.message.conversation.externalId;const known=byExternal.get(external);if(known)assert.equal(row.conversation_id,known);else byExternal.set(external,row.conversation_id);}
 assert.equal(byExternal.size,4);assert.equal(new Set(byExternal.values()).size,4);
 assert.deepEqual(f.requests.map(r=>[r.url,r.body.userIds?.[0]??r.body.openConversationId]),[
  ['/v1.0/robot/oToMessages/batchSend','staff-alice'],['/v1.0/robot/oToMessages/batchSend','staff-bob'],
  ['/v1.0/robot/groupMessages/send','group-one'],['/v1.0/robot/groupMessages/send','group-one'],
  ['/v1.0/robot/groupMessages/send','group-two'],['/v1.0/robot/groupMessages/send','group-two'],
 ]);
});


test('DingTalk accepted private/group sends are queried from durable keys and confirmed without inventing message IDs or reading',async t=>{
 const f=await fixture(t,{query(request){
  const key=request.body?.processQueryKey??new URL(request.url,'http://fixture').searchParams.get('processQueryKey');
  const durable=f.store.one('SELECT status,receipt_query_attempts FROM channel_deliveries WHERE provider_request_id=?',key);
  assert.equal(durable.status,'unknown');assert.equal(durable.receipt_query_attempts,1);
  return{sendStatus:'SUCCESS',messageReadInfoList:[{userId:'staff-alice',readStatus:'UNREAD'}],readUserIds:[]};
 }});
 await f.receive('private-query');await f.drain();await f.receive('group-query','2',true);await f.drain();
 assert.equal(f.queries.length,0);assert.equal(f.requests.length,2);
 f.advance(2000);await f.drain();assert.equal(f.queries.length,2);
 assert.deepEqual(f.store.all('SELECT status,message_id,provider_request_id,attempts,receipt_query_attempts,receipt_query_state FROM channel_deliveries ORDER BY rowid').map(r=>({...r})),[
  {status:'sent',message_id:null,provider_request_id:'accepted-1',attempts:1,receipt_query_attempts:1,receipt_query_state:'done'},
  {status:'sent',message_id:null,provider_request_id:'accepted-2',attempts:1,receipt_query_attempts:1,receipt_query_state:'done'},
 ]);
 assert.deepEqual(f.store.all("SELECT status,provider_request_id FROM channel_message_receipts WHERE kind='outbox' ORDER BY rowid").map(r=>({...r})),[{status:'sent',provider_request_id:'accepted-1'},{status:'sent',provider_request_id:'accepted-2'}]);
 assert.equal(f.models.length,2);f.advance(600000);await f.drain();assert.equal(f.requests.length,2);assert.equal(f.queries.length,2);
});

test('DingTalk query retries PROCESSING across restart with the original send and finite persisted delays',async t=>{
 const f=await fixture(t,{query(_request,n){return{sendStatus:n<3?'PROCESSING':'SUCCESS'};}});
 await f.receive('retry-query');await f.drain();f.advance(2000);await f.drain();assert.equal(f.queries.length,1);
 assert.equal(f.store.one('SELECT status FROM channel_deliveries').status,'unknown');await f.restart();
 f.advance(4999);await f.drain();assert.equal(f.queries.length,1);f.advance(1);await f.drain();assert.equal(f.queries.length,2);
 f.advance(10000);await f.drain();assert.equal(f.queries.length,3);assert.equal(f.store.one('SELECT status FROM channel_deliveries').status,'sent');
 assert.equal(f.requests.length,1);assert.equal(f.models.length,1);assert.equal(f.store.one('SELECT receipt_query_attempts FROM channel_deliveries').receipt_query_attempts,3);
});

test('DingTalk unrecognized query results exhaust five queries and never resend even after restart',async t=>{
 const f=await fixture(t,{query(){return{sendStatus:'UNRECOGNIZED',messageReadInfoList:[{readStatus:'READ'}]};}});
 await f.receive('unknown-query');await f.drain();
 for(const delay of [2000,5000,10000,20000,30000]){f.advance(delay);await f.drain();}
 assert.equal(f.queries.length,5);assert.equal(f.requests.length,1);
 assert.deepEqual({...f.store.one('SELECT status,error,receipt_query_attempts,receipt_query_state FROM channel_deliveries')},{status:'unknown',error:'receipt_query_exhausted',receipt_query_attempts:5,receipt_query_state:'done'});
 await f.restart();f.advance(600000);await f.drain();assert.equal(f.queries.length,5);assert.equal(f.requests.length,1);assert.equal(f.models.length,1);
});

test('DingTalk recalled result is terminal failed and does not trigger another send',async t=>{
 const f=await fixture(t,{query(){return{sendStatus:'RECALLED'};}});
 await f.receive('recalled-query','2',true);await f.drain();f.advance(2000);await f.drain();
 assert.deepEqual({...f.store.one('SELECT status,error FROM channel_deliveries')},{status:'failed',error:'provider_message_recalled'});
 f.advance(600000);await f.drain();assert.equal(f.requests.length,1);assert.equal(f.queries.length,1);
});

test('DingTalk binding changes stop accepted-result queries and preserve unknown instead of switching identities',async t=>{
 const f=await fixture(t);await f.receive('binding-query');await f.drain();f.binding.bindingVersion='replacement';
 f.advance(2000);await f.drain();assert.equal(f.queries.length,0);assert.equal(f.requests.length,1);
 assert.deepEqual({...f.store.one('SELECT status,error,receipt_query_state FROM channel_deliveries')},{status:'unknown',error:'receipt_query_unavailable',receipt_query_state:'done'});
});

test('DingTalk stale successful query cannot confirm a changed binding',async t=>{
 const f=await fixture(t,{query(){f.binding.bindingVersion='changed-during-query';return{sendStatus:'SUCCESS'};}});
 await f.receive('stale-query');await f.drain();f.advance(2000);await f.drain();
 assert.equal(f.queries.length,1);assert.equal(f.store.one('SELECT status FROM channel_deliveries').status,'unknown');assert.equal(f.requests.length,1);
});

test('DingTalk fixed permission replies share the same durable query lifecycle without executing a model',async t=>{
 const f=await fixture(t,{denyInvocation:true});await f.receive('denied-query','2',true);await f.drain();
 assert.equal(f.models.length,0);assert.equal(f.requests.length,1);f.advance(2000);await f.drain();
 assert.equal(f.queries.length,1);assert.equal(f.store.one('SELECT status FROM channel_deliveries').status,'sent');assert.equal(f.models.length,0);
});


// Timer controls exercise the existing loop and SQLite fixture, not another provider mock.
for(const failStorage of [false,true])test(`late DingTalk acceptance after confirmation timeout cannot resend or produce an unhandled rejection (storageFailure=${failStorage})`,async t=>{
 const f=await fixture(t);await f.receive('late-accept-source');await f.drain();f.advance(2000);await f.drain();
 const original=f.store.one('SELECT scope_json scopeJson,target_json targetJson FROM channel_deliveries');
 f.repo.enqueueDelivery({id:'late-accept',...original,text:'synthetic late receipt',status:'queued',taskDeliveryId:null,leaseToken:null},f.now());
 const token='late-send-token',row=f.repo.claimDelivery(f.now(),f.now()+60000,token);assert.equal(row.id,'late-accept');
 let resolve;const pending=new Promise(done=>{resolve=done;});
 t.mock.timers.enable({apis:['setTimeout']});const confirmation=f.loop.confirmedSend(row,token,()=>pending,true);
 f.advance(30000);t.mock.timers.tick(30000);assert.equal(await confirmation,undefined);
 if(failStorage){await f.loop.stop();t.mock.method(f.repo,'finishDelivery',()=>{throw Error('synthetic closed store');});}
 resolve({status:'accepted',providerRequestId:'late-key',idempotent:false});
 await new Promise(done=>setImmediate(done));await new Promise(done=>setImmediate(done));t.mock.timers.reset();
 const saved=f.store.one("SELECT status,provider_request_id,receipt_query_state,attempts FROM channel_deliveries WHERE id='late-accept'");
 assert.equal(saved.status,'unknown');assert.equal(saved.attempts,1);assert.equal(saved.provider_request_id,failStorage?null:'late-key');assert.equal(saved.receipt_query_state,failStorage?null:'pending');
 assert.equal(f.requests.length,1,'late confirmation only updates the original durable row');
 if(!failStorage){f.advance(2000);await f.drain();assert.equal(f.store.one("SELECT status FROM channel_deliveries WHERE id='late-accept'").status,'sent');assert.equal(f.requests.length,1);}
});

test('DingTalk query timeout is bounded and a late SUCCESS cannot overwrite its replacement query state',async t=>{
 let release;const response=new Promise(done=>{release=done;});
 const f=await fixture(t,{timeoutMs:60000,query(){return response;}});
 await f.receive('timeout-query');await f.drain();f.advance(2000);
 // Claim before the automatic wake and drive the same production query method directly.
 const row=f.repo.claimDeliveryQuery(f.now(),'timeout-token');assert.ok(row);
 const realTimeout=globalThis.setTimeout;
 t.mock.timers.enable({apis:['setTimeout']});const query=f.loop.queryDelivery(row,'timeout-token');
 try{
  for(let n=0;n<1000&&f.queries.length===0;n++)await new Promise(done=>realTimeout(done,5));
  assert.equal(f.queries.length,1);f.advance(25000);t.mock.timers.tick(25000);await query;
  const before={...f.store.one('SELECT status,receipt_query_state,receipt_query_attempts,receipt_query_token FROM channel_deliveries')};
  assert.deepEqual(before,{status:'unknown',receipt_query_state:'pending',receipt_query_attempts:1,receipt_query_token:null});
  release({sendStatus:'SUCCESS'});await new Promise(done=>realTimeout(done,100));
  assert.deepEqual({...f.store.one('SELECT status,receipt_query_state,receipt_query_attempts,receipt_query_token FROM channel_deliveries')},before);
  assert.equal(f.requests.length,1);assert.equal(f.queries.length,1);
 }finally{release({sendStatus:'SUCCESS'});t.mock.timers.tick(25000);await query;t.mock.timers.reset();}
});

test('DingTalk task-result query confirms the same task delivery without re-executing the task',async t=>{
 const f=await fixture(t);await f.receive('task-result-origin');await f.drain();f.advance(2000);await f.drain();
 const origin=f.store.one('SELECT conversation_id,scope_json FROM channel_inbox');
 f.store.run("INSERT INTO tasks(id,workspace_id,entity_id,user_id,conversation_id,operation_id,request_hash,input,context_mode,snapshot_id,snapshot_json,source_json,status,run_id,created_at,updated_at) VALUES('synthetic-task','w','e',NULL,?,'synthetic-operation','fixture-hash','fixture task','none','fixture-snapshot','{}',?,'succeeded','synthetic-run',?,?)",origin.conversation_id,origin.scope_json,f.now(),f.now());
 f.store.run("INSERT INTO deliveries(id,task_id,conversation_id,event_id,text,status,created_at) VALUES('synthetic-task-delivery','synthetic-task',?,'synthetic-event','synthetic task result','stored',?)",origin.conversation_id,f.now());
 await f.drain();assert.equal(f.store.one("SELECT status FROM deliveries WHERE id='synthetic-task-delivery'").status,'channel_unknown');
 f.advance(2000);await f.drain();assert.equal(f.store.one("SELECT status FROM deliveries WHERE id='synthetic-task-delivery'").status,'channel_sent');
 assert.equal(f.store.one("SELECT status FROM channel_message_receipts WHERE id='task-delivery:synthetic-task-delivery' AND kind='outbox'").status,'sent');
 assert.equal(f.store.one("SELECT status FROM tasks WHERE id='synthetic-task'").status,'succeeded');assert.equal(f.models.length,1);assert.equal(f.requests.length,2);
});
