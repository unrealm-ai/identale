import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkerPiDriver} from '../dist/driver.js';
import {requestContainsSteering} from '../dist/steering.js';
import {modelFetch} from '../dist/model-fetch.js';
import {deflateSync} from 'node:zlib';
const crc=bytes=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
const pngChunk=(name,data)=>{const type=Buffer.from(name),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([length,type,data,sum]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(2);ihdr.writeUInt32BE(2,4);ihdr[8]=8;ihdr[9]=2;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(Buffer.from([0,230,20,30,230,20,30,0,230,20,30,230,20,30]))),pngChunk('IEND',Buffer.alloc(0))]);
const event=(type,value)=>`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`;
test('protocol steering evidence only accepts the exact user content block, including merged Anthropic tool-result messages',()=>{
 const expected='nonce-bound synthetic steering';
 assert.equal(requestContainsSteering({input:[{role:'user',content:[{type:'input_text',text:expected}]}]},'openai_responses',expected),true);
 assert.equal(requestContainsSteering({messages:[{role:'user',content:[{type:'tool_result',content:'prior output'},{type:'text',text:expected}]}]},'anthropic_messages',expected),true);
 for(const payload of [{messages:[{role:'assistant',content:expected}]},{messages:[{role:'tool',content:expected}]},{messages:[{role:'user',content:[{type:'tool_result',content:expected}]}]},{messages:[{role:'user',content:expected+' extra'}]}])assert.equal(requestContainsSteering(payload,'anthropic_messages',expected),false);
 assert.throws(()=>requestContainsSteering({messages:[]},'openai_responses',expected),/unavailable/);
});
test('Anthropic destination guard does not generalize the fixed SDK beta flag into arbitrary query or path access',async()=>{
 const guarded=modelFetch('https://synthetic.invalid/v1','synthetic-key',undefined,undefined,undefined,undefined,undefined,'anthropic_messages');
 for(const path of ['/v1/messages?beta=false','/v1/messages?beta=true&other=1','/v1/messages/count_tokens?beta=true','/v1/messages?other=1'])await assert.rejects(guarded('https://synthetic.invalid'+path,{body:'{}'}),/destination/);
});
function responseStream(turn){
 const item=turn===1?{type:'function_call',id:'fc_read',call_id:'call_read',name:'read',arguments:JSON.stringify({path:'picture.png'})}:turn===2?{type:'function_call',id:'fc_write',call_id:'call_write',name:'write',arguments:JSON.stringify({path:'result.txt',content:'Synthetic verified output'})}:{type:'message',id:'msg_final',role:'assistant',status:'completed',content:[{type:'output_text',text:'Finished fixture image and tool exchange.',annotations:[]}]};
 return event('response.created',{response:{id:'resp_'+turn,status:'in_progress',output:[]}})+event('response.output_item.added',{output_index:0,item:item.type==='function_call'?{...item,arguments:''}:{...item,content:[]}})+(item.type==='function_call'?event('response.function_call_arguments.delta',{output_index:0,delta:item.arguments}):event('response.output_text.delta',{output_index:0,content_index:0,delta:item.content[0].text}))+event('response.output_item.done',{output_index:0,item})+event('response.completed',{response:{id:'resp_'+turn,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,input_tokens_details:{cached_tokens:0}}}});
}
function anthropicStream(turn){
 const tool=turn<3,block=tool?{type:'tool_use',id:'call_'+turn,name:turn===1?'read':'write',input:{}}:{type:'text',text:''},delta=tool?{type:'input_json_delta',partial_json:JSON.stringify(turn===1?{path:'picture.png'}:{path:'result.txt',content:'Synthetic verified output'})}:{type:'text_delta',text:'Finished fixture image and tool exchange.'};
 return event('message_start',{message:{id:'msg_'+turn,type:'message',role:'assistant',model:'fixture',content:[],usage:{input_tokens:10,output_tokens:0}}})+event('content_block_start',{index:0,content_block:block})+event('content_block_delta',{index:0,delta})+event('content_block_stop',{index:0})+event('message_delta',{delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:5}})+event('message_stop',{});
}
for(const protocol of ['openai_responses','anthropic_messages'])test(`native Pi SDK ${protocol} reads an image, carries it with paired tool history and executes another tool`,{timeout:30000},async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'identity-protocol-worker-'))),work=join(root,'work');await mkdir(work);await writeFile(join(work,'picture.png'),png);let requests=0,sawImage=false,sawResult=false,serverError;
 const server=createServer(async(req,res)=>{try{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests++;assert.equal(req.url,protocol==='openai_responses'?'/v1/responses':'/v1/messages?beta=true');assert.equal(protocol==='anthropic_messages'?req.headers['x-api-key']:req.headers.authorization,protocol==='anthropic_messages'?'synthetic-key':'Bearer synthetic-key');assert.equal(body.stream,true);assert.ok(body.tools.some(x=>(x.name??x.function?.name)==='read'));if(requests===2){sawImage=/"type":"(?:input_image|image)"/.test(JSON.stringify(body));assert.ok(sawImage,'native read image must be included after a successful read');if(protocol==='openai_responses'){assert.ok(body.input.some(x=>x.type==='function_call'&&x.call_id==='call_read'));assert.ok(body.input.some(x=>x.type==='function_call_output'&&x.call_id==='call_read'));}else assert.ok(JSON.stringify(body.messages).includes('tool_result'));}if(requests===3){sawResult=JSON.stringify(body).includes('result.txt');assert.ok(sawResult);}assert.ok(requests<=3);res.writeHead(200,{'content-type':'text/event-stream'});res.end(protocol==='openai_responses'?responseStream(requests):anthropicStream(requests));}catch(error){serverError=error;res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic assertion failed'}}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 const context={workspaceId:'w',entityId:'e',authorizationRef:'run',expiresAt:'2099-01-01T00:00:00Z',grantRef:'run',triggerId:'task',sourceEventRef:'task',configRevision:'1',trigger:{kind:'human_request',requester:{channelType:'web',tenantId:'w',identityNamespace:'platform-user',externalUserId:'u'}},sessionId:'s',invocationId:'run',target:{kind:'task_run',taskId:'task',runId:'run'}};
 const done=new WorkerPiDriver().start({spec:{platformTools:[],mcpServers:[],skills:[],role:'execution',thinkingLevel:'none'},context,instructions:'Use registered tools only.',prompt:'Read picture.png then write result.txt.',profile:{provider:'openai-compatible',protocol,modelId:'fixture',apiKey:'synthetic-key',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,inputCapabilities:{text:'passed',image:'passed',testedAt:'2026-11-03T00:00:00Z',probeVersion:1}},sessionDirectory:join(root,'session'),resume:false,mcpServers:[],skills:[],executionResource:{resourceId:'r',version:'1',mode:'task',root:work,directory:work,tools:['read','write']}},async()=>{}).done;
 let result;try{result=await done;}catch(error){const pointer=JSON.parse(await readFile(join(root,'session','session-pointer.json'),'utf8'));const entries=(await readFile(pointer,'utf8')).trim().split('\n').map(x=>JSON.parse(x));const errors=entries.filter(x=>x.message?.errorMessage).map(x=>x.message.errorMessage);throw serverError??new Error('Fixture requests='+requests+'; '+errors.join('; '),{cause:error});}assert.ifError(serverError);assert.equal(result,'Finished fixture image and tool exchange.');assert.equal(requests,3);assert.ok(sawImage&&sawResult);assert.equal(await readFile(join(work,'result.txt'),'utf8'),'Synthetic verified output');
});
