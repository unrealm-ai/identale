import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileDiagnostics} from '../dist/adapters/diagnostics.js';
import {safeModelRequestDiagnostic,captureModelResponse} from '@dentity/application';
import {OpenAICompatibleModelClient} from '../../../packages/runtime-builtin/dist/index.js';

const secret='SYNTHETIC_SECRET_MUST_NOT_APPEAR',privateText='SYNTHETIC_PRIVATE_MESSAGE_MUST_NOT_APPEAR';
const data=Buffer.from('SYNTHETIC_IMAGE_MUST_NOT_APPEAR').toString('base64');
const context={traceId:'a'.repeat(64),messageId:'b'.repeat(64),turnId:'c'.repeat(64)};
const ref={assetId:'private-asset-reference',version:'private-version-reference'};
const valid={id:'11111111-1111-4111-8111-111111111111',protocol:'openai_responses',imageInputEnabled:true,referencedImages:1,readImages:1,imageBlocks:1,imageBytes:29,requestBytes:1234};
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'identity-model-request-metadata-')),log=new FileDiagnostics(dir,{warn:()=>{}});t.after(async()=>{await log.close();await rm(dir,{recursive:true,force:true});});return{log,async rows(){await log.flush();const raw=(await Promise.all((await readdir(dir)).filter(n=>n.endsWith('.jsonl')).map(n=>readFile(join(dir,n),'utf8')))).join('');for(const forbidden of [secret,privateText,data,'fixture.invalid',ref.assetId,ref.version])assert.equal(raw.includes(forbidden),false);return raw.trim()?raw.trim().split('\n').map(JSON.parse):[];}};}
function reply(protocol){return protocol==='openai_responses'?{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'ok'}]}],usage:{input_tokens:1,output_tokens:1}}:protocol==='anthropic_messages'?{stop_reason:'end_turn',content:[{type:'text',text:'ok'}],usage:{input_tokens:1,output_tokens:1}}:{choices:[{finish_reason:'stop',message:{content:'ok'}}],usage:{prompt_tokens:1,completion_tokens:1}};}
const input=()=>({messages:[{role:'user',content:privateText,images:[ref]}],tools:[],maxOutputTokens:128,signal:new AbortController().signal});

for(const protocol of ['chat_completions','openai_responses','anthropic_messages'])test(protocol+' records final wire counts and bytes without model, content, image, credential, URL or asset references',async t=>{
 const f=await fixture(t);let calls=0,reads=0,bytes=0;
 const client=new OpenAICompatibleModelClient({protocol,endpoint:'https://fixture.invalid/v1',model:'private-model-name',secretRef:'private-profile',imageInput:true,readImage:async r=>{assert.deepEqual(r,ref);reads++;return{data,mediaType:'image/png'};}},async()=>secret,async(_url,init)=>{calls++;bytes=Buffer.byteLength(init.body);const b=JSON.parse(init.body),messages=protocol==='openai_responses'?b.input:b.messages;assert.ok(JSON.stringify(messages).includes(data));return Response.json(reply(protocol));},f.log);
 const original=input(),before=JSON.stringify(original.messages);assert.equal((await f.log.run(context,()=>client.complete(original))).text,'ok');assert.equal(JSON.stringify(original.messages),before);assert.equal(calls,1);assert.equal(reads,1);
 const rows=(await f.rows()).filter(r=>r.operation==='model.request.metadata');assert.equal(rows.length,1);const r=rows[0];assert.equal(r.traceId,context.traceId);assert.equal(r.turnId,context.turnId);assert.match(r.modelRequest.id,/^[a-f0-9-]{36}$/);assert.deepEqual({...r.modelRequest,id:valid.id},{...valid,protocol,imageBytes:Buffer.byteLength(data,'base64'),requestBytes:bytes});
});

for(const enabled of [false,true])test('text-only request reports zero actual images; image capability='+enabled,async t=>{
 const f=await fixture(t);let calls=0;const value=input();if(enabled)value.messages[0].images=[];
 const client=new OpenAICompatibleModelClient({endpoint:'https://fixture.invalid/v1',model:'fixture',secretRef:'fixture',imageInput:enabled,readImage:async()=>{throw Error('must not read');}},async()=>secret,async()=>{calls++;return Response.json(reply('chat_completions'));},f.log);
 await f.log.run(context,()=>client.complete(value));assert.equal(calls,1);const r=(await f.rows()).find(r=>r.modelRequest).modelRequest;assert.equal(r.imageInputEnabled,enabled);assert.equal(r.referencedImages,enabled?0:1);assert.equal(r.readImages,0);assert.equal(r.imageBlocks,0);assert.equal(r.imageBytes,0);
});

test('unavailable image fails before request metadata and before any transport call',async t=>{
 const f=await fixture(t);let calls=0;const client=new OpenAICompatibleModelClient({endpoint:'https://fixture.invalid/v1',model:'fixture',secretRef:'fixture',imageInput:true,readImage:async()=>{throw Error(privateText);}},async()=>secret,async()=>{calls++;throw Error('not reached');},f.log);
 await assert.rejects(f.log.run(context,()=>client.complete(input())));assert.equal(calls,0);assert.equal((await f.rows()).filter(r=>r.modelRequest).length,0);
});

test('sink reconstructs fixed whitelist and disallows body capture or arbitrary nested metadata',async t=>{
 const f=await fixture(t);f.log.run(context,()=>f.log.event({stage:'model.http',phase:'point',operation:'model.request.metadata',outcome:'failure',modelRequest:{...valid,model:privateText,url:'https://fixture.invalid',headers:{authorization:secret},image:data,text:privateText,nested:{secret}},modelResponse:captureModelResponse(privateText,{model:privateText,secrets:[]}),text:privateText,json:{secret}}));
 const [r]=await f.rows();assert.deepEqual(r.modelRequest,valid);assert.equal(r.modelResponse,undefined);assert.equal(r.text,undefined);assert.equal(r.json,undefined);
});

test('validator rejects invalid IDs, protocols and unbounded/non-integer counts instead of logging them',()=>{
 assert.deepEqual(safeModelRequestDiagnostic({...valid,secret}),valid);
 for(const value of [null,[],{...valid,id:secret},{...valid,protocol:secret},{...valid,imageInputEnabled:secret}])assert.equal(safeModelRequestDiagnostic(value),undefined);
 for(const key of ['referencedImages','readImages','imageBlocks','imageBytes','requestBytes'])for(const value of [-1,0.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,secret])assert.equal(safeModelRequestDiagnostic({...valid,[key]:value}),undefined);
});

test('request metadata is emitted once and cannot change the wire request on transport retry',async t=>{
 const f=await fixture(t);const bodies=[];const client=new OpenAICompatibleModelClient({endpoint:'https://fixture.invalid/v1',model:'fixture',secretRef:'fixture'},async()=>secret,async(_url,init)=>{bodies.push(init.body);return bodies.length===1?Response.json({error:{code:'rate_limit_exceeded'}},{status:429}):Response.json(reply('chat_completions'));},f.log);
 assert.equal((await f.log.run(context,()=>client.complete(input()))).text,'ok');assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.equal((await f.rows()).filter(r=>r.modelRequest).length,1);
});

test('throwing diagnostic observer does not prevent the request or alter the model result',async()=>{
 const diagnostics={context:()=>undefined,run:(_c,work)=>work(),span:(_s,work)=>work(),event:event=>{if(event.operation==='model.request.metadata')throw Error(secret);}};let calls=0;
 const client=new OpenAICompatibleModelClient({endpoint:'https://fixture.invalid/v1',model:'fixture',secretRef:'fixture'},async()=>secret,async()=>{calls++;return Response.json(reply('chat_completions'));},diagnostics);
 assert.equal((await client.complete(input())).text,'ok');assert.equal(calls,1);
});
