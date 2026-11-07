import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import protobuf from 'protobufjs/minimal.js';
import {SdkIngress} from '../dist/adapters/channels/ingress/sdk-ingress.js';
const session = provider => ({connectionId:'test-connection',provider,appId:'cli_1234567890abcdef',authRevision:1,revision:1,generation:'test-generation'});
const envelope = {schema:'2.0',header:{app_id:'cli_1234567890abcdef',tenant_key:'trusted-tenant',event_type:'im.message.receive_v1',event_id:'evt'},event:{app_id:'conflicting-nested-app',message:{message_id:'msg'}}};
const callback = {specVersion:'1.0',type:'CALLBACK',headers:{topic:'/v1.0/im/bot/messages/get',messageId:'transport-msg'},data:JSON.stringify({msgId:'msg',text:{content:'hello'}})};
function frame(payload, id='frame1') {
  const w=protobuf.Writer.create().uint32(8).uint64(1).uint32(16).uint64(1).uint32(24).int32(1).uint32(32).int32(1);
  for (const [key,value] of Object.entries({type:'event',message_id:id,sum:'1',seq:'0',trace_id:'trace'})) w.uint32(42).fork().uint32(10).string(key).uint32(18).string(value).ldelim();
  return w.uint32(66).bytes(Buffer.from(JSON.stringify(payload))).finish();
}
function payload(buffer) {const r=protobuf.Reader.create(buffer);while(r.pos<r.len){const tag=r.uint32();if((tag>>>3)===8)return JSON.parse(Buffer.from(r.bytes()).toString());r.skipType(tag&7);}return undefined;}
async function until(predicate) {const deadline=Date.now()+8000;while(!predicate()){if(Date.now()>deadline)throw new Error('condition timed out');await delay(20);}}
async function fixture(t,provider,onEvent) {
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const sockets=[];const responses=[];let child;
  server.on('connection',socket=>{sockets.push(socket);socket.on('message',data=>{const p=provider==='feishu'?payload(data):JSON.parse(data.toString());if(p)responses.push(p);});});
  const port=new SdkIngress(session(provider),{appSecret:'fake-secret-never-log'},{forkRunner:()=>child=fork(new URL('./fixtures/local-sdk-ingress-runner.mjs',import.meta.url),[],{stdio:['ignore','pipe','pipe','ipc'],execArgv:[],env:{TEST_LOCAL_WS:`ws://127.0.0.1:${server.address().port}`}}),stopTimeoutMs:200});
  const statuses=[];let output='';
  t.after(async()=>{await port.stop('test-cleanup');for(const socket of sockets)socket.terminate();await new Promise(resolve=>server.close(resolve));});
  await port.start(session(provider),{onEvent,onStatus:s=>statuses.push(s)});
  child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  assert.equal(port.status().state,'connecting','start acceptance is not readiness');
  await until(()=>port.status().state==='connected');
  return {port,statuses,sockets,responses,child,output:()=>output};
}
for(const provider of ['feishu','dingtalk']) {
  test(`${provider}: real official SDK over local WebSocket waits for parent durable acceptance before ACK`,async t=>{
    let accept;let received;const gate=new Promise(resolve=>accept=resolve);
    const f=await fixture(t,provider,async value=>{received=value;await gate;return 'accepted';});
    f.sockets[0].send(provider==='feishu'?frame(envelope):JSON.stringify(callback));
    await until(()=>received);assert.deepEqual(received,provider==='feishu'?envelope:callback);
    await delay(100);assert.equal(f.responses.length,0,'no success before commit');
    accept();await until(()=>f.responses.length===1);
    assert.equal(f.responses[0].code,200);
    if(provider==='dingtalk')assert.equal(f.responses[0].headers.messageId,'transport-msg');
    assert.ok(!f.output().includes('fake-secret-never-log'));
  });
  test(`${provider}: failed durability never sends success ACK`,async t=>{
    let calls=0;const f=await fixture(t,provider,async()=>{calls++;throw new Error('private persistence details');});
    f.sockets[0].send(provider==='feishu'?frame(envelope):JSON.stringify(callback));
    await until(()=>calls===1);await delay(150);
    assert.ok(f.responses.every(r=>r.code!==200));
    if(provider==='feishu')assert.equal(f.responses[0].code,500);
    assert.ok(!f.output().includes('private persistence details'));
  });
  test(`${provider}: stop revokes late parent ACK and waits for process exit, repeated stop is safe`,async t=>{
    let accept;let called=false;const gate=new Promise(resolve=>accept=resolve);
    const f=await fixture(t,provider,async()=>{called=true;await gate;return 'accepted';});
    f.sockets[0].send(provider==='feishu'?frame(envelope):JSON.stringify(callback));await until(()=>called);
    await f.port.stop('disabled');accept();await delay(100);
    assert.ok(f.child.exitCode!==null||f.child.signalCode!==null);assert.equal(f.port.status().state,'stopped');assert.equal(f.responses.length,0);
    await f.port.stop('again');await assert.rejects(f.port.start(session(provider),{onEvent:async()=> 'accepted',onStatus(){}}));
  });
}
test('Feishu SDK reconnects after local disconnect and stop prevents resurrection',async t=>{
  const f=await fixture(t,'feishu',async()=> 'accepted');f.sockets[0].terminate();
  await until(()=>f.sockets.length===2&&f.statuses.filter(s=>s.state==='connected').length===2);
  assert.ok(f.statuses.some(s=>s.state==='reconnecting'));await f.port.stop('done');await delay(200);assert.equal(f.sockets.length,2);
});
test('Ding SDK does not subscribe EVENT wildcard, acknowledge unexpected EVENT, or reconnect itself',async t=>{
  let calls=0;const f=await fixture(t,'dingtalk',async()=>{calls++;return 'accepted';});
  f.sockets[0].send(JSON.stringify({...callback,type:'EVENT'}));await delay(100);assert.equal(calls,0);assert.equal(f.responses.length,0);
  f.sockets[0].terminate();await until(()=>f.port.status().state==='failed');await delay(1200);assert.equal(f.sockets.length,1);
});
test('process deadline kills stubborn SDK, fences wrong generation and rejects non-whitelisted diagnostics',async()=>{
  let child;let calls=0;const states=[];
  const port=new SdkIngress(session('feishu'),{appSecret:'fake'},{stopTimeoutMs:50,forkRunner:()=>child=fork(new URL('./fixtures/stubborn-ingress-runner.mjs',import.meta.url),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc'],env:{}})});
  await port.start(session('feishu'),{onEvent:async()=>{calls++;return 'accepted';},onStatus:s=>states.push(s)});
  await until(()=>port.status().state==='connected');assert.equal(calls,0);assert.ok(states.every(s=>!s.error));
  await port.stop('deadline');assert.equal(child.signalCode,'SIGKILL');await port.stop('again');
});
test('actual failed fork does not leave stop waiting forever for an exit that never occurs',async()=>{
  const port=new SdkIngress(session('feishu'),{appSecret:'fake'},{stopTimeoutMs:30,forkRunner:()=>fork(new URL('./fixtures/stubborn-ingress-runner.mjs',import.meta.url),[],{execPath:'/nonexistent-dentity-test-node',stdio:['ignore','ignore','ignore','ipc'],env:{}})});
  await port.start(session('feishu'),{onEvent:async()=> 'accepted',onStatus(){}});
  await until(()=>port.status().state==='failed');await Promise.race([port.stop('failed-spawn'),delay(1000).then(()=>{throw new Error('stop leaked');})]);
});
test('production process has minimal environment, no credential argv, and discarded stdout/stderr',async()=>{
  const port=new SdkIngress({...session('feishu'),appId:'invalid-local-only-no-network'},{appSecret:'fake-secret'});
  await port.start({...session('feishu'),appId:'invalid-local-only-no-network'},{onEvent:async()=> 'accepted',onStatus(){}});
  try {assert.equal(port.child.stdout,null);assert.equal(port.child.stderr,null);assert.ok(!port.child.spawnargs.join(' ').includes('fake-secret'));}
  finally {await port.stop('test');}
});

for(const provider of ['feishu','dingtalk']) {
  test(`${provider}: stop during late endpoint discovery cannot resurrect socket`,async t=>{
    const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');let connected=0;server.on('connection',()=>connected++);
    let child;const port=new SdkIngress(session(provider),{appSecret:'fake'},{forkRunner:()=>child=fork(new URL('./fixtures/local-sdk-ingress-runner.mjs',import.meta.url),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc'],env:{TEST_LOCAL_WS:`ws://127.0.0.1:${server.address().port}`,TEST_DISCOVERY_DELAY:'1'}})});
    t.after(async()=>{await port.stop('cleanup');await new Promise(resolve=>server.close(resolve));});
    await port.start(session(provider),{onEvent:async()=> 'accepted',onStatus(){}});await delay(250);await port.stop('disabled');await delay(1100);assert.equal(connected,0);assert.ok(child.exitCode!==null||child.signalCode!==null);
  });
  test(`${provider}: explicit discovery auth rejection becomes a safe terminal authentication code`,async t=>{
    const port=new SdkIngress(session(provider),{appSecret:'fake'},{forkRunner:()=>fork(new URL('./fixtures/local-sdk-ingress-runner.mjs',import.meta.url),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc'],env:{TEST_LOCAL_WS:'ws://127.0.0.1:1',TEST_AUTH_CODE:provider==='feishu'?'514':'401'}})});
    t.after(()=>port.stop('cleanup'));await port.start(session(provider),{onEvent:async()=> 'accepted',onStatus(){}});await until(()=>port.status().state==='failed');assert.equal(port.status().error,'channel_authentication_failed');
  });
}
