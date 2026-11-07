import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {SdkIngress} from '../dist/adapters/channels/ingress/sdk-ingress.js';
import {normalizeChannelIngressEvent} from '../dist/adapters/channels/ingress/normalize.js';
import {WeComConversationAdapter} from '../dist/adapters/channels/wecom.js';
const session={connectionId:'wecom-test',provider:'wecom',appId:'bot-local',authRevision:1,revision:1,generation:'generation-local'};
const incoming=(overrides={})=>({cmd:'aibot_msg_callback',headers:{req_id:'callback-request'},body:{msgid:'message-1',aibotid:'bot-local',from:{userid:'employee-local'},chattype:'single',msgtype:'text',text:{content:'hello'},response_url:'https://secret.invalid',...overrides}});
const conversation={provider:'wecom',connectionId:session.connectionId,tenantId:'corp-local',kind:'conversation',externalId:'employee-local',privateRecipientId:'employee-local',conversationKind:'private'};
const request=(overrides={})=>({conversation,text:'local response',operationId:'operation-local',...overrides});
async function until(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('condition timed out');await delay(10);}}
async function fixture(t,{onEvent=async()=> 'accepted',auth=true,sendAck=true}={}){
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
 const sockets=[],frames=[],statuses=[];let child;
 server.on('connection',socket=>{sockets.push(socket);socket.on('message',buffer=>{const frame=JSON.parse(buffer.toString());frames.push(frame);if(frame.cmd==='aibot_subscribe'&&auth||frame.cmd==='ping'||sendAck&&['aibot_respond_msg','aibot_send_msg'].includes(frame.cmd))socket.send(JSON.stringify({headers:frame.headers,errcode:0}));});});
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
