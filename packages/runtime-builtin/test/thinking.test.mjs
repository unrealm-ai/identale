import test from 'node:test';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {OpenAICompatibleModelClient} from '../dist/index.js';
const config={endpoint:'https://synthetic.invalid/v1',model:'arbitrary-model-name',secretRef:'synthetic-ref'};
const input={messages:[{role:'user',content:'hello'}],tools:[],maxOutputTokens:20,signal:new AbortController().signal};
test('builtin defaults to both none wire parameters without model-name or user policy choices',async()=>{
 for(const model of ['arbitrary-model-name','gpt-5.1','qwen-plus']){
  let body;
  const client=new OpenAICompatibleModelClient({...config,model},async()=> 'synthetic-test-key',async(url,init)=>{
   assert.equal(init.redirect,'error');body=JSON.parse(init.body);
   return Response.json({choices:[{finish_reason:'stop',message:{content:'hello'}}],usage:{prompt_tokens:1,completion_tokens:1}});
  });
  await client.complete(input);assert.equal(body.reasoning_effort,'none');assert.equal(body.enable_thinking,false);
  assert.equal('extra_body' in body,false);assert.equal('thinking' in body,false);assert.deepEqual(body.messages,input.messages);
 }
});
test('builtin rejects non-none or malformed unified levels before network',()=>{
 for(const thinkingLevel of ['low','medium','high','off',true,null,{}])assert.throws(()=>new OpenAICompatibleModelClient({...config,thinkingLevel},async()=>''),/unsupported_thinking_level/);
});

test('builtin accepts HTTPS domains and ports without allowlist and keeps loopback HTTP opt-in',()=>{
 let credentials=0,requests=0;const options={...config,endpoint:'http://127.0.0.1:18302/v1'};
 const resolve=async()=>{credentials++;return 'synthetic-key';},transport=async()=>{requests++;throw Error('No network expected');};
 for(const endpoint of ['https://custom-provider.example/v1','https://another-provider.example:8443/custom/v1'])assert.doesNotThrow(()=>new OpenAICompatibleModelClient({...config,endpoint},resolve,transport));
 for(const endpoint of ['http://localhost:18302/v1','http://[::1]:18302/v1','http://127.0.0.1:18303/v1']){
  assert.throws(()=>new OpenAICompatibleModelClient({...options,endpoint},resolve,transport),/HTTPS or explicitly enabled loopback/);
  assert.doesNotThrow(()=>new OpenAICompatibleModelClient({...options,endpoint,allowLoopbackHttp:true},resolve,transport));
 }
 for(const endpoint of ['http://not-loopback.invalid/v1','http://192.168.1.2/v1','file:///etc/passwd','https://user:pass@provider.example/v1','https://provider.example/v1?key=hidden','https://provider.example/v1#key'])assert.throws(()=>new OpenAICompatibleModelClient({...options,endpoint,allowLoopbackHttp:true},resolve,transport));
 assert.equal(credentials,0);assert.equal(requests,0);
});

test('enabled loopback builtin uses actual HTTP without allowlist and refuses provider redirects',async t=>{
 const requests=[];let redirected=0;
 const server=createServer(async(req,res)=>{if(req.url==='/redirect-target'){redirected++;res.end('{}');return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));requests.push({url:req.url,authorization:req.headers.authorization,body});
  if(body.model==='reject-flags'){res.writeHead(400);res.end('synthetic-local-only-token');return;}
  if(body.model==='redirect'){res.writeHead(307,{location:'/redirect-target'});res.end();return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Synthetic local reply'}}],usage:{prompt_tokens:2,completion_tokens:3}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const origin=`http://127.0.0.1:${server.address().port}`,settings={...config,endpoint:origin+'/v1',allowLoopbackHttp:true};
 const client=new OpenAICompatibleModelClient(settings,async(ref,endpoint)=>{assert.equal(ref,config.secretRef);assert.equal(endpoint,origin+'/v1');return 'synthetic-local-only-token';});
 const result=await client.complete(input);assert.equal(result.text,'Synthetic local reply');assert.deepEqual(result.usage,{inputTokens:2,outputTokens:3});assert.equal(requests[0].url,'/v1/chat/completions');assert.equal(requests[0].body.reasoning_effort,'none');assert.equal(requests[0].body.enable_thinking,false);assert.equal(requests[0].body.stream,false);assert.equal(requests[0].authorization,'Bearer synthetic-local-only-token');
 const before=requests.length;const incompatible=new OpenAICompatibleModelClient({...settings,model:'reject-flags'},async()=> 'synthetic-local-only-token');await assert.rejects(incompatible.complete(input),/model_parameters_incompatible/);assert.equal(requests.length,before+1,'Rejected dual flags must not cause stripped retry');
 const redirect=new OpenAICompatibleModelClient({...settings,model:'redirect'},async()=> 'synthetic-local-only-token');await assert.rejects(redirect.complete(input));assert.equal(redirected,0);
});
