import {JsonlJournal} from '@dentity/runtime-builtin';
import {SqliteConversationRepository} from '../dist/adapters/sqlite/conversation-repository.js';
import {SqliteTaskCompletionNotifications} from '../dist/adapters/sqlite/task-completion-notifications.js';
import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {Store} from '../dist/store.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {EmployeeChannelService} from '../dist/employee-channels/service.js';
import {CapabilityConfigService} from '../dist/capability-config.js';
import {SqliteMessageLoopRepository} from '../dist/channel-loop/repository.js';
import {ChannelIngressSupervisor} from '../dist/channel-loop/ingress-supervisor.js';
import {SdkIngress} from '../dist/adapters/channels/ingress/sdk-ingress.js';
import {ChannelMessageLoop} from '@dentity/application';
async function until(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('condition timed out');await delay(10);}}
async function fixture(t,{botOnly=false,deny=false,sendAck=true}={}){
 const dir=await mkdtemp(join(tmpdir(),'wecom-supervisor-')),store=new Store(join(dir,'test.sqlite'));let now=1800000000000;
 store.run("INSERT INTO users VALUES('u','user','Owner','active')");store.run("INSERT INTO workspaces VALUES('w','Workspace','u','active')");store.run("INSERT INTO members(id,workspace_id,user_id,role,status) VALUES('m','w','u','owner','active')");store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin-interaction')");
 const repository=new EmployeeChannelRepository(store),service=new EmployeeChannelService(repository,{masterKey:new Uint8Array(32).fill(9),now:()=>now});
 const c=await service.save('w','e','wecom','u',{appId:'bot-local',appSecret:'local-only-secret'});
 const capabilities=new CapabilityConfigService(store,[],service);
 service.setAccessCheck((...args)=>capabilities.authorizeChannel(...args));
 // This transport fixture explicitly chooses its access mode; lifecycle defaults
 // are covered elsewhere and must not determine these send/receipt scenarios.
 capabilities.patchDirectoryAccess('w','e',{sourceId:c.sourceId,mode:deny?'allowlist':'all',allow:[],deny:[],expectedRevision:capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===c.sourceId).revision});
 if(!botOnly){
  const old=repository.byId(c.id);repository.save({...old,status:'verified',eventTenantId:c.appId,eventTenantNamespace:'app_id',botId:c.appId,inboundVerified:true,identityEvidence:'authenticated_first_message'},old);
 }
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const sockets=[],frames=[];
 server.on('connection',socket=>{let mediaType;sockets.push(socket);socket.on('message',data=>{const frame=JSON.parse(data.toString());frames.push(frame);if(!sendAck&&['aibot_respond_msg','aibot_send_msg'].includes(frame.cmd))return;if(frame.cmd==='aibot_upload_media_init')mediaType=frame.body.type;socket.send(JSON.stringify({headers:frame.headers,errcode:0,...(frame.cmd==='aibot_upload_media_init'?{body:{upload_id:'synthetic-upload'}}:frame.cmd==='aibot_upload_media_finish'?{body:{media_id:'synthetic-media',type:mediaType}}:{})}));});});
 const messageRepository=new SqliteMessageLoopRepository(store,()=>now);
 const journal=new JsonlJournal({root:join(dir,'journal'),ownerId:'fixture',serialize:fn=>store.transaction(fn)}),conversations=new SqliteConversationRepository(store,journal,()=>now);conversations.initialize(0);
 const notifications=new SqliteTaskCompletionNotifications(store,conversations,messageRepository);
 const loop=new ChannelMessageLoop(messageRepository,service,{}, {},()=>now);
 const factory=(session,credentials)=>new SdkIngress(session,credentials,{forkRunner:()=>fork(new URL('./fixtures/local-wecom-sdk-runner.mjs',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[],env:{TEST_LOCAL_WS:`ws://127.0.0.1:${server.address().port}`}})});
 const supervisor=new ChannelIngressSupervisor(service,loop,factory,()=>now);await supervisor.start();
 t.after(async()=>{await loop.stop();await supervisor.stop();for(const socket of sockets)socket.terminate();await new Promise(resolve=>server.close(resolve));store.close();await rm(dir,{recursive:true,force:true});});
 await until(()=>supervisor.status(c.id).state==='connected');
 const request={conversation:{provider:'wecom',connectionId:c.id,tenantId:c.appId,kind:'conversation',externalId:'employee-local',privateRecipientId:'employee-local',conversationKind:'private'},text:'fixture only',operationId:'op-local'};
 return {c,store,repository,service,capabilities,messageRepository,notifications,loop,supervisor,sockets,frames,request,advance:ms=>now+=ms};
}
test('real SDK supervisor sends only current authenticated robot binding, then fences revoked await',async t=>{
 const f=await fixture(t);f.request.conversation={...f.request.conversation,conversationKind:'group',externalId:'group-local',privateRecipientId:undefined};assert.equal(f.supervisor.canDispatch(f.c.id),true);
 assert.equal((await f.supervisor.send(f.c.id,f.request)).status,'sent');
 await assert.rejects(f.supervisor.send(f.c.id,{...f.request,conversation:{...f.request.conversation,tenantId:'other'}}),e=>e.code==='forbidden');
 let release,entered;const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r);
 const result=f.supervisor.send(f.c.id,{...f.request,beforeSend:async()=>{entered();await gate;}});const rejected=assert.rejects(result,e=>e.code==='forbidden');await seen;
 f.service.settings('w','e','wecom','u',{enabled:false,expectedRevision:f.c.revision});release();await rejected;
 assert.equal(f.supervisor.canDispatch(f.c.id),false);assert.equal(f.frames.filter(x=>x.cmd==='aibot_send_msg').length,1);
});
test('expired owner cannot claim/send; takeover is terminal across periodic reconciles',async t=>{
 const f=await fixture(t);f.sockets[0].send(JSON.stringify({cmd:'aibot_event_callback',headers:{req_id:'takeover'},body:{msgtype:'event',event:{eventtype:'disconnected_event'}}}));await until(()=>f.supervisor.status(f.c.id).state==='failed');
 for(let i=0;i<3;i++){f.advance(10_000);await f.supervisor.tick();}assert.equal(f.sockets.length,1);assert.equal(f.supervisor.canDispatch(f.c.id),false);
 await assert.rejects(f.supervisor.send(f.c.id,f.request),e=>e.code==='not_ready');
});
test('owner lease expiry fences dispatch without waiting for periodic reconciliation',async t=>{
 const f=await fixture(t);f.advance(31_000);assert.equal(f.supervisor.canDispatch(f.c.id),false);await assert.rejects(f.supervisor.send(f.c.id,f.request),e=>e.message==='channel_ingress_owner_lost');assert.equal(f.frames.filter(x=>x.cmd==='aibot_send_msg').length,0);
});

test('I01 WeCom first authenticated message binds, enters the inbox and can reply on the same SDK socket',async t=>{
 const f=await fixture(t,{botOnly:true});
 f.sockets[0].send(JSON.stringify({cmd:'aibot_msg_callback',headers:{req_id:'first-request'},body:{
  aibotid:'bot-local',msgid:'first-message',chattype:'single',from:{userid:'employee-local'},msgtype:'text',text:{content:'fixture first message'},
 }}));
 await until(()=>f.store.one("SELECT count(*) n FROM channel_inbox WHERE status='queued'").n===1);
 assert.equal(f.repository.byId(f.c.id).identityEvidence,'authenticated_first_message');
 const receipt=await f.supervisor.send(f.c.id,{...f.request,conversation:{...f.request.conversation,tenantId:f.c.appId},replyToMessageId:'first-message'});
 assert.equal(receipt.status,'sent');
 assert.equal(f.sockets.length,1);
 assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_respond_msg').length,1);
});

test('I02 denied WeCom private message receives the fixed permission reply on its callback socket',async t=>{
 const f=await fixture(t,{botOnly:true,deny:true});
 f.sockets[0].send(JSON.stringify({cmd:'aibot_msg_callback',headers:{req_id:'denied-request'},body:{
  aibotid:'bot-local',msgid:'denied-message',chattype:'single',from:{userid:'not-on-allowlist'},msgtype:'text',text:{content:'fixture denied message'},
 }}));
 await until(()=>!!f.store.one("SELECT 1 FROM channel_message_receipts WHERE kind='outbox' AND status='sent' AND provider_request_id IS NOT NULL"));
 assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,0);
 assert.equal(f.store.one("SELECT status FROM channel_message_receipts WHERE kind='inbox'").status,'rejected');
 assert.equal(f.repository.byId(f.c.id).identityEvidence,'authenticated_first_message');
 const reply=f.frames.find(frame=>frame.cmd==='aibot_respond_msg');
 assert.equal(reply.headers.req_id,'denied-request');
 assert.match(reply.body.stream.content,/权限/);
 assert.equal(f.frames.some(frame=>frame.cmd==='aibot_send_msg'),false);
 f.advance(31_000);await f.loop.tick();await f.loop.waitForWork();
 const persisted=f.store.one("SELECT status,error,message_id,provider_request_id,blocking,attempts FROM channel_deliveries");
 assert.deepEqual({...persisted},{status:'sent',error:null,message_id:null,provider_request_id:'denied-request',blocking:0,attempts:1});
 assert.equal(f.store.one("SELECT status,error FROM channel_message_receipts WHERE kind='outbox'").status,'sent');
 assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_respond_msg').length,1);
});

 test('missing callback permission reply is failed without proactive fallback or retry',async t=>{
 const f=await fixture(t);
 await f.loop.rejectAuthenticatedEvent({workspaceId:'w',entityId:'e',connectionId:f.c.id,bindingVersion:f.service.currentBindingVersion(f.c.id),appId:f.c.appId,conversation:f.request.conversation,messageId:'missing-callback',eventId:'missing-event'},'permission');
 await until(()=>!!f.store.one("SELECT 1 FROM channel_message_receipts WHERE kind='outbox' AND status='failed'"));
 const receipt=f.store.one("SELECT status,error FROM channel_message_receipts WHERE kind='outbox'");
 assert.equal(receipt.error,'invalid_request');
 await f.loop.tick();await f.loop.waitForWork();
 assert.equal(f.frames.some(frame=>['aibot_respond_msg','aibot_send_msg'].includes(frame.cmd)),false);
 assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,0);
 });

async function acceptedTaskSource(f){
 f.messageRepository.setClaimFilter(()=>false);
 f.sockets.at(-1).send(JSON.stringify({cmd:'aibot_msg_callback',headers:{req_id:'task-request'},body:{aibotid:'bot-local',msgid:'task-message',chattype:'single',from:{userid:'employee-local'},msgtype:'text',text:{content:'synthetic long task'}}}));
 await until(()=>!!f.store.one("SELECT scope_json FROM channel_inbox WHERE status='queued'"));
 const row=f.store.one('SELECT id,scope_json FROM channel_inbox');
 // Synthetic completed-task fixture: preserve the real authenticated inbox scope.
 // No model or business runtime runs in this transport test.
 f.store.run("UPDATE channel_inbox SET status='committed',rt_terminal=1 WHERE id=?",row.id);
 f.store.run("INSERT INTO conversations(id,workspace_id,entity_id,channel,operation_id,created_at,scope_json,owner_key,mode,expires_at) VALUES('synthetic-conversation','w','e','wecom','synthetic-origin',?,?,'synthetic-owner','real',0)",1800000000000,row.scope_json);
 f.store.run("INSERT INTO tasks(id,workspace_id,entity_id,conversation_id,operation_id,request_hash,input,context_mode,snapshot_id,snapshot_json,source_json,status,run_id,created_at,updated_at) VALUES('synthetic-task','w','e','synthetic-conversation','synthetic-task','synthetic-hash','synthetic task','new','synthetic-snapshot','{}',?,'succeeded','synthetic-run',?,?)",row.scope_json,1800000000000,1800000000000);
 f.store.run("INSERT INTO runs(id,task_id,session_id,status,result,result_revision,created_at) VALUES('synthetic-run','synthetic-task','synthetic-session','succeeded','synthetic result',1,?)",1800000000000);
 return row.scope_json;
}
for(const publication of ['legacy','completion','unified'])for(const revoked of [false,true])test(`all-mode unsearched ${publication} private task result survives reconnect and checks current permission (revoked=${revoked})`,async t=>{
 const f=await fixture(t,{botOnly:true}),scopeJson=await acceptedTaskSource(f);
 assert.equal(f.store.one('SELECT count(*) n FROM wecom_bot_contacts').n,0);
 assert.equal(f.repository.byId(f.c.id).wecomContactIdentityRevision,undefined);
 await f.supervisor.stop();await f.supervisor.start();await until(()=>f.supervisor.status(f.c.id).state==='connected');
 assert.equal(f.sockets.length,2);
 if(revoked)f.capabilities.patchDirectoryAccess('w','e',{sourceId:f.c.sourceId,mode:'allowlist',allow:[],deny:[],expectedRevision:f.capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===f.c.sourceId).revision});
 const resultId=publication==='completion'?'task-notification:synthetic-notice':publication==='legacy'?'task-delivery:synthetic-task-delivery':'synthetic-task-result',targetJson=JSON.stringify({conversation:f.request.conversation});
 if(publication==='legacy'){
  f.store.run("INSERT INTO deliveries(id,task_id,conversation_id,event_id,text,status,created_at) VALUES('synthetic-task-delivery','synthetic-task','synthetic-conversation','synthetic-result','synthetic long task result','stored',?)",1800000000000);
 }else{
  f.store.run("INSERT INTO task_completion_notifications(id,task_id,run_id,conversation_id,scope_json,result_ref,status,lease_token,created_at,delivery_id) VALUES('synthetic-notice','synthetic-task','synthetic-run','synthetic-conversation',?,'','leased','synthetic-lease',?,NULL)",scopeJson,1800000000000);
 }
 if(publication==='completion'){
  f.notifications.publish({id:'synthetic-notice',taskId:'synthetic-task',runId:'synthetic-run',conversationId:'synthetic-conversation',scopeJson},'synthetic-lease','synthetic long task result',1800000000000,()=>{});
  assert.equal(f.store.one("SELECT delivery_id FROM task_completion_notifications").delivery_id,resultId);
 }else{
  if(publication==='unified'){
   f.store.run("INSERT INTO business_notification_jobs(id,source_kind,task_id,run_id,scope_json,target_json,state,source_id,workspace_id,entity_id,data_ref,turn_id,created_at) VALUES(?,'task','synthetic-task','synthetic-run',?,?,'published','fixture','w','e','','fixture-turn',1800000000000)",resultId,scopeJson,targetJson);
   f.store.run("UPDATE task_completion_notifications SET status='succeeded',delivery_id=?",resultId);
  }
  // Legacy delivery publication belongs to loop.tick(), including its stable ID.
  // Do not enqueue a second synthetic operation for the same logical result.
  if(publication!=='legacy')f.messageRepository.enqueueDelivery({id:resultId,scopeJson,targetJson,text:'synthetic long task result',status:'queued',taskDeliveryId:null,leaseToken:null},1800000000000);
 }
 f.messageRepository.setClaimFilter(()=>true);await f.loop.tick();await f.loop.waitForWork();
 await until(()=>['failed','sent'].includes(f.store.one("SELECT status FROM channel_deliveries WHERE id=?",resultId)?.status));
 const receipt=f.store.one("SELECT status,error,provider_request_id FROM channel_deliveries WHERE id=?",resultId);
 assert.equal(receipt.status,revoked?'failed':'sent');
 const sends=f.frames.filter(frame=>frame.cmd==='aibot_send_msg');assert.equal(sends.length,revoked?0:1);
 assert.equal(f.frames.some(frame=>frame.cmd==='aibot_respond_msg'),false);
 if(!revoked){assert.equal(sends[0].body.chatid,'employee-local');assert.equal(sends[0].body.markdown.content,'synthetic long task result');assert.equal(receipt.error,null);assert.equal(typeof receipt.provider_request_id,'string');}
 await f.loop.tick();await f.loop.waitForWork();assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_send_msg').length,revoked?0:1);
});
test('originating task scope cannot widen recipient or replace administrator-selected notification verification',async t=>{
 const f=await fixture(t,{botOnly:true}),scope=JSON.parse(await acceptedTaskSource(f));
 await assert.rejects(f.supervisor.send(f.c.id,f.request),e=>e.code==='forbidden');
 await assert.rejects(f.supervisor.send(f.c.id,{...f.request,originatingTaskScope:scope}),e=>e.code==='forbidden');
 for(const changed of [{...scope,workspaceId:'other'},{...scope,source:{...scope.source,conversationId:'other'}},{...scope,principal:{...scope.principal,externalUserId:'other'}},{...scope,source:{...scope.source,bindingVersion:'old'}},{...scope,source:{...scope.source,sourceEventId:undefined}}])
  await assert.rejects(f.supervisor.send(f.c.id,{...f.request,originatingTaskScope:()=>changed}),e=>e.code==='forbidden');
 assert.equal(f.frames.some(frame=>['aibot_send_msg','aibot_respond_msg'].includes(frame.cmd)),false);
});
test('task recipient permission revoked during host beforeSend is checked again before SDK dispatch',async t=>{
 const f=await fixture(t,{botOnly:true}),scope=JSON.parse(await acceptedTaskSource(f));
 await assert.rejects(f.supervisor.send(f.c.id,{...f.request,originatingTaskScope:()=>scope,beforeSend:async()=>{
  f.capabilities.patchDirectoryAccess('w','e',{sourceId:f.c.sourceId,mode:'allowlist',allow:[],deny:[],expectedRevision:f.capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===f.c.sourceId).revision});
 }}),e=>e.code==='forbidden');
 assert.equal(f.frames.some(frame=>['aibot_send_msg','aibot_respond_msg'].includes(frame.cmd)),false);
});

test('unified task attachment inherits only a verified durable parent origin and exact private target',async t=>{
 const f=await fixture(t,{botOnly:true}),scopeJson=await acceptedTaskSource(f),targetJson=JSON.stringify({conversation:f.request.conversation});
 f.store.run("INSERT INTO task_completion_notifications(id,task_id,run_id,conversation_id,scope_json,result_ref,status,created_at,delivery_id) VALUES('artifact-notice','synthetic-task','synthetic-run','synthetic-conversation',?,'','succeeded',?,'artifact-parent')",scopeJson,1800000000000);
 f.store.run("INSERT INTO business_notification_jobs(id,source_kind,task_id,run_id,scope_json,target_json,state,source_id,workspace_id,entity_id,data_ref,turn_id,created_at) VALUES('artifact-parent','task','synthetic-task','synthetic-run',?,?,'published','fixture','w','e','','fixture-turn',1800000000000)",scopeJson,targetJson);
 const parent={id:'artifact-parent',scopeJson,targetJson,text:'synthetic task report',status:'queued',taskDeliveryId:null,leaseToken:null};
 f.messageRepository.enqueueDelivery(parent,1800000000000);
 const artifact={...parent,id:'synthetic-artifact',text:'',targetJson:JSON.stringify({conversation:f.request.conversation,artifact:{taskId:'synthetic-task',runId:'synthetic-run',ref:{resourceId:'synthetic-file',version:'1'}}})};
 const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 f.store.run('INSERT INTO task_artifact_delivery_grants VALUES(?,?,?,?)',artifact.id,digest(scopeJson),digest(artifact.targetJson),JSON.stringify(parent));
 f.messageRepository.enqueueDelivery(artifact,1800000000000);
 assert.deepEqual(f.messageRepository.originatingTaskScope(artifact),JSON.parse(scopeJson));
 await f.supervisor.stop();await f.supervisor.start();await until(()=>f.supervisor.status(f.c.id).state==='connected');
 const result=await f.supervisor.send(f.c.id,{...f.request,text:'',attachment:{kind:'file',name:'synthetic.txt',mediaType:'text/plain',bytes:Buffer.from('synthetic file')},originatingTaskScope:()=>f.messageRepository.originatingTaskScope(artifact)});
 assert.equal(result.status,'sent');const sent=f.frames.find(frame=>frame.cmd==='aibot_send_msg');assert.equal(sent.body.chatid,'employee-local');assert.equal(sent.body.file.media_id,'synthetic-media');assert.equal(f.frames.some(frame=>frame.cmd==='aibot_respond_msg'),false);
 f.store.run("UPDATE business_notification_jobs SET source_kind='trigger' WHERE id='artifact-parent'");assert.equal(f.messageRepository.originatingTaskScope(artifact),undefined);
 f.store.run("UPDATE business_notification_jobs SET source_kind='task' WHERE id='artifact-parent'");
 f.store.run("UPDATE task_artifact_delivery_grants SET target_hash='forged' WHERE delivery_id=?",artifact.id);assert.equal(f.messageRepository.originatingTaskScope(artifact),undefined);
 assert.equal(f.messageRepository.originatingTaskScope({...parent,id:'task-notification:fake'}),undefined);
 assert.equal(f.store.one('SELECT count(*) n FROM wecom_bot_contacts').n,0);
});

for(const outcome of ['timeout','wrong-request-id','nonzero','disconnect'])test(`durable ${outcome} stays unknown without automatic resend`,async t=>{
 const f=await fixture(t,{botOnly:true,deny:true,sendAck:false});
 f.sockets[0].send(JSON.stringify({cmd:'aibot_msg_callback',headers:{req_id:'unconfirmed-request'},body:{aibotid:'bot-local',msgid:'unconfirmed-message',chattype:'single',from:{userid:'employee-local'},msgtype:'text',text:{content:'synthetic denied message'}}}));
 await until(()=>f.frames.some(frame=>frame.cmd==='aibot_respond_msg'));
 if(outcome==='wrong-request-id')f.sockets[0].send(JSON.stringify({headers:{req_id:'unrelated-request'},errcode:0}));
 if(outcome==='nonzero')f.sockets[0].send(JSON.stringify({headers:{req_id:'unconfirmed-request'},errcode:40001,errmsg:'private-error-never-persist'}));
 if(outcome==='disconnect')f.sockets[0].terminate();
 // The locked official SDK's own business ACK timeout is five seconds.
 const deadline=Date.now()+8000;while(f.store.one("SELECT status FROM channel_deliveries")?.status!=='unknown'){if(Date.now()>deadline)assert.fail('unknown delivery was not persisted');await delay(20);}
 const snapshot=()=>f.store.one('SELECT status,error,message_id,provider_request_id,attempts FROM channel_deliveries');
 assert.equal(snapshot().status,'unknown');assert.equal(snapshot().attempts,1);assert.equal(snapshot().message_id,null);assert.equal(snapshot().provider_request_id,null);assert.ok(!JSON.stringify(snapshot()).includes('private-error'));
 if(outcome!=='disconnect')f.sockets[0].send(JSON.stringify({headers:{req_id:'unconfirmed-request'},errcode:0}));
 f.advance(31_000);for(let i=0;i<2;i++){await f.loop.tick();await f.loop.waitForWork();}
 assert.equal(snapshot().status,'unknown');assert.equal(snapshot().attempts,1);assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_respond_msg').length,1);assert.ok(!f.frames.some(frame=>frame.cmd==='aibot_send_msg'));
});
