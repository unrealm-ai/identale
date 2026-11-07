import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync}from'node:zlib';
import {probeImageInput}from'../dist/model-image-probe.js';
const input={endpoint:'https://synthetic.invalid/v1',modelId:'test',apiKey:'synthetic-only'};
for(const protocol of ['chat_completions','openai_responses','anthropic_messages'])test(`${protocol} image probe uses a 40 second deadline and timeout remains unknown`,async t=>{
 let requestedTimeout,calls=0;
 t.mock.method(AbortSignal,'timeout',ms=>{requestedTimeout=ms;return AbortSignal.abort(new DOMException('Synthetic timeout','TimeoutError'));});
 const result=await probeImageInput({...input,protocol,fetch:async(_url,init)=>{calls++;assert.equal(init.signal.aborted,true);throw init.signal.reason;}});
 assert.equal(requestedTimeout,40000);assert.equal(calls,1);assert.equal(result,'unknown');
});
function correctAnswer(payload){const png=Buffer.from(payload.messages[0].content[1].image_url.url.split(',')[1],'base64');let pos=8,data=[];while(pos<png.length){const n=png.readUInt32BE(pos),kind=png.toString('ascii',pos+4,pos+8);if(kind==='IDAT')data.push(png.subarray(pos+8,pos+8+n));pos+=n+12;}const rows=inflateSync(Buffer.concat(data)),stride=96*3+1,offset=32*stride+1+48*3,color=rows[offset]>200?(rows[offset+1]>100?'yellow':'red'):rows[offset+1]>100?'green':'blue';const digits=['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];let code='';for(let i=0;i<4;i++){let glyph='';for(let y=0;y<5;y++)for(let x=0;x<3;x++)glyph+=rows[(61+y*3)*stride+1+(25+i*12+x*3)*3]===0?'1':'0';code+=digits.indexOf(glyph);}return JSON.stringify({shape:'square',color,code});}
test('synthetic image probe verifies pixels, is bounded and does not contain user data',async()=>{
 let calls=0;const result=await probeImageInput({...input,fetch:async(url,init)=>{calls++;assert.equal(url,input.endpoint+'/chat/completions');assert.equal(init.redirect,'error');const body=JSON.parse(init.body);assert.equal(body.stream,false);assert.equal(body.messages[0].content[1].type,'image_url');return Response.json({choices:[{finish_reason:'stop',message:{content:correctAnswer(body)}}]});}});assert.equal(result,'passed');assert.equal(calls,1);
});
test('transport and generic HTTP failures are unknown, only explicit modality rejection is unsupported',async()=>{
 for(const response of [()=>{throw Object.assign(Error('DNS'),{code:'ENOTFOUND'});},()=>Response.json({error:{message:'Invalid request'}},{status:400}),()=>Response.json({error:{message:'Unauthorized'}},{status:401}),()=>Response.json({choices:[{message:{content:'OK'}}]})])assert.equal(await probeImageInput({...input,fetch:async()=>response()}),'unknown');
 assert.equal(await probeImageInput({...input,fetch:async()=>Response.json({error:{code:'unsupported_image_input'}},{status:400})}),'unsupported');
});
