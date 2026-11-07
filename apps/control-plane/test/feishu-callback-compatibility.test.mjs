import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv, createHash} from 'node:crypto';
import {FeishuConversationAdapter, verifyFeishuBindingCandidate} from '../dist/adapters/channels/feishu.js';

// Synthetic callback bytes only: no provider requests, credentials, or model calls.
const now = 1792750000000;
const encryptKey = 'fixture-only-encrypt-key';
const token = 'fixture-only-verification-token';
const challengeText = 'DENTITY-VERIFY-fixture';
const connection = {workspaceId:'fixture-workspace',connectionId:'fixture-connection',provider:'feishu',tenantId:'fixture-tenant',identity:{kind:'bot',externalId:'ou_fixture_bot'},credentialRef:'fixture-ref'};
const options = {appId:'fixture-app',now:()=>now,grants:{privateMessageEvents:true,mentionEvents:true,ordinaryMessageEvents:true},resolveCredential:async(_connection,purpose)=>({webhook_encrypt_key:encryptKey,webhook_verification_token:token})[purpose]};
const adapter = () => new FeishuConversationAdapter(connection,options);
const mention = (key='@_user_1',open_id=connection.identity.externalId) => ({key,id:{open_id},name:'Fixture bot',tenant_key:connection.tenantId});
function event(text=challengeText,chat_type='p2p',mentions=[]) {
  return {schema:'2.0',header:{event_id:'fixture-event',event_type:'im.message.receive_v1',app_id:options.appId,tenant_key:connection.tenantId,token},event:{sender:{sender_id:{open_id:'ou_fixture_user'},sender_type:'user',tenant_key:connection.tenantId},message:{message_id:'fixture-message',chat_id:'fixture-chat',chat_type,message_type:'text',create_time:String(now),content:JSON.stringify({text}),mentions}}};
}
function request(value,{encrypted=false,signed=true,time=String(now/1000)}={}) {
  let rawBody = JSON.stringify(value);
  if (encrypted) {
    const iv = Buffer.alloc(16,3);
    const cipher = createCipheriv('aes-256-cbc',createHash('sha256').update(encryptKey).digest(),iv);
    rawBody = JSON.stringify({encrypt:Buffer.concat([iv,cipher.update(rawBody),cipher.final()]).toString('base64')});
  }
  const nonce = 'fixture-nonce';
  const signature = createHash('sha256').update(time+nonce+encryptKey).update(rawBody).digest('hex');
  return {rawBody,receivedAt:now,headers:signed?{'x-lark-request-timestamp':time,'x-lark-request-nonce':nonce,'x-lark-signature':signature}:{}};
}
const verify = (value,extra={}) => verifyFeishuBindingCandidate(request(value,{encrypted:true}),{adapter:adapter(),appId:options.appId,botId:connection.identity.externalId,challengeText,expiresAt:now+60000,now:()=>now,...extra});
const challenge = {type:'url_verification',token,challenge:'fixture-url-challenge'};

test('Feishu URL verification accepts token-authenticated unsigned plaintext and encrypted challenges',async()=>{
  for (const encrypted of [false,true]) {
    assert.deepEqual(await adapter().receiveWebhook(request(challenge,{signed:false,encrypted})),{kind:'challenge',challenge:challenge.challenge});
  }
});

test('Feishu unsigned challenge rejects wrong token, malformed challenge, ciphertext and missing required secrets',async()=>{
  for (const encrypted of [false,true]) {
    await assert.rejects(adapter().receiveWebhook(request({...challenge,token:'wrong'},{signed:false,encrypted})),{code:'unauthenticated'});
    for (const value of ['',null,{},'x'.repeat(4097)]) await assert.rejects(adapter().receiveWebhook(request({...challenge,challenge:value},{signed:false,encrypted})),{code:'unauthenticated'});
  }
  for (const encrypt of ['not base64!',Buffer.alloc(32).toString('base64')]) {
    await assert.rejects(adapter().receiveWebhook(request({encrypt},{signed:false})),{code:'unauthenticated'});
  }
  for (const missing of ['webhook_encrypt_key','webhook_verification_token']) {
    const a = new FeishuConversationAdapter(connection,{...options,resolveCredential:async(c,p)=>p===missing?'':options.resolveCredential(c,p)});
    await assert.rejects(a.receiveWebhook(request(challenge,{signed:false})),{code:'unauthenticated'});
  }
});

test('Feishu challenge exemption never admits unsigned, forged or expired ordinary events',async()=>{
  for (const encrypted of [false,true]) {
    await assert.rejects(adapter().receiveWebhook(request(event(),{signed:false,encrypted})),{code:'unauthenticated'});
    const forged = request(event(),{encrypted}); forged.headers['x-lark-signature']='0'.repeat(64);
    await assert.rejects(adapter().receiveWebhook(forged),{code:'unauthenticated'});
    await assert.rejects(adapter().receiveWebhook(request(event(),{encrypted,time:String(now/1000-301)})),{code:'unauthenticated'});
    const wrongToken=event();wrongToken.header.token='wrong';
    await assert.rejects(adapter().receiveWebhook(request(wrongToken,{encrypted})),{code:'unauthenticated'});
  }
  // A payload labelled as a challenge can only produce a challenge response, never a message.
  const mixed={...event(),...challenge};
  assert.equal((await adapter().receiveWebhook(request(mixed,{signed:false}))).kind,'challenge');
  await assert.rejects(verifyFeishuBindingCandidate(request(mixed,{signed:false}),{adapter:adapter(),appId:options.appId,botId:connection.identity.externalId,challengeText,expiresAt:now+60000,now:()=>now}),{code:'invalid_request'});
});

test('Feishu ordinary events still require app, tenant and sender-tenant scope',async()=>{
  const cases=[value=>{value.header.app_id='other-app';},value=>{value.header.tenant_key='other-tenant';},value=>{value.event.sender.tenant_key='other-tenant';}];
  for (const change of cases) {const value=event();change(value);await assert.rejects(verify(value),{code:'forbidden'});}
});

test('Feishu binding accepts private challenge and real group mention placeholder while preserving business text',async()=>{
  assert.equal((await verify(event())).challengeText,challengeText);
  for (const text of [`@_user_1 ${challengeText}`,`${challengeText} @_user_1`,` \n@_user_1\t${challengeText}  `]) {
    const value=event(text,'group',[mention()]);
    assert.equal((await verify(value)).challengeText,challengeText);
    assert.equal((await adapter().receiveWebhook(request(value,{encrypted:true}))).event.message.text,text);
  }
});

test('Feishu binding does not erase literal text, foreign mentions or ambiguous placeholder ownership',async()=>{
  const invalid=[
    event(`@_user_1 ${challengeText}`,'group',[]),
    event(`@_user_1 ${challengeText}`,'group',[mention('@_user_1','ou_other')]),
    event(`@_user_1 ${challengeText}`,'group',[mention('@_user_2')]),
    event(`@_user_1 ${challengeText}`,'group',[mention(),mention('@_user_1','ou_other')]),
    event(`@_user_1 ${challengeText} @_user_2`,'group',[mention(),mention('@_user_2','ou_other')]),
    event(`@Fixture bot ${challengeText}`,'group',[mention()]),
    event(`@_user_1${challengeText}`,'group',[mention()]),
    event(`prefix @_user_1 ${challengeText}`,'group',[mention()]),
    event(`@_user_1 ${challengeText}`,'p2p',[mention()]),
    event(`@_user_1 ${challengeText}`,'group',[mention('@_user_1.*')]),
  ];
  for (const value of invalid) await assert.rejects(verify(value),{code:'forbidden'});
});

test('Feishu group challenge keeps sender and administrator challenge-expiry restrictions',async()=>{
  const value=event(`@_user_1 ${challengeText}`,'group',[mention()]);
  value.event.sender.sender_type='app';await assert.rejects(verify(value),{code:'forbidden'});
  await assert.rejects(verify(event(),{expiresAt:now}),{code:'unauthenticated'});
});
