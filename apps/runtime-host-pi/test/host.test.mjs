import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiRuntimeAdapter } from '../dist/adapter.js';
import { createServer } from '../dist/server.js';
import { invocationEnvironment } from '../dist/environment.js';
const runtime = {runtimeId:'local-pi',workspaceId:'w',entityId:'e'};
const context = {workspaceId:'w',entityId:'e',authorizationRef:'auth',expiresAt:'2099-01-01T00:00:00Z',grantRef:'g',triggerId:'t',sourceEventRef:'event',configRevision:'1',trigger:{kind:'human_request',requester:{channelType:'web',tenantId:'tenant',identityNamespace:'account',externalUserId:'user'}},sourceChannel:{channelType:'web',tenantId:'tenant',installationId:'i'},conversation:{conversationId:'c',kind:'private'}};
const management = {workspaceId:'w',entityId:'e',authorizationRef:'auth',expiresAt:context.expiresAt,authenticatedActorRef:'operator'};
const ref = resourceId => ({resourceId,version:'1'});
const spec = {workspaceId:'w',entityId:'e',specVersion:1,specId:'spec',specHash:'hash',agentBindingId:'binding',role:'execution',sourceVersions:{definition:'1',entityConfig:'1',profile:'1'},instructions:ref('instructions'),modelProfileRef:ref('profile'),skills:[],mcpServers:[],cliRequirements:[],platformTools:[],knowledgeScopes:[],contextPolicyRef:'policy',authorizationRef:'auth',limits:{timeoutSeconds:30,maxConcurrentTools:1},requiredCapabilities:['taskRun','createSession','idempotentSubmit','trustedInvocationContext'],optionalCapabilities:[]};
const policy = {policyRef:'policy',allowedOptionalDegradations:[],secretDelivery:'protected_only'};
const bootstrap = {scope:{kind:'execution',taskId:'task',runId:'run'},mode:'new',snapshotId:'snapshot',bundleRef:ref('context'),inputRefs:[],knowledgeScopes:[],workStateViewRef:ref('work'),budget:{maxTokens:1000,maxBytes:4096},provenance:{sourceRefs:[],authorizationDecisionRef:'auth',createdAt:'2026-01-01T00:00:00Z'}};
let sequence = 0;
const request = (payload,authorizationContext=context) => ({schemaVersion:1,operationId:`op${++sequence}`,correlationId:'co',causationId:'ca',deadlineAt:'2099-01-01T00:00:00Z',authorizationContext,payload});
class FakePiDriver {
  starts=[]; mode='finish';
  start(input,emit) { this.starts.push(input); let doneResolve; const done = new Promise(resolve=>{doneResolve=resolve;}); this.finish=async()=>{if(this.progress)await emit({type:'progress',text:'Business progress'});await emit({type:'output_delta',text:'Hello'});doneResolve('Final answer');}; if(this.mode==='finish')queueMicrotask(()=>this.finish()); return {done,cancel:async()=>{if(this.mode==='requested')return 'requested';doneResolve('');return 'confirmed';}}; }
}
async function fixture(t,capacity=4) {
 const directory=await mkdtemp(join(tmpdir(),'pi-host-test-'));t.after(async()=>{await rm(directory,{recursive:true,force:true});await rm(`${directory}-execution`,{recursive:true,force:true});});
 const driver=new FakePiDriver();const output=[];
 const resolver={verify:async r=>r.authorizationContext.workspaceId==='w',content:async r=>r.resourceId==='instructions'?'Be useful':'Input',model:async()=>({provider:'test',modelId:'fixture',apiKey:'test-only-not-a-real-secret'}),storeOutput:async text=>{output.push(text);return ref('output');}};
 const adapter=new PiRuntimeAdapter(directory,resolver,driver,'local-pi',undefined,capacity);const server=createServer({token:'test-bearer',adapter});t.after(()=>server.close());
 const call=async(method,payload,c=context)=>{const response=await server.inject({method:'POST',url:`/v1/${method}`,headers:{authorization:'Bearer test-bearer'},payload:request(payload,c)});assert.equal(response.statusCode,200,response.body);return response.json();};
 const prepared=await call('prepareAgent',{runtime,spec,policy,idempotencyKey:'prepare'},management);assert.equal(prepared.ok,true,JSON.stringify(prepared));
 const created=await call('createSession',{handle:prepared.value,sessionId:'s',contextBootstrap:bootstrap,idempotencyKey:'session'});assert.equal(created.ok,true,JSON.stringify(created));
 const session=created.value;const execution={runtime,executionId:'exec',sessionId:'s',invocationId:'inv',target:{kind:'task_run',taskId:'task',runId:'run'}};
 const invocation={...context,sessionId:'s',invocationId:'inv',target:execution.target};
 const payload={session,execution,input:{kind:'task_run',taskId:'task',runId:'run',taskInput:{taskId:'task',revision:1,inputRef:ref('input'),snapshotId:'snapshot'}},idempotencyKey:'submit'};
 return {directory,driver,resolver,adapter,server,call,session,execution,invocation,payload,output};
}
const settle = async (f, terminal='succeeded')=>{for(let i=0;i<100;i++){const s=await f.call('getStatus',{execution:f.execution});if(s.value.status===terminal)return;await new Promise(r=>setTimeout(r,5));}assert.fail('Did not settle');};
test('HTTP authentication, version, flat identity and unconfigured host fail closed',async t=>{
 const f=await fixture(t);
 for(const header of [undefined,'Bearer wrong']) { const r=await f.server.inject({method:'POST',url:'/v1/capabilities',headers:header?{authorization:header}:{},payload:request({runtime},management)});assert.equal(r.statusCode,401); }
 const invalid=request({runtime},management);invalid.schemaVersion=2;assert.equal((await f.server.inject({method:'POST',url:'/v1/capabilities',headers:{authorization:'Bearer test-bearer'},payload:invalid})).statusCode,400);
 const nested=request({runtime},{...context,trigger:{kind:'human_request',requester:{channel:context.sourceChannel,userId:'user'}}});assert.equal((await f.server.inject({method:'POST',url:'/v1/capabilities',headers:{authorization:'Bearer test-bearer'},payload:nested})).statusCode,400);
 const unconfigured=createServer();t.after(()=>unconfigured.close());assert.equal((await unconfigured.inject('/healthz')).statusCode,200);assert.equal((await unconfigured.inject({method:'POST',url:'/v1/capabilities',payload:request({runtime},management)})).statusCode,503);
});
test('real HTTP transport accepts exact Ports and rejects required unknown safeguards/resources',async t=>{
 const f=await fixture(t);await f.server.listen({host:'127.0.0.1',port:0});const address=f.server.server.address();const response=await fetch(`http://127.0.0.1:${address.port}/v1/capabilities`,{method:'POST',headers:{authorization:'Bearer test-bearer','content-type':'application/json'},body:JSON.stringify(request({runtime},management))});assert.equal(response.status,200);const capabilities=(await response.json()).value;assert.equal(capabilities.type,'local-pi');const executionRole=capabilities.roles.find(r=>r.role==='execution');assert.equal(executionRole.capabilities.filesystemScope.status,'unsupported');assert.equal(executionRole.capabilities.networkScope.status,'unsupported');assert.equal(executionRole.isolationLevel,'local-directory-and-worker-not-security-sandbox');
 for(const changed of [{...spec,requiredCapabilities:['filesystemScope']},{...spec,requiredCapabilities:['networkScope']},{...spec,requiredCapabilities:['protectedMcpInjection']},{...spec,cliRequirements:[{packageRef:'unreviewed'}]},{...spec,role:'interaction',mcpServers:[{serverRef:'evil',allowedTools:['*']}]}])assert.equal((await f.call('prepareAgent',{runtime,spec:changed,policy,idempotencyKey:'invalid'},management)).ok,false);
});
test('HTTP provisioning accepts executionResources as a contract field and rejects unregistered resource scope',async t=>{
 const f=await fixture(t);
 const payload=request({runtime,spec:{...spec,executionResources:[{resourceId:'not-registered',version:'1',tools:['read','bash']}]},policy},management);
 const response=await f.server.inject({method:'POST',url:'/v1/validateSpec',headers:{authorization:'Bearer test-bearer'},payload});
 assert.equal(response.statusCode,200,response.body);
 const body=response.json();assert.equal(body.ok,true);assert.equal(body.value.valid,false);
 assert.equal(body.value.fields.find(f=>f.field==='executionResources').status,'unsupported');
});
test('ordered persistent callback/final/status events, idempotency, result and fresh/resumed driver state',async t=>{
 const f=await fixture(t);assert.equal((await f.call('submit',f.payload,f.invocation)).status,'accepted');await settle(f);
 const events=(await f.call('events',{execution:f.execution})).value;assert.deepEqual(events.map(e=>e.eventType),['status_changed','status_changed','output_delta','final_result','status_changed']);assert.deepEqual(events.map(e=>e.sequence),[1,2,3,4,5]);assert.equal(new Set(events.map(e=>e.eventId)).size,5);
 assert.deepEqual((await f.call('events',{execution:f.execution,cursor:'3'})).value,events.slice(3));assert.equal((await f.call('getResult',{execution:f.execution})).value.status,'available');
 assert.equal((await f.call('submit',f.payload,f.invocation)).status,'accepted');assert.equal(f.driver.starts.length,1);assert.equal(f.driver.starts[0].resume,false);
 const restored=new PiRuntimeAdapter(f.directory,f.resolver,f.driver);assert.equal((await restored.getResult(request({execution:f.execution}))).value.status,'available');assert.equal((await restored.resumeSession(request({session:f.session}))).ok,true);
 assert.equal((await f.call('submit',{...f.payload,input:{...f.payload.input,taskInput:{...f.payload.input.taskInput,revision:2}}},f.invocation)).status,'rejected');
 assert.equal((await readFile(join(f.directory,'journal.json'),'utf8')).includes('test-only-not-a-real-secret'),false);
});
test('crash recovery becomes unknown and never dispatches again; cross-owner access rejected',async t=>{
 const f=await fixture(t);f.driver.mode='pending';await f.call('submit',f.payload,f.invocation);await settle(f,'running');
 const second=new FakePiDriver();const restored=new PiRuntimeAdapter(f.directory,f.resolver,second);
 assert.equal((await restored.getStatus(request({execution:f.execution}))).value.status,'unknown');assert.equal((await restored.submit(request(f.payload,f.invocation))).status,'unknown');assert.equal(second.starts.length,0);
 assert.equal((await restored.getResult(request({execution:f.execution},{...context,trigger:{kind:'human_request',requester:{...context.trigger.requester,externalUserId:'other'}}}))).ok,false);
 assert.equal((await restored.cancel(request({execution:f.execution,reason:'stop'}))).value.status,'unknown');
});
test('cancel requested versus confirmed and append input never falsely applied',async t=>{
 const f=await fixture(t);f.driver.mode='requested';await f.call('submit',f.payload,f.invocation);await settle(f,'running');
 assert.equal((await f.call('cancel',{execution:f.execution,reason:'stop'})).value.status,'requested');assert.equal((await f.call('getStatus',{execution:f.execution})).value.status,'cancel_requested');
 const receipt=await f.call('appendInput',{execution:f.execution,inputId:'i',input:{kind:'task_run',taskInput:f.payload.input.taskInput},idempotencyKey:'i'},f.invocation);assert.equal(receipt.status,'unsupported');
 f.driver.finish();await settle(f,'unknown');assert.equal((await f.call('getResult',{execution:f.execution})).value.status,'unknown');
});
test('trusted context env allowlist uses canonical requester and clears absent optional values',()=>{
 const a=invocationEnvironment({...context,sessionId:'s',invocationId:'i',target:{kind:'task_run',taskId:'task',runId:'run'}});assert.equal(a.DENTITY_REQUESTER_ID,'user');assert.equal(a.DENTITY_REQUESTER_NAMESPACE,'account');assert.equal(a.PATH,undefined);
 const b=invocationEnvironment({...context,sourceChannel:undefined,conversation:undefined,trigger:{kind:'configured_event',triggerBindingId:'binding'},sessionId:'new',invocationId:'new',target:{kind:'task_run',taskId:'t2',runId:'r2'}});assert.equal(b.DENTITY_REQUESTER_PRESENT,'false');assert.equal(b.DENTITY_REQUESTER_ID,undefined);assert.equal(b.DENTITY_CONVERSATION_ID,undefined);assert.equal(process.env.DENTITY_INVOCATION_ID,undefined);
});

test('business progress is stored before final event and cancel cannot relabel completed work',async t=>{const f=await fixture(t);f.driver.progress=true;await f.call('submit',f.payload,f.invocation);await settle(f);const events=(await f.call('events',{execution:f.execution})).value;assert.deepEqual(events.map(e=>e.eventType),['status_changed','status_changed','progress','output_delta','final_result','status_changed']);assert.deepEqual(f.output,['Business progress','Final answer']);assert.equal((await f.call('cancel',{execution:f.execution,reason:'late stop'})).value.status,'unknown');assert.equal((await f.call('getStatus',{execution:f.execution})).value.status,'succeeded');});
test('health readiness reports configured transport, never a verified provider',async t=>{const f=await fixture(t);const health=(await f.server.inject('/healthz')).json();assert.equal(health.executionAvailable,true);const ready=(await f.server.inject('/readyz')).json();assert.equal(ready.status,'ready');assert.equal(ready.providerConnectivity,'unverified');assert.equal(f.driver.starts.length,0);});

test('role thinking capabilities and validation distinguish four execution levels from fixed interaction none',async t=>{
 const f=await fixture(t),cap=(await f.call('capabilities',{runtime},management)).value;
 for(const role of cap.roles)for(const level of ['none','low','medium','high'])assert.equal(role.thinkingLevels[level].status,role.role==='execution'||level==='none'?'supported':'unsupported');
 for(const level of ['none','low','medium','high'])assert.equal((await f.call('validateSpec',{runtime,spec:{...spec,thinkingLevel:level},policy},management)).value.valid,true);
 for(const thinkingLevel of ['off','max',null,{},true])assert.equal((await f.call('validateSpec',{runtime,spec:{...spec,thinkingLevel},policy},management)).value.valid,false);
 assert.equal((await f.call('validateSpec',{runtime,spec:{...spec,role:'interaction',thinkingLevel:'medium'},policy},management)).value.valid,false);
 assert.equal((await f.call('validateSpec',{runtime,spec:{...spec,role:'interaction',thinkingLevel:'none'},policy},management)).value.valid,true);
});


test('bounded workers durably queue other Sessions and reacquire capacity without duplicate execution',async t=>{const f=await fixture(t,1);f.driver.mode='pending';await f.call('submit',f.payload,f.invocation);await settle(f,'running');const finishFirst=f.driver.finish;const h=(await f.call('prepareAgent',{runtime,spec,policy,idempotencyKey:'prepare'},management)).value;const target={kind:'task_run',taskId:'task',runId:'run-two'},c={...f.invocation,sessionId:'s-two',invocationId:'inv-two',target};const s=(await f.call('createSession',{handle:h,sessionId:'s-two',contextBootstrap:{...bootstrap,scope:{kind:'execution',taskId:'task',runId:'run-two'}},idempotencyKey:'session-two'},c)).value;const execution={runtime,executionId:'exec-two',sessionId:'s-two',invocationId:'inv-two',target},payload={session:s,execution,input:{kind:'task_run',taskId:'task',runId:'run-two',taskInput:{taskId:'task',revision:1,inputRef:ref('input'),snapshotId:'snapshot'}},idempotencyKey:'submit-two'};assert.equal((await f.call('submit',payload,c)).status,'accepted');assert.equal((await f.call('getStatus',{execution},c)).value.status,'queued');assert.equal(f.driver.starts.length,1);const persisted=JSON.parse(await readFile(join(f.directory,'journal.json'),'utf8'));assert.equal(persisted.executions[1].started,false);assert.equal(persisted.executions[1].status,'queued');await finishFirst();for(let i=0;i<100&&f.driver.starts.length<2;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.driver.starts.length,2);assert.equal((await f.call('submit',payload,c)).status,'accepted');assert.equal(f.driver.starts.length,2);await f.driver.finish();for(let i=0;i<100;i++){if((await f.call('getStatus',{execution},c)).value.status==='succeeded')break;await new Promise(r=>setTimeout(r,5));}assert.equal((await f.call('getStatus',{execution},c)).value.status,'succeeded');});

test('model failure diagnostics persist before worker failure, stay bounded, and do not enter business events',async t=>{
 const f=await fixture(t);const at=new Date().toISOString(),diagnostic={version:1,phase:'body',at,startedAt:at,elapsedMs:10,receivedBytes:40,httpStatus:200,abortObserved:false,timeoutObserved:false,causes:[{name:'TypeError',kind:'terminated',message:'PRIVATE_MODEL_FIELD'}],payload:'PRIVATE_MODEL_FIELD'};
 f.driver.start=(_input,emit)=>({done:(async()=>{for(let i=0;i<20;i++)await emit({type:'model_diagnostic',diagnostic:{...diagnostic,elapsedMs:i}});throw Error('synthetic worker failure');})(),cancel:async()=> 'confirmed'});
 await f.call('submit',f.payload,f.invocation);await settle(f,'unknown');const state=JSON.parse(await readFile(join(f.directory,'journal.json'),'utf8'));assert.equal(state.executions[0].modelDiagnostics.length,16);assert.equal(state.executions[0].modelDiagnostics.at(-1).elapsedMs,19);assert.equal(JSON.stringify(state).includes('PRIVATE_MODEL_FIELD'),false);const projection=f.adapter.monitorExecution(f.execution.executionId);assert.equal(projection.modelDiagnostics.length,16);assert.equal(projection.status,'unknown');assert.equal((await f.call('events',{execution:f.execution})).value.some(e=>e.eventType==='model_diagnostic'),false);
});


test('authenticated event cursor reads and durable model lifecycle are monitor facts, not business events',async t=>{
 const f=await fixture(t);await f.call('submit',f.payload,f.invocation);await settle(f);const first=await f.call('events',{execution:f.execution,cursor:'0'});assert.equal(first.ok,true);const through=first.value.at(-1).sequence,metadata=f.adapter.monitorExecution(f.execution.executionId);assert.equal(metadata.eventCursor,through);assert.deepEqual(metadata.lastEventRead,{at:metadata.lastEventRead.at,cursor:0,returnedThrough:through,count:first.value.length});const saved=JSON.parse(await readFile(join(f.directory,'journal.json'),'utf8')).executions[0];assert.deepEqual(saved.lastEventRead,metadata.lastEventRead);assert.deepEqual((await f.call('events',{execution:f.execution,cursor:String(through)})).value,[]);assert.equal(f.adapter.monitorExecution(f.execution.executionId).lastEventRead.cursor,through);
});

test('known settled provider rejection is failed while unclassified worker loss remains unknown',async t=>{
 const {ProviderInvocationError}=await import('../dist/types.js');
 for(const known of[true,false]){const f=await fixture(t);f.driver.start=()=>({done:Promise.reject(known?new ProviderInvocationError(400):Error('worker vanished')),cancel:async()=> 'confirmed'});await f.call('submit',f.payload,f.invocation);await settle(f,known?'failed':'unknown');const events=(await f.call('events',{execution:f.execution})).value;assert.equal(events.at(-1).payload.error.code,known?'REMOTE_REJECTED':'RUNTIME_UNAVAILABLE');assert.match(events.at(-1).payload.error.safeMessage,known?/Model provider rejected request \(HTTP 400\)/:/Invocation failed/);assert.equal(f.driver.starts.length,0);}
});
