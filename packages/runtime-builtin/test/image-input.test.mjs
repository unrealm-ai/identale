import test from'node:test';import assert from'node:assert/strict';
import {OpenAICompatibleModelClient}from'../dist/index.js';
const config={endpoint:'https://model.invalid/v1',model:'synthetic',secretRef:'profile'};
const ref={assetId:'approved',version:'fixed'};
const input=()=>({messages:[{role:'user',content:'Describe the attachment',images:[ref]}],tools:[],maxOutputTokens:128,signal:new AbortController().signal});
const ok=()=>Response.json({choices:[{finish_reason:'stop',message:{content:'synthetic response'}}],usage:{prompt_tokens:1,completion_tokens:1}});
test('text-only and unknown model paths retain text but never read or serialize image bytes',async()=>{
 let reads=0;const c=new OpenAICompatibleModelClient({...config,readImage:async()=>{reads++;throw Error('must not read');}},async()=> 'synthetic-key',async(_url,init)=>{assert.deepEqual(JSON.parse(init.body).messages,[{role:'user',content:'Describe the attachment'}]);return ok();});await c.complete(input());assert.equal(reads,0);
});
test('vision path resolves versioned references per request and emits native Chat Completions image blocks',async()=>{
 let reads=0;const c=new OpenAICompatibleModelClient({...config,imageInput:true,readImage:async(value)=>{assert.deepEqual(value,ref);reads++;return{data:'synthetic-base64',mediaType:'image/png'};}},async()=> 'synthetic-key',async(_url,init)=>{const body=JSON.parse(init.body);assert.equal(body.messages[0].content[1].image_url.url,'data:image/png;base64,synthetic-base64');return ok();});const value=input();await c.complete(value);assert.equal(reads,1);assert.equal(JSON.stringify(value).includes('synthetic-base64'),false);
});
test('unauthorized or unavailable image is not silently omitted then reported as successful vision',async()=>{
 let requests=0;const c=new OpenAICompatibleModelClient({...config,imageInput:true,readImage:async()=>{throw Error('not authorized');}},async()=> 'synthetic-key',async()=>{requests++;return ok();});await assert.rejects(c.complete(input()));assert.equal(requests,0);
});
