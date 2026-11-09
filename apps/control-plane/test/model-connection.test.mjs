import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../dist/store.js';
import {ModelProfileService,registerModelProfileRoutes} from '../dist/model-profiles.js';
import {OpenAICompatibleModelClient} from '@dentity/runtime-builtin';
import {createServer as createPlatform} from '../dist/server.js';

const secret='synthetic-local-provider-credential';
const masterKey=Buffer.alloc(32,9);
const code=expected=>error=>error.code===expected;
async function setup(t,base='/v1'){
 const requests=[],hooks={},provider=createServer(async(req,res)=>{
  if(req.url==='/redirect-target'){requests.push({redirectTarget:true});res.end('{}');return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({path:req.url,body,authorization:req.headers.authorization});
  if(hooks.beforeResponse)await hooks.beforeResponse();
  if(req.url!==base.replace(/\/+$/,'')+'/chat/completions'){res.writeHead(404);res.end(secret);return;}
  if(req.headers.authorization!==`Bearer ${secret}`){res.writeHead(401);res.end(secret);return;}
  if(body.model==='missing-model'||body.model==='incompatible'&&body.enable_thinking===false){res.writeHead(400);res.end(secret);return;}
  if(body.model==='redirect'){res.writeHead(307,{location:'/redirect-target'});res.end();return;}
  if(body.model==='malformed'){res.end(JSON.stringify({error:secret}));return;}
  if(body.model==='oversized'){res.end('x'.repeat(70000));return;}
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'OK'}}],usage:{prompt_tokens:2,completion_tokens:1}}));
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const endpoint=`http://127.0.0.1:${provider.address().port}${base}`;
 const dir=mkdtempSync(join(tmpdir(),'dentity-connection-')),store=new Store(join(dir,'isolated.sqlite'));
 store.run("INSERT INTO users(id,username,display_name) VALUES('u','user','User')");
 store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Workspace','u'),('other','Other','u')");
 store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner')");
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Entity','m','m',1,'u','builtin')");
 const options={masterKey,allowLoopbackHttp:true},service=new ModelProfileService(store,options);
 const input={name:'Local synthetic model',provider:'openai-compatible',endpoint,modelId:'supported',apiKey:secret};
 t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
 return {service,store,input,requests,options,hooks,dir};
}

test('local connection probe checks fixed dual none parameters and unlocks atomic create plus bind',async t=>{
 const {service,input,requests,store}=await setup(t),config={...input,bindEntityId:'e',setAsDefault:true};
 assert.throws(()=>service.saveValidated('w',null,'u',config),code('model_connection_test_required'));
 const tested=await service.testConnection('w',null,'u',config);
 assert.equal(requests.length,2);assert.equal(requests[0].body.reasoning_effort,'none');assert.equal(requests[0].body.enable_thinking,false);
 for(const request of requests.slice(0,1)){assert.equal(request.body.max_completion_tokens,64);assert.equal(request.body.stream,false);assert.deepEqual(request.body.messages,[{role:'user',content:'Reply OK.'}]);assert.equal(request.authorization,`Bearer ${secret}`);}
 assert.equal(tested.inputCapabilities.text,'passed');assert.equal(tested.inputCapabilities.image,'unknown');assert.equal(requests[1].body.messages[0].content[1].type,'image_url');
 assert.equal(service.list('w').length,0,'Testing must not persist profile or key');
 assert.equal(JSON.stringify(tested).includes(secret),false);
 const saved=service.saveValidated('w',null,'u',{...config,connectionTestReceipt:tested.connectionTestReceipt});
 assert.equal(saved.referenceCount,2);assert.equal(service.effective('w','e').id,saved.id);assert.equal(service.defaultProfileId('w'),saved.id);
 assert.equal(JSON.stringify(saved).includes(secret),false);assert.equal(JSON.stringify(store.one('SELECT * FROM model_catalog')).includes(secret),false);
 assert.throws(()=>service.saveValidated('w',null,'u',{...config,connectionTestReceipt:tested.connectionTestReceipt}),code('model_connection_test_required'));
});

test('bad endpoint, credential, model and incompatible parameters never unlock saving or change old profile',async t=>{
 const {service,input}=await setup(t),old=service.save('w','e',input),before=service.getProfile('w',old.id);
 const cases=[{endpoint:input.endpoint+'/missing',apiKey:secret},{apiKey:'incorrect-synthetic-key'},{modelId:'missing-model'},{modelId:'incompatible'},{modelId:'malformed'},{modelId:'oversized'}];
 for(const patch of cases){
  const config={...input,...patch};
  await assert.rejects(service.testConnection('w',old.id,'u',config),error=>{assert.equal(error.message.includes(secret),false);return ['model_connection_test_failed','model_connection_test_invalid_response','model_parameters_incompatible'].includes(error.code);});
  assert.throws(()=>service.saveValidated('w',old.id,'u',config),code('model_connection_test_required'));
  assert.deepEqual(service.getProfile('w',old.id),before);
 }
 await assert.rejects(service.testConnection('w',old.id,'u',{...input,endpoint:'http://not-loopback.invalid/v1'}),code('model_endpoint_requires_tls'));
 await assert.rejects(service.testConnection('w',old.id,'u',{...input,interactionThinkingControl:'unconfigured'}),code('model_thinking_configuration_removed'));
 await assert.rejects(service.testConnection('w',old.id,'u',{...input,executionThinkingControl:'unconfigured'}),code('model_thinking_configuration_removed'));
 assert.equal((await service.resolve({workspaceId:'w',entityId:'e',profileId:old.id,configRevision:old.configRevision,purpose:'model-inference'},()=>true)).apiKey,secret);
});

test('receipts bind actor, workspace, all configuration, key operation and current profile revision',async t=>{
 const {service,input}=await setup(t),tested=await service.testConnection('w',null,'u',input);
 const receipt={connectionTestReceipt:tested.connectionTestReceipt};
 for(const [workspace,actor,patch] of [['other','u',{}],['w','other-user',{}],['w','u',{name:'Changed'}],['w','u',{modelId:'different'}],['w','u',{enabled:false}],['w','u',{apiKey:'new-key'}],['w','u',{bindEntityId:'e'}],['w','u',{setAsDefault:true}]]){
  assert.throws(()=>service.saveValidated(workspace,null,actor,{...input,...patch,...receipt}),code('model_connection_test_required'));
 }
 const saved=service.saveValidated('w',null,'u',{...input,...receipt});service.select('w','e',saved.id);
 const retain={...input,apiKey:undefined},updatedTest=await service.testConnection('w',saved.id,'u',retain);
 assert.throws(()=>service.saveValidated('w',saved.id,'u',{...input,connectionTestReceipt:updatedTest.connectionTestReceipt}),code('model_connection_test_required'),'Even same key replacement differs from retention');
 const updated=service.saveValidated('w',saved.id,'u',{...retain,connectionTestReceipt:updatedTest.connectionTestReceipt});
 assert.equal(updated.secretRef,saved.secretRef);assert.equal(updated.configRevision,saved.configRevision+1);
 const stale=await service.testConnection('w',saved.id,'u',retain);
 service.save('w','e',{...input,name:'Concurrent editor'});
 assert.throws(()=>service.saveValidated('w',saved.id,'u',{...retain,connectionTestReceipt:stale.connectionTestReceipt}),code('model_connection_test_required'));
});

test('expired or restart-lost receipt cannot save',async t=>{
 const {service,store,input,options}=await setup(t),tested=await service.testConnection('w',null,'u',input);
 const save={...input,connectionTestReceipt:tested.connectionTestReceipt};
 const resumed=new ModelProfileService(store,options);
 assert.throws(()=>resumed.saveValidated('w',null,'u',save),code('model_connection_test_required'));
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 t.mock.timers.tick(5*60_000+1);
 assert.throws(()=>service.saveValidated('w',null,'u',save),code('model_connection_test_required'));
 t.mock.timers.reset();assert.equal(service.hasCatalog('w'),false);
});

test('provider redirect is never followed and no receipt or secret response is issued',async t=>{
 const {service,input,requests}=await setup(t);
 await assert.rejects(service.testConnection('w',null,'u',{...input,modelId:'redirect'}),error=>{assert.equal(error.code,'model_connection_test_failed');assert.equal(error.message.includes(secret),false);return true;});
 assert.equal(requests.length,1);assert.equal(requests.some(r=>r.redirectTarget),false);assert.equal(service.hasCatalog('w'),false);
});

test('HTTP authorization and save gate cannot be bypassed; success and errors redact credentials',async t=>{
 const {service,input}=await setup(t),app=Fastify();
 const manager=request=>{if(request.headers['x-role']!=='admin'){const error=new Error('forbidden');error.statusCode=403;throw error;}};
 await registerModelProfileRoutes(app,service,{requireManager:manager,requireWorkspaceManager:manager,requireWorkspaceMember:()=>{},currentUser:request=>({id:String(request.headers['x-user']??'u')})});
 t.after(()=>app.close());
 const url='/api/workspaces/w/model-profiles',headers={'x-role':'admin'},config={...input,bindEntityId:'e'};
 assert.equal((await app.inject({method:'POST',url:url+'/test-connection',payload:config})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url,headers,payload:config})).statusCode,409);
 const tested=await app.inject({method:'POST',url:url+'/test-connection',headers,payload:config});assert.equal(tested.statusCode,200,tested.body);assert.equal(tested.body.includes(secret),false);
 const save={...config,connectionTestReceipt:tested.json().connectionTestReceipt};
 const roleRevoked=await app.inject({method:'POST',url,headers:{'x-role':'member'},payload:save});assert.equal(roleRevoked.statusCode,403);
 const changed=await app.inject({method:'POST',url,headers,payload:{...save,setAsDefault:true}});assert.equal(changed.statusCode,409);
 const crossWorkspace=await app.inject({method:'POST',url:'/api/workspaces/other/model-profiles',headers,payload:{...save,bindEntityId:undefined}});assert.equal(crossWorkspace.statusCode,409);
 const crossActor=await app.inject({method:'POST',url,headers:{...headers,'x-user':'someone-else'},payload:save});assert.equal(crossActor.statusCode,409);
 const saved=await app.inject({method:'POST',url,headers,payload:save});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.body.includes(secret),false);
 const replay=await app.inject({method:'POST',url,headers,payload:save});assert.equal(replay.statusCode,409);
 const id=saved.json().id,bad=await app.inject({method:'POST',url:`${url}/${id}/test-connection`,headers,payload:{...input,apiKey:'invalid'}});assert.equal(bad.statusCode,502);assert.equal(bad.body.includes(secret),false);
 const previous=service.getProfile('w',id);
 for(const patch of [{endpoint:input.endpoint+'/wrong'},{modelId:'missing-model'},{modelId:'incompatible'}]){
  const failedConfig={...input,...patch};
  const result=await app.inject({method:'POST',url:`${url}/${id}/test-connection`,headers,payload:failedConfig});assert.ok([409,502].includes(result.statusCode));assert.equal(result.body.includes(secret),false);
  const blocked=await app.inject({method:'PUT',url:`${url}/${id}`,headers,payload:failedConfig});assert.equal(blocked.statusCode,409);
  assert.deepEqual(service.getProfile('w',id),previous);
 }
 const expires=await app.inject({method:'POST',url:`${url}/${id}/test-connection`,headers,payload:input});assert.equal(expires.statusCode,200);
 t.mock.timers.enable({apis:['Date'],now:Date.now()});t.mock.timers.tick(5*60_000+1);
 const expired=await app.inject({method:'PUT',url:`${url}/${id}`,headers,payload:{...input,connectionTestReceipt:expires.json().connectionTestReceipt}});assert.equal(expired.statusCode,409);
 t.mock.timers.reset();assert.deepEqual(service.getProfile('w',id),previous);
 const revoke=await app.inject({method:'POST',url:`${url}/${id}/revoke`,headers,payload:{}});assert.equal(revoke.statusCode,200);assert.equal(revoke.json().enabled,false);assert.equal(revoke.json().secretRef,null);
});

test('in-flight duplicate probe is blocked and concurrent configuration update makes result stale',async t=>{
 const {service,input,hooks}=await setup(t),old=service.save('w','e',input);
 let release,entered;const enteredPromise=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
 hooks.beforeResponse=async()=>{entered();await hold;};
 const pending=service.testConnection('w',old.id,'u',input);
 const stale=assert.rejects(pending,code('model_connection_test_stale'));
 await enteredPromise;
 await assert.rejects(service.testConnection('w',old.id,'u',input),code('model_connection_test_in_progress'));
 const changed=service.save('w','e',{...input,name:'Concurrent saved revision'});
 release();await stale;
 assert.equal(service.getProfile('w',old.id).configRevision,changed.configRevision);
 assert.equal(service.getProfile('w',old.id).name,'Concurrent saved revision');
});


test('loopback HTTP still needs its flag; existing profiles survive disabled policy and restore unchanged',async t=>{
 const {service,store,input,requests}=await setup(t);
 const profile=service.save('w','e',input),before=store.one('SELECT * FROM model_catalog WHERE id=?',profile.id);
 const disabled=new ModelProfileService(store,{masterKey});
 assert.throws(()=>disabled.save('w','e',input),code('model_endpoint_requires_tls'));
 assert.throws(()=>disabled.assertUsable('w','e'),code('model_endpoint_requires_tls'));
 await assert.rejects(disabled.resolve({workspaceId:'w',entityId:'e',profileId:profile.id,configRevision:profile.configRevision,purpose:'model-inference'},()=>true),code('model_endpoint_requires_tls'));
 await assert.rejects(disabled.testConnection('w',profile.id,'u',input),code('model_endpoint_requires_tls'));
 for(const endpoint of ['http://not-loopback.invalid/v1','http://192.168.1.2/v1']){
  await assert.rejects(service.testConnection('w',profile.id,'u',{...input,endpoint}),code('model_endpoint_requires_tls'));
 }
 assert.deepEqual(store.one('SELECT * FROM model_catalog WHERE id=?',profile.id),before,'Policy rejection preserves saved ciphertext, endpoint and binding');
 assert.equal(service.effective('w','e').id,profile.id);assert.equal(requests.length,0,'Invalid destinations fail before any provider call');
 const restored=new ModelProfileService(store,{masterKey,allowLoopbackHttp:true});
 const resolved=await restored.resolve({workspaceId:'w',entityId:'e',profileId:profile.id,configRevision:profile.configRevision,purpose:'model-inference'},()=>true);assert.equal(resolved.apiKey,secret);
 assert.deepEqual(store.one('SELECT * FROM model_catalog WHERE id=?',profile.id),before);
});

for(const base of ['','/','/v1','/v1/'])test(`base ${base||'(origin)'} probes, saves and completes builtin inference through the resolved credential`,async t=>{
 const {service,store,input,requests,options}=await setup(t,base),config={...input,bindEntityId:'e'};
 const tested=await service.testConnection('w',null,'u',config);
 const profile=service.saveValidated('w',null,'u',{...config,connectionTestReceipt:tested.connectionTestReceipt});
 const restarted=new ModelProfileService(store,options);
 assert.equal(restarted.assertUsable('w','e').id,profile.id);
 const scope={workspaceId:'w',entityId:'e',profileId:profile.id,configRevision:profile.configRevision,purpose:'model-inference'};
 const client=new OpenAICompatibleModelClient({endpoint:profile.endpoint,model:profile.modelId,secretRef:profile.id,allowLoopbackHttp:true},async(ref,endpoint)=>{
  assert.equal(ref,profile.id);const resolved=await restarted.resolve(scope,()=>true);assert.equal(endpoint,resolved.endpoint);return resolved.apiKey;
 });
 const result=await client.complete({messages:[{role:'user',content:'Synthetic inference'}],tools:[],maxOutputTokens:20,signal:new AbortController().signal});
 assert.equal(result.text,'OK');assert.deepEqual(result.usage,{inputTokens:2,outputTokens:1});assert.equal(requests.length,3);
 assert.equal(profile.endpoint,input.endpoint.replace(/\/+$/,''));
 assert.ok(requests.every(request=>request.path===base.replace(/\/+$/,'')+'/chat/completions'&&request.authorization===`Bearer ${secret}`));
});

for(const base of ['','/','/v1','/v1/'])test(`base ${base||'(origin)'} completes a platform HTTP turn with the production credential binding`,async t=>{
 const f=await setup(t,base),origin='http://127.0.0.1:15173';
 const app=createPlatform({databasePath:join(f.dir,'platform.sqlite'),origin,pollIntervalMs:0,modelProfiles:f.options});
 try {
  await app.ready();
  const call=(method,url,payload,cookie)=>app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{origin,...(cookie?{cookie}:{})}});
  const registered=await call('POST','/api/auth/register',{username:'endpoint-user',password:'Synthetic endpoint test password 2026!'});
  assert.equal(registered.statusCode,201,registered.body);
  const cookie=registered.headers['set-cookie'].split(';')[0],workspace=`/api/workspaces/${registered.json().workspace.id}`;
  const employee=await call('POST',workspace+'/entities',{name:'Endpoint fixture',ownWebUse:true},cookie);
  assert.equal(employee.statusCode,200,employee.body);
  const entityId=employee.json().entity.id,config={...f.input,bindEntityId:entityId};
  const tested=await call('POST',workspace+'/model-profiles/test-connection',config,cookie);
  assert.equal(tested.statusCode,200,tested.body);
  const saved=await call('POST',workspace+'/model-profiles',{...config,connectionTestReceipt:tested.json().connectionTestReceipt},cookie);
  assert.equal(saved.statusCode,200,saved.body);
  assert.equal(saved.json().endpoint,f.input.endpoint.replace(/\/+$/,''));
  const conversations=`${workspace}/entities/${entityId}/conversations`;
  const opened=await call('POST',conversations,{operationId:'endpoint-conversation'},cookie);
  assert.ok([200,201].includes(opened.statusCode),opened.body);
  const turns=`${conversations}/${opened.json().conversation.id}/turns`;
  const started=await call('POST',turns,{operationId:'endpoint-turn',text:'Synthetic inference'},cookie);
  assert.equal(started.statusCode,202,started.body);
  let turn;
  const deadline=Date.now()+5000;
  do {
   const state=await call('GET',`${turns}/${started.json().turn.id}`,undefined,cookie);
   assert.equal(state.statusCode,200,state.body);turn=state.json().turn;
   if(['succeeded','failed','unknown','canceled'].includes(turn.status))break;
   await new Promise(resolve=>setTimeout(resolve,10));
  } while(Date.now()<deadline);
  assert.equal(turn.status,'succeeded',JSON.stringify(turn));assert.equal(turn.text,'OK');
  assert.equal(f.requests.length,3);
  assert.ok(f.requests.every(request=>request.path===base.replace(/\/+$/,'')+'/chat/completions'&&request.authorization===`Bearer ${secret}`));
 } finally { await app.close(); }
});
