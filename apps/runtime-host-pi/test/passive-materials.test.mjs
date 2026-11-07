import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PassiveMaterials,materialDigest} from '../dist/materials.js';
const digest=b=>createHash('sha256').update(b).digest('hex');
const ref=id=>({resourceId:id,version:'1'});
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'pi-passive-'));t.after(()=>rm(dir,{recursive:true,force:true}));const m=new PassiveMaterials(dir);
 const bytes=Buffer.from('Fixed text'),blob={sha256:digest(bytes),byteLength:bytes.length};m.putBlob(bytes,blob.sha256);
 const body={version:1,model:{provider:'test',modelId:'test-model',apiKey:'SYNTHETIC_PASSIVE_ONLY'},skills:[],mcp:[]};const cfg={...body,configurationId:materialDigest(body)};m.putConfiguration(cfg);
 const context={workspaceId:'w',entityId:'e',authorizationRef:'run',expiresAt:'2099-01-01T00:00:00Z',sessionId:'session',invocationId:'run',configRevision:'1',target:{kind:'task_run',taskId:'task',runId:'run'}};
 const execution={runtime:{runtimeId:'local-pi',workspaceId:'w',entityId:'e'},executionId:'run',sessionId:'session',invocationId:'run',target:context.target};
 const spec={workspaceId:'w',entityId:'e',authorizationRef:'run',modelProfileRef:ref('model')};
 const packet={version:1,configurationId:cfg.configurationId,context,spec,execution,contents:[{ref:ref('input'),blob}],assets:[],history:null};m.putRun(packet);
 const request={schemaVersion:1,operationId:'op',correlationId:'run',causationId:'op',deadlineAt:'2099-01-01T00:00:00Z',authorizationContext:context,payload:{execution}};
 return{m,dir,blob,cfg,context,execution,packet,request};
}
test('passive material persisted restart, same digest reuse, and isolated versions',async t=>{
 const f=await fixture(t);assert.deepEqual(f.m.missing([f.blob]),[]);assert.deepEqual(f.m.putConfiguration(f.cfg),f.m.inspect(f.cfg.configurationId));
 const restarted=new PassiveMaterials(f.dir);assert.equal(await restarted.content(ref('input'),f.context),'Fixed text');assert.equal(await restarted.verify(f.request),true);
 const body={...f.cfg,model:{...f.cfg.model,modelId:'new'}};delete body.configurationId;const newer={...body,configurationId:materialDigest(body)};f.m.putConfiguration(newer);assert.equal((await restarted.model(ref('model'),f.context)).modelId,'test-model');
 assert.throws(()=>f.m.putRun({...f.packet,configurationId:newer.configurationId}),/conflict/);
});
test('no cross-workspace, execution, expired-envelope or undeclared content grant',async t=>{
 const f=await fixture(t);assert.equal(await f.m.verify({...f.request,authorizationContext:{...f.context,workspaceId:'foreign'}}),false);
 assert.equal(await f.m.verify({...f.request,payload:{execution:{...f.execution,sessionId:'foreign'}}}),false);
 assert.equal(await f.m.verify({...f.request,payload:{handle:{specHash:'foreign',specId:'foreign',isolationScope:{authorizationRef:'other'}}}}),false);
 assert.equal(await f.m.verify({...f.request,authorizationContext:{...f.context,expiresAt:'not-a-date'}}),false);
 assert.equal(await f.m.verify({...f.request,deadlineAt:'2000-01-01T00:00:00Z'}),false);
 await assert.rejects(()=>f.m.content(ref('other'),f.context),/not_granted/);
 assert.throws(()=>f.m.putRun({...f.packet,execution:{...f.execution,sessionId:'foreign'}}),/execution_mismatch/);
});
test('append only immutable inputs, hash mismatch and missing resources fail closed',async t=>{
 const f=await fixture(t);assert.throws(()=>f.m.putBlob(Buffer.from('different'),f.blob.sha256),/integrity/);
 assert.throws(()=>f.m.putRun({...f.packet,contents:[]}),/immutable_input/);
 assert.throws(()=>f.m.putRun({...f.packet,contents:[...f.packet.contents,{ref:ref('new'),blob:{sha256:'0'.repeat(64),byteLength:1}}]}));
 const added={...f.packet,contents:[...f.packet.contents,{ref:ref('new'),blob:f.blob}]};f.m.putRun(added);f.m.putRun(added);assert.equal(await f.m.content(ref('new'),f.context),'Fixed text');
});
test('assets and outputs are fixed refs; raw content does not enter execution events',async t=>{
 const f=await fixture(t),id='11111111-1111-4111-8111-111111111111';f.m.putRun({...f.packet,assets:[{assetId:id,kind:'file',reads:{content:{...f.blob,mediaType:'text/plain'},transcript:{state:'not_available'}}}]});
 assert.equal(await(await f.m.asset(id,'content',f.context)).text(),'Fixed text');assert.equal((await f.m.asset('foreign','content',f.context)).state,'no_permission');assert.equal((await f.m.asset(id,'transcript',f.context)).state,'not_available');
 const out=await f.m.storeOutput('Final result',f.context);assert.match(out.resourceId,/^host-output:/);assert.equal(f.m.readOutput(out,f.context),'Final result');
 await assert.rejects(()=>f.m.storeOutput('forbidden',{...f.context,entityId:'foreign'}));
 assert.equal((await readFile(join(f.dir,'config-'+f.cfg.configurationId),'utf8')).includes('SYNTHETIC_PASSIVE_ONLY'),true,'Secrets live only in private prepared config, no execution journal');
});
test('tampered and permissive material files are rejected after restart',async t=>{
 const f=await fixture(t);await writeFile(join(f.dir,'blob-'+f.blob.sha256),'tampered');await assert.rejects(()=>f.m.content(ref('input'),f.context),/integrity/);
 await chmod(f.dir,0o755);assert.throws(()=>new PassiveMaterials(f.dir),/unsafe/);await chmod(f.dir,0o700);
});

test('passive production Host has no business resolver environment or network client',async()=>{
 const main=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');assert.doesNotMatch(main,/httpResolver|DENTITY_PLATFORM_RESOLVER/);assert.match(main,/new PassiveMaterials/);
 const local=await readFile(new URL('../src/materials.ts',import.meta.url),'utf8');assert.doesNotMatch(local,/fetch\s*\(/);
});

test('Skill reference includes digest and cannot be replaced by a shortened or mismatched reference',async t=>{
 const f=await fixture(t),fixed={resourceId:'uploaded-skill-fixed',version:'1',digest:'a'.repeat(64)},body={version:1,model:f.cfg.model,skills:[{ref:fixed,blob:f.blob}],mcp:[]},cfg={...body,configurationId:materialDigest(body)};f.m.putConfiguration(cfg);
 const context={...f.context,authorizationRef:'run-skill',target:{...f.context.target,runId:'run-skill'},invocationId:'run-skill'},execution={...f.execution,executionId:'run-skill',invocationId:'run-skill',target:context.target};
 f.m.putRun({...f.packet,configurationId:cfg.configurationId,context,execution,spec:{...f.packet.spec,authorizationRef:'run-skill'}});
 assert.equal(await f.m.content(fixed,context),'Fixed text');await assert.rejects(()=>f.m.content({resourceId:fixed.resourceId,version:fixed.version},context),/not_granted/);await assert.rejects(()=>f.m.content({...fixed,digest:'b'.repeat(64)},context),/not_granted/);
});

test('material HTTP routes require execution credential, reject monitor writes and unsupported versions',async t=>{
 const f=await fixture(t),{PiRuntimeAdapter}=await import('../dist/adapter.js'),{createServer}=await import('../dist/server.js');
 const adapter=new PiRuntimeAdapter(join(f.dir,'host'),f.m,{start(){throw Error('No task may start in protocol test');}}),app=createServer({token:'execution-only',monitorToken:'monitor-only',adapter});t.after(()=>app.close());
 const invoke=(url,payload,token='execution-only')=>app.inject({method:'POST',url,payload,headers:{authorization:'Bearer '+token}});
 assert.equal((await invoke('/v2/materials/inspect',{configurationId:f.cfg.configurationId},'monitor-only')).statusCode,401);
 const ready=await invoke('/v2/materials/inspect',{configurationId:f.cfg.configurationId});assert.equal(ready.statusCode,200);assert.equal(ready.json().sdk,'initializes_on_submit');assert.equal(ready.json().prepared,f.cfg.configurationId);
 assert.equal((await invoke('/v2/materials/configuration',{...f.cfg,version:2})).statusCode,409);
 assert.equal((await invoke('/v2/materials/run',{...f.packet,context:{...f.context,workspaceId:'foreign'}})).statusCode,409);
});

test('pending asset may become a fixed ready version, which later refresh cannot replace',async t=>{
 const f=await fixture(t),id='11111111-1111-4111-8111-111111111111';f.m.putRun({...f.packet,assets:[{assetId:id,kind:'file',reads:{content:{state:'pending'}}}]});assert.equal((await f.m.asset(id,'content',f.context)).state,'pending');
 f.m.putRun({...f.packet,assets:[{assetId:id,kind:'file',reads:{content:{...f.blob,mediaType:'text/plain'}}}]});assert.equal(await(await f.m.asset(id,'content',f.context)).text(),'Fixed text');
 assert.throws(()=>f.m.putRun({...f.packet,assets:[{assetId:id,kind:'file',reads:{content:{state:'pending'}}}]}),/immutable_asset/);
});

test('material CAS accommodates existing large Skill snapshot encoding while keeping a hard limit',async t=>{
 const f=await fixture(t),{MAX_RUNTIME_MATERIAL_BYTES}=await import('@dentity/contracts');assert.equal(MAX_RUNTIME_MATERIAL_BYTES,150*1024*1024);
 const bytes=Buffer.alloc(106_000_000,97),sha=digest(bytes);f.m.putBlob(bytes,sha);assert.deepEqual(f.m.missing([{sha256:sha,byteLength:bytes.length}]),[]);assert.throws(()=>f.m.putBlob(Buffer.alloc(0),'invalid'),/integrity/);
});


test('prepared configurations detect and repair deleted or corrupt dependencies without changing versions or scope',async t=>{
 const f=await fixture(t),body={version:1,model:f.cfg.model,skills:[{ref:ref('skill-one'),blob:f.blob}],mcp:[{ref:ref('mcp-one'),blob:f.blob}]},cfg={...body,configurationId:materialDigest(body)};
 f.m.putConfiguration(cfg);f.context={...f.context,authorizationRef:'repair-run',invocationId:'repair-run',target:{...f.context.target,runId:'repair-run'}};const execution={...f.execution,executionId:'repair-run',invocationId:'repair-run',target:f.context.target};const packet={...f.packet,configurationId:cfg.configurationId,context:f.context,execution,spec:{...f.packet.spec,authorizationRef:'repair-run'}};f.m.putRun(packet);const path=join(f.dir,'blob-'+f.blob.sha256);
 assert.equal(f.m.inspect(cfg.configurationId).resources,'ready');await rm(path);
 let observed=f.m.inspect(cfg.configurationId);assert.equal(observed.prepared,null);assert.equal(observed.resources,'not_ready');assert.match(observed.reason,/missing_or_corrupt/);assert.deepEqual(observed.missing,[f.blob,f.blob]);assert.throws(()=>f.m.putRun(packet),/not_ready/);
 const bytes=Buffer.from('Fixed text');f.m.putBlob(bytes,f.blob.sha256);assert.equal(f.m.inspect(cfg.configurationId).prepared,cfg.configurationId);f.m.putRun(packet);
 // Same-length corruption changes ctime/mtime: a previous successful stat cache cannot mask it.
 await writeFile(path,Buffer.from('Wrong text'));assert.equal(f.m.inspect(cfg.configurationId).resources,'not_ready');await assert.rejects(()=>f.m.content(ref('skill-one'),f.context),/integrity/);
 f.m.putBlob(bytes,f.blob.sha256);assert.equal(await f.m.content(ref('skill-one'),f.context),'Fixed text');assert.equal(f.m.inspect(cfg.configurationId).prepared,cfg.configurationId);
 const newerBody={...body,model:{...body.model,modelId:'future'}};const newer={...newerBody,configurationId:materialDigest(newerBody)};f.m.putConfiguration(newer);assert.equal((await f.m.model(ref('model'),f.context)).modelId,'test-model');assert.throws(()=>f.m.putRun({...packet,configurationId:newer.configurationId}),/conflict/);
 await assert.rejects(()=>f.m.content(ref('skill-one'),{...f.context,workspaceId:'foreign'}),/scope/);
 await writeFile(path,'corrupt');await chmod(path,0o644);assert.throws(()=>f.m.putBlob(bytes,f.blob.sha256),/unsafe/);await chmod(path,0o600);await rm(path);await symlink(join(f.dir,'not-present'),path);assert.throws(()=>f.m.putBlob(bytes,f.blob.sha256),/unsafe/);
});
