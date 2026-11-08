import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {HumanChannelNotifications} from '../dist/human-channel.js';
import {SqliteMessageLoopRepository} from '../dist/channel-loop/repository.js';
import {ChannelMessageLoop} from '@dentity/application';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {SdkIngress} from '../dist/adapters/channels/ingress/sdk-ingress.js';
import {encodeSend,wireHash} from '../dist/adapters/channels/ingress/media-wire.js';
import {normalizeChannelIngressEvent} from '../dist/adapters/channels/ingress/normalize.js';
import {WeComConversationAdapter} from '../dist/adapters/channels/wecom.js';
const session={connectionId:'wecom-test',provider:'wecom',appId:'bot-local',authRevision:1,revision:1,generation:'generation-local'};
const incoming=(overrides={})=>({cmd:'aibot_msg_callback',headers:{req_id:'callback-request'},body:{msgid:'message-1',aibotid:'bot-local',from:{userid:'employee-local'},chattype:'single',msgtype:'text',text:{content:'hello'},response_url:'https://secret.invalid',...overrides}});
const conversation={provider:'wecom',connectionId:session.connectionId,tenantId:'bot-local',kind:'conversation',externalId:'employee-local',privateRecipientId:'employee-local',conversationKind:'private'};
const request=(overrides={})=>({conversation,text:'local response',operationId:'operation-local',...overrides});
async function until(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('condition timed out');await delay(10);}}
async function fixture(t,{onEvent=async()=> 'accepted',auth=true,sendAck=true,mediaAck=true}={}){
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
 const sockets=[],frames=[],statuses=[];let child,uploadType;
 server.on('connection',socket=>{sockets.push(socket);socket.on('message',buffer=>{const frame=JSON.parse(buffer.toString());frames.push(frame);if(frame.cmd==='aibot_upload_media_init')uploadType=frame.body.type;if(mediaAck&&frame.cmd.startsWith('aibot_upload_media_'))socket.send(JSON.stringify({headers:frame.headers,errcode:0,body:frame.cmd.endsWith('_init')?{upload_id:'synthetic-upload'}:frame.cmd.endsWith('_finish')?{media_id:'synthetic-media',type:uploadType}:{}}));if(frame.cmd==='aibot_subscribe'&&auth||frame.cmd==='ping'||sendAck&&['aibot_respond_msg','aibot_send_msg'].includes(frame.cmd))socket.send(JSON.stringify({headers:frame.headers,errcode:0}));});});
 const port=new SdkIngress(session,{botSecret:'local-only-secret'},{forkRunner:()=>child=fork(new URL('./fixtures/local-wecom-sdk-runner.mjs',import.meta.url),[],{stdio:['ignore','pipe','pipe','ipc'],execArgv:[],env:{TEST_LOCAL_WS:`ws://127.0.0.1:${server.address().port}`}})});
 let output='';
 t.after(async()=>{await port.stop('test');for(const socket of sockets)socket.terminate();await new Promise(resolve=>server.close(resolve));});
 await port.start(session,{onEvent,onStatus:s=>statuses.push(s)});child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
 await until(()=>frames.some(f=>f.cmd==='aibot_subscribe'));if(auth)await until(()=>port.status().state==='connected');
 return {port,frames,sockets,statuses,child,output:()=>output};
}
test('real WeCom SDK: socket open is not authenticated; auth rejection is safe terminal failure',async t=>{
 const f=await fixture(t,{auth:false});assert.equal(f.port.status().state,'connecting');
 await assert.rejects(f.port.send(request()),e=>e.code==='not_ready');
 const auth=f.frames.find(x=>x.cmd==='aibot_subscribe');f.sockets[0].send(JSON.stringify({headers:auth.headers,errcode:40001,errmsg:'secret-error-not-for-log'}));
 await until(()=>f.port.status().state==='failed');assert.equal(f.port.status().error,'channel_authentication_failed');assert.ok(!f.output().includes('secret-error'));assert.ok(!f.output().includes('local-only-secret'));
});
test('same real SDK socket receives and replies; no inbound durable ACK is fabricated',async t=>{
 let admit,received;const gate=new Promise(resolve=>admit=resolve);
 const f=await fixture(t,{onEvent:async e=>{received=e;await gate;return 'accepted';}});
 f.sockets[0].send(JSON.stringify(incoming()));await until(()=>received);
 assert.equal(received.body.response_url,undefined);await delay(150);
 assert.ok(f.frames.every(x=>['aibot_subscribe','ping'].includes(x.cmd)));
 admit();await delay(30);assert.ok(f.frames.every(x=>['aibot_subscribe','ping'].includes(x.cmd)));
 const receipt=await f.port.send(request({replyToMessageId:'message-1'}));assert.deepEqual(receipt,{status:'sent',idempotent:false,providerRequestId:'callback-request'});
 const reply=f.frames.find(x=>x.cmd==='aibot_respond_msg');assert.equal(reply.headers.req_id,'callback-request');assert.equal(reply.body.stream.finish,true);assert.equal(reply.body.stream.content,'local response');
 const proactiveReceipt=await f.port.send(request());const proactive=f.frames.find(x=>x.cmd==='aibot_send_msg');assert.deepEqual(proactiveReceipt,{status:'sent',idempotent:false,providerRequestId:proactive.headers.req_id});assert.equal(proactive.body.chatid,'employee-local');assert.equal(proactive.body.markdown.content,'local response');assert.equal(f.sockets.length,1);
 await assert.rejects(f.port.send(request({replyToMessageId:'not-received'})),e=>e.code==='invalid_request');
});
test('invalid bot payload cannot produce parent event or reply context; takeover does not reconnect',async t=>{
 let calls=0;const f=await fixture(t,{onEvent:async()=>{calls++;return 'accepted';}});
 for(const body of [{aibotid:'other-bot'},{from:{}},{chattype:'unknown'}])f.sockets[0].send(JSON.stringify(incoming(body)));
 await delay(100);assert.equal(calls,0);
 f.sockets[0].send(JSON.stringify({cmd:'aibot_event_callback',headers:{req_id:'takeover'},body:{msgtype:'event',event:{eventtype:'disconnected_event'}}}));
 await until(()=>f.port.status().state==='failed');assert.equal(f.port.status().error,'channel_connection_taken_over');await delay(300);assert.equal(f.sockets.length,1);
 await assert.rejects(f.port.send(request()),e=>e.code==='not_ready');
});
test('disconnect after dispatch is unknown, does not retry; host guard rejects before dispatch',async t=>{
 const f=await fixture(t,{sendAck:false});let guarded=0;
 await assert.rejects(f.port.send(request({assertSendAllowed:()=>{guarded++;throw Error('revoked');}})),/revoked/);assert.equal(guarded,1);assert.ok(!f.frames.some(x=>x.cmd==='aibot_send_msg'));
 const sending=f.port.send(request());const rejected=assert.rejects(sending,e=>e.code==='delivery_unknown');await until(()=>f.frames.some(x=>x.cmd==='aibot_send_msg'));f.sockets[0].terminate();await rejected;await delay(200);assert.equal(f.frames.filter(x=>x.cmd==='aibot_send_msg').length,1);
});
test('parent durable admission failure becomes safe failure, never a made-up provider ACK',async t=>{
 const f=await fixture(t,{onEvent:async()=>{throw Error('private database info');}});f.sockets[0].send(JSON.stringify(incoming()));await until(()=>f.port.status().state==='failed');assert.equal(f.port.status().error,'channel_ingress_persistence_failed');assert.ok(f.frames.every(x=>['aibot_subscribe','ping'].includes(x.cmd)));assert.ok(!f.output().includes('private database'));
});
test('normalization uses authenticated robot context, msgid dedup, private userid and real directed group semantics',()=>{
 assert.throws(()=>normalizeChannelIngressEvent(session,incoming()),e=>e.code==='forbidden');
 const hints={botId:'bot-local',tenantId:'bot-local',tenantNamespace:'app_id'};
 const result=normalizeChannelIngressEvent(session,incoming({chattype:'group',chatid:'group-local'}),hints,1000);
 assert.equal(result.event.eventId,'message-1');assert.equal(result.event.tenantId,'bot-local');assert.equal(result.event.message.providerDirectedBot,true);assert.deepEqual(result.event.message.mentions,[]);assert.equal(result.event.message.author.idNamespace,'user_id');assert.equal(result.event.message.conversation.externalId,'group-local');
 for(const body of [{aibotid:'different'},{chattype:'bad'},{chattype:'group',chatid:''},{msgid:''}])assert.throws(()=>normalizeChannelIngressEvent(session,incoming(body),hints));
 const changed=incoming();changed.headers.req_id='another-request';assert.equal(normalizeChannelIngressEvent(session,changed,hints).event.eventId,'message-1');
});
test('conversation adapter declares actual capabilities and cannot invent history',async()=>{
 const connection={workspaceId:'w',connectionId:session.connectionId,provider:'wecom',tenantId:'bot-local',identity:{kind:'bot',externalId:'bot-local'},credentialRef:'opaque'};
 const adapter=new WeComConversationAdapter(connection,{send:async()=>({status:'accepted',idempotent:false})});const caps=await adapter.inspectCapabilities();assert.equal(caps.mentionEvents.supported,false);assert.equal(caps.directedBotMessageEvents.availability,'available');await assert.rejects(adapter.listMessages(conversation,{}),e=>e.code==='unsupported');
});
test('real child fences old generation/revision RPC and bounds 128 pending sends without retry',async t=>{
 const f=await fixture(t,{sendAck:false});
 for(const fence of [{generation:'old'},{revision:0},{authRevision:0},{connectionId:'other'}])f.child.send({type:'send',generation:session.generation,connectionId:session.connectionId,revision:session.revision,authRevision:session.authRevision,requestId:JSON.stringify(fence),request:request(),...fence});
 await delay(100);assert.equal(f.frames.filter(x=>x.cmd==='aibot_send_msg').length,0);
 const sends=Array.from({length:128},(_,i)=>f.port.send(request({operationId:`op-${i}`})).then(()=> 'accepted',e=>e.code));
 await until(()=>f.frames.filter(x=>x.cmd==='aibot_send_msg').length===128);
 await assert.rejects(f.port.send(request()),e=>e.code==='rate_limited');
 await f.port.stop('owner_lost');assert.deepEqual(new Set(await Promise.all(sends)),new Set(['delivery_unknown']));assert.equal(f.frames.filter(x=>x.cmd==='aibot_send_msg').length,128);
});
test('same callback req_id has no SDK backlog: concurrent reply is rejected before dispatch',async t=>{
 let received;const f=await fixture(t,{sendAck:false,onEvent:async e=>{received=e;return 'accepted';}});f.sockets[0].send(JSON.stringify(incoming()));await until(()=>received);
 const first=f.port.send(request({replyToMessageId:'message-1'})).catch(e=>e.code);await until(()=>f.frames.some(x=>x.cmd==='aibot_respond_msg'));
 await assert.rejects(f.port.send(request({replyToMessageId:'message-1'})),e=>e.code==='rate_limited');await f.port.stop('revoked');assert.equal(await first,'delivery_unknown');assert.equal(f.frames.filter(x=>x.cmd==='aibot_respond_msg').length,1);
});
test('real child preserves optional CorpID without granting enterprise scope',async t=>{
 const seen=[];
 const hints={botId:'bot-local',tenantId:'bot-local',tenantNamespace:'app_id'};
 const f=await fixture(t,{onEvent:async envelope=>{seen.push(envelope);normalizeChannelIngressEvent(session,envelope,hints);return 'accepted';}});
 f.sockets[0].send(JSON.stringify(incoming()));await until(()=>seen.length===1);assert.equal(Object.hasOwn(seen[0].body.from,'corpid'),false);
 f.sockets[0].send(JSON.stringify(incoming({msgid:'matching-corp',from:{userid:'employee-local',corpid:'corp-local'}})));await until(()=>seen.length===2);assert.equal(seen[1].body.from.corpid,'corp-local');assert.equal(f.port.status().state,'connected');
 f.sockets[0].send(JSON.stringify(incoming({msgid:'wrong-corp',from:{userid:'employee-local',corpid:'other-corp'}})));await until(()=>seen.length===3);assert.equal(seen[2].body.from.corpid,'other-corp');assert.equal(f.port.status().state,'connected');
 assert.equal(normalizeChannelIngressEvent(session,seen[2],hints).event.tenantId,session.appId);
 assert.throws(()=>normalizeChannelIngressEvent(session,seen[2],{...hints,tenantNamespace:'corp_id'}),e=>e.code==='forbidden');
 assert.ok(f.frames.every(x=>['aibot_subscribe','ping'].includes(x.cmd)));
});

test('real SDK forwards only supported media fields over private IPC; normalized durable event never includes download keys',async t=>{let received;const f=await fixture(t,{onEvent:async event=>{received=event;return'accepted';}});f.sockets[0].send(JSON.stringify(incoming({msgtype:'image',text:undefined,image:{url:'https://media.qq.com/sample?signature=SYNTHETIC',aeskey:'SYNTHETIC_KEY'},otherPrivate:'must-not-cross'})));await until(()=>received);assert.equal(received.body.msgtype,'image');assert.equal(received.body.otherPrivate,undefined);assert.equal(received.body.response_url,undefined);const result=normalizeChannelIngressEvent(session,received,{botId:session.appId,tenantId:'bot-local',tenantNamespace:'app_id'});assert.equal(result.kind,'message');assert.equal(result.media.length,1);assert.ok(!JSON.stringify(result.event).includes('SYNTHETIC'));await f.port.send(request({replyToMessageId:'message-1'}));assert.equal(f.frames.filter(x=>x.cmd==='aibot_respond_msg').length,1);});


test('WeCom human-confirmation outbox reaches the real SDK with the exact private userid',async t=>{
 const f=await fixture(t),dir=mkdtempSync(join(tmpdir(),'identale-wecom-human-')),store=new Store(join(dir,'test.sqlite'));
 store.db.exec("PRAGMA foreign_keys=OFF;INSERT INTO human_requests(request_id,workspace_id,entity_id,task_id,source_run_id,session_id,question_json,question_digest,content_version,created_at,updated_at)VALUES('request','w','e','task','run','session','{}','digest',1,1,1)");
 const repo=new SqliteMessageLoopRepository(store),connection={workspaceId:'w',connectionId:session.connectionId,provider:'wecom',tenantId:'bot-local',identity:{kind:'bot',externalId:session.appId},credentialRef:'local-only'};
 const adapter=new WeComConversationAdapter(connection,{send:r=>f.port.send(r)}),binding={workspaceId:'w',entityId:'e',connectionId:session.connectionId,appId:session.appId,provider:'wecom',bindingVersion:'v1',enabled:true,connection,conversation:adapter};
 const connections={resolveBinding:async()=>binding,currentBindingVersion:()=>binding.bindingVersion},notifications=new HumanChannelNotifications(store,connections,repo);
 repo.setTaskDeliveryPolicy({list:()=>[],refresh:async r=>notifications.assert(r),assert:r=>notifications.assert(r)});
 const loop=new ChannelMessageLoop(repo,connections,{}, {},Date.now);
 t.after(async()=>{await loop.stop();store.close();rmSync(dir,{recursive:true,force:true});});
 const notice={workspaceId:'w',entityId:'e',requestId:'request',target:{kind:'channel',connectionId:session.connectionId,userId:'employee-local',identityNamespace:'user_id',provider:'wecom',appId:session.appId,tenantId:'bot-local'},text:'Synthetic human approval question'};
 await notifications.prepare(notice);await notifications.prepare(notice);await loop.tick();await loop.waitForWork();
 // Repository wakeups schedule another tick. tick() can return while that tick
 // is busy, and waitForWork() observes only already-claimed work, not queued
 // wakeups. Await the durable outcome instead of assuming one drain is final.
 const receipt=()=>store.one("SELECT status,error,provider_request_id FROM channel_message_receipts WHERE id='human-question:request' AND kind='outbox'");
 try{await until(()=>['unknown','sent','failed','canceled','expired'].includes(receipt()?.status));}
 catch(error){assert.fail(`${error.message}; receipt=${JSON.stringify(receipt())}; transport=${JSON.stringify(f.port.status())}; commands=${JSON.stringify(f.frames.map(frame=>frame.cmd))}`);}
 assert.equal(receipt().status,'sent',`Provider business ACK must be persisted as send confirmation: ${JSON.stringify(receipt())}`);
 assert.equal(receipt().error,null,`Sent here means provider-confirmed sending, not client receipt or user read: ${JSON.stringify({receipt:receipt(),transport:f.port.status(),statuses:f.statuses})}`);
 assert.equal(typeof receipt().provider_request_id,'string','SDK confirmation must retain the provider request ID');
 const sends=f.frames.filter(frame=>frame.cmd==='aibot_send_msg');assert.equal(sends.length,1,JSON.stringify({receipt:store.one("SELECT * FROM channel_message_receipts WHERE id='human-question:request'"),delivery:store.one("SELECT status,error,provider_request_id,attempts FROM channel_deliveries WHERE id='human-question:request'"),transport:f.port.status(),statuses:f.statuses,frames:f.frames.map(frame=>({cmd:frame.cmd,chatid:frame.body?.chatid})),childOutput:f.output()}));assert.equal(sends[0].body.chatid,'employee-local');assert.equal(sends[0].body.markdown.content,notice.text);
 const saved=JSON.parse(store.one('SELECT target_json FROM human_channel_notices').target_json);assert.equal(saved.conversation.externalId,'human-user:user_id:employee-local','durable logical destination stays unchanged');
 assert.equal(store.one('SELECT status FROM channel_message_receipts').status,'sent','provider business ACK confirms send, not recipient read');
 assert.equal(store.one('SELECT message_id FROM channel_message_receipts').message_id,null,'req_id is not a provider message ID');
 await loop.tick();await loop.waitForWork();assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_send_msg').length,1);
 assert.equal(f.sockets.length,1);
});

test('WeCom logical private routes reject forged targets, namespaces, group recipients and synthetic quote replies before dispatch',async t=>{
 const f=await fixture(t),connection={workspaceId:'w',connectionId:session.connectionId,provider:'wecom',tenantId:'bot-local',identity:{kind:'bot',externalId:session.appId},credentialRef:'local-only'};
 const adapter=new WeComConversationAdapter(connection,{send:r=>f.port.send(r)}),logical={...conversation,externalId:'human-user:user_id:employee-local',privateRecipientNamespace:'user_id'};
 for(const ref of [{...logical,privateRecipientId:'other'},{...logical,privateRecipientNamespace:'open_id'},{...logical,privateRecipientNamespace:undefined},{...logical,externalId:'arbitrary-chat'},{...logical,conversationKind:'group'}])await assert.rejects(adapter.sendMessage(request({conversation:ref})),e=>e.code==='invalid_request');
 await assert.rejects(adapter.sendMessage(request({conversation:logical,replyToMessageId:'message-1'})),e=>e.code==='invalid_request');
 await assert.rejects(adapter.sendMessage(request({conversation:logical,assertSendAllowed:()=>{throw Error('revoked');}})),/revoked/);
 assert.ok(f.frames.every(frame=>!['aibot_respond_msg','aibot_send_msg'].includes(frame.cmd)));
});

test('WeCom conversation adapter preserves native private replies and group send/reply targets through the real SDK',async t=>{
 const events=[],f=await fixture(t,{onEvent:async e=>{events.push(e);return 'accepted';}}),connection={workspaceId:'w',connectionId:session.connectionId,provider:'wecom',tenantId:'bot-local',identity:{kind:'bot',externalId:session.appId},credentialRef:'local-only'};
 const adapter=new WeComConversationAdapter(connection,{send:r=>f.port.send(r)});
 f.sockets[0].send(JSON.stringify(incoming()));await until(()=>events.length===1);
 await adapter.sendMessage(request({replyToMessageId:'message-1',text:'native private reply'}));
 const group={...conversation,externalId:'group-local',conversationKind:'group',privateRecipientId:undefined};
 const groupFrame=incoming({msgid:'group-message',chattype:'group',chatid:'group-local'});groupFrame.headers.req_id='group-callback';
 f.sockets[0].send(JSON.stringify(groupFrame));await until(()=>events.length===2);
 await adapter.sendMessage(request({conversation:group,text:'native group send'}));
 await adapter.sendMessage(request({conversation:group,replyToMessageId:'group-message',text:'native group reply'}));
 const replies=f.frames.filter(frame=>frame.cmd==='aibot_respond_msg'),sends=f.frames.filter(frame=>frame.cmd==='aibot_send_msg');
 assert.deepEqual(replies.map(frame=>[frame.headers.req_id,frame.body.stream.content]),[['callback-request','native private reply'],['group-callback','native group reply']]);
 assert.equal(sends.length,1);assert.equal(sends[0].body.chatid,'group-local');assert.equal(sends[0].body.markdown.content,'native group send');assert.equal(f.sockets.length,1);
});

const fileAttachment={kind:'file',name:'fixture.txt',mediaType:'text/plain',bytes:new TextEncoder().encode('synthetic file')};
test('native file upload and send reuse the receiving socket, with a new parent authorization check after upload',async t=>{
 const f=await fixture(t);let guards=0;
 const receipt=await f.port.send(request({text:'',attachment:fileAttachment,beforeSend:async()=>{guards++;}}));
 assert.equal(receipt.status,'sent');assert.equal(guards,2);assert.equal(f.sockets.length,1);
 const commands=f.frames.filter(x=>x.cmd!=='ping').map(x=>x.cmd);
 assert.deepEqual(commands,['aibot_subscribe','aibot_upload_media_init','aibot_upload_media_chunk','aibot_upload_media_finish','aibot_send_msg']);
 assert.equal(f.frames.find(x=>x.cmd==='aibot_upload_media_init').body.total_size,fileAttachment.bytes.length);
 assert.equal(f.frames.find(x=>x.cmd==='aibot_send_msg').body.file.media_id,'synthetic-media');
});
test('revocation after upload prevents native media dispatch',async t=>{
 const f=await fixture(t);let guards=0;
 await assert.rejects(f.port.send(request({text:'',attachment:fileAttachment,beforeSend:async()=>{if(++guards===2)throw Error('revoked');}})),e=>e.code==='forbidden');
 assert.equal(guards,2);await delay(50);assert.ok(f.frames.some(x=>x.cmd==='aibot_upload_media_finish'));assert.ok(!f.frames.some(x=>x.cmd==='aibot_send_msg'));
});
test('native reply keeps exact inbound callback and rejects stale reply before upload',async t=>{
 let received;const f=await fixture(t,{onEvent:async e=>{received=e;return'accepted';}});
 await assert.rejects(f.port.send(request({text:'',attachment:fileAttachment,replyToMessageId:'missing'})),e=>e.code==='invalid_request');assert.ok(!f.frames.some(x=>x.cmd==='aibot_upload_media_init'));
 f.sockets[0].send(JSON.stringify(incoming()));await until(()=>received);
 await f.port.send(request({text:'',attachment:fileAttachment,replyToMessageId:'message-1'}));
 const reply=f.frames.find(x=>x.cmd==='aibot_respond_msg');assert.equal(reply.headers.req_id,'callback-request');assert.equal(reply.body.file.media_id,'synthetic-media');assert.equal(f.sockets.length,1);
});
test('upload-only disconnect is not sent; post-dispatch disconnect is unknown and not retried',async t=>{
 const f=await fixture(t,{mediaAck:false});const result=f.port.send(request({text:'',attachment:fileAttachment})).catch(e=>e.code);
 await until(()=>f.frames.some(x=>x.cmd==='aibot_upload_media_init'));f.sockets[0].terminate();assert.equal(await result,'temporarily_unavailable');assert.ok(!f.frames.some(x=>x.cmd==='aibot_send_msg'));
 const other=await fixture(t,{sendAck:false});const unknown=other.port.send(request({text:'',attachment:fileAttachment})).catch(e=>e.code);
 await until(()=>other.frames.some(x=>x.cmd==='aibot_send_msg'));other.sockets[0].terminate();assert.equal(await unknown,'delivery_unknown');await delay(50);assert.equal(other.frames.filter(x=>x.cmd==='aibot_send_msg').length,1);
});
test('invalid native payloads never cross upload transport',async t=>{
 const f=await fixture(t);
 for(const attachment of [{...fileAttachment,bytes:new Uint8Array()},{...fileAttachment,name:'../private'},{...fileAttachment,bytes:new Uint8Array(20_000_001)},{...fileAttachment,kind:'image',mediaType:'image/png'}])await assert.rejects(f.port.send(request({text:'',attachment})),e=>e.code==='invalid_request');
 assert.ok(!f.frames.some(x=>x.cmd==='aibot_upload_media_init'));
});

test('native image sends to the exact group target on one connection',async t=>{
 const f=await fixture(t),attachment={kind:'image',name:'pixel.png',mediaType:'image/png',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP3sAAAAASUVORK5CYII=','base64')};
 const group={...conversation,conversationKind:'group',externalId:'group-local',privateRecipientId:undefined};
 await f.port.send(request({conversation:group,text:'',attachment}));
 const sent=f.frames.find(x=>x.cmd==='aibot_send_msg');assert.equal(sent.body.chatid,'group-local');assert.equal(sent.body.image.media_id,'synthetic-media');assert.equal(f.sockets.length,1);
});
test('late host authorization cannot commit after parent RPC deadline',async t=>{
 const f=await fixture(t);let release,checks=0;const gate=new Promise(resolve=>release=resolve);
 // Hold only the child result IPC so the parent RPC timer deterministically
 // wins, regardless of which process notices the shared deadline first.
 const emit=f.child.emit.bind(f.child),held=[];
 f.child.emit=(event,...args)=>{if(event==='message'&&args[0]?.type==='send_result'){held.push(args[0]);return true;}return emit(event,...args);};
 const result=f.port.send(request({text:'',attachment:fileAttachment,beforeSend:async()=>{if(++checks===2)await gate;}})).catch(e=>e.code);
 await until(()=>checks===2);assert.ok(f.frames.some(x=>x.cmd==='aibot_upload_media_finish'));
 assert.equal(await result,'temporarily_unavailable');release();await until(()=>held.length===1);
 assert.equal(held[0].error,'temporarily_unavailable');emit('message',held[0]);
 await delay(100);assert.ok(!f.frames.some(x=>['aibot_send_msg','aibot_respond_msg'].includes(x.cmd)));
 assert.equal(f.port.status().state,'connected');
});
test('child commit deadline expires before parent RPC and rejects late commit',async t=>{
 const f=await fixture(t),wire=encodeSend(request({text:'',attachment:fileAttachment}));
 const requestId='child-deadline-first',deadline=Date.now()+2000,messages=[];
 f.child.on('message',m=>{if(m.requestId===requestId)messages.push(m);});
 // A direct runner RPC isolates child-first expiry from the host's 15s timer.
 f.child.send({type:'send',generation:session.generation,connectionId:session.connectionId,revision:session.revision,authRevision:session.authRevision,requestId,request:wire,hash:wireHash(wire),deadline});
 await until(()=>messages.some(m=>m.type==='send_prepared'));
 const prepared=messages.find(m=>m.type==='send_prepared');assert.equal(prepared.deadline,deadline);
 await until(()=>messages.some(m=>m.type==='send_result'));
 assert.equal(messages.find(m=>m.type==='send_result').error,'temporarily_unavailable');
 assert.ok(Date.now()>=deadline);assert.equal(f.port.status().state,'connected');
 assert.ok(!f.frames.some(x=>['aibot_send_msg','aibot_respond_msg'].includes(x.cmd)));
 f.child.send({...prepared,type:'send_commit'});await delay(100);
 assert.ok(!f.frames.some(x=>['aibot_send_msg','aibot_respond_msg'].includes(x.cmd)));
});
test('prepared commit rejects altered nonce/hash/generation/deadline',async t=>{
 const f=await fixture(t);let release,checks=0;const gate=new Promise(resolve=>release=resolve),prepared=[];
 f.child.on('message',m=>{if(m.type==='send_prepared')prepared.push(m);});
 const result=f.port.send(request({text:'',attachment:fileAttachment,beforeSend:async()=>{if(++checks===2)await gate;}}));
 await until(()=>prepared.length===1);
 const proof=prepared[0];
 for(const change of [{nonce:'forged'},{hash:'0'.repeat(64)},{generation:'old'},{deadline:Date.now()+60_000}])f.child.send({...proof,type:'send_commit',...change});
 await delay(100);assert.ok(!f.frames.some(x=>x.cmd==='aibot_send_msg'));release();assert.equal((await result).status,'sent');f.child.send({...proof,type:'send_commit'});await delay(50);assert.equal(f.frames.filter(x=>x.cmd==='aibot_send_msg').length,1);
});

test('child rejects media bytes or exact target changed after wire hash was bound',async t=>{
 const f=await fixture(t),wire=encodeSend(request({text:'',attachment:fileAttachment})),hash=wireHash(wire);
 for(const changed of [{...wire,conversation:{...wire.conversation,externalId:'other-user',privateRecipientId:'other-user'}},{...wire,attachment:{...wire.attachment,base64:Buffer.from('different').toString('base64')}}])f.child.send({type:'send',generation:session.generation,connectionId:session.connectionId,revision:session.revision,authRevision:session.authRevision,requestId:JSON.stringify(changed),request:changed,hash,deadline:Date.now()+15_000});
 await delay(100);assert.ok(!f.frames.some(x=>x.cmd==='aibot_upload_media_init'));assert.ok(!f.frames.some(x=>x.cmd==='aibot_send_msg'));
});

test('local SDK fixture uses production heartbeat tolerance during synchronous host work',async t=>{
 const f=await fixture(t);
 // Deliberately model synchronous SQLite work while other test files compete
 // for CPU. The child continues running, but this local WS server cannot ACK.
 // The old 100ms fixture heartbeat terminated the socket after two missed pongs.
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,700);
 const receipt=await f.port.send(request());
 assert.equal(receipt.status,'sent');assert.equal(f.port.status().state,'connected');
 assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_send_msg').length,1);
 assert.equal(f.sockets.length,1,'A healthy connection must not reconnect merely because the fixture server briefly blocks');
});

test('originating task authorization proof is host-only and excluded from the SDK wire',()=>{
 const wire=encodeSend(request({originatingTaskScope:()=>{throw Error('must stay in host');}}));
 assert.equal(Object.hasOwn(wire,'originatingTaskScope'),false);
 assert.equal(JSON.stringify(wire).includes('originatingTaskScope'),false);
});

for(const kind of ['private','group'])test(`only the exact pending ${kind} business ACK confirms sent`,async t=>{
 const f=await fixture(t,{sendAck:false}),target=kind==='private'?conversation:{...conversation,conversationKind:'group',externalId:'group-local',privateRecipientId:undefined};
 let settled=false;const result=f.port.send(request({conversation:target})).finally(()=>settled=true);
 await until(()=>f.frames.some(frame=>frame.cmd==='aibot_send_msg'));
 const sent=f.frames.find(frame=>frame.cmd==='aibot_send_msg');
 f.sockets[0].send(JSON.stringify({headers:{req_id:'unrelated-request'},errcode:0}));
 await delay(80);assert.equal(settled,false);
 f.sockets[0].send(JSON.stringify({headers:sent.headers,errcode:0}));
 assert.deepEqual(await result,{status:'sent',idempotent:false,providerRequestId:sent.headers.req_id});
 f.sockets[0].send(JSON.stringify({headers:sent.headers,errcode:0}));await delay(30);
 assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_send_msg').length,1);
});

test('reply ACK must match the retained inbound callback request',async t=>{
 let received;const f=await fixture(t,{sendAck:false,onEvent:async e=>{received=e;return 'accepted';}});
 f.sockets[0].send(JSON.stringify(incoming()));await until(()=>received);
 let settled=false;const result=f.port.send(request({replyToMessageId:'message-1'})).finally(()=>settled=true);
 await until(()=>f.frames.some(frame=>frame.cmd==='aibot_respond_msg'));
 f.sockets[0].send(JSON.stringify({headers:{req_id:'wrong-callback'},errcode:0}));await delay(80);assert.equal(settled,false);
 f.sockets[0].send(JSON.stringify({headers:{req_id:'callback-request'},errcode:0}));
 assert.deepEqual(await result,{status:'sent',idempotent:false,providerRequestId:'callback-request'});
});

test('nonzero business ACK remains unknown, is sanitized and never retried',async t=>{
 const f=await fixture(t,{sendAck:false}),result=f.port.send(request()).catch(e=>e);
 await until(()=>f.frames.some(frame=>frame.cmd==='aibot_send_msg'));const sent=f.frames.find(frame=>frame.cmd==='aibot_send_msg');
 f.sockets[0].send(JSON.stringify({headers:sent.headers,errcode:40001,errmsg:'secret-error-not-for-log'}));
 const error=await result;assert.equal(error.code,'delivery_unknown');assert.ok(!error.message.includes('secret-error'));
 f.sockets[0].send(JSON.stringify({headers:sent.headers,errcode:0}));await delay(80);
 assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_send_msg').length,1);assert.ok(!f.output().includes('secret-error'));assert.ok(!f.output().includes('local-only-secret'));
});

test('business ACK timeout stays unknown even after a late success, without retry',async t=>{
 const f=await fixture(t,{sendAck:false}),result=f.port.send(request()).catch(e=>e.code);
 await until(()=>f.frames.some(frame=>frame.cmd==='aibot_send_msg'));const sent=f.frames.find(frame=>frame.cmd==='aibot_send_msg');
 assert.equal(await result,'delivery_unknown');
 f.sockets[0].send(JSON.stringify({headers:sent.headers,errcode:0}));await delay(80);
 assert.equal(f.port.status().state,'connected');assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_send_msg').length,1);
});

// Intercept only the existing real child IPC. No alternate transport or SDK mock.
function holdSendResults(child){
 const emit=child.emit.bind(child),held=[];
 child.emit=(event,...args)=>{if(event==='message'&&args[0]?.type==='send_result'){held.push(args[0]);return true;}return emit(event,...args);};
 return {held,emit:message=>emit('message',message)};
}
for(const mutation of ['hash','deadline','missing-request-id','empty-request-id','oversized-request-id','idempotent','message-id','error','status'])test(`IPC send confirmation rejects ${mutation}`,async t=>{
 const f=await fixture(t),ipc=holdSendResults(f.child),result=f.port.send(request()).catch(e=>e.code);
 await until(()=>ipc.held.length===1);const good=ipc.held[0],bad={...good,receipt:{...good.receipt}};
 if(mutation==='hash')bad.hash='0'.repeat(64);
 if(mutation==='deadline')bad.deadline++;
 if(mutation==='missing-request-id')delete bad.receipt.providerRequestId;
 if(mutation==='empty-request-id')bad.receipt.providerRequestId='';
 if(mutation==='oversized-request-id')bad.receipt.providerRequestId='x'.repeat(257);
 if(mutation==='idempotent')bad.receipt.idempotent=true;
 if(mutation==='message-id')bad.receipt.messageId=good.receipt.providerRequestId;
 if(mutation==='error')bad.error='forbidden';
 if(mutation==='status')bad.receipt.status='unknown';
 ipc.emit(bad);assert.equal(await result,'delivery_unknown');ipc.emit(good);await delay(20);
 assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_send_msg').length,1);
});

test('IPC confirmations with another generation or request cannot resolve the pending send',async t=>{
 const f=await fixture(t),ipc=holdSendResults(f.child);let settled=false;
 const result=f.port.send(request()).finally(()=>settled=true);await until(()=>ipc.held.length===1);const good=ipc.held[0];
 ipc.emit({...good,generation:'old'});ipc.emit({...good,requestId:'different'});await delay(40);assert.equal(settled,false);
 ipc.emit(good);assert.deepEqual(await result,good.receipt);
});

test('IPC success before native media authorization is never accepted or dispatched',async t=>{
 const f=await fixture(t);let checks=0,release;const gate=new Promise(resolve=>release=resolve),prepared=[];
 f.child.on('message',message=>{if(message.type==='send_prepared')prepared.push(message);});
 const result=f.port.send(request({text:'',attachment:fileAttachment,beforeSend:async()=>{if(++checks===2)await gate;}})).catch(e=>e.code);
 await until(()=>checks===2&&prepared.length===1);const proof=prepared[0];
 f.child.emit('message',{...proof,type:'send_result',receipt:{status:'sent',idempotent:false,providerRequestId:'fabricated'}});
 assert.equal(await result,'temporarily_unavailable');release();await delay(80);
 assert.ok(!f.frames.some(frame=>['aibot_send_msg','aibot_respond_msg'].includes(frame.cmd)));
});

for(const fence of ['disconnected','deadline'])test(`late success IPC cannot cross the ${fence} fence`,async t=>{
 const f=await fixture(t),ipc=holdSendResults(f.child);
 const result=f.port.send(request()).catch(e=>e.code);
 await until(()=>ipc.held.length===1);const good=ipc.held[0];
 if(fence==='disconnected'){f.sockets[0].terminate();await until(()=>f.port.status().state==='failed');}
 const originalNow=Date.now;
 try{if(fence==='deadline')Date.now=()=>good.deadline;ipc.emit(good);assert.equal(await result,'delivery_unknown');}
 finally{Date.now=originalNow;}
 assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_send_msg').length,1);
});

test('all upload ACKs without the final native media send ACK do not confirm sent',async t=>{
 const f=await fixture(t,{sendAck:false});let settled=false;
 const result=f.port.send(request({text:'',attachment:fileAttachment})).finally(()=>settled=true);
 await until(()=>f.frames.some(frame=>frame.cmd==='aibot_send_msg'));assert.equal(settled,false);
 const uploaded=f.frames.find(frame=>frame.cmd==='aibot_upload_media_finish'),sent=f.frames.find(frame=>frame.cmd==='aibot_send_msg');
 f.sockets[0].send(JSON.stringify({headers:uploaded.headers,errcode:0}));await delay(50);assert.equal(settled,false);
 f.sockets[0].send(JSON.stringify({headers:sent.headers,errcode:0}));assert.deepEqual(await result,{status:'sent',idempotent:false,providerRequestId:sent.headers.req_id});
});

test('provider confirmation does not rerun a pre-dispatch guard and mislabel a completed send',async t=>{
 const f=await fixture(t),ipc=holdSendResults(f.child);let checks=0,authorized=true;
 const result=f.port.send(request({assertSendAllowed:()=>{checks++;if(!authorized)throw Error('revoked after dispatch');}}));
 await until(()=>ipc.held.length===1);authorized=false;ipc.emit(ipc.held[0]);
 assert.equal((await result).status,'sent');assert.equal(checks,1);
 assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_send_msg').length,1);
});

for(const firstKind of ['text','file'])for(const outcome of ['timeout','nonzero'])test(`${firstKind} reply ${outcome} poisons its callback across duplicate ingress and late ACKs`,async t=>{
 const events=[],f=await fixture(t,{sendAck:false,onEvent:async e=>{events.push(e);return 'accepted';}});
 f.sockets[0].send(JSON.stringify(incoming()));await until(()=>events.length===1);
 const first=f.port.send(request({replyToMessageId:'message-1',operationId:'reply-a',...(firstKind==='file'?{text:'',attachment:fileAttachment}:{})})).catch(e=>e.code);
 await until(()=>f.frames.some(frame=>frame.cmd==='aibot_respond_msg'));
 if(outcome==='nonzero')f.sockets[0].send(JSON.stringify({headers:{req_id:'callback-request'},errcode:40001}));
 assert.equal(await first,'delivery_unknown');assert.equal(f.port.status().state,'connected');
 const uploadsBefore=f.frames.filter(frame=>frame.cmd==='aibot_upload_media_init').length;
 for(const attachment of [undefined,fileAttachment])await assert.rejects(f.port.send(request({replyToMessageId:'message-1',operationId:'reply-b',...(attachment?{text:'',attachment}:{})})),e=>e.code==='invalid_request');
 assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_upload_media_init').length,uploadsBefore,'poisoned replies fail before uploading');
 // Neither exact replay, a new message ID with the old req_id, nor the same
 // message ID with a different req_id can revive the ambiguous callback.
 const changedRequest=incoming();changedRequest.headers.req_id='duplicate-new-request';
 for(const event of [incoming(),incoming({msgid:'duplicate-new-message'}),changedRequest])f.sockets[0].send(JSON.stringify(event));
 await until(()=>events.length===4);
 for(const messageId of ['message-1','duplicate-new-message'])await assert.rejects(f.port.send(request({replyToMessageId:messageId,operationId:'reply-after-replay'})),e=>e.code==='invalid_request');
 f.sockets[0].send(JSON.stringify({headers:{req_id:'callback-request'},errcode:0}));await delay(50);
 await assert.rejects(f.port.send(request({replyToMessageId:'message-1',operationId:'reply-after-late-ack'})),e=>e.code==='invalid_request');
 assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_respond_msg').length,1);
 assert.equal(f.frames.some(frame=>frame.cmd==='aibot_send_msg'),false,'no proactive fallback');
 // A separate fresh callback has a separate ACK identity and remains usable.
 const fresh=incoming({msgid:'fresh-message'});fresh.headers.req_id='fresh-request';f.sockets[0].send(JSON.stringify(fresh));await until(()=>events.length===5);
 let settled=false;const freshResult=f.port.send(request({replyToMessageId:'fresh-message',operationId:'fresh-operation'})).finally(()=>settled=true);
 await until(()=>f.frames.filter(frame=>frame.cmd==='aibot_respond_msg').length===2);
 f.sockets[0].send(JSON.stringify({headers:{req_id:'callback-request'},errcode:0}));await delay(30);assert.equal(settled,false);
 f.sockets[0].send(JSON.stringify({headers:{req_id:'fresh-request'},errcode:0}));
 assert.deepEqual(await freshResult,{status:'sent',idempotent:false,providerRequestId:'fresh-request'});
});

for(const kind of ['private','group'])test(`confirmed ${kind} callback supports sequential text and attachment replies`,async t=>{
 const events=[],f=await fixture(t,{onEvent:async e=>{events.push(e);return 'accepted';}}),isGroup=kind==='group';
 const target=isGroup?{...conversation,conversationKind:'group',externalId:'group-local',privateRecipientId:undefined}:conversation;
 const event=incoming(isGroup?{chattype:'group',chatid:'group-local'}:{});f.sockets[0].send(JSON.stringify(event));await until(()=>events.length===1);
 const imageAttachment={kind:'image',name:'pixel.png',mediaType:'image/png',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP3sAAAAASUVORK5CYII=','base64')};
 for(const [index,attachment]of [undefined,fileAttachment,imageAttachment,undefined].entries()){
  const receipt=await f.port.send(request({conversation:target,replyToMessageId:'message-1',operationId:'confirmed-'+index,...(attachment?{text:'',attachment}:{})}));
  assert.deepEqual(receipt,{status:'sent',idempotent:false,providerRequestId:'callback-request'});
 }
 assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_respond_msg').length,4);assert.equal(f.sockets.length,1);
});

test('poisoned callback capacity terminates this connection instead of evicting ambiguous ACK identities',async t=>{
 const seen=new Set(),f=await fixture(t,{sendAck:false,onEvent:async e=>{seen.add(e.body.msgid);return 'accepted';}});
 f.sockets[0].on('message',data=>{const frame=JSON.parse(data.toString());if(frame.cmd==='aibot_respond_msg')f.sockets[0].send(JSON.stringify({headers:frame.headers,errcode:40001}));});
 for(let base=0;base<1024;base+=32){
  const ids=Array.from({length:32},(_,index)=>base+index);
  for(const id of ids){const event=incoming({msgid:'poison-message-'+id});event.headers.req_id='poison-request-'+id;f.sockets[0].send(JSON.stringify(event));}
  await until(()=>ids.every(id=>seen.has('poison-message-'+id)));
  const results=await Promise.all(ids.map(id=>f.port.send(request({replyToMessageId:'poison-message-'+id,operationId:'poison-operation-'+id})).catch(e=>e.code)));
  assert.deepEqual(new Set(results),new Set(['delivery_unknown']));
 }
 await until(()=>f.port.status().state==='failed');
 assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_respond_msg').length,1024);
 await assert.rejects(f.port.send(request({replyToMessageId:'poison-message-0',operationId:'cannot-revive-first'})),e=>e.code==='not_ready');
 await delay(80);assert.equal(f.sockets.length,1);assert.ok(!f.frames.some(frame=>frame.cmd==='aibot_send_msg'));
});
