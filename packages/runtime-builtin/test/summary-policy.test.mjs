import test from 'node:test';
import assert from 'node:assert/strict';
import {DiagnosticError} from '@dentity/application';
import {summarizeHistory,renderSummary} from '../dist/summary.js';
import {OpenAICompatibleModelClient} from '../dist/provider.js';

const policy={retainMessages:20,recentDays:30,maxSummaryTokens:8192,maxDailySummaryTokens:2048,contextTokenThreshold:12000,timezone:'UTC'};
const day=Date.parse('2026-11-04T00:00:00Z');
const record=(date=day)=>({message:{role:'user',content:'Synthetic facts: preserve explicit approval and unresolved work.'},at:date,id:'source-'+date});
const complete=(text='Approval is still required; work is not completed.',finishReason='stop')=>({text,finishReason,usage:{inputTokens:100,outputTokens:20}});
const request=(model,overrides={})=>({model,policy,previous:[],sourceCheckpoint:'a'.repeat(64),records:[record()],now:day,signal:new AbortController().signal,...overrides});
const target=input=>Number(/at most (\d+) Unicode characters/.exec(input.messages[0].content)[1]);

test('summary prompt targets twelve hundred characters with generation headroom and no tools',async()=>{
 let observed;const result=await summarizeHistory(request({async complete(input){observed=input;return complete();}}));
 assert.equal(target(observed),1200);assert.equal(observed.maxOutputTokens,2048);assert.deepEqual(observed.tools,[]);
 assert.match(observed.messages[0].content,/8192 UTF-8 bytes/);assert.match(observed.messages[0].content,/untrusted/);
 assert.equal(result.length,1);assert.ok(Buffer.byteLength(renderSummary(result))<=8192);
});

test('three progressively stronger retries use original evidence, one signal and no partial candidate',async()=>{
 const inputs=[],control=new AbortController();
 const result=await summarizeHistory(request({async complete(input){inputs.push(input);return inputs.length<4?complete('cut fragment','length'):complete();}},{signal:control.signal}));
 assert.equal(inputs.length,4);assert.deepEqual(inputs.map(target),[1200,800,500,300]);
 assert.equal(new Set(inputs.map(i=>i.messages[1].content)).size,1);assert.ok(inputs.every(i=>i.signal===control.signal&&i.maxOutputTokens===2048));
 assert.equal(result[0].content.includes('cut fragment'),false);
});

test('oversized UTF-8 results get at most three additional compression attempts',async()=>{
 let calls=0;await assert.rejects(summarizeHistory(request({async complete(){calls++;return complete('字'.repeat(3000));}})),/result budget/);assert.equal(calls,4);
 calls=0;const result=await summarizeHistory(request({async complete(){return ++calls<4?complete('字'.repeat(3000)):complete();}}));assert.equal(calls,4);assert.ok(Buffer.byteLength(renderSummary(result))<=8192);
});

test('retry credits are shared by all daily rows in a single summary job',async()=>{
 const calls=[];await assert.rejects(summarizeHistory(request({async complete(input){const date=JSON.parse(input.messages[1].content).date;calls.push(date);return calls.length===4?complete():complete('partial','length');}},{records:[record(day),record(day+86400000)],now:day+86400000})),/Truncated/);
 assert.equal(calls.length,5);assert.equal(calls.filter(d=>d==='2026-11-04').length,4);assert.equal(calls.filter(d=>d==='2026-11-05').length,1);
});

test('non-length protocol errors, network failures, invalid output and tool calls are not semantic retries',async()=>{
 for(const answer of [new DiagnosticError({category:'parse',modelResponseIssue:'payload_json'}),new DiagnosticError({category:'network'}),complete('','stop'),{...complete(),toolCalls:[{id:'never',name:'task_create',arguments:{}}]}]){
  let calls=0;await assert.rejects(summarizeHistory(request({async complete(){calls++;if(answer instanceof Error)throw answer;return answer;}})));assert.equal(calls,1);
 }
});

test('abort during a truncated response prevents all further semantic calls',async()=>{
 const controller=new AbortController();let calls=0;await assert.rejects(summarizeHistory(request({async complete(){calls++;controller.abort();return complete('partial','length');}},{signal:controller.signal})));assert.equal(calls,1);
});

test('exhaustion leaves caller-owned old summary and records unchanged',async()=>{
 const previous=[{kind:'daily',date:'2026-11-03',fromDate:'2026-11-03',throughDate:'2026-11-03',content:'Old approved memory.',sourceCheckpoint:'b'.repeat(64),sourceRecordCount:1}],records=[record()],before=structuredClone({previous,records});
 let calls=0;await assert.rejects(summarizeHistory(request({async complete(){calls++;return complete('partial','length');}},{previous,records})));assert.equal(calls,4);assert.deepEqual({previous,records},before);
});

test('per-row shortening retries stay inside total result bytes without reducing generation budget to word target',async()=>{
 const previous=Array.from({length:3},(_,i)=>({kind:'daily',date:`2026-11-0${i+1}`,fromDate:`2026-11-0${i+1}`,throughDate:`2026-11-0${i+1}`,content:'x'.repeat(400),sourceCheckpoint:'b'.repeat(64),sourceRecordCount:1}));
 const inputs=[];const result=await summarizeHistory(request({async complete(input){inputs.push(input);return complete(inputs.length===1?'x'.repeat(300):'Preserve approval.');}},{previous,records:[],policy:{...policy,maxSummaryTokens:900,maxDailySummaryTokens:800}}));
 assert.equal(inputs.length,4);assert.ok(inputs[0].maxOutputTokens>target(inputs[0]));assert.ok(Buffer.byteLength(renderSummary(result))<=900);
});

function wire(protocol,text,truncated=false){
 if(protocol==='chat_completions')return{choices:[{finish_reason:truncated?'length':'stop',message:{content:text}}],usage:{prompt_tokens:100,completion_tokens:20}};
 if(protocol==='openai_responses')return{status:truncated?'incomplete':'completed',...(truncated?{incomplete_details:{reason:'max_output_tokens'}}:{}),output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:100,output_tokens:20}};
 return{type:'message',role:'assistant',stop_reason:truncated?'max_tokens':'end_turn',content:[{type:'text',text}],usage:{input_tokens:100,output_tokens:20}};
}
for(const protocol of ['chat_completions','openai_responses','anthropic_messages']){
 test(protocol+' sends the enlarged API budget and retries normalized length errors only',async()=>{
  const inputs=[],client=new OpenAICompatibleModelClient({protocol,endpoint:'https://fixture.invalid/v1',model:'synthetic-summary',secretRef:'synthetic-reference'},async()=> 'synthetic-key',async(_url,init)=>{inputs.push(JSON.parse(init.body));return Response.json(wire(protocol,inputs.length<4?'partial':'Complete facts.',inputs.length<4));});
  const result=await summarizeHistory(request(client));assert.equal(inputs.length,4);assert.equal(result[0].content,'Complete facts.');
  const field=protocol==='chat_completions'?'max_completion_tokens':protocol==='openai_responses'?'max_output_tokens':'max_tokens';assert.ok(inputs.every(i=>i[field]===2048&&!i.tools));
 });
 test(protocol+' does not add semantic retries to an HTTP 400 failure',async()=>{
  let calls=0;const client=new OpenAICompatibleModelClient({protocol,endpoint:'https://fixture.invalid/v1',model:'synthetic-summary',secretRef:'synthetic-reference'},async()=> 'synthetic-key',async()=>{calls++;return Response.json({error:{code:'fixture-rejected'}},{status:400});});
  await assert.rejects(summarizeHistory(request(client)));assert.equal(calls,1);
 });
}

test('Responses filter or unknown incomplete reason does not retry locally or trigger semantic compression',async()=>{
 for(const reason of ['content_filter',undefined]){let calls=0;const client=new OpenAICompatibleModelClient({protocol:'openai_responses',endpoint:'https://fixture.invalid/v1',model:'synthetic-summary',secretRef:'synthetic-reference'},async()=> 'synthetic-key',async()=>{calls++;return Response.json({...wire('openai_responses','partial',true),incomplete_details:reason?{reason}:undefined});});
  await assert.rejects(summarizeHistory(request(client)));assert.equal(calls,1);
 }
});

test('transport retries are bounded separately and do not restart semantic compression after HTTP exhaustion',async()=>{
 let calls=0;const client=new OpenAICompatibleModelClient({endpoint:'https://fixture.invalid/v1',model:'synthetic-summary',secretRef:'synthetic-reference'},async()=> 'synthetic-key',async()=>{calls++;return Response.json({error:{code:'fixture-transient'}},{status:503});});
 await assert.rejects(summarizeHistory(request(client)));assert.equal(calls,3);
});

test('one daily request with three compression retries cannot exceed twelve HTTP attempts',async()=>{
 const bodies=[];const client=new OpenAICompatibleModelClient({endpoint:'https://fixture.invalid/v1',model:'synthetic-summary',secretRef:'synthetic-reference'},async()=> 'synthetic-key',async(_url,init)=>{bodies.push(JSON.parse(init.body));return bodies.length%3?Response.json({error:{code:'fixture-transient'}},{status:503}):Response.json(wire('chat_completions','partial',true));});
 await assert.rejects(summarizeHistory(request(client)));assert.equal(bodies.length,12);assert.equal(new Set(bodies.map(b=>b.messages[0].content)).size,4);
 for(let i=0;i<4;i++)assert.deepEqual(bodies.slice(i*3,i*3+3),[bodies[i*3],bodies[i*3],bodies[i*3]]);
});
