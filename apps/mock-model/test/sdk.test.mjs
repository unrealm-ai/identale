import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { Type } from '@earendil-works/pi-ai';
import { createServer, closeServer, DEFAULT_TOKEN } from '../dist/server.js';
async function fixture(t){const requests=[];const server=createServer({observe:(request)=>requests.push(request)});server.listen({host:'127.0.0.1',port:0});await once(server,'listening');t.after(()=>closeServer(server));return{base:`http://127.0.0.1:${server.address().port}/v1`,requests};}
const model=(base,id='mock')=>({id,name:id,api:'openai-completions',provider:'dentity-registered-model',baseUrl:base,reasoning:true,compat:{supportsReasoningEffort:true},input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:4096});
const user=content=>({role:'user',content,timestamp:1});
test('locked real pi-ai decoder consumes local HTTP SSE text and usage',async t=>{
  const f=await fixture(t);const events=[];const stream=streamSimple(model(f.base),normalizeContext({messages:[user('你好')]}),{apiKey:DEFAULT_TOKEN,reasoning:'medium',maxRetries:0,maxTokens:4096});
  for await(const event of stream)events.push(event);const result=await stream.result();assert.equal(result.stopReason,'stop');assert.equal(result.content.map(c=>c.text??'').join(''),'你好。我可以帮你做什么');assert(events.some(e=>e.type==='text_delta'));assert(events.some(e=>e.type==='done'));assert(result.usage.output>0);assert.equal(f.requests.length,1);assert.equal(f.requests[0].stream,true);assert.equal(f.requests[0].includeUsage,true);
});
test('locked real pi-ai decoder reassembles task call without package IDs',async t=>{
 const f=await fixture(t),tools=[{name:'task_create',description:'task_create: platform resolves authorized business tools',parameters:Type.Object({input:Type.String()})}];
 const stream=streamSimple(model(f.base),normalizeContext({messages:[user('帮我写一个md文章')],tools}),{apiKey:DEFAULT_TOKEN,reasoning:'medium',maxRetries:0});const result=await stream.result();assert.equal(result.stopReason,'toolUse');const created=result.content.find(c=>c.type==='toolCall');assert.equal(created.name,'task_create');assert.deepEqual(created.arguments,{input:'帮我写一个md文章'});assert.equal(f.requests.length,1);
});
test('locked real pi-ai decoder treats intentionally incomplete provider stream as error',async t=>{
  const f=await fixture(t);const stream=streamSimple(model(f.base,'mock-incomplete-stream'),normalizeContext({messages:[user('你好')]}),{apiKey:DEFAULT_TOKEN,reasoning:'medium',maxRetries:0});const result=await stream.result();assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/finish_reason/);
});
