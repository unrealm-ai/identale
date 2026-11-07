import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DingTalkDwsConversationAdapter,DingTalkDwsMeetingArtifactsAdapter} from '../dist/adapters/channels/dws.js';

const connection={workspaceId:'w',connectionId:'dws',provider:'dingtalk',tenantId:'corp',identity:{kind:'delegated_user',externalId:'user'},credentialRef:'host-profile'};
const group={provider:'dingtalk',connectionId:'dws',tenantId:'corp',kind:'conversation',externalId:'group1'};
const minute={...group,kind:'minutes',externalId:'minute1'};
const transcript={...minute,kind:'transcript'};
const range={startAt:Date.parse('2026-07-20T00:00:00Z'),endAt:Date.parse('2026-07-21T00:00:00Z')};
async function fixture(t,response){
 const dir=await mkdtemp(join(tmpdir(),'identity-dws-test-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const executable=join(dir,'fake-dws');
 await writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync('call.json',JSON.stringify({argv:process.argv.slice(2),env:process.env}));const x=JSON.parse(fs.readFileSync('response.json','utf8'));if(x.delay)setTimeout(()=>{},x.delay);else if(x.exit){if(x.stdout)process.stdout.write(JSON.stringify(x.stdout));process.stderr.write('private-provider-error');process.exitCode=x.exit}else if(x.raw!==undefined)process.stdout.write(x.raw);else process.stdout.write(JSON.stringify(x));\n`,{mode:0o700});
 const set=async x=>writeFile(join(dir,'response.json'),JSON.stringify(x.data?{ok:true,outcome:'success',...x}:x));await set(response);
 return {set,call:async()=>JSON.parse(await readFile(join(dir,'call.json'),'utf8')),options:{executable,configDirectory:dir,workingDirectory:dir,profile:'corp:user',authorizedConversationIds:['group1'],authorizedMinuteIds:['minute1'],now:()=>123}};
}
const history={data:{contractVersion:'im.message-list.v1',messages:[{messageId:'m1',conversationId:'group1',senderId:'person',sender:'张三',text:'hello',createTime:'2026-07-20 21:41:21'}],failedCount:0,failures:[],complete:true,hasMore:false}};
const paragraphs=(next)=>({data:{taskUuid:'minute1',complete:true,paragraphList:[{paragraphId:next?'p1':'p2',paragraph:'hello',nickName:'Speaker A',unionId:'speaker-union',startTime:10,endTime:20}]},meta:{pagination:{endpoint_exhausted:!next,...(next?{next_token:next}:{})}}});
test('DWS fixed read command isolates environment and retains bounded query and source labels',async t=>{
 const f=await fixture(t,history),a=new DingTalkDwsConversationAdapter(connection,f.options);
 const page=await a.listMessages(group,range);assert.equal(page.items[0].occurredAt,Date.parse('2026-07-20T13:41:21Z'));assert.equal(page.items[0].author.identityEvidence,'source_label');assert.equal(page.items[0].author.idNamespace,'unknown');assert.equal(page.exhausted,true);
 const call=await f.call();assert.deepEqual(call.argv.slice(0,5),['--profile','corp:user','chat','+chat-messages','--group']);assert.equal(call.env.DWS_CONFIG_DIR,f.options.configDirectory);assert.equal(call.env.PATH,undefined);assert.equal(call.env.OPENAI_API_KEY,undefined);
 assert.equal((await a.inspectCapabilities(group)).ordinaryMessageEvents.supported,false);
 await assert.rejects(a.listMessages(group,{}),{code:'invalid_request'});
 await assert.rejects(a.listMessages(group,{...range,order:'desc'}),{code:'unsupported'});
 await assert.rejects(a.listMessages({...group,provider:'feishu'},range),{code:'forbidden'});
 await assert.rejects(a.listMessages({...group,externalId:'other'},range),{code:'forbidden'});
 assert.throws(()=>new DingTalkDwsConversationAdapter(connection,{...f.options,profile:'corp:other'}),{code:'forbidden'});
 await assert.rejects(a.sendMessage({conversation:group,text:'hello',operationId:'send'}),{code:'unsupported'});
});
test('DWS partial history never implies complete coverage or invented continuation',async t=>{
 const f=await fixture(t,{data:{...history.data,complete:false,hasMore:true,nextPage:{time:'x'}}}),a=new DingTalkDwsConversationAdapter(connection,f.options);
 const p=await a.listMessages(group,range);assert.equal(p.exhausted,false);assert.equal(p.coverage,'partial');assert.equal(p.nextCursor,undefined);
 await f.set({data:{...history.data,messages:[{...history.data.messages[0],conversationId:'other'}]}});await assert.rejects(a.listMessages(group,range),{code:'forbidden'});
 await f.set({raw:'not-json'});await assert.rejects(a.listMessages(group,range),{code:'temporarily_unavailable'});
});
test('DWS transcript uses metadata cursor, scopes continuation and labels unverified speakers',async t=>{
 const f=await fixture(t,paragraphs('next-page')),a=new DingTalkDwsMeetingArtifactsAdapter(connection,f.options);
 const p=await a.readTranscript(transcript,{});assert.equal(p.exhausted,false);assert.equal(p.items[0].speaker.identityEvidence,'source_label');assert.equal(p.items[0].speaker.idNamespace,'union_id');assert.equal(p.items[0].sequence,0);
 await f.set(paragraphs());const p2=await a.readTranscript(transcript,{cursor:p.nextCursor});assert.equal(p2.items[0].sequence,1);assert.equal(p2.exhausted,true);assert.ok((await f.call()).argv.includes('next-page'));
 await assert.rejects(a.readTranscript(transcript,{cursor:'bad-cursor'}),{code:'invalid_request'});
 await assert.rejects(a.readTranscript(transcript,{limit:10}),{code:'unsupported'});
 await f.set({data:{taskUuid:'other',complete:true,paragraphList:[]},meta:{pagination:{endpoint_exhausted:true}}});await assert.rejects(a.readTranscript(transcript,{}),{code:'temporarily_unavailable'});
});
test('DWS summary is official source and minutes namespace is not a meeting ID',async t=>{
 const f=await fixture(t,{data:{taskUuid:'minute1',complete:true,summary:{result:{fullSummary:'Official summary'}}}}),a=new DingTalkDwsMeetingArtifactsAdapter(connection,f.options);
 const result=await a.readSummary({...minute,kind:'summary'});assert.equal(result.text,'Official summary');assert.equal(result.artifact.origin,'provider_summary');assert.deepEqual(result.artifact.sourceRef,minute);
 await assert.rejects(a.resolveMeeting({...minute,kind:'meeting'}),{code:'unsupported'});
 await assert.rejects(a.listArtifacts({...minute,kind:'summary'}),{code:'unsupported'});
 await f.set({data:{taskUuid:'minute1',complete:true,summary:{result:{}}}});await assert.rejects(a.readSummary({...minute,kind:'summary'}));
});
test('DWS subprocess timeout, output bound and failures are sanitized',async t=>{
 const f=await fixture(t,{exit:1}),a=new DingTalkDwsConversationAdapter(connection,f.options);
 await assert.rejects(a.listMessages(group,range),e=>e.code==='temporarily_unavailable'&&!e.message.includes('private-provider-error'));
 await f.set({delay:1000});await assert.rejects(new DingTalkDwsConversationAdapter(connection,{...f.options,timeoutMs:30}).listMessages(group,range),{code:'temporarily_unavailable'});
 await f.set({raw:'x'.repeat(10000)});await assert.rejects(new DingTalkDwsConversationAdapter(connection,{...f.options,maxOutputBytes:1024}).listMessages(group,range),{code:'temporarily_unavailable'});
});
test('DWS signed history cursors bind filters and adapter identity and reject loops',async t=>{
 const f=await fixture(t,{data:{...history.data,complete:false,hasMore:true,nextPageToken:'provider-token'}}),a=new DingTalkDwsConversationAdapter(connection,f.options);
 const p=await a.listMessages(group,range);assert.notEqual(p.nextCursor,'provider-token');
 await assert.rejects(a.listMessages(group,{...range,endAt:range.endAt+1,cursor:p.nextCursor}),{code:'invalid_request'});
 await assert.rejects(a.listMessages(group,{...range,limit:20,cursor:p.nextCursor}),{code:'invalid_request'});
 await assert.rejects(new DingTalkDwsConversationAdapter(connection,f.options).listMessages(group,{...range,cursor:p.nextCursor}),{code:'invalid_request'});
 await assert.rejects(a.listMessages(group,{...range,cursor:p.nextCursor+'x'}),{code:'invalid_request'});
 await assert.rejects(a.listMessages(group,{...range,limit:50,cursor:p.nextCursor}),{code:'partial_failure'});
 await f.set(history);assert.equal((await a.listMessages(group,{...range,limit:50,cursor:p.nextCursor})).exhausted,true);
 assert.ok((await f.call()).argv.includes('provider-token'));
});
test('DWS transcript signed offset cannot be edited, loops rejected, empty summary not ready',async t=>{
 const f=await fixture(t,paragraphs('repeat')),a=new DingTalkDwsMeetingArtifactsAdapter(connection,f.options);
 const p=await a.readTranscript(transcript,{});
 const [payload,mac]=p.nextCursor.split('.');const decoded=JSON.parse(Buffer.from(payload,'base64url'));decoded.offset=999;
 const changed=Buffer.from(JSON.stringify(decoded)).toString('base64url')+'.'+mac;
 await assert.rejects(a.readTranscript(transcript,{cursor:changed}),{code:'invalid_request'});
 await assert.rejects(a.readTranscript(transcript,{cursor:p.nextCursor}),{code:'partial_failure'});
 await f.set({data:{taskUuid:'minute1',complete:true,summary:{result:{fullSummary:'  '}}}});
 await assert.rejects(a.readSummary({...minute,kind:'summary'}),{code:'not_ready'});
});
test('DWS material listing preserves per-artifact authorization failure',async t=>{
 const {ChannelError}=await import('@dentity/application');
 const f=await fixture(t,paragraphs()),a=new DingTalkDwsMeetingArtifactsAdapter(connection,f.options);
 a.readSummary=async()=>{throw new ChannelError('forbidden');};
 const results=await a.listArtifacts(minute);
 assert.equal(results[0].state,'unknown');assert.equal(results[0].readError,'forbidden');
 assert.equal(results[1].state,'ready');assert.deepEqual(results[1].sourceRef,minute);
});
test('DWS rejects unknown message contracts and unrecognized envelopes',async t=>{
 const f=await fixture(t,{data:{...history.data,contractVersion:'unknown'}}),a=new DingTalkDwsConversationAdapter(connection,f.options);
 await assert.rejects(a.listMessages(group,range),{code:'temporarily_unavailable'});
 await f.set({data:history.data,ok:false,outcome:'failure'});await assert.rejects(a.listMessages(group,range),{code:'temporarily_unavailable'});
 await f.set({raw:JSON.stringify({data:history.data})});await assert.rejects(a.listMessages(group,range),{code:'temporarily_unavailable'});
});
test('DWS exit 7 accepts only official partial envelope and never guesses message projection',async t=>{
 const partial={ok:false,outcome:'partial_failure',data:{total:2,succeeded:[{id:'a'}],failed:[{id:'b',error:{type:'api'}}],unknown:[]}};
 const f=await fixture(t,{exit:7,stdout:partial}),a=new DingTalkDwsConversationAdapter(connection,f.options);
 await assert.rejects(a.listMessages(group,range),{code:'partial_failure'});
 await f.set({exit:7,stdout:{ok:false,outcome:'partial_failure',data:history.data}});await assert.rejects(a.listMessages(group,range),{code:'temporarily_unavailable'});
 await f.set({exit:1,stdout:partial});await assert.rejects(a.listMessages(group,range),{code:'temporarily_unavailable'});
 await f.set({exit:7,stdout:{...partial,data:{...partial.data,total:9}}});await assert.rejects(a.listMessages(group,range),{code:'temporarily_unavailable'});
});
