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
  return json(action==='init'?{errcode:0,nonce}:action==='begin'?{errcode:0,device_code:device,verification_uri_complete:'https://open.dingtalk.com/verify?ticket=synthetic',expires_in:60,interval:1}:state.poll);
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

test('unconfigured source, reserved source and missing key make no requests',async t=>{
 for(const [config,reason] of [[{source:undefined},'source_unconfigured'],[{source:'DING_DWS_CLAW'},'source_invalid'],[{source:'ding_dws_claw'},'source_invalid'],[{source:'not valid'},'source_invalid'],[{masterKey:undefined},'secret_key_unconfigured']])await t.test(reason,async t=>{
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
 for(const payload of [{errcode:0,status:'FAIL'},{errcode:0,status:'EXPIRED'},{errcode:0,status:'UNKNOWN'},{errcode:0,status:'SUCCESS',client_id:'app'},{errcode:0,status:'SUCCESS',client_secret:secret},{errcode:42,errmsg:secret}])await t.test(JSON.stringify(payload).replace(secret,'redacted'),async t=>{
  const f=await setup(t);f.state.poll=payload;const s=await f.ready();assert.equal(s.status,payload.status==='EXPIRED'?'expired':'failed');assert.equal(f.registration.sessions.get(s.sessionId).secret,undefined);noSecrets(s);noSecrets(f.state.logs);await assert.rejects(f.registration.bind(scope,s.sessionId,false,()=>{}),/not_ready/);
 });
});

test('adapter rejects malformed, oversized, HTTP errors, redirection and aborted timeout safely',async t=>{
 for(const value of ['{',JSON.stringify([]),JSON.stringify({}),JSON.stringify({errcode:0,status:'SUCCESS',client_id:'app',client_secret:'x'.repeat(33000)})]){
  const a=new DingTalkRegistrationAdapter(async()=>new Response(value));await assert.rejects(a.poll(device,new AbortController().signal),error=>!error.message.includes(secret));
 }
 for(const status of [302,500]){const a=new DingTalkRegistrationAdapter(async()=>new Response(null,{status,headers:{location:'https://evil.invalid/'+secret}}));await assert.rejects(a.poll(device,new AbortController().signal),/unavailable/);}
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

test('capability GET does not recover expired, cancelled, consumed or stale sessions',async t=>{
 for(const status of ['expired','cancelled','consumed','stale'])await t.test(status,async t=>{
  const f=await setup(t),s=status==='consumed'?await f.ready():await f.start();
  if(status==='expired')f.advance(60001);
  if(status==='cancelled')f.registration.cancel(scope,s.sessionId);
  if(status==='consumed')await f.registration.bind(scope,s.sessionId,false,()=>{});
  if(status==='stale')await f.channels.save('w','e','dingtalk','u',{appId:'manual-app',appSecret:'manual-secret',expectedRevision:0});
  const calls=f.state.calls.length,response=await f.app.inject({method:'GET',url:base});assert.equal(response.statusCode,200);assert.equal(response.json().session,undefined);assert.equal(f.state.calls.length,calls);noSecrets(response.body);
 });
});

test('verification links reject nonce and device secrets in raw and encoded forms',async()=>{
 const encoded=text=>[...text].map(c=>'%'+c.charCodeAt(0).toString(16)).join('');
 for(const value of [nonce,device])for(const fragment of [value,encoded(value),encodeURIComponent(encoded(value))]){
  const adapter=new DingTalkRegistrationAdapter(async url=>json(url.endsWith('/init')?{errcode:0,nonce}:{errcode:0,device_code:device,verification_uri_complete:'https://open.dingtalk.com/verify?ticket='+fragment}));
  await assert.rejects(adapter.begin('IDENTALE_TEST',new AbortController().signal),/invalid_response/);
 }
});
