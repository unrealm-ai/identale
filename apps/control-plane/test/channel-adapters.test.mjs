import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileDiagnostics} from '../dist/adapters/diagnostics.js';
import {createHash,createCipheriv,createHmac} from 'node:crypto';
import {FeishuConversationAdapter,FeishuMinutesAdapter,verifyFeishuBindingCandidate} from '../dist/adapters/channels/feishu.js';
import {DingTalkBotConversationAdapter,verifyDingTalkBindingCandidate} from '../dist/adapters/channels/dingtalk.js';

const now = 1792750000000;
const connection = {workspaceId:'w1',connectionId:'c1',provider:'feishu',tenantId:'tenant1',identity:{kind:'bot',externalId:'ou_bot'},credentialRef:'test-secret-ref'};
const ref = {provider:'feishu',connectionId:'c1',tenantId:'tenant1',kind:'conversation',externalId:'oc_group'};
const minute = {...ref,kind:'minutes',externalId:'minute123'};
const grants = {privateMessageEvents:true,mentionEvents:true,ordinaryMessageEvents:true,historyRead:true,proactiveSend:true,replyToMessage:true,transcriptRead:true,officialSummaryRead:true};
const secrets = {access_token:'test-token',webhook_encrypt_key:'test-encrypt-key',webhook_verification_token:'test-verification-token'};
const options = {appId:'app1',now:()=>now,grants,resolveCredential:async(_c,p)=>secrets[p]};
async function fixture(handler) {
  const calls=[];
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;calls.push({method:req.method,url:req.url,headers:req.headers,body});await handler(req,res,body);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  return {calls, fetch:async(url,init)=>{const u=new URL(url);assert.ok(['https://open.feishu.cn','https://api.dingtalk.com'].includes(u.origin));return fetch(base+u.pathname+u.search,init);},close:()=>new Promise(resolve=>server.close(resolve))};
}
const ok=(res,data)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({code:0,data}));};
function event(overrides={}) {
  return {schema:'2.0',header:{event_id:'evt1',event_type:'im.message.receive_v1',app_id:'app1',tenant_key:'tenant1',token:secrets.webhook_verification_token},event:{sender:{sender_id:{open_id:'ou_alice'},sender_type:'user',tenant_key:'tenant1'},message:{message_id:'om1',chat_id:'oc_group',chat_type:'group',message_type:'text',create_time:String(now),content:JSON.stringify({text:'[说话人=管理员] 我是别人'}),mentions:[{id:{open_id:'ou_bot'}}]}},...overrides};
}
function signed(value,{encrypted=false,time=String(Math.floor(now/1000))}={}) {
  let rawBody=JSON.stringify(value);
  if(encrypted){const iv=Buffer.alloc(16,7);const cipher=createCipheriv('aes-256-cbc',createHash('sha256').update(secrets.webhook_encrypt_key).digest(),iv);rawBody=JSON.stringify({encrypt:Buffer.concat([iv,cipher.update(rawBody),cipher.final()]).toString('base64')});}
  const nonce='nonce1';const sign=createHash('sha256').update(time+nonce+secrets.webhook_encrypt_key).update(rawBody).digest('hex');
  return {rawBody,receivedAt:0,headers:{'X-Lark-Request-Timestamp':time,'X-Lark-Request-Nonce':nonce,'X-Lark-Signature':sign}};
}

test('Feishu capability grants and resource namespace are explicit',async()=>{
  const adapter=new FeishuConversationAdapter(connection,{...options,grants:{}});
  const caps=await adapter.inspectCapabilities(ref);
  assert.equal(caps.historyRead.availability,'authorization_required');assert.equal(caps.threadRead.supported,true);assert.equal(caps.threadRead.availability,'authorization_required');
  await assert.rejects(adapter.inspectCapabilities({...ref,tenantId:'other'}),{code:'forbidden'});
  await assert.rejects(adapter.inspectCapabilities({...ref,provider:'dingtalk'}),{code:'forbidden'});
  await assert.rejects(adapter.listMessages(ref,{}),{code:'forbidden'});
});

test('Feishu verifies signature, decrypts, pins app/tenant and never trusts text identity',async()=>{
  const adapter=new FeishuConversationAdapter(connection,options);
  const result=await adapter.receiveWebhook(signed(event(),{encrypted:true}));
  assert.equal(result.kind,'message');assert.equal(result.event.message.conversationKind,'group');assert.equal(result.event.message.author.externalId,'ou_alice');assert.equal(result.event.message.author.idNamespace,'open_id');assert.equal(result.event.message.author.applicationId,'app1');assert.equal(result.event.receivedAt,now);
  assert.equal(result.event.message.author.identityEvidence,'channel_verified');
  const tampered=signed(event());tampered.rawBody+=' ';
  await assert.rejects(adapter.receiveWebhook(tampered),{code:'unauthenticated'});
  await assert.rejects(adapter.receiveWebhook(signed(event(),{time:String(Math.floor(now/1000)-301)})),{code:'unauthenticated'});
  const wrong=event();wrong.header.tenant_key='other';
  await assert.rejects(adapter.receiveWebhook(signed(wrong)),{code:'forbidden'});
  const wrongApp=event();wrongApp.header.app_id='other';await assert.rejects(adapter.receiveWebhook(signed(wrongApp)),{code:'forbidden'});
  const privateEvent=event();privateEvent.event.message.chat_type='p2p';assert.equal((await adapter.receiveWebhook(signed(privateEvent))).event.message.conversationKind,'private');
});

test('Feishu requires explicit ordinary-message grant and rejects forged challenge',async()=>{
  const adapter=new FeishuConversationAdapter(connection,{...options,grants:{mentionEvents:true}});
  const ordinary=event();ordinary.event.message.mentions=[];
  await assert.rejects(adapter.receiveWebhook(signed(ordinary)),{code:'forbidden'});
  const challenge={type:'url_verification',token:secrets.webhook_verification_token,challenge:'verify-me'};
  assert.deepEqual(await adapter.receiveWebhook(signed(challenge)),{kind:'challenge',challenge:'verify-me'});
  assert.deepEqual(await adapter.receiveWebhook({rawBody:JSON.stringify(challenge),headers:{},receivedAt:now}),{kind:'challenge',challenge:'verify-me'});
  await assert.rejects(adapter.receiveWebhook({rawBody:JSON.stringify({...challenge,token:'wrong-token'}),headers:{},receivedAt:now}),{code:'unauthenticated'});
});

test('Feishu history retains pagination and rejects missing continuation',async t=>{
  let broken=false;
  const f=await fixture((_req,res)=>ok(res,{has_more:true,...(!broken?{page_token:'page2'}:{}),items:[{message_id:'om1',chat_id:'oc_group',msg_type:'text',create_time:String(now),sender:{id:'ou_alice',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:'hello'})},mentions:[{id:'ou_bot',id_type:'open_id'}]}]}));t.after(f.close);
  const adapter=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch});
  const page=await adapter.listMessages(ref,{limit:10});
  assert.equal(page.exhausted,false);assert.ok(page.nextCursor);assert.notEqual(page.nextCursor,'page2');assert.equal(page.items[0].text,'hello');assert.equal(page.items[0].mentions[0],'ou_bot');
  assert.equal(f.calls[0].headers.authorization,'Bearer test-token');
  await assert.rejects(adapter.listMessages(ref,{limit:11,cursor:page.nextCursor}),{code:'invalid_request'});
  await assert.rejects(adapter.listMessages(ref,{limit:10,cursor:page.nextCursor+'x'}),{code:'invalid_request'});
  await assert.rejects(adapter.listMessages(ref,{limit:10,cursor:page.nextCursor}),{code:'partial_failure'});
  assert.ok(f.calls.at(-1).url.includes('page_token=page2'));
  await assert.rejects(adapter.listMessages(ref,{startAt:1001}),{code:'invalid_request'});
  broken=true;await assert.rejects(adapter.listMessages(ref,{}),{code:'partial_failure'});
});

test('Feishu prevents replying into another conversation and sends bounded text',async t=>{
  const f=await fixture((req,res)=>req.method==='GET'?ok(res,{items:[{chat_id:'oc_other'}]}):ok(res,{message_id:'sent1'}));t.after(f.close);
  const adapter=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch});
  await assert.rejects(adapter.sendMessage({conversation:ref,text:'hello',operationId:'op1',replyToMessageId:'other-message'}),{code:'forbidden'});
  assert.equal(f.calls.length,1);
  const receipt=await adapter.sendMessage({conversation:ref,text:'hello',operationId:'op2'});
  assert.equal(receipt.messageId,'sent1');assert.equal(JSON.parse(f.calls[1].body).receive_id,'oc_group');
  await assert.rejects(adapter.sendMessage({conversation:ref,text:'x'.repeat(16001),operationId:'op3'}),{code:'invalid_request'});
});

test('Feishu Minutes processing differs from absence and preserves exact source text',async t=>{
  let processing=true;
  const f=await fixture((req,res)=>{if(processing)res.end(JSON.stringify({code:2091003}));else if(req.url.includes('/transcript?')){assert.ok(req.url.includes('need_speaker=true'));assert.ok(req.url.includes('need_timestamp=true'));res.end('张三 00:01\n原文不能改写');}else ok(res,{summary:'原生摘要',transcript:'张三 00:01\n原文不能改写'});});t.after(f.close);
  const adapter=new FeishuMinutesAdapter(connection,{...options,fetch:f.fetch});
  const artifacts=await adapter.listArtifacts(minute);assert.ok(artifacts.every(x=>x.state==='processing'));
  await assert.rejects(adapter.readTranscript({...minute,kind:'transcript'},{}),{code:'not_ready'});
  processing=false;
  const transcript=await adapter.readTranscript({...minute,kind:'transcript'},{});
  assert.equal(transcript.items[0].text,'张三 00:01\n原文不能改写');assert.equal(transcript.items[0].speaker,undefined);
  assert.equal((await adapter.inspectCapabilities()).speakerIdentity,'embedded_labels');
  const summary=await adapter.readSummary({...minute,kind:'summary'});
  assert.equal(summary.text,'原生摘要');assert.deepEqual(summary.artifact.sourceRef,minute);
  await assert.rejects(adapter.resolveMeeting({...minute,kind:'meeting'}),{code:'unsupported'});
  await assert.rejects(adapter.readTranscript({...minute,kind:'transcript'},{cursor:'p2'}),{code:'unsupported'});
});

test('provider transport bounds response, rejects redirects and sanitizes authorization errors',async t=>{
  let mode='large';
  const f=await fixture((_req,res)=>{if(mode==='large'){res.end('x'.repeat(300));}else if(mode==='redirect'){res.writeHead(302,{location:'https://example.invalid/never'});res.end();}else{res.writeHead(403);res.end('secret test-token');}});t.after(f.close);
  const adapter=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch,maxResponseBytes:100});
  await assert.rejects(adapter.listMessages(ref,{}),e=>e.message==='provider_response_too_large');
  mode='redirect';await assert.rejects(adapter.listMessages(ref,{}),{code:'temporarily_unavailable'});
  mode='forbidden';await assert.rejects(adapter.listMessages(ref,{}),e=>e.code==='forbidden'&&!e.message.includes('test-token'));
});

test('DingTalk uses durable proactive API and returns acceptance not a fabricated message ID',async t=>{
  const f=await fixture((_req,res)=>res.end(JSON.stringify({processQueryKey:'request-key'})));t.after(f.close);
  const conn={...connection,provider:'dingtalk'};const target={...ref,provider:'dingtalk'};
  const adapter=new DingTalkBotConversationAdapter(conn,{...options,fetch:f.fetch,robotCode:'robot1',proactiveSendGranted:true});
  const caps=await adapter.inspectCapabilities();assert.equal(caps.ordinaryMessageEvents.supported,false);assert.equal(caps.historyRead.supported,false);
  const receipt=await adapter.sendMessage({conversation:target,text:'hello',operationId:'op1'});
  assert.deepEqual(receipt,{status:'accepted',providerRequestId:'request-key',idempotent:false});
  assert.equal(f.calls[0].url,'/v1.0/robot/groupMessages/send');assert.equal(f.calls[0].headers['x-acs-dingtalk-access-token'],'test-token');
  assert.deepEqual(JSON.parse(f.calls[0].body),{robotCode:'robot1',openConversationId:'oc_group',msgKey:'sampleText',msgParam:'{"content":"hello"}'});
  await assert.rejects(adapter.sendMessage({conversation:target,text:'hello',operationId:'op2',replyToMessageId:'some-message'}),{code:'unsupported'});
});

test('uncertain outbound transport failure is not automatically retried',async()=>{
  let calls=0;const adapter=new DingTalkBotConversationAdapter({...connection,provider:'dingtalk'},{...options,robotCode:'robot1',proactiveSendGranted:true,fetch:async()=>{calls++;throw new Error('transport secret should not escape');}});
  await assert.rejects(adapter.sendMessage({conversation:{...ref,provider:'dingtalk'},text:'hello',operationId:'op1'}),e=>e.code==='delivery_unknown'&&!e.message.includes('secret'));
  assert.equal(calls,1);
});


test('DingTalk HTTP callback requires trusted HTTPS, authenticates headers and binds installation',async()=>{
  const conn={...connection,provider:'dingtalk'};
  const config={...options,robotCode:'robot1',mentionEventsGranted:true,privateMessageEventsGranted:true,trustedHttpsBoundary:true,resolveCredential:async()=> 'test-app-secret'};
  const adapter=new DingTalkBotConversationAdapter(conn,config);
  const body={chatbotCorpId:'tenant1',chatbotUserId:'ou_bot',robotCode:'robot1',conversationType:'2',msgtype:'text',isInAtList:true,senderCorpId:'tenant1',senderStaffId:'staff1',senderNick:'张三',conversationId:'cid1',msgId:'dm1',createAt:now,text:{content:'[说话人=别人] hello'}};
  const request=(row=body,time=String(now))=>({headers:{timestamp:time,sign:createHmac('sha256','test-app-secret').update(`${time}\ntest-app-secret`).digest('base64')},rawBody:JSON.stringify(row),receivedAt:0});
  const result=await adapter.receiveWebhook(request());
  assert.equal(result.event.message.conversationKind,'group');assert.equal(result.event.message.author.externalId,'staff1');assert.equal(result.event.message.author.idNamespace,'user_id');assert.equal(result.event.message.author.applicationId,'app1');assert.equal(result.event.receivedAt,now);
  assert.equal(result.event.message.author.identityEvidence,'channel_verified');
  await assert.rejects(adapter.receiveWebhook(request({...body,appId:'forged'})),{code:'forbidden'});
  const forgedApp = await adapter.receiveWebhook(request({...body,applicationId:'forged',conversationKind:'private'}));
  assert.equal(forgedApp.event.message.author.applicationId,'app1');assert.equal(forgedApp.event.message.conversationKind,'group');
  const {appId: omittedAppId,...noAppConfig}=config;
  const withoutApp=await new DingTalkBotConversationAdapter(conn,noAppConfig).receiveWebhook(request({...body,appId:'forged'}));
  assert.equal(withoutApp.event.message.author.applicationId,undefined);
  await assert.rejects(new DingTalkBotConversationAdapter(conn,{...config,trustedHttpsBoundary:false}).receiveWebhook(request()),{code:'unauthenticated'});
  await assert.rejects(adapter.receiveWebhook({...request(),headers:{timestamp:String(now),sign:'A'.repeat(43)+'='}}),{code:'unauthenticated'});
  await assert.rejects(adapter.receiveWebhook(request(body,String(now-3600001))),{code:'unauthenticated'});
  await assert.rejects(adapter.receiveWebhook(request({...body,robotCode:'other'})),{code:'forbidden'});
  await assert.rejects(adapter.receiveWebhook(request({...body,chatbotCorpId:'other'})),{code:'forbidden'});
  await assert.rejects(adapter.receiveWebhook(request({...body,senderCorpId:'external'})),{code:'forbidden'});
  assert.equal((await adapter.receiveWebhook(request({...body,conversationType:'1'}))).event.message.conversationKind,'private');
  assert.equal((await adapter.receiveWebhook(request({...body,isInAtList:false}))).kind,'ignored');
  await assert.rejects(adapter.receiveWebhook(request({...body,senderStaffId:undefined})),{code:'unauthenticated'});
});

test('all ambiguous outbound provider responses stay delivery_unknown and are never retried',async t=>{
  let mode='500';
  const f=await fixture((_req,res)=>{if(mode==='500'){res.statusCode=500;res.end('{}');}else if(mode==='large')res.end('x'.repeat(300));else if(mode==='empty')res.end();else if(mode==='html')res.end('<html>');else if(mode==='array')res.end('[]');else if(mode==='missing')res.end('{}');else res.end(JSON.stringify({code:123456,msg:'private provider diagnostic'}));});t.after(f.close);
  const ding=new DingTalkBotConversationAdapter({...connection,provider:'dingtalk'},{...options,fetch:f.fetch,maxResponseBytes:100,robotCode:'robot1',proactiveSendGranted:true});
  const feishu=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch,maxResponseBytes:100});
  for(const item of ['500','large','empty','html','array','missing','unknown-business']){
    mode=item;
    const before=f.calls.length;
    await assert.rejects(ding.sendMessage({conversation:{...ref,provider:'dingtalk'},text:'hello',operationId:'op'}),{code:'delivery_unknown'});
    await assert.rejects(feishu.sendMessage({conversation:ref,text:'hello',operationId:'op'}),{code:'delivery_unknown'});
    assert.equal(f.calls.length,before+2);
  }
});


test('Feishu transcript metadata follows export bytes and permissions independently of summary',async t=>{
  const f=await fixture((req,res)=>{if(req.url.includes('/transcript?'))res.end('Speaker A 00:01\nexact export');else {res.statusCode=403;res.end('{}');}});t.after(f.close);
  const adapter=new FeishuMinutesAdapter(connection,{...options,grants:{transcriptRead:true},fetch:f.fetch});
  const artifact=await adapter.getArtifact({...minute,kind:'transcript'});
  assert.equal(artifact.state,'ready');assert.equal(artifact.version,createHash('sha256').update('Speaker A 00:01\nexact export').digest('hex'));
  const listed=await adapter.listArtifacts(minute);
  assert.equal(listed[0].state,'ready');assert.equal(listed[1].state,'unknown');assert.equal(listed[1].readError,'forbidden');
  assert.ok(f.calls.every(call=>call.url.includes('/transcript?')));
});


test('Feishu signed private events need a separate grant and immutable trusted app identity',async()=>{
  const config={...options,grants:{privateMessageEvents:true}};
  const adapter=new FeishuConversationAdapter(connection,config);
  config.appId='forged';config.grants.privateMessageEvents=false;
  const e=event();e.event.message.chat_type='p2p';e.event.message.mentions=[];
  e.event.message.conversationKind='group';e.event.sender.applicationId='forged';
  const result=await adapter.receiveWebhook(signed(e));
  assert.equal(result.event.message.conversationKind,'private');
  assert.equal(result.event.message.conversation.conversationKind,'private');
  assert.equal(result.event.message.author.applicationId,'app1');
  assert.deepEqual(result.event.message.mentions,[]);
  await assert.rejects(new FeishuConversationAdapter(connection,{...options,grants:{mentionEvents:true}}).receiveWebhook(signed(e)),{code:'forbidden'});
  e.event.sender.sender_id.open_id='ou_bot';assert.equal((await adapter.receiveWebhook(signed(e))).kind,'ignored');
});

test('DingTalk private callback fixes the recipient and ignores callback URL and forged actor app',async t=>{
  const config={...options,robotCode:'robot1',privateMessageEventsGranted:true,trustedHttpsBoundary:true,proactiveSendGranted:true,resolveCredential:async()=> 'test-app-secret'};
  const body={chatbotCorpId:'tenant1',chatbotUserId:'ou_bot',robotCode:'robot1',conversationType:'1',msgtype:'text',senderCorpId:'tenant1',senderStaffId:'staff1',conversationId:'private-cid',msgId:'private-msg',createAt:now,text:{content:'hello'},sessionWebhook:'https://attacker.invalid',applicationId:'forged'};
  const request=row=>({headers:{timestamp:String(now),sign:createHmac('sha256','test-app-secret').update(`${now}\ntest-app-secret`).digest('base64')},rawBody:JSON.stringify(row),receivedAt:0});
  let rejected=false;
  const f=await fixture((_req,res)=>res.end(JSON.stringify({processQueryKey:'private-send',...(rejected?{invalidStaffIdList:['staff1']}:{})})));t.after(f.close);
  const adapter=new DingTalkBotConversationAdapter({...connection,provider:'dingtalk'},{...config,fetch:f.fetch});
  config.appId='forged';
  const result=await adapter.receiveWebhook(request(body));
  assert.equal(result.event.message.conversation.externalId,'private-cid');
  assert.equal(result.event.message.conversation.privateRecipientId,'staff1');
  assert.equal(result.event.message.author.applicationId,'app1');
  assert.deepEqual(result.event.message.mentions,[]);
  const send={conversation:result.event.message.conversation,text:'reply',operationId:'private-op'};
  assert.equal((await adapter.sendMessage(send)).status,'accepted');
  assert.equal(f.calls[0].url,'/v1.0/robot/oToMessages/batchSend');
  assert.deepEqual(JSON.parse(f.calls[0].body),{robotCode:'robot1',userIds:['staff1'],msgKey:'sampleText',msgParam:'{"content":"reply"}'});
  await assert.rejects(adapter.sendMessage({...send,conversation:{...send.conversation,privateRecipientId:undefined}}),{code:'invalid_request'});
  rejected=true;await assert.rejects(adapter.sendMessage(send),{code:'invalid_request'});
  assert.equal(f.calls.length,2);
  await assert.rejects(adapter.receiveWebhook(request({...body,senderStaffId:undefined})),{code:'unauthenticated'});
  assert.equal((await adapter.receiveWebhook(request({...body,senderId:'ou_bot'}))).kind,'ignored');
  await assert.rejects(adapter.receiveWebhook(request({...body,chatbotCorpId:'other'})),{code:'forbidden'});
  await assert.rejects(new DingTalkBotConversationAdapter({...connection,provider:'dingtalk'},{...config,privateMessageEventsGranted:false}).receiveWebhook(request(body)),{code:'forbidden'});
});


test('Feishu display-id pending installation discovers only a signed same-app actual tenant',async()=>{
  const pending={...connection,tenantId:'display-123'};
  const adapter=new FeishuConversationAdapter(pending,{...options,expectedTenantNamespace:'display_id'});
  const result=await adapter.receiveWebhook(signed(event()));
  assert.equal(result.event.tenantId,'tenant1');assert.equal(result.event.message.conversation.tenantId,'tenant1');
  assert.equal(adapter.connection.tenantId,'display-123');
  await assert.rejects(new FeishuConversationAdapter(pending,{...options,expectedTenantNamespace:'tenant_key'}).receiveWebhook(signed(event())),{code:'forbidden'});
  const bad=event();bad.header.app_id='other';await assert.rejects(adapter.receiveWebhook(signed(bad)),{code:'forbidden'});
  const badSender=event();badSender.event.sender.tenant_key='other';await assert.rejects(adapter.receiveWebhook(signed(badSender)),{code:'forbidden'});
  const tampered=signed(event());tampered.rawBody+=' ';await assert.rejects(adapter.receiveWebhook(tampered),{code:'unauthenticated'});
});


test('DingTalk pending binding yields only a challenge-bound candidate, not a business event',async()=>{
  const body={msgId:'verify-msg',chatbotCorpId:'corp-candidate',chatbotUserId:'bot-candidate',robotCode:'robot-not-app-key',senderStaffId:'staff',senderCorpId:'corp-candidate',conversationType:'1',msgtype:'text',text:{content:'  identity-verify-test  '},appId:'trusted-app'};
  const options={appId:'trusted-app',resolveAppSecret:async()=> 'fixture-secret',challengeText:'identity-verify-test',expiresAt:now+600000,now:()=>now,trustedHttpsBoundary:true};
  const request=(value=body,time=String(now))=>({rawBody:JSON.stringify(value),receivedAt:0,headers:{timestamp:time,sign:createHmac('sha256','fixture-secret').update(`${time}\nfixture-secret`).digest('base64')}});
  const result=await verifyDingTalkBindingCandidate(request(),options);
  assert.deepEqual(result,{eventId:'verify-msg',messageId:'verify-msg',appId:'trusted-app',botId:'robot-not-app-key',tenantId:'corp-candidate',robotCode:'robot-not-app-key',challengeText:'identity-verify-test'});
  assert.equal('event' in result,false);assert.equal('identityEvidence' in result,false);
  await assert.rejects(verifyDingTalkBindingCandidate({...request(),headers:{...request().headers,sign:'A'.repeat(43)+'='}},options),{code:'unauthenticated'});
  await assert.rejects(verifyDingTalkBindingCandidate(request(body,String(now-3600001)),options),{code:'unauthenticated'});
  await assert.rejects(verifyDingTalkBindingCandidate(request(),{...options,expiresAt:now}),{code:'unauthenticated'});
  await assert.rejects(verifyDingTalkBindingCandidate(request(),{...options,trustedHttpsBoundary:false}),{code:'unauthenticated'});
  await assert.rejects(verifyDingTalkBindingCandidate(request({...body,text:{content:'other challenge'}}),options),{code:'forbidden'});
  for(const field of ['msgId','chatbotCorpId','chatbotUserId','robotCode','senderStaffId'])await assert.rejects(verifyDingTalkBindingCandidate(request({...body,[field]:undefined}),options),{code:'forbidden'});
  await assert.rejects(verifyDingTalkBindingCandidate(request({...body,senderCorpId:'outside'}),options),{code:'forbidden'});
  await assert.rejects(verifyDingTalkBindingCandidate(request({...body,conversationType:'2',isInAtList:false}),options),{code:'invalid_request'});
});


test('Feishu pending candidate requires an explicit challenge and configured bot, never arbitrary first traffic',async()=>{
  const adapter=new FeishuConversationAdapter({...connection,tenantId:'display-id'},{...options,expectedTenantNamespace:'display_id'});
  const config={adapter,appId:'app1',botId:'ou_bot',challengeText:'identity-verify-feishu',expiresAt:now+600000,now:()=>now};
  await assert.rejects(verifyFeishuBindingCandidate(signed(event()),config),{code:'forbidden'});
  const e=event();e.event.message.chat_type='p2p';e.event.message.mentions=[];e.event.message.content=JSON.stringify({text:' identity-verify-feishu '});
  assert.deepEqual(await verifyFeishuBindingCandidate(signed(e),config),{appId:'app1',botId:'ou_bot',tenantId:'tenant1',challengeText:'identity-verify-feishu',eventId:'evt1',messageId:'om1'});
  assert.equal(adapter.connection.tenantId,'display-id');
  await assert.rejects(verifyFeishuBindingCandidate(signed(e),{...config,expiresAt:now}),{code:'unauthenticated'});
  await assert.rejects(verifyFeishuBindingCandidate(signed(e),{...config,botId:'other-bot'}),{code:'forbidden'});
  await assert.rejects(verifyFeishuBindingCandidate(signed(e),{...config,appId:'other-app'}),{code:'forbidden'});
  e.event.sender.sender_type='app';await assert.rejects(verifyFeishuBindingCandidate(signed(e),config),{code:'forbidden'});
});


test('Feishu descending history is explicit and continuation cannot cross sort order',async t=>{
  const f=await fixture((_req,res)=>ok(res,{has_more:true,page_token:'next-page',items:[]}));t.after(f.close);
  const adapter=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch});
  const page=await adapter.listMessages(ref,{order:'desc',limit:10});
  assert.ok(f.calls[0].url.includes('sort_type=ByCreateTimeDesc'));
  await assert.rejects(adapter.listMessages(ref,{order:'asc',limit:10,cursor:page.nextCursor}),{code:'invalid_request'});
  await adapter.listMessages(ref,{limit:10});assert.ok(f.calls[1].url.includes('sort_type=ByCreateTimeAsc'));
  await assert.rejects(adapter.listMessages(ref,{order:'invalid'}),{code:'invalid_request'});
});

test('Feishu app-id fallback can yield only a challenge-bound candidate with original bot',async()=>{
  const adapter=new FeishuConversationAdapter({...connection,tenantId:'app1'},{...options,expectedTenantNamespace:'app_id'});
  const e=event();e.event.message.chat_type='p2p';e.event.message.content=JSON.stringify({text:'verify-app-fallback'});
  const result=await verifyFeishuBindingCandidate(signed(e),{adapter,appId:'app1',botId:'ou_bot',challengeText:'verify-app-fallback',expiresAt:now+600000,now:()=>now});
  assert.equal(result.tenantId,'tenant1');assert.equal(result.eventId,'evt1');assert.equal(adapter.connection.tenantId,'app1');
});


test('final host authorization after Feishu reply lookup prevents a revoked outbound POST',async t=>{
  let allow=true,checks=0;
  const f=await fixture((_req,res)=>{allow=false;ok(res,{items:[{chat_id:'oc_group'}]});});t.after(f.close);
  const adapter=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch});
  const beforeSend=async()=>{checks++;if(!allow)throw new Error('revoked-after-lookup');};
  await assert.rejects(adapter.sendMessage({conversation:ref,text:'private output',operationId:'op-final-guard',replyToMessageId:'om1',beforeSend}),/revoked-after-lookup/);
  assert.equal(checks,1);assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');
});

test('DingTalk final host guard failure issues no HTTP send',async t=>{
  const f=await fixture((_req,res)=>res.end(JSON.stringify({processQueryKey:'unused'})));t.after(f.close);
  const adapter=new DingTalkBotConversationAdapter({...connection,provider:'dingtalk'},{...options,robotCode:'robot1',proactiveSendGranted:true,fetch:f.fetch});
  await assert.rejects(adapter.sendMessage({conversation:{...ref,provider:'dingtalk'},text:'private output',operationId:'op-final-guard',beforeSend:async()=>{throw new Error('revoked');}}),/revoked/);
  assert.equal(f.calls.length,0);
});


test('final synchronous guard runs after token resolution and preserves known pre-send denial',async()=>{
  for(const provider of ['feishu','dingtalk']){
    let calls=0,allowed=true,checked=false;
    const config={...options,robotCode:'robot1',proactiveSendGranted:true,resolveCredential:async()=>{await Promise.resolve();allowed=false;return 'fixture-token';},fetch:async()=>{calls++;throw new Error('must-not-send');}};
    const adapter=provider==='feishu'?new FeishuConversationAdapter(connection,config):new DingTalkBotConversationAdapter({...connection,provider},config);
    await assert.rejects(adapter.sendMessage({conversation:{...ref,provider},text:'sensitive',operationId:'final-guard',beforeSend:async()=>{assert.equal(allowed,true);},assertSendAllowed:()=>{checked=true;if(!allowed)throw new Error('known-revocation');}}),/known-revocation/);
    assert.equal(checked,true);assert.equal(calls,0);
  }
});


async function wireLogs(t){const root=await mkdtemp(join(tmpdir(),'identity-feishu-wire-')),log=new FileDiagnostics(root);t.after(async()=>{await log.close();await rm(root,{recursive:true,force:true});});return{log,async rows(){await log.flush();return(await Promise.all((await readdir(root)).map(n=>readFile(join(root,n),'utf8')))).join('').trim().split('\n').filter(Boolean).map(JSON.parse);}};}
const wireContext={traceId:'a'.repeat(64),messageId:'b'.repeat(64),attemptId:'11111111-1111-4111-8111-111111111111'};
for(const reply of [false,true])test(`Feishu actual send logs complete request/response JSON and stable correlation (reply=${reply})`,async t=>{
 const {log,rows}=await wireLogs(t);const response={code:0,msg:'success',data:{message_id:'sent-id',root_id:'root',body:{content:'{"text":"hello"}'},mentions:[{key:'@_user_1',id:'ou_bot',name:'机器人'}],extra:{nothing:null,enabled:false}}};
 const f=await fixture((req,res)=>req.method==='GET'?ok(res,{items:[{chat_id:'oc_group'}]}):res.end(JSON.stringify(response)));t.after(f.close);const adapter=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch,diagnostics:log});
 await log.run(wireContext,()=>adapter.sendMessage({conversation:ref,text:'hello',operationId:'wire-uuid',...(reply?{replyToMessageId:'original-message'}:{})}));const logs=await rows(),request=logs.find(r=>r.messageKind==='send_request'),result=logs.find(r=>r.messageKind==='send_response');
 assert.deepEqual(request.json.body,JSON.parse(f.calls.find(c=>c.method==='POST').body));assert.equal(request.json.path,reply?'/open-apis/im/v1/messages/original-message/reply':'/open-apis/im/v1/messages');assert.deepEqual(request.json.query,reply?[]:[['receive_id_type','chat_id']]);assert.deepEqual(result.json,response);assert.equal(result.httpStatus,200);assert.ok(logs.every(r=>r.traceId===wireContext.traceId&&r.messageId===wireContext.messageId));assert.ok(!JSON.stringify(logs).includes('Bearer test-token'));assert.ok(f.calls.every(c=>c.headers.authorization==='Bearer test-token'));
});
for(const status of [403,429,503])test(`Feishu HTTP ${status} preserves full failure JSON and prior error/retry semantics`,async t=>{
 const {log,rows}=await wireLogs(t);const response={code:40004,msg:'echo test-token',data:{detail:'provider detail',access_token:'reflected-secret',items:[{custom:true}]}};
 const f=await fixture((_req,res)=>{res.statusCode=status;res.setHeader('retry-after','2');res.end(JSON.stringify(response));});t.after(f.close);const adapter=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch,diagnostics:log});
 await log.run(wireContext,()=>assert.rejects(adapter.sendMessage({conversation:ref,text:'hello',operationId:'error-op'}),{code:status===403?'forbidden':status===429?'rate_limited':'delivery_unknown'}));assert.equal(f.calls.length,1);const logged=(await rows()).find(r=>r.messageKind==='send_response');assert.equal(logged.httpStatus,status);assert.equal(logged.json.code,40004);assert.equal(logged.json.msg,'echo ***');assert.equal(logged.json.data.access_token,'***');assert.deepEqual(logged.json.data.items,[{custom:true}]);assert.equal(logged.outcome,'failure');
});
for(const mode of ['business-error','invalid-json','network','body-fails'])test(`Feishu ${mode} records response evidence without retry or invented success`,async t=>{
 const {log,rows}=await wireLogs(t);let calls=0;const adapter=new FeishuConversationAdapter(connection,{...options,diagnostics:log,fetch:async()=>{calls++;if(mode==='network')throw Error('PRIVATE_TRANSPORT_ERROR');if(mode==='body-fails')return new Response(new ReadableStream({start(controller){controller.error(Error('PRIVATE_READ_ERROR'));}}),{status:403});if(mode==='invalid-json')return new Response('not JSON test-token',{status:200});return Response.json({code:99991672,msg:'denied',error:{request_id:'fixture-request',extra:'retained'}});}});
 await log.run(wireContext,()=>assert.rejects(adapter.sendMessage({conversation:ref,text:'hello',operationId:'failure-op'}),{code:mode==='business-error'||mode==='body-fails'?'forbidden':'delivery_unknown'}));assert.equal(calls,1);const logs=await rows(),response=logs.find(r=>r.messageKind==='send_response');assert.ok(response);assert.ok(!JSON.stringify(logs).includes('PRIVATE_TRANSPORT_ERROR')&&!JSON.stringify(logs).includes('PRIVATE_READ_ERROR'));if(mode==='business-error')assert.equal(response.json.error.extra,'retained');if(mode==='invalid-json')assert.deepEqual(response.json,{responseFormat:'text',rawBody:'not JSON ***'});if(mode==='network'){assert.equal(response.status,'unknown');assert.equal(response.category,'network');}if(mode==='body-fails'){assert.equal(response.httpStatus,403);assert.equal(response.status,'failed');assert.equal(response.category,'permission');}
});
test('Feishu history mention names use the same display mapping without authenticating history speakers',async t=>{
 const f=await fixture((_req,res)=>ok(res,{has_more:false,items:[{message_id:'history',chat_id:'oc_group',msg_type:'text',create_time:String(now),sender:{id:'ou_alice',id_type:'open_id',sender_type:'user'},body:{content:'{"text":"@_user_1 hello"}'},mentions:[{key:'@_user_1',id:'ou_bot',id_type:'open_id',name:'机器人'}]}]}));t.after(f.close);const adapter=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch});const page=await adapter.listMessages(ref,{});assert.deepEqual(page.items[0].mentionDetails,[{key:'@_user_1',id:'ou_bot',name:'机器人'}]);assert.equal(page.items[0].author.identityEvidence,'source_label');
});

test('pre-send credential or host-guard failure logs prepared JSON as failed and never claims an HTTP response',async t=>{
 for(const mode of ['credential','guard']){
  const {log,rows}=await wireLogs(t);let requests=0;const adapter=new FeishuConversationAdapter(connection,{...options,diagnostics:log,resolveCredential:async()=>{if(mode==='credential')throw Error('SYNTHETIC_PRIVATE_CREDENTIAL_ERROR');return'test-token';},fetch:async()=>{requests++;return Response.json({code:0,data:{message_id:'must-not-send'}});}});
  await log.run(wireContext,()=>assert.rejects(adapter.sendMessage({conversation:ref,text:'hello',operationId:'not-dispatched',...(mode==='guard'?{assertSendAllowed:()=>{throw Object.assign(Error('not permitted'),{code:'HOST_GUARD_DENIED'});}}:{})})));
  const logs=await rows();assert.equal(requests,0);assert.equal(logs.length,1);assert.equal(logs[0].messageKind,'send_request');assert.equal(logs[0].status,'failed');assert.equal(logs[0].json.body.receive_id,'oc_group');assert.ok(!JSON.stringify(logs).includes('SYNTHETIC_PRIVATE_CREDENTIAL_ERROR'));
 }
});

test('Feishu replies to verified original topic with reply_in_thread and stable UUID; never posts to main chat',async t=>{const f=await fixture((req,res)=>req.method==='GET'?ok(res,{items:[{message_id:'trigger',chat_id:'oc_group',thread_id:'omt_topic'}]}):ok(res,{message_id:'reply',chat_id:'oc_group',thread_id:'omt_topic'}));t.after(f.close);const adapter=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch});const result=await adapter.sendMessage({conversation:{...ref,conversationKind:'group'},threadId:'omt_topic',replyToMessageId:'trigger',text:'reply',operationId:'topic-stable'});assert.equal(result.status,'sent');assert.equal(f.calls[1].url,'/open-apis/im/v1/messages/trigger/reply');assert.deepEqual(JSON.parse(f.calls[1].body),{msg_type:'text',content:JSON.stringify({text:'reply'}),uuid:'topic-stable',reply_in_thread:true});});
test('Feishu refuses missing target, unverified thread and cross-chat topic without any send fallback',async t=>{let row={chat_id:'oc_group'};const f=await fixture((_req,res)=>ok(res,{items:[row]}));t.after(f.close);const adapter=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch}),request={conversation:{...ref,conversationKind:'group'},threadId:'omt_topic',replyToMessageId:'trigger',text:'reply',operationId:'op'};await assert.rejects(adapter.sendMessage({...request,replyToMessageId:undefined}),{code:'invalid_request'});for(const value of [{chat_id:'other',thread_id:'omt_topic'},{chat_id:'oc_group',thread_id:'other'},{chat_id:'oc_group'}]){row=value;await assert.rejects(adapter.sendMessage(request),{code:'forbidden'});}assert.equal(f.calls.filter(c=>c.method==='POST').length,0);});
test('Feishu thread POST failure and incomplete/mismatched receipt never downgrade to group send',async t=>{let mode='deny';const f=await fixture((req,res)=>{if(req.method==='GET')return ok(res,{items:[{chat_id:'oc_group',thread_id:'omt_topic'}]});if(mode==='deny'){res.statusCode=403;res.end(JSON.stringify({code:99991672}));}else ok(res,{message_id:'reply',chat_id:'oc_group',...(mode==='wrong'?{thread_id:'other'}:{})});});t.after(f.close);const adapter=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch}),request={conversation:{...ref,conversationKind:'group'},threadId:'omt_topic',replyToMessageId:'trigger',text:'reply',operationId:'op'};await assert.rejects(adapter.sendMessage(request));for(const value of ['missing','wrong']){mode=value;await assert.rejects(adapter.sendMessage(request),{code:'delivery_unknown'});}assert.equal(f.calls.filter(c=>c.method==='POST').length,3);assert.ok(f.calls.filter(c=>c.method==='POST').every(c=>c.url==='/open-apis/im/v1/messages/trigger/reply'));});

test('Feishu human private target uses trusted application-scoped recipient namespace, ordinary replies stay chat_id',async t=>{const f=await fixture((_req,res)=>ok(res,{message_id:'human-dm'}));t.after(f.close);const adapter=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch});await adapter.sendMessage({conversation:{...ref,conversationKind:'private',externalId:'human-user:open_id:ou_person',privateRecipientId:'ou_person',privateRecipientNamespace:'open_id'},text:'Synthetic human request',operationId:'human-one'});assert.equal(f.calls[0].url,'/open-apis/im/v1/messages?receive_id_type=open_id');assert.equal(JSON.parse(f.calls[0].body).receive_id,'ou_person');await assert.rejects(adapter.sendMessage({conversation:{...ref,conversationKind:'group',privateRecipientId:'ou_person',privateRecipientNamespace:'open_id'},text:'no',operationId:'bad'}),{code:'invalid_request'});assert.equal(f.calls.length,1);});

test('Feishu thread history uses its container with bounded pagination and rejects cross-parent replies',async t=>{
 let mismatch=false;const f=await fixture((_req,res)=>ok(res,{has_more:false,items:[{message_id:'topic-history',chat_id:mismatch?'other':'oc_group',thread_id:'omt_topic',msg_type:'text',create_time:String(now),sender:{id:'ou_person',id_type:'open_id',sender_type:'user'},body:{content:'{"text":"topic data"}'}}]}));t.after(f.close);
 const adapter=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch}),page=await adapter.listMessages(ref,{threadId:'omt_topic',startAt:1000,endAt:2000,limit:3});assert.equal(page.items[0].threadId,'omt_topic');const url=new URL(f.calls[0].url,'http://fixture');assert.equal(url.searchParams.get('container_id_type'),'thread');assert.equal(url.searchParams.get('container_id'),'omt_topic');assert.equal(url.searchParams.get('page_size'),'3');assert.equal(url.searchParams.has('start_time'),false);assert.equal(url.searchParams.has('end_time'),false);assert.equal(url.searchParams.has('sort_type'),false);assert.equal((await adapter.inspectCapabilities()).threadRead.supported,true);
 await assert.rejects(adapter.listMessages(ref,{threadId:'omt_topic',order:'desc'}),{code:'unsupported'});mismatch=true;await assert.rejects(adapter.listMessages(ref,{threadId:'omt_topic'}),{code:'forbidden'});
});

test('Feishu p2p thread replies verify exact original chat and thread without proactive or main-chat fallback',async t=>{
 let original={chat_id:'oc_private',thread_id:'omt_private'},receipt={message_id:'reply',chat_id:'oc_private',thread_id:'omt_private'};
 const f=await fixture((req,res)=>ok(res,req.method==='GET'?{items:[original]}:receipt));t.after(f.close);
 const adapter=new FeishuConversationAdapter(connection,{...options,fetch:f.fetch}),r={conversation:{...ref,externalId:'oc_private',conversationKind:'private'},threadId:'omt_private',replyToMessageId:'private-message',text:'Synthetic thread reply',operationId:'private-thread'};
 assert.equal((await adapter.sendMessage(r)).status,'sent');assert.equal(f.calls[1].url,'/open-apis/im/v1/messages/private-message/reply');assert.equal(JSON.parse(f.calls[1].body).reply_in_thread,true);assert.equal('receive_id'in JSON.parse(f.calls[1].body),false);
 for(const row of[{chat_id:'other',thread_id:'omt_private'},{chat_id:'oc_private',thread_id:'other'}]){original=row;await assert.rejects(adapter.sendMessage(r),{code:'forbidden'});}assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 original={chat_id:'oc_private',thread_id:'omt_private'};receipt={message_id:'wrong',chat_id:'oc_private',thread_id:'other'};await assert.rejects(adapter.sendMessage(r),{code:'delivery_unknown'});
 await assert.rejects(adapter.sendMessage({...r,replyToMessageId:undefined}),{code:'invalid_request'});assert.ok(f.calls.filter(c=>c.method==='POST').every(c=>c.url.endsWith('/private-message/reply')));
});

test('Feishu current membership query uses this bot tenant token and rejects unknown or cross-scope results',async()=>{
 const calls=[];let data={is_in_chat:true};const adapter=new FeishuConversationAdapter(connection,{...options,fetch:async(url,init)=>{calls.push({url:String(url),headers:init.headers});return new Response(JSON.stringify({code:0,data}),{status:200,headers:{'content-type':'application/json'}});}});
 assert.equal(await adapter.isBotInGroup({...ref,conversationKind:'group'}),true);assert.equal(calls.length,1);assert.equal(calls[0].url,'https://open.feishu.cn/open-apis/im/v1/chats/oc_group/members/is_in_chat');assert.equal(calls[0].headers.authorization,'Bearer test-token');
 data={is_in_chat:false};assert.equal(await adapter.isBotInGroup({...ref,conversationKind:'group'}),false);data={};await assert.rejects(adapter.isBotInGroup({...ref,conversationKind:'group'}),/membership_response_invalid/);
 const before=calls.length;await assert.rejects(adapter.isBotInGroup({...ref,tenantId:'other',conversationKind:'group'}),{code:'forbidden'});await assert.rejects(adapter.isBotInGroup({...ref,conversationKind:'private'}),{code:'invalid_request'});assert.equal(calls.length,before);
});

const dingStatusConnection={...connection,provider:'dingtalk'};
const dingStatusTarget={...ref,provider:'dingtalk',conversationKind:'group'};
const dingStatusOptions={...options,robotCode:'robot1',proactiveSendGranted:true};

test('DingTalk status query uses exact private GET and group POST contracts with encoded identifiers',async t=>{
  const f=await fixture((_req,res)=>res.end(JSON.stringify({sendStatus:'SUCCESS',readStatus:'UNREAD'})));t.after(f.close);
  const robotCode='robot/+?&=中文',providerRequestId='query/+?&=中文',adapter=new DingTalkBotConversationAdapter(dingStatusConnection,{...dingStatusOptions,robotCode,fetch:f.fetch});
  for(const conversationKind of ['private','group'])assert.deepEqual(await adapter.queryMessageStatus({conversation:{...dingStatusTarget,conversationKind},providerRequestId}),{status:'sent'});
  const [privateCall,groupCall]=f.calls,url=new URL(privateCall.url,'http://fixture');
  assert.equal(privateCall.method,'GET');assert.equal(url.pathname,'/v1.0/robot/oToMessages/readStatus');assert.deepEqual([...url.searchParams],[['robotCode',robotCode],['processQueryKey',providerRequestId]]);assert.equal(privateCall.body,'');
  assert.equal(groupCall.method,'POST');assert.equal(groupCall.url,'/v1.0/robot/groupMessages/query');assert.deepEqual(JSON.parse(groupCall.body),{robotCode,processQueryKey:providerRequestId,openConversationId:'oc_group',maxResults:1});
  assert.ok(f.calls.every(c=>c.headers['x-acs-dingtalk-access-token']==='test-token'));assert.equal(groupCall.headers['content-type'],'application/json');assert.equal(f.calls.length,2);
});

test('DingTalk status query trusts only exact sendStatus values, never read receipts or nested hints',async t=>{
  let response;const f=await fixture((_req,res)=>res.end(JSON.stringify(response)));t.after(f.close);
  const adapter=new DingTalkBotConversationAdapter(dingStatusConnection,{...dingStatusOptions,fetch:f.fetch});
  const cases=[
    [{sendStatus:'SUCCESS',readStatus:'UNREAD'},'sent'],[{sendStatus:'PROCESSING',readStatus:'READ'},'processing'],[{sendStatus:'RECALLED',readStatus:'READ'},'recalled'],
    [{readStatus:'READ'},'unknown'],[{sendStatus:'FAILED'},'unknown'],[{sendStatus:'success'},'unknown'],[{sendStatus:1},'unknown'],[{sendStatus:null},'unknown'],[{sendStatus:['SUCCESS']},'unknown'],[{},'unknown'],[{data:{sendStatus:'SUCCESS'}},'unknown'],[{readUserIds:['staff1'],unReadUserIds:[]},'unknown'],
  ];
  for(const conversationKind of ['private','group'])for(const [value,status] of cases){response=value;assert.deepEqual(await adapter.queryMessageStatus({conversation:{...dingStatusTarget,conversationKind},providerRequestId:'query-key'}),{status},JSON.stringify(value));}
  assert.equal(f.calls.length,cases.length*2);assert.ok(f.calls.every(c=>!c.url.includes('/send')&&!c.url.includes('/batchSend')));
});

test('DingTalk status query rejects cross-namespace targets, invalid keys and missing capability before credentials or HTTP',async t=>{
  let credentials=0;const f=await fixture((_req,res)=>res.end('{}'));t.after(f.close);
  const config={...dingStatusOptions,fetch:f.fetch,resolveCredential:async()=>{credentials++;return'test-token';}},adapter=new DingTalkBotConversationAdapter(dingStatusConnection,config),request={conversation:dingStatusTarget,providerRequestId:'query-key'};
  for(const patch of [{provider:'feishu'},{connectionId:'other'},{tenantId:'other'}])await assert.rejects(adapter.queryMessageStatus({...request,conversation:{...dingStatusTarget,...patch}}),{code:'forbidden'});
  for(const patch of [{kind:'minutes'},{conversationKind:undefined}])await assert.rejects(adapter.queryMessageStatus({...request,conversation:{...dingStatusTarget,...patch}}),{code:'invalid_request'});
  for(const providerRequestId of [undefined,null,0,'',' ','key\n','key\x00','key\x7f','x'.repeat(2049)])await assert.rejects(adapter.queryMessageStatus({...request,providerRequestId}),{code:'invalid_request'});
  await assert.rejects(new DingTalkBotConversationAdapter(dingStatusConnection,{...config,proactiveSendGranted:false}).queryMessageStatus(request),{code:'forbidden'});
  assert.equal(credentials,0);assert.equal(f.calls.length,0);
});

test('DingTalk status query rechecks synchronous host authorization after awaited credential resolution',async t=>{
  const f=await fixture((_req,res)=>res.end('{}'));t.after(f.close);
  for(const conversationKind of ['private','group']){
    let allowed=true,checks=0,credentials=0;const revoked=Error('known-query-revocation');
    const adapter=new DingTalkBotConversationAdapter(dingStatusConnection,{...dingStatusOptions,fetch:f.fetch,resolveCredential:async()=>{credentials++;await Promise.resolve();allowed=false;return'test-token';}});
    await assert.rejects(adapter.queryMessageStatus({conversation:{...dingStatusTarget,conversationKind},providerRequestId:'query-key',assertQueryAllowed:()=>{checks++;if(!allowed)throw revoked;}}),error=>error===revoked);
    assert.equal(checks,1);assert.equal(credentials,1);
  }
  assert.equal(f.calls.length,0);
});

for(const conversationKind of ['private','group'])test(`DingTalk ${conversationKind} status query preserves HTTP denials and treats failed queries as retryable reads without sending`,async t=>{
  let mode=403;const f=await fixture((req,res)=>{if(mode==='network'){req.socket.destroy();return;}if(mode==='invalid-json'){res.end('not JSON test-token');return;}res.statusCode=mode;res.setHeader('retry-after','2');res.end(JSON.stringify({message:'PRIVATE_PROVIDER_DETAIL test-token'}));});t.after(f.close);
  const adapter=new DingTalkBotConversationAdapter(dingStatusConnection,{...dingStatusOptions,fetch:f.fetch}),request={conversation:{...dingStatusTarget,conversationKind},providerRequestId:'query-key'};
  for(const [status,code] of [[401,'unauthenticated'],[403,'forbidden'],[404,'not_found'],[429,'rate_limited'],[503,'temporarily_unavailable'],['invalid-json','temporarily_unavailable'],['network','temporarily_unavailable']]){
    mode=status;const before=f.calls.length;await assert.rejects(adapter.queryMessageStatus(request),error=>{assert.equal(error.code,code);assert.ok(!error.message.includes('test-token')&&!error.message.includes('PRIVATE_PROVIDER_DETAIL'));if(status===429)assert.equal(error.retryAfterMs,2000);return true;});assert.equal(f.calls.length,before+1);
  }
  assert.ok(f.calls.every(c=>!c.url.includes('/send')&&!c.url.includes('/batchSend')));
});

test('DingTalk status query rejects malformed envelopes and business failures without claiming sent',async t=>{
  let response;const f=await fixture((_req,res)=>res.end(JSON.stringify(response)));t.after(f.close);
  const adapter=new DingTalkBotConversationAdapter(dingStatusConnection,{...dingStatusOptions,fetch:f.fetch});
  for(const conversationKind of ['private','group'])for(const value of [null,[],42,'SUCCESS',{errcode:1,sendStatus:'SUCCESS'},{code:'denied',sendStatus:'SUCCESS'}]){
    response=value;await assert.rejects(adapter.queryMessageStatus({conversation:{...dingStatusTarget,conversationKind},providerRequestId:'query-key'}),{code:'temporarily_unavailable'});
  }
  assert.equal(f.calls.length,12);assert.ok(f.calls.every(c=>!c.url.includes('/send')&&!c.url.includes('/batchSend')));
});

test('DingTalk private single-recipient batch rejection requires both lists to be trustworthy and never retries',async t=>{
  let response;const f=await fixture((_req,res)=>res.end(JSON.stringify(response)));t.after(f.close);
  const adapter=new DingTalkBotConversationAdapter(dingStatusConnection,{...dingStatusOptions,fetch:f.fetch}),request={conversation:{...dingStatusTarget,conversationKind:'private',privateRecipientId:'staff1'},text:'synthetic message',operationId:'batch-check'};
  const cases=[
    [{invalidStaffIdList:['staff1']},'invalid_request'],[{flowControlledStaffIdList:['staff1']},'rate_limited'],
    [{invalidStaffIdList:['other']},'delivery_unknown'],[{flowControlledStaffIdList:['other']},'delivery_unknown'],
    [{invalidStaffIdList:'staff1'},'delivery_unknown'],[{flowControlledStaffIdList:null},'delivery_unknown'],
    [{invalidStaffIdList:['staff1','other']},'delivery_unknown'],[{flowControlledStaffIdList:[1]},'delivery_unknown'],
    [{invalidStaffIdList:['staff1'],flowControlledStaffIdList:'invalid'},'delivery_unknown'],[{invalidStaffIdList:{},flowControlledStaffIdList:['staff1']},'delivery_unknown'],
  ];
  for(const [fields,code] of cases){response={processQueryKey:'request-key',...fields};const before=f.calls.length;await assert.rejects(adapter.sendMessage(request),{code});assert.equal(f.calls.length,before+1);}
  for(const fields of [{},{invalidStaffIdList:[],flowControlledStaffIdList:[]}]){response={processQueryKey:'request-key',...fields};assert.deepEqual(await adapter.sendMessage(request),{status:'accepted',providerRequestId:'request-key',idempotent:false});}
  assert.equal(f.calls.length,cases.length+2);assert.ok(f.calls.every(c=>c.method==='POST'&&c.url==='/v1.0/robot/oToMessages/batchSend'&&JSON.stringify(JSON.parse(c.body).userIds)==='["staff1"]'));
});

test('DingTalk send never fabricates acceptance when processQueryKey is missing or invalid',async t=>{
  let response;const f=await fixture((_req,res)=>res.end(JSON.stringify(response)));t.after(f.close);
  const adapter=new DingTalkBotConversationAdapter(dingStatusConnection,{...dingStatusOptions,fetch:f.fetch});
  const keys=[undefined,null,0,'',' ','key\n','key\x00','key\x7f','x'.repeat(2049)];
  for(const conversationKind of ['private','group'])for(const processQueryKey of keys){response={processQueryKey};const before=f.calls.length;await assert.rejects(adapter.sendMessage({conversation:{...dingStatusTarget,conversationKind,...(conversationKind==='private'?{privateRecipientId:'staff1'}:{})},text:'synthetic message',operationId:'bad-receipt'}),{code:'delivery_unknown'});assert.equal(f.calls.length,before+1);}
  assert.equal(f.calls.length,keys.length*2);
});
