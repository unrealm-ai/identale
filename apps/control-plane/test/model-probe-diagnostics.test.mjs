import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readdir,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../dist/store.js';
import {ModelProfileService} from '../dist/model-profiles.js';
import {probeImageInput} from '../dist/model-image-probe.js';
import {FileDiagnostics} from '../dist/adapters/diagnostics.js';
import {captureModelResponse} from '@dentity/application';

const secret='SYNTHETIC_PROBE_KEY_DO_NOT_RECORD';
const privateBody='SYNTHETIC_PROBE_BODY_DO_NOT_RECORD';
const responseFor=protocol=>protocol==='openai_responses'?{status:'completed',output:[{type:'message',content:[{type:'output_text',text:privateBody}]}]}:protocol==='anthropic_messages'?{stop_reason:'end_turn',content:[{type:'text',text:privateBody}]}:{choices:[{finish_reason:'stop',message:{content:privateBody}}]};
async function fixture(t,handler,protocol='openai_responses',base='/v1'){
 const root=await mkdtemp(join(tmpdir(),'identity-probe-diagnostic-')),store=new Store(join(root,'isolated.sqlite')),dir=join(root,'diagnostics'),diagnostics=new FileDiagnostics(dir);
 const calls=[];
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push(req.url);handler(req,res,raw,calls.length);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await diagnostics.close();store.close();await rm(root,{recursive:true,force:true});});
 store.run("INSERT INTO users(id,username,display_name) VALUES('u','probe','Probe')");
 store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Isolated probe','u')");
 const input={provider:'openai-compatible',protocol,endpoint:`http://127.0.0.1:${server.address().port}${base}`,modelId:privateBody,apiKey:secret};
 const service=new ModelProfileService(store,{masterKey:Buffer.alloc(32,17),allowLoopbackHttp:true,diagnostics});
 async function records(){await diagnostics.flush();const names=(await readdir(dir)).filter(n=>n.endsWith('.jsonl'));const raw=(await Promise.all(names.map(n=>readFile(join(dir,n),'utf8')))).join('');assert.ok(!raw.includes(secret));assert.ok(!raw.includes(privateBody));assert.ok(!raw.includes(input.endpoint));assert.ok(!raw.includes('connectionTestReceipt'));for(const name of names)assert.equal((await stat(join(dir,name))).mode&0o777,0o600);return raw.trim()?raw.trim().split('\n').map(JSON.parse):[];}
 return{root,dir,store,diagnostics,service,input,calls,records};
}
function json(res,body,status=200,type='application/json'){res.writeHead(status,{'content-type':type,'x-api-key':secret,'set-cookie':secret});res.end(JSON.stringify(body));}
for(const protocol of ['chat_completions','openai_responses','anthropic_messages'])test(`${protocol}: one linked text/image probe; no save, secret or response body in logs`,async t=>{
 const f=await fixture(t,(_req,res,_raw,n)=>n===1?json(res,responseFor(protocol)):json(res,{error:{code:'unsupported_image_input',message:privateBody}},400),protocol);
 const result=await f.service.testConnection('w',null,'u',f.input);
 assert.equal(result.inputCapabilities.text,'passed');assert.equal(result.inputCapabilities.image,'unsupported');assert.equal(f.calls.length,2);assert.equal(f.service.list('w').length,0);
 const rows=await f.records(),ends=rows.filter(r=>r.phase==='end');assert.equal(rows.length,4);assert.equal(new Set(rows.map(r=>r.modelProbe.id)).size,1);assert.deepEqual(rows.map(r=>[r.modelProbe.modality,r.phase]),[['text','start'],['text','end'],['image','start'],['image','end']]);
 assert.deepEqual(ends.map(r=>r.httpStatus),[200,400]);assert.deepEqual(ends.map(r=>r.modelProbe.issue),['passed','unsupported_image']);assert.ok(rows.every(r=>r.operation==='model.connection.test'));assert.ok(ends.every(r=>r.modelProbe.contentType==='json'));
});
for(const [base,path] of [['','/responses'],['/v1','/v1/responses']])test(`Responses endpoint ${path} is distinguishable without logging host`,async t=>{
 const f=await fixture(t,(_req,res)=>json(res,{error:{message:privateBody}},404),'openai_responses',base);
 await assert.rejects(f.service.testConnection('w',null,'u',f.input),e=>e.code==='model_connection_test_failed');
 assert.deepEqual(f.calls,[path]);const [end]=(await f.records()).filter(r=>r.phase==='end');assert.equal(end.modelProbe.endpoint,path);assert.equal(end.httpStatus,404);assert.equal(end.category,'not_found');
});
for(const status of [400,401,403,404,422,429,500,503])test(`HTTP ${status}: retains exact status, original business error, one text attempt and no image`,async t=>{
 const f=await fixture(t,(_req,res)=>json(res,{error:{message:privateBody,api_key:secret}},status));
 await assert.rejects(f.service.testConnection('w',null,'u',f.input),e=>e.code===([400,422].includes(status)?'model_parameters_incompatible':'model_connection_test_failed'));
 assert.equal(f.calls.length,1);const [end]=(await f.records()).filter(r=>r.phase==='end');assert.equal(end.httpStatus,status);assert.equal(end.modelProbe.issue,'http_status');assert.equal(end.modelProbe.contentType,'json');
});
const invalidCases=[
 ['HTML',()=>'<html>'+privateBody+'</html>','text/html; echo='+secret,'payload_json','html'],
 ['SSE',()=>'data: '+JSON.stringify({text:privateBody})+'\n\n','text/event-stream','payload_json','event_stream'],
 ['empty',()=>'', 'application/json','empty_body','json'],
 ['oversize',()=>privateBody.repeat(4000),'application/json','body_limit','json'],
 ['malformed JSON',()=>'{"private":"'+privateBody,'application/json','payload_json','json'],
 ['missing Responses status',()=>JSON.stringify({choices:[{message:{content:privateBody},finish_reason:'stop'}]}),'application/json','response_status_missing','json'],
 ['invalid Responses status',()=>JSON.stringify({status:'failed',error:{message:privateBody}}),'application/json','response_status_invalid','json'],
 ['top-level array',()=>JSON.stringify([privateBody]),'application/json','protocol_shape','json'],
 ['wrong tool shape',()=>JSON.stringify({status:'completed',output:[{type:'function_call',name:privateBody}]}),'application/json','protocol_shape','json'],
 ['vendor JSON mime',()=>'{','application/vendor+json; charset=utf-8','payload_json','json'],
 ['unknown mime',()=>'{','application/'+secret,'payload_json','other'],
];
for(const [label,body,type,issue,contentType] of invalidCases)test(`${label}: format rejection has safe specific diagnosis; no image or retry`,async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':type});res.end(body());});
 await assert.rejects(f.service.testConnection('w',null,'u',f.input),e=>e.code==='model_connection_test_invalid_response');assert.equal(f.calls.length,1);
 const [end]=(await f.records()).filter(r=>r.phase==='end');assert.equal(end.httpStatus,200);assert.equal(end.category,'parse');assert.equal(end.modelProbe.issue,issue);assert.equal(end.modelProbe.contentType,contentType);
});
test('timeout preserves original 20s policy, records no arbitrary exception and releases probe lock',async t=>{
 const f=await fixture(t,()=>{}),original=AbortSignal.timeout.bind(AbortSignal);
 t.mock.method(AbortSignal,'timeout',ms=>{assert.equal(ms,20000);return original(25);});
 await assert.rejects(f.service.testConnection('w',null,'u',f.input),e=>e.code==='model_connection_test_failed');
 const [end]=(await f.records()).filter(r=>r.phase==='end');assert.equal(end.modelProbe.issue,'timeout');assert.equal(end.category,'timeout');assert.equal(end.httpStatus,undefined);
 await assert.rejects(f.service.testConnection('w',null,'u',f.input),e=>e.code==='model_connection_test_failed');
});
test('network and body read failure preserve errors without logging error message or stack',async t=>{
 const f=await fixture(t,()=>{});
 for(const bodyRead of [false,true]){
  t.mock.method(globalThis,'fetch',async()=>{if(!bodyRead)throw Error(secret+privateBody);return new Response(new ReadableStream({start(c){c.error(Error(secret+privateBody));}}),{headers:{'content-type':'application/json'}});});
  await assert.rejects(f.service.testConnection('w',null,'u',f.input),e=>e.code==='model_connection_test_failed');t.mock.restoreAll();
 }
 const ends=(await f.records()).filter(r=>r.phase==='end');assert.deepEqual(ends.map(r=>r.modelProbe.issue),['transport','body_read']);assert.deepEqual(ends.map(r=>r.httpStatus),[undefined,200]);
});
test('redirect stays forbidden; no second path or image request',async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(302,{location:'/private-'+privateBody});res.end();});
 await assert.rejects(f.service.testConnection('w',null,'u',f.input),e=>e.code==='model_connection_test_failed');assert.equal(f.calls.length,1);const [end]=(await f.records()).filter(r=>r.phase==='end');assert.equal(end.modelProbe.issue,'transport');
});
test('image unknown diagnoses format and answer mismatch without changing observed capability',async t=>{
 const f=await fixture(t,()=>{});
 const cases=[new Response('<html>'+privateBody,{headers:{'content-type':'text/html'}}),Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:privateBody}]}]}),Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"shape":"triangle","color":"purple","code":"0000"}'}]}]})];
 for(const response of cases)assert.equal(await probeImageInput({...f.input,diagnostics:f.diagnostics,fetch:async()=>response}),'unknown');
 assert.deepEqual((await f.records()).filter(r=>r.phase==='end').map(r=>r.modelProbe.issue),['payload_json','answer_json','answer_mismatch']);
});
test('image JSON null and null answers remain unknown with accurate diagnosis',async t=>{
 const f=await fixture(t,()=>{});
 for(const response of [Response.json(null),Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'null'}]}]})])assert.equal(await probeImageInput({...f.input,diagnostics:f.diagnostics,fetch:async()=>response}),'unknown');
 assert.deepEqual((await f.records()).filter(r=>r.phase==='end').map(r=>r.modelProbe.issue),['protocol_shape','answer_mismatch']);
});
test('concurrent independent probes have distinct IDs without mixing text/image correlation',async t=>{
 const protocol='openai_responses',f=await fixture(t,(_req,res,raw)=>JSON.parse(raw).input?.[0]?.content?.some(p=>p.type==='input_image')?json(res,{error:{code:'unsupported_image_input'}},400):json(res,responseFor(protocol)));
 const results=await Promise.all(['u','u2'].map(actor=>f.service.testConnection('w',null,actor,f.input)));assert.ok(results.every(r=>r.inputCapabilities.image==='unsupported'));assert.equal(f.calls.length,4);
 const rows=await f.records(),ids=[...new Set(rows.map(r=>r.modelProbe.id))];assert.equal(ids.length,2);for(const id of ids)assert.deepEqual(rows.filter(r=>r.modelProbe.id===id).map(r=>[r.modelProbe.modality,r.phase]),[['text','start'],['text','end'],['image','start'],['image','end']]);
});
test('invalid direct image endpoint still returns unknown and never logs its raw path',async()=>{
 const rows=[],diagnostics={context:()=>undefined,run:(_c,work)=>work(),event:r=>rows.push(r),span:(_s,work)=>work()};
 assert.equal(await probeImageInput({endpoint:'invalid '+privateBody,apiKey:secret,modelId:'fixture',diagnostics,fetch:async()=>{throw Error(secret);}}),'unknown');
 assert.equal(rows.at(-1).modelProbe.endpoint,'other');assert.equal(rows.at(-1).modelProbe.issue,'transport');assert.ok(!JSON.stringify(rows).includes(secret)&&!JSON.stringify(rows).includes(privateBody));
});
test('diagnostic failure cannot change successful text receipt or unsupported image observation',async t=>{
 const protocol='openai_responses',f=await fixture(t,(_req,res,_raw,n)=>n%2?json(res,responseFor(protocol)):json(res,{error:{code:'unsupported_image_input'}},400));
 const throwing={context:()=>undefined,run:(_c,work)=>work(),event:()=>{throw Error(secret);},span:(_s,work)=>work()};
 const service=new ModelProfileService(f.store,{masterKey:Buffer.alloc(32,17),allowLoopbackHttp:true,diagnostics:throwing});const result=await service.testConnection('w',null,'u',f.input);assert.equal(result.inputCapabilities.image,'unsupported');assert.ok(result.connectionTestReceipt);assert.equal(f.calls.length,2);
});
test('file sink reconstructs probe metadata and cannot capture body even with enabled model capture',async t=>{
 const f=await fixture(t,()=>{}),id=randomUUID();
 f.diagnostics.event({stage:'model.http',phase:'point',operation:'model.connection.test',outcome:'failure',modelProbe:{id,modality:'text',protocol:'openai_responses',endpoint:'/responses',contentType:'html',issue:'payload_json',headers:{authorization:secret},body:privateBody,apiKey:secret},modelResponse:captureModelResponse(privateBody,{model:privateBody,secrets:[]}),text:privateBody,json:{secret}});
 const [row]=await f.records();assert.deepEqual(row.modelProbe,{id,modality:'text',protocol:'openai_responses',endpoint:'/responses',contentType:'html',issue:'payload_json'});assert.equal(row.modelResponse,undefined);assert.equal(row.text,undefined);assert.equal(row.json,undefined);
 f.diagnostics.event({stage:'model.http',phase:'end',operation:'model.connection.test',modelProbe:{id:secret,modality:'text',protocol:'openai_responses',endpoint:'/responses'}});
 f.diagnostics.event({stage:'model.http',phase:'end',operation:'model.connection.test',modelProbe:{id,modality:'text',protocol:'openai_responses',endpoint:'/responses',contentType:secret,issue:privateBody}});
 const rows=await f.records();assert.equal(rows[1].modelProbe,undefined);assert.deepEqual(rows[2].modelProbe,{id,modality:'text',protocol:'openai_responses',endpoint:'/responses'});
});
