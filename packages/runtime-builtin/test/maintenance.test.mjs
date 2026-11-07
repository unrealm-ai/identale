import test, { after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { JsonlJournal,BuiltinInteractionRuntime,OpenAICompatibleModelClient } from '../dist/index.js';
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
async function fixture(overrides={}) {
 const sessionStore=new SessionStore(),operationStore=new Operations(),outputs=[];
 const root=mkdtempSync(join(tmpdir(),'dentity-builtin-'));temporaryRoots.push(root);const journal=new JsonlJournal({root,ownerId:'test-owner',serialize:fn=>fn()});
 const options={journal,sessionStore,operationStore,tools:[tool()],modelClient:{async complete(){return response();}},authorize:async()=>true,readContent:async ref=>ref.resourceId,writeOutput:async text=>{outputs.push(text);return ref(`out-${outputs.length}`);},filterHistory:async messages=>messages,filterToolResult:async result=>result,...overrides};
 const adapter=new BuiltinInteractionRuntime(options);
 const spec={workspaceId:'w',entityId:'e',specVersion:1,specId:'spec',specHash:'hash',agentBindingId:'binding',role:'interaction',sourceVersions:{definition:'1',entityConfig:'1',profile:'1'},instructions:ref('system'),modelProfileRef:ref('model'),skills:[],mcpServers:[],cliRequirements:[],platformTools:['task_create'],knowledgeScopes:[],contextPolicyRef:'ctx',authorizationRef:'auth',limits:{timeoutSeconds:60,maxConcurrentTools:1},requiredCapabilities:[],optionalCapabilities:[]};
 const management={workspaceId:'w',entityId:'e',authorizationRef:'auth',expiresAt:future,authenticatedActorRef:'u'};
 const p=await adapter.prepareAgent(request({runtime,spec,policy:{policyRef:'policy',allowedOptionalDegradations:[],secretDelivery:'protected_only'},idempotencyKey:'prepare'},management));
 if(!p.ok)return {adapter,options,sessionStore,operationStore,outputs,prepare:p};
 const s=await adapter.createSession(request({handle:p.value,sessionId:'c',idempotencyKey:'session',contextBootstrap:{scope:{kind:'interaction',conversationId:'c'},mode:'new',snapshotId:'snap',bundleRef:ref('bundle'),inputRefs:[],knowledgeScopes:[],workStateViewRef:ref('state'),budget:{maxTokens:10000,maxBytes:10000},provenance:{sourceRefs:[],authorizationDecisionRef:'auth',createdAt:new Date().toISOString()}}}));assert.equal(s.ok,true);
 const target={kind:'interaction_turn',conversationId:'c',turnId:'turn',epoch:1};
 const execution={runtime,executionId:'x',sessionId:'c',invocationId:'i',target};
 const invocation={...context,invocationId:'i',sessionId:'c',target};
 const submission=request({session:s.value,execution,input:{...target,messageRefs:[ref('hello')]},idempotencyKey:'turn'},invocation);
 return{adapter,options,sessionStore,operationStore,outputs,session:s.value,submission,execution};
}
async function finished(f){for(let i=0;i<100;i++){const result=await f.adapter.getStatus(request({execution:f.execution}));assert.equal(result.ok,true);if(['succeeded','failed','canceled','unknown'].includes(result.value.status))return result.value;await new Promise(r=>setTimeout(r,1));}throw Error('No terminal status');}
function nextSubmission(f,n,text){const value=structuredClone(f.submission);value.payload.execution.executionId=`x${n}`;value.payload.execution.invocationId=`i${n}`;value.payload.execution.target={...value.payload.execution.target,turnId:`turn${n}`,epoch:n};value.payload.input={...value.payload.input,turnId:`turn${n}`,epoch:n,messageRefs:[ref(text)]};value.payload.idempotencyKey=`turn${n}`;value.authorizationContext={...value.authorizationContext,invocationId:`i${n}`,triggerId:`trigger${n}`,target:value.payload.execution.target};return value;}

const policy={retainMessages:2,recentDays:30,maxSummaryTokens:4000,maxDailySummaryTokens:800,contextTokenThreshold:12000,timezone:'UTC'};
const maintenance=(f,id='job1')=>({operationId:id,deadlineAt:future,authorization:{workspaceId:'w',entityId:'e',conversationId:'c',sessionId:'c',configRevision:'1',policyRevision:'p1',jobRunId:id,leaseToken:'lease',expiresAt:future},session:f.session,reason:'schedule',policy,idempotencyKey:id});
async function turns(f,count,start=1){for(let n=start;n<start+count;n++){const req=nextSubmission(f,n,`message-${n}`);assert.equal((await f.adapter.submit(req)).status,'accepted');assert.equal((await finished({...f,execution:req.payload.execution})).status,'succeeded');}}
const state=f=>[...f.sessionStore.records.values()].find(r=>r.value.handle?.sessionId==='c').value;
const scope={workspaceId:'w',entityId:'e',conversationId:'c'};
test('maintenance archives original prefix, keeps recent tail, injects one bounded summary on next turn',async()=>{
 const inputs=[];const f=await fixture({authorizeMaintenance:async()=>true,modelClient:{async complete(input){inputs.push(input);return response({text:input.tools.length?'reply':'Constraints and pending work retained.',finishReason:'stop'});}}});await turns(f,4);
 const original=[...state(f).messageRefs];const result=await f.adapter.requestMaintenance(maintenance(f));assert.equal(result.ok,true);assert.equal(result.value.status,'applied');
 assert.equal(state(f).messageRefs.length,3);assert.equal(f.options.journal.readSummary(scope).entries.length,1);for(const ref of original)assert.ok(f.options.journal.read(scope,ref));
 const current=readFileSync(join(f.options.journal.root,f.session.recordLocation.resourceId,'current.jsonl'),'utf8');assert.equal(current.includes('message-1'),false);assert.equal(current.includes('message-4'),true);
 const again=await f.adapter.requestMaintenance(maintenance(f));assert.equal(again.value.status,'applied');assert.equal(inputs.filter(i=>!i.tools.length).length,1);
 await turns(f,1,5);const sent=inputs.at(-1).messages;assert.equal(sent.filter(m=>m.content.includes('Historical conversation summary')).length,1);assert.equal(sent.some(m=>m.content==='message-1'),false);assert.equal(sent.some(m=>m.content==='message-4'),true);
});
test('summary may run concurrently; newly completed turns survive safe prefix replacement',async()=>{
 let release,entered;const started=new Promise(r=>entered=r);const f=await fixture({authorizeMaintenance:async()=>true,modelClient:{async complete(input){if(!input.tools.length){entered();await new Promise(r=>release=r);return response({text:'Summary retains important constraints.'});}return response({text:'reply'});}}});await turns(f,4);const pending=f.adapter.requestMaintenance(maintenance(f));await started;await turns(f,1,5);release();const result=await pending;assert.equal(result.value.status,'applied');const history=state(f).messageRefs.map(ref=>f.options.journal.read(scope,ref));assert.deepEqual(history.filter(m=>m.role==='user').map(m=>m.content),['message-4','message-5']);
});
test('failed, truncated or tool-producing summary leaves original history intact',async()=>{
 for(const value of [{text:''},{text:'truncated',finishReason:'length'},{text:'tool',toolCalls:[{id:'bad',name:'task_create',arguments:{input:'never'}}]}]){const f=await fixture({authorizeMaintenance:async()=>true,modelClient:{async complete(input){return response(input.tools.length?{text:'reply'}:value);}}});await turns(f,3);const before=structuredClone(state(f).messageRefs);const result=await f.adapter.requestMaintenance(maintenance(f));assert.equal(result.value.status,'failed');assert.deepEqual(state(f).messageRefs,before);assert.equal(f.options.journal.readSummary(scope),undefined);}
});
test('maintenance requires explicit current scoped authorization and cannot grant tools',async()=>{
 const f=await fixture({authorizeMaintenance:async r=>r.authorization.leaseToken==='valid'});await turns(f,3);assert.equal((await f.adapter.requestMaintenance(maintenance(f))).ok,false);const r=maintenance(f);r.authorization.leaseToken='valid';r.authorization.workspaceId='other';assert.equal((await f.adapter.requestMaintenance(r)).ok,false);assert.equal(state(f).summaryRef,undefined);
});
test('metadata failure after archive is recovered without re-running summarizer',async()=>{
 let summaries=0;const f=await fixture({authorizeMaintenance:async()=>true,modelClient:{async complete(input){if(!input.tools.length)summaries++;return response({text:input.tools.length?'reply':'Preserved constraints.'});}}});await turns(f,3);const original=f.sessionStore.compareAndSetMany.bind(f.sessionStore);let fail=true;f.sessionStore.compareAndSetMany=async changes=>{if(fail&&changes.some(c=>c.value.status==='applied'))throw Error('publication unavailable');return original(changes);};const result=await f.adapter.requestMaintenance(maintenance(f));assert.equal(result.ok,false);assert.equal(result.error.code,'MAINTENANCE_RECONCILIATION_REQUIRED');for(const ref of state(f).messageRefs)assert.ok(f.options.journal.read(scope,ref));fail=false;const restarted=new BuiltinInteractionRuntime(f.options);const recovered=await restarted.getMaintenanceStatus(maintenance(f));assert.equal(recovered.value.status,'applied');assert.equal(summaries,1);assert.equal(f.options.journal.readSummary(scope).version,'job1');
});
test('same day compactions replace a daily row and preserve raw archives',async()=>{
 const f=await fixture({authorizeMaintenance:async()=>true,modelClient:{async complete(input){return response({text:input.tools.length?'reply':'Daily facts and constraints.'});}}});await turns(f,3);assert.equal((await f.adapter.requestMaintenance(maintenance(f))).value.status,'applied');await turns(f,3,4);assert.equal((await f.adapter.requestMaintenance(maintenance(f,'job2'))).value.status,'applied');const summary=f.options.journal.readSummary(scope);assert.equal(summary.entries.length,1);assert.equal(summary.version,'job2');
});
test('ready summary waits for active turn, then preserves its whole tool exchange',async()=>{
 let summaryRelease,summaryEntered,turnRelease,turnEntered;const summaryStarted=new Promise(r=>summaryEntered=r),turnStarted=new Promise(r=>turnEntered=r);let holdTurn=false;
 const f=await fixture({authorizeMaintenance:async()=>true,modelClient:{async complete(input){if(!input.tools.length){summaryEntered();await new Promise(r=>summaryRelease=r);return response({text:'Important constraints retained.'});}if(holdTurn){holdTurn=false;turnEntered();await new Promise(r=>turnRelease=r);return response({toolCalls:[{id:'tool-tail',name:'task_create',arguments:{input:'work'}}]});}return response({text:'reply'});}}});await turns(f,4);const compact=f.adapter.requestMaintenance(maintenance(f));await summaryStarted;holdTurn=true;const next=nextSubmission(f,5,'message-5');await f.adapter.submit(next);await turnStarted;summaryRelease();assert.equal((await compact).value.status,'ready');assert.equal(state(f).summaryRef,undefined);turnRelease();assert.equal((await finished({...f,execution:next.payload.execution})).status,'succeeded');assert.equal((await f.adapter.getMaintenanceStatus(maintenance(f))).value.status,'applied');const history=state(f).messageRefs.map(ref=>f.options.journal.read(scope,ref));assert.equal(history.some(m=>m.role==='tool'&&m.toolCallId==='tool-tail'),true);assert.equal(history.some(m=>m.role==='assistant'&&m.toolCalls?.[0].id==='tool-tail'),true);
});
test('revocation while summarizing does not publish a candidate or remove original data',async()=>{
 let release,entered;const started=new Promise(r=>entered=r);let authorized=true;const f=await fixture({authorizeMaintenance:async()=>authorized,modelClient:{async complete(input){if(!input.tools.length){entered();await new Promise(r=>release=r);return response({text:'Summary'});}return response({text:'reply'});}}});await turns(f,3);const before=structuredClone(state(f).messageRefs);const compact=f.adapter.requestMaintenance(maintenance(f));await started;authorized=false;release();assert.equal((await compact).value.status,'failed');assert.deepEqual(state(f).messageRefs,before);assert.equal(f.options.journal.readSummary(scope),undefined);
});
test('old daily summaries roll into one bounded historical row without deleting sources',async()=>{
 let now=Date.parse('2026-01-01T12:00:00Z');const f=await fixture({now:()=>now,authorizeMaintenance:async()=>true,modelClient:{async complete(input){return response({text:input.tools.length?'reply':'Goals, constraints, decisions and pending work.'});}}});await turns(f,3);const r=maintenance(f);r.policy={...policy,recentDays:2};assert.equal((await f.adapter.requestMaintenance(r)).value.status,'applied');now+=4*86400000;await turns(f,3,4);const next=maintenance(f,'job2');next.policy=r.policy;assert.equal((await f.adapter.requestMaintenance(next)).value.status,'applied');const summary=f.options.journal.readSummary(scope);assert.equal(summary.entries.filter(e=>e.kind==='rollup').length,1);assert.equal(summary.entries.filter(e=>e.kind==='daily').length,1);assert.equal(summary.entries[0].fromDate,'2026-01-01');
});
test('configured retained tail is a minimum and threshold skips without model work',async()=>{
 let summaries=0;const f=await fixture({authorizeMaintenance:async()=>true,modelClient:{async complete(input){if(!input.tools.length)summaries++;return response({text:'reply'});}}});await turns(f,3);const r=maintenance(f);r.reason='context_threshold';r.policy={...policy,contextTokenThreshold:999999};assert.equal((await f.adapter.requestMaintenance(r)).value.reason,'below_context_threshold');assert.equal(summaries,0);const next=maintenance(f,'job2');next.policy={...policy,retainMessages:100};assert.equal((await f.adapter.requestMaintenance(next)).value.reason,'insufficient_history');assert.equal(summaries,0);
});
test('interrupted summarizer clears pending state so another maintenance run can proceed',async()=>{
 const f=await fixture({authorizeMaintenance:async()=>true,modelClient:{async complete(input){return response({text:input.tools.length?'reply':'Summary'});}}});await turns(f,3);const r=maintenance(f);await f.adapter.requestMaintenance(r);
 const [mk,mr]=[...f.sessionStore.records].find(([key])=>key.startsWith('builtin:maintenance:'));const [sk,sr]=[...f.sessionStore.records].find(([,record])=>record.value.handle?.sessionId==='c');f.sessionStore.records.set(mk,{version:mr.version+1,value:{...mr.value,status:'summarizing'}});f.sessionStore.records.set(sk,{version:sr.version+1,value:{...sr.value,pendingMaintenance:mk}});
 const restarted=new BuiltinInteractionRuntime(f.options);assert.equal((await restarted.requestMaintenance(r)).value.reason,'interrupted_summary_not_replayed');assert.equal(state(f).pendingMaintenance,undefined);await turns(f,2,4);assert.equal((await restarted.requestMaintenance(maintenance(f,'job2'))).value.status,'applied');
});
test('retaining one hundred visible messages has headroom beyond the old hundred-message limit',async()=>{
 const f=await fixture({authorizeMaintenance:async()=>true,modelClient:{async complete(input){return response({text:input.tools.length?'reply':'Historical constraints.'});}}});await turns(f,52);const r=maintenance(f);r.policy={...policy,retainMessages:100};const result=await f.adapter.requestMaintenance(r);assert.equal(result.value.status,'applied');const history=state(f).messageRefs.map(ref=>f.options.journal.read(scope,ref));assert.equal(history.filter(m=>(m.role==='user'||m.role==='assistant')&&m.content.trim()).length,100);await turns(f,1,53);
});
test('terminal publication rebases maintenance metadata races without repeating a model or tool',async()=>{
 let modelCalls=0,admissionRelease,admissionEntered;const entered=new Promise(r=>admissionEntered=r);const f=await fixture({authorizeMaintenance:async()=>true,modelClient:{async complete(input){if(!input.tools.length){admissionEntered();await new Promise(r=>admissionRelease=r);return response({text:'Summary preserves the constraints.'});}modelCalls++;return response({text:'reply'});}}});await turns(f,3);
 const original=f.sessionStore.compareAndSetMany.bind(f.sessionStore);let once=true,compaction;f.sessionStore.compareAndSetMany=async changes=>{if(once&&changes.some(c=>c.value.status==='succeeded')){once=false;compaction=f.adapter.requestMaintenance(maintenance(f));await entered;}return original(changes);};
 const next=nextSubmission(f,4,'message-4');await f.adapter.submit(next);assert.equal((await finished({...f,execution:next.payload.execution})).status,'succeeded');assert.equal(state(f).activeExecution,undefined);admissionRelease();assert.equal((await compaction).value.status,'applied');assert.equal(modelCalls,4);const messages=state(f).messageRefs.map(ref=>f.options.journal.read(scope,ref));assert.equal(messages.some(m=>m.content==='message-4'),true);
});
test('only authoritative terminal proof can supersede an uncommitted ready candidate',async()=>{
 let allowed='job1',terminal=false,hold=true;
 const f=await fixture({authorizeMaintenance:async r=>r.authorization.jobRunId===allowed,authorizeMaintenanceReplacement:async()=>terminal,modelClient:{async complete(input){if(!input.tools.length&&hold){const [key,row]=[...f.sessionStore.records].find(([,r])=>r.value.handle?.sessionId==='c');f.sessionStore.records.set(key,{version:row.version+1,value:{...row.value,activeExecution:'busy'}});}return response({text:input.tools.length?'reply':'Preserved constraints.'});}}});await turns(f,3);
 assert.equal((await f.adapter.requestMaintenance(maintenance(f))).value.status,'ready');const pending=state(f).pendingMaintenance;
 const [key,row]=[...f.sessionStore.records].find(([,r])=>r.value.handle?.sessionId==='c');const {activeExecution,...rest}=row.value;f.sessionStore.records.set(key,{version:row.version+1,value:rest});hold=false;allowed='job2';
 // The old request is no longer authorized, but its job might have a renewed lease.
 assert.equal((await f.adapter.requestMaintenance(maintenance(f,'job2'))).ok,false);assert.equal(state(f).pendingMaintenance,pending);
 terminal=true;assert.equal((await f.adapter.requestMaintenance(maintenance(f,'job2'))).value.status,'applied');assert.equal(state(f).pendingMaintenance,undefined);
});
test('terminal proof cannot discard a durable publication awaiting reconciliation',async()=>{
 let allowed='job1';const f=await fixture({authorizeMaintenance:async r=>r.authorization.jobRunId===allowed,authorizeMaintenanceReplacement:async()=>true});await turns(f,3);
 const original=f.sessionStore.compareAndSetMany.bind(f.sessionStore);f.sessionStore.compareAndSetMany=async changes=>changes.some(c=>c.value.status==='applied')?false:original(changes);
 assert.equal((await f.adapter.requestMaintenance(maintenance(f))).ok,false);const pending=state(f).pendingMaintenance;allowed='job2';f.sessionStore.compareAndSetMany=original;
 assert.equal((await f.adapter.requestMaintenance(maintenance(f,'job2'))).ok,false);assert.equal(state(f).pendingMaintenance,pending);
 allowed='job1';assert.equal((await f.adapter.getMaintenanceStatus(maintenance(f))).value.status,'applied');
});
test('more than one thousand short messages have no independent message-count limit',async()=>{
 const f=await fixture({limits:{maxInputTokens:64000}});const [key,row]=[...f.sessionStore.records].find(([,r])=>r.value.handle?.sessionId==='c');
 const messages=Array.from({length:1002},(_,i)=>({role:i%2?'assistant':'user',content:'a'}));
 const refs=f.options.journal.putMany(scope,'message',messages);f.sessionStore.records.set(key,{version:row.version+1,value:{...row.value,messageRefs:[...row.value.messageRefs,...refs],messageDates:[...row.value.messageDates,...messages.map(()=>Date.now())]}});
 await turns(f,1);assert.ok(state(f).messageRefs.length>1000);
});


test('real compaction preserves committed notice IDs, so the original question is not projected again after restart',async()=>{
 const notice={role:'assistant',content:'Original sent confirmation question',contextSource:{kind:'human_notice',id:'sent-question',occurredAt:1}},inputs=[];
 const f=await fixture({authorizeMaintenance:async()=>true,prepareInputHistory:async(messages,_c,projected)=>{if(projected.includes('sent-question'))return messages;const i=messages.findIndex(m=>m.contextSource?.kind==='user_input');return[...messages.slice(0,i),notice,...messages.slice(i)];},modelClient:{async complete(input){inputs.push(input);return response({text:input.tools.length?'reply':'Original confirmation was discussed; retain constraints.',finishReason:'stop'});}}});
 await turns(f,4);assert.deepEqual(state(f).projectedNoticeIds,['sent-question']);assert.equal((await f.adapter.requestMaintenance(maintenance(f,'notice-compaction'))).value.status,'applied');assert.deepEqual(state(f).projectedNoticeIds,['sent-question']);assert.ok(!state(f).messageRefs.some(r=>f.options.journal.read(scope,r).contextSource?.id==='sent-question'));
 await f.adapter.shutdown();f.adapter=new BuiltinInteractionRuntime(f.options);await turns(f,1,5);assert.equal(inputs.at(-1).messages.filter(m=>m.contextSource?.id==='sent-question').length,0);assert.deepEqual(state(f).projectedNoticeIds,['sent-question']);await f.adapter.shutdown();
});

test('exhausted compression retries preserve old summary, raw refs and terminal receipt after restart',async()=>{
 let fail=false,calls=0;
 const f=await fixture({authorizeMaintenance:async()=>true,modelClient:{async complete(input){if(input.tools.length)return response({text:'reply'});calls++;return response(fail?{text:'cut fragment',finishReason:'length'}:{text:'Old complete constraints.',finishReason:'stop'});}}});
 await turns(f,4);assert.equal((await f.adapter.requestMaintenance(maintenance(f,'old-memory'))).value.status,'applied');await turns(f,3,5);
 const before=structuredClone(state(f)),oldSummary=structuredClone(f.options.journal.readSummary(scope));fail=true;const r=maintenance(f,'failed-compression');const startCalls=calls;
 assert.equal((await f.adapter.requestMaintenance(r)).value.status,'failed');assert.equal(calls-startCalls,4);assert.deepEqual(state(f).messageRefs,before.messageRefs);assert.deepEqual(state(f).summaryRef,before.summaryRef);assert.deepEqual(f.options.journal.readSummary(scope),oldSummary);assert.equal(state(f).pendingMaintenance,undefined);
 for(const ref of before.messageRefs)assert.ok(f.options.journal.read(scope,ref));
 await f.adapter.shutdown();f.adapter=new BuiltinInteractionRuntime(f.options);assert.equal((await f.adapter.requestMaintenance(r)).value.status,'failed');assert.equal(calls-startCalls,4,'same failed operation never resets compression credits after restart');await f.adapter.shutdown();
});

test('compression retry shares the safe prefix while concurrent new chat and duplicate request remain intact',async()=>{
 let calls=0,release,entered;const started=new Promise(r=>entered=r);
 const f=await fixture({authorizeMaintenance:async()=>true,modelClient:{async complete(input){if(input.tools.length)return response({text:'reply'});if(++calls===1)return response({text:'cut',finishReason:'length'});entered();await new Promise(r=>release=r);return response({text:'Complete constraints.',finishReason:'stop'});}}});
 await turns(f,4);const r=maintenance(f,'retry-concurrent'),pending=f.adapter.requestMaintenance(r);await started;
 assert.equal((await f.adapter.requestMaintenance(r)).value.status,'summarizing');assert.equal(calls,2);await turns(f,1,5);release();assert.equal((await pending).value.status,'applied');
 const history=state(f).messageRefs.map(ref=>f.options.journal.read(scope,ref));assert.ok(history.some(m=>m.content==='message-5'));assert.equal(calls,2);await f.adapter.shutdown();
});

test('successive rollups preserve dated daily files and exclude all archived data from chat prompts',async()=>{
 let now=Date.parse('2026-01-01T12:00:00Z');const inputs=[];
 const f=await fixture({now:()=>now,authorizeMaintenance:async()=>true,modelClient:{async complete(input){inputs.push(input);const data=input.tools.length?null:JSON.parse(input.messages[1].content);return response({text:input.tools.length?'reply':data.kind==='historical_rollup'?'HISTORY_ROLLUP':`DAILY_${data.date}`,finishReason:'stop'});}}});
 const compact=async id=>{const r=maintenance(f,id);r.policy={...policy,recentDays:2};assert.equal((await f.adapter.requestMaintenance(r)).value.status,'applied');};
 await turns(f,3);await compact('day1');
 const first=f.options.journal.readSummary(scope).entries.find(e=>e.kind==='daily'),firstTail=state(f).messageRefs.length-1;
 now=Date.parse('2026-01-05T12:00:00Z');await turns(f,3,4);await compact('day5');
 const directory=join(f.options.journal.root,f.session.recordLocation.resourceId),history=join(directory,'history');
 const firstBytes=readFileSync(join(history,'2026-01-01.jsonl'),'utf8');
 const second=f.options.journal.readSummary(scope).entries.find(e=>e.kind==='daily'),secondTail=state(f).messageRefs.length-1;
 // The previous day's retained tail is summarized on this run before that daily
 // row joins the rollup. Preserve this updated row, not the prior projection.
 assert.deepEqual(JSON.parse(firstBytes.trim()).value.entry,{...first,sourceCheckpoint:second.sourceCheckpoint,sourceRecordCount:first.sourceRecordCount+firstTail});
 now=Date.parse('2026-01-07T12:00:00Z');await turns(f,3,7);await compact('day7');
 assert.deepEqual(readdirSync(history).sort(),['2026-01-01.jsonl','2026-01-05.jsonl']);
 assert.equal(readFileSync(join(history,'2026-01-01.jsonl'),'utf8'),firstBytes);
 const summary=f.options.journal.readSummary(scope),third=summary.entries.find(e=>e.kind==='daily');assert.equal(summary.entries.filter(e=>e.kind==='rollup').length,1);
 assert.deepEqual(JSON.parse(readFileSync(join(history,'2026-01-05.jsonl'),'utf8').trim()).value.entry,{...second,sourceCheckpoint:third.sourceCheckpoint,sourceRecordCount:second.sourceRecordCount+secondTail});
 assert.equal(JSON.stringify(summary).includes('archivedDaily'),false);
 // Prove normal interaction does not even parse the daily history files.
 writeFileSync(join(history,'2026-01-01.jsonl'),'unreadable daily archive');
 await turns(f,1,10);const prompt=JSON.stringify(inputs.at(-1).messages);
 assert.ok(prompt.includes('HISTORY_ROLLUP'));assert.ok(prompt.includes('DAILY_2026-01-07'));
 for(const excluded of ['DAILY_2026-01-01','DAILY_2026-01-05','history/','raw/','archivedDaily','sourceCheckpoint'])assert.equal(prompt.includes(excluded),false,excluded);
 assert.ok(readdirSync(join(directory,'raw')).length>=3);await f.adapter.shutdown();
});

test('daily archival and raw publication faults reconcile durable candidates after restart without new model calls',async()=>{
 for(const failAt of [1,2,3,5,7,8]){
  let now=Date.parse('2026-01-01T12:00:00Z'),calls=0;
  const f=await fixture({now:()=>now,authorizeMaintenance:async()=>true,modelClient:{async complete(input){if(!input.tools.length)calls++;return response({text:input.tools.length?'reply':'Preserved daily facts.',finishReason:'stop'});}}});
  const initial=maintenance(f,'first');initial.policy={...policy,recentDays:2};await turns(f,3);assert.equal((await f.adapter.requestMaintenance(initial)).value.status,'applied');
  now=Date.parse('2026-01-05T12:00:00Z');await turns(f,3,4);
  const [sk,sr]=[...f.sessionStore.records].find(([,r])=>r.value.handle?.sessionId==='c');
  f.sessionStore.records.set(sk,{version:sr.version+1,value:{...sr.value,activeExecution:'held-for-test'}});
  const r=maintenance(f,'second');r.policy=initial.policy;assert.equal((await f.adapter.requestMaintenance(r)).value.status,'ready');
  const held=f.sessionStore.records.get(sk),{activeExecution,...rest}=held.value;f.sessionStore.records.set(sk,{version:held.version+1,value:rest});
  const before=structuredClone(state(f)),oldSummary=structuredClone(f.options.journal.readSummary(scope)),callsBefore=calls;
  let armed=false,syncs=0;f.options.journal=new JsonlJournal({root:f.options.journal.root,ownerId:'test-owner',serialize:fn=>fn(),beforeSync:()=>{if(armed&&++syncs===failAt)throw Error('archive fault');}});armed=true;
  const failure=await f.adapter.getMaintenanceStatus(r);assert.equal(failure.ok,false);assert.equal(failure.error.code,'MAINTENANCE_RECONCILIATION_REQUIRED');
  assert.deepEqual(state(f).messageRefs,before.messageRefs);assert.deepEqual(state(f).summaryRef,before.summaryRef);assert.deepEqual(f.options.journal.readSummary(scope),oldSummary);
  for(const ref of before.messageRefs)assert.ok(f.options.journal.read(scope,ref));
  await f.adapter.shutdown();armed=false;f.adapter=new BuiltinInteractionRuntime(f.options);
  assert.equal((await f.adapter.getMaintenanceStatus(r)).value.status,'applied');assert.equal(calls,callsBefore);
  const path=join(f.options.journal.root,f.session.recordLocation.resourceId,'history','2026-01-01.jsonl');assert.equal(readFileSync(path,'utf8').trim().split('\n').length,1);
  assert.equal(f.options.journal.readSummary(scope).version,'second');await f.adapter.shutdown();
 }
});

test('failed or revoked rollup never creates daily archives or switches effective history',async()=>{
 for(const revoked of [false,true]){
  let now=Date.parse('2026-01-01T12:00:00Z'),allowed=true,fail=false;
  const f=await fixture({now:()=>now,authorizeMaintenance:async()=>allowed,modelClient:{async complete(input){if(!input.tools.length&&fail){if(revoked)allowed=false;else throw Error('model unavailable');}return response({text:input.tools.length?'reply':'Preserve constraints.',finishReason:'stop'});}}});
  const first=maintenance(f,'first');first.policy={...policy,recentDays:2};await turns(f,3);assert.equal((await f.adapter.requestMaintenance(first)).value.status,'applied');
  now=Date.parse('2026-01-05T12:00:00Z');await turns(f,3,4);const before=structuredClone(state(f));fail=true;
  const next=maintenance(f,'second');next.policy=first.policy;const result=await f.adapter.requestMaintenance(next);assert.ok(!result.ok||result.value.status==='failed');
  assert.deepEqual(state(f).messageRefs,before.messageRefs);assert.deepEqual(state(f).summaryRef,before.summaryRef);
  assert.equal(existsSync(join(f.options.journal.root,f.session.recordLocation.resourceId,'history')),false);await f.adapter.shutdown();
 }
});
