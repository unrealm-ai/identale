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
const conversation={provider:'wecom',connectionId:session.connectionId,tenantId:'corp-local',kind:'conversation',externalId:'employee-local',privateRecipientId:'employee-local',conversationKind:'private'};
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
 const receipt=await f.port.send(request({replyToMessageId:'message-1'}));assert.equal(receipt.status,'accepted');assert.equal(receipt.idempotent,false);
 const reply=f.frames.find(x=>x.cmd==='aibot_respond_msg');assert.equal(reply.headers.req_id,'callback-request');assert.equal(reply.body.stream.finish,true);assert.equal(reply.body.stream.content,'local response');
 await f.port.send(request());const proactive=f.frames.find(x=>x.cmd==='aibot_send_msg');assert.equal(proactive.body.chatid,'employee-local');assert.equal(proactive.body.markdown.content,'local response');assert.equal(f.sockets.length,1);
 await assert.rejects(f.port.send(request({replyToMessageId:'not-received'})),e=>e.code==='not_ready');
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
test('normalization uses admin context, msgid dedup, private userid and real directed group semantics',()=>{
 assert.equal(normalizeChannelIngressEvent(session,incoming()).kind,'ignored');
 const hints={botId:'bot-local',tenantId:'corp-local',tenantNamespace:'corp_id'};
 const result=normalizeChannelIngressEvent(session,incoming({chattype:'group',chatid:'group-local'}),hints,1000);
 assert.equal(result.event.eventId,'message-1');assert.equal(result.event.tenantId,'corp-local');assert.equal(result.event.message.providerDirectedBot,true);assert.deepEqual(result.event.message.mentions,[]);assert.equal(result.event.message.author.idNamespace,'user_id');assert.equal(result.event.message.conversation.externalId,'group-local');
 for(const body of [{aibotid:'different'},{from:{userid:'u',corpid:'other'}},{chattype:'bad'},{chattype:'group',chatid:''},{msgid:''}])assert.throws(()=>normalizeChannelIngressEvent(session,incoming(body),hints));
 const changed=incoming();changed.headers.req_id='another-request';assert.equal(normalizeChannelIngressEvent(session,changed,hints).event.eventId,'message-1');
});
test('conversation adapter declares actual capabilities and cannot invent history',async()=>{
 const connection={workspaceId:'w',connectionId:session.connectionId,provider:'wecom',tenantId:'corp-local',identity:{kind:'bot',externalId:'bot-local'},credentialRef:'opaque'};
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
test('real child preserves optional CorpID for parent binding check, and never invents it',async t=>{
 const seen=[];
 const hints={botId:'bot-local',tenantId:'corp-local',tenantNamespace:'corp_id'};
 const f=await fixture(t,{onEvent:async envelope=>{seen.push(envelope);normalizeChannelIngressEvent(session,envelope,hints);return 'accepted';}});
 f.sockets[0].send(JSON.stringify(incoming()));await until(()=>seen.length===1);assert.equal(Object.hasOwn(seen[0].body.from,'corpid'),false);
 f.sockets[0].send(JSON.stringify(incoming({msgid:'matching-corp',from:{userid:'employee-local',corpid:'corp-local'}})));await until(()=>seen.length===2);assert.equal(seen[1].body.from.corpid,'corp-local');assert.equal(f.port.status().state,'connected');
 f.sockets[0].send(JSON.stringify(incoming({msgid:'wrong-corp',from:{userid:'employee-local',corpid:'other-corp'}})));await until(()=>seen.length===3);assert.equal(seen[2].body.from.corpid,'other-corp');await until(()=>f.port.status().state==='failed');
 assert.throws(()=>normalizeChannelIngressEvent(session,seen[2],hints),e=>e.message==='ingress_sender_tenant_mismatch');
 assert.ok(f.frames.every(x=>['aibot_subscribe','ping'].includes(x.cmd)));
});

test('real SDK forwards only supported media fields over private IPC; normalized durable event never includes download keys',async t=>{let received;const f=await fixture(t,{onEvent:async event=>{received=event;return'accepted';}});f.sockets[0].send(JSON.stringify(incoming({msgtype:'image',text:undefined,image:{url:'https://media.qq.com/sample?signature=SYNTHETIC',aeskey:'SYNTHETIC_KEY'},otherPrivate:'must-not-cross'})));await until(()=>received);assert.equal(received.body.msgtype,'image');assert.equal(received.body.otherPrivate,undefined);assert.equal(received.body.response_url,undefined);const result=normalizeChannelIngressEvent(session,received,{botId:session.appId,tenantId:'corp-local',tenantNamespace:'corp_id'});assert.equal(result.kind,'message');assert.equal(result.media.length,1);assert.ok(!JSON.stringify(result.event).includes('SYNTHETIC'));await f.port.send(request({replyToMessageId:'message-1'}));assert.equal(f.frames.filter(x=>x.cmd==='aibot_respond_msg').length,1);});


test('WeCom human-confirmation outbox reaches the real SDK with the exact private userid',async t=>{
 const f=await fixture(t),dir=mkdtempSync(join(tmpdir(),'identale-wecom-human-')),store=new Store(join(dir,'test.sqlite'));
 store.db.exec("PRAGMA foreign_keys=OFF;INSERT INTO human_requests(request_id,workspace_id,entity_id,task_id,source_run_id,session_id,question_json,question_digest,content_version,created_at,updated_at)VALUES('request','w','e','task','run','session','{}','digest',1,1,1)");
 const repo=new SqliteMessageLoopRepository(store),connection={workspaceId:'w',connectionId:session.connectionId,provider:'wecom',tenantId:'corp-local',identity:{kind:'bot',externalId:session.appId},credentialRef:'local-only'};
 const adapter=new WeComConversationAdapter(connection,{send:r=>f.port.send(r)}),binding={workspaceId:'w',entityId:'e',connectionId:session.connectionId,appId:session.appId,provider:'wecom',bindingVersion:'v1',enabled:true,connection,conversation:adapter};
 const connections={resolveBinding:async()=>binding,currentBindingVersion:()=>binding.bindingVersion},notifications=new HumanChannelNotifications(store,connections,repo);
 repo.setTaskDeliveryPolicy({list:()=>[],refresh:async r=>notifications.assert(r),assert:r=>notifications.assert(r)});
 const loop=new ChannelMessageLoop(repo,connections,{}, {},Date.now);
 t.after(async()=>{await loop.stop();store.close();rmSync(dir,{recursive:true,force:true});});
 const notice={workspaceId:'w',entityId:'e',requestId:'request',target:{kind:'channel',connectionId:session.connectionId,userId:'employee-local',identityNamespace:'user_id',provider:'wecom',appId:session.appId,tenantId:'corp-local'},text:'Synthetic human approval question'};
 await notifications.prepare(notice);await notifications.prepare(notice);await loop.tick();await loop.waitForWork();
 // Repository wakeups schedule another tick. tick() can return while that tick
 // is busy, and waitForWork() observes only already-claimed work, not queued
 // wakeups. Await the durable outcome instead of assuming one drain is final.
 const receipt=()=>store.one("SELECT status,error,provider_request_id FROM channel_message_receipts WHERE id='human-question:request' AND kind='outbox'");
 try{await until(()=>['unknown','sent','failed','canceled','expired'].includes(receipt()?.status));}
 catch(error){assert.fail(`${error.message}; receipt=${JSON.stringify(receipt())}; transport=${JSON.stringify(f.port.status())}; commands=${JSON.stringify(f.frames.map(frame=>frame.cmd))}`);}
 assert.equal(receipt().status,'unknown',`Provider acceptance must be persisted without invented delivery proof: ${JSON.stringify(receipt())}`);
 assert.equal(receipt().error,null,`Unknown here must mean ACKed acceptance, not transport failure: ${JSON.stringify({receipt:receipt(),transport:f.port.status(),statuses:f.statuses})}`);
 assert.equal(typeof receipt().provider_request_id,'string','SDK acceptance must retain the provider request ID');
 const sends=f.frames.filter(frame=>frame.cmd==='aibot_send_msg');assert.equal(sends.length,1,JSON.stringify({receipt:store.one("SELECT * FROM channel_message_receipts WHERE id='human-question:request'"),delivery:store.one("SELECT status,error,provider_request_id,attempts FROM channel_deliveries WHERE id='human-question:request'"),transport:f.port.status(),statuses:f.statuses,frames:f.frames.map(frame=>({cmd:frame.cmd,chatid:frame.body?.chatid})),childOutput:f.output()}));assert.equal(sends[0].body.chatid,'employee-local');assert.equal(sends[0].body.markdown.content,notice.text);
 const saved=JSON.parse(store.one('SELECT target_json FROM human_channel_notices').target_json);assert.equal(saved.conversation.externalId,'human-user:user_id:employee-local','durable logical destination stays unchanged');
 assert.equal(store.one('SELECT status FROM channel_message_receipts').status,'unknown','provider acceptance is not fabricated delivery proof');
 assert.equal(f.sockets.length,1);
});

test('WeCom logical private routes reject forged targets, namespaces, group recipients and synthetic quote replies before dispatch',async t=>{
 const f=await fixture(t),connection={workspaceId:'w',connectionId:session.connectionId,provider:'wecom',tenantId:'corp-local',identity:{kind:'bot',externalId:session.appId},credentialRef:'local-only'};
 const adapter=new WeComConversationAdapter(connection,{send:r=>f.port.send(r)}),logical={...conversation,externalId:'human-user:user_id:employee-local',privateRecipientNamespace:'user_id'};
 for(const ref of [{...logical,privateRecipientId:'other'},{...logical,privateRecipientNamespace:'open_id'},{...logical,privateRecipientNamespace:undefined},{...logical,externalId:'arbitrary-chat'},{...logical,conversationKind:'group'}])await assert.rejects(adapter.sendMessage(request({conversation:ref})),e=>e.code==='invalid_request');
 await assert.rejects(adapter.sendMessage(request({conversation:logical,replyToMessageId:'message-1'})),e=>e.code==='invalid_request');
 await assert.rejects(adapter.sendMessage(request({conversation:logical,assertSendAllowed:()=>{throw Error('revoked');}})),/revoked/);
 assert.ok(f.frames.every(frame=>!['aibot_respond_msg','aibot_send_msg'].includes(frame.cmd)));
});

test('WeCom conversation adapter preserves native private replies and group send/reply targets through the real SDK',async t=>{
 const events=[],f=await fixture(t,{onEvent:async e=>{events.push(e);return 'accepted';}}),connection={workspaceId:'w',connectionId:session.connectionId,provider:'wecom',tenantId:'corp-local',identity:{kind:'bot',externalId:session.appId},credentialRef:'local-only'};
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
 assert.equal(receipt.status,'accepted');assert.equal(guards,2);assert.equal(f.sockets.length,1);
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
 await assert.rejects(f.port.send(request({text:'',attachment:fileAttachment,replyToMessageId:'missing'})),e=>e.code==='not_ready');assert.ok(!f.frames.some(x=>x.cmd==='aibot_upload_media_init'));
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
 await delay(100);assert.ok(!f.frames.some(x=>x.cmd==='aibot_send_msg'));release();assert.equal((await result).status,'accepted');f.child.send({...proof,type:'send_commit'});await delay(50);assert.equal(f.frames.filter(x=>x.cmd==='aibot_send_msg').length,1);
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
 assert.equal(receipt.status,'accepted');assert.equal(f.port.status().state,'connected');
 assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_send_msg').length,1);
 assert.equal(f.sockets.length,1,'A healthy connection must not reconnect merely because the fixture server briefly blocks');
});
