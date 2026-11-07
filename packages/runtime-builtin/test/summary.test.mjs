import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHistory, renderSummary, validateMaintenancePolicy } from '../dist/summary.js';
const policy={retainMessages:20,recentDays:30,maxSummaryTokens:4000,maxDailySummaryTokens:800,contextTokenThreshold:12000,timezone:'UTC'};
const concise='约束：不得外发客户资料；决定：先测试；待办：确认发布审批。';
const previous=Array.from({length:31},(_,i)=>{const date=`2026-01-${String(i+1).padStart(2,'0')}`;return {kind:'daily',date,fromDate:date,throughDate:date,content:('当天讨论了方案调整和多个需要后续确认的细节。').repeat(8)+'约束不得外发客户资料，发布必须审批。',sourceCheckpoint:'a'.repeat(64),sourceRecordCount:20};});
test('default budget keeps thirty daily rows plus older rollup with bounded metadata and compact prompt rendering',async()=>{
 let calls=0;const result=await summarizeHistory({model:{async complete(input){calls++;assert.deepEqual(input.tools,[]);assert.match(input.messages[0].content,/untrusted/);return {text:concise,finishReason:'stop',usage:{inputTokens:100,outputTokens:20}};}},policy,previous,sourceCheckpoint:'b'.repeat(64),records:[{message:{role:'user',content:'继续遵守保密和发布审批要求'},at:Date.parse('2026-02-01T10:00:00Z'),id:'raw-record'}],now:Date.parse('2026-02-01T12:00:00Z'),signal:new AbortController().signal});
 assert.equal(result.filter(r=>r.kind==='daily').length,30);assert.equal(result.filter(r=>r.kind==='rollup').length,1);assert.ok(Buffer.byteLength(renderSummary(result))<=4000);assert.ok(calls>=31);assert.equal(renderSummary(result).includes('sourceCheckpoint'),false);assert.ok(result.every(r=>r.sourceCheckpoint.length===64));assert.equal(result.some(r=>'sourceIds' in r),false);assert.ok(result.every(r=>r.content.includes('不得外发')));
});
test('impossible summary budget fails explicitly rather than dropping daily rows or originals',async()=>{
 await assert.rejects(summarizeHistory({model:{async complete(){return {text:concise,finishReason:'stop',usage:{inputTokens:20,outputTokens:20}};}},policy:{...policy,maxSummaryTokens:800},previous,sourceCheckpoint:'b'.repeat(64),records:[],now:Date.parse('2026-01-31T12:00:00Z'),signal:new AbortController().signal}),/budget/);
 assert.throws(()=>validateMaintenancePolicy({...policy,timezone:'not-a-timezone'}));assert.throws(()=>validateMaintenancePolicy({...policy,retainMessages:501}));
});

test('daily, rollup and shortening use actual HTTP with fixed none dual parameters and no tools',async t=>{
 const {createServer}=await import('node:http');const {OpenAICompatibleModelClient}=await import('../dist/provider.js');
 const requests=[],server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:concise}}],usage:{prompt_tokens:100,completion_tokens:20}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const origin=`http://127.0.0.1:${server.address().port}`,model=new OpenAICompatibleModelClient({endpoint:origin+'/v1',model:'synthetic-summary',secretRef:'synthetic-ref',allowLoopbackHttp:true},async()=> 'synthetic-summary-token');
 await summarizeHistory({model,policy,previous,sourceCheckpoint:'b'.repeat(64),records:[{message:{role:'user',content:'保留决定'},at:Date.parse('2026-02-01T10:00:00Z'),id:'record'}],now:Date.parse('2026-02-01T12:00:00Z'),signal:new AbortController().signal});
 const kinds=requests.map(body=>JSON.parse(body.messages[1].content).kind??'daily');assert.ok(kinds.includes('daily'));assert.ok(kinds.includes('historical_rollup'));assert.ok(kinds.includes('shorten_memory_preserving_constraints'));
 for(const body of requests){assert.equal(body.reasoning_effort,'none');assert.equal(body.enable_thinking,false);assert.equal('tools' in body,false);assert.equal('executionThinkingLevel' in body,false);}
});

test('candidate preserves exact consumed daily rows and never archives the previous rollup as a daily row',async()=>{
 const {summarizeHistoryCandidate}=await import('../dist/summary.js');
 const old=structuredClone(previous[0]),old2=structuredClone(previous[1]);
 const result=await summarizeHistoryCandidate({model:{async complete(input){const data=JSON.parse(input.messages[1].content);return {text:data.kind==='historical_rollup'?'Combined historical facts.':'New daily facts.',finishReason:'stop',usage:{inputTokens:20,outputTokens:5}};}},policy,previous:[old,old2],sourceCheckpoint:'b'.repeat(64),records:[],now:Date.parse('2026-02-01T12:00:00Z'),signal:new AbortController().signal});
 assert.deepEqual(result.archivedDaily,[old,old2]);assert.equal(result.entries.length,1);assert.equal(result.entries[0].kind,'rollup');
 assert.equal(renderSummary(result.entries).includes(old.content),false);
 const next=await summarizeHistoryCandidate({model:{async complete(){throw Error('no rollup model needed');}},policy,previous:result.entries,sourceCheckpoint:'c'.repeat(64),records:[],now:Date.parse('2026-02-02T12:00:00Z'),signal:new AbortController().signal});
 assert.deepEqual(next.archivedDaily,[]);assert.deepEqual(next.entries,result.entries.map(entry=>({...entry,sourceCheckpoint:'c'.repeat(64)})));
});
