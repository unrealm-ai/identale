import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer,closeServer,DEFAULT_TOKEN} from '../dist/server.js';
import {createRuleEngine,contextFor} from '../dist/engine.js';
import {parseRequest} from '../dist/protocol.js';

const label=(actor='ou_fixture')=>`[说话人=${actor}][身份=open_id:${actor}]`;
const tool=logical=>({type:'function',function:{name:logical,description:`${logical}: fixture tool`,parameters:{type:'object',properties:{}}}});
const request=(content,extra={})=>({model:'mock',messages:[{role:'user',content}],...extra});
async function fixture(t){
  const observed=[],server=createServer({observe:r=>observed.push(r)});
  server.listen({host:'127.0.0.1',port:0});await once(server,'listening');
  t.after(()=>closeServer(server));
  return{observed,async post(body){return fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${DEFAULT_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(body)});}};
}

test('channel greeting matches through real HTTP while the original message retains speaker identity',async t=>{
  const f=await fixture(t);
  for(const prefix of ['',label(),label('Alice'),`[说话人=张三]`,`[说话人=张三][部门=研发部]`,`[说话人=张三][成员=成员1][部门=研发部][职位=后端工程师]`,`[说话人=张三][身份=user_id:fixture]`,`[说话人=][身份=open_id:ou_fixture]`,label()+label()]){
    const content=` ${prefix}你好 \n`,response=await f.post(request(content));
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.choices[0].message.content,'你好。我可以帮你做什么');
    assert.equal(f.observed.at(-1).messages[0].content,content);
  }
  const response=await f.post(request(label()+'你好',{stream:true,stream_options:{include_usage:true}}));
  assert.equal(response.status,200);const frames=await response.text();
  assert.match(frames,/"finish_reason":"stop"/);assert.match(frames,/data: \[DONE\]/);
});

test('tagged article and query match body only and preserve tool-result continuation',async t=>{
  const f=await fixture(t),tools=[tool('task_create'),tool('task_query')];
  for(const input of ['帮我写一个md文章','请帮我写一篇Markdown文章']){
    const messages=[{role:'user',content:label()+input}];
    const response=await f.post(request('',{messages,tools}));assert.equal(response.status,200);
    const assistant=(await response.json()).choices[0].message,call=assistant.tool_calls[0];
    assert.equal(call.function.name,'task_create');assert.deepEqual(JSON.parse(call.function.arguments),{input});
    const history=[...messages,assistant,{role:'tool',tool_call_id:call.id,content:JSON.stringify({id:'fixture-task',status:'queued'})}];
    const accepted=await f.post(request('',{messages:history,tools}));assert.equal(accepted.status,200);
    assert.match((await accepted.json()).choices[0].message.content,/fixture-task/);
    const query=await f.post(request('',{messages:[...history,{role:'user',content:label('Bob')+'查询任务'}],tools}));
    assert.equal(query.status,200);const next=(await query.json()).choices[0].message.tool_calls[0];
    assert.equal(next.function.name,'task_query');assert.deepEqual(JSON.parse(next.function.arguments),{taskId:'fixture-task'});
    const greeting=await f.post(request('',{messages:[...history,{role:'user',content:label('Bob')+'你好'}],tools}));
    assert.equal(greeting.status,200);assert.equal((await greeting.json()).choices[0].message.content,'你好。我可以帮你做什么');
  }
});

test('bounded leading metadata labels are removed without erasing unknown or malformed body text',async t=>{
  const f=await fixture(t);
  for(const content of [label()+'没有匹配规则',`[说话人=${'a'.repeat(161)}][身份=open_id:ou_fixture]你好`,'[说话人=A\nB][身份=open_id:ou_fixture]你好',label()+'Reply OK.','[普通正文]你好','你好[说话人=张三]', '[部门=研发部]'.repeat(17)+'你好']){
    const response=await f.post(request(content));assert.equal(response.status,422);
    assert.equal((await response.json()).error.code,'mock_rule_not_matched');
  }
  const response=await f.post(request(label()+'你好',{model:'mock-error'}));
  assert.equal(response.status,503);assert.equal((await response.json()).error.code,'mock_injected_provider_error');
  const namedLikeCommand=await f.post(request(label('查询任务')+'没有匹配规则',{tools:[tool('task_query')]}));
  assert.equal(namedLikeCommand.status,422);assert.equal((await namedLikeCommand.json()).error.code,'mock_rule_not_matched');
});

test('multiple semantic labels cannot trigger rules from name, department or job title',async t=>{
 const f=await fixture(t),tools=[tool('task_create'),tool('task_query')];
 const prefix='[说话人=查询任务][部门=写文章部门][职位=帮我写一个md文章]';
 const response=await f.post(request(prefix+'你好',{tools}));assert.equal(response.status,200);
 const greeting=(await response.json()).choices[0].message;assert.equal(greeting.content,'你好。我可以帮你做什么');assert.equal(greeting.tool_calls,undefined);
 const article=await f.post(request(prefix+'帮我写一个md文章',{tools}));assert.equal(article.status,200);
 assert.deepEqual(JSON.parse((await article.json()).choices[0].message.tool_calls[0].function.arguments),{input:'帮我写一个md文章'});
});

test('summary, execution and probe contexts retain phase-specific inputs',()=>{
  const content=label()+'你好';
  const execution=contextFor(parseRequest(request(content,{tools:[tool('read')]})));
  assert.equal(execution.phase,'execution');assert.equal(execution.input,content);
  const summary=contextFor(parseRequest(request('',{messages:[{role:'system',content:'Produce a concise factual memory summary, not a reply or an action.'},{role:'user',content}]})));
  assert.equal(summary.phase,'summary');assert.equal(summary.input,content);
  const probe=contextFor(parseRequest(request('Reply OK.')));
  assert.equal(probe.phase,'probe');assert.equal(probe.input,'Reply OK.');
});

test('interleaved actors and a new engine instance keep independent task receipts',async t=>{
  const f=await fixture(t),tools=[tool('task_create')];
  const outputs=await Promise.all(Array.from({length:8},async(_,i)=>{
    const content=label(`ou_fixture_${i}`)+'帮我写一个md文章';
    const first=await f.post(request(content,{tools}));assert.equal(first.status,200);
    const assistant=(await first.json()).choices[0].message,call=assistant.tool_calls[0];
    const next=await f.post(request('',{tools,messages:[{role:'user',content},assistant,{role:'tool',tool_call_id:call.id,content:JSON.stringify({id:`fixture-task-${i}`,status:'queued'})}]}));
    assert.equal(next.status,200);return(await next.json()).choices[0].message.content;
  }));
  for(const [i,text] of outputs.entries()){
    assert.match(text,new RegExp(`fixture-task-${i}`));assert.doesNotMatch(text,new RegExp(`fixture-task-${(i+1)%8}`));
  }
  const parsed=parseRequest(request(label()+'你好'));
  assert.deepEqual(createRuleEngine()(parsed),createRuleEngine()(parsed));
});
