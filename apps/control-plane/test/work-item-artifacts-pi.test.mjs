import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {mkdtemp, realpath, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {createServer as createPlatform} from '../dist/server.js';
import {createServer as createHost} from '../../runtime-host-pi/dist/server.js';
import {PiRuntimeAdapter} from '../../runtime-host-pi/dist/adapter.js';
import {PassiveMaterials} from '../../runtime-host-pi/dist/materials.js';
import {materializeAsset} from '../../runtime-host-pi/dist/asset-materializer.js';
import {HostArtifacts} from '../../runtime-host-pi/dist/artifacts.js';
import {WorkerPiDriver} from '../../runtime-host-pi/dist/driver.js';
import {callWorkItem} from '../../runtime-host-pi/dist/work-item-tools.js';
import {Store} from '../dist/store.js';
import {ModelProfileService} from '../dist/model-profiles.js';

// Real SDK + child worker + authenticated HTTP Host. Only the model is synthetic.
// All data, files and credentials belong to this isolated temporary fixture.
test('real Pi: explicit artifacts survive acceptance, return and revision without implicit file grants', {timeout:180000}, async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'identity-work-item-artifacts-pi-')));
  const origin = 'http://127.0.0.1:5173';
  let app, host, model, fixtureStore, tasks, items, phase = 0;
  const employeeIds = [], publications = [], reads = [], currentViews = [], errors = [], invocations = new Map();
  const contents = ['Synthetic report v1: missing appendix.', 'Synthetic report v2: appendix complete.'];
  const deniedId = '00000000-0000-4000-8000-000000000000';
  t.after(async () => {
    await app?.close(); await host?.close();
    if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
    fixtureStore?.close(); await rm(dir, {recursive:true, force:true});
  });
  const textOf = m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(x => x.text ?? '').join('');
  const resultsOf = messages => messages.filter(m => m.role === 'tool').map(m => {
    try { return JSON.parse(textOf(m)); } catch { return textOf(m); }
  });
  const chunk = (delta, finish) => 'data: ' + JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'synthetic',choices:[{index:0,delta,finish_reason:finish}]}) + '\n\n';
  model = httpServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw), results = resultsOf(body.messages);
      const calls = body.messages.flatMap(m => m.tool_calls ?? []);
      const step = calls.length, current = results.find(v => v?.item);
      const item = current?.item;
      const material = current?.materials?.[0];
      const expected = item && {expectedAssignmentId:item.currentAssignmentId, expectedVersion:item.version};
      const last = results.at(-1);
      let name, args;
      const choose = (n, a) => { name=n; args=a; };
      if (phase === 0) {
        assert.equal(step, 0);
        choose('work_item_handoff', {targetEmployeeId:employeeIds[1],title:'Synthetic artifact roundtrip',goal:'Deliver and revise a synthetic file',criteria:'Appendix complete',summary:'Produce revision one'});
      } else if (step === 0) choose('work_item_get_current', {});
      else if (phase === 1) {
        if (step === 1) { assert.deepEqual(current.materials ?? [], []); choose('write',{path:'hidden.txt',content:'Published but NOT handed off'}); }
        if (step === 2) choose('artifact_publish',{path:'hidden.txt'});
        if (step === 3) choose('write',{path:'report.txt',content:contents[0]});
        if (step === 4) choose('artifact_publish',{path:'report.txt'});
        if (step === 5) { assert.ok(last.content?.version); choose('work_item_finish',{...expected,summary:'Revision one ready',completionEvidence:'Report published',artifactRefs:[last.content]}); }
      } else {
        assert.equal(current.materials.length, 1, 'Only the explicitly selected artifact is granted');
        assert.equal(material.content.version, publications.filter(p=>p.value.name==='report.txt')[phase === 4 ? 1 : 0].value.content.version);
        if (step === 1) choose('asset_read',{asset_id:phase === 4 ? currentViews[1].materials[0].assetId : deniedId,kind:'content'});
        if (step === 2) { assert.match(String(last),/Asset is not authorized/); choose('asset_read',{asset_id:material.assetId,kind:'content'}); }
        if (step === 3) { assert.equal(last.state,'ready'); assert.ok(last.path.startsWith(dir+'/')); choose('read',{path:last.path}); }
        if (step === 4) {
          assert.ok(textOf(body.messages.filter(m=>m.role==='tool').at(-1)).includes(contents[phase === 4 ? 1 : 0]), 'Pi reads the actual transferred bytes');
          if (phase === 2) choose('work_item_handoff',{...expected,targetEmployeeId:employeeIds[1],summary:'Add the missing appendix',artifactRefs:[material.content]});
          if (phase === 3) choose('write',{path:'report.txt',content:contents[1]});
          if (phase === 4) choose('work_item_finish',{...expected,summary:'Accepted complete revision',completionEvidence:'Read and verified appendix'});
        }
        if (phase === 3 && step === 5) choose('artifact_publish',{path:'report.txt'});
        if (phase === 3 && step === 6) { assert.ok(last.content?.version); choose('work_item_finish',{...expected,summary:'Revision two ready',completionEvidence:'Appendix added',artifactRefs:[last.content]}); }
      }
      assert.ok(name, JSON.stringify({phase,step,results}));
      assert.ok(body.tools.some(tool=>tool.function.name===name), 'Real Pi exposes '+name+'; offered='+JSON.stringify(body.tools.map(t=>t.function.name)));
      if (name === 'work_item_handoff' || name === 'work_item_finish') phase++;
      res.writeHead(200, {'content-type':'text/event-stream'});
      res.end(chunk({tool_calls:[{index:0,id:'phase-'+phase+'-step-'+step,type:'function',function:{name,arguments:JSON.stringify(args)}}]},null)+chunk({},'tool_calls')+'data: [DONE]\n\n');
    } catch (error) { errors.push(error.stack); res.writeHead(500); res.end('Synthetic assertion failed'); }
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const materials = new PassiveMaterials(join(dir,'host','materials'));
  const artifacts = new HostArtifacts(join(dir,'host','artifacts'));
  const remember = input => invocations.set(input.context.authorizationRef,input);
  const driver = new WorkerPiDriver(async (input,id,kind) => {
    remember(input);
    const result = await materializeAsset(await materials.asset(id,kind,input.context),id,join(input.executionResource.directory,'assets'));
    reads.push({runId:input.context.authorizationRef,directory:input.executionResource.directory,result}); return result;
  }, undefined, async (input,operation,query) => {
    remember(input);
    const result = await callWorkItem(materials.workItems(input.context),operation,query);
    if (operation === 'get_current' && !query?.roleOnly) currentViews.push(result);
    return result;
  }, false, async (input,path,operationId) => {
    remember(input);
    const value = await artifacts.publish({runId:input.context.authorizationRef,workspaceId:input.context.workspaceId,entityId:input.context.entityId},input.executionResource.directory,path,operationId);
    publications.push({runId:input.context.authorizationRef,directory:input.executionResource.directory,value}); return value;
  });
  host = createHost({token:'synthetic-artifact-host-token-20261107-000000001',adapter:new PiRuntimeAdapter(join(dir,'host'),materials,driver,'local-pi',undefined,1)});
  await host.listen({host:'127.0.0.1',port:0});
  const hostConfig = {url:'http://127.0.0.1:'+host.server.address().port,token:'synthetic-artifact-host-token-20261107-000000001',workItemUrl:'http://127.0.0.1:1/internal/runtime/work-items'};
  app = createPlatform({databasePath:join(dir,'db.sqlite'),origin,pollIntervalMs:0,triggers:{automatic:false},directorySync:{automatic:false},maintenance:{enabled:false},runtimeHost:hostConfig,modelProfiles:{masterKey:Buffer.alloc(32,41),allowLoopbackHttp:true},modelClient:{async complete(){return{text:'Synthetic discussion',usage:{inputTokens:1,outputTokens:1}};}},onService:s=>tasks=s,onWorkItemService:s=>items=s});
  await app.listen({host:'127.0.0.1',port:0});
  hostConfig.workItemUrl='http://127.0.0.1:'+app.server.address().port+'/internal/runtime/work-items';
  const call = (method,url,payload,cookie) => app.inject({method,url,payload,headers:{origin,...(cookie?{cookie}:{})}});
  const registered = await call('POST','/api/auth/register',{username:'artifact-roundtrip',password:'Isolated synthetic password 2026!'});
  assert.equal(registered.statusCode,201,registered.body);
  const user=registered.json(), cookie=registered.headers['set-cookie'].split(';')[0], ws='/api/workspaces/'+user.workspace.id;
  fixtureStore=new Store(join(dir,'db.sqlite'));
  const profiles=new ModelProfileService(fixtureStore,{masterKey:Buffer.alloc(32,41),allowLoopbackHttp:true});
  for (const name of ['A','B']) {
    const response=await call('POST',ws+'/entities',{name:'Synthetic '+name,ownWebUse:true},cookie);
    assert.equal(response.statusCode,200,response.body); const employee=response.json().entity;
    employeeIds.push(employee.id);
    profiles.save(user.workspace.id,employee.id,{provider:'openai-compatible',endpoint:'http://127.0.0.1:'+model.address().port+'/v1',modelId:'synthetic',apiKey:'synthetic-model-token'});
  }
  const config=items.configuration.get(user.workspace.id);
  items.configuration.save(user.workspace.id,user.user.id,{expectedRevision:config.revision,enabled:true});
  await tasks.tick();
  assert.equal(items.status(user.workspace.id).enabled,true);
  const base=ws+'/entities/'+employeeIds[0];
  const conversation=await call('POST',base+'/conversations',{operationId:'artifact-conversation'},cookie);
  assert.equal(conversation.statusCode,201,conversation.body);
  const created=await call('POST',base+'/tasks',{operationId:'artifact-root',conversationId:conversation.json().conversation.id,input:'Start the synthetic artifact collaboration',contextMode:'new'},cookie);
  assert.equal(created.statusCode,202,created.body);
  const deadline=Date.now()+120000;
  while (Date.now()<deadline) {
    await tasks.tick();
    assert.deepEqual(errors,[]);
    if (items.list(user.workspace.id).items[0]?.status==='completed') break;
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  assert.equal(items.list(user.workspace.id).items[0]?.status,'completed',JSON.stringify({phase,errors,tasks:items.store.all('SELECT status FROM tasks'),intents:items.store.all('SELECT state FROM work_item_intents')}));
  assert.equal(phase,5);
  assert.equal(items.store.one('SELECT count(*) n FROM tasks').n,5);
  assert.equal(new Set([...invocations.values()].map(i=>i.executionResource.directory)).size,5);
  assert.equal(currentViews.length,4);
  for (const [index,view] of currentViews.slice(1).entries()) {
    const source=publications.filter(p=>p.value.name==='report.txt')[index===2?1:0];
    assert.equal(view.materials[0].sourceRunId,source.runId);
    assert.equal(view.materials[0].sourceTaskId,invocations.get(source.runId).context.target.taskId);
  }
  assert.equal(reads.length,3);
  const reports=publications.filter(p=>p.value.name==='report.txt');
  assert.equal(publications.length,3); assert.equal(reports.length,2);
  assert.notEqual(reports[0].value.content.version,reports[1].value.content.version);
  for (const [index,read] of reads.entries()) {
    assert.equal(read.result.state,'ready');
    assert.ok(!relative(read.directory,read.result.path).startsWith('..'));
    assert.equal(await readFile(read.result.path,'utf8'),contents[index===2?1:0]);
    assert.notEqual(read.directory,reports[index===2?1:0].directory);
  }
  assert.notEqual(reads[0].result.path,reads[1].result.path,'Return material is copied into a different task workspace');
  for (const [index,report] of reports.entries()) {
    assert.equal(await readFile((await artifacts.read(report.runId,report.value.content)).path,'utf8'),contents[index]);
    await assert.rejects(artifacts.read(report.runId,{...report.value.content,version:'0'.repeat(64)}),/artifact_not_granted/);
    await assert.rejects(artifacts.read(reads[0].runId,report.value.content),/artifact_not_granted/);
  }
  for (const view of currentViews) assert.ok(!(view.materials??[]).some(m=>m.content.resourceId===publications[0].value.content.resourceId),'Published but unselected files never become task materials');

  // A delayed live-manifest response must not erase a later publication. Exercise
  // the real runtime persistence boundary, without replacing its transport/store.
  const passiveRuntime=tasks.runtime;
  const publicationRun=reports[0].runId;
  const originalManifest=passiveRuntime.artifacts(publicationRun);
  assert.equal(originalManifest.length,2);
  const hidden=originalManifest.find(a=>a.name==='hidden.txt');
  const originalReport=originalManifest.find(a=>a.name==='report.txt');
  assert.ok(hidden); assert.ok(originalReport);
  passiveRuntime.recordArtifacts(publicationRun,[hidden]);
  assert.deepEqual(passiveRuntime.artifacts(publicationRun),originalManifest,'An older partial response cannot drop a published report');
  for (const conflicting of [
    {...originalReport,content:{...originalReport.content,version:'0'.repeat(64)}},
    {...originalReport,name:'changed-description.txt'},
  ]) {
    assert.throws(()=>passiveRuntime.recordArtifacts(publicationRun,[hidden,conflicting]),/artifact.*conflict/);
    assert.deepEqual(passiveRuntime.artifacts(publicationRun),originalManifest,'A conflicting descriptor leaves the complete prior manifest intact');
  }

});
