import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiRuntimeAdapter } from '../dist/adapter.js';
import { WorkerPiDriver } from '../dist/driver.js';
import { createServer as hostServer } from '../dist/server.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(fn, label = 'condition') { for (let n = 0; n < 600; n++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 15)); } assert.fail(`Timed out: ${label}`); }
const ref = resourceId => ({ resourceId, version: '1' });
const runtime = { runtimeId: 'local-pi', workspaceId: 'w', entityId: 'e' };
const context = { workspaceId:'w',entityId:'e',authorizationRef:'auth',expiresAt:'2099-01-01T00:00:00Z',grantRef:'g',triggerId:'t',sourceEventRef:'event',configRevision:'1',trigger:{kind:'human_request',requester:{channelType:'web',tenantId:'tenant',identityNamespace:'account',externalUserId:'user'}},sourceChannel:{channelType:'web',tenantId:'tenant',installationId:'i'},conversation:{conversationId:'c',kind:'private'} };
const management = { workspaceId:'w',entityId:'e',authorizationRef:'auth',expiresAt:context.expiresAt,authenticatedActorRef:'operator' };
let sequence = 0;
const request = (payload, authorizationContext = context) => ({ schemaVersion:1,operationId:`steer-op-${++sequence}`,correlationId:'co',causationId:'ca',deadlineAt:'2099-01-01T00:00:00Z',authorizationContext,payload });
const chunk = (delta, finish = null) => `data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
const answer = text => chunk({content:text}) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const callGate = () => chunk({tool_calls:[{index:0,id:'gate-call',type:'function',function:{name:'mcp__controlled__gate',arguments:'{}'}}]}) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const schema = {type:'object',properties:{},additionalProperties:false};
async function serve(t, handler) { const server = createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); })); return `http://127.0.0.1:${server.address().port}`; }
async function fixture(t, { toolGate = true, modelGate = false, startupGate = false, driver = new WorkerPiDriver() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-steer-'));
  // A result can precede the worker exit diagnostic. Keep its journal alive until
  // the final diagnostic is persisted, otherwise rm races a late journal rename.
  let workersStarted = 0, workersExited = 0;
  const trackedDriver = driver instanceof WorkerPiDriver ? {
    supportsSteer: driver.supportsSteer,
    start(input, emit) {
      workersStarted++;
      return driver.start(input, async event => {
        await emit(event);
        if (event.type === 'model_diagnostic' && event.diagnostic.event === 'worker_exit') workersExited++;
      });
    },
  } : driver;
  const gate = deferred(), started = deferred(), modelEntered = deferred(), startup = deferred(), resolving = deferred(), resolveInput = deferred();
  t.after(() => { gate.resolve(); startup.resolve(); resolveInput.resolve(); });
  const observations = []; let tools = 0; let authorized = true; let blockInput = false;
  const mcp = await serve(t, async (req, res) => {
    let raw=''; for await (const part of req) raw += part; const msg = raw ? JSON.parse(raw) : {};
    if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
    let result;
    if (msg.method === 'initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    else if (msg.method === 'tools/list') result={tools:[{name:'gate',description:'Wait for the isolated test gate.',inputSchema:schema}]};
    else if (msg.method === 'tools/call') { tools++; started.resolve(); await gate.promise; result={content:[{type:'text',text:'Actual controlled tool completed.'}]}; }
    else result={};
    res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}));
  });
  const model = await serve(t, async (req, res) => {
    let raw=''; for await (const part of req) raw += part;
    observations.push(JSON.parse(raw)); const index=observations.length;
    if (index===1) { modelEntered.resolve(); if (modelGate) await gate.promise; }
    res.writeHead(200, {'content-type':'text/event-stream'}); res.end(index===1&&toolGate ? callGate() : answer(`Completed request ${index}`));
  });
  const contents = new Map([['instructions','Only execute explicitly allowed tools.'],['context','Isolated context.'],['input:1','Original task.'],['input:2','Repeated extra requirement.'],['input:3','Repeated extra requirement.']]);
  const resolver = {
    verify: async () => authorized,
    content: async r => { if (r.resourceId==='input:2'&&blockInput) { resolving.resolve(); await resolveInput.promise; } if (!contents.has(r.resourceId)) throw new Error('Missing ref'); return contents.get(r.resourceId); },
    model: async () => { if (startupGate) await startup.promise; return {provider:'openai-compatible',modelId:'fixture',apiKey:'synthetic-steering-test-token',baseUrl:`${model}/v1`}; },
    storeOutput: async text => { const id=`output:${contents.size}`; contents.set(id,text); return ref(id); },
  };
  const registry={mcpServers:toolGate?[{serverRef:'controlled',endpoint:`${mcp}/mcp`,tools:[{name:'gate',description:'controlled',inputSchema:schema}]}]:[]};
  const adapter = new PiRuntimeAdapter(root,resolver,trackedDriver,'local-pi',registry); const server = hostServer({token:'synthetic-host-token',adapter}); t.after(()=>server.close());
  const call = async (method,payload,c=context) => { const response=await server.inject({method:'POST',url:`/v1/${method}`,headers:{authorization:'Bearer synthetic-host-token'},payload:request(payload,c)}); assert.equal(response.statusCode,200,response.body); return response.json(); };
  const spec={workspaceId:'w',entityId:'e',specVersion:1,specId:'steer',specHash:'hash',agentBindingId:'b',role:'execution',sourceVersions:{definition:'1',entityConfig:'1',profile:'1'},instructions:ref('instructions'),modelProfileRef:ref('profile'),skills:[],mcpServers:toolGate?[{serverRef:'controlled',allowedTools:['gate']}]:[],cliRequirements:[],platformTools:[],knowledgeScopes:[],contextPolicyRef:'p',authorizationRef:'auth',limits:{timeoutSeconds:30,maxConcurrentTools:1},requiredCapabilities:['taskRun','createSession','idempotentSubmit','trustedInvocationContext'],optionalCapabilities:[]};
  const prepared=await call('prepareAgent',{runtime,spec,policy:{policyRef:'p',allowedOptionalDegradations:[],secretDelivery:'protected_only'},idempotencyKey:'prepare'},management); assert.equal(prepared.ok,true,JSON.stringify(prepared));
  const created=await call('createSession',{handle:prepared.value,sessionId:'s',contextBootstrap:{scope:{kind:'execution',taskId:'task',runId:'run'},mode:'new',snapshotId:'snap',bundleRef:ref('context'),inputRefs:[],knowledgeScopes:[],workStateViewRef:ref('context'),budget:{maxTokens:4000,maxBytes:64000},provenance:{sourceRefs:[],authorizationDecisionRef:'auth',createdAt:'2026-01-01T00:00:00Z'}},idempotencyKey:'session'}); assert.equal(created.ok,true,JSON.stringify(created));
  const execution={runtime,executionId:'exec',sessionId:'s',invocationId:'inv',target:{kind:'task_run',taskId:'task',runId:'run'}};
  const invocation={...context,sessionId:'s',invocationId:'inv',target:execution.target};
  const submit=()=>call('submit',{session:created.value,execution,input:{kind:'task_run',taskId:'task',runId:'run',taskInput:{taskId:'task',revision:1,inputRef:ref('input:1'),snapshotId:'snap'}},idempotencyKey:'submit'},invocation);
  const input=(revision,id=`input-${revision}`)=>({execution,inputId:id,input:{kind:'task_run',taskInput:{taskId:'task',revision,inputRef:ref(`input:${revision}`),snapshotId:'snap'}},idempotencyKey:id});
  const events=async()=>{const result=await call('events',{execution}); assert.equal(result.ok,true,JSON.stringify(result));return result.value;};
  const receipts=async()=> (await events()).filter(e=>e.eventType==='input_receipt').map(e=>e.payload);
  const terminal=()=>until(async()=>{const result=await call('getStatus',{execution});return result.ok&&['succeeded','failed','unknown','canceled'].includes(result.value.status)&&result.value.status;},'execution terminal');
  t.after(async()=>{
    gate.resolve();startup.resolve();resolveInput.resolve();authorized=true;
    const status=await adapter.getStatus(request({execution}));
    if(status.ok&&!['succeeded','failed','unknown','canceled'].includes(status.value.status))await adapter.cancel(request({execution,reason:'Test cleanup'}));
    await until(()=>workersExited===workersStarted,'worker exit diagnostic persisted before fixture deletion');
    await rm(root,{recursive:true,force:true});
    await rm(`${root}-execution`,{recursive:true,force:true});
  });
  return {root,resolver,driver,registry,adapter,call,submit,input,execution,invocation,gate,started,modelEntered,startup,observations,contents,events,receipts,terminal,resolving,resolveInput,setAuthorized:v=>{authorized=v;},blockInput:()=>{blockInput=true;},tools:()=>tools};
}
const userTexts = body => body.messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:m.content.map(p=>p.text).join(''));
async function nativeEntries(root) { const values=[]; const walk=async dir=>{for(const e of await readdir(dir,{withFileTypes:true})){const name=join(dir,e.name);if(e.isDirectory())await walk(name);else if(name.endsWith('.jsonl'))for(const line of (await readFile(name,'utf8')).trim().split('\n'))values.push(JSON.parse(line));}};await walk(join(root,'sessions'));return values; }

test('real SDK steers during a blocked tool, persists accepted/queued/applied and consumes repeated text once per revision in FIFO order',async t=>{
  const f=await fixture(t);assert.equal((await f.submit()).status,'accepted');await f.started.promise;
  const capability=(await f.call('capabilities',{runtime},management)).value.roles.find(r=>r.role==='execution').capabilities;for(const name of ['appendInput','steer','inputQueue','inputAppliedAck'])assert.equal(capability[name].status,'supported');
  const payload=f.input(2);const responses=await Promise.all([f.call('appendInput',payload,f.invocation),f.call('appendInput',payload,f.invocation)]);
  assert.equal(responses[0].status,'received');assert.equal(responses[0].effect,'pending');assert.equal(responses[1].status,'received');
  assert.equal((await f.call('appendInput',{...payload,input:{...payload.input,taskInput:{...payload.input.taskInput,inputRef:ref('input:3')}}},f.invocation)).status,'rejected');
  const stranger={...f.invocation,trigger:{kind:'human_request',requester:{...context.trigger.requester,externalUserId:'other'}}};assert.equal((await f.call('appendInput',f.input(3),stranger)).status,'rejected');
  assert.equal((await f.call('appendInput',f.input(3),{...f.invocation,sessionId:'other-session'})).status,'rejected');
  assert.equal((await f.call('appendInput',f.input(4),f.invocation)).status,'rejected');
  assert.equal((await f.call('appendInput',f.input(3),f.invocation)).status,'received');
  await until(async()=> (await f.receipts()).filter(r=>r.effect==='queued_steer').length===2,'both SDK queued');
  assert.equal(f.observations.length,1);assert.equal(f.tools(),1);assert.equal((await f.receipts()).some(r=>r.status==='applied'),false);
  const journal=JSON.parse(await readFile(join(f.root,'journal.json'),'utf8'));assert.equal(journal.executions[0].inputs.length,2);assert.equal(journal.executions[0].inputs.every(i=>i.receipt.effect==='queued_steer'),true);
  f.gate.resolve();assert.equal(await f.terminal(),'succeeded',JSON.stringify({events:await f.events(),journal:JSON.parse(await readFile(join(f.root,'journal.json'),'utf8')).executions.map(e=>({status:e.status,modelDiagnostics:e.modelDiagnostics,modelLifecycle:e.modelLifecycle})),modelRequests:f.observations.length}));
  const receipts=await f.receipts();assert.equal(receipts.length,6);for(const revision of [2,3])assert.deepEqual(receipts.filter(r=>r.input.inputRevision===revision).map(r=>[r.status,r.effect]),[['received','pending'],['received','queued_steer'],['applied','steered']]);assert.deepEqual(receipts.filter(r=>r.effect==='queued_steer').map(r=>r.input.inputRevision),[2,3]);assert.deepEqual(receipts.filter(r=>r.status==='applied').map(r=>r.input.inputRevision),[2,3]);
  assert.equal(f.observations.length,3);assert.equal(userTexts(f.observations[1]).filter(x=>x.includes('"revision":2')).length,1);assert.equal(userTexts(f.observations[1]).some(x=>x.includes('"revision":3')),false);assert.equal(userTexts(f.observations[2]).filter(x=>x.includes('"revision":3')).length,1);
  const applied=receipts.filter(r=>r.status==='applied');assert.notEqual(applied[0].evidence.messageEntryId,applied[1].evidence.messageEntryId);assert.equal(applied.every(r=>r.evidence.kind==='provider_request'&&r.evidence.requestId&&r.evidence.contentDigest),true);
  const entries=await nativeEntries(f.root);for(const r of applied)assert.equal(entries.find(e=>e.id===r.evidence.messageEntryId).message.role,'user');
  const result=(await f.call('getResult',{execution:f.execution})).value.result;assert.equal(result.basedOnInputRevision,3);
  assert.equal((await f.call('appendInput',payload,f.invocation)).status,'applied');assert.equal((await f.call('appendInput',f.input(4),f.invocation)).status,'rejected');
  const persisted=await readFile(join(f.root,'journal.json'),'utf8');assert.equal(persisted.includes('synthetic-steering-test-token'),false);
});

test('input accepted while initial dispatch is preparing reaches the same real worker without replacing the original execution',async t=>{
  const f=await fixture(t,{toolGate:false,startupGate:true});await f.submit();
  assert.equal((await f.call('appendInput',f.input(2),f.invocation)).effect,'pending');assert.equal(f.observations.length,0);
  f.startup.resolve();assert.equal(await f.terminal(),'succeeded',JSON.stringify({events:await f.events(),journal:JSON.parse(await readFile(join(f.root,'journal.json'),'utf8')).executions.map(e=>({status:e.status,modelDiagnostics:e.modelDiagnostics,modelLifecycle:e.modelLifecycle})),modelRequests:f.observations.length}));
  const applied=(await f.receipts()).filter(r=>r.status==='applied');assert.equal(applied.length,1);assert.equal((await f.call('getResult',{execution:f.execution})).value.result.basedOnInputRevision,2);
  assert.equal(f.observations.some(b=>userTexts(b).some(x=>x.includes('"revision":2'))),true);assert.equal(JSON.parse(await readFile(join(f.root,'journal.json'),'utf8')).executions.length,1);
});

test('a supplement queued before a slow final response is consumed at a safe boundary instead of being lost at completion',async t=>{
  const f=await fixture(t,{toolGate:false,modelGate:true});await f.submit();await f.modelEntered.promise;
  await f.call('appendInput',f.input(2),f.invocation);await until(async()=> (await f.receipts()).some(r=>r.effect==='queued_steer'),'SDK queued while response blocked');
  assert.equal((await f.receipts()).some(r=>r.status==='applied'),false);f.gate.resolve();assert.equal(await f.terminal(),'succeeded',JSON.stringify({events:await f.events(),journal:JSON.parse(await readFile(join(f.root,'journal.json'),'utf8')).executions.map(e=>({status:e.status,modelDiagnostics:e.modelDiagnostics,modelLifecycle:e.modelLifecycle})),modelRequests:f.observations.length}));
  assert.equal(f.observations.length,2);assert.equal((await f.call('getResult',{execution:f.execution})).value.result.basedOnInputRevision,2);
});

test('completion wins an unresolved input-ref race: reject live delivery and keep the result on its actual consumed revision',async t=>{
  const f=await fixture(t,{toolGate:false,modelGate:true});await f.submit();await f.modelEntered.promise;f.blockInput();
  const append=f.call('appendInput',f.input(2),f.invocation);await f.resolving.promise;f.gate.resolve();assert.equal(await f.terminal(),'succeeded',JSON.stringify({events:await f.events(),journal:JSON.parse(await readFile(join(f.root,'journal.json'),'utf8')).executions.map(e=>({status:e.status,modelDiagnostics:e.modelDiagnostics,modelLifecycle:e.modelLifecycle})),modelRequests:f.observations.length}));
  f.resolveInput.resolve();assert.equal((await append).status,'rejected');assert.equal((await f.receipts()).length,0);assert.equal((await f.call('getResult',{execution:f.execution})).value.result.basedOnInputRevision,1);assert.equal(f.observations.length,1);
});

test('revocation after queueing prevents the next request and never claims applied; restored queued receipts become unknown without replay',async t=>{
  const f=await fixture(t);await f.submit();await f.started.promise;await f.call('appendInput',f.input(2),f.invocation);await until(async()=> (await f.receipts()).some(r=>r.effect==='queued_steer'),'queued');
  const copy=await mkdtemp(join(tmpdir(),'pi-steer-restored-'));t.after(()=>rm(copy,{recursive:true,force:true}));await writeFile(join(copy,'journal.json'),await readFile(join(f.root,'journal.json')));
  let starts=0;const restored=new PiRuntimeAdapter(copy,f.resolver,{supportsSteer:true,start(){starts++;throw new Error('Must not replay');}},'local-pi',f.registry);
  const replay=await restored.appendInput(request(f.input(2),f.invocation));assert.equal(replay.status,'unknown');assert.equal(starts,0);const after=(await restored.events(request({execution:f.execution}))).value;assert.equal(after.some(e=>e.eventType==='input_receipt'&&e.payload.status==='applied'),false);
  f.setAuthorized(false);f.gate.resolve();await until(async()=>JSON.parse(await readFile(join(f.root,'journal.json'),'utf8')).executions[0].status==='unknown','revoked execution terminal');f.setAuthorized(true);
  assert.equal(f.observations.length,1);assert.equal((await f.receipts()).some(r=>r.status==='applied'),false);assert.equal((await f.receipts()).at(-1).status,'unknown');
  const entries=await nativeEntries(f.root);assert.equal(entries.some(e=>e.type==='message'&&e.message.role==='user'&&JSON.stringify(e.message.content).includes('revision')),true,'Even a persisted native user-message event is insufficient without the authorized serialized request boundary');
});

test('a driver without live append advertises unsupported and never reports accepted or applied',async t=>{
  let finish;const fake={start(){return {done:new Promise(r=>{finish=r;}),cancel:async()=>{finish('');return 'confirmed';}};}};
  const f=await fixture(t,{toolGate:false,driver:fake});await f.submit();await until(async()=> (await f.call('getStatus',{execution:f.execution})).value.status==='running');
  assert.equal((await f.call('appendInput',f.input(2),f.invocation)).status,'unsupported');const caps=(await f.call('capabilities',{runtime},management)).value.roles.find(r=>r.role==='execution').capabilities;assert.equal(caps.appendInput.status,'unsupported');finish('fixture');assert.equal(await f.terminal(),'succeeded',JSON.stringify({events:await f.events(),journal:JSON.parse(await readFile(join(f.root,'journal.json'),'utf8')).executions.map(e=>({status:e.status,modelDiagnostics:e.modelDiagnostics,modelLifecycle:e.modelLifecycle})),modelRequests:f.observations.length}));assert.equal((await f.receipts()).length,0);
});


test('cancel accepted during initial resource preparation prevents any later worker or model start',async t=>{const f=await fixture(t,{toolGate:false,startupGate:true});await f.submit();const receipt=await f.call('cancel',{execution:f.execution,reason:'Synthetic cancellation before worker'},f.invocation);assert.equal(receipt.value.status,'confirmed');f.startup.resolve();await new Promise(r=>setTimeout(r,50));assert.equal(f.observations.length,0);assert.equal((await f.call('getStatus',{execution:f.execution})).value.status,'canceled');});
