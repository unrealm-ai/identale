import test from 'node:test';
import {Store} from '../dist/store.js';
import {ModelProfileService} from '../dist/model-profiles.js';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../dist/server.js';
const origin='http://127.0.0.1:5173';
const hostToken='synthetic-host-test-token-not-a-secret-0001',resolverToken='synthetic-resolver-test-token-not-a-secret-0002';
async function setup(t,{queuedSupplement=false,planned=false}={}){
  const dir=await mkdtemp(join(tmpdir(),'dentity-host-client-'));let service;const records=[];
  const app=createServer({databasePath:join(dir,'test.sqlite'),origin,pollIntervalMs:0,onService:s=>service=s,runtimeHost:{url:'http://127.0.0.1:4646',token:hostToken,resolverToken},modelProfiles:{masterKey:Buffer.alloc(32,7),allowLoopbackHttp:true}});await app.ready();
  const db=new DatabaseSync(join(dir,'test.sqlite'));
  t.after(async()=>{fixtureStore.close();db.close();await app.close();await rm(dir,{recursive:true,force:true});});
  const call=(method,url,payload,cookie)=>app.inject({method,url,payload,headers:{origin,...(cookie?{cookie}:{})}});
  const reg=await call('POST','/api/auth/register',{username:'host-user',password:'Synthetic runtime local test 2026!'});const user=reg.json(),cookie=reg.headers['set-cookie'].split(';')[0];
  const entity=(await call('POST',`/api/workspaces/${user.workspace.id}/entities`,{name:'Test',ownWebUse:true},cookie)).json().entity;
  const base=`/api/workspaces/${user.workspace.id}/entities/${entity.id}`;
  const fixtureStore=new Store(join(dir,'test.sqlite'));
  const profiles=new ModelProfileService(fixtureStore,{masterKey:Buffer.alloc(32,7),allowLoopbackHttp:true});
  const profileInput={provider:'openai-compatible',endpoint:'http://127.0.0.1:4545/v1',modelId:'synthetic-model',apiKey:'synthetic-credential-no-provider-access'};
  const profile=profiles.saveWorkspace(user.workspace.id,profileInput);
  const conversation=(await call('POST',base+'/conversations',{operationId:'one',mode:'real'},cookie)).json().conversation;
  const taskBase=`${base}/conversations/${conversation.id}/tasks`;
  const created=await call('POST',planned?taskBase.replace(/tasks$/,'todos'):taskBase,{operationId:'one',input:'Synthetic text-only task'},cookie);assert.equal(created.statusCode,planned?201:202,created.body);let task=created.json().task;
  if(planned){assert.equal(task.run,null);const started=await call('POST',taskBase+'/'+task.id+'/start',{operationId:'user-explicit-start',expectedVersion:task.version},cookie);assert.equal(started.statusCode,200,started.body);task=started.json().task;}
  if(queuedSupplement){const updated=await call('POST',`${taskBase}/${task.id}/input`,{operationId:'queued-refinement',expectedVersion:task.version,input:'Use the latest queued requirement'},cookie);assert.equal(updated.statusCode,200,updated.body);task=updated.json().task;assert.equal(task.inputRevision,2);assert.equal(task.actionReceipt.deliveryMode,'dispatch_input');}
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url).includes('/v2/materials/')){
      if(String(url).endsWith('/missing'))return Response.json({missing:JSON.parse(options.body)});
      if(String(url).includes('/blobs/'))return Response.json({status:'stored'});
      const body=JSON.parse(options.body);return Response.json({version:1,status:'prepared',configurationId:body.configurationId,prepared:body.configurationId,hostId:'fixed-host-instance'});
    }
    const request=JSON.parse(options.body);records.push({method:String(url).split('/').at(-1),request});assert.equal(options.headers.authorization,`Bearer ${hostToken}`);
    const runtime={workspaceId:user.workspace.id,entityId:entity.id,runtimeId:'local-pi'};let value;
    switch(records.at(-1).method){
      case 'capabilities':value={runtime,runtimeVersion:'fixture-v1',available:{status:'supported'},roles:[{role:'execution',support:{status:'supported'},thinkingLevels:Object.fromEntries(['none','low','medium','high'].map(level=>[level,{status:'supported'}])),capabilities:{appendInput:{status:'unsupported'},cancel:{status:'supported'}}}]};break;
      case 'prepareAgent':value={runtime,opaqueHandle:'prepared',specId:request.payload.spec.specId,specHash:request.payload.spec.specHash,role:'execution',isolationScope:{scopeId:task.run.id,authorizationRef:task.run.id,configRevision:'1'},createdAt:new Date().toISOString(),appliedConfigReportRef:'report'};break;
      case 'createSession':value={runtime,sessionId:request.payload.sessionId,opaqueHandle:'session',preparedAgentHandle:'prepared',specHash:request.payload.handle.specHash,configRevision:'1',role:'execution',scope:{kind:'execution',taskId:task.id,runId:task.run.id}};break;
      case 'submit':{
        const command=JSON.parse(db.prepare('SELECT command_json FROM task_host_bindings WHERE run_id=?').get(task.run.id).command_json);
        assert.equal(request.payload.input.taskInput.revision,command.inputRevision,'Host submit must use the actual dispatched input revision');assert.equal(command.inputRevision,task.inputRevision);
        assert.deepEqual(request.payload.input.taskInput.inputRef,{resourceId:`input:${task.run.id}:${command.inputRevision}`,version:String(command.inputRevision)});
        return Response.json({status:'accepted'});
      }
      case 'events':value=[];break;
      case 'cancel':value={status:'confirmed'};break;
      case 'getStatus':value={status:'succeeded'};break;
      default:throw Error('Unexpected test method');
    }
    return Response.json({ok:true,value});
  });
  await service.tick();
  const context=records.find(r=>r.method==='submit').request.authorizationContext;
  const internal=(path,payload,token=resolverToken)=>app.inject({method:'POST',url:'/internal/runtime/'+path,payload,headers:{authorization:`Bearer ${token}`}});
  return {app,service,db,records,task,context,internal,profile,profiles,profileInput,call,cookie,base,taskBase};
}
test('trusted host facade maps shared DTOs and callbacks reject forged identity, scope, role and missing context',async t=>{
  const s=await setup(t);assert.deepEqual(s.records.slice(0,4).map(r=>r.method),['capabilities','prepareAgent','createSession','submit']);
  const request=s.records.find(r=>r.method==='submit').request;
  assert.deepEqual((await s.internal('verify',{request})).json(),{verified:true});
  assert.deepEqual((await s.internal('verify',{request:{...request,payload:{...request.payload,execution:{...request.payload.execution,sessionId:'foreign'}}}})).json(),{verified:false});
  const missing={workspaceId:s.context.workspaceId,entityId:s.context.entityId,authorizationRef:s.context.authorizationRef,expiresAt:s.context.expiresAt};
  assert.equal((await s.internal('model',{ref:{resourceId:s.profile.id,version:'1'},context:missing})).statusCode,403);
  assert.equal((await s.internal('content',{ref:{resourceId:`input:${s.task.run.id}:1`,version:'1'},context:{...s.context,invocationId:'foreign'}})).statusCode,403);
  assert.equal((await s.internal('content',{ref:{resourceId:`input:${s.task.run.id}:1`,version:'1'},context:s.context},'wrong-token')).statusCode,401);
  const content=await s.internal('content',{ref:{resourceId:`input:${s.task.run.id}:1`,version:'1'},context:s.context});assert.equal(content.statusCode,200,content.body);assert.equal(content.json().text,'Synthetic text-only task');
  const instructions=await s.internal('content',{ref:{resourceId:`instructions:${s.task.run.id}`,version:'1'},context:s.context});assert.equal(instructions.statusCode,200);assert.doesNotMatch(instructions.json().text,/Runtime|Adapter|Session|Dentity|DENTITY|能力包|装配|Skill|local-mock|合成业务/i);assert.match(instructions.json().text,/read-only/);assert.match(instructions.json().text,/uncertain effects/);
  const secret=await s.internal('model',{ref:{resourceId:s.profile.id,version:'1'},context:s.context});assert.equal(secret.statusCode,200,secret.body);assert.equal(secret.json().apiKey,'synthetic-credential-no-provider-access');assert.deepEqual(Object.keys(secret.json()).sort(),['apiKey','baseUrl','modelId','provider'],'Execution host DTO carries execution settings only');
  assert.equal(s.records.find(r=>r.method==='prepareAgent').request.payload.spec.thinkingLevel,'medium');
  const output=await s.internal('output',{text:'Synthetic output',context:s.context});assert.equal(output.statusCode,200,output.body);assert.equal((await s.internal('content',{ref:output.json().ref,context:s.context})).json().text,'Synthetic output');
  s.db.prepare('UPDATE entities SET own_web_use=0').run();assert.equal((await s.internal('model',{ref:{resourceId:s.profile.id,version:'1'},context:s.context})).statusCode,200,'existing execution keeps admitted snapshot');
});
test('host completion before cancel is reconciled rather than misreported canceled',async t=>{
  const s=await setup(t);const current=(await s.call('GET',s.taskBase+`/${s.task.id}`,undefined,s.cookie)).json().task;
  await s.call('POST',s.taskBase+`/${s.task.id}/cancel`,{operationId:'cancel',expectedVersion:current.version},s.cookie);await s.service.tick();
  const result=(await s.call('GET',s.taskBase+`/${s.task.id}`,undefined,s.cookie)).json().task;assert.equal(result.status,'cancel_requested');assert.ok(s.records.some(r=>r.method==='getStatus'));
});
test('host capability evidence is cached for DTO reads, expires and is bound to persisted host identity',async t=>{
 const s=await setup(t);const read=()=>s.call('GET',s.taskBase+`/${s.task.id}`,undefined,s.cookie);let task=(await read()).json().task;assert.equal(task.actionCapabilities.status,'known');assert.equal(task.availableActions.cancel.available,true);assert.equal(task.availableActions.supplement.runtimeDelivery.support,'unsupported');assert.equal(task.availableActions.supplement.mode,'platform_record_only');
 const before=s.records.filter(r=>r.method==='capabilities').length;await read();await read();assert.equal(s.records.filter(r=>r.method==='capabilities').length,before,'Rendering tasks must not contact the host');
 const cached=s.db.prepare('SELECT json FROM task_runtime_capabilities WHERE run_id=?').get(s.task.run.id);s.db.prepare('UPDATE task_runtime_capabilities SET json=? WHERE run_id=?').run(JSON.stringify({...JSON.parse(cached.json),expiresAt:0}),s.task.run.id);assert.equal((await read()).json().task.actionCapabilities.status,'unknown');
 await s.service.runtime.refreshCapabilities(s.task.run.id);assert.equal((await read()).json().task.actionCapabilities.status,'known');
 s.db.prepare("UPDATE task_host_bindings SET host_url='http://127.0.0.1:9999' WHERE run_id=?").run(s.task.run.id);const calls=s.records.length;await s.service.runtime.refreshCapabilities(s.task.run.id);task=(await read()).json().task;assert.equal(task.actionCapabilities.status,'unknown');assert.equal(task.availableActions.cancel.available,false);assert.equal(s.records.length,calls,'Never route old-run capability discovery to a different host');
});
test('mismatched host capability scope clears evidence instead of granting task actions',async t=>{
 const s=await setup(t);const original=globalThis.fetch;t.mock.method(globalThis,'fetch',async(url,options)=>String(url).endsWith('/v1/capabilities')?Response.json({ok:true,value:{runtime:{workspaceId:'other',entityId:'other',runtimeId:'local-pi'},runtimeVersion:'untrusted',available:{status:'supported'},roles:[{role:'execution',support:{status:'supported'},capabilities:{cancel:{status:'supported'}}}]}}):original(url,options));
 await s.service.runtime.refreshCapabilities(s.task.run.id);assert.equal(s.service.runtime.capabilities(s.task.run.id),undefined);const task=(await s.call('GET',s.taskBase+`/${s.task.id}`,undefined,s.cookie)).json().task;assert.equal(task.availableActions.cancel.reason,'runtime_capability_unknown');
});

test('effective profile replacement or revocation denies old credentials without stranding reconciliation',async t=>{
 const s=await setup(t);const request=s.records.find(r=>r.method==='submit').request;
 const binding=s.db.prepare('SELECT profile_id,profile_source,revision,binding_revision,command_json FROM task_host_bindings WHERE run_id=?').get(s.task.run.id);
 assert.deepEqual(JSON.parse(s.context.configRevision),[binding.profile_source,binding.profile_id,binding.revision,binding.binding_revision,'medium']);assert.equal(binding.profile_source,'workspace_default');
 const readCredential=()=>s.internal('model',{ref:{resourceId:s.profile.id,version:String(s.profile.configRevision)},context:s.context});
 assert.equal((await readCredential()).statusCode,200);
 // Initially inherit the workspace default, then select a distinct catalog model for this employee.
 const selected=s.profiles.save(s.context.workspaceId,s.context.entityId,{...s.profileInput,modelId:'replacement-fixture-model'});
 assert.notEqual(selected.id,s.profile.id);assert.notEqual((await readCredential()).statusCode,200);
 const preparesBefore=s.records.filter(r=>r.method==='prepareAgent').length;assert.deepEqual(await s.service.runtime.dispatch(JSON.parse(binding.command_json)),{status:'accepted'});assert.equal(s.records.filter(r=>r.method==='prepareAgent').length,preparesBefore,'Already admitted execution retries only its fixed prepared Session, never provisions the replacement model');
 assert.deepEqual((await s.internal('verify',{request:{...request,authorizationContext:{...request.authorizationContext,configRevision:'forged-current-binding'}}})).json(),{verified:false});
 // Historical run authority survives model revocation for cancellation, status and durable results.
 const statusRequest={...request,payload:{execution:request.payload.execution}};
 assert.deepEqual((await s.internal('verify',{request:statusRequest})).json(),{verified:true});
 assert.deepEqual((await s.internal('verify',{request:{...statusRequest,payload:{...statusRequest.payload,reason:'User requested cancellation'}}})).json(),{verified:true});
 const output=await s.internal('output',{text:'Final historical run output',context:s.context});assert.equal(output.statusCode,200,output.body);
 assert.equal((await s.internal('content',{ref:output.json().ref,context:s.context})).json().text,'Final historical run output');
 s.profiles.select(s.context.workspaceId,s.context.entityId,null);
 assert.notEqual((await readCredential()).statusCode,200,'Returning to the same catalog default must not restore a revoked binding generation');
 s.profiles.saveWorkspace(s.context.workspaceId,{...s.profileInput,enabled:false});
 assert.notEqual((await readCredential()).statusCode,200);
 assert.deepEqual((await s.internal('verify',{request:statusRequest})).json(),{verified:true});
});


test('queued latest input is the exact revision and content submitted to the host',async t=>{
 const s=await setup(t,{queuedSupplement:true}),submit=s.records.find(r=>r.method==='submit').request;
 assert.equal(submit.payload.input.taskInput.revision,2);
 const content=await s.internal('content',{ref:submit.payload.input.taskInput.inputRef,context:s.context});assert.equal(content.statusCode,200,content.body);
 assert.equal(content.json().text,'Synthetic text-only task\n\n补充要求：\nUse the latest queued requirement');
 assert.equal(s.records.filter(r=>r.method==='submit').length,1);assert.equal(s.records.some(r=>r.method==='appendInput'),false,'Pre-dispatch supplement belongs in initial submit, not a second delivery');
});

test('bound execution level survives employee edits, dispatch retry and facade reconstruction',async t=>{
 const s=await setup(t),binding=s.db.prepare('SELECT spec_json,command_json FROM task_host_bindings WHERE run_id=?').get(s.task.run.id),before=JSON.parse(binding.spec_json);
 const changed=await s.call('PATCH',s.base,{executionThinkingLevel:'high'},s.cookie);assert.equal(changed.statusCode,200,changed.body);
 assert.equal((await s.call('GET',s.base+'/configuration',undefined,s.cookie)).json().entity.executionThinkingLevel,'high');
 const {HttpTaskRuntime}=await import('../dist/runtime-http.js');const previous=s.service.runtime;
 const restored=new HttpTaskRuntime(previous.store,previous.profiles,previous.config,previous.now,previous.tasks);
 assert.deepEqual(await restored.dispatch(JSON.parse(binding.command_json)),{status:'accepted'});
 assert.deepEqual(JSON.parse(s.db.prepare('SELECT spec_json FROM task_host_bindings WHERE run_id=?').get(s.task.run.id).spec_json),before);
 assert.equal(before.thinkingLevel,'medium');assert.equal(s.records.filter(r=>r.method==='prepareAgent').length,1);
});

test('unknown execution thinking capabilities reject before provisioning without downgrade',async t=>{
 const s=await setup(t),binding=s.db.prepare('SELECT command_json FROM task_host_bindings WHERE run_id=?').get(s.task.run.id),before=s.records.filter(r=>r.method==='submit').length;
 const original=globalThis.fetch;t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(String(url).endsWith('/v1/capabilities'))return Response.json({ok:true,value:{runtime:{workspaceId:s.context.workspaceId,entityId:s.context.entityId,runtimeId:'local-pi'},runtimeVersion:'unknown-thinking',available:{status:'supported'},roles:[{role:'execution',support:{status:'supported'},capabilities:{}}]}});
  return original(url,options);
 });
 assert.deepEqual(await s.service.runtime.dispatch(JSON.parse(binding.command_json)),{status:'rejected'});assert.equal(s.records.filter(r=>r.method==='submit').length,before);
});

test('persisted prepared version survives facade restart and later model edits without switching the admitted task',async t=>{
 const s=await setup(t),before=s.db.prepare('SELECT configuration_id,command_json,spec_json FROM task_host_bindings WHERE run_id=?').get(s.task.run.id);assert.match(before.configuration_id,/^[a-f0-9]{64}$/);
 s.profiles.saveWorkspace(s.context.workspaceId,{...s.profileInput,modelId:'future-only-model'});
 const {HttpTaskRuntime}=await import('../dist/runtime-http.js');const old=s.service.runtime,restored=new HttpTaskRuntime(old.store,old.profiles,old.config,old.now,old.tasks);
 assert.deepEqual(await restored.dispatch(JSON.parse(before.command_json)),{status:'accepted'});
 const after=s.db.prepare('SELECT configuration_id,spec_json FROM task_host_bindings WHERE run_id=?').get(s.task.run.id);assert.equal(after.configuration_id,before.configuration_id);assert.equal(after.spec_json,before.spec_json);
});

test('pending material refresh is durable and cannot block event polling or redispatch a task',{timeout:10000},async t=>{
 const s=await setup(t),runtime=s.service.runtime,id='11111111-1111-4111-8111-111111111111';let release,reads=0;const gate=new Promise(resolve=>release=resolve);const bytes=Buffer.from('Ready after preparation');const {createHash}=await import('node:crypto');
 runtime.setAssetService({async revalidateBusinessResourcesForRun(){},listForRun(){return[{assetId:id,kind:'file'}];},async streamForRun(_scope,_id,kind){reads++;if(kind!=='content')return{state:'not_available'};await gate;return new Response(bytes,{headers:{'x-asset-sha256':createHash('sha256').update(bytes).digest('hex'),'content-type':'text/plain'}});}});
 s.db.prepare('UPDATE task_host_bindings SET material_pending_revision=1 WHERE run_id=?').run(s.task.run.id);
 const submits=s.records.filter(r=>r.method==='submit').length;assert.deepEqual(await runtime.events(s.task.run.id,0),[]);assert.equal(s.db.prepare('SELECT material_pending_revision FROM task_host_bindings WHERE run_id=?').get(s.task.run.id).material_pending_revision,1);
 release();for(let i=0;i<100;i++){if(s.db.prepare('SELECT material_pending_revision FROM task_host_bindings WHERE run_id=?').get(s.task.run.id).material_pending_revision===null)break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(s.db.prepare('SELECT material_pending_revision FROM task_host_bindings WHERE run_id=?').get(s.task.run.id).material_pending_revision,null);await runtime.events(s.task.run.id,0);assert.equal(reads,3);assert.equal(s.records.filter(r=>r.method==='submit').length,submits);
});

test('same URL with a replaced Host identity cannot replay an old admitted execution',async t=>{
 const s=await setup(t),before=s.records.filter(r=>r.method==='submit').length,binding=s.db.prepare('SELECT host_instance_id,command_json FROM task_host_bindings WHERE run_id=?').get(s.task.run.id);assert.equal(binding.host_instance_id,'fixed-host-instance');
 const original=globalThis.fetch;t.mock.method(globalThis,'fetch',async(url,options)=>{if(String(url).endsWith('/v2/materials/inspect'))return Response.json({version:1,prepared:JSON.parse(options.body).configurationId,hostId:'replacement-host'});return original(url,options);});
 await assert.rejects(()=>s.service.runtime.dispatch(JSON.parse(binding.command_json)),e=>e.code==='runtime_host_replaced_unknown');assert.equal(s.records.filter(r=>r.method==='submit').length,before);
});

test('configuration prefetch caches independent resource versions without creating sessions or granting a union',async t=>{
 const s=await setup(t),runtime=s.service.runtime,known=new Set();let prepared=0,resources=0;
 runtime.tasks.preparationResources=()=>({skills:[],mcpServers:[{serverRef:'versioned',version:'1',allowedTools:['read']},{serverRef:'versioned',version:'2',allowedTools:['write']}]});
 runtime.tasks.mcp=async(_w,ref)=>{resources++;return{serverRef:ref.resourceId,version:ref.version,endpoint:'http://127.0.0.1:4545',tools:[]};};
 const original=globalThis.fetch;t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(String(url).endsWith('/v2/materials/inspect')){const id=JSON.parse(options.body).configurationId;return known.has(id)?Response.json({version:1,prepared:id,hostId:'fixed-host-instance'}):Response.json({error:'missing'},{status:409});}
  if(String(url).endsWith('/v2/materials/configuration')){const body=JSON.parse(options.body);known.add(body.configurationId);prepared++;assert.equal(body.mcp.length,2);return Response.json({version:1,prepared:body.configurationId,hostId:'fixed-host-instance'});}
  return original(url,options);
 });
 const invokes=s.records.filter(r=>['createSession','submit'].includes(r.method)).length;await runtime.prepareConfigured();await runtime.prepareConfigured();assert.equal(prepared,1);assert.equal(resources,2);assert.equal(s.records.filter(r=>['createSession','submit'].includes(r.method)).length,invokes);assert.ok(runtime.preparation(s.context.workspaceId,s.context.entityId).prepared);
});

test('prepared input/context manifest survives source retention and old revision retries',async t=>{
 const s=await setup(t),runtime=s.service.runtime,binding=s.db.prepare('SELECT command_json,materials_json FROM task_host_bindings WHERE run_id=?').get(s.task.run.id);const retained=JSON.parse(binding.materials_json);assert.equal(retained.inputRevision,1);assert.ok(retained.packet.contents.length>=3);
 runtime.tasks.retainedMessage=()=>{throw Error('Source conversation was retained independently');};runtime.tasks.input=()=>{throw Error('Must reuse the immutable material version');};
 assert.deepEqual(await runtime.dispatch(JSON.parse(binding.command_json)),{status:'accepted'});assert.deepEqual(JSON.parse(s.db.prepare('SELECT materials_json FROM task_host_bindings WHERE run_id=?').get(s.task.run.id).materials_json).packet.contents,retained.packet.contents);
});


test('runtime repeated prepare heals real Host resource loss from retained CAS without fetching resources again',async t=>{
 const s=await setup(t),runtime=s.service.runtime,dir=await mkdtemp(join(tmpdir(),'passive-heal-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const {PassiveMaterials}=await import('../../runtime-host-pi/dist/materials.js'),{PiRuntimeAdapter}=await import('../../runtime-host-pi/dist/adapter.js'),{createServer:hostServer}=await import('../../runtime-host-pi/dist/server.js');
 const materials=new PassiveMaterials(join(dir,'materials')),adapter=new PiRuntimeAdapter(join(dir,'state'),materials,{start(){throw Error('Prepare must never start a task');}}),host=hostServer({token:hostToken,adapter});t.after(()=>host.close());
 let resourceReads=0,uploads=0,config;const uploaded=[];
 runtime.tasks.preparationResources=()=>({skills:[],mcpServers:[{serverRef:'exact-resource',version:'1',allowedTools:['read']}]});
 runtime.tasks.mcp=async()=>{resourceReads++;return{serverRef:'exact-resource',version:'1',endpoint:'http://127.0.0.1:4545',tools:[]};};
 const original=globalThis.fetch;t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(!String(url).includes('/v2/materials/'))return original(url,options);
  const route=new URL(url).pathname;if(route.includes('/blobs/')){uploads++;uploaded.push(route.split('/').at(-1));}if(route.endsWith('/configuration'))config=JSON.parse(options.body);
  const response=await host.inject({method:options.method,url:route,headers:options.headers,payload:route.includes('/blobs/')?Buffer.from(options.body):options.body});
  return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
 });
 await runtime.prepareConfigured();assert.ok(config);assert.equal(resourceReads,1);assert.equal(uploads,1);assert.equal(runtime.preparation(s.context.workspaceId,s.context.entityId).prepared,config.configurationId);
 await runtime.prepareConfigured();assert.equal(uploads,1,'unchanged cache hits must not upload');assert.equal(resourceReads,1);
 const path=join(dir,'materials','blob-'+config.mcp[0].blob.sha256);await rm(path);assert.equal(materials.inspect(config.configurationId).prepared,null);
 await runtime.prepareConfigured();assert.equal(uploads,2);assert.equal(resourceReads,1,'repair reads exact local CAS, not newer platform definitions');assert.equal(materials.inspect(config.configurationId).prepared,config.configurationId);
 await writeFile(path,'corrupt');await runtime.prepareConfigured();assert.equal(uploads,3);assert.equal(resourceReads,1);assert.equal(materials.inspect(config.configurationId).prepared,config.configurationId);
 await runtime.prepareConfigured();assert.equal(uploads,3);assert.equal(resourceReads,1);
 // The admitted old binding can repair its exact configuration even after a model edit/restart.
 s.db.prepare('UPDATE task_host_bindings SET configuration_id=?,host_instance_id=? WHERE run_id=?').run(config.configurationId,adapter.monitorStatus().hostId,s.task.run.id);
 s.profiles.saveWorkspace(s.context.workspaceId,{...s.profileInput,modelId:'future-only'});
 const {HttpTaskRuntime}=await import('../dist/runtime-http.js'),restored=new HttpTaskRuntime(runtime.store,runtime.profiles,runtime.config,runtime.now,runtime.tasks);
 await rm(path);const binding=s.db.prepare('SELECT command_json FROM task_host_bindings WHERE run_id=?').get(s.task.run.id);assert.deepEqual(await restored.dispatch(JSON.parse(binding.command_json)),{status:'accepted'});assert.equal(materials.inspect(config.configurationId).prepared,config.configurationId);assert.equal(resourceReads,1);assert.equal(uploaded.filter(sha=>sha===config.mcp[0].blob.sha256).length,4);assert.equal(uploads,7,'Three missing immutable task inputs also transferred to the isolated Host');
});


test('instruction material includes only a trusted exact Task/Run todo start fact',async t=>{
  const s=await setup(t),ref={resourceId:`instructions:${s.task.run.id}`,version:'1'};
  const runtime=s.service.runtime;
  assert.ok(runtime?.tasks,'Runtime fixture exposes trusted internal access');
  const fact={kind:'explicit_todo_start',taskId:s.task.id,runId:s.task.run.id,operationId:'start-receipt',inputRevision:1};
  runtime.tasks.todoStartFact=()=>fact;
  const read=()=>s.internal('content',{ref,context:s.context});
  const good=await read();assert.equal(good.statusCode,200,good.body);
  assert.match(good.json().text,/explicitly started/);assert.match(good.json().text,/NOT approval/);assert.match(good.json().text,/ask_human/);
  runtime.tasks.todoStartFact=()=>({...fact,runId:'another-run'});
  const wrong=await read();assert.equal(wrong.statusCode,409);assert.match(wrong.body,/todo_start_fact_mismatch/);
  runtime.tasks.todoStartFact=()=>undefined;
  assert.doesNotMatch((await read()).json().text,/Trusted platform scheduling fact/);
});


test('real todo API start persists trusted scheduling fact into passive Host instruction material',async t=>{
 const s=await setup(t,{planned:true});
 const response=await s.internal('content',{ref:{resourceId:`instructions:${s.task.run.id}`,version:'1'},context:s.context});
 assert.equal(response.statusCode,200,response.body);const text=response.json().text;
 assert.match(text,/Trusted platform scheduling fact/);assert.match(text,/user-explicit-start/);assert.match(text,/NOT approval/);
 assert.ok(text.includes(s.task.run.id));assert.ok(text.includes(s.task.id));
 const input=await s.internal('content',{ref:{resourceId:`input:${s.task.run.id}:1`,version:'1'},context:s.context});
 assert.equal(input.statusCode,200,input.body);assert.ok(input.json().text.startsWith('Synthetic text-only task'));assert.match(input.json().text,/用户已明确启动/);assert.match(input.json().text,/不是业务审批/);
 const binding=s.db.prepare('SELECT materials_json FROM task_host_bindings WHERE run_id=?').get(s.task.run.id);
 const packet=JSON.parse(binding.materials_json).packet;
 assert.ok(packet.contents.some(c=>c.ref.resourceId===`instructions:${s.task.run.id}`));
 assert.equal(s.db.prepare('SELECT text FROM task_inputs WHERE task_id=? AND revision=1').get(s.task.id).text,'Synthetic text-only task');
});
