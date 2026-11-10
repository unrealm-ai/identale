import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {PlatformAssetService} from '../dist/assets/service.js';
import {workItemResourceLineage} from '../dist/work-items/resource-lineage.js';
const digest=text=>createHash('sha256').update(text).digest('hex');
const scope=entity=>({workspaceId:'w',entityId:entity,taskId:'task-'+entity,runId:'run-'+entity});
const source={workspaceId:'w',entityId:'A',provider:'feishu',tenantId:'tenant',applicationId:'app',connectionId:'connection',bindingVersion:'binding',chatId:'original-group',conversationKind:'group',requesterId:'alice',requesterNamespace:'open_id'};
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'identale-source-material-transfers-')),store=new Store(join(dir,'db'));let live=true,allowed=true,revision='r1',now=10000;const texts={content:'source overview',summary:'selected summary',transcript:'unselected transcript'};
 store.run("INSERT INTO users(id,username,display_name) VALUES('u','fixture','fixture')");store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','fixture','u')");store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('member','w','u','owner')");
 for(const entity of ['A','B','C','D'])store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES(?,'w',?,'member','member',1,'u','builtin')",entity,entity);
 const task=(run,assignment)=>{store.run("INSERT INTO tasks(id,workspace_id,entity_id,user_id,conversation_id,operation_id,request_hash,input,context_mode,snapshot_id,snapshot_json,source_json,status,run_id,created_at,updated_at) VALUES(?,'w',?,'u',NULL,?,'hash','fixture','new',?,'{}',?,'running',?,0,0)",run.taskId,run.entityId,run.taskId,run.taskId,JSON.stringify({workspaceId:'w',entityId:run.entityId,...(assignment?{assignment}:{})}),run.runId);store.run("INSERT INTO runs(id,task_id,session_id,status,created_at) VALUES(?,?,?,'running',0)",run.runId,run.taskId,run.runId);};task(scope('A'));

 const make=()=>new PlatformAssetService(store,join(dir,'assets'),{read:async()=>{throw Error('no IM fallback');}},{now:()=>now,assertSource:s=>{assert.equal(s.connectionId,'connection');if(!live)throw Error('channel binding revoked');},businessResources:{identityKind:'application',authorization:{authorize:async request=>allowed?{state:'authorized',identityKind:'application',accountId:'app:fixture',authorizationRevision:revision,resourceVersion:digest(texts[request.operation]),expiresAt:now+60000,apiScopeVerified:true,resourceAclVerified:true,outputAudienceVerified:true}:{state:'authorization_required'}},reader:{read:async request=>new Response(texts[request.operation])}}});
 let assets=make();t.after(async()=>{await assets.waitForIdle();assets.close();store.close();await rm(dir,{recursive:true,force:true});});
 const binding={workspaceId:'w',entityId:'A',provider:'feishu',appId:'app',connectionId:'connection',bindingVersion:'binding',connection:{connectionId:'connection',tenantId:'tenant'}},event={connectionId:'connection',tenantId:'tenant',message:{id:'original-message',conversationKind:'group',author:{identityEvidence:'channel_verified',externalId:'alice',idNamespace:'open_id'},conversation:{provider:'feishu',connectionId:'connection',tenantId:'tenant',externalId:'original-group'},text:'feishu:minutes:meeting'}};
 const id=assets.ingest(binding,event).message.sharedAssets[0].assetId;assets.grantForRun(scope('A'),[id],source);for(const kind of ['summary','transcript'])assert.equal((await assets.resolveForRun(scope('A'),id,kind)).state,'ready');
 const commit=async(from,to,selected,key=`${from.entityId}-${to.entityId}`)=>{
  const intentId='intent-'+key,assignmentId='assignment-'+key,assignment={assignmentId,targetEmployeeId:to.entityId,sourceEmployeeId:from.entityId,grantId:'grant-'+key,workItemId:'work-item',rootTaskId:'task-A'};task(to,assignment);
  const fingerprint=workItemResourceLineage(store,{id:from.taskId,workspace_id:'w',entity_id:from.entityId}).fingerprint,prepared={materials:selected,summary:'only selected work',resourceFingerprint:fingerprint},preparedJson=JSON.stringify(prepared);
  store.run("INSERT INTO work_item_intents(id,task_id,run_id,state,checkpoint_ref,prepared_json,operation_id,work_item_id,assignment_id,expected_version,kind) VALUES(?,?,?,?,?,?,?,'work-item',?,1,'handoff')",intentId,from.taskId,from.runId,'committed','checkpoint',preparedJson,intentId,assignmentId);store.run("INSERT INTO work_item_dispatches(id,source_task_id,source_run_id,task_id,assignment_id,state,work_item_id) VALUES(?,?,?,?,?,?,'work-item')",intentId,from.taskId,from.runId,to.taskId,assignmentId,'done');store.run("INSERT INTO work_item_assignments(id,employee_id,source_employee_id,grant_id,work_item_id,summary,snapshot_json,created_at) VALUES(?,?,?,?,?,?,'{}',0)",assignmentId,to.entityId,from.entityId,assignment.grantId,assignment.workItemId,prepared.summary);store.run('INSERT INTO work_item_resource_transfers(intent_id,assignment_id,source_task_id,source_run_id,target_task_id,fingerprint,package_digest) VALUES(?,?,?,?,?,?,?)',intentId,assignmentId,from.taskId,from.runId,to.taskId,fingerprint,digest(preparedJson));
  await assets.workItemMaterials().validate(from,selected,to.entityId);assets.workItemMaterials().grant(from,to,selected,{intentId,assignmentId});return{intentId,assignmentId};
 };
 return{store,id,texts,task,commit,get assets(){return assets;},restart(){assets.close();assets=make();},set allowed(value){allowed=value;},set live(value){live=value;},set revision(value){revision=value;},advance(){now+=60001;},ref(kind='summary'){return{kind:'source_asset',assetId:id,readKind:kind,version:digest(texts[kind])};}};
}

test('selected source summary becomes a new content-only alias, never original asset or transcript permission',async t=>{
 const f=await fixture(t),selected=await f.assets.workItemMaterials().select(scope('A'),[f.ref()],'B');assert.equal(f.assets.workItemMaterials().list(scope('A')).length,2);const proof=await f.commit(scope('A'),scope('B'),selected),list=f.assets.listForRun(scope('B'));assert.equal(list.length,1);const alias=list[0].assetId;assert.notEqual(alias,f.id);assert.equal((await f.assets.resolveForRun(scope('B'),alias)).state,'ready');assert.equal(await(await f.assets.streamForRun(scope('B'),alias,'content')).text(),'selected summary');assert.equal((await f.assets.streamForRun(scope('B'),alias,'transcript')).state,'not_available');await assert.rejects(f.assets.streamForRun(scope('B'),f.id,'transcript'),/not_authorized/);assert.equal(f.store.one('SELECT count(*) n FROM message_asset_run_grants WHERE run_id=?',scope('B').runId).n,0);assert.equal(f.store.one('SELECT count(*) n FROM business_resource_run_context WHERE run_id=?',scope('B').runId).n,0);
 await f.assets.assertBusinessOutputForRun(scope('B'),source);await assert.rejects(f.assets.assertBusinessOutputForRun(scope('B'),{...source,chatId:'other'}),/audience_mismatch/);f.restart();assert.equal(await(await f.assets.streamForRun(scope('B'),alias)).text(),'selected summary');
 f.store.run('DELETE FROM work_item_resource_transfers WHERE intent_id=?',proof.intentId);await assert.rejects(f.assets.assertBusinessOutputForRun(scope('B'),source),/transfer_authorization_required|durable_proof_changed/);await assert.rejects(f.assets.streamForRun(scope('B'),alias),/durable_proof_changed/);await assert.rejects(f.assets.workItemMaterials().select(scope('B'),[{kind:'source_asset',assetId:alias,readKind:'content',version:f.ref().version}],'C'),/durable_proof_changed/);
});

test('source selection rejects unprepared, foreign-run, duplicate and changed-version refs; grant requires exact committed selection and target',async t=>{
 const f=await fixture(t),port=f.assets.workItemMaterials();for(const refs of [[{...f.ref(),readKind:'content'}],[{...f.ref(),version:'0'.repeat(64)}],[f.ref(),f.ref()],[{...f.ref(),approved:true}]])await assert.rejects(port.select(scope('A'),refs,'B'));
 await assert.rejects(port.select(scope('B'),[f.ref()],'C'));const selected=await port.select(scope('A'),[f.ref()],'B');await assert.rejects(port.validate(scope('A'),selected,'C'),/selection_changed/);
 const proof=await f.commit(scope('A'),scope('B'),selected);await port.validate(scope('A'),selected,'B');f.store.run('UPDATE work_item_intents SET prepared_json=? WHERE id=?',JSON.stringify({materials:[]}),proof.intentId);assert.throws(()=>port.grant(scope('A'),scope('B'),selected,proof),/selection_changed|durable_proof_changed/);
});

test('source ACL, credential revision, source binding and content version remain live despite cached transferred bytes',async t=>{
 for(const change of ['acl','revision','binding','version']){const f=await fixture(t),selected=await f.assets.workItemMaterials().select(scope('A'),[f.ref()],'B');await f.commit(scope('A'),scope('B'),selected);const alias=f.assets.listForRun(scope('B'))[0].assetId;
  if(change==='acl')f.allowed=false;if(change==='revision')f.revision='changed';if(change==='binding')f.live=false;if(change==='version')f.texts.summary='changed summary';
  await assert.rejects(f.assets.streamForRun(scope('B'),alias));await assert.rejects(f.assets.revalidateBusinessResourcesForRun(scope('B')));await assert.rejects(f.assets.assertBusinessOutputForRun(scope('B'),source));
 }
});

test('multi-hop selection intersects received aliases and preserves original source provenance across continuation',async t=>{
 const f=await fixture(t),first=await f.assets.workItemMaterials().select(scope('A'),[f.ref()],'B');await f.commit(scope('A'),scope('B'),first);const alias=f.assets.listForRun(scope('B'))[0].assetId,ref={kind:'source_asset',assetId:alias,readKind:'content',version:f.ref().version};await assert.rejects(f.assets.workItemMaterials().select(scope('B'),[{...ref,readKind:'transcript'}],'C'));const second=await f.assets.workItemMaterials().select(scope('B'),[ref],'C');await f.commit(scope('B'),scope('C'),second);const cAlias=f.assets.listForRun(scope('C'))[0].assetId;assert.notEqual(cAlias,alias);assert.equal(await(await f.assets.streamForRun(scope('C'),cAlias)).text(),'selected summary');assert.equal(second[0].originRun.runId,scope('A').runId);assert.equal(second[0].sourceRun.runId,scope('B').runId);
 const continued={...scope('C'),runId:'run-C-continued'};f.store.run("INSERT INTO runs(id,task_id,session_id,status,created_at,attempt,parent_run_id) VALUES(?,?,?,'running',1,2,?)",continued.runId,continued.taskId,continued.runId,scope('C').runId);f.store.run('UPDATE tasks SET run_id=? WHERE id=?',continued.runId,continued.taskId);await f.assets.prepareBusinessContinuation(continued,scope('C').runId);assert.equal(await(await f.assets.streamForRun(continued,cAlias)).text(),'selected summary');await f.assets.assertBusinessOutputForRun(continued,source);
 f.store.run('DELETE FROM message_asset_run_grants WHERE asset_id=? AND run_id=?',f.id,scope('A').runId);await assert.rejects(f.assets.streamForRun(continued,cAlias));await assert.rejects(f.assets.assertBusinessOutputForRun(continued,source));
});

test('grant cannot consume stale validation or substituted target assignment and never grants before a committed intent',async t=>{
 const f=await fixture(t),selected=await f.assets.workItemMaterials().select(scope('A'),[f.ref()],'B'),proof=await f.commit(scope('A'),scope('B'),selected);const port=f.assets.workItemMaterials();await port.validate(scope('A'),selected,'B');f.advance();assert.throws(()=>port.grant(scope('A'),scope('B'),selected,proof),/validation_required/);await port.validate(scope('A'),selected,'B');f.store.run("UPDATE work_item_intents SET state='safe' WHERE id=?",proof.intentId);assert.throws(()=>port.grant(scope('A'),scope('B'),selected,proof),/target_not_authorized/);f.store.run("UPDATE work_item_intents SET state='committed' WHERE id=?",proof.intentId);f.store.run("UPDATE tasks SET source_json='{}' WHERE id=?",scope('B').taskId);assert.throws(()=>port.grant(scope('A'),scope('B'),selected,proof),/target_not_authorized/);
});

test('summary-only handoff revoked after dispatch is blocked before Runtime uploads any task contents or starts a model',async t=>{
 const {HttpTaskRuntime}=await import('../dist/runtime-http.js');const f=await fixture(t);await f.commit(scope('A'),scope('B'),[]);assert.equal(f.assets.listForRun(scope('B')).length,0);await f.assets.revalidateBusinessResourcesForRun(scope('B'));
 const task=f.store.one('SELECT * FROM tasks WHERE id=?',scope('B').taskId),assignment=JSON.parse(task.source_json).assignment;
 const runtime=new HttpTaskRuntime(f.store,{}, {url:'http://127.0.0.1:49691',token:'synthetic-source-transfer-host-token-000000000000'},Date.now,{task:id=>f.store.one('SELECT * FROM tasks WHERE id=?',id)});runtime.setAssetService(f.assets);let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('Must not upload revoked task summary or invoke a model');});
 f.allowed=false;const binding={task_id:task.id,run_id:task.run_id,command_json:JSON.stringify({...scope('B'),sessionId:task.run_id,assignment}),spec_json:JSON.stringify({specHash:'fixture'})};
 await assert.rejects(runtime.prepareMaterials(binding,1),/authorization_required/);assert.equal(calls,0);await assert.rejects(f.assets.revalidateBusinessResourcesForRun(scope('B')),/authorization_required/);
});

test('alias read, metadata and further selection all require the exact durable package digest and committed dispatch state',async t=>{
 for(const mutate of ['digest','dispatch']){const f=await fixture(t),selected=await f.assets.workItemMaterials().select(scope('A'),[f.ref()],'B'),proof=await f.commit(scope('A'),scope('B'),selected),alias=f.assets.listForRun(scope('B'))[0].assetId;
  if(mutate==='digest')f.store.run("UPDATE work_item_resource_transfers SET package_digest='tampered' WHERE intent_id=?",proof.intentId);else f.store.run("UPDATE work_item_dispatches SET state='pending' WHERE id=?",proof.intentId);
  await assert.rejects(f.assets.streamForRun(scope('B'),alias));assert.throws(()=>f.assets.listForRun(scope('B')));await assert.rejects(f.assets.workItemMaterials().select(scope('B'),[{kind:'source_asset',assetId:alias,readKind:'content',version:f.ref().version}],'C'));await assert.rejects(f.assets.revalidateBusinessResourcesForRun(scope('B')));
 }
});
