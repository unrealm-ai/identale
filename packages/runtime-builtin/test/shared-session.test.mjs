import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { JsonlJournal,BuiltinInteractionRuntime } from '../dist/index.js';
const future='2099-01-01T00:00:00.000Z';
const temporaryRoots=[];after(()=>{for(const root of temporaryRoots)rmSync(root,{recursive:true,force:true});});
class SessionStore { async compareAndSetMany(changes){if(changes.some(c=>(this.records.get(c.key)?.version??null)!==c.expectedVersion))return false;for(const c of changes)this.records.set(c.key,{version:(c.expectedVersion??0)+1,value:structuredClone(c.value)});return true;} records=new Map();async get(k){return structuredClone(this.records.get(k));}async compareAndSet(k,v,value){const old=this.records.get(k);if((old?.version??null)!==v)return false;this.records.set(k,{version:(v??0)+1,value:structuredClone(value)});return true;} }
class Operations { records=new Map();async get(k){return structuredClone(this.records.get(k));}async claim(r){if(this.records.has(r.operationId))return false;this.records.set(r.operationId,structuredClone(r));return true;}async complete(k,result){const old=this.records.get(k);this.records.set(k,{...old,status:'completed',result:structuredClone(result)});} }
const runtime={workspaceId:'w',entityId:'e',runtimeId:'builtin-interaction'};
const context={workspaceId:'w',entityId:'e',authorizationRef:'auth',expiresAt:future,grantRef:'grant',triggerId:'trigger',sourceEventRef:'message',configRevision:'1',trigger:{kind:'human_request',requester:{channelType:'web',tenantId:'w',identityNamespace:'user',externalUserId:'u'}},sourceChannel:{channelType:'web',tenantId:'w',installationId:'web'},conversation:{conversationId:'c',kind:'private'}};
const request=(payload,c=context)=>({schemaVersion:1,operationId:'op',correlationId:'cor',causationId:'cause',deadlineAt:future,authorizationContext:c,payload});
const ref=resourceId=>({resourceId,version:'1'});
const tool=(execute=async()=>({taskId:'task-1',status:'queued'}))=>({name:'task_create',description:'Create task',kind:'task',parameters:{type:'object',additionalProperties:false,properties:{input:{type:'string'}},required:['input']},execute});
const response=(value={text:'Done'})=>({...value,usage:{inputTokens:5,outputTokens:2}});
async function fixture(overrides={},base=context) {
 const sessionStore=new SessionStore(),operationStore=new Operations(),outputs=[];
 const root=mkdtempSync(join(tmpdir(),'dentity-builtin-'));temporaryRoots.push(root);const journal=new JsonlJournal({root,ownerId:'test-owner',serialize:fn=>fn()});
 const options={journal,sessionStore,operationStore,tools:[tool()],modelClient:{async complete(){return response();}},authorize:async()=>true,readContent:async ref=>ref.resourceId,writeOutput:async text=>{outputs.push(text);return ref(`out-${outputs.length}`);},filterHistory:async messages=>messages,filterToolResult:async result=>result,...overrides};
 const adapter=new BuiltinInteractionRuntime(options);
 const spec={workspaceId:'w',entityId:'e',specVersion:1,specId:'spec',specHash:'hash',agentBindingId:'binding',role:'interaction',sourceVersions:{definition:'1',entityConfig:'1',profile:'1'},instructions:ref('system'),modelProfileRef:ref('model'),skills:[],mcpServers:[],cliRequirements:[],platformTools:['task_create'],knowledgeScopes:[],contextPolicyRef:'ctx',authorizationRef:'auth',limits:{timeoutSeconds:60,maxConcurrentTools:1},requiredCapabilities:[],optionalCapabilities:[]};
 const management={workspaceId:'w',entityId:'e',authorizationRef:'auth',expiresAt:future,authenticatedActorRef:'u'};
 const p=await adapter.prepareAgent(request({runtime,spec,policy:{policyRef:'policy',allowedOptionalDegradations:[],secretDelivery:'protected_only'},idempotencyKey:'prepare'},management));
 if(!p.ok)return {adapter,options,sessionStore,operationStore,outputs,prepare:p};
 const s=await adapter.createSession(request({handle:p.value,sessionId:'c',idempotencyKey:'session',contextBootstrap:{scope:{kind:'interaction',conversationId:'c'},mode:'new',snapshotId:'snap',bundleRef:ref('bundle'),inputRefs:[],knowledgeScopes:[],workStateViewRef:ref('state'),budget:{maxTokens:10000,maxBytes:10000},provenance:{sourceRefs:[],authorizationDecisionRef:'auth',createdAt:new Date().toISOString()}}},base));assert.equal(s.ok,true);
 const target={kind:'interaction_turn',conversationId:'c',turnId:'turn',epoch:1};
 const execution={runtime,executionId:'x',sessionId:'c',invocationId:'i',target};
 const invocation={...base,invocationId:'i',sessionId:'c',target};
 const submission=request({session:s.value,execution,input:{...target,messageRefs:[ref('hello')]},idempotencyKey:'turn'},invocation);
 return{adapter,options,sessionStore,operationStore,outputs,base,session:s.value,submission,execution};
}
async function finished(f){for(let i=0;i<100;i++){const result=await f.adapter.getStatus(request({execution:f.execution},f.base));assert.equal(result.ok,true);if(['succeeded','failed','canceled','unknown'].includes(result.value.status))return result.value;await new Promise(r=>setTimeout(r,1));}throw Error('No terminal status');}

const channelContext=(actor,kind='group')=>({...context,trigger:{kind:'human_request',requester:{channelType:'feishu',tenantId:'tenant',identityNamespace:'open_id',externalUserId:actor,applicationId:'app',identityEvidence:'channel_verified'}},sourceChannel:{channelType:'feishu',tenantId:'tenant',installationId:'conn'},conversation:{conversationId:'c',kind}});
function nextSubmission(f,actor,n=2){const value=structuredClone(f.submission);value.payload.execution.executionId=`x${n}`;value.payload.execution.invocationId=`i${n}`;value.payload.execution.target={...value.payload.execution.target,turnId:`turn${n}`,epoch:n};value.payload.input={...value.payload.input,turnId:`turn${n}`,epoch:n,messageRefs:[ref(`hello-${actor}`)]};value.payload.idempotencyKey=`turn${n}`;value.authorizationContext={...channelContext(actor,f.base.conversation.kind),invocationId:`i${n}`,sessionId:'c',triggerId:`trigger${n}`,sourceEventRef:`event-${n}`,target:value.payload.execution.target};return value;}
for(const kind of ['group','meeting'])test(`${kind} shares history across actors while execution results and cancellation stay actor-bound`,async()=>{
  let round=0;const captured=[],actors=[],events=[];
  const f=await fixture({tools:[tool(async(_args,c)=>{actors.push(c.trigger.requester.externalUserId);events.push(c.sourceEventRef);return {taskId:`task-${actors.length}`};})],modelClient:{async complete({messages}){captured.push(structuredClone(messages));return response(++round%2?{toolCalls:[{id:`tool-${round}`,name:'task_create',arguments:{input:'work'}}]}:{text:`answer-${round}`});}}},channelContext('alice',kind));
  assert.equal((await f.adapter.submit(f.submission)).status,'accepted');assert.equal((await finished(f)).status,'succeeded');
  const second=nextSubmission(f,'bob');
  assert.equal((await f.adapter.submit(second)).status,'accepted');
  assert.equal((await finished({...f,execution:second.payload.execution,base:second.authorizationContext})).status,'succeeded');
  assert.deepEqual(actors,['alice','bob']);assert.deepEqual(events,['message','event-2']);
  assert.ok(captured[2].some(m=>m.role==='user'&&m.content==='hello'));
  assert.ok(captured[2].some(m=>m.role==='assistant'&&m.content==='answer-2'));
  assert.ok(captured[2].some(m=>m.role==='user'&&m.content==='hello-bob'));
  const payload={execution:second.payload.execution};
  for(const method of ['getResult','getStatus','cancel']){
    const denied=await f.adapter[method](request({...payload,reason:'interrupt'},f.base));
    assert.equal(denied.ok,false);assert.equal(denied.error.code,'POLICY_DENIED');
  }
  assert.equal((await f.adapter.getResult(request(payload,second.authorizationContext))).ok,true);
  const restarted=new BuiltinInteractionRuntime(f.options);
  assert.equal((await restarted.resumeSession(request({session:f.session},second.authorizationContext))).ok,true);
});

test('private channel sessions cannot be reused by a different actor',async()=>{
  const f=await fixture({},channelContext('alice','private'));
  assert.equal((await f.adapter.submit(f.submission)).status,'accepted');await finished(f);
  const second=nextSubmission(f,'bob');
  const denied=await f.adapter.submit(second);assert.notEqual(denied.status,'accepted');assert.equal(denied.error.code,'POLICY_DENIED');
  const resumed=await f.adapter.resumeSession(request({session:f.session},second.authorizationContext));
  assert.equal(resumed.ok,false);assert.equal(resumed.error.code,'POLICY_DENIED');
});

test('shared session does not bypass current authorization for an unverified actor',async()=>{
  let modelCalls=0;const checks=[];
  const f=await fixture({authorize:async(c,action)=>{checks.push(action);return !c.trigger || c.trigger.requester.identityEvidence==='channel_verified';},modelClient:{async complete(){modelCalls++;return response();}}},channelContext('alice'));
  const forged=nextSubmission(f,'mallory');forged.authorizationContext.trigger.requester.identityEvidence='unknown';
  const denied=await f.adapter.submit(forged);
  assert.notEqual(denied.status,'accepted');assert.equal(denied.error.code,'POLICY_DENIED');assert.equal(modelCalls,0);assert.ok(checks.length>0);
});

test('existing Web private session remains resumable after runtime reconstruction',async()=>{
  const f=await fixture();assert.equal((await f.adapter.submit(f.submission)).status,'accepted');await finished(f);
  assert.equal((await new BuiltinInteractionRuntime(f.options).resumeSession(request({session:f.session},context))).ok,true);
  const other={...context,trigger:{...context.trigger,requester:{...context.trigger.requester,externalUserId:'other'}}};
  assert.equal((await new BuiltinInteractionRuntime(f.options).resumeSession(request({session:f.session},other))).ok,false);
});
