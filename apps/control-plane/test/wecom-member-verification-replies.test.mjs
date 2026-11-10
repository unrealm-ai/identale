import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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

const day=24*60*60_000,success='身份验证成功',used='验证码已使用，请勿重复发送。',expired='验证码已过期，请联系管理员获取新验证码。',revoked='验证码已作废，请联系管理员获取新验证码。',conflict='身份验证未完成，请联系管理员获取新验证码。';
async function until(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('condition timed out');await delay(10);}}
// Reuse the existing official SDK localhost fixture. No real tenant, model,
// provider session search, proactive notification or business runtime is used.
async function fixture(t,{sendAck=true,allowBusiness=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'wecom-verification-replies-')),store=new Store(join(dir,'test.sqlite'));let now=1800000000000;
 store.run("INSERT INTO users VALUES('u','user','Owner','active')");store.run("INSERT INTO workspaces VALUES('w','Workspace','u','active')");store.run("INSERT INTO members(id,workspace_id,user_id,role,status) VALUES('m','w','u','owner','active')");store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin-interaction')");
 const repository=new EmployeeChannelRepository(store),service=new EmployeeChannelService(repository,{masterKey:new Uint8Array(32).fill(9),now:()=>now});
 const connection=await service.save('w','e','wecom','u',{appId:'bot-local',appSecret:'local-only-secret'}),old=repository.byId(connection.id);
 repository.save({...old,status:'verified',eventTenantId:connection.appId,eventTenantNamespace:'app_id',botId:connection.appId,inboundVerified:true,identityEvidence:'authenticated_first_message'},old);
 const capabilities=new CapabilityConfigService(store,[],service),permissionChecks=[];
 service.setAccessCheck((...args)=>{permissionChecks.push(args[2]);return capabilities.authorizeChannel(...args);});
 const setBusinessAccess=allowed=>capabilities.patchDirectoryAccess('w','e',{sourceId:connection.sourceId,mode:allowed?'all':'allowlist',allow:[],deny:[],allowGroupMembers:false,expectedRevision:capabilities.getDirectoryAccess('w','e').channelPolicies.find(policy=>policy.sourceId===connection.sourceId).revision});
 setBusinessAccess(allowBusiness);
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const sockets=[],frames=[],completed=[],diagnostics=[],errors=[],hooks={};
 server.on('connection',socket=>{sockets.push(socket);socket.on('message',data=>{const frame=JSON.parse(data.toString());frames.push(frame);if(!sendAck&&['aibot_respond_msg','aibot_send_msg'].includes(frame.cmd))return;socket.send(JSON.stringify({headers:frame.headers,errcode:0}));});});
 const messageRepository=new SqliteMessageLoopRepository(store,()=>now);
 // Exercise real permission/admission writes while never dispatching a model or
 // a normal permission-rejection outbox from this verification transport suite.
 messageRepository.setClaimFilter(()=>false);
 const loop=new ChannelMessageLoop(messageRepository,service,{}, {},()=>now);
 const factory=(session,credentials)=>{
  const port=new SdkIngress(session,credentials,{forkRunner:()=>fork(new URL('./fixtures/local-wecom-sdk-runner.mjs',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[],env:{TEST_LOCAL_WS:`ws://127.0.0.1:${server.address().port}`}})});
  return {start:(session,sink)=>port.start(session,{...sink,onEvent:async envelope=>{try{return await sink.onEvent(envelope);}catch(error){errors.push(error);throw error;}finally{completed.push(envelope.body?.msgid);}}}),stop:reason=>port.stop(reason),status:()=>port.status(),send:async request=>{await hooks.beforeSend?.();return port.send(request);}};
 };
 const supervisor=new ChannelIngressSupervisor(service,loop,factory,()=>now,{event:event=>diagnostics.push(event)});await supervisor.start();
 t.after(async()=>{await loop.stop();await supervisor.stop();for(const socket of sockets)socket.terminate();await new Promise(resolve=>server.close(resolve));store.close();await rm(dir,{recursive:true,force:true});});
 await until(()=>supervisor.status(connection.id).state==='connected');
 const seed=async({userId='selected-member',expired=false,replace=false}={})=>{
  const requestId=randomUUID(),issued=await service.memberVerification.start(repository.byId(connection.id),userId,requestId,'u',{ready:async()=>true},replace);
  assert.match(issued.phrase,/^\d{6}$/);
  if(expired){const current=repository.byId(connection.id);repository.save({...current,wecomMemberChallenges:current.wecomMemberChallenges.map(challenge=>challenge.requestId===requestId?{...challenge,expiresAt:now-1}:challenge)},current);}
  return issued.phrase;
 };
 const incoming=(id,code,patch={})=>({cmd:'aibot_msg_callback',headers:{req_id:'request-'+id},body:{aibotid:'bot-local',msgid:id,chattype:'single',from:{userid:'callback-member'},msgtype:'text',text:{content:code},...patch}});
 const receive=async(id,code,patch={})=>{const count=completed.filter(value=>value===id).length;sockets.at(-1).send(JSON.stringify(incoming(id,code,patch)));await until(()=>completed.filter(value=>value===id).length>count);};
 const replies=()=>frames.filter(frame=>frame.cmd==='aibot_respond_msg');
 const assertNoBusiness=()=>{assert.equal(permissionChecks.length,0,'known control traffic must bypass ordinary permission checks');for(const table of ['channel_inbox','channel_deliveries','channel_message_receipts'])assert.equal(store.one(`SELECT count(*) n FROM ${table}`).n,0,table);assert.equal(frames.some(frame=>frame.cmd==='aibot_send_msg'),false);};
 const protectControl=code=>{for(const event of diagnostics){assert.equal(typeof event.text==='string'&&event.text.includes(code),false);assert.equal(event.json,undefined);}assert.equal(replies().some(reply=>reply.body.stream.content.includes(code)),false);};
 const advanceConnected=async ms=>{now+=ms;await supervisor.tick();await until(()=>supervisor.status(connection.id).state==='connected');};
 return {connection,store,repository,service,supervisor,sockets,frames,completed,errors,diagnostics,hooks,seed,incoming,receive,replies,assertNoBusiness,protectControl,permissionChecks,setBusinessAccess,advanceConnected,advance:ms=>now+=ms};
}

test('member code succeeds once on the original authenticated callback without business work or code echo',async t=>{
 const f=await fixture(t),code=await f.seed();
 await f.receive('verified',code);
 assert.deepEqual(f.replies().map(reply=>[reply.headers.req_id,reply.body.stream.content]),[['request-verified',success]]);
 assert.deepEqual(f.repository.byId(f.connection.id).wecomContactMappings.map(mapping=>[mapping.userId,mapping.callbackUserId]),[['selected-member','callback-member']]);
 assert.equal(f.sockets.length,1);assert.equal(f.service.isVerificationEvent(f.connection.id,'verified','verified'),true);
 await Promise.all([f.receive('verified',code),f.receive('verified',code)]);assert.equal(f.replies().length,1);
 // Persistent suppression survives a new authenticated runner/socket.
 await f.supervisor.stop();await f.supervisor.start();await until(()=>f.supervisor.status(f.connection.id).state==='connected');
 await f.receive('verified',code);assert.equal(f.replies().length,1);
 f.protectControl(code);assert.deepEqual(f.errors,[]);f.assertNoBusiness();
});

test('member code awaits authoritative persistence before claiming verification success',async t=>{
 const f=await fixture(t),code=await f.seed();
 f.service.setMemberVerificationPersistence(async()=>false);
 await f.receive('awaiting-persistence',code);
 assert.deepEqual(f.replies().map(reply=>[reply.headers.req_id,reply.body.stream.content]),[['request-awaiting-persistence','验证结果正在同步，请稍后查看页面状态。']]);
 assert.deepEqual(f.repository.byId(f.connection.id).wecomContactMappings.map(mapping=>[mapping.userId,mapping.callbackUserId]),[['selected-member','callback-member']]);
 assert.equal(f.service.isVerificationEvent(f.connection.id,'awaiting-persistence','awaiting-persistence'),true);
 // Later synchronization cannot revive the consumed callback for a second reply.
 f.service.setMemberVerificationPersistence(async()=>true);
 await f.receive('awaiting-persistence',code);assert.equal(f.replies().length,1);
 f.protectControl(code);assert.deepEqual(f.errors,[]);f.assertNoBusiness();
});

test('one known code embedded in plain private text verifies immediately without ordinary authorization',async t=>{
 const f=await fixture(t),code=await f.seed();
 await f.receive('embedded','验证码给你 '+code+'，请处理');
 assert.deepEqual(f.replies().map(reply=>[reply.headers.req_id,reply.body.stream.content]),[['request-embedded',success]]);
 f.protectControl(code);f.assertNoBusiness();
});

for(const state of ['used','expired','revoked'])test(`known ${state} code gives its fixed status only on the original callback`,async t=>{
 const f=await fixture(t),code=await f.seed({expired:state==='expired'});
 if(state==='used')await f.receive('initial-success',code);
 if(state==='revoked')await f.seed({replace:true});
 const before=f.replies().length,expected={used,expired,revoked}[state];
 await f.receive('old-'+state,'这是 '+code);
 assert.equal(f.replies().length,before+1);assert.equal(f.replies().at(-1).headers.req_id,'request-old-'+state);assert.equal(f.replies().at(-1).body.stream.content,expected);
 await f.receive('old-'+state,code);assert.equal(f.replies().length,before+1);
 f.protectControl(code);f.assertNoBusiness();
});

test('conflicting callback mapping gives a fixed failure, then the consumed code is revoked',async t=>{
 const f=await fixture(t),first=await f.seed(),second=await f.seed({userId:'second-member'});
 await f.receive('bind-first',first);await f.receive('conflict',second);await f.receive('conflict-reuse',second);
 assert.deepEqual(f.replies().map(reply=>reply.body.stream.content),[success,conflict,revoked]);
 assert.deepEqual(f.repository.byId(f.connection.id).wecomContactMappings.map(mapping=>[mapping.userId,mapping.callbackUserId]),[['selected-member','callback-member']]);
 f.protectControl(first);f.protectControl(second);f.assertNoBusiness();
});

for(const allowBusiness of [false,true])test(`unknown, multiple, word-only, group, quoted and mixed messages follow ordinary permission (allowed=${allowBusiness})`,async t=>{
 const f=await fixture(t,{allowBusiness}),code=await f.seed(),unknown=code==='654321'?'654322':'654321',cases=[
  {label:'unknown',text:unknown,patch:{}},
  {label:'unknown-context',text:'验证码给你 '+unknown,patch:{}},
  {label:'multiple',text:code+' 或者 '+unknown,patch:{}},
  {label:'repeated-candidate',text:code+' '+code,patch:{}},
  {label:'word-only',text:'验证码',patch:{}},
  {label:'seven-digits',text:code+'7',patch:{}},
  {label:'group',text:code,patch:{chattype:'group',chatid:'synthetic-group'}},
  {label:'quote-with-code',text:code,patch:{quote:{msgtype:'text',text:{content:'ordinary quoted text'}}}},
  {label:'quoted-code',text:'收到',patch:{quote:{msgtype:'text',text:{content:code}}}},
  {label:'quoted-voice-code',text:'收到',patch:{quote:{msgtype:'voice',voice:{content:code}}}},
  {label:'mixed-code',text:'',patch:{msgtype:'mixed',mixed:{msg_item:[{msgtype:'text',text:{content:code}}]}}},
 ];
 for(const [index,{label,text,patch}]of cases.entries()){
  await f.receive(label,text,patch);
  assert.equal(f.permissionChecks.length,index+1,label+' must reach ordinary permission');
  assert.equal(f.service.isVerificationEvent(f.connection.id,label,label),false,label+' must not reserve a verification marker');
  assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,allowBusiness?index+1:0);
 }
 assert.equal(f.repository.byId(f.connection.id).wecomContactMappings,undefined);assert.equal(f.replies().length,0,'ordinary replies are not verification responses');
 assert.equal(f.store.one("SELECT count(*) n FROM channel_message_receipts WHERE kind='inbox' AND status='rejected'").n,allowBusiness?0:cases.length);
 assert.equal(f.store.one("SELECT count(*) n FROM channel_inbox WHERE status<>'queued'").n,0,'allowed ordinary messages stay queued; no model runs in this fixture');
 assert.equal(f.frames.some(frame=>frame.cmd==='aibot_send_msg'),false);assert.deepEqual(f.errors,[]);
});

test('ordinary unknown numbers do not impose a cooldown or prevent immediate known-code verification',async t=>{
 const f=await fixture(t),code=await f.seed(),unknown=code==='654321'?'654322':'654321';
 for(let attempt=0;attempt<30;attempt++)await f.receive('ordinary-'+attempt,unknown);
 assert.equal(f.permissionChecks.length,30);assert.equal(f.replies().length,0);assert.equal(f.repository.byId(f.connection.id).wecomContactMappings,undefined);
 await f.receive('known-after-ordinary',code);
 assert.deepEqual(f.replies().map(reply=>reply.body.stream.content),[success]);assert.equal(f.permissionChecks.length,30);assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,0);
 assert.equal(f.store.one("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('wecom_member_verification_attempts','wecom_member_verification_notices')").n,0,'new fixtures have no attempt or notification budget');
});

for(const state of ['used','expired','revoked'])test(`${state} code stays control for three days, then a new message follows ordinary permissions`,async t=>{
 const f=await fixture(t),code=await f.seed();
 if(state==='used')await f.receive('initial-success',code);
 if(state==='revoked')await f.seed({replace:true});
 if(state==='expired')await f.advanceConnected(day);
 await f.advanceConnected(3*day-1);
 await f.receive('protected-old',code);
 assert.equal(f.replies().at(-1).body.stream.content,{used,expired,revoked}[state]);assert.equal(f.permissionChecks.length,0);f.protectControl(code);
 const count=f.replies().length;
 await f.advanceConnected(1);await f.receive('outside-window',code);
 assert.equal(f.permissionChecks.length,1);assert.equal(f.service.isVerificationEvent(f.connection.id,'outside-window','outside-window'),false);assert.equal(f.replies().length,count);
 assert.equal(f.store.one("SELECT count(*) n FROM channel_message_receipts WHERE kind='inbox' AND status='rejected'").n,1);assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,0);
 // The old event's durable reply marker outlives code retention: replay is still
 // suppressed, rather than treating the same callback as new ordinary work.
 await f.receive('protected-old',code);assert.equal(f.permissionChecks.length,1);assert.equal(f.replies().length,count);
});

test('unknown verification reply outcome is not retried on duplicate or a replacement SDK socket',async t=>{
 const f=await fixture(t,{sendAck:false}),code=await f.seed();
 f.sockets[0].send(JSON.stringify(f.incoming('uncertain',code)));await until(()=>f.replies().length===1);
 f.sockets[0].terminate();await until(()=>f.completed.includes('uncertain'));
 // A failed runner's ordinary reconnect backoff follows the fixture clock.
 f.advance(2_000);await f.supervisor.stop();await f.supervisor.start();await until(()=>f.supervisor.status(f.connection.id).state==='connected');
 await f.receive('uncertain',code);assert.equal(f.replies().length,1);assert.equal(f.replies()[0].body.stream.content,success);f.assertNoBusiness();
});

for(const revocation of ['owner','disabled','source','credential','generation'])test(`member reply rechecks ${revocation} after transport await before dispatch`,async t=>{
 const f=await fixture(t),code=await f.seed();let entered,release;
 const seen=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 f.hooks.beforeSend=async()=>{entered();await gate;};
 f.sockets[0].send(JSON.stringify(f.incoming('fenced',code)));await seen;
 if(revocation==='owner')f.advance(31_000);
 else if(revocation==='generation')await f.supervisor.stop();
 else {
  const current=f.repository.byId(f.connection.id),patch=revocation==='disabled'?{enabled:false,status:'disabled'}:revocation==='source'?{sourceId:'replacement-source'}:{authRevision:current.authRevision+1};
  assert.equal(f.repository.save({...current,...patch},current),true);
 }
 release();await until(()=>f.completed.includes('fenced'));
 assert.equal(f.replies().length,0);assert.equal(f.service.isVerificationEvent(f.connection.id,'fenced','fenced'),true);f.assertNoBusiness();
});
