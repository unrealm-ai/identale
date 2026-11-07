import{createHash,randomUUID}from'node:crypto';
import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{createServer}from'../dist/server.js';import{WorkItemArtifacts}from'../dist/work-items/artifacts.js';import{handoffPackageAllowed,workItemTransitionAllowed,scopeFromJson}from'@dentity/application';
const origin='http://127.0.0.1:5173';
class MockRuntime{published=new Map();artifacts(id){return(this.published.get(id)??[]).map(x=>x.artifact);}async artifactContent(runId,id){const p=(this.published.get(runId)??[]).find(x=>x.artifact.content.resourceId===id);if(!p)throw Error('missing artifact');return{...p.artifact,bytes:p.bytes};}commands=[];stream=[];idempotentDispatch=true;async dispatch(c){this.commands.push(c);return{status:'accepted'};}async events(id,after){return this.stream.filter(e=>e.runId===id&&e.sequence>after);}async input(){return{status:'received'};}async cancel(){return{status:'confirmed'};}}
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'identity-work-items-'));let tasks,items,notifications,human;const runtime=new MockRuntime(),app=createServer({databasePath:join(root,'db.sqlite'),origin,pollIntervalMs:0,triggers:{automatic:false},directorySync:{automatic:false},maintenance:{enabled:false},runtime,modelClient:{async complete(){throw Error('No model invocation in state-machine fixture');}},onHumanConfirmationService:v=>human=v,onService:v=>tasks=v,onWorkItemService:v=>items=v,onTaskCompletionNotifications:v=>notifications=v});await app.ready();t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const call=(method,url,payload,cookie)=>app.inject({method,url,...(payload!==undefined?{payload}:{}),headers:{origin,...(cookie?{cookie}:{})}}),register=async name=>{const r=await call('POST','/api/auth/register',{username:name,password:'Synthetic Work Item Password 2026!'});assert.equal(r.statusCode,201,r.body);return{...r.json(),cookie:r.headers['set-cookie'].split(';')[0]};};
 const owner=await register('item-owner'),member=await register('item-member'),outside=await register('item-outside'),w=owner.workspace.id,ws='/api/workspaces/'+w;const invite=(await call('POST',ws+'/invitations',{},owner.cookie)).json().token;assert.equal((await call('POST','/api/invitations/accept',{token:invite},member.cookie)).statusCode,200);
 const employees=[];for(const name of['A','B','C']){const r=await call('POST',ws+'/entities',{name:'Employee '+name,ownWebUse:true},owner.cookie);assert.equal(r.statusCode,200,r.body);employees.push(r.json().entity);}
 async function rootTask(index=0,operation='root-'+index){const e=employees[index],base=ws+'/entities/'+e.id,conversation=(await call('POST',base+'/conversations',{operationId:'conversation-'+operation},owner.cookie)).json().conversation,r=await call('POST',base+'/tasks',{operationId:operation,conversationId:conversation.id,input:'Synthetic tracked business work',contextMode:'new'},owner.cookie);assert.equal(r.statusCode,202,r.body);await tasks.tick();return items.store.one('SELECT * FROM tasks WHERE id=?',r.json().task.id);}
 const row=id=>items.store.one('SELECT * FROM tasks WHERE id=?',id);
 const enable=async()=>{const settings=(await call('GET',ws+'/work-items/settings',undefined,owner.cookie)).json();assert.equal((await call('PUT',ws+'/work-items/settings',{expectedRevision:settings.configured.revision,enabled:true},owner.cookie)).statusCode,200);assert.equal((await call('GET',ws+'/work-items/settings',undefined,owner.cookie)).json().effective.enabled,true);};
 async function finish(task){const current=row(task.id),sequence=items.store.one('SELECT sequence FROM runs WHERE id=?',current.run_id).sequence;runtime.stream.push({eventId:'complete-'+current.run_id,runId:current.run_id,sequence:sequence+1,type:'final_result',inputRevision:current.input_revision,text:'Synthetic ended task'},{eventId:'succeeded-'+current.run_id,runId:current.run_id,sequence:sequence+2,type:'status',status:'succeeded'});await tasks.tick();assert.equal(row(task.id).status,'succeeded');}
 function handoff(task,target,operation='handoff',extra={}){const item=items.execute(row(task.id),'get_current',{}).item;return items.execute(row(task.id),'handoff',{operationId:operation,...(item?{expectedAssignmentId:item.currentAssignmentId,expectedVersion:item.version}:{title:'Synthetic work',goal:'Track business progress',criteria:'Check deterministic result'}),targetEmployeeId:target.id,summary:'Structured necessary business handoff',...extra});}
 function safe(task,accepted){const current=row(task.id),sequence=items.store.one('SELECT sequence FROM runs WHERE id=?',current.run_id).sequence;tasks.ingest(current.run_id,{type:'work_item_safe',eventId:'safe-'+accepted.boundary.intentId,runId:current.run_id,sequence:sequence+1,workItemSafe:{...accepted.boundary,checkpointRef:'a'.repeat(64)}});}

 return{human,app,call,owner,member,outside,w,ws,tasks,items,notifications,runtime,employees,rootTask,row,enable,finish,handoff,safe};
}

const refs=x=>[x.artifact.content];
function publish(f,task,content='synthetic report',name='report.txt'){
 const bytes=Buffer.from(content),artifact={content:{resourceId:'artifact:'+createHash('sha256').update(randomUUID()).digest('hex'),version:createHash('sha256').update(bytes).digest('hex')},availability:'available',name,kind:'file',mediaType:'application/octet-stream',size:bytes.length},value={artifact,bytes};f.runtime.published.set(task.run_id,[...(f.runtime.published.get(task.run_id)??[]),value]);return value;
}
const currentTask=f=>{const view=f.items.list(f.w).items[0];return f.items.store.one('SELECT t.* FROM tasks t JOIN work_item_task_links l ON l.task_id=t.id WHERE l.assignment_id=?',view.currentAssignmentId);};
const scope=task=>({workspaceId:task.workspace_id,entityId:task.entity_id,taskId:task.id,runId:task.run_id});
const bridge=f=>new WorkItemArtifacts(f.items.store,f.runtime,Date.now);
function complete(f,task,artifactRefs,operationId='finish'){const item=f.items.readForTask(task,{}).item;return f.items.execute(task,'finish',{operationId,expectedAssignmentId:item.currentAssignmentId,expectedVersion:item.version,summary:'Submitted output',completionEvidence:'Checked synthetic bytes',...(artifactRefs===undefined?{}:{artifactRefs})});}

test('first handoff grants only explicit immutable outputs after safe commit; replay and restart do not duplicate grants',async t=>{
 const f=await fixture(t);await f.enable();const root=await f.rootTask(),chosen=publish(f,root),hidden=publish(f,root,'private unselected','hidden.txt');
 const intent=f.handoff(root,f.employees[1],'file-handoff',{artifactRefs:refs(chosen)});assert.equal(f.items.store.one('SELECT count(*) n FROM message_asset_run_grants').n,0);
 assert.deepEqual(f.handoff(root,f.employees[1],'file-handoff',{artifactRefs:refs(chosen)}),intent);assert.throws(()=>f.handoff(root,f.employees[1],'file-handoff',{artifactRefs:refs(hidden)}),{code:'work_item_operation_conflict'});
 f.safe(root,intent);await f.items.tick();const task=currentTask(f),restarted=bridge(f),materials=restarted.listForRun(scope(task));assert.equal(materials.length,1);assert.deepEqual(materials[0].content,chosen.artifact.content);assert.equal(materials[0].sourceTaskId,root.id);assert.equal(materials[0].sourceRunId,root.run_id);
 assert.equal(await(await restarted.streamForRun(scope(task),materials[0].assetId,'content')).text(),'synthetic report');
 f.safe(root,intent);await f.items.tick();assert.equal(f.items.store.one('SELECT count(*) n FROM message_asset_run_grants').n,1);assert.equal(f.items.store.one('SELECT count(*) n FROM tasks').n,2);
 const prepared=JSON.parse(f.items.store.one('SELECT prepared_json FROM work_item_intents WHERE id=?',intent.boundary.intentId).prepared_json);assert.deepEqual(prepared.artifacts[0].artifact,chosen.artifact);assert.equal(JSON.stringify(materials).includes('hidden.txt'),false);
});

test('selection rejects unowned, stale-version, cross-task, malformed and duplicate references without preparing a boundary',async t=>{
 const f=await fixture(t);await f.enable();const root=await f.rootTask(),other=await f.rootTask(0,'unrelated'),own=publish(f,root),foreign=publish(f,other);
 for(const bad of [refs(foreign),[{...own.artifact.content,version:'0'.repeat(64)}],[{resourceId:'artifact:'+'1'.repeat(64),version:'2'.repeat(64)}]])assert.throws(()=>f.handoff(root,f.employees[1],randomUUID(),{artifactRefs:bad}),{code:'work_item_artifact_not_authorized'});
 for(const bad of [null,{},[...refs(own),...refs(own)],Array(33).fill(own.artifact.content),[{...own.artifact.content,path:'/secret'}],[{resourceId:'/tmp/report.txt',version:'1'}]])assert.throws(()=>f.handoff(root,f.employees[1],randomUUID(),{artifactRefs:bad}),{code:'invalid_work_item_artifacts'});
 assert.equal(f.items.store.one('SELECT count(*) n FROM work_item_intents').n,0);assert.equal(f.items.store.one('SELECT count(*) n FROM work_item_artifact_materials').n,0);
});

test('finish grants outputs to acceptance; corrections may explicitly forward granted files and acceptance may cite them',async t=>{
 const f=await fixture(t);await f.enable();const root=await f.rootTask(),original=publish(f,root,'root briefing'),first=f.handoff(root,f.employees[1],'first',{artifactRefs:refs(original)});f.safe(root,first);await f.items.tick();await f.tasks.tick();const work=currentTask(f);
 assert.throws(()=>complete(f,work,refs(original),'cannot-submit-inherited'),{code:'work_item_artifact_not_authorized'});
 const output=publish(f,work,'work version 1'),done=complete(f,work,refs(output));f.safe(work,done);await f.items.tick();await f.tasks.tick();const reviewer=currentTask(f),materials=bridge(f).listForRun(scope(reviewer));assert.equal(materials.length,1);assert.deepEqual(materials[0].content,output.artifact.content);
 const returned=f.handoff(reviewer,f.employees[1],'corrections',{artifactRefs:refs(output)});f.safe(reviewer,returned);await f.items.tick();await f.tasks.tick();const correction=currentTask(f),oldMaterial=bridge(f).listForRun(scope(correction));assert.equal(oldMaterial.length,1);assert.equal(await(await bridge(f).streamForRun(scope(correction),oldMaterial[0].assetId,'content')).text(),'work version 1');
 const fixed=publish(f,correction,'work version 2'),resubmit=complete(f,correction,refs(fixed));f.safe(correction,resubmit);await f.items.tick();await f.tasks.tick();const finalReviewer=currentTask(f),newMaterials=bridge(f).listForRun(scope(finalReviewer));assert.equal(newMaterials.length,1);assert.deepEqual(newMaterials[0].content,fixed.artifact.content);assert.notEqual(newMaterials[0].assetId,oldMaterial[0].assetId);
 const accepted=complete(f,finalReviewer,refs(fixed));f.safe(finalReviewer,accepted);await f.items.tick();assert.equal(f.items.list(f.w).items[0].status,'completed');
});

test('material grants bind workspace, receiver employee, Task and Run; IDs and event history never authorize reads or forwarding',async t=>{
 const f=await fixture(t);await f.enable();const root=await f.rootTask(),chosen=publish(f,root),handoff=f.handoff(root,f.employees[1],'grant',{artifactRefs:refs(chosen)});f.safe(root,handoff);await f.items.tick();const receiver=currentTask(f),b=bridge(f),material=b.listForRun(scope(receiver))[0];
 for(const key of ['workspaceId','entityId','taskId','runId']){const bad={...scope(receiver),[key]:'unrelated'};assert.deepEqual(b.listForRun(bad),[]);await assert.rejects(b.streamForRun(bad,material.assetId,'content'),{code:'asset_not_authorized'});}
 await assert.rejects(b.streamForRun(scope(root),material.assetId,'content'),{code:'asset_not_authorized'});
 const unrelated=await f.rootTask(2,'unrelated');assert.throws(()=>f.handoff(unrelated,f.employees[1],'stolen',{artifactRefs:refs(chosen)}),{code:'work_item_artifact_not_authorized'});
 assert.deepEqual(await b.streamForRun(scope(receiver),material.assetId,'summary'),{state:'not_available',reason:'artifact_read_kind_unavailable'});
});

test('source and version revalidation fences safe commit, durable dispatch and changed bytes',async t=>{
 const f=await fixture(t);await f.enable();const root=await f.rootTask(),chosen=publish(f,root),intent=f.handoff(root,f.employees[1],'source-fence',{artifactRefs:refs(chosen)});f.safe(root,intent);
 f.runtime.published.set(root.run_id,[]);await f.items.tick();assert.equal(f.items.store.one('SELECT state FROM work_item_intents').state,'safe');assert.equal(f.items.store.one('SELECT count(*) n FROM tasks').n,1);
 f.runtime.published.set(root.run_id,[chosen]);await f.items.tick();const task=currentTask(f),b=bridge(f),material=b.listForRun(scope(task))[0];chosen.bytes=Buffer.from('corrupt');await assert.rejects(b.streamForRun(scope(task),material.assetId,'content'),{code:'work_item_artifact_integrity_mismatch'});
 f.runtime.published.set(root.run_id,[]);await assert.rejects(b.streamForRun(scope(task),material.assetId,'content'),{code:'work_item_artifact_source_changed'});
});

test('text-only completion and omitted correction selection grant no files implicitly',async t=>{
 const f=await fixture(t);await f.enable();const root=await f.rootTask();publish(f,root);const first=f.handoff(root,f.employees[1]);f.safe(root,first);await f.items.tick();await f.tasks.tick();const work=currentTask(f);assert.deepEqual(bridge(f).listForRun(scope(work)),[]);publish(f,work);const done=complete(f,work);f.safe(work,done);await f.items.tick();const reviewer=currentTask(f);assert.deepEqual(bridge(f).listForRun(scope(reviewer)),[]);
 assert.equal(f.items.store.one('SELECT count(*) n FROM work_item_artifact_materials').n,0);
});

test('deferred dispatch revalidates exact source and atomically rolls back target and grants on failure',async t=>{
 const f=await fixture(t);await f.enable();const root=await f.rootTask(),chosen=publish(f,root),intent=f.handoff(root,f.employees[1],'delayed',{artifactRefs:refs(chosen)}),config=f.items.configuration.get(f.w);f.items.configuration.save(f.w,f.owner.user.id,{expectedRevision:config.revision,enabled:false});f.safe(root,intent);await f.items.tick();assert.equal(f.items.store.one('SELECT state FROM work_item_intents').state,'committed');
 f.runtime.published.set(root.run_id,[]);await f.enable();await f.items.tick();assert.equal(f.items.store.one('SELECT count(*) n FROM tasks').n,1);assert.equal(f.items.store.one('SELECT count(*) n FROM message_asset_run_grants').n,0);assert.equal(f.items.list(f.w).items[0].pendingDispatch.error,'work_item_artifact_source_changed');
 f.runtime.published.set(root.run_id,[chosen]);await f.items.tick();await f.items.tick();assert.equal(f.items.store.one('SELECT count(*) n FROM tasks').n,2);assert.equal(f.items.store.one('SELECT count(*) n FROM message_asset_run_grants').n,1);
});

test('human continuation keeps granted materials in the same Task and may explicitly forward them',async t=>{
 const f=await fixture(t);await f.enable();const root=await f.rootTask(),chosen=publish(f,root),intent=f.handoff(root,f.employees[1],'for-human',{artifactRefs:refs(chosen)});f.safe(root,intent);await f.items.tick();await f.tasks.tick();const task=currentTask(f),run=f.items.store.one('SELECT * FROM runs WHERE id=?',task.run_id);let sequence=run.sequence;
 const question={questionScope:'synthetic',background:'Isolated file handoff fixture',goal:'Check inherited material',knownFacts:[],questions:[{id:'answer',text:'Continue synthetic work?',required:true,answerType:'text'}],completionCriteria:['Explicit fixture answer'],proposedAction:'Continue fixture',impactScope:'Synthetic test only',ifNotConfirmed:'wait'},checkpoint={requestId:randomUUID(),contentVersion:1,question,questionDigest:createHash('sha256').update(JSON.stringify(question)).digest('hex'),taskId:task.id,runId:run.id,sessionId:run.session_id,configurationId:'synthetic',inputRevision:task.input_revision,safe:false};
 f.tasks.ingest(run.id,{eventId:'artifact-human-request',runId:run.id,sequence:++sequence,type:'human_request',human:checkpoint});
 // Synthetic confirmed state exercises the production continuation transaction, not recipient/model approval.
 const response=JSON.stringify({decision:'approve',answers:[{questionId:'answer',value:'Synthetic approval'}]});f.items.store.run("UPDATE human_requests SET status='confirmed',response_json=?,response_digest=? WHERE request_id=?",response,createHash('sha256').update(response).digest('hex'),checkpoint.requestId);
 f.tasks.ingest(run.id,{eventId:'artifact-human-safe',runId:run.id,sequence:++sequence,type:'human_safe',human:{...checkpoint,safe:true,checkpointRef:'b'.repeat(64)}});await f.human.tick();const continued=f.row(task.id);assert.notEqual(continued.run_id,run.id);assert.equal(f.items.store.one('SELECT session_id FROM runs WHERE id=?',continued.run_id).session_id,run.session_id);
 const b=bridge(f),materials=b.listForRun(scope(continued));assert.equal(materials.length,1);assert.equal(await(await b.streamForRun(scope(continued),materials[0].assetId,'content')).text(),'synthetic report');
 const forward=f.handoff(continued,f.employees[2],'after-human',{artifactRefs:refs(chosen)});f.safe(continued,forward);await f.items.tick();assert.equal(b.listForRun(scope(currentTask(f))).length,1);
});

test('committed source metadata and receiver grants survive closing and reopening the platform store',async t=>{
 const f=await fixture(t);await f.enable();const root=await f.rootTask(),chosen=publish(f,root),intent=f.handoff(root,f.employees[1],'restart',{artifactRefs:refs(chosen)});f.safe(root,intent);await f.items.tick();const receiver=currentTask(f),before=bridge(f).listForRun(scope(receiver)),path=f.items.store.databasePath;await f.app.close();
 const {Store}=await import('../dist/store.js'),reopened=new Store(path);try{const b=new WorkItemArtifacts(reopened,f.runtime,Date.now);assert.deepEqual(b.listForRun(scope(receiver)),before);assert.equal(await(await b.streamForRun(scope(receiver),before[0].assetId,'content')).text(),'synthetic report');}finally{reopened.close();}
});
