import test from'node:test';import assert from'node:assert/strict';
import{OpenAICompatibleModelClient,modelProtocolEndpoint,modelProtocolRequest}from'../dist/index.js';
const protocols=['chat_completions','openai_responses','anthropic_messages'];
const tool={name:'task_query',description:'Read an authorized task',parameters:{type:'object',properties:{taskId:{type:'string'}},required:['taskId'],additionalProperties:false}};
const call={id:'call-one',name:'task_query',arguments:{taskId:'task'}};
function response(protocol,withTool=false){
 if(protocol==='chat_completions')return{choices:[{finish_reason:withTool?'tool_calls':'stop',message:{content:withTool?'':'Final fixture reply',...(withTool?{tool_calls:[{id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]}:{})}}],usage:{prompt_tokens:7,completion_tokens:3}};
 if(protocol==='openai_responses')return{status:'completed',output:withTool?[{type:'function_call',id:'fc_one',call_id:call.id,name:call.name,arguments:JSON.stringify(call.arguments)}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Final fixture reply'}]}],usage:{input_tokens:7,output_tokens:3}};
 return{type:'message',role:'assistant',stop_reason:withTool?'tool_use':'end_turn',content:withTool?[{type:'tool_use',id:call.id,name:call.name,input:call.arguments}]:[{type:'text',text:'Final fixture reply'}],usage:{input_tokens:7,output_tokens:3}};
}
for(const protocol of protocols)test(protocol+' preserves image input, tool identity/results and final reply across a full two-request exchange',async()=>{
 const requests=[],client=new OpenAICompatibleModelClient({protocol,endpoint:'https://fixture.invalid/v1',model:'synthetic',secretRef:'profile',imageInput:true,readImage:async()=>({data:'AAAA',mediaType:'image/png'})},async()=> 'synthetic-key',async(url,init)=>{assert.equal(String(url),modelProtocolEndpoint('https://fixture.invalid/v1',protocol));assert.equal(init.redirect,'error');if(protocol==='anthropic_messages'){assert.equal(init.headers['x-api-key'],'synthetic-key');assert.equal(init.headers.authorization,undefined);}else assert.equal(init.headers.authorization,'Bearer synthetic-key');const body=JSON.parse(init.body);requests.push(body);return Response.json(response(protocol,requests.length===1));});
 const messages=[{role:'system',content:'Trusted policy'},{role:'user',content:'Inspect the shared image and query the task.',images:[{assetId:'allowed',version:'fixed'}]}],input={messages,tools:[tool],maxOutputTokens:256,signal:new AbortController().signal};
 const first=await client.complete(input);assert.deepEqual(first.toolCalls,[call]);assert.equal(first.usage.inputTokens,7);
 messages.push({role:'assistant',content:'',toolCalls:first.toolCalls},{role:'tool',toolCallId:call.id,content:'{"status":"succeeded"}'});
 const final=await client.complete(input);assert.equal(final.text,'Final fixture reply');assert.equal(final.usage.outputTokens,3);assert.equal(requests.length,2);
 if(protocol==='chat_completions'){assert.equal(requests[0].messages[1].content[1].type,'image_url');assert.equal(requests[1].messages.at(-1).tool_call_id,call.id);}
 else if(protocol==='openai_responses'){assert.equal(requests[0].input[1].content[1].type,'input_image');assert.equal(requests[1].input.at(-1).type,'function_call_output');assert.equal(requests[1].input.at(-1).call_id,call.id);}
 else{assert.equal(requests[0].system,'Trusted policy');assert.equal(requests[0].messages[0].content[1].type,'image');assert.equal(requests[1].messages.at(-1).content[0].tool_use_id,call.id);assert.equal(requests[1].messages.at(-1).content[0].type,'tool_result');}
 assert.equal(JSON.stringify(messages).includes('AAAA'),false,'Persisted model history retains references, never encoded bytes');
});
test('Anthropic batches all tool results in the next user message; historical tool declarations have no execution choice',()=>{
 const messages=[{role:'assistant',content:'',tool_calls:[{id:'one',function:{name:'task_query',arguments:'{}'}},{id:'two',function:{name:'task_query',arguments:'{}'}}]},{role:'tool',tool_call_id:'one',content:'a'},{role:'tool',tool_call_id:'two',content:'b'}];
 const body=modelProtocolRequest({model:'fixture',messages,tools:[{type:'function',function:tool}],tool_choice:'none',max_completion_tokens:256},'anthropic_messages');assert.equal(body.messages.length,2);assert.equal(body.messages[1].content.length,2);assert.deepEqual(body.tool_choice,{type:'none'});
});
for(const protocol of ['openai_responses','anthropic_messages'])test(protocol+' bounds incomplete/malformed/undeclared responses without executing tools',async()=>{
 for(const mode of ['length','bad','unknown-tool']){let calls=0;const client=new OpenAICompatibleModelClient({protocol,endpoint:'https://fixture.invalid/v1',model:'synthetic',secretRef:'profile'},async()=> 'synthetic-key',async()=>{calls++;let body=response(protocol,mode==='unknown-tool');if(mode==='length'){if(protocol==='openai_responses')body.status='incomplete';else body.stop_reason='max_tokens';}if(mode==='bad')return new Response('{invalid');if(mode==='unknown-tool'){if(protocol==='openai_responses')body.output[0].name='forbidden';else body.content[0].name='forbidden';}return Response.json(body);});await assert.rejects(client.complete({messages:[{role:'user',content:'fixture'}],tools:[tool],maxOutputTokens:128,signal:new AbortController().signal}));assert.equal(calls,protocol==='anthropic_messages'&&mode==='length'?1:3);}
});
