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
import {SqliteMessageLoopRepository} from '../dist/channel-loop/repository.js';
import {ChannelIngressSupervisor} from '../dist/channel-loop/ingress-supervisor.js';
import {SdkIngress} from '../dist/adapters/channels/ingress/sdk-ingress.js';
import {ChannelMessageLoop} from '@dentity/application';
async function until(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('condition timed out');await delay(10);}}
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wecom-supervisor-')),store=new Store(join(dir,'test.sqlite'));let now=1800000000000;
 store.run("INSERT INTO users VALUES('u','user','Owner','active')");store.run("INSERT INTO workspaces VALUES('w','Workspace','u','active')");store.run("INSERT INTO members VALUES('m','w','u','owner','active')");store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin-interaction')");
 const repository=new EmployeeChannelRepository(store),service=new EmployeeChannelService(repository,{masterKey:new Uint8Array(32).fill(9),now:()=>now});
 const c=await service.save('w','e','wecom','u',{appId:'bot-local',appSecret:'local-only-secret'});
 // Isolated persisted configuration fixture, not a claim of live directory verification.
 store.run("INSERT INTO employee_channel_directory_credentials VALUES('directory','w','wecom','corp-local','agent-local',1,'{}')");
 const old=repository.byId(c.id);repository.save({...old,status:'verified',directoryStatus:'available',eventTenantId:'corp-local',inboundVerified:true,identityEvidence:'admin_asserted',directoryBinding:{credentialId:'directory',corpId:'corp-local',agentId:'agent-local',sourceRevision:1,credentialRevision:1,scopeRevision:'scope-local',status:'confirmed',assertion:{evidence:'admin_asserted',actorId:'u',confirmedAt:now,botId:'bot-local',corpId:'corp-local',credentialRevision:1}}},old);
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const sockets=[],frames=[];
 server.on('connection',socket=>{sockets.push(socket);socket.on('message',data=>{const frame=JSON.parse(data.toString());frames.push(frame);socket.send(JSON.stringify({headers:frame.headers,errcode:0}));});});
 const loop=new ChannelMessageLoop(new SqliteMessageLoopRepository(store),service,{}, {},()=>now);
 const factory=(session,credentials)=>new SdkIngress(session,credentials,{forkRunner:()=>fork(new URL('./fixtures/local-wecom-sdk-runner.mjs',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[],env:{TEST_LOCAL_WS:`ws://127.0.0.1:${server.address().port}`}})});
 const supervisor=new ChannelIngressSupervisor(service,loop,factory,()=>now);await supervisor.start();
 t.after(async()=>{await supervisor.stop();for(const socket of sockets)socket.terminate();await new Promise(resolve=>server.close(resolve));store.close();await rm(dir,{recursive:true,force:true});});
 await until(()=>supervisor.status(c.id).state==='connected');
 const request={conversation:{provider:'wecom',connectionId:c.id,tenantId:'corp-local',kind:'conversation',externalId:'employee-local',privateRecipientId:'employee-local',conversationKind:'private'},text:'fixture only',operationId:'op-local'};
 return {c,repository,service,supervisor,sockets,frames,request,advance:ms=>now+=ms};
}
test('real SDK supervisor sends only current authenticated directory binding, then fences revoked await',async t=>{
 const f=await fixture(t);assert.equal(f.supervisor.canDispatch(f.c.id),true);
 assert.equal((await f.supervisor.send(f.c.id,f.request)).status,'accepted');
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
