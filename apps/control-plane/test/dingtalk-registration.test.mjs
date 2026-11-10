import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../dist/store.js';
import {registerHttpSecurity} from '../dist/http/security.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {EmployeeChannelService,EmployeeChannelError} from '../dist/employee-channels/service.js';
import {DingTalkRegistrations} from '../dist/employee-channels/dingtalk-registration.js';
import {DingTalkRegistrationAdapter,registrationVerificationUrl} from '../dist/employee-channels/dingtalk-registration-adapter.js';
import {registerDingTalkRegistrationRoutes} from '../dist/employee-channels/dingtalk-registration-routes.js';

// Approved synthetic transport and application-verification fixtures only. Never use global fetch.
const nonce='SENTINEL_NONCE',device='SENTINEL_DEVICE',secret='SENTINEL_SECRET';
const scope={workspaceId:'w',entityId:'e',actorId:'u'};
const base='/api/workspaces/w/entities/e/channels/dingtalk/registration';
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function setup(t,config={}){
 const dir=await mkdtemp(join(tmpdir(),'ding-registration-')),store=new Store(join(dir,'test.sqlite'));
 store.run("INSERT INTO users VALUES('u','owner','Owner','active')");
 store.run("INSERT INTO workspaces VALUES('w','Fixture','u','active')");
 store.run("INSERT INTO members(id,workspace_id,user_id,role,status) VALUES('m','w','u','owner','active')");
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin-interaction')");
 let now=1800000000000;
 const state={calls:[],logs:[],poll:{errcode:0,status:'SUCCESS',client_id:'synthetic-app',client_secret:secret},hold:undefined,verifyHold:undefined,authorized:true,verifications:0};
 const repository=new EmployeeChannelRepository(store);
 const channels=new EmployeeChannelService(repository,{masterKey:Buffer.alloc(32,7),now:()=>now,verifyApplication:async(provider,appId)=>{
  state.verifications++;if(state.verifyHold)await state.verifyHold.promise;
  return {identity:{provider,appId,tenantId:appId,tenantIdNamespace:'app_id'},directoryStatus:provider==='feishu'?'available':'unavailable'};
 }});
 const transport=async(url,init)=>{
  assert.equal(new URL(url).origin,'https://oapi.dingtalk.com');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(init.headers['content-type'],'application/json');assert.ok(init.signal instanceof AbortSignal);
  const action=new URL(url).pathname.split('/').at(-1);assert.equal(new URL(url).pathname,'/app/registration/'+action);
  state.calls.push({action,body:JSON.parse(init.body)});
  if(state.hold?.action===action)await state.hold.promise;
  if(action==='poll'&&state.pollFault){if(state.pollFault instanceof Error)throw state.pollFault;return state.pollFault;}
  return json(action==='init'?{errcode:0,nonce}:action==='begin'?{errcode:0,device_code:device,verification_uri_complete:'https://open.dingtalk.com/verify?ticket=synthetic',expires_in:config.expiresSeconds??60,interval:1}:state.poll);
 };
 const registration=new DingTalkRegistrations(channels,{source:'IDENTALE_TEST',masterKey:Buffer.alloc(32,7),fetch:transport,now:()=>now,...config});
 const app=Fastify({logger:{stream:{write:line=>state.logs.push(line)}}});
 if(config.httpSecurity)await registerHttpSecurity(app,{origin:'http://localhost:3000',secureCookies:false,sessionTtlMs:60000});
 registerDingTalkRegistrationRoutes(app,registration,request=>{if(!state.authorized||request.headers['x-manager']==='no')throw new EmployeeChannelError(403,'role_forbidden');return request.headers['x-actor']??'u';});
 t.after(async()=>{registration.close();await app.close();store.close();await rm(dir,{recursive:true,force:true});});
 const start=(id=randomUUID(),expectedRevision=0,s=scope)=>registration.start(s,{sessionId:id,expectedRevision});
 const ready=async(expectedRevision=0)=>{const session=await start(randomUUID(),expectedRevision);now+=1001;return registration.poll(scope,session.sessionId);};
 return {store,state,repository,channels,registration,app,start,ready,advance:ms=>now+=ms};
}
function noSecrets(value){const text=JSON.stringify(value);for(const sentinel of [nonce,device,secret])assert.equal(text.includes(sentinel),false,sentinel+' leaked');}

test('official protocol, polling interval, encrypted session, one-time bind and manual save',async t=>{
 const f=await setup(t),id=randomUUID(),s=await f.start(id);
 assert.equal(s.status,'waiting');assert.deepEqual(f.state.calls,[{action:'init',body:{source:'IDENTALE_TEST'}},{action:'begin',body:{nonce}}]);
 noSecrets(s);noSecrets([...f.registration.sessions.values()]);
 assert.ok(f.registration.sessions.get(id).secret.ciphertext);
 await f.start(id);await f.registration.poll(scope,id);assert.equal(f.state.calls.length,2);
 f.state.poll={errcode:0,status:'WAITING'};f.advance(1001);assert.equal((await f.registration.poll(scope,id)).status,'waiting');
 f.state.poll={errcode:0,status:'SUCCESS',client_id:'synthetic-app',client_secret:secret};f.advance(1001);
 const ready=await f.registration.poll(scope,id);assert.equal(ready.status,'ready');assert.equal(ready.verificationUrl,undefined);noSecrets(ready);noSecrets([...f.registration.sessions.values()]);
 assert.deepEqual(f.state.calls.at(-1),{action:'poll',body:{device_code:device}});
 const saved=await f.registration.bind(scope,id,false,()=>{});assert.equal(saved.appId,'synthetic-app');assert.equal(saved.status,'pending_verification');noSecrets(saved);
 await assert.rejects(f.registration.bind(scope,id,false,()=>{}),/not_ready/);assert.equal(f.state.verifications,1);
 assert.equal(f.registration.cancel(scope,id).status,'consumed');
 const manual=await f.channels.save('w','e','dingtalk','u',{appId:'synthetic-app',appSecret:'manual-secret',expectedRevision:saved.revision});assert.equal(manual.revision,2);
 noSecrets(f.store.all('SELECT * FROM employee_channel_connections'));noSecrets(f.state.logs);
});

test('missing or empty source uses Identale own source and reaches provider',async t=>{
 for(const source of [undefined,'','  '])await t.test(String(source),async t=>{
  const f=await setup(t,{source});assert.equal(f.registration.availability().available,true);
  const s=await f.start();assert.equal(s.status,'waiting');assert.deepEqual(f.state.calls[0],{action:'init',body:{source:'identale'}});
 });
});

test('invalid source, reserved source and missing key make no requests',async t=>{
 for(const [config,reason] of [[{source:'DING_DWS_CLAW'},'source_invalid'],[{source:'ding_dws_claw'},'source_invalid'],[{source:'not valid'},'source_invalid'],[{masterKey:undefined},'secret_key_unconfigured']])await t.test(reason,async t=>{
  const f=await setup(t,config);assert.deepEqual(f.registration.availability(),{available:false,reason});await assert.rejects(f.start(),new RegExp(reason));assert.equal(f.state.calls.length,0);
 });
});

test('route manager enforcement, strict payload, scope isolation and no-store headers',async t=>{
 const f=await setup(t);
 for(const method of ['GET','POST','DELETE']){const url=method==='GET'?base:method==='POST'?base+'/start':base+'/'+randomUUID();const r=await f.app.inject({method,url,headers:{'x-manager':'no'}});assert.equal(r.statusCode,403);}
 assert.equal(f.state.calls.length,0);
 const invalid=await f.app.inject({method:'POST',url:base+'/start',payload:{sessionId:randomUUID(),expectedRevision:0,source:'DING_DWS_CLAW'}});assert.equal(invalid.statusCode,400);
 const r=await f.app.inject({method:'POST',url:base+'/start',payload:{sessionId:randomUUID(),expectedRevision:0}});assert.equal(r.statusCode,200);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['referrer-policy'],'no-referrer');noSecrets(r.body);
 const id=r.json().sessionId;
 for(const changed of [{actorId:'other'},{workspaceId:'other'},{entityId:'other'}]){
  const wrong={...scope,...changed};await assert.rejects(f.registration.poll(wrong,id),/not_found/);await assert.rejects(f.registration.bind(wrong,id,false,()=>{}),/not_found/);assert.throws(()=>f.registration.cancel(wrong,id),/not_found/);await assert.rejects(f.start(id,0,wrong),/not_found/);
 }
 assert.equal((await f.app.inject({method:'POST',url:base+'/'+id+'/poll',headers:{'x-actor':'other'},payload:{}})).statusCode,404);
 await assert.rejects(f.start(),/busy/);noSecrets(f.state.logs);
});

test('terminal protocol statuses cannot retain secrets or bind',async t=>{
 for(const payload of [{errcode:0,status:'SUCCESS',client_id:'app'},{errcode:0,status:'SUCCESS',client_secret:secret},{errcode:42,errmsg:secret}])await t.test(JSON.stringify(payload).replace(secret,'redacted'),async t=>{
  const f=await setup(t);f.state.poll=payload;const s=await f.ready();assert.equal(s.status,payload.status==='EXPIRED'?'expired':'failed');assert.equal(f.registration.sessions.get(s.sessionId).secret,undefined);noSecrets(s);noSecrets(f.state.logs);await assert.rejects(f.registration.bind(scope,s.sessionId,false,()=>{}),/not_ready/);
 });
});

test('adapter rejects malformed, oversized, HTTP errors, redirection and aborted timeout safely',async t=>{
 for(const value of ['{',JSON.stringify([]),JSON.stringify({}),JSON.stringify({errcode:0,status:'SUCCESS',client_id:'app',client_secret:'x'.repeat(33000)})]){
  const a=new DingTalkRegistrationAdapter(async()=>new Response(value));await assert.rejects(a.poll(device,new AbortController().signal),error=>!error.message.includes(secret));
 }
 for(const status of [302,500]){const a=new DingTalkRegistrationAdapter(async()=>new Response(null,{status,headers:{location:'https://evil.invalid/'+secret}}));await assert.rejects(a.poll(device,new AbortController().signal),status===500?/unavailable/:/rejected/);}
 const a=new DingTalkRegistrationAdapter(async(_url,init)=>{assert.equal(init.redirect,'error');throw new DOMException(secret,'TimeoutError');});await assert.rejects(a.poll(device,new AbortController().signal),/unavailable/);
 const controller=new AbortController();controller.abort();const b=new DingTalkRegistrationAdapter(async(_url,init)=>{init.signal.throwIfAborted();return json({});});await assert.rejects(b.begin('IDENTALE_TEST',controller.signal),/unavailable/);
 for(const url of ['http://dingtalk.com/x','https://dingtalk.com.evil.invalid/x','https://user:pass@dingtalk.com/x','https://dingtalk.com:8443/x','https://dingtalk.com/x#fragment'])assert.throws(()=>registrationVerificationUrl(url),/invalid_response/);
 const c=new DingTalkRegistrationAdapter(async url=>json(url.endsWith('/init')?{errcode:0,nonce}:{errcode:0,device_code:device,verification_uri_complete:'https://dingtalk.com/?code='+device}));await assert.rejects(c.begin('IDENTALE_TEST',new AbortController().signal),/invalid_response/);
});

test('cancel before start and racing init/begin/poll cannot revive a session',async t=>{
 for(const action of ['init','begin','poll'])await t.test(action,async t=>{
  const f=await setup(t),id=randomUUID(),gate=deferred();
  let job;if(action==='poll'){await f.start(id);f.advance(1001);f.state.hold={...gate,action};job=f.registration.poll(scope,id);}else{f.state.hold={...gate,action};job=f.start(id);}
  while(!f.state.calls.some(c=>c.action===action))await new Promise(r=>setImmediate(r));
  if(action!=='poll'){assert.equal((await f.start(id)).status,'starting');await assert.rejects(f.start(),/busy/);}else{await f.registration.poll(scope,id);assert.equal(f.state.calls.filter(c=>c.action==='poll').length,1);}
  f.registration.cancel(scope,id);gate.resolve();assert.equal((await job).status,'cancelled');assert.equal((await f.start(id)).status,'cancelled');assert.equal(f.registration.sessions.get(id).secret,undefined);
 });
 const f=await setup(t),id=randomUUID();f.registration.cancel(scope,id);assert.equal((await f.start(id)).status,'cancelled');assert.equal(f.state.calls.length,0);
});

test('TTL expiration and closure prevent late results and binding',async t=>{
 const f=await setup(t),s=await f.start();f.advance(60001);assert.equal((await f.registration.poll(scope,s.sessionId)).status,'expired');assert.equal(f.state.calls.length,2);
 const ready=await f.ready();f.advance(60001);await assert.rejects(f.registration.bind(scope,ready.sessionId,false,()=>{}),/not_ready/);
 f.registration.close();await assert.rejects(f.start(),/unavailable/);
});

test('replacement needs explicit confirmation and preserves other channel binding',async t=>{
 const f=await setup(t),old=await f.channels.save('w','e','dingtalk','u',{appId:'old-app',appSecret:'old-secret',expectedRevision:0}),other=await f.channels.save('w','e','feishu','u',{appId:'feishu-app',appSecret:'other-secret',expectedRevision:0});
 const snapshot=f.repository.byId(other.id),s=await f.ready(old.revision);
 await assert.rejects(f.registration.bind(scope,s.sessionId,false,()=>{}),/channel_unbind_required/);assert.equal(f.repository.byId(old.id).appId,'old-app');
 const replacement=await f.registration.bind(scope,s.sessionId,true,()=>{});assert.equal(replacement.id,old.id);assert.notEqual(replacement.sourceId,old.sourceId);assert.deepEqual(f.repository.byId(other.id),snapshot);
});

test('CAS change before poll or during awaited save never overwrites newer binding',async t=>{
 for(const phase of ['poll','bind'])await t.test(phase,async t=>{
  const f=await setup(t),s=phase==='poll'?await f.start():await f.ready();
  let job,gate;if(phase==='bind'){gate=deferred();f.state.verifyHold=gate;job=f.registration.bind(scope,s.sessionId,false,()=>{});while(!f.state.verifications)await new Promise(r=>setImmediate(r));f.state.verifyHold=undefined;}
  const manual=await f.channels.save('w','e','dingtalk','u',{appId:'manual-app',appSecret:'manual-secret',expectedRevision:0});
  if(phase==='poll'){f.advance(1001);await assert.rejects(f.registration.poll(scope,s.sessionId),/configuration_changed/);}else{gate.resolve();await assert.rejects(job,/configuration_changed/);}
  assert.equal(f.repository.byId(manual.id).appId,'manual-app');
 });
});

test('cancel, expiry, revoked authority and duplicate bind during credential verification cannot commit',async t=>{
 for(const action of ['cancel','expire','revoke','duplicate'])await t.test(action,async t=>{
  const f=await setup(t),s=await f.ready(),gate=deferred();f.state.verifyHold=gate;
  const job=f.registration.bind(scope,s.sessionId,false,()=>{if(!f.state.authorized)throw new EmployeeChannelError(403,'role_forbidden');});
  while(!f.state.verifications)await new Promise(r=>setImmediate(r));
  if(action==='cancel')f.registration.cancel(scope,s.sessionId);
  if(action==='expire')f.advance(60001);
  if(action==='revoke')f.state.authorized=false;
  if(action==='duplicate')await assert.rejects(f.registration.bind(scope,s.sessionId,false,()=>{}),/not_ready/);
  gate.resolve();if(action==='duplicate'){await job;assert.equal(f.state.verifications,1);}else{await assert.rejects(job,/not_ready|role_forbidden/);assert.equal(f.repository.byProvider('w','e','dingtalk'),undefined);}
 });
});

test('global Origin guard protects every mutation and GET causes no registration request',async t=>{
 const f=await setup(t,{httpSecurity:true});
 const get=await f.app.inject({method:'GET',url:base});assert.equal(get.statusCode,200);assert.equal(get.headers['cache-control'],'no-store');assert.equal(f.state.calls.length,0);
 for(const [method,path,payload] of [['POST','/start',{sessionId:randomUUID(),expectedRevision:0}],['POST','/'+randomUUID()+'/poll',{}],['POST','/'+randomUUID()+'/bind',{replaceSource:false}],['DELETE','/'+randomUUID(),undefined]])for(const origin of [undefined,'https://untrusted.invalid']){
  const r=await f.app.inject({method,url:base+path,headers:origin?{origin}:{},...(payload?{payload}:{})});assert.equal(r.statusCode,403);assert.equal(r.json().error,'invalid_origin');assert.equal(r.headers['cache-control'],'no-store');
 }
 assert.equal(f.state.calls.length,0);
 const valid=await f.app.inject({method:'POST',url:base+'/start',headers:{origin:'http://localhost:3000'},payload:{sessionId:randomUUID(),expectedRevision:0}});assert.equal(valid.statusCode,200);
});

test('route rechecks manager after awaited verification before committing',async t=>{
 const f=await setup(t),s=await f.ready(),gate=deferred();f.state.verifyHold=gate;
 const job=f.app.inject({method:'POST',url:base+'/'+s.sessionId+'/bind',payload:{replaceSource:false}});
 while(!f.state.verifications)await new Promise(r=>setImmediate(r));
 f.state.authorized=false;gate.resolve();const response=await job;assert.equal(response.statusCode,403);assert.equal(response.json().error,'role_forbidden');assert.equal(f.repository.byProvider('w','e','dingtalk'),undefined);
});

test('per-actor start rate cap survives cancellation and resets after a minute',async t=>{
 const f=await setup(t);
 for(let i=0;i<5;i++){const s=await f.start();f.registration.cancel(scope,s.sessionId);}
 await assert.rejects(f.start(),error=>error.status===429);assert.equal(f.state.calls.length,10);
 f.advance(60001);assert.equal((await f.start()).status,'waiting');
});

test('transport receives real bounded timeout signal without contacting a provider',async()=>{
 const keepAlive=setInterval(()=>{},1000),started=Date.now();
 try{
  const adapter=new DingTalkRegistrationAdapter((_url,init)=>new Promise((_resolve,reject)=>{
   init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
  }));
  await assert.rejects(adapter.poll(device,new AbortController().signal),/dingtalk_registration_unavailable/);
  assert.ok(Date.now()-started>=9000);assert.ok(Date.now()-started<20000);
 }finally{clearInterval(keepAlive);}
});

test('capability GET recovers only same-scope active sessions without external work',async t=>{
 const f=await setup(t),s=await f.start(),calls=f.state.calls.length;
 for(let i=0;i<2;i++){
  const response=await f.app.inject({method:'GET',url:base});assert.equal(response.statusCode,200);assert.deepEqual(response.json().session,s);noSecrets(response.body);
 }
 for(const [url,headers] of [[base,{'x-actor':'other'}],[base.replace('/w/','/other/'),{}],[base.replace('/e/','/other/'),{}]]){
  const response=await f.app.inject({method:'GET',url,headers});assert.equal(response.statusCode,200);assert.equal(response.json().session,undefined);
 }
 assert.equal(f.state.calls.length,calls);assert.equal(f.registration.sessions.size,1);
 f.advance(1001);const ready=await f.registration.poll(scope,s.sessionId);
 const restored=await f.app.inject({method:'GET',url:base});assert.deepEqual(restored.json().session,ready);noSecrets(restored.body);assert.equal(f.state.verifications,0);
});

test('capability GET preserves terminal diagnostics including consumed marker, never credentials',async t=>{
 for(const status of ['expired','cancelled','consumed','stale'])await t.test(status,async t=>{
  const f=await setup(t),s=status==='consumed'?await f.ready():await f.start();
  if(status==='expired')f.advance(60001);
  if(status==='cancelled')f.registration.cancel(scope,s.sessionId);
  if(status==='consumed')await f.registration.bind(scope,s.sessionId,false,()=>{});
  if(status==='stale')await f.channels.save('w','e','dingtalk','u',{appId:'manual-app',appSecret:'manual-secret',expectedRevision:0});
  const calls=f.state.calls.length,response=await f.app.inject({method:'GET',url:base});assert.equal(response.statusCode,200);assert.equal(response.json().session?.status,status==='expired'?'expired':status==='stale'?'failed':status==='consumed'?'consumed':undefined);assert.equal(response.json().session?.verificationUrl,undefined);assert.equal(f.state.calls.length,calls);noSecrets(response.body);
 });
});

test('verification links reject nonce and device secrets in raw and encoded forms',async()=>{
 const encoded=text=>[...text].map(c=>'%'+c.charCodeAt(0).toString(16)).join('');
 for(const value of [nonce,device])for(const fragment of [value,encoded(value),encodeURIComponent(encoded(value))]){
  const adapter=new DingTalkRegistrationAdapter(async url=>json(url.endsWith('/init')?{errcode:0,nonce}:{errcode:0,device_code:device,verification_uri_complete:'https://open.dingtalk.com/verify?ticket='+fragment}));
  await assert.rejects(adapter.begin('IDENTALE_TEST',new AbortController().signal),/invalid_response/);
 }
});


test('save failure preserves encrypted ready credentials for explicit retry without provider recreation',async t=>{
 const f=await setup(t);const ready=await f.ready();const save=f.channels.save.bind(f.channels);let attempts=0;
 f.channels.save=async(...args)=>{if(++attempts===1)throw new EmployeeChannelError(502,'channel_validation_failed');return save(...args);};
 await assert.rejects(f.registration.bind(scope,ready.sessionId,false,()=>{}),/channel_validation_failed/);
 assert.equal((await f.registration.poll(scope,ready.sessionId)).status,'ready');
 assert.ok(f.registration.sessions.get(ready.sessionId).secret.ciphertext);
 noSecrets(f.registration.availability(scope));noSecrets([...f.registration.sessions.values()]);
 await f.registration.bind(scope,ready.sessionId,false,()=>{});
 assert.equal(f.state.calls.filter(x=>x.action==='init').length,1);
 assert.equal(f.state.verifications,1);assert.equal(attempts,2);
 assert.equal((await f.registration.poll(scope,ready.sessionId)).status,'consumed');
});


for(const fault of ['network','timeout','5xx','429'])test(`transient provider poll ${fault} preserves original encrypted session for explicit recovery`,async t=>{
 const f=await setup(t),s=await f.start();f.advance(1001);
 f.state.pollFault=fault==='network'?new TypeError('network'):fault==='timeout'?new DOMException('timeout','TimeoutError'):new Response('',{status:fault==='429'?429:503});
 await assert.rejects(f.registration.poll(scope,s.sessionId),/dingtalk_registration_unavailable/);
 const retained=f.registration.availability(scope).session;
 assert.equal(retained.status,'waiting');assert.equal(retained.expiresAt,s.expiresAt);
 assert.ok(f.registration.sessions.get(s.sessionId).secret.ciphertext);noSecrets(retained);noSecrets([...f.registration.sessions.values()]);
 f.state.pollFault=undefined;f.advance(1001);
 assert.equal((await f.registration.poll(scope,s.sessionId)).status,'ready');
 assert.equal(f.state.calls.filter(x=>x.action==='init').length,1);assert.equal(f.state.calls.filter(x=>x.action==='begin').length,1);
});
for(const fault of ['401','invalid-json'])test(`nonretryable poll ${fault} terminates and clears secrets`,async t=>{
 const f=await setup(t),s=await f.start();f.advance(1001);
 f.state.pollFault=new Response(fault==='401'?'':'invalid-json',{status:fault==='401'?401:200});
 assert.equal((await f.registration.poll(scope,s.sessionId)).status,'failed');
 assert.equal(f.registration.sessions.get(s.sessionId).secret,undefined);
 const calls=f.state.calls.length;await f.registration.poll(scope,s.sessionId);assert.equal(f.state.calls.length,calls);
});
test('transient poll failure after TTL cannot preserve or revive the session',async t=>{
 const f=await setup(t),s=await f.start();f.advance(1001);
 const hold=deferred();f.state.hold={action:'poll',...hold};f.state.pollFault=new Error('network');
 const job=f.registration.poll(scope,s.sessionId);f.advance(60000);hold.resolve();
 assert.equal((await job).status,'expired');assert.equal(f.registration.sessions.get(s.sessionId).secret,undefined);
});

test('failed state survives re-entry only for its owner; explicit dismissal does not expose older sessions',async t=>{
 const f=await setup(t),s=await f.start();f.advance(1001);
 f.state.pollFault=new Response('',{status:401});await f.registration.poll(scope,s.sessionId);
 const calls=f.state.calls.length;
 assert.equal(f.registration.availability(scope).session.status,'failed');
 assert.equal(f.registration.availability({...scope,actorId:'other'}).session,undefined);
 assert.equal(f.registration.availability({...scope,entityId:'other'}).session,undefined);
 assert.equal(f.registration.availability({...scope,workspaceId:'other'}).session,undefined);
 f.registration.cancel(scope,s.sessionId);assert.equal(f.registration.availability(scope).session,undefined);
 f.state.pollFault=undefined;const next=await f.start();f.registration.cancel(scope,next.sessionId);
 assert.equal(f.registration.availability(scope).session,undefined);
 assert.equal(f.state.calls.length,calls+2);
 f.advance(1200001);assert.equal(f.registration.sessions.size>0,true);f.registration.availability(scope);assert.equal(f.registration.sessions.size,0);
});

test('a cancelled unknown start does not hide an existing active scoped session',async t=>{
 const f=await setup(t),s=await f.start();f.registration.cancel(scope,randomUUID());
 assert.equal(f.registration.availability(scope).session.sessionId,s.sessionId);
 assert.equal(f.registration.availability(scope).session.status,'waiting');
});

test('poll normalizes official string statuses but does not coerce malformed status or credentials',async()=>{
 const signal=new AbortController().signal;
 for(const status of ['waiting',' WAITING ',' success ','fail','expired']){
  const adapter=new DingTalkRegistrationAdapter(async()=>json({errcode:0,status,client_id:'app',client_secret:secret}));
  assert.equal((await adapter.poll(device,signal)).status,status.trim().toUpperCase());
 }
 for(const status of [null,{},['SUCCESS'],42]){
  const events=[],adapter=new DingTalkRegistrationAdapter(async()=>json({errcode:0,status}),event=>events.push(event));
  await assert.rejects(adapter.poll(device,signal),/invalid_response/);assert.equal(events[0].reason,'unknown_status');
 }
});

test('protocol diagnostics distinguish failure shapes without retaining any raw provider values',async()=>{
 const signal=new AbortController().signal;
 for(const [response,reason] of [
  [new Response(secret),'invalid_json'],[json([secret]),'non_object_body'],
  [json({errcode:0,status:{value:secret},errmsg:device,[nonce]:secret}),'unknown_status'],
  [json({errcode:0,status:'SUCCESS',client_id:device,client_secret:{value:secret}}),'invalid_success_credentials'],
  [json({errcode:0,status:'SUCCESS',client_secret:secret}),'invalid_success_credentials']]){
  const events=[],adapter=new DingTalkRegistrationAdapter(async()=>response,event=>events.push(event));
  await assert.rejects(adapter.poll(device,signal),/invalid_response/);
  assert.equal(events.length,1);assert.equal(events[0].action,'poll');assert.equal(events[0].reason,reason);noSecrets(events);
  assert.equal(Object.hasOwn(events[0].fields,'errmsg'),false);
 }
 const adapter=new DingTalkRegistrationAdapter(async()=>json({errcode:0,status:42}),()=>{throw new Error(secret);});
 await assert.rejects(adapter.poll(device,signal),/invalid_response/);
});

test('init and begin shape diagnostics are safe and retain existing protocol bounds',async()=>{
 for(const action of ['init','begin']){
  const events=[],adapter=new DingTalkRegistrationAdapter(async url=>json(url.endsWith('/init')&&action==='begin'?{errcode:0,nonce}:{errcode:0,nonce:{value:secret},device_code:device,verification_uri_complete:'https://evil.invalid/'+secret}),event=>events.push(event));
  await assert.rejects(adapter.begin('IDENTALE_TEST',new AbortController().signal),/invalid_response/);
  assert.equal(events.length,1);assert.equal(events[0].action,action);noSecrets(events);
 }
});

test('terminal-looking provider states recover on the original session across page re-entry',async t=>{
 for(const status of ['FAIL','EXPIRED','UNKNOWN','undocumented'])await t.test(status,async t=>{
  const f=await setup(t,{expiresSeconds:600});f.state.poll={errcode:0,status};const s=await f.ready();
  assert.equal(s.status,'waiting');assert.ok(f.registration.sessions.get(s.sessionId).secret);noSecrets(s);
  assert.equal(f.registration.availability(scope).session.sessionId,s.sessionId);
  f.advance(5000);f.state.poll={errcode:0,status:'SUCCESS',client_id:'app',client_secret:secret};
  assert.equal((await f.registration.poll(scope,s.sessionId)).status,'ready');
  assert.equal(f.state.calls.filter(c=>c.action==='init').length,1);assert.equal(f.state.calls.filter(c=>c.action==='begin').length,1);
  assert.ok(f.state.calls.filter(c=>c.action==='poll').every(c=>c.body.device_code===device));
 });
});

test('persistent abnormal status expires its 120 second budget without extending the original TTL',async t=>{
 for(const status of ['FAIL','EXPIRED','UNKNOWN'])await t.test(status,async t=>{
  const f=await setup(t,{expiresSeconds:600});f.state.poll={errcode:0,status};const s=await f.ready();
  f.advance(119000);assert.equal((await f.registration.poll(scope,s.sessionId)).status,'waiting');
  const calls=f.state.calls.length;f.advance(1000);
  assert.equal((await f.registration.poll(scope,s.sessionId)).status,status==='EXPIRED'?'expired':'failed');
  assert.equal(f.state.calls.length,calls);assert.equal(f.registration.sessions.get(s.sessionId).secret,undefined);
 });
 const f=await setup(t);f.state.poll={errcode:0,status:'UNKNOWN'};const s=await f.ready();f.advance(60000);
 assert.equal((await f.registration.poll(scope,s.sessionId)).status,'expired');
});

test('WAITING resets the abnormal status window and malformed success still fails immediately',async t=>{
 const f=await setup(t,{expiresSeconds:600});f.state.poll={errcode:0,status:'FAIL'};const s=await f.ready();
 f.advance(100000);f.state.poll={errcode:0,status:'WAITING'};await f.registration.poll(scope,s.sessionId);
 assert.equal(f.registration.sessions.get(s.sessionId).retryUntil,undefined);
 f.advance(30000);f.state.poll={errcode:0,status:'UNKNOWN'};assert.equal((await f.registration.poll(scope,s.sessionId)).status,'waiting');
 f.advance(1000);f.state.poll={errcode:0,status:'SUCCESS',client_id:'app'};
 assert.equal((await f.registration.poll(scope,s.sessionId)).status,'failed');assert.equal(f.registration.sessions.get(s.sessionId).secret,undefined);
});

test('cancel, binding changes, and late success cannot bypass the abnormal status budget',async t=>{
 for(const change of ['cancel','binding','timeout'])await t.test(change,async t=>{
  const f=await setup(t,{expiresSeconds:600});f.state.poll={errcode:0,status:'UNKNOWN'};const s=await f.ready();
  f.advance(1000);const gate=deferred();f.state.hold={...gate,action:'poll'};f.state.poll={errcode:0,status:'SUCCESS',client_id:'app',client_secret:secret};
  const job=f.registration.poll(scope,s.sessionId);while(f.state.calls.filter(c=>c.action==='poll').length<2)await new Promise(r=>setImmediate(r));
  if(change==='cancel')f.registration.cancel(scope,s.sessionId);
  if(change==='binding')await f.channels.save('w','e','dingtalk','u',{appId:'other',appSecret:'other-secret',expectedRevision:0});
  if(change==='timeout')f.advance(120000);
  gate.resolve();const result=await job;assert.equal(result.status,change==='cancel'?'cancelled':'failed');assert.equal(f.registration.sessions.get(s.sessionId).secret,undefined);
 });
});
