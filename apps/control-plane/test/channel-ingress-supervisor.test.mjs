import {SqliteGroupContext} from '../dist/channel-loop/group-context.js';
import {DiscoveredGroups} from '../dist/channel-loop/discovered-groups.js';
import {fork} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {FileDiagnostics} from '../dist/adapters/diagnostics.js';
import {SdkIngress} from '../dist/adapters/channels/ingress/sdk-ingress.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {EmployeeChannelService} from '../dist/employee-channels/service.js';
import {SqliteMessageLoopRepository} from '../dist/channel-loop/repository.js';
import {ChannelIngressSupervisor} from '../dist/channel-loop/ingress-supervisor.js';
import {IngressOwner} from '../dist/channel-loop/ingress-owner.js';
import {ChannelMessageLoop} from '@dentity/application';
import {CapabilityConfigService} from '../dist/capability-config.js';
import {ingressFixture} from './helpers/ingress-fixture.mjs';

async function fixture(t,{pending=false,factory,appId='app',diagnostics,groupLifecycle=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'ingress-supervisor-')),store=new Store(join(dir,'isolated.sqlite'));let now=1800000000000;
 store.run("INSERT INTO users VALUES('u','user','Owner','active')");store.run("INSERT INTO workspaces VALUES('w','Workspace','u','active')");store.run("INSERT INTO members VALUES('m','w','u','owner','active')");store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin-interaction')");
 const repository=new EmployeeChannelRepository(store),service=new EmployeeChannelService(repository,{masterKey:new Uint8Array(32).fill(7),now:()=>now,adapterFactory:provider=>({provider,capabilities:{},async getUser(id){return{id,displayName:'Synthetic person',status:'active',departmentIds:[],departmentMembershipsKnown:true,primaryDepartmentId:{status:'unknown'},directManager:{status:'unknown'},dottedLineManagers:{status:'unknown'},aliases:[]};}}),verifyApplication:async(provider,appId)=>({identity:{appId,tenantId:pending?appId:'tenant',tenantIdNamespace:pending?(provider==='feishu'?'display_id':'app_id'):provider==='feishu'?'tenant_key':'corp_id'},...(provider==='feishu'||!pending?{botId:'bot'}:{}),...(!pending?{eventTenantId:'tenant'}:{}),directoryStatus:'available'})});
 const capabilities=new CapabilityConfigService(store,[],service);service.setAccessCheck((...args)=>capabilities.authorizeChannel(...args));
 const groupContext=groupLifecycle?new SqliteGroupContext(store):undefined,groups=groupLifecycle?new DiscoveredGroups(store):undefined;
 const inbox=new SqliteMessageLoopRepository(store),loop=new ChannelMessageLoop(inbox,service,{}, {},()=>now,diagnostics,groupContext),transport=ingressFixture(),supervisor=new ChannelIngressSupervisor(service,loop,factory??transport.factory,()=>now,diagnostics,groups);
 await supervisor.start();
 let closed=false;const closeStore=()=>{if(!closed){closed=true;store.close();}};
 t.after(async()=>{await supervisor.stop();groupContext?.close();closeStore();await rm(dir,{recursive:true,force:true});});
 const save=async(provider='feishu',expectedRevision=0)=>{const saved=await service.save('w','e',provider,'u',{appId,appSecret:'local-only-fixture',expectedRevision});capabilities.saveDirectoryAccess('w','e',{allow:[{sourceId:saved.sourceId,kind:'channel_user',subjectId:JSON.stringify(['channel_user',provider==='feishu'?'open_id':'user_id',appId,'person']),conversationKinds:['private','group']}],deny:[]});return saved;};
 const count=()=>store.one('SELECT count(*) n FROM channel_inbox').n;
 return{dir,store,closeStore,repository,service,loop,transport,supervisor,save,count,advance:ms=>now+=ms,now:()=>now};
}
function feishu(id='message',text='Hello',extra={}){return{schema:'2.0',header:{event_id:'event-'+id,event_type:'im.message.receive_v1',app_id:'app',tenant_key:'tenant'},event:{sender:{sender_id:{open_id:'person'},sender_type:'user',tenant_key:'tenant'},message:{message_id:id,chat_id:'chat',chat_type:'p2p',message_type:'text',create_time:'1800000000000',content:JSON.stringify({text}),mentions:[]}},...extra};}
function ding(id,text){return{type:'CALLBACK',headers:{topic:'/v1.0/im/bot/messages/get',messageId:'envelope-'+id},data:JSON.stringify({msgId:id,chatbotCorpId:'tenant',chatbotUserId:'bot',robotCode:'distinct-code',senderCorpId:'tenant',senderStaffId:'person',senderId:'opaque-person',conversationId:'chat',conversationType:'1',msgtype:'text',createAt:1800000000000,text:{content:text}})};}

test('saved connection starts local transport; success is observable only after durable commit, duplicate stays one row',async t=>{
 const f=await fixture(t),c=await f.save(),live=await f.transport.current(c.id);
 assert.equal(f.service.dto(f.repository.byId(c.id)).transport.state,'connected');assert.equal(c.callbackPath,undefined);
 assert.equal(await live.sink.onEvent(feishu()),'accepted');assert.equal(f.count(),1);
 assert.equal(await live.sink.onEvent(feishu()),'duplicate');assert.equal(f.count(),1);
 // Real SQLite error, not a mocked persistence return value.
 f.store.db.exec("CREATE TRIGGER reject_new_inbox BEFORE INSERT ON channel_inbox BEGIN SELECT RAISE(ABORT,'fixture_commit_failure'); END");
 await assert.rejects(live.sink.onEvent(feishu('write-failed')),/fixture_commit_failure/);assert.equal(f.count(),1);
});

test('disable and same-installation rotation immediately fence old sink and prevent duplicate business work',async t=>{
 const f=await fixture(t);let c=await f.save(),first=await f.transport.current(c.id);
 await first.sink.onEvent(feishu());c=await f.save('feishu',c.revision);const second=await f.transport.current(c.id);
 assert.notEqual(first.session.generation,second.session.generation);assert.equal(first.stopped,true);
 await assert.rejects(first.sink.onEvent(feishu('late-old')),/channel_ingress_generation_expired/);
 assert.equal(await second.sink.onEvent(feishu()),'duplicate');assert.equal(f.count(),1);
 f.service.settings('w','e','feishu','u',{enabled:false,expectedRevision:c.revision});
 await assert.rejects(second.sink.onEvent(feishu('late-disabled')),/channel_ingress_generation_expired/);
 assert.equal(f.service.dto(f.repository.byId(c.id)).transport.state,'stopped');
});

test('pending DingTalk ignores old challenge text and accepts an ordinary first authenticated message',async t=>{
 const f=await fixture(t,{pending:true}),c=await f.save('dingtalk'),live=await f.transport.current(c.id);
 assert.equal(await live.sink.onEvent(ding('old','identity-verify-00000000-0000-0000-0000-000000000000')),'ignored');
 assert.equal(f.count(),0);
 assert.equal(await live.sink.onEvent(ding('ordinary','ordinary')),'accepted');assert.equal(f.count(),1);
 assert.equal(await live.sink.onEvent(ding('ordinary','ordinary')),'duplicate');assert.equal(f.count(),1);
 assert.equal(f.repository.byId(c.id).robotCode,'distinct-code');
});

test('generation is rechecked after async capability work, not only when a frame arrives',async t=>{
 const f=await fixture(t),c=await f.save(),live=await f.transport.current(c.id),original=f.service.resolveBinding.bind(f.service);let release,entered;
 const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r);
 f.service.resolveBinding=async id=>{const b=await original(id);const inspect=b.conversation.inspectCapabilities.bind(b.conversation);b.conversation.inspectCapabilities=async(...args)=>{entered();await gate;return inspect(...args);};return b;};
 const receipt=live.sink.onEvent(feishu());await seen;f.service.settings('w','e','feishu','u',{enabled:false,expectedRevision:c.revision});release();
 await assert.rejects(receipt,/channel_ingress_generation_expired/);assert.equal(f.count(),0);
});

test('two database owners cannot run together; crashed lease expires and old incarnation cannot commit or renew',async t=>{
 const f=await fixture(t),other=new Store(join(f.dir,'isolated.sqlite'));t.after(()=>other.close());
 const contender=new IngressOwner(other,f.now);
 assert.throws(()=>contender.acquire(),/channel_ingress_owner_busy/);
 const c=await f.save(),old=await f.transport.current(c.id);f.advance(31_000);contender.acquire();
 await assert.rejects(old.sink.onEvent(feishu()),/channel_ingress_owner_lost/);assert.equal(f.count(),0);
 contender.commit(()=>other.run("INSERT INTO employee_channel_audit(workspace_id,entity_id,connection_id,actor_id,action,revision,created_at) VALUES('w','e',?,'test','new_owner',1,?)",c.id,f.now()));
 contender.release();
});

test('shutdown prevents late SDK status and messages; enabled persisted connection restores on next supervisor',async t=>{
 const f=await fixture(t),c=await f.save(),old=await f.transport.current(c.id);await f.supervisor.stop();
 old.sink.onStatus({state:'connected',changedAt:f.now()});assert.equal(f.supervisor.status(c.id).state,'stopped');
 await assert.rejects(old.sink.onEvent(feishu()),/channel_ingress_owner_lost/);
 const resumed=new ChannelIngressSupervisor(f.service,f.loop,f.transport.factory,f.now);t.after(()=>resumed.stop());await resumed.start();const live=await f.transport.current(c.id);assert.notEqual(live.session.generation,old.session.generation);assert.equal(await live.sink.onEvent(feishu()),'accepted');
 await resumed.stop();
});

test('SDK failure stops the old runner before bounded retry; successful reconnect clears transport errors',async t=>{
 const f=await fixture(t);let c=await f.save(),old=await f.transport.current(c.id);
 old.sink.onStatus({state:'failed',changedAt:f.now(),error:'channel_transport_failed'});
 await f.supervisor.tick();assert.equal(old.stopped,true);assert.equal(f.transport.all.length,1);
 await assert.rejects(old.sink.onEvent(feishu()),/channel_ingress_generation_expired/);
 f.advance(2000);await f.supervisor.tick();const resumed=await f.transport.current(c.id);assert.notEqual(old.session.generation,resumed.session.generation);assert.equal(f.supervisor.status(c.id).error,undefined);
 resumed.sink.onStatus({state:'failed',changedAt:f.now(),error:'ingress_connect_failed'});await f.supervisor.tick();f.advance(10_000);await f.supervisor.tick();assert.equal(f.transport.all.length,3);
 c=await f.save('feishu',c.revision);await f.transport.current(c.id);assert.equal(f.transport.all.length,4);
});


for(const provider of ['feishu','dingtalk']) {
 test(`${provider}: official SDK structured auth failure crosses child IPC and pauses supervisor until administrator revalidation`,async t=>{
  const ports=[];
  const factory=(session,credentials)=>{const port=new SdkIngress(session,credentials,{stopTimeoutMs:200,forkRunner:()=>fork(new URL('./fixtures/local-sdk-ingress-runner.mjs',import.meta.url),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc'],env:{TEST_LOCAL_WS:'ws://127.0.0.1:1',TEST_AUTH_CODE:provider==='feishu'?'514':'401'}})});ports.push(port);return port;};
  const f=await fixture(t,{factory,appId:'cli_1234567890abcdef'});let c=await f.save(provider);
  const until=async condition=>{const deadline=Date.now()+8000;while(!condition()){if(Date.now()>deadline)assert.fail('Real SDK auth status did not reach supervisor');await delay(20);}};
  await until(()=>f.supervisor.status(c.id).error==='channel_authentication_failed');
  await f.supervisor.tick();assert.equal(ports[0].status().state,'stopped');
  for(let n=0;n<3;n++){f.advance(20_000);await f.supervisor.tick();}
  assert.equal(ports.length,1,'Structured provider auth error must not retry merely because time elapsed');assert.equal(f.count(),0);
  c=f.service.settings('w','e',provider,'u',{enabled:true,expectedRevision:c.revision});await f.supervisor.tick();assert.equal(ports.length,1,'Unrelated settings revision must not bypass authentication pause');
  c=await f.service.revalidate('w','e',provider,'u',c.revision);
  await until(()=>ports.length===2&&f.supervisor.status(c.id).error==='channel_authentication_failed');
  assert.equal(f.count(),0);assert.ok(c.authRevision>1);
 });
}

test('shared database standby does not create a second SDK; owner release permits safe takeover',async t=>{
 const f=await fixture(t),c=await f.save(),first=await f.transport.current(c.id);
 const secondStore=new Store(join(f.dir,'isolated.sqlite'));
 const secondService=new EmployeeChannelService(new EmployeeChannelRepository(secondStore),{masterKey:new Uint8Array(32).fill(7),now:f.now});
 const secondLoop=new ChannelMessageLoop(new SqliteMessageLoopRepository(secondStore),secondService,{}, {},f.now);
 const secondTransport=ingressFixture(),second=new ChannelIngressSupervisor(secondService,secondLoop,secondTransport.factory,f.now);
 t.after(async()=>{await second.stop();secondStore.close();});
 await second.start();assert.equal(secondTransport.all.length,0);assert.equal(second.status(c.id).error,'channel_ingress_standby');
 await second.tick();assert.equal(secondTransport.all.length,0);assert.equal(await first.sink.onEvent(feishu()),'accepted');
 await f.supervisor.stop();await second.tick();const takeover=await secondTransport.current(c.id);
 assert.notEqual(takeover.session.generation,first.session.generation);assert.equal(first.stopped,true);
 assert.equal(await takeover.sink.onEvent(feishu()),'duplicate');assert.equal(f.count(),1);
 await assert.rejects(first.sink.onEvent(feishu('old-owner')),/channel_ingress_owner_lost/);
 await second.stop();
});


test('shutdown waits for the lease-loss tick already draining an SDK before SQLite can close',async t=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),stopping=new Promise(resolve=>entered=resolve);let sink,stops=0;
 const factory=()=>({async start(_session,value){sink=value;value.onStatus({state:'connected',changedAt:Date.now()});},async stop(){stops++;entered();await gate;},status(){return{state:'connected',changedAt:Date.now()};}});
 const f=await fixture(t,{factory}),c=await f.save();await f.supervisor.tick();
 f.advance(31_000);const lost=f.supervisor.tick();await stopping;
 let closed=false;const closing=f.supervisor.stop().then(()=>{f.closeStore();closed=true;});
 await delay(30);assert.equal(closed,false,'stop must wait for the runner already owned by in-flight lease-loss tick');
 await assert.rejects(sink.onEvent(feishu()),/channel_ingress_owner_lost|channel_ingress_generation_expired/);
 release();await Promise.all([lost,closing]);assert.equal(stops,1);assert.equal(closed,true);
 await f.supervisor.stop();assert.equal(c.status,'verified');
});

test('SDK boundary logs full incoming text before failed identity parsing and queues one fixed original-target reply',async t=>{
 const root=await mkdtemp(join(tmpdir(),'identity-ingress-text-')),diagnostics=new FileDiagnostics(join(root,'logs'));t.after(async()=>{await diagnostics.close();await rm(root,{recursive:true,force:true});});
 const f=await fixture(t,{diagnostics}),c=await f.save(),live=await f.transport.current(c.id),raw=feishu('identity-invalid','@_user_1 你好\n完整原文');delete raw.event.sender.sender_id.open_id;raw.header.token='SYNTHETIC_RECEIVE_TOKEN';raw.event.message.mentions=[{key:'@_user_1',id:{open_id:'bot'},name:'机器人A'}];raw.extra={kept:[false,null,{custom:'all fields'}],secret:'SYNTHETIC_RECEIVE_SECRET'};
 await assert.rejects(live.sink.onEvent(raw),{code:'unauthenticated'});await assert.rejects(live.sink.onEvent(raw),{code:'unauthenticated'});
 const deliveries=f.store.all('SELECT text,target_json,scope_json FROM channel_deliveries');assert.equal(deliveries.length,1);assert.equal(deliveries[0].text,'抱歉，无法验证身份');assert.equal(JSON.parse(deliveries[0].target_json).conversation.externalId,'chat');assert.equal(JSON.parse(deliveries[0].scope_json).kind,'channel_quick_reply');assert.equal(f.count(),0);
 await diagnostics.flush();const logs=[];for(const n of await readdir(diagnostics.root))logs.push(...(await readFile(join(diagnostics.root,n),'utf8')).trim().split('\n').map(JSON.parse));
 assert.equal(logs[0].stage,'ingress.received');assert.equal(logs[0].text,'@_user_1 你好\n完整原文');assert.equal(logs[0].json.header.token,'***');assert.equal(logs[0].json.extra.secret,'***');assert.deepEqual(logs[0].json.extra.kept,[false,null,{custom:'all fields'}]);assert.equal(logs[0].json.event.message.mentions[0].name,'机器人A');assert.equal(raw.header.token,'SYNTHETIC_RECEIVE_TOKEN');assert.ok(!JSON.stringify(logs).includes('SYNTHETIC_RECEIVE_TOKEN'));assert.ok(logs.some(r=>r.reason==='identity_invalid'));assert.equal(logs.filter(r=>r.stage==='reply.generated').length,1);assert.equal(logs.find(r=>r.stage==='reply.generated').traceId,logs[0].traceId);assert.ok(!JSON.stringify(logs).includes('local-only-fixture'));
});
test('malformed content replies to verified original route; foreign installation and pending verification cannot send errors',async t=>{
 const f=await fixture(t),c=await f.save(),live=await f.transport.current(c.id),bad=feishu('malformed');bad.event.message.content='{invalid json';
 await assert.rejects(live.sink.onEvent(bad));assert.equal(f.store.one('SELECT text FROM channel_deliveries').text,'抱歉，无法验证身份');
 const foreign=feishu('foreign');foreign.header.tenant_key='other';await assert.rejects(live.sink.onEvent(foreign));assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,1);
 const pending=await fixture(t,{pending:true}),p=await pending.save(),plive=await pending.transport.current(p.id),raw=feishu('pending');raw.event.message.content='{invalid json';await assert.rejects(plive.sink.onEvent(raw));assert.equal(pending.store.one('SELECT count(*) n FROM channel_deliveries').n,0);
});

test('formal ingress recovers a left Feishu group after persisted verification retry and admits the original message once',async t=>{
 const f=await fixture(t,{groupLifecycle:true}),c=await f.save(),live=await f.transport.current(c.id);let answer=false,queries=0;const resolve=f.service.resolveBinding.bind(f.service);f.service.resolveBinding=async id=>{const b=await resolve(id);if(b)b.conversation.isBotInGroup=async()=>{queries++;if(answer instanceof Error)throw answer;return answer;};return b;};
 const lifecycle=(id,present)=>({schema:'2.0',header:{event_id:id,event_type:present?'im.chat.member.bot.added_v1':'im.chat.member.bot.deleted_v1',app_id:'app',tenant_key:'tenant',create_time:String(f.now())},event:{chat_id:'chat',name:'Synthetic group'}});
 await live.sink.onEvent(lifecycle('leave',false));assert.equal(f.store.one('SELECT present FROM group_live_membership').present,0);
 f.advance(10);const incoming=feishu('recovered');incoming.event.message.chat_type='group';incoming.event.message.create_time=String(f.now());incoming.event.message.mentions=[{id:{open_id:'bot'}}];answer=Error('synthetic unavailable');
 await live.sink.onEvent(incoming);assert.equal(f.count(),0);assert.equal(f.store.one("SELECT count(*) n FROM feishu_group_evidence WHERE status='pending'").n,1);
 answer=true;f.advance(30000);await f.supervisor.tick();assert.equal(f.count(),1);assert.equal(f.store.one('SELECT present FROM group_live_membership').present,1);assert.equal(f.store.one('SELECT count(*) n FROM group_live_messages').n,1);assert.equal(f.store.one('SELECT available FROM channel_discovered_groups').available,1);
 const before=queries,reconnected=await f.transport.current(c.id);await reconnected.sink.onEvent(incoming);assert.equal(f.count(),1);assert.equal(queries,before);
});

for(const kind of ['private','group'])test(`Feishu pending ${kind} first message fills only tenant and is admitted once on the same runner`,async t=>{
 const f=await fixture(t,{pending:true,groupLifecycle:true}),c=await f.save(),live=await f.transport.current(c.id),before=f.repository.byId(c.id);
 const policy=f.store.one('SELECT * FROM entity_directory_policies WHERE entity_id=?','e');
 const raw=feishu('first-'+kind);raw.event.message.chat_type=kind==='group'?'group':'p2p';raw.event.message.mentions=kind==='group'?[{id:{open_id:'bot'}}]:[];
 // A genuine provider redelivery is still live; this change does not add an age cutoff.
 raw.event.message.create_time='1000';
 const results=await Promise.all([live.sink.onEvent(raw),live.sink.onEvent(raw)]);
 assert.deepEqual(results.sort(),['accepted','duplicate']);assert.equal(f.count(),1);
 const after=f.repository.byId(c.id);assert.equal(after.status,'verified');assert.equal(after.botId,'bot');assert.equal(after.eventTenantId,'tenant');assert.equal(after.inboundVerified,true);assert.equal(after.identityEvidence,'authenticated_first_message');
 assert.equal(after.stateVersion,before.stateVersion+1);assert.equal(after.revision,before.revision);assert.equal(after.authRevision,before.authRevision);assert.deepEqual(after.credential,before.credential);assert.deepEqual(after.identity,before.identity);assert.equal(after.sourceId,before.sourceId);assert.deepEqual(after.context,before.context);
 assert.deepEqual(f.store.one('SELECT * FROM entity_directory_policies WHERE entity_id=?','e'),policy);assert.equal(f.service.isVerificationEvent(c.id,raw.header.event_id,raw.event.message.message_id),false);
 await f.supervisor.tick();assert.equal((await f.transport.current(c.id)).session.generation,live.session.generation);assert.equal(f.transport.all.length,1);assert.equal(live.stopped,false);
});

test('Feishu first unapproved sender confirms installation without authorizing them or creating work',async t=>{
 const f=await fixture(t,{pending:true}),c=await f.save(),live=await f.transport.current(c.id),policy=f.store.one('SELECT * FROM entity_directory_policies WHERE entity_id=?','e');
 const raw=feishu('unapproved');raw.event.sender.sender_id.open_id='stranger';assert.equal(await live.sink.onEvent(raw),'accepted');
 assert.equal(f.repository.byId(c.id).inboundVerified,true);assert.equal(f.count(),0);assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,0);assert.deepEqual(f.store.one('SELECT * FROM entity_directory_policies WHERE entity_id=?','e'),policy);
 assert.equal(await live.sink.onEvent(feishu('approved')),'accepted');assert.equal(f.count(),1);
});

test('Feishu pending ignores ordinary groups, fake mentions, bots, lifecycle events and old challenges',async t=>{
 const f=await fixture(t,{pending:true,groupLifecycle:true}),c=await f.save(),live=await f.transport.current(c.id);
 const old=f.repository.byId(c.id),challengeText='identity-verify-00000000-0000-0000-0000-000000000000';
 f.repository.save({...old,verification:{challengeId:'legacy',challengeText:'legacy-custom-challenge',expiresAt:1}},old);
 f.repository.markVerificationEvent(c.id,'recorded-event','recorded-message');const before=f.repository.byId(c.id);
 const events=[];
 for(const mode of ['plain','text-mention','other-bot','bot','self']){const raw=feishu(mode,mode==='text-mention'?'@bot ordinary':'ordinary');if(['plain','text-mention','other-bot'].includes(mode))raw.event.message.chat_type='group';if(mode==='other-bot')raw.event.message.mentions=[{id:{open_id:'other-bot'}}];if(mode==='bot')raw.event.sender.sender_type='app';if(mode==='self')raw.event.sender.sender_id.open_id='bot';events.push(raw);}
 events.push(feishu('expired-challenge',challengeText),feishu('legacy-challenge','legacy-custom-challenge'));
 const recorded=feishu('recorded-message','ordinary');recorded.header.event_id='new-envelope';events.push(recorded);
 events.push({schema:'2.0',header:{event_id:'membership',event_type:'im.chat.member.bot.added_v1',app_id:'app',tenant_key:'tenant',create_time:String(f.now())},event:{chat_id:'chat'}});
 for(const raw of events)await live.sink.onEvent(raw);
 assert.deepEqual(f.repository.byId(c.id),before);assert.equal(f.count(),0);assert.equal(f.store.one('SELECT count(*) n FROM feishu_group_evidence').n,0);assert.equal(f.store.one('SELECT count(*) n FROM group_live_membership').n,0);
 assert.equal(await live.sink.onEvent(feishu('ordinary-after-legacy')),'accepted');assert.equal(f.count(),1);
 const ready=f.repository.byId(c.id);assert.equal(ready.verification,undefined);assert.equal(await live.sink.onEvent(feishu('challenge-after-ready',challengeText)),'ignored');assert.equal(await live.sink.onEvent(recorded),'duplicate');assert.equal(f.count(),1);
});

test('Feishu pending missing identities, header overrides and foreign senders cannot establish evidence',async t=>{
 const f=await fixture(t,{pending:true}),c=await f.save(),live=await f.transport.current(c.id),before=f.repository.byId(c.id);
 for(const mutate of [r=>r.header.app_id='foreign',r=>r.event.app_id='foreign',r=>r.event.tenant_key='forged',r=>r.event.sender.tenant_key='foreign',r=>delete r.header.tenant_key,r=>delete r.event.sender.sender_id.open_id,r=>r.event.sender.sender_type='system']){
  const raw=feishu();mutate(raw);await assert.rejects(live.sink.onEvent(raw));assert.deepEqual(f.repository.byId(c.id),before);
 }
 const {botId:_,...missing}=before;f.repository.save(missing,before);const withoutBot=f.repository.byId(c.id),raw=feishu('mentions-never-supply-bot');raw.event.message.mentions=[{id:{open_id:'bot'}}];
 assert.equal(await live.sink.onEvent(raw),'ignored');assert.deepEqual(f.repository.byId(c.id),withoutBot);assert.equal(f.count(),0);
});

for(const conflict of ['directory-tenant','previous-tenant','previous-bot'])test(`Feishu first inbound rejects ${conflict} without replacing source or policy`,async t=>{
 const f=await fixture(t,{pending:true}),c=await f.save(),live=await f.transport.current(c.id),old=f.repository.byId(c.id);
 const next=conflict==='directory-tenant'?{...old,identity:{appId:'app',tenantId:'other',tenantIdNamespace:'tenant_key'}}:{...old,previousInstallation:{botId:conflict==='previous-bot'?'other':'bot',tenantId:conflict==='previous-tenant'?'other':'tenant'}};
 f.repository.save(next,old);const before=f.repository.byId(c.id);await assert.rejects(live.sink.onEvent(feishu()),/channel_verification_identity_conflict/);assert.deepEqual(f.repository.byId(c.id),before);assert.equal(f.count(),0);
});

test('Feishu first inbound atomic persistence failure never admits work and replay recovers once',async t=>{
 const f=await fixture(t,{pending:true}),c=await f.save(),live=await f.transport.current(c.id),before=f.repository.byId(c.id);
 f.store.db.exec("CREATE TRIGGER reject_first_identity BEFORE INSERT ON employee_channel_audit WHEN NEW.action='first_inbound_confirmed' BEGIN SELECT RAISE(ABORT,'first_identity_failed'); END");
 await assert.rejects(live.sink.onEvent(feishu()),/first_identity_failed/);assert.deepEqual(f.repository.byId(c.id),before);assert.equal(f.count(),0);
 f.store.db.exec('DROP TRIGGER reject_first_identity');assert.equal(await live.sink.onEvent(feishu()),'accepted');assert.equal(await live.sink.onEvent(feishu()),'duplicate');assert.equal(f.count(),1);
 assert.equal(f.repository.save({...before,lastError:'stale-write'},before),false,'old stateVersion cannot overwrite committed observation');assert.equal(f.repository.byId(c.id).lastError,null);
});

test('Feishu first group message rechecks left membership before admitting the same event',async t=>{
 const f=await fixture(t,{pending:true,groupLifecycle:true}),c=await f.save(),live=await f.transport.current(c.id);let answer=Error('temporary membership failure'),queries=0;
 const resolve=f.service.resolveBinding.bind(f.service);f.service.resolveBinding=async id=>{const b=await resolve(id);if(b)b.conversation.isBotInGroup=async()=>{queries++;if(answer instanceof Error)throw answer;return answer;};return b;};
 f.loop.membership(c.id,'chat',false,f.now()-1);
 const raw=feishu('first-group-recovery');raw.event.message.chat_type='group';raw.event.message.mentions=[{id:{open_id:'bot'}}];
 assert.equal(await live.sink.onEvent(raw),'accepted');assert.equal(f.repository.byId(c.id).status,'verified');assert.equal(f.count(),0);assert.equal(queries,1);assert.equal(f.store.one("SELECT count(*) n FROM feishu_group_evidence WHERE status='pending'").n,1);
 answer=true;f.advance(15_000);await f.supervisor.tick();f.advance(15_000);await f.supervisor.tick();assert.equal(f.count(),1);assert.equal(queries,2);assert.equal(f.store.one('SELECT present FROM group_live_membership').present,1);assert.equal(f.transport.all.length,1);
 assert.equal(await live.sink.onEvent(raw),'duplicate');assert.equal(f.count(),1);
});

test('Feishu first group observation cannot bypass a persisted disbanded tombstone',async t=>{
 const f=await fixture(t,{pending:true,groupLifecycle:true}),c=await f.save(),live=await f.transport.current(c.id),old=f.repository.byId(c.id);
 // Logical binding is stable across same-installation revalidation; retain its terminal group evidence.
 const {createHash}=await import('node:crypto');const binding=createHash('sha256').update(JSON.stringify([old.sourceId,'feishu','app','bot','tenant'])).digest('hex');
 f.store.run('INSERT INTO feishu_group_disbanded VALUES(?,?,?)',c.id,binding,'chat');
 const raw=feishu('first-after-disband');raw.event.message.chat_type='group';raw.event.message.mentions=[{id:{open_id:'bot'}}];assert.equal(await live.sink.onEvent(raw),'ignored');assert.equal(f.repository.byId(c.id).status,'verified');assert.equal(f.count(),0);assert.equal(f.store.one('SELECT reason FROM feishu_group_evidence').reason,'group_disbanded');
});

for(const type of ['post','image','file','video_chat'])test(`Feishu first ${type} keeps the existing supported message types`,async t=>{
 const f=await fixture(t,{pending:true}),c=await f.save(),live=await f.transport.current(c.id),raw=feishu(type);
 const contents={post:{title:'',content:[[{tag:'text',text:'Hello'}]]},image:{image_key:'fixture-image'},file:{file_key:'fixture-file',file_name:'fixture.txt'},video_chat:{topic:'Fixture meeting',meet_number:'123',start_time:'100',end_time:'200'}};
 raw.event.message.message_type=type;raw.event.message.content=JSON.stringify(contents[type]);await live.sink.onEvent(raw);assert.equal(f.repository.byId(c.id).status,'verified');assert.equal(f.repository.byId(c.id).inboundVerified,true);assert.equal(f.count(),1);
});

test('Feishu API-complete verified connection does not degrade or acquire unrelated observation writes',async t=>{
 const f=await fixture(t),c=await f.save(),live=await f.transport.current(c.id),before=f.repository.byId(c.id);assert.equal(before.inboundVerified,false);
 assert.equal(await live.sink.onEvent(feishu()),'accepted');assert.deepEqual(f.repository.byId(c.id),before);assert.equal(f.count(),1);
});

test('Feishu pending rotation, disable and owner loss fence first-message observation',async t=>{
 const f=await fixture(t,{pending:true});let c=await f.save(),old=await f.transport.current(c.id);c=await f.save('feishu',c.revision);const current=await f.transport.current(c.id),before=f.repository.byId(c.id);
 await assert.rejects(old.sink.onEvent(feishu('old-credentials')),/channel_ingress_generation_expired/);assert.deepEqual(f.repository.byId(c.id),before);
 f.service.settings('w','e','feishu','u',{enabled:false,expectedRevision:c.revision});await assert.rejects(current.sink.onEvent(feishu('disabled')),/channel_ingress_generation_expired/);assert.equal(f.repository.byId(c.id).status,'disabled');assert.equal(f.count(),0);
 const lost=await fixture(t,{pending:true}),lc=await lost.save(),ll=await lost.transport.current(lc.id),record=lost.repository.byId(lc.id);lost.advance(31_000);
 const contender=new IngressOwner(lost.store,lost.now);contender.acquire();try{await assert.rejects(ll.sink.onEvent(feishu('lost-owner')),/channel_ingress_owner_lost/);assert.deepEqual(lost.repository.byId(lc.id),record);assert.equal(lost.count(),0);}finally{contender.release();}
});

test('Feishu pending reconnect accepts first message only on replacement runner and keeps established evidence',async t=>{
 const f=await fixture(t,{pending:true}),c=await f.save(),old=await f.transport.current(c.id);old.sink.onStatus({state:'failed',changedAt:f.now(),error:'channel_transport_failed'});await f.supervisor.tick();f.advance(2000);await f.supervisor.tick();const current=await f.transport.current(c.id);
 await assert.rejects(old.sink.onEvent(feishu('old-connection')),/channel_ingress_generation_expired/);assert.equal(f.repository.byId(c.id).status,'pending_verification');assert.equal(await current.sink.onEvent(feishu()),'accepted');const verified=f.repository.byId(c.id);
 current.sink.onStatus({state:'failed',changedAt:f.now(),error:'channel_transport_failed'});await f.supervisor.tick();f.advance(2000);await f.supervisor.tick();const next=await f.transport.current(c.id);assert.deepEqual(f.repository.byId(c.id),verified);assert.equal(await next.sink.onEvent(feishu()),'duplicate');assert.equal(f.count(),1);
});

test('DingTalk identity rejection persists safe field diagnostics without logging raw IDs, text or callback secrets',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dingtalk-safe-ingress-')),diagnostics=new FileDiagnostics(join(root,'logs'));t.after(async()=>{await diagnostics.close();await rm(root,{recursive:true,force:true});});
 const f=await fixture(t,{diagnostics}),c=await f.save('dingtalk'),live=await f.transport.current(c.id);
 for(const group of [true,false]){
  const raw=ding('PRIVATE_MESSAGE_SENTINEL_'+group,'PRIVATE_TEXT_SENTINEL');const data=JSON.parse(raw.data);
  Object.assign(data,{chatbotUserId:'PRIVATE_BOT_SENTINEL',appId:'PRIVATE_WRONG_APP_SENTINEL',senderStaffId:'PRIVATE_SENDER_SENTINEL',senderId:'PRIVATE_OPAQUE_SENTINEL',conversationId:'PRIVATE_CHAT_SENTINEL',conversationType:group?'2':'1',isInAtList:group,sessionWebhook:'https://private.invalid/PRIVATE_WEBHOOK_SENTINEL',accessToken:'PRIVATE_TOKEN_SENTINEL'});raw.data=JSON.stringify(data);
  await assert.rejects(live.sink.onEvent(raw),/ingress_app_mismatch/);
 }
 await diagnostics.flush();const logs=[];for(const file of await readdir(diagnostics.root))logs.push(...(await readFile(join(diagnostics.root,file),'utf8')).trim().split('\n').map(JSON.parse));
 const failures=logs.filter(log=>log.stage==='ingress.received'&&log.reason==='identity_invalid');assert.equal(failures.length,2);
 for(const [index,failed] of failures.entries()){
  assert.equal(failed.ingressIdentity.channel,'dingtalk');assert.equal(failed.ingressIdentity.error,'ingress_app_mismatch');assert.equal(failed.ingressIdentity.conversationKind,index===0?'group':'private');assert.equal(failed.ingressIdentity.mentioned,index===0?'yes':'no');assert.equal(failed.ingressIdentity.fields.chatbotUserId,'present');assert.equal(failed.ingressIdentity.fields.chatbotCorpId,'match');assert.equal(failed.ingressIdentity.fields.senderStaffId,'present');assert.equal(failed.ingressIdentity.fields.appId,'mismatch');
 }
 assert.ok(logs.filter(log=>log.stage==='ingress.received').every(log=>log.text===undefined&&log.json===undefined));assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));assert.equal(f.count(),0);assert.equal(f.repository.byId(c.id).status,'pending_verification');
});

test('Feishu concurrent first events cannot race a conflicting tenant into the pinned binding',async t=>{
 const f=await fixture(t,{pending:true}),c=await f.save(),live=await f.transport.current(c.id),foreign=feishu('foreign-first');foreign.header.tenant_key='foreign';foreign.event.sender.tenant_key='foreign';
 const outcomes=await Promise.allSettled([live.sink.onEvent(feishu('valid-first')),live.sink.onEvent(foreign)]);assert.equal(outcomes[0].status,'fulfilled');assert.equal(outcomes[0].value,'accepted');assert.equal(outcomes[1].status,'rejected');assert.match(outcomes[1].reason.message,/ingress_tenant_mismatch/);assert.equal(f.repository.byId(c.id).eventTenantId,'tenant');assert.equal(f.count(),1);
});

test('Feishu first observation does not bypass generation revocation during asynchronous admission',async t=>{
 const f=await fixture(t,{pending:true}),c=await f.save(),live=await f.transport.current(c.id),original=f.service.resolveBinding.bind(f.service);let release,entered;const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r);
 f.service.resolveBinding=async id=>{const b=await original(id);const inspect=b.conversation.inspectCapabilities.bind(b.conversation);b.conversation.inspectCapabilities=async(...args)=>{entered();await gate;return inspect(...args);};return b;};
 const receipt=live.sink.onEvent(feishu());await seen;assert.equal(f.repository.byId(c.id).status,'verified');f.service.settings('w','e','feishu','u',{enabled:false,expectedRevision:c.revision});release();await assert.rejects(receipt,/channel_ingress_generation_expired/);assert.equal(f.count(),0);assert.equal(f.repository.byId(c.id).status,'disabled');
});
