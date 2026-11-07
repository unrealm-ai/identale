import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, closeServer, DEFAULT_TOKEN } from '../dist/server.js';
import { createRuleEngine, validateRules } from '../dist/engine.js';
import { parseRequest } from '../dist/protocol.js';
import { ARTICLE_CONTENT } from '../dist/scenarios/default.js';
const auth = { authorization: `Bearer ${DEFAULT_TOKEN}`, 'content-type':'application/json' };
const req = (content='你好', extra={}) => ({model:'mock',messages:[{role:'user',content}],...extra});
const tool = (logical, name=logical, properties={}) => ({type:'function',function:{name,description:`${logical}: reviewed tool`,parameters:{type:'object',properties,additionalProperties:false}}});
const call = (id,name,args={}) => ({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const result = (id,content) => ({role:'tool',tool_call_id:id,content:typeof content === 'string'?content:JSON.stringify(content)});
async function fixture(t,options={}) {
  const server=createServer(options);server.listen({host:'127.0.0.1',port:0});await once(server,'listening');
  t.after(()=>closeServer(server));const base=`http://127.0.0.1:${server.address().port}`;
  return {server,base, async post(body,headers={...auth,authorization:`Bearer ${options.token??DEFAULT_TOKEN}`}){return fetch(`${base}/v1/chat/completions`,{method:'POST',headers,body:JSON.stringify(body)});}};
}
test('health/ready identify independent service; authentication and routes fail closed',async t=>{
  const f=await fixture(t);
  for(const [route,status] of [['healthz','alive'],['readyz','ready']])assert.deepEqual(await (await fetch(`${f.base}/${route}`)).json(),{status,service:'dentity-rule-model',protocolVersion:1});
  assert.equal((await f.post(req(),{'content-type':'application/json'})).status,401);
  assert.equal((await f.post(req(),{...auth,authorization:'Bearer formal-looking-key'})).status,401);
  const models=await(await fetch(`${f.base}/v1/models`,{headers:auth})).json();assert(models.data.some(m=>m.id==='mock'));
  assert.equal((await fetch(`${f.base}/v1/responses`,{method:'POST',headers:auth,body:'{}'})).status,404);
  assert.throws(()=>createServer({token:'sk-formal-key'}),/synthetic/);
});
test('real HTTP nonstream greeting and four whitelisted thinking levels have complete usage',async t=>{
  const f=await fixture(t);
  for(const effort of ['none','low','medium','high']){
    const response=await f.post(req('Reply OK.',{stream:false,reasoning_effort:effort,max_completion_tokens:64}));assert.equal(response.status,200);const body=await response.json();assert.equal(body.choices[0].message.content,'OK.');assert.equal(body.choices[0].finish_reason,'stop');assert.equal(body.usage.total_tokens,body.usage.prompt_tokens+body.usage.completion_tokens);
  }
  const body=await(await f.post(req())).json();assert.equal(body.choices[0].message.content,'你好。我可以帮你做什么');
  const array=await(await f.post(req('ignored',{messages:[{role:'user',content:[{type:'text',text:'你好'}]}]}))).json();assert.equal(array.choices[0].message.content,body.choices[0].message.content);
});
test('article directly creates a task with its single name and no package routing',async t=>{
 const f=await fixture(t),tools=[tool('task_create','task_create')],messages=req('帮我写一个md文章').messages;
 const body=await(await f.post(req('',{messages,tools}))).json(),created=body.choices[0].message.tool_calls[0];assert.equal(created.function.name,'task_create');assert.deepEqual(JSON.parse(created.function.arguments),{input:'帮我写一个md文章'});
 const accepted=await(await f.post(req('',{messages:[...messages,body.choices[0].message,result(created.id,{id:'task-this-request',status:'queued'})],tools}))).json();assert.match(accepted.choices[0].message.content,/task-this-request/);assert.match(accepted.choices[0].message.content,/尚不能/);
});
test('no business packages are required for a baseline article task',async t=>{
 const f=await fixture(t),body=await(await f.post(req('帮我写一个md文章',{tools:[tool('task_create','task_create')]}))).json();assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments),{input:'帮我写一个md文章'});
});
test('execution is a tool-result driven write/read/Bash chain, not generated completion facts',async t=>{
  const f=await fixture(t);const tools=['write','read','bash','progress_report'].map(name=>tool(name));let messages=[{role:'user',content:'帮我写一个md文章'}];
  const names=[];
  for(let i=0;i<6;i++){
    const response=await f.post(req('',{messages,tools,stream:false,reasoning_effort:'medium'}));assert.equal(response.status,200);const body=await response.json(),message=body.choices[0].message;
    const next=message.tool_calls?.[0];if(!next){assert.deepEqual(names,['progress_report','write','read','bash','progress_report']);assert.match(message.content,/真实 write/);break;}
    names.push(next.function.name);const args=JSON.parse(next.function.arguments);if(next.function.name==='write')assert.deepEqual(args,{path:'article.md',content:ARTICLE_CONTENT});
    const content=next.function.name==='read'?ARTICLE_CONTENT:next.function.name==='bash'?'dentity-article-verified\n247\n':next.function.name==='write'?'Successfully wrote to article.md':'Progress persisted.';
    messages=[...messages,message,result(next.id,content)];
  }
  assert.equal((await f.post(req('帮我写一个md文章',{tools:[tool('read')]}))).status,422);
  const failed=[{role:'user',content:'帮我写一个md文章'},call('bad','write',{path:'article.md',content:ARTICLE_CONTENT}),result('bad','Error: Permission denied')];
  const response=await f.post(req('',{messages:failed,tools}));assert.equal(response.status,422);assert.equal((await response.json()).error.code,'mock_execution_tool_failed');
});
test('SSE emits text/tool parameter deltas, finish_reason, usage and DONE',async t=>{
  const f=await fixture(t);const response=await f.post(req('帮我写一个md文章',{tools:[tool('capability.list','wire_list'),tool('task_create','task_create')],stream:true,stream_options:{include_usage:true}}));assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/event-stream/);
  const frames=(await response.text()).trim().split('\n\n').map(s=>s.slice(6));assert.equal(frames.at(-1),'[DONE]');const chunks=frames.slice(0,-1).map(JSON.parse);assert.equal(chunks[0].choices[0].delta.role,'assistant');assert(chunks.some(c=>c.choices[0]?.finish_reason==='tool_calls'));assert.deepEqual(chunks.at(-1).choices,[]);assert.equal(typeof chunks.at(-1).usage.completion_tokens,'number');
  const deltas=chunks.flatMap(c=>c.choices[0]?.delta.tool_calls??[]);assert.equal(deltas[0].function.name,'task_create');assert.deepEqual(JSON.parse(deltas.map(d=>d.function.arguments??'').join('')),{input:'帮我写一个md文章'});
});
test('execution steering preserves prior real tool receipts without restarting the article scenario',async t=>{
  const f=await fixture(t);const tools=['write','read','bash','progress_report'].map(name=>tool(name));
  const messages=[{role:'user',content:'帮我写一个md文章'},call('progress','progress_report',{text:'started'}),result('progress','Progress persisted.'),call('written','write',{path:'article.md',content:ARTICLE_CONTENT}),result('written','Successfully wrote to article.md'),{role:'user',content:'补充要求：继续核验，不能重复生成文件。'}];
  const response=await f.post(req('',{messages,tools}));assert.equal(response.status,200);const next=(await response.json()).choices[0].message.tool_calls[0];assert.equal(next.function.name,'read');
  assert.equal((await f.post(req('补充要求：继续核验，不能重复生成文件。',{tools}))).status,422,'a separate request cannot inherit another execution’s article intent');
  const interaction=[{role:'user',content:'帮我写一个md文章'},{role:'assistant',content:'受理记录'},{role:'user',content:'未命中的新请求'}];
  assert.equal((await f.post(req('',{messages:interaction,tools:[tool('capability.list'),tool('task_create')]}))).status,422);
});
test('summary phases precede greeting/keywords and produce bounded deterministic text',async t=>{
  const f=await fixture(t);const system={role:'system',content:'Produce a concise factual memory summary, not a reply or an action. Do not call tools.'};
  for(const source of [{date:'2026-10-23',records:[{id:'a',message:{role:'user',content:'你好，约束：只写测试目录'}}]},{kind:'historical_rollup',summaries:[{fromDate:'2026-10-01',throughDate:'2026-10-02',content:'事实'}]},{kind:'shorten_memory_preserving_constraints',fromDate:'2026-10-23',throughDate:'2026-10-23',summary:'合成测试摘要',maxUtf8Bytes:90}]){
    const body=req('',{messages:[system,{role:'user',content:JSON.stringify(source)}],max_completion_tokens:64});const one=await(await f.post(body)).json(),two=await(await f.post(body)).json();assert.deepEqual(one,two);const content=one.choices[0].message.content;assert(!content.includes('我可以帮你'));assert(Buffer.byteLength(content)<=256);assert(!one.choices[0].message.tool_calls);
  }
});
test('unmatched, malformed, unsupported semantics, orphan tools and forced calls are explicit failures',async t=>{
  const token='dentity-local-test-error-redaction-check',f=await fixture(t,{token});
  for(const [body,status] of [[req('没有匹配规则'),422],[req('你好',{model:'unknown'}),404],[req('你好',{tool_choice:'required'}),400],[req('你好',{tool_choice:'required',tools:[tool('read')]}),422],[req('你好',{response_format:{type:'json_object'}}),400],[req('你好',{reasoning_effort:'invalid'}),400],[req('你好',{messages:[{role:'tool',tool_call_id:'unknown',content:'fake'}]}),400],[req('你好',{tools:[{type:'web_search'}]}),400]]){const response=await f.post(body);assert.equal(response.status,status);const error=await response.json();assert(error.error.code);assert(!JSON.stringify(error).includes(token));}
  assert.equal((await f.post(req(),{...auth,authorization:`Bearer ${token}`,'content-type':'application/jsonp'})).status,415);
});
test('task query reports authoritative failed status and ID without confusing it with a failed tool',async t=>{
  const f=await fixture(t);const tools=[tool('task_query','task_query')];const messages=[{role:'user',content:'查询任务'},call('query-current','task_query',{taskId:'failed-task-id'}),result('query-current',{id:'failed-task-id',status:'failed'})];
  const response=await f.post(req('',{messages,tools}));assert.equal(response.status,200);const text=(await response.json()).choices[0].message.content;assert.match(text,/failed-task-id/);assert.match(text,/failed/);assert(!text.includes('平台工具没有成功'));
  const completed=[{role:'user',content:'查询任务'},call('query-done','task_query',{taskId:'done-task-id'}),result('query-done',{id:'done-task-id',status:'succeeded',run:{result:'article.md 已通过实际工具核验'}})];
  const done=await f.post(req('',{messages:completed,tools}));assert.equal(done.status,200);const answer=(await done.json()).choices[0].message.content;assert.match(answer,/done-task-id/);assert.match(answer,/succeeded/);assert.match(answer,/article\.md/);
});
test('concurrent sessions remain stateless and bind only their own receipt IDs',async t=>{
  const f=await fixture(t);const tools=[tool('task_create','task_create')];
  const outputs=await Promise.all(Array.from({length:8},async(_,i)=>{
    const messages=[{role:'user',content:'帮我写一个md文章'},call(`call-${i}`,'task_create',{input:'帮我写一个md文章'}),result(`call-${i}`,{id:`task-${i}`,status:'queued'})];return(await(await f.post(req('',{messages,tools}))).json()).choices[0].message.content;
  }));for(const [i,output]of outputs.entries()){assert.match(output,new RegExp(`task-${i}`));assert(!output.includes(`task-${(i+1)%8}`));}
  assert.equal((await f.post(req('你好'))).status,200);
});
test('body/concurrency limits and aborted streams release service capacity',async t=>{
  const f=await fixture(t,{maxBodyBytes:512,maxConcurrent:1});assert.equal((await f.post(req('x'.repeat(600)))).status,413);
  const oversized=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify(req('x'.repeat(600)))));controller.close();}});
  assert.equal((await fetch(`${f.base}/v1/chat/completions`,{method:'POST',headers:auth,body:oversized,duplex:'half'})).status,413);
  const pending=f.post(req('你好',{model:'mock-delay'}));await new Promise(resolve=>setTimeout(resolve,30));assert.equal((await f.post(req())).status,429);assert.equal((await pending).status,200);assert.equal((await f.post(req())).status,200);
  const controller=new AbortController();const streamed=await fetch(`${f.base}/v1/chat/completions`,{method:'POST',headers:auth,body:JSON.stringify(req('你好',{stream:true})),signal:controller.signal});assert.equal(streamed.status,200);controller.abort();await new Promise(resolve=>setTimeout(resolve,30));assert.equal((await f.post(req())).status,200);
});
test('wire framing overhead counts toward the bounded response, before sending SSE headers',async t=>{
  const f=await fixture(t,{rules:[{id:'large.response',priority:1,phase:'interaction',exact:'large',output:{text:'x'.repeat(60000)}}]});
  assert.equal((await f.post(req('large',{max_completion_tokens:20000}))).status,200);
  const response=await f.post(req('large',{max_completion_tokens:20000,stream:true}));assert.equal(response.status,422);assert.equal((await response.json()).error.code,'mock_output_limit_exceeded');
});
test('explicit error and incomplete-stream model faults never produce successful finish markers',async t=>{
  const f=await fixture(t);assert.equal((await f.post(req('你好',{model:'mock-error'}))).status,503);
  const response=await f.post(req('你好',{model:'mock-incomplete-stream',stream:true,stream_options:{include_usage:true}}));const text=await response.text();assert(!text.includes('[DONE]'));assert(!text.includes('"finish_reason":"stop"'));
});
test('rules have stable priorities, exact/keyword/required/forbidden matching and invalid configurations reject startup',()=>{
  const rules=[{id:'keyword.rule',priority:1,phase:'interaction',keywords:['hello'],output:{text:'keyword'}},{id:'exact.rule',priority:2,phase:'interaction',exact:'hello',forbiddenTools:['blocked'],output:{text:'exact'}}];
  const engine=createRuleEngine(rules);assert.equal(engine(parseRequest(req('hello'))).text,'exact');assert.equal(engine(parseRequest(req('hello',{tools:[tool('blocked')]}))).text,'keyword');assert.throws(()=>validateRules([...rules,rules[0]]),/configuration/);
});

test('synthetic request observer captures only validated thinking values and preserves absent versus false',async t=>{
 const token='dentity-local-test-observer-redaction-check',observed=[],f=await fixture(t,{token,observe:request=>observed.push(request)});
 assert.equal((await f.post(req('Reply OK.',{reasoning_effort:'none',enable_thinking:false}))).status,200);
 assert.equal((await f.post(req('Reply OK.'))).status,200);
 assert.equal(observed[0].reasoningEffort,'none');assert.equal(observed[0].enableThinking,false);assert.equal('enableThinking' in observed[1],false);assert.equal('reasoningEffort' in observed[1],false);
 for(const patch of [{reasoning_effort:'off'},{reasoning_effort:['none']},{enable_thinking:true},{enable_thinking:0}])assert.equal((await f.post(req('Reply OK.',patch))).status,400);
 assert.equal(observed.length,2);assert.equal(JSON.stringify(observed).includes(token),false);
});

test('mock default accepts legacy aliases but an explicit custom token never accepts either default',async t=>{
 const f=await fixture(t);assert.equal(DEFAULT_TOKEN,'identity-local-test-token');const rejected=await f.post(req(),{...auth,authorization:'Bearer mock'});assert.equal(rejected.status,401);assert.equal((await rejected.json()).error.code,'mock_authentication_failed');assert.throws(()=>createServer({token:'mock'}),/synthetic local test token/);
 const legacy=await f.post(req('你好',{model:'dentity-local-rules'}),{...auth,authorization:'Bearer dentity-local-test-token'});assert.equal(legacy.status,200);assert.equal((await legacy.json()).model,'dentity-local-rules');
 const server=createServer({token:'dentity-local-test-custom'});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>closeServer(server));const base=`http://127.0.0.1:${server.address().port}`;
 for(const token of [DEFAULT_TOKEN,'dentity-local-test-token','mock'])assert.equal((await fetch(base+'/v1/chat/completions',{method:'POST',headers:{...auth,authorization:'Bearer '+token},body:JSON.stringify(req())})).status,401);
 assert.equal((await fetch(base+'/v1/chat/completions',{method:'POST',headers:{...auth,authorization:'Bearer dentity-local-test-custom'},body:JSON.stringify(req())})).status,200);
});
test('workspace MCP names resolve only already-exposed local fixture tools and preserve missing-resource denial',async t=>{const f=await fixture(t),name='mcp__ws_mcp_0123456789abcdef0123456789abcdef__lookup',mcp=tool(name);mcp.function.description='Local synthetic alpha business lookup';const tools=[tool('read'),mcp],messages=[{role:'user',content:'帮我写一个md文章，体验MCP甲'}];const response=await f.post(req('',{messages,tools}));assert.equal(response.status,200);const message=(await response.json()).choices[0].message;assert.equal(message.tool_calls[0].function.name,name);const done=await f.post(req('',{messages:[...messages,message,result(message.tool_calls[0].id,'LOCAL_MOCK_MCP_ALPHA_OK')],tools}));assert.match((await done.json()).choices[0].message.content,/LOCAL_MOCK_MCP_ALPHA_OK/);const denied=await f.post(req('帮我写一个md文章，体验MCP乙',{tools}));const no=(await denied.json()).choices[0].message;assert.equal(no.tool_calls,undefined);assert.match(no.content,/未装配/);const forged=tool('mcp__unregistered__lookup');forged.function.description=mcp.function.description;const invalid=await f.post(req('帮我写一个md文章，体验MCP甲',{tools:[tool('read'),forged]}));assert.match((await invalid.json()).choices[0].message.content,/未装配/);});
